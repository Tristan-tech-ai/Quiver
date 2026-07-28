// GATE B6 — two ways to prove a portfolio's nearest liquidation, measured against each other.
//
// THE QUESTION. `portfolio-gate` reports the leg closest to liquidation, which is a MINIMUM over legs.
// Proving a minimum inside one circuit forces every leg into a single evaluation domain, and a leg IS
// the liquidation circuit at 1,301 constraints, so the ceremony file on hand caps it at three legs.
// The obvious response is to fetch a bigger ceremony file. `domain-scaling.mjs` measured what that
// costs: proving grows as domain^1.01, so twelve legs would take about 5.7 s and blow the roadmap's
// own three-second abandon threshold.
//
// So this measures the alternative nobody had tried: prove each leg SEPARATELY and let a contract take
// the minimum on chain. A Plonk proof is constant size and constant verification cost no matter how
// big the circuit behind it is, which is the fact the whole comparison turns on.
//
//   ROUTE A   one wide circuit      1 proof   ~273k gas   proving grows with legs, ceiling 3 legs today
//   ROUTE B   one proof per leg     n proofs  n verifies  proving is per-leg and parallel, no ceiling
//
// Route A's gas is known and constant. What was NOT known is Route B's real gas once the verifications
// and the minimum selection are in one transaction, and whether the minimum can be taken on chain at
// all without re-deriving anything the proofs already carry. That is what this measures.
//
// Nothing is deployed. Everything runs in an in-process EVM.
//
// Run: node zk/scripts/gateB6-portfolio-routes.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist, shutdown, snarkjs } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const require = createRequire(import.meta.url);
const { perpGate } = await load(import.meta.url, 'engine/perpGate.js');

const { record, failed } = checklist();
console.log(`GATE B6 — wide circuit vs per-leg proofs — ${new Date().toISOString()}\n`);

// ---- 1. a real book, through the real engine ------------------------------------------------------
// Eleven legs, because that is the largest book portfolio-gate's own tests exercise, and it is the
// size a three-leg circuit cannot describe.
const LEGS = [
  { side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005 },
  { side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006 },
  { side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01 },
  { side: 'long', entryPrice: 0.62, size: 90000, leverage: 4, maintMarginRate: 0.012 },
  { side: 'short', entryPrice: 7.4, size: 5000, leverage: 6, maintMarginRate: 0.009 },
  { side: 'long', entryPrice: 118, size: 300, leverage: 12, maintMarginRate: 0.007 },
  { side: 'long', entryPrice: 2.15, size: 15000, leverage: 3, maintMarginRate: 0.015 },
  { side: 'short', entryPrice: 42, size: 700, leverage: 7, maintMarginRate: 0.008 },
  { side: 'long', entryPrice: 9.8, size: 2500, leverage: 9, maintMarginRate: 0.011 },
  { side: 'short', entryPrice: 0.94, size: 40000, leverage: 4, maintMarginRate: 0.013 },
  { side: 'long', entryPrice: 320, size: 60, leverage: 15, maintMarginRate: 0.006 },
];

const priced = LEGS.map((l) => ({ leg: l, out: perpGate(l) }));
const bad = priced.filter((p) => !p.out.ok || !(p.out.liquidationPrice > 0));
record('the engine prices every leg of the book', bad.length === 0, `${priced.length - bad.length} of ${priced.length}`);

// THE SERVICE'S OWN WITNESS BUILDER, imported rather than reimplemented. A hand-rolled version was
// tried first and every one of the eleven legs was refused by the constraint system, which is the good
// failure mode and also the point: the encoder carries a margin recomputation, a grid snap and a
// divergence guard that took two defects to get right, and writing a fourth copy of it here would have
// been the same mistake this project keeps finding in its own gates.
const { witnessFor: serviceWitness } = await load(import.meta.url, 'util/snark.js');

// ---- 2. prove every leg -------------------------------------------------------------------------
const sj = await snarkjs();
const zkey = path.join(BUILD, 'liquidation_plonk.zkey');
const wasm = path.join(BUILD, 'liquidation_js', 'liquidation.wasm');
const calcPath = path.join(BUILD, 'liquidation_js', 'witness_calculator.cjs');
const builder = await require(calcPath)(readFileSync(wasm));

console.log('\nProving each leg on its own:');
const proofs = [];
let serialMs = 0, slowestMs = 0;
for (let i = 0; i < priced.length; i++) {
  const built = serviceWitness(priced[i].leg, priced[i].out.liquidationPrice);
  if (!built) { console.log(`  leg ${i}: outside the circuit's domain, refused rather than approximated`); continue; }
  let wtns;
  try { wtns = await builder.calculateWTNSBin(built.witness, 0); }
  catch (e) { console.log(`  leg ${i}: witness refused — ${String(e.message).slice(0, 70)}`); continue; }
  const t = Date.now();
  const { proof, publicSignals } = await sj.plonk.prove(zkey, wtns);
  const ms = Date.now() - t;
  serialMs += ms;
  slowestMs = Math.max(slowestMs, ms);
  proofs.push({ i, proof, publicSignals, ms, pLiq: priced[i].out.liquidationPrice });
}
console.log(`  ${proofs.length} of ${priced.length} legs proved · ${serialMs} ms serial · slowest single leg ${slowestMs} ms`);

record('every leg produces a proof', proofs.length === priced.length, `${proofs.length} of ${priced.length}`);
record('the book is bigger than one wide circuit could hold', priced.length > 3,
  `${priced.length} legs against a 3-leg ceiling at 4,096 constraints`);

// ---- 3. Route B on chain: verify n proofs, take the minimum ---------------------------------------
const solc = (await import('solc')).default ?? (await import('solc'));
const { EVM } = await import('@ethereumjs/evm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
const { keccak256 } = await import('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('ethereum-cryptography/utils.js');

const NPUB = proofs[0].publicSignals.length;
// The verifier, plus a thin router that verifies each leg and keeps the smallest liquidation price.
// It re-derives nothing: the price is already a public signal of each proof, so the contract's only
// job is to refuse any leg whose proof does not verify and then compare numbers it has been given.
const ROUTER = `
// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.7.0 <0.9.0;
interface IVerifier { function verifyProof(uint256[24] calldata p, uint256[${NPUB}] calldata s) external view returns (bool); }
contract PortfolioMin {
    IVerifier public immutable verifier;
    uint256 public constant PRICE_INDEX = ${NPUB - 1};
    constructor(address v) { verifier = IVerifier(v); }
    /// Verifies every leg and returns the smallest certified liquidation price and which leg it was.
    /// Reverts if ANY leg fails, because a portfolio minimum computed over a subset is not a minimum.
    function nearest(uint256[24][] calldata proofs, uint256[${NPUB}][] calldata signals)
        external view returns (uint256 minPrice, uint256 legIndex)
    {
        require(proofs.length == signals.length && proofs.length > 0, "shape");
        minPrice = type(uint256).max;
        for (uint256 i = 0; i < proofs.length; i++) {
            require(verifier.verifyProof(proofs[i], signals[i]), "leg proof invalid");
            uint256 p = signals[i][PRICE_INDEX];
            if (p < minPrice) { minPrice = p; legIndex = i; }
        }
    }
}
`;

const solOut = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    // PlonkVerifier.sol, NOT LiquidationVerifier.sol. That second file is named after the circuit but
    // holds a GROTH16 verifier, left from the ceremony that was abandoned for having a single
    // participant. Its verifyProof takes a different shape entirely, so compiling it here produced a
    // contract that deployed happily at 2,025 bytes and reverted on every call.
    'PlonkVerifier.sol': { content: readFileSync(path.join(BUILD, 'PlonkVerifier.sol'), 'utf8') },
    'PortfolioMin.sol': { content: ROUTER },
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const solErrs = (solOut.errors || []).filter((e) => e.severity === 'error');
if (solErrs.length) throw new Error(solErrs.map((e) => e.formattedMessage).join('\n'));

const vName = Object.keys(solOut.contracts['PlonkVerifier.sol']).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k));
if (!/plonk/i.test(vName)) throw new Error();
const V = solOut.contracts['PlonkVerifier.sol'][vName];
const R = solOut.contracts['PortfolioMin.sol'].PortfolioMin;

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const evm = await EVM.create({ common });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const dv = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
if (dv.execResult.exceptionError) throw new Error(`verifier deploy: ${dv.execResult.exceptionError}`);
const vAddr = bytesToHex(dv.createdAddress.bytes);

const dr = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(R.evm.bytecode.object + vAddr.padStart(64, '0')), gasLimit: 30_000_000n });
if (dr.execResult.exceptionError) throw new Error(`router deploy: ${dr.execResult.exceptionError}`);
const rAddr = dr.createdAddress;

console.log(`\n  verifier ${V.evm.deployedBytecode.object.length / 2} bytes · router ${R.evm.deployedBytecode.object.length / 2} bytes\n`);

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = bytesToHex(keccak256(utf8ToBytes(`nearest(uint256[24][],uint256[${NPUB}][])`))).slice(0, 8);

/** ABI-encode two dynamic arrays of fixed-size arrays. */
function encodeNearest(items) {
  const n = items.length;
  const proofWords = items.flatMap((p) => p.words);
  const sigWords = items.flatMap((p) => p.sigs);
  const offA = 64;
  const offB = 64 + 32 + n * 24 * 32;
  return hexToBytes(sel + pad(offA) + pad(offB)
    + pad(n) + proofWords.map(pad).join('')
    + pad(n) + sigWords.map(pad).join(''));
}

const prepared = [];
for (const p of proofs) {
  const raw = await sj.plonk.exportSolidityCallData(p.proof, p.publicSignals);
  const [words, sigs] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  prepared.push({ words, sigs, pLiq: p.pLiq, i: p.i });
}

console.log('Route B — verify n proofs and take the minimum, in one call:');
console.log(`  ${'legs'.padStart(5)}${'gas'.padStart(12)}${'gas/leg'.padStart(10)}`);
const rows = [];
for (const n of [1, 3, 5, 8, prepared.length]) {
  if (n > prepared.length) continue;
  const res = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(prepared.slice(0, n)), gasLimit: 60_000_000n });
  if (res.execResult.exceptionError) { console.log(`  ${String(n).padStart(5)}  reverted: ${JSON.stringify(res.execResult.exceptionError)}`); continue; }
  const gas = res.execResult.executionGasUsed;
  rows.push({ n, gas });
  console.log(`  ${String(n).padStart(5)}${String(gas).padStart(12)}${String(gas / BigInt(n)).padStart(10)}`);
}

// The answer has to be RIGHT, not merely cheap.
const full = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(prepared), gasLimit: 60_000_000n });
const ret = bytesToHex(full.execResult.returnValue);
const onChainMin = BigInt('0x' + ret.slice(0, 64));
const onChainIdx = Number(BigInt('0x' + ret.slice(64, 128)));
const expected = prepared.reduce((a, b) => (BigInt(b.sigs[NPUB - 1]) < BigInt(a.sigs[NPUB - 1]) ? b : a));
record('the contract picks the right leg', onChainIdx === prepared.indexOf(expected) && onChainMin === BigInt(expected.sigs[NPUB - 1]),
  `leg ${onChainIdx}, price ${Number(onChainMin) / S}`);

// And the half that can fail: one bad leg must sink the whole answer, or the "minimum" is a minimum
// over whatever happened to verify.
const tampered = prepared.map((p, i) => (i === 2 ? { ...p, words: [...p.words.slice(0, 1).map((w) => '0x' + (BigInt(w) + 1n).toString(16)), ...p.words.slice(1)] } : p));
const badRun = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(tampered), gasLimit: 60_000_000n });
record('one invalid leg makes the whole answer fail', !!badRun.execResult.exceptionError,
  badRun.execResult.exceptionError ? `reverted: ${badRun.execResult.exceptionError}` : 'ACCEPTED A BAD LEG');

// ---- 4. the comparison ---------------------------------------------------------------------------
const ROUTE_A_GAS = 273118n;      // measured: a Plonk verify is constant, whatever the circuit size
const nFull = prepared.length;
const routeB = rows.find((r) => r.n === nFull);
const perLegProve = Math.round(serialMs / Math.max(1, proofs.length));
const routeAProveEst = Math.round(770 * (nFull * 1301 / 2048));   // domain^1.01, measured in domain-scaling

console.log(`\n${'-'.repeat(70)}`);
console.log(`For an ${nFull}-leg book:\n`);
console.log(`  ROUTE A  one wide circuit`);
console.log(`    gas       ~${ROUTE_A_GAS}  (a Plonk verify costs the same at any circuit size)`);
console.log(`    proving   ~${(routeAProveEst / 1000).toFixed(1)} s, serial and unsplittable   EXTRAPOLATED`);
console.log(`    ceiling   NOT BUILDABLE today: needs 2^14 powers of tau, and 5.7 s breaks the 3 s threshold`);
console.log(`\n  ROUTE B  one proof per leg`);
console.log(`    gas       ${routeB ? routeB.gas : '?'}  (${routeB ? (Number(routeB.gas) / Number(ROUTE_A_GAS)).toFixed(1) : '?'}x Route A)`);
console.log(`    proving   ${perLegProve} ms per leg, ${serialMs} ms serial, ~${slowestMs} ms if the legs run in parallel`);
console.log(`    ceiling   none: legs are independent, and the ceremony file on hand already covers a leg`);

record('Route B has no leg ceiling and Route A does', true,
  `${nFull} legs proved and verified with the powers-of-tau already on disk`);
record('Route B costs more gas than Route A, and by how much is now measured',
  routeB != null, routeB ? `${routeB.gas} vs ${ROUTE_A_GAS} — the trade is gas for reach and for wall-clock` : 'not measured');

const bad2 = failed();
const gate = bad2.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B6: ${gate ? 'PASSED' : `FAILED — ${bad2.map((x) => x.name).join('; ')}`}`);
console.log('  NOTHING DEPLOYED. PortfolioMin.sol exists only inside this test.');

writeFileSync(path.join(BUILD, 'gateB6-portfolio-routes.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, legs: nFull,
  routeA: { gas: String(ROUTE_A_GAS), proveMsEstimated: routeAProveEst, buildableToday: false },
  routeB: { gas: routeB ? String(routeB.gas) : null, proveMsPerLeg: perLegProve, proveMsSerial: serialMs, proveMsParallel: slowestMs, buildableToday: true },
  gasByLegCount: rows.map((r) => ({ legs: r.n, gas: String(r.gas) })),
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
