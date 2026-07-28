// Shared machinery for the circuit gates.
//
// The roadmap's definition of done for Phase B says the divergence guard must be "shared, not
// copy-pasted", and the same applies to the two halves that are genuinely identical across circuits:
// prove-verify-and-REFUSE, and the in-EVM rehearsal of the exported Solidity verifier. Three copies of
// a refusal loop is three places for one of them to quietly stop refusing.
//
// What deliberately is NOT here: the sweep against the live engine. That is different for every
// circuit because every engine publishes a different rounded field, and a generic sweep would end up
// comparing a formula against itself, which is the exact failure mode the sweeps exist to catch.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build');

export const SCALE = 1_000_000_000n;
export const S = Number(SCALE);
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Round the DECIMAL, never the scaled product: `Math.round(x * 1e9)` is wrong above ~9e6, where the
 *  product passes 2^53 and the last digits are no longer representable. */
export const snap = (x) => Number(x.toFixed(9));

/**
 * Scale onto the 1e-9 grid, exactly, at every magnitude.
 *
 * THIS FUNCTION USED TO CONTRADICT THE COMMENT ABOVE IT. It read
 * `BigInt(Math.round(snap(x) * S))`, which is precisely the scaled product the comment warns against.
 * For a probability or a Kelly fraction that is harmless, since the product stays under 2^53. For an
 * AMM reserve it is not: at x = 8.03e8 the product is 8.03e17, where a double's granularity is 128,
 * so the returned integer was wrong by up to sixty-four grid steps. Gate B5-1 found it by refusing to
 * certify 455 of 3,595 pools, and the refusals were right — the encoder really was producing a
 * different pool from the one the engine priced.
 *
 * The fix is to never form the product as a double. `toFixed(9)` is the correctly-rounded decimal
 * expansion, so splitting it on the point and reassembling in BigInt is exact at any magnitude.
 */
export const toScaled = (x, name = 'value') => {
  const v = Number(x);
  if (!Number.isFinite(v)) throw new Error(`${name}: not finite`);
  if (v < 0) throw new Error(`${name}: negative`);
  const [whole, frac = ''] = v.toFixed(9).split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(9, '0'));
};

/** Field elements above p/2 are the encoding of negative integers; show them as such. */
export const asInt = (x) => { const v = BigInt(x); return v > FIELD / 2n ? v - FIELD : v; };

/** A tiny pass/fail recorder so every gate reports in one shape. */
export function checklist() {
  const results = [];
  return {
    results,
    record(name, pass, detail) {
      results.push({ name, pass: !!pass });
      console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
      return !!pass;
    },
    failed: () => results.filter((r) => !r.pass),
  };
}

export async function snarkjs() {
  const m = await import('snarkjs');
  return m.default ?? m;
}

/**
 * Prove a witness, verify it, then REFUSE every single-signal perturbation and a bent proof point.
 *
 * The refusal half is the half that can fail, so it is not optional and it is not summarised: each
 * perturbation is printed. A verifier that accepts a moved signal is not a verifier.
 */
export async function proveVerifyRefuse(circuit, witness, { record }) {
  const sj = await snarkjs();
  const wasm = path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`);
  const zkey = path.join(BUILD, `${circuit}_plonk.zkey`);
  const vk = JSON.parse(readFileSync(path.join(BUILD, `${circuit}_vk.json`), 'utf8'));

  const builder = await require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.cjs'))(readFileSync(wasm));
  const wtns = await builder.calculateWTNSBin(witness, 0);

  const t0 = Date.now();
  const { proof, publicSignals } = await sj.plonk.prove(zkey, wtns);
  const proveMs = Date.now() - t0;

  const ok = await sj.plonk.verify(vk, publicSignals, proof);
  record('the honest proof verifies against the published key', ok === true,
    `proved in ${proveMs} ms · ${publicSignals.length} public signals · nPublic ${vk.nPublic}`);

  console.log('\nRefusals — each public signal moved by one, on its own:');
  let refused = 0;
  for (let i = 0; i < publicSignals.length; i++) {
    const bad = [...publicSignals];
    bad[i] = (BigInt(bad[i]) + 1n).toString();
    const accepted = await sj.plonk.verify(vk, bad, proof);
    if (accepted === false) refused++;
    console.log(`  [${accepted === false ? 'PASS' : '*** FAIL ***'}] signal[${i}] + 1 -> ${accepted}`);
  }
  record('every perturbed public signal is rejected', refused === publicSignals.length,
    `${refused} of ${publicSignals.length}`);

  const bent = JSON.parse(JSON.stringify(proof));
  bent.A[0] = (BigInt(bent.A[0]) + 1n).toString();
  let bentAccepted;
  try { bentAccepted = await sj.plonk.verify(vk, publicSignals, bent); } catch { bentAccepted = false; }
  record('a bent proof point is rejected', bentAccepted === false, `returned ${bentAccepted}`);

  return { proof, publicSignals, proveMs, vk };
}

/**
 * Compile the exported Solidity verifier, run it in an in-process EVM, and require that it both
 * accepts the honest proof and refuses every tampered submission. Returns the gas for each.
 *
 * Nothing is deployed on chain here. A verifier that has never been asked to reject is decoration.
 */
export async function evmRehearsal(circuit, proof, publicSignals, { record }) {
  const sj = await snarkjs();
  const solc = (await import('solc')).default ?? (await import('solc'));
  const { EVM } = await import('@ethereumjs/evm');
  const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
  const { keccak256 } = await import('ethereum-cryptography/keccak.js');
  const { utf8ToBytes, bytesToHex, hexToBytes } = await import('ethereum-cryptography/utils.js');

  const solName = `${circuit[0].toUpperCase()}${circuit.slice(1)}Verifier.sol`;
  const source = readFileSync(path.join(BUILD, solName), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [solName]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));

  // Select by NAME. Taking Object.keys()[0] once picked the IPlonkVerifier *interface*, which compiles
  // to almost nothing and deploys happily, and the failure only surfaced two steps later.
  const contracts = out.contracts[solName];
  const key = Object.keys(contracts).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(contracts)[0];
  const V = contracts[key];
  const deployedSize = V.evm.deployedBytecode.object.length / 2;
  console.log(`\n  solc ${solc.version()} · contract ${key} · deployed ${deployedSize} bytes\n`);

  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const evm = await EVM.create({ common });
  const caller = hexToBytes('1000000000000000000000000000000000000001');
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy failed: ${dep.execResult.exceptionError}`);
  const addr = dep.createdAddress;

  // Plonk emits two adjacent arrays with no separator between them.
  const raw = await sj.plonk.exportSolidityCallData(proof, publicSignals);
  const [proofWords, pubWords] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  record('calldata parses into proof words and public signals',
    Array.isArray(proofWords) && proofWords.length === 24 && pubWords.length === publicSignals.length,
    `${proofWords.length} proof words · ${pubWords.length} public signals`);

  const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
  const selector = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${publicSignals.length}])`))).slice(0, 8);
  const encode = (pr, pu) => hexToBytes(selector + [...pr, ...pu].map(pad).join(''));

  const call = async (label, data, expect) => {
    const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
    const err = res.execResult.exceptionError;
    const ret = bytesToHex(res.execResult.returnValue);
    const value = err ? null : BigInt('0x' + (ret || '0')) === 1n;
    const ok = value === expect;
    console.log(`  [${ok ? 'PASS' : '*** FAIL ***'}] ${label.padEnd(30)} returned ${String(value).padEnd(5)} ${res.execResult.executionGasUsed} gas${err ? ` · ${err}` : ''}`);
    return { ok, gas: res.execResult.executionGasUsed };
  };

  console.log('Calling verifyProof in the EVM:');
  const good = await call('honest proof', encode(proofWords, pubWords), true);

  let refused = 0;
  for (let i = 0; i < pubWords.length; i++) {
    const t = [...pubWords];
    t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
    if ((await call(`tampered signal[${i}]`, encode(proofWords, t), false)).ok) refused++;
  }
  const bentWords = [...proofWords];
  bentWords[0] = '0x' + (BigInt(bentWords[0]) + 1n).toString(16);
  const bentRes = await call('bent proof point', encode(bentWords, pubWords), false);
  if (bentRes.ok) refused++;

  record('the honest proof verifies on chain', good.ok, `${good.gas} gas`);
  record('every tampered submission is refused', refused === pubWords.length + 1,
    `${refused} of ${pubWords.length + 1} · cheapest refusal ${bentRes.gas} gas`);

  return { acceptGas: good.gas, rejectGas: bentRes.gas, deployedSize, solc: solc.version() };
}

/** Close down the BN254 worker pool, or the process hangs after a gate finishes. */
export async function shutdown() {
  await globalThis.curve_bn128?.terminate();
}
