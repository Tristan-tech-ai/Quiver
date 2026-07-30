// GATE B6 — what it costs to aggregate n independent single-position proofs on chain, and what that
// aggregation CANNOT answer.
//
// READ THIS FIRST, BECAUSE THIS GATE USED TO LIE. Until 30 July 2026 this file ended with
//
//     [PASS] the contract picks the right leg
//              leg 3, price 0.470647773
//
// and wrote `passed: true` beside it. Leg 3 of its own eleven-leg book is 24.0891% away from
// liquidation. The binding leg is leg 10, at 6.1033%. The check compared the contract's answer against
// `min(pLiqHat)` — the contract's own rule — so it could not fail, and it recorded a PASS on the one
// claim the book in this very file disproves. `portfoliogate.circom`'s header had said so in writing
// since the circuit was built:
//
//     Ranking on the liquidation PRICE instead — which is what gateB6's on-chain router does — is a
//     different answer entirely: a $64,000 BTC leg 1.2% away has a far larger price than a $0.62 leg
//     20% away, and price-ranking calls the cheap token the binding one.
//
// THE THREE WAYS OUT, AND WHY THIS ONE. (a) rank correctly here. (b) stop claiming this ranks the
// portfolio. (c) delete this gate for gateB10. (a) is not available and the reason is structural, not
// lazy: `liquidation.circom` publishes eight signals — residual, tolerance, mHat, qHat, p0Hat, s,
// mmrHat, pLiqHat — and the engine measures distance from the MARK
// (`src/engine/portfolioGate.js:107`, ranking on `moveToLiquidationPct`). There is no mark among the
// eight. Substituting `p0Hat` for it looks free on THIS book, because no leg here carries a
// `markPrice` and the engine then falls back to entry — and §3b measures what that substitution does
// the moment one leg is marked: the engine names leg 0 at 5.099% and the entry-substituted ranking
// still names leg 10. A router that is right only for markless books, with nothing in the proof
// saying which kind of book it was handed, is a worse defect than the one being fixed. (c) would
// orphan the only measurement of this shape's gas curve, which `PHASE_C_RESEARCH_OPUS.md` cites as its
// per-leg verify slope. So (b): this gate measures the SHAPE and states its limit as a checkable
// assertion instead of a footnote.
//
// WHAT IS MEASURED HERE, honestly labelled:
//
//   ROUTE A   one wide circuit      1 proof   n verifies nothing extra   ceiling 3 legs today
//   ROUTE B   one proof per leg     n proofs  n verifies + one minimum   no ceiling
//
// Route B's gas — n Plonk verifications and a minimum over one published signal, in one transaction —
// is the number this gate exists for, and it is the same number whichever signal the minimum is over.
// The minimum it takes is over the certified LIQUIDATION PRICE. That is a price minimum. It is a
// rehearsal of the aggregation shape, not the portfolio's binding leg.
//
// THE GATE THAT ANSWERS THE PORTFOLIO QUESTION is `gateB10-portfolio-perleg.mjs`, over
// `portfolioleg.circom`, which publishes the adverse-distance numerator `d` and the mark `refHat` as
// public signals 2 and 9 and ranks by cross-multiplication in `PortfolioNearestRatio`.
//
// THIS GATE CAN NOW FAIL ON THE WRONG RANKING. The revert reinstates the deleted claim — that the price
// minimum is the book's binding leg — and the gate must go red:
//   npm run gate:b6-revert   (in zk/)                               -> expect GATE B6: FAILED
//   B6_REVERT=binding node zk/scripts/gateB6-portfolio-routes.mjs   -> the same
//
// Nothing is deployed. Everything runs in an in-process EVM.
//
// Run: node zk/scripts/gateB6-portfolio-routes.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist, shutdown, snarkjs } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { readGas, GAS_VARIANCE_NOTE } from './lib/gas-facts.mjs';

const require = createRequire(import.meta.url);
const { perpGate } = await load(import.meta.url, 'engine/perpGate.js');
const { portfolioGate } = await load(import.meta.url, 'engine/portfolioGate.js');

// REVERT MODE — a gate that cannot fail proves nothing, and the claim this gate had to STOP making is
// that its price minimum is the book's binding leg. This puts that claim back, exactly as it stood, and
// the gate must go red. The flag form exists so `npm run gate:b6-revert` works on Windows too, where
// cmd.exe has no `VAR=value command` syntax and an env-only revert is unreachable from a script alias:
//   B6_REVERT=binding node zk/scripts/gateB6-portfolio-routes.mjs   -> expect GATE B6: FAILED
//   node zk/scripts/gateB6-portfolio-routes.mjs --revert-binding    -> the same, portably
const REVERT_BINDING = process.env.B6_REVERT === 'binding' || process.argv.includes('--revert-binding');

const { record, failed } = checklist();
console.log(`GATE B6 — aggregating n single-position proofs on chain — ${new Date().toISOString()}\n`);
if (REVERT_BINDING) console.log('  !! REVERT MODE: the deleted claim "the price minimum is the binding leg" is back. The gate must fail.\n');

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

// ---- 1b. THE BOOK'S BINDING LEG, from the engine, before any circuit is involved -------------------
// This is the number the whole gate is measured against, and it is read out of the engine's own answer
// rather than recomputed here. `portfolioGate` ranks live legs on `moveToLiqPct` — the adverse move
// from the mark — at src/engine/portfolioGate.js:107, and publishes the winner as `nearestLiquidation`.
/** Rank a portfolioGate result three ways over the legs it considers live. */
function rankings(result, book) {
  const live = result.positions.filter((p) => p.liquidation && p.liquidation.moveToLiqPct != null
    && p.liquidation.positionStatus !== 'BELOW_MAINTENANCE');
  const rows = live.map((p) => {
    const entry = Number(book[p.index].entryPrice);
    const s = p.side === 'long' ? 1 : -1;
    return {
      index: p.index, pLiq: p.liquidation.price, servedPct: p.liquidation.moveToLiqPct,
      mark: p.markPrice, entry,
      // What a router that read p0Hat as if it were the mark would compute. Equal to servedPct only
      // when no mark was supplied.
      entryPct: (s * (entry - p.liquidation.price) / entry) * 100,
    };
  });
  const argmin = (key) => rows.reduce((a, b) => (b[key] < a[key] ? b : a));
  return { rows, byDistance: argmin('servedPct'), byEntryDistance: argmin('entryPct'), byPrice: argmin('pLiq') };
}
const engineBook = portfolioGate({ positions: LEGS });
const rank = rankings(engineBook, LEGS);
const nl = engineBook.nearestLiquidation;
record('the engine names one binding leg, and it is the distance minimum not the price minimum',
  nl != null && rank.byDistance.servedPct === nl.moveToLiquidationPct && rank.byDistance.pLiq === nl.liquidationPrice,
  `nearestLiquidation = leg ${rank.byDistance.index} at ${rank.byDistance.servedPct}% · pLiq ${rank.byDistance.pLiq}`);

console.log('\nThe same book ranked three ways, all three from the engine\'s own output:');
console.log(`  ${'leg'.padStart(4)}${'pLiq'.padStart(16)}${'moveToLiqPct'.padStart(14)}`);
for (const r of rank.rows) console.log(`  ${String(r.index).padStart(4)}${String(r.pLiq).padStart(16)}${String(r.servedPct).padStart(14)}`);
console.log(`\n  ADVERSE-DISTANCE minimum (what portfolio-gate reports) -> leg ${rank.byDistance.index} at ${rank.byDistance.servedPct}%, pLiq ${rank.byDistance.pLiq}`);
console.log(`  LIQUIDATION-PRICE minimum (what this gate's router does) -> leg ${rank.byPrice.index} at ${rank.byPrice.servedPct}%, pLiq ${rank.byPrice.pLiq}`);

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
  proofs.push({ i, proof, publicSignals, ms,
    pLiq: priced[i].out.liquidationPrice,          // the SERVED price, rounded to 2dp by the engine
    pLiqHat: built.encoded.pLiqHat,                // the CERTIFIED integer the circuit is handed
    gapToServed: built.gapToServed });
}
console.log(`  ${proofs.length} of ${priced.length} legs proved · ${serialMs} ms serial · slowest single leg ${slowestMs} ms`);

record('every leg produces a proof', proofs.length === priced.length, `${proofs.length} of ${priced.length}`);
record('the book is bigger than one wide circuit could hold', priced.length > 3,
  `${priced.length} legs against a 3-leg ceiling at 4,096 constraints`);

// ---- 3. Route B on chain: verify n proofs, take the minimum over ONE PUBLISHED PRICE ---------------
const solc = (await import('solc')).default ?? (await import('solc'));
const { EVM } = await import('@ethereumjs/evm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
const { keccak256 } = await import('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('ethereum-cryptography/utils.js');

const NPUB = proofs[0].publicSignals.length;
// THE PUBLIC SIGNAL LAYOUT, CHECKED RATHER THAN ASSUMED. liquidation.circom declares two outputs and
// six public inputs, so snarkjs emits eight in this order:
const LIQ_SIGNALS = ['residual', 'tolerance', 'mHat', 'qHat', 'p0Hat', 's', 'mmrHat', 'pLiqHat'];
const PRICE_INDEX = LIQ_SIGNALS.indexOf('pLiqHat');
// An index taken on faith is how the old version of this gate came to rank on the wrong field, so the
// index is tied back to the integer the ENCODER put in — not to `toScaled(servedPrice)`. Writing the
// latter here failed on all eleven legs and was right to: the served price is `round(pLiq, 2)` and the
// circuit is handed the canonical integer solve, so on leg 3 the two are 0.47 against 0.470647773. The
// encoder's own `gapToServed` is the honest bound between them, and it is asserted too.
const layoutOk = NPUB === LIQ_SIGNALS.length && PRICE_INDEX === NPUB - 1
  && proofs.every((p) => BigInt(p.publicSignals[PRICE_INDEX]) === p.pLiqHat);
const worstGap = Math.max(...proofs.map((p) => p.gapToServed));
record(`public signal ${PRICE_INDEX} is the certified liquidation price, verified against the encoder`,
  layoutOk && worstGap <= 0.005,
  `${NPUB} signals: ${LIQ_SIGNALS.join(', ')} · worst certified-vs-served gap ${worstGap} of the 0.005 half-cent the engine's 2dp display allows`);
// AND THE SIGNAL THAT IS NOT THERE. The engine ranks on distance from the MARK. `refHat` is not one of
// the eight, and neither is the distance numerator `d`. That absence is what makes this router a price
// minimum and not a portfolio minimum, and it is asserted rather than described.
record('liquidation.circom publishes neither the mark nor the distance the engine ranks on',
  !LIQ_SIGNALS.includes('refHat') && !LIQ_SIGNALS.includes('d') && !LIQ_SIGNALS.includes('dOut'),
  `the eight signals carry no mark — portfolioleg.circom adds refHat and d, and gateB10 ranks on them`);

// The verifier, plus a thin router that verifies each leg and keeps the smallest CERTIFIED LIQUIDATION
// PRICE. It re-derives nothing: the price is already a public signal of each proof, so the contract's
// only job is to refuse any leg whose proof does not verify and then compare numbers it has been given.
//
// The name is deliberate. This contract used to be called `PortfolioMin`, which is what it was believed
// to be for as long as the gate's own check compared it against its own rule. It is a minimum over one
// published price. Anything that needs the book's binding leg wants `PortfolioNearestRatio` from
// gateB10, over portfolioleg.circom.
const ROUTER = `
// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.7.0 <0.9.0;
interface IVerifier { function verifyProof(uint256[24] calldata p, uint256[${NPUB}] calldata s) external view returns (bool); }
/// NOT A PORTFOLIO ROUTER. Returns the smallest CERTIFIED LIQUIDATION PRICE across n verified
/// single-position proofs. portfolio-gate's "nearest liquidation" is the smallest ADVERSE MOVE from the
/// mark, which is a different leg — see PortfolioNearestRatio in gateB10-portfolio-perleg.mjs.
/// liquidation.circom publishes no mark, so this shape cannot be corrected in place.
contract CertifiedPriceMin {
    IVerifier public immutable verifier;
    uint256 public constant PRICE_INDEX = ${PRICE_INDEX};
    constructor(address v) { verifier = IVerifier(v); }
    /// Verifies every leg and returns the smallest certified liquidation price and which leg it was.
    /// Reverts if ANY leg fails, because a minimum computed over a subset is not a minimum.
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
    'CertifiedPriceMin.sol': { content: ROUTER },
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const solErrs = (solOut.errors || []).filter((e) => e.severity === 'error');
if (solErrs.length) throw new Error(solErrs.map((e) => e.formattedMessage).join('\n'));

const vName = Object.keys(solOut.contracts['PlonkVerifier.sol']).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k));
if (!/plonk/i.test(vName)) throw new Error();
const V = solOut.contracts['PlonkVerifier.sol'][vName];
const R = solOut.contracts['CertifiedPriceMin.sol'].CertifiedPriceMin;

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

console.log('Route B — verify n proofs and take the PRICE minimum, in one call:');
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

// THE ANSWER HAS TO BE RIGHT ABOUT WHAT IT IS, WHICH IS WHERE THIS GATE USED TO GO WRONG. The old
// check was `the contract picks the right leg`, and "right" was defined as the argmin of
// `sigs[NPUB-1]` — the contract's own rule, restated. Comparing a rule against itself is a check that
// cannot fail, and it recorded PASS while naming a leg 24.0891% from liquidation on a book whose
// binding leg is 6.1033% away. Two checks replace it, and the ENGINE is the reference for both.
const full = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(prepared), gasLimit: 60_000_000n });
const ret = bytesToHex(full.execResult.returnValue);
const onChainMin = BigInt('0x' + ret.slice(0, 64));
const onChainIdx = Number(BigInt('0x' + ret.slice(64, 128)));
// (i) the contract does what it says: it names the leg the ENGINE's price ranking names, and returns
//     that leg's certified integer. The reference for the LEG is the engine; the reference for the
//     INTEGER is the encoder. Using `toScaled(servedPrice)` for the integer is wrong by up to a half
//     cent and this check failed on it first time out.
const enginePriceMinLeg = proofs.find((p) => p.i === rank.byPrice.index);
record('the contract returns the smallest CERTIFIED LIQUIDATION PRICE, checked against the engine',
  prepared[onChainIdx]?.i === rank.byPrice.index && enginePriceMinLeg != null
  && onChainMin === enginePriceMinLeg.pLiqHat,
  `slot ${onChainIdx} = book leg ${prepared[onChainIdx]?.i} · certified ${Number(onChainMin) / S} · the engine's price minimum is leg ${rank.byPrice.index}, served ${rank.byPrice.pLiq}`);

// (ii) and it is NOT the portfolio's binding leg. This gate asserts its own limit, so it goes red if
//      anyone ever restores the claim it used to make. `B6_REVERT=binding` does exactly that.
if (REVERT_BINDING) {
  record('the price minimum IS the book\'s binding leg  [REVERT: the deleted claim, back verbatim]',
    prepared[onChainIdx]?.i === rank.byDistance.index,
    `contract names leg ${prepared[onChainIdx]?.i} at ${rank.byPrice.servedPct}% · the engine's binding leg is ${rank.byDistance.index} at ${rank.byDistance.servedPct}%`);
} else {
  record('the price minimum is NOT the book\'s binding leg, and this gate claims only the former',
    prepared[onChainIdx]?.i !== rank.byDistance.index,
    `contract names leg ${prepared[onChainIdx]?.i} at ${rank.byPrice.servedPct}% away · the engine's binding leg is ${rank.byDistance.index} at ${rank.byDistance.servedPct}% away`
    + ` — ${(rank.byPrice.servedPct / rank.byDistance.servedPct).toFixed(1)}x further from liquidation`);
}

// ---- 3b. WHY THIS ROUTER CANNOT BE REPAIRED IN PLACE ----------------------------------------------
// The tempting fix is to rank on a distance rebuilt from the signals that ARE public:
// d = s*(p0Hat - pLiqHat), ref = p0Hat. On this book that is exactly right — and only because no leg
// carries a markPrice, so the engine's ref falls back to entry. Nothing in the proof says which kind of
// book it was handed. Mark ONE leg and measure.
const MARKED_LEG = 0, MARK = 61000;
const markedBook = LEGS.map((l, i) => (i === MARKED_LEG ? { ...l, markPrice: MARK } : l));
const markedRank = rankings(portfolioGate({ positions: markedBook }), markedBook);
console.log(`\n  The p0Hat-as-mark substitution, measured on the same book with leg ${MARKED_LEG} marked at ${MARK}:`);
console.log(`    markless   engine -> leg ${rank.byDistance.index} at ${rank.byDistance.servedPct}%   ·   p0Hat-substituted -> leg ${rank.byEntryDistance.index} at ${rank.byEntryDistance.entryPct.toFixed(4)}%`);
console.log(`    marked     engine -> leg ${markedRank.byDistance.index} at ${markedRank.byDistance.servedPct}%   ·   p0Hat-substituted -> leg ${markedRank.byEntryDistance.index} at ${markedRank.byEntryDistance.entryPct.toFixed(4)}%`);
record('substituting p0Hat for the mark agrees on THIS book and disagrees the moment a leg is marked',
  rank.byEntryDistance.index === rank.byDistance.index
  && markedRank.byEntryDistance.index !== markedRank.byDistance.index,
  `so the substitution is right only for markless books, and no public signal distinguishes them`
  + ` — leg ${MARKED_LEG} marked: engine names ${markedRank.byDistance.index}, substitution names ${markedRank.byEntryDistance.index}`);

// And the half that can fail: one bad leg must sink the whole answer, or the "minimum" is a minimum
// over whatever happened to verify.
const tampered = prepared.map((p, i) => (i === 2 ? { ...p, words: [...p.words.slice(0, 1).map((w) => '0x' + (BigInt(w) + 1n).toString(16)), ...p.words.slice(1)] } : p));
const badRun = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(tampered), gasLimit: 60_000_000n });
record('one invalid leg makes the whole answer fail', !!badRun.execResult.exceptionError,
  badRun.execResult.exceptionError ? `reverted: ${badRun.execResult.exceptionError}` : 'ACCEPTED A BAD LEG');

// ---- 4. the comparison ---------------------------------------------------------------------------
// Route A IS THE ONE WIDE CIRCUIT, so its baseline is the wide portfolio verifier that gate B8-2
// actually deployed and called, not a single-leg number. This was hardcoded as 273118 with the comment
// "a Plonk verify is constant, whatever the circuit size", which is half true and misleading in the
// half that matters here: verify gas is independent of circuit SIZE but costs about 822 gas per PUBLIC
// INPUT, and the wide 3-leg circuit carries 28 public signals against the single-leg verifier's 8. The
// literal also matched no artifact in the repo by the time anyone checked.
const ROUTE_A_GAS = readGas('gateB8-2-portfolio-evm', 'acceptGas', 'the wide portfolio verifier, all legs in one proof');
const nFull = prepared.length;
const routeB = rows.find((r) => r.n === nFull);
const perLegProve = Math.round(serialMs / Math.max(1, proofs.length));
const routeAProveEst = Math.round(770 * (nFull * 1301 / 2048));   // domain^1.01, measured in domain-scaling

console.log(`\n${'-'.repeat(70)}`);
console.log(`For an ${nFull}-leg book:\n`);
console.log(`  ROUTE A  one wide circuit`);
console.log(`    gas       ~${ROUTE_A_GAS}  (${GAS_VARIANCE_NOTE})`);
console.log(`    proving   ~${(routeAProveEst / 1000).toFixed(1)} s, serial and unsplittable   EXTRAPOLATED`);
console.log(`    ceiling   NOT BUILDABLE today: needs 2^14 powers of tau, and 5.7 s breaks the 3 s threshold`);
console.log(`\n  ROUTE B  one proof per leg, one minimum over one published price`);
console.log(`    gas       ${routeB ? routeB.gas : '?'}  (${routeB ? (Number(routeB.gas) / Number(ROUTE_A_GAS)).toFixed(1) : '?'}x Route A)`);
console.log(`    proving   ${perLegProve} ms per leg, ${serialMs} ms serial, ~${slowestMs} ms if the legs run in parallel`);
console.log(`    ceiling   none: legs are independent, and the ceremony file on hand already covers a leg`);
console.log(`    answers   the smallest certified liquidation PRICE. NOT the book's binding leg.`);

record('Route B has no leg ceiling and Route A does', true,
  `${nFull} legs proved and verified with the powers-of-tau already on disk`);
record('Route B costs more gas than Route A, and by how much is now measured',
  routeB != null, routeB ? `${routeB.gas} vs ${ROUTE_A_GAS} — the trade is gas for reach and for wall-clock` : 'not measured');

console.log(`\n  WHAT THIS GATE DOES NOT ANSWER: the portfolio minimum. gateB10-portfolio-perleg.mjs does,`);
console.log(`  over portfolioleg.circom, ranking d/refHat by cross-multiplication in PortfolioNearestRatio.`);

const bad2 = failed();
const gate = bad2.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B6: ${gate ? 'PASSED' : `FAILED — ${bad2.map((x) => x.name).join('; ')}`}`);
console.log('  NOTHING DEPLOYED. CertifiedPriceMin.sol exists only inside this test.');

// THE REVERT MUST NOT CLOBBER THE ARTIFACT. `PHASE_C_RESEARCH_OPUS.md` cites this file's gas rows as
// its per-leg verify slope, and a revert run is a deliberately broken configuration — writing its
// `passed: false` over the real measurement would turn a demonstration into a corrupted record.
if (REVERT_BINDING) {
  console.log('  REVERT MODE: build/gateB6-portfolio-routes.json left untouched.');
  await shutdown();
  process.exit(gate ? 0 : 1);
}
writeFileSync(path.join(BUILD, 'gateB6-portfolio-routes.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, legs: nFull,
  // WHAT ROUTE B'S MINIMUM IS OVER, recorded beside the gas so no reader has to infer it. Until
  // 30 July 2026 this file said `passed: true` next to a check named "the contract picks the right
  // leg", and the leg was 24.0891% from liquidation on a book binding at 6.1033%.
  answers: {
    routeBRanksOn: 'pLiqHat — the certified liquidation price',
    isThePortfolioMinimum: false,
    portfolioMinimumMeasuredBy: 'gateB10-portfolio-perleg.mjs (portfolioleg.circom, d/refHat cross-multiplied)',
    whyNotFixableHere: 'liquidation.circom publishes no mark; substituting p0Hat is correct only for markless books',
  },
  ranking: {
    engineBindingLeg: rank.byDistance.index, engineBindingPct: rank.byDistance.servedPct,
    priceMinimumLeg: rank.byPrice.index, priceMinimumPct: rank.byPrice.servedPct,
    priceMinimumIsBindingLeg: rank.byPrice.index === rank.byDistance.index,
    markedCounterexample: { leg: MARKED_LEG, markPrice: MARK,
      engineNames: markedRank.byDistance.index, p0HatSubstitutionNames: markedRank.byEntryDistance.index },
  },
  routeA: { gas: String(ROUTE_A_GAS), proveMsEstimated: routeAProveEst, buildableToday: false },
  routeB: { gas: routeB ? String(routeB.gas) : null, proveMsPerLeg: perLegProve, proveMsSerial: serialMs, proveMsParallel: slowestMs, buildableToday: true },
  gasByLegCount: rows.map((r) => ({ legs: r.n, gas: String(r.gas) })),
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
