// GATE B2 — a contract accepts the Kelly proof and refuses a tampered one, in a real EVM.
//
// Nothing is deployed on chain here and nothing is served. This is the same rehearsal the liquidation
// circuit went through before its verifier reached X Layer: compile the exported Solidity verifier,
// run it in an in-process EVM, and confirm it can both accept and REFUSE. A verifier that cannot
// reject is decoration.
//
// Run: node zk/scripts/gateB2-kelly-evm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from 'ethereum-cryptography/utils.js';
import { load } from './service-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, '..', 'build');
const require = createRequire(import.meta.url);

const SCALE = 1_000_000_000n;
const S = Number(SCALE);
const snap = (x) => Number(x.toFixed(9));
const toScaled = (x) => BigInt(Math.round(snap(x) * S));

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};

console.log(`GATE B2 — Kelly verifier in an EVM — ${new Date().toISOString()}\n`);

// ---- 1. a proof from the real engine's numbers --------------------------------------------------
const { sizeGate } = await load(import.meta.url, 'engine/sizeGate.js');
const p = 0.55, b = 1.2;
const served = sizeGate({ winProb: p, winLossRatio: b });
const pHat = toScaled(p), bHat = toScaled(b);
// Full precision, from the snapped inputs — never the engine's `round(fullKelly, 6)`.
const fFull = (Number(pHat) / S * (Number(bHat) / S + 1) - 1) / (Number(bHat) / S);
const fHat = toScaled(fFull);
console.log(`  engine served f = ${served.fullKellyFraction} · witness certifies f = ${fFull}`);
console.log(`  gap to served   = ${Math.abs(fFull - served.fullKellyFraction).toExponential(2)} (published at 6dp)\n`);

const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
const builder = await require(path.join(BUILD, 'kelly_js', 'witness_calculator.cjs'))(fs.readFileSync(path.join(BUILD, 'kelly_js', 'kelly.wasm')));
const wtns = await builder.calculateWTNSBin({ pHat: pHat.toString(), bHat: bHat.toString(), fHat: fHat.toString() }, 0);
const { proof, publicSignals } = await snarkjs.plonk.prove(path.join(BUILD, 'kelly_plonk.zkey'), wtns);

// Plonk emits two adjacent arrays with no separator between them.
const raw = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
const [proofWords, pubWords] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
record('calldata parses into proof words and public signals',
  Array.isArray(proofWords) && proofWords.length === 24 && pubWords.length === publicSignals.length,
  `${proofWords.length} proof words · ${pubWords.length} public signals`);

// ---- 2. compile the exported verifier -----------------------------------------------------------
const SOL = path.join(BUILD, 'KellyVerifier.sol');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'KellyVerifier.sol': { content: fs.readFileSync(SOL, 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
const contracts = out.contracts['KellyVerifier.sol'];
const V = contracts[Object.keys(contracts)[0]];
console.log(`\n  solc ${solc.version()} · deployed bytecode ${V.evm.deployedBytecode.object.length / 2} bytes\n`);

// ---- 3. run it -----------------------------------------------------------------------------------
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const evm = await EVM.create({ common });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
if (dep.execResult.exceptionError) throw new Error(`deploy failed: ${dep.execResult.exceptionError}`);
const addr = dep.createdAddress;

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const SELECTOR = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${publicSignals.length}])`))).slice(0, 8);
const encode = (pr, pu) => hexToBytes(SELECTOR + [...pr, ...pu].map(pad).join(''));

async function call(label, data, expect) {
  const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
  const err = res.execResult.exceptionError;
  const ret = bytesToHex(res.execResult.returnValue);
  const value = err ? null : BigInt('0x' + (ret || '0')) === 1n;
  const ok = value === expect;
  console.log(`  [${ok ? 'PASS' : '*** FAIL ***'}] ${label.padEnd(30)} returned ${String(value).padEnd(5)} ${res.execResult.executionGasUsed} gas${err ? ` · ${err}` : ''}`);
  return { ok, gas: res.execResult.executionGasUsed };
}

console.log('Calling verifyProof in the EVM:');
const good = await call('honest proof', encode(proofWords, pubWords), true);

let refused = 0;
for (let i = 0; i < pubWords.length; i++) {
  const t = [...pubWords];
  t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
  const r = await call(`tampered signal[${i}]`, encode(proofWords, t), false);
  if (r.ok) refused++;
}
const bent = [...proofWords];
bent[0] = '0x' + (BigInt(bent[0]) + 1n).toString(16);
const bentRes = await call('bent proof point', encode(bent, pubWords), false);
if (bentRes.ok) refused++;

record('the honest proof verifies on chain', good.ok, `${good.gas} gas`);
record('every tampered submission is refused', refused === pubWords.length + 1,
  `${refused} of ${pubWords.length + 1} · cheapest refusal ${bentRes.gas} gas`);

const failed = results.filter((r) => !r.pass);
const gate = failed.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B2: ${gate ? 'PASSED' : `FAILED — ${failed.map((f) => f.name).join('; ')}`}`);
console.log(`  accept ${good.gas} gas · reject ${bentRes.gas} gas · NOT deployed on chain, NOT served by the endpoint`);

fs.writeFileSync(path.join(BUILD, 'gateB2-kelly-evm.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, solc: solc.version(),
  acceptGas: String(good.gas), rejectGas: String(bentRes.gas),
  publicSignals, verifierBytes: V.evm.deployedBytecode.object.length / 2, checks: results,
}, null, 2) + '\n', 'utf8');
await globalThis.curve_bn128?.terminate();
process.exit(gate ? 0 : 1);
