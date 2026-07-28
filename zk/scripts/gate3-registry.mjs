// Gate 3 — the registry contract, exercised in an EVM against a proof the SERVICE produced.
//
// Phase 0 proved a contract can verify a proof from a file. That is not the claim. The claim is that
// an agent buys a risk number from the live engine and a contract checks its arithmetic without
// trusting the seller — so this gate starts by calling perp-gate, waits for the proof the service
// builds, and puts THAT on chain. A fixture would have let a break between the circuit and the
// service pass unnoticed, which is the only interesting way this can fail.
//
// Run: node zk/scripts/gate3-registry.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from 'ethereum-cryptography/utils.js';
import { load } from './service-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, '..', 'build');
const CONTRACTS = path.join(__dirname, '..', 'contracts');
const SERVICE = path.join(__dirname, '..', '..', 'hackathon', 'veritape');

// A throwaway key, and it must stay throwaway: this is the "Quiver attestor" the registry is
// constructed with, so the gate can prove the attestation path works end to end. Hardhat account #1,
// published in their docs and funded on no chain anybody cares about.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function compile(files, evmVersion = 'paris') {
  const sources = {};
  for (const [name, file] of Object.entries(files)) sources[name] = { content: fs.readFileSync(file, 'utf8') };
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  return out.contracts;
}

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = (sig) => bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);

async function main() {
  console.log(`GATE 3 — the registry verifies a live service proof on chain — ${new Date().toISOString()}\n`);
  const results = [];
  const record = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
  };

  // ---- 1. buy a risk number from the live engine, and take the proof it builds ----------------
  process.env.QUIVER_SIGNING_KEY = TEST_KEY;
  const { byName } = await load(import.meta.url, 'services.js');
  const { getProof } = await load(import.meta.url, 'util/snark.js');
  const answer = await byName['perp-gate'].run({
    side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125, snark: true,
  });
  console.log(`  bought: liquidationPrice ${answer.liquidationPrice} · contentHash ${answer.proof.contentHash}`);
  let rec = null;
  for (let i = 0; i < 400; i++) {
    rec = getProof(answer.proof.contentHash);
    if (rec && rec.status !== 'building') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!rec || rec.status !== 'ready') throw new Error(`the service never produced a proof: ${rec && rec.status} ${rec && rec.error}`);
  console.log(`  service proof ready · attestor ${rec.signalsAttestation?.signer || 'NONE'}\n`);

  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const raw = await snarkjs.plonk.exportSolidityCallData(rec.proof, rec.publicSignals);
  const [proof24, pub8] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);

  // ---- 2. compile and deploy both contracts ---------------------------------------------------
  const verifierOut = compile({ 'PlonkVerifier.sol': path.join(BUILD, 'PlonkVerifier.sol') });
  const registryOut = compile({ 'QuiverProofRegistry.sol': path.join(CONTRACTS, 'QuiverProofRegistry.sol') });
  const V = verifierOut['PlonkVerifier.sol'][Object.keys(verifierOut['PlonkVerifier.sol'])[0]];
  const R = registryOut['QuiverProofRegistry.sol']['QuiverProofRegistry'];
  console.log(`  solc ${solc.version()} · verifier ${V.evm.deployedBytecode.object.length / 2}B · registry ${R.evm.deployedBytecode.object.length / 2}B\n`);

  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const evm = await EVM.create({ common });
  const caller = hexToBytes('1000000000000000000000000000000000000001');

  const depV = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
  if (depV.execResult.exceptionError) throw new Error(`verifier deploy failed: ${depV.execResult.exceptionError}`);
  const verifierAddr = bytesToHex(depV.createdAddress.bytes);

  const ctorArgs = pad('0x' + verifierAddr) + pad(TEST_ADDR);
  const depR = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(R.evm.bytecode.object + ctorArgs), gasLimit: 30_000_000n });
  if (depR.execResult.exceptionError) throw new Error(`registry deploy failed: ${depR.execResult.exceptionError}`);
  const registryAddr = depR.createdAddress;
  console.log(`  verifier at 0x${verifierAddr} (${depV.execResult.executionGasUsed} gas)`);
  console.log(`  registry at 0x${bytesToHex(registryAddr.bytes)} (${depR.execResult.executionGasUsed} gas)\n`);

  // ---- 3. submit ------------------------------------------------------------------------------
  const SUBMIT = sel('submit(uint256[24],uint256[8],bytes)');
  const encodeSubmit = (p24, p8, sigHex) => {
    const sigBytes = (sigHex || '').replace(/^0x/, '');
    const len = sigBytes.length / 2;
    const head = pad(24 * 32 + 8 * 32 + 32);            // offset to the bytes argument
    const tail = pad(len) + (sigBytes.padEnd(Math.ceil(len / 32) * 64, '0') || '');
    return hexToBytes(SUBMIT + [...p24, ...p8].map(pad).join('') + head + tail);
  };

  const digest = rec.signalsAttestation?.digest;
  const attestation = rec.signalsAttestation?.signature;

  async function submit(label, data, expectAccepted, gasLimit = 8_000_000n) {
    const res = await evm.runCall({ caller: { bytes: caller }, to: registryAddr, data, gasLimit });
    const err = res.execResult.exceptionError;
    const ret = bytesToHex(res.execResult.returnValue);
    const accepted = err ? null : BigInt('0x' + (ret || '0')) === 1n;
    const logs = res.execResult.logs || [];
    const topic0 = logs.length ? bytesToHex(logs[0][1][0]) : null;
    const ACCEPTED = bytesToHex(keccak256(utf8ToBytes('ProofAccepted(bytes32,address,uint256,bool,bool)')));
    const REJECTED = bytesToHex(keccak256(utf8ToBytes('ProofRejected(bytes32,address,string)')));
    const eventName = topic0 === ACCEPTED ? 'ProofAccepted' : topic0 === REJECTED ? 'ProofRejected' : 'none';
    const ok = accepted === expectAccepted && (expectAccepted ? eventName === 'ProofAccepted' : eventName === 'ProofRejected');
    record(label, ok, `returned ${accepted} · emitted ${eventName} · ${res.execResult.executionGasUsed} gas${err ? ` · exception ${err}` : ''}`);
    return { res, accepted, eventName, logs, gas: res.execResult.executionGasUsed };
  }

  console.log('Submitting to the registry:');
  const good = await submit('honest proof, attested by Quiver', encodeSubmit(proof24, pub8, attestation), true);

  // The attested flag must be TRUE here, and it is the last word of the accepted event's data.
  const attestedFlag = good.logs.length ? bytesToHex(good.logs[0][2]).slice(-1) === '1' : false;
  record('the event says Quiver attested to these exact signals', attestedFlag,
    `digest ${digest}`);

  const noSig = await submit('honest proof, no attestation', encodeSubmit(proof24, pub8, ''), true);
  const unattestedFlag = noSig.logs.length ? bytesToHex(noSig.logs[0][2]).slice(-1) === '1' : true;
  record('an unattested proof is still accepted, and flagged unattested', noSig.accepted === true && unattestedFlag === false,
    'the arithmetic stands on its own — that is the point of proving it');

  // A signature over the RIGHT digest by the WRONG key must not set the flag. This is the check that
  // separates "Quiver said it" from "someone said it", and it is the one an attacker would attack.
  // ethers lives in the service's tree, not this one — resolve it from there rather than adding a
  // duplicate dependency to a directory whose only job is to build circuits.
  const { createRequire } = await import('node:module');
  const { Wallet, getBytes } = createRequire(path.join(SERVICE, 'package.json'))('ethers');
  const impostor = new Wallet('0x' + '11'.repeat(32));
  const forged = await impostor.signMessage(getBytes(digest));
  const wrongKey = await submit('proof attested by an impostor key', encodeSubmit(proof24, pub8, forged), true);
  const forgedFlag = wrongKey.logs.length ? bytesToHex(wrongKey.logs[0][2]).slice(-1) === '1' : true;
  record('an impostor signature does not set the attested flag', forgedFlag === false,
    `signed by ${impostor.address}, not the registry's attestor`);

  // Rejections. Each public signal perturbed one at a time, then a bent proof point.
  console.log('\nRejections:');
  let rejectsOk = 0;
  for (let i = 0; i < pub8.length; i++) {
    const t = [...pub8];
    t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
    const r = await submit(`tampered signal[${i}]`, encodeSubmit(proof24, t, attestation), false);
    if (r.accepted === false && r.eventName === 'ProofRejected') rejectsOk++;
  }
  const bent = [...proof24];
  bent[0] = '0x' + (BigInt(bent[0]) + 1n).toString(16);
  const bentRes = await submit('bent proof point', encodeSubmit(bent, pub8, attestation), false);
  if (bentRes.accepted === false && bentRes.eventName === 'ProofRejected') rejectsOk++;
  record('every tampered submission was rejected AND recorded', rejectsOk === pub8.length + 1,
    `${rejectsOk} of ${pub8.length + 1} — a rejection that reverts leaves no record, which is why they are events`);

  // ---- 4. the stored number is the number that was sold ---------------------------------------
  const LIQ = sel('liquidationPrice(bytes32)');
  const q = await evm.runCall({ caller: { bytes: caller }, to: registryAddr, data: hexToBytes(LIQ + digest.replace(/^0x/, '')), gasLimit: 1_000_000n });
  const retHex = bytesToHex(q.execResult.returnValue);
  const whole = BigInt('0x' + retHex.slice(0, 64));
  const nano = BigInt('0x' + retHex.slice(64, 128));
  const onChain = Number(whole) + Number(nano) / 1e9;
  record('the price the contract stores is the price the agent bought',
    Math.abs(onChain - answer.liquidationPrice) <= 0.005,
    `on chain ${whole}.${String(nano).padStart(9, '0')} vs sold ${answer.liquidationPrice}`);

  // ---- verdict --------------------------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  const gate = failed.length === 0;
  console.log(`\n${'='.repeat(76)}`);
  console.log(`GATE 3: ${gate ? 'PASSED' : `FAILED — ${failed.map((f) => f.name).join('; ')}`}`);
  if (gate) console.log('  An agent bought a risk number and a contract checked its arithmetic without trusting the seller.');
  console.log(`  accept gas ${good.gas} · reject gas ${bentRes.gas}`);

  fs.writeFileSync(path.join(BUILD, 'gate3-registry.json'), JSON.stringify({
    at: new Date().toISOString(), passed: gate, solc: solc.version(),
    acceptGas: String(good.gas), rejectGas: String(bentRes.gas),
    contentHash: answer.proof.contentHash, signalsDigest: digest,
    liquidationPrice: answer.liquidationPrice,
    checks: results,
  }, null, 2) + '\n', 'utf8');

  await globalThis.curve_bn128?.terminate();
  process.exit(gate ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
