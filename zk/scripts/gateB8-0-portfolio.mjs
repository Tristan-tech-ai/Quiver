// GATE B8-0 — portfolio-gate's nearest liquidation: prove, verify, and REFUSE.
//
// The refusal half is the half that can fail. A circuit that proves a MINIMUM has a failure mode the
// single-leg circuits do not: it can be perfectly correct about every leg's arithmetic and still name
// the wrong leg. Nothing in the liquidation identity catches that — each leg's residual is fine — so
// the only thing standing between a book and a confident lie is the comparison, and the only way to
// know the comparison works is to hand it a lie and watch it refuse.
//
// So the centrepiece here is not the honest proof. It is the run where the witness names the
// runner-up, with every other signal honest, twice: once with the two legs 2.4 points apart and once
// with them a thousandth of a point apart. Both must die in the witness calculator, before a proof
// exists to be verified.
//
// Run: node zk/scripts/gateB8-0-portfolio.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, S, asInt, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { makeBuilder, distPct } from './lib/portfolio-witness.mjs';

const require = createRequire(import.meta.url);
const CIRCUIT = 'portfoliogate';
const { record, failed } = checklist();
console.log(`GATE B8-0 — portfolio nearest-liquidation circuit — ${new Date().toISOString()}\n`);

const { build, portfolioGate } = await makeBuilder(import.meta.url);

// ---- 1. a worked book -----------------------------------------------------------------------------
// Ordered so the nearest leg is leg 1 and the runner-up is leg 2, which makes "names leg 2 when leg 1
// is nearer" the literal test rather than an approximation of it.
const BOOK = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
];

const built = build(BOOK);
if (!built.ok) { console.error(`the worked book did not encode: ${built.why}`); process.exit(1); }
const engine = built.result;

record('the engine names a leg as nearest', engine.nearestLiquidation != null,
  `${engine.nearestLiquidation.asset} ${engine.nearestLiquidation.side} at ${engine.nearestLiquidation.moveToLiquidationPct}%`);
record('the witness names the leg the engine named', built.nearest === 1,
  `leg ${built.nearest} of ${BOOK.length}`);

// ---- 2. PRINT THE ENCODER'S OUTPUT, before trusting any of it -------------------------------------
// One command, over a list of inputs. It has caught two defects in this project already: a bound
// written nine orders of magnitude too wide, and an encoder forming a scaled product as a double.
console.log('\nEncoder output, leg by leg — read these before believing anything downstream:');
console.log(`  ${'leg'.padStart(3)} ${'side'.padEnd(6)}${'mHat'.padStart(20)}${'qHat'.padStart(16)}${'p0Hat'.padStart(16)}${'pLiqHat'.padStart(16)}${'refHat'.padStart(16)}${'mmrHat'.padStart(10)}`);
for (const l of built.realLegs) {
  console.log(`  ${String(l.index).padStart(3)} ${(l.s === 1 ? 'long' : 'short').padEnd(6)}${String(l.mHat).padStart(20)}${String(l.qHat).padStart(16)}${String(l.p0Hat).padStart(16)}${String(l.pLiqHat).padStart(16)}${String(l.refHat).padStart(16)}${String(l.mmrHat).padStart(10)}`);
}
console.log(`\n  ${'leg'.padStart(3)} ${'served P_liq'.padStart(14)}${'certified'.padStart(16)}${'gap'.padStart(12)}${'served %'.padStart(11)}${'exact %'.padStart(12)}`);
for (const l of built.realLegs) {
  console.log(`  ${String(l.index).padStart(3)} ${String(l.servedPrice).padStart(14)}${l.certifiedPrice.toFixed(9).padStart(16)}${l.gapToServedPrice.toExponential(2).padStart(12)}${String(l.servedPct).padStart(11)}${distPct(l).toFixed(6).padStart(12)}`);
}
console.log(`\n  ${'leg'.padStart(3)} ${'residual R'.padStart(28)}${'tolerance'.padStart(24)}${'2|R|/tol'.padStart(12)}`);
let worstRatio = 0;
for (const l of built.realLegs) {
  const absR2 = (l.residual < 0n ? -l.residual : l.residual) * 2n;
  const ratio = Number(absR2) / Number(l.tolerance);
  worstRatio = Math.max(worstRatio, ratio);
  console.log(`  ${String(l.index).padStart(3)} ${String(l.residual).padStart(28)}${String(l.tolerance).padStart(24)}${ratio.toFixed(6).padStart(12)}`);
}

// The exact residual, spelled out, so the number in the write-up is a number somebody read.
const lead = built.realLegs[built.nearest];
record('the named leg satisfies the liquidation identity inside its own derived bound',
  2n * (lead.residual < 0n ? -lead.residual : lead.residual) <= lead.tolerance,
  `R = ${lead.residual} · tol = ${lead.tolerance} · 2|R|/tol = ${(Number(2n * (lead.residual < 0n ? -lead.residual : lead.residual)) / Number(lead.tolerance)).toFixed(9)}`);
record('every leg satisfies its own identity, not only the winner',
  built.realLegs.every((l) => 2n * (l.residual < 0n ? -l.residual : l.residual) <= l.tolerance),
  `worst of ${built.realLegs.length} legs uses ${worstRatio.toFixed(6)} of its bound`);

// ---- 3. prove / verify / refuse a moved signal ----------------------------------------------------
const proved = await proveVerifyRefuse(CIRCUIT, built.witness, { record });

// The public signals carry the residuals first; check the circuit computed what scale.cjs computes,
// or the printed table above is describing a different circuit than the one that proved.
const pub = proved.publicSignals.map((x) => asInt(x));
const residualsAgree = built.legs.every((l, i) => pub[i] === l.residual);
record('the circuit\'s published residuals are the ones scale.cjs derives', residualsAgree,
  residualsAgree ? `${built.legs.length} legs agree exactly` : `circuit ${pub.slice(0, 3)} vs encoder ${built.legs.map((l) => l.residual)}`);
record('the last public signal is the leg index that was named',
  pub[pub.length - 1] === BigInt(built.nearest), `nearest = ${pub[pub.length - 1]}`);

// ---- 4. dishonest witnesses, refused BEFORE a proof exists ----------------------------------------
const wasm = path.join(BUILD, `${CIRCUIT}_js`, `${CIRCUIT}.wasm`);
const calc = await require(path.join(BUILD, `${CIRCUIT}_js`, 'witness_calculator.cjs'))(readFileSync(wasm));

console.log('\nDishonest witnesses — each must die in the constraint system, not at the verifier:');
const clone = () => JSON.parse(JSON.stringify(built.witness));
async function refuses(label, w) {
  let threw = false, why = '';
  try { await calc.calculateWTNSBin(w, 0); } catch (e) { threw = true; why = String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 88); }
  record(`REFUSED: ${label}`, threw, threw ? why : '*** THE CONSTRAINT SYSTEM ACCEPTED IT ***');
  return threw;
}

// THE ONE THE BRIEF NAMES. Every signal honest; only the claim about which leg is nearest is a lie.
const nameRunnerUp = clone();
nameRunnerUp.nearest = '2';
nameRunnerUp.sel = ['0', '0', '1'];
await refuses('names leg 2 as nearest while leg 1 is nearer (2.42 points apart)', nameRunnerUp);

const nameThird = clone();
nameThird.nearest = '0';
nameThird.sel = ['1', '0', '0'];
await refuses('names leg 0, the furthest leg, as nearest', nameThird);

// The same lie with the two legs almost tied, which is where a comparison written in floating point
// or at the wrong scale stops being able to tell them apart. ETH is set a hair BELOW BTC's leverage,
// so BTC is genuinely the nearest and naming ETH is genuinely a lie — the two legs still serve at the
// same rounded 9.548%, so nothing above the third decimal can tell them apart.
const TIE_BOOK = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 9.99999, maintMarginRate: 0.005, markPrice: 3200 },
];
const tie = build(TIE_BOOK);
if (!tie.ok) { console.error(`the near-tie book did not encode: ${tie.why}`); process.exit(1); }
const gap = Math.abs(distPct(tie.legs[1]) - distPct(tie.legs[2]));
console.log(`\n  near-tie book: leg 1 at ${distPct(tie.legs[1]).toFixed(9)}%, leg 2 at ${distPct(tie.legs[2]).toFixed(9)}% — ${gap.toExponential(2)} points apart`);
console.log(`                 both SERVED as ${tie.realLegs[1].servedPct}% and ${tie.realLegs[2].servedPct}% — indistinguishable at the published precision`);
record('the near-tie book really is a near tie, so the next refusal is discriminating',
  gap > 0 && gap < 1e-3 && tie.realLegs[1].servedPct === tie.realLegs[2].servedPct,
  `${gap.toExponential(2)} points apart, served identically, and the engine names leg ${tie.nearest}`);
const tieLie = JSON.parse(JSON.stringify(tie.witness));
const other = tie.nearest === 1 ? 2 : 1;
tieLie.nearest = String(other);
tieLie.sel = ['0', '0', '0'];
tieLie.sel[other] = '1';
await refuses(`names leg ${other} when leg ${tie.nearest} is nearer by ${gap.toExponential(2)} points`, tieLie);

// ---- 4b. the trap this circuit's own shape carries ------------------------------------------------
// The engine ranks on round(pct, 3) and breaks ties by BOOK ORDER; the circuit ranks on the exact
// ratio. On a book where those two orderings part company the engine's own answer is not a minimum,
// and the honest move is to decline the book rather than certify a ranking that is false underneath.
// This was found by construction, not by reasoning: the first near-tie book written here happened to
// have ETH marginally NEARER than BTC while both served as 9.548%, the engine named BTC, and the
// circuit refused it. That refusal was correct and the test was wrong.
const SPLIT_BOOK = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 10.0000109, maintMarginRate: 0.005, markPrice: 3200 },
];
const split = build(SPLIT_BOOK);
record('a book whose rounded ranking and exact ranking disagree is DECLINED, not certified',
  split.ok === false && split.orderingSplit === true,
  split.ok === false
    ? `${split.why} — refused before a witness exists`
    : '*** A BOOK WAS ENCODED WHOSE NAMED LEG IS NOT THE MINIMUM ***');

// Structure of the claim itself.
const twoHot = clone(); twoHot.sel = ['0', '1', '1'];
await refuses('a selector that names two legs at once', twoHot);
const noneHot = clone(); noneHot.sel = ['0', '0', '0'];
await refuses('a selector that names no leg', noneHot);
const mismatched = clone(); mismatched.nearest = '2';
await refuses('a stated index that disagrees with the selector', mismatched);
const fractional = clone(); fractional.sel = ['0', '2', '-1'];
await refuses('a selector outside {0,1} that still sums to one', fractional);

// The leg identity, which the minimum sits on top of.
const movedPrice = clone(); movedPrice.pLiqHat[1] = (BigInt(movedPrice.pLiqHat[1]) + 1000000n).toString();
await refuses('a liquidation price moved by 0.001 on the named leg', movedPrice);
const movedLoser = clone(); movedLoser.pLiqHat[0] = (BigInt(movedLoser.pLiqHat[0]) + 1000000n).toString();
await refuses('a liquidation price moved on a leg that LOST the comparison', movedLoser);
const zeroSize = clone(); zeroSize.qHat[1] = '0';
await refuses('a zero-size leg, where the identity degenerates', zeroSize);
const noSide = clone(); noSide.s[1] = '0';
await refuses('a side that is neither long nor short', noSide);
const bigMmr = clone(); bigMmr.mmrHat[1] = '1000000000';
await refuses('a maintenance rate of exactly 1', bigMmr);
const zeroRef = clone(); zeroRef.refHat[1] = '0';
await refuses('a zero mark, which would make the distance 0/0', zeroRef);

// A leg already past its liquidation price. The engine drops these from the ranking; here the mark is
// pushed below the named long leg's liquidation price, which makes d negative.
const breached = clone();
breached.refHat[1] = (BigInt(built.legs[1].pLiqHat) - 1000000000n).toString();
await refuses('a mark already below the leg\'s liquidation price', breached);

// And the negative control: the honest witness must still pass through the same calculator, or every
// refusal above is just a broken harness refusing everything.
let honestOk = false;
try { await calc.calculateWTNSBin(built.witness, 0); honestOk = true; } catch { honestOk = false; }
record('the honest witness still passes the same calculator', honestOk,
  honestOk ? 'so the refusals above are refusals, not a broken harness' : 'THE HARNESS REFUSES EVERYTHING');

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE B8-0: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);

writeFileSync(path.join(BUILD, 'gateB8-0-portfolio.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, circuit: CIRCUIT,
  legs: BOOK.length, nearest: built.nearest, proveMs: proved.proveMs,
  publicSignals: proved.publicSignals.length,
  worked: built.realLegs.map((l) => ({
    leg: l.index, side: l.s === 1 ? 'long' : 'short', servedPrice: l.servedPrice,
    certifiedPrice: l.certifiedPrice, gapToServedPrice: l.gapToServedPrice,
    servedPct: l.servedPct, exactPct: distPct(l),
    residual: String(l.residual), tolerance: String(l.tolerance),
    boundUsed: Number(2n * (l.residual < 0n ? -l.residual : l.residual)) / Number(l.tolerance),
  })),
  nearTieGapPoints: gap,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
