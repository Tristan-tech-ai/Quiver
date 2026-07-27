// PHASE 0 GATE — can a contract verify the proof we already have, and can it REJECT a bad one?
//
// Nothing downstream of this matters if it fails, and it touches no service code, so it runs first.
// The verifier under test is PLONK, not Groth16, and that choice is the point: the Groth16
// circuit-specific ceremony had one participant and it was our machine, so deploying that verifier
// and inviting anyone to rely on it would be the exact failure this project criticises in others.
// Plonk uses the public Hermez reference string. It costs more gas. That is the trade.
//
// Adapted from scripts/gas.mjs, which did this for Groth16. The Plonk verifier's signature is
// verifyProof(uint256[24], uint256[8]) — both static, so the encoding is a flat concatenation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from 'ethereum-cryptography/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, '..', 'build');
const SOL = path.join(BUILD, 'PlonkVerifier.sol');

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'PlonkVerifier.sol': { content: fs.readFileSync(SOL, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const contracts = out.contracts['PlonkVerifier.sol'];
  const name = Object.keys(contracts)[0];
  return { name, ...contracts[name], solcVersion: solc.version() };
}

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const SIG = 'verifyProof(uint256[24],uint256[8])';
const SELECTOR = bytesToHex(keccak256(utf8ToBytes(SIG))).slice(0, 8);
const encodeCall = (proof24, pub8) => hexToBytes(SELECTOR + [...proof24, ...pub8].map(pad).join(''));

async function main() {
  console.log(`PHASE 0 GATE — plonk on-chain verification — ${new Date().toISOString()}\n`);

  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const proof = JSON.parse(fs.readFileSync(path.join(BUILD, 'proof_plonk.json'), 'utf8'));
  const pubSignals = JSON.parse(fs.readFileSync(path.join(BUILD, 'public_plonk.json'), 'utf8'));

  // Let snarkjs lay out the 24 proof words. Doing that by hand is a well-known way to build a
  // verifier that rejects valid proofs and then to blame the circuit.
  // Plonk emits TWO adjacent arrays with no separator — `[...24 proof...][...8 signals...]` — where
  // groth16 emits four comma-separated ones. Neither `JSON.parse(raw)` nor the groth16 script's
  // `[${raw}]` handles that; both fail at the boundary, which is where the shape announced itself.
  const raw = await snarkjs.plonk.exportSolidityCallData(proof, pubSignals);
  const parsed = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  if (parsed.length !== 2) throw new Error(`expected 2 calldata arrays, got ${parsed.length}`);
  const [proof24, pub8] = parsed;
  if (!Array.isArray(proof24) || proof24.length !== 24) throw new Error(`expected 24 proof words, got ${proof24 && proof24.length}`);
  // The 8 signals must match the committed public.json, or we are verifying a different statement.
  if (pub8.length !== pubSignals.length) throw new Error(`signal count mismatch: ${pub8.length} vs ${pubSignals.length}`);
  for (let i = 0; i < pub8.length; i++) {
    if (BigInt(pub8[i]) !== BigInt(pubSignals[i])) throw new Error(`signal[${i}] differs from public_plonk.json`);
  }

  const compiled = compile();
  const deployed = compiled.evm.deployedBytecode.object;
  console.log(`solc ${compiled.solcVersion}, optimizer on (200 runs), EVM cancun`);
  console.log(`contract ${compiled.name}, deployed bytecode ${deployed.length / 2} bytes\n`);

  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const evm = await EVM.create({ common });
  const caller = hexToBytes('1000000000000000000000000000000000000001');

  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(compiled.evm.bytecode.object), gasLimit: 30_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy failed: ${dep.execResult.exceptionError}`);
  const addr = dep.createdAddress;
  console.log(`deploy gas: ${dep.execResult.executionGasUsed}\n`);

  const results = [];
  async function call(label, data, expect, gasLimit = 5_000_000n) {
    const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit });
    const err = res.execResult.exceptionError;
    const ret = bytesToHex(res.execResult.returnValue);
    const value = err ? null : BigInt('0x' + (ret || '0')) === 1n;
    const ok = value === expect;
    results.push({ label, value, expect, ok, gas: res.execResult.executionGasUsed });
    console.log(`  [${ok ? 'PASS' : '*** FAIL ***'}] ${label.padEnd(28)} returned ${String(value).padEnd(5)} gas ${res.execResult.executionGasUsed}`);
    if (err) console.log(`          exception: ${err}`);
    return results[results.length - 1];
  }

  console.log('Calling verifyProof in the EVM:');
  const good = await call('honest proof', encodeCall(proof24, pub8), true);

  // A verifier that cannot reject is not a verifier. Every public signal is perturbed, because the
  // contract is the thing that would hold the money.
  for (let i = 0; i < pub8.length; i++) {
    const t = [...pub8];
    t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
    await call(`tampered signal[${i}]`, encodeCall(proof24, t), false);
  }
  const bent = [...proof24];
  bent[0] = '0x' + (BigInt(bent[0]) + 1n).toString(16);
  await call('bent proof point', encodeCall(bent, pub8), false);

  const failed = results.filter((r) => !r.ok);
  const rejects = results.filter((r) => r.expect === false);
  console.log(`\n${results.length} EVM calls — ${results.length - failed.length} as expected, ${failed.length} not`);

  const gate = good.ok && rejects.length >= 9 && rejects.every((r) => r.ok) && Number(good.gas) > 0;
  console.log('\nGATE 0');
  console.log(`  honest proof verifies            : ${good.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  every tampered input rejected    : ${rejects.every((r) => r.ok) ? 'PASS' : 'FAIL'} (${rejects.length} cases)`);
  console.log(`  gas is a measured number         : ${Number(good.gas)}`);
  console.log(`\n  ${gate ? 'GATE 0 PASSED — a contract can verify our proof and can refuse a bad one.' : 'GATE 0 FAILED — stop here; publish nothing.'}`);

  fs.writeFileSync(path.join(BUILD, 'gate0-plonk.json'), JSON.stringify({
    at: new Date().toISOString(), protocol: 'plonk', solc: compiled.solcVersion,
    deployedBytecodeBytes: deployed.length / 2, deployGas: Number(dep.execResult.executionGasUsed),
    verifyGasHonest: Number(good.gas), rejectionCases: rejects.length,
    allRejected: rejects.every((r) => r.ok), gate: gate,
  }, null, 2));
  process.exit(gate ? 0 : 1);
}

main().catch((e) => { console.error('GATE 0 ERRORED:', e.message); process.exit(1); });
