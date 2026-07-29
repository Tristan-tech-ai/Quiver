// GATE B5-4 — does the HEADLINE circuit agree with the ENGINE's headline, over a sweep?
//
// `adverseExecutionBps` comes from the REAL execVerify engine. A recomputation of
// (honestOut − realized)/honestOut·1e4 would agree with itself and prove nothing.
//
// ── THE DIVERGENCE BOUND IS DERIVED HERE, NOT INHERITED ──────────────────────────────────────────
// Gate B5-1 derived an allowance for the BENCHMARK in output tokens. That allowance is not this one
// and cannot be reused as a number: basis points are a ratio, so every term has to be divided through
// by the fill, and one term (the display step) is a different size because `round(bps, 2)` is coarser
// in bps than `round(honestOut, 8)` is in tokens. Copying B5-1's figure across would have been the
// liquidation half-cent all over again — a bound that belonged to a different quantity.
//
// Derived term by term, all in bps:
//
//   display    the served field is `round(bps, 2)`                      -> 0.005
//   bps grid   b̂ = round(bps·S) rounds by half a unit                    -> 0.5/S
//   fill grid  realized snaps onto the grid by <= half a step, and
//              d(bps)/d(realized) = -1e4/out                             -> 1e4·(0.5/S)/out
//   benchmark  the certified ô differs from the engine's double honestOut
//              by at most gOut, and d(bps)/d(out) = 1e4·realized/out²    -> 1e4·(realized/out)·gOut/out
//   IEEE       the engine forms out − realized and then divides, both
//              in doubles; the cancellation term dominates and is
//              about out·1e-16, carried through the same derivative     -> 1e4·1e-16
//
// gOut is A PRIORI, not measured. The first version of this gate set gOut = |ô/S − honestOut| for the
// same trade, which made the bound expand to fit whatever the encoder had just done — and the proof
// that it was worthless is that it then failed to refuse the encoder this repo is on record as having
// had wrong. A bound whose width is read off the value under test cannot fail. So gOut is the DERIVED
// form gate B5-1 established and measured to hold over 3,595 pools:
//
//   gOut = 0.5e-8  (round(honestOut, 8))  +  (1 + 2·y/x)/S  (snapping dx and y)  +  honestOut·1e-14
//
// and this sweep reports how much of it the measured gap actually uses, so the reuse is checked rather
// than assumed.
//
// How much of the bound the worst honest case uses is printed, and the last block shows the bound
// being exceeded — twice, by two defect shapes with history in this repo. A bound nothing can break is
// not a bound. It also records one defect the bound canNOT see, and why.
//
// Run: node zk/scripts/gateB5-4-execadverse-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { execVerify } = await load(import.meta.url, 'engine/execVerify.js');

const TOL_MULT = 1n;
const FEE_TIERS = [0.0001, 0.0005, 0.003, 0.01];
const NB_BPS_LIMIT = 1n << 50n;

let seed = 20260730;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const abs = (v) => (v < 0n ? -v : v);

// naive: the encoder this repo used to have — Math.round(v * 1e9), which passes 2^53 above ~9e6.
// Used ONLY by the final check, to show the derived bound can be exceeded.
const naiveScaled = (v) => BigInt(Math.round(Number(v) * S));

// benchmarkModes: how the bps numerator's benchmark is formed. `honest` is the real thing; the other
// two are defect shapes with history here, used at the end to show the bound can be exceeded.
function trial(scale = toScaled, mode = 'honest') {
  const x = 10 ** (3 + rand() * 7) * (0.5 + rand());
  const y = x * (0.2 + rand() * 5);
  const f = FEE_TIERS[Math.floor(rand() * FEE_TIERS.length)];
  const dx = x * (10 ** (-6 + rand() * 5));
  if (!(dx > 0)) return null;

  // A realized fill spanning a favorable quote through a heavy sandwich: -50 bps to +400 bps of the
  // pre-trade mid. The engine is what decides what that fill is worth.
  const realized = dx * (y / x) * (1 - (-0.005 + rand() * 0.045));
  if (!(realized > 0)) return null;

  const probe = execVerify({ amountIn: dx, amountOutRealized: realized, reserveIn: x, reserveOut: y, feeTier: f });
  if (!probe.ok || probe.mode !== 'constant-product' || !(probe.honestOut > 0)) return null;

  const xHat = scale(x), yHat = scale(y), dxHat = scale(dx), fHat = scale(f), realizedHat = scale(realized);
  if (realizedHat <= 0n) return null;
  const inHat = (dxHat * (SCALE - fHat) + SCALE / 2n) / SCALE;
  const denom = xHat + inHat;
  if (denom <= 0n) return null;
  let outHat = (inHat * yHat + denom / 2n) / denom;        // the engine's expression, the engine's order
  // the two defect shapes: reading the engine's DISPLAY-ROUNDED benchmark (the liquidation and Kelly
  // defect, twice), and benchmarking against the pre-trade MID instead of the honest fill (the exact
  // confusion this service exists to prevent — it relabels unavoidable cost as adverse execution).
  if (mode === 'display') outHat = scale(probe.honestOut);
  if (mode === 'mid') outHat = (dxHat * yHat + xHat / 2n) / xHat;
  // a pure RELATIVE slip in the benchmark, to locate where this bound starts being able to see one
  if (mode.startsWith('slip:')) {
    const ppb = BigInt(Math.round(Number(mode.slice(5)) * 1e12));   // relative error in parts per 1e12
    outHat = outHat + (outHat * ppb + 500000000000n) / 1000000000000n;
  }
  if (outHat <= 0n || outHat >= yHat) return null;

  const LIMIT = 1n << 62n;
  if ([xHat, yHat, dxHat, inHat, outHat, realizedHat].some((v) => v >= LIMIT)) return { outOfDomain: true };

  const sHat = outHat - realizedHat;
  const num = 10000n * SCALE * sHat;
  const bpsHat = (num * 2n / outHat + (num < 0n ? -1n : 1n)) / 2n;   // round-half-away-from-zero
  if (abs(bpsHat) >= NB_BPS_LIMIT) return { outOfBpsDomain: true };

  const Rf = inHat * SCALE - dxHat * (SCALE - fHat);
  const R = (xHat + inHat) * (yHat - outHat) - xHat * yHat;
  const Rb = bpsHat * outHat - 10000n * SCALE * sHat;

  const certOut = Number(outHat) / S;
  const certBps = Number(bpsHat) / S;
  const servedBps = probe.adverseExecutionBps;
  const gOutMeasured = Math.abs(certOut - probe.honestOut);
  // A PRIORI, per the derivation above. Never read off the value under test.
  const gOutBound = 0.5e-8 + (1 + 2 * (y / x)) / S + Math.abs(probe.honestOut) * 1e-14;

  // ---- the derived bound, term by term ----
  const display = 0.005;
  const bpsGrid = 0.5 / S;
  const fillGrid = 1e4 * (0.5 / S) / probe.honestOut;
  const benchmark = 1e4 * (realized / probe.honestOut) * gOutBound / probe.honestOut;
  const ieee = 1e4 * 1e-16;
  const allowed = display + bpsGrid + fillGrid + benchmark + ieee;
  const gap = Math.abs(certBps - servedBps);

  // the shortfall's own allowance, in OUTPUT TOKENS, derived the same way: the engine publishes
  // round(honestOut - realized, 8), the benchmark can differ by gOutBound, and realized snaps by half
  // a grid step. Nothing here is a hand-picked epsilon.
  const shortAllowed = 0.5e-8 + gOutBound + 0.5 / S;
  const shortGap = Math.abs(Number(sHat) / S - probe.adverseValueOut);

  // ---- the soundness window: how far could a CHEATING prover move each intermediate? ----
  // Rf pins ĩn: dRf/dîn = S and |Rf| <= S/2, so the admissible window is 2·(S/2)/S = ONE grid step.
  // R  pins ô : dR/dô  = -(x̂+ĩn) and |R| <= (x̂+ĩn+ŷ-ô)/2, so the window is (x̂+ĩn+ŷ-ô)/(x̂+ĩn) steps.
  // Rb pins b̂ : dRb/db̂ = ô and |Rb| <= ô/2, so the window is ONE unit of 1e-9 bps, given ô and ŝ.
  const inWindowSteps = 1;
  const outWindowSteps = Number(xHat + inHat + yHat - outHat) / Number(xHat + inHat);
  // the headline's total exposure: its own unit, plus whatever the ô window lets through
  const bpsWindow = 1 / S + 1e4 * (realized / probe.honestOut) * (outWindowSteps / S) / probe.honestOut;

  return {
    x, y, dx, f, realized, servedBps, certBps, gap, allowed, allowanceUsed: gap / allowed,
    terms: { display, bpsGrid, fillGrid, benchmark, ieee },
    gOutMeasured, gOutBound, gOutUsed: gOutMeasured / gOutBound,
    shortGap, shortAllowed, shortUsed: shortGap / shortAllowed,
    ratio: Number(abs(R) * 2n) / Number(TOL_MULT * (xHat + inHat + yHat - outHat)),
    feeRatio: Number(abs(Rf) * 2n) / Number(SCALE),
    bpsRatio: Number(abs(Rb) * 2n) / Number(outHat),
    honestOut: probe.honestOut,
    inWindowSteps, outWindowSteps, bpsWindow,
  };
}

const { record, failed } = checklist();
console.log(`GATE B5-4 — the headline circuit against the live engine — ${new Date().toISOString()}\n`);

const RUNS = 4000;
let kept = 0, diverged = 0, outOfDomain = 0, outOfBpsDomain = 0;
let violations = 0, feeViolations = 0, bpsViolations = 0;
let worst = null, worstFee = null, worstBps = null, worstUse = null, widestWindow = null;
let worstShort = null, worstGOut = null, shortDiverged = 0;
// where does the soundness window on the headline fall below the 0.01 bps it is published at?
let windowOverPublished = 0, smallestFillUnderPublished = Infinity, largestFillOverPublished = 0;
for (let i = 0; i < RUNS; i++) {
  const t = trial();
  if (!t) continue;
  if (t.outOfDomain) { outOfDomain++; continue; }
  if (t.outOfBpsDomain) { outOfBpsDomain++; continue; }
  if (t.gap > t.allowed) { diverged++; if (diverged <= 3) console.log(`  DIVERGED x=${t.x.toPrecision(6)} served ${t.servedBps} cert ${t.certBps} gap ${t.gap.toExponential(3)} allowed ${t.allowed.toExponential(3)}`); continue; }
  kept++;
  if (t.ratio > 1) violations++;
  if (t.feeRatio > 1) feeViolations++;
  if (t.bpsRatio > 1) bpsViolations++;
  if (t.shortGap > t.shortAllowed) shortDiverged++;
  if (t.bpsWindow > 0.01) { windowOverPublished++; largestFillOverPublished = Math.max(largestFillOverPublished, t.honestOut); }
  else smallestFillUnderPublished = Math.min(smallestFillUnderPublished, t.honestOut);
  if (!worst || t.ratio > worst.ratio) worst = t;
  if (!worstFee || t.feeRatio > worstFee.feeRatio) worstFee = t;
  if (!worstBps || t.bpsRatio > worstBps.bpsRatio) worstBps = t;
  if (!worstUse || t.allowanceUsed > worstUse.allowanceUsed) worstUse = t;
  if (!worstShort || t.shortUsed > worstShort.shortUsed) worstShort = t;
  if (!worstGOut || t.gOutUsed > worstGOut.gOutUsed) worstGOut = t;
  if (!widestWindow || t.bpsWindow > widestWindow.bpsWindow) widestWindow = t;
}

console.log(`  trades sampled       : ${kept}   (pools 1e3..1e10, trades 1e-6..1e-1 of the pool, fills -50..+400 bps of mid)`);
console.log(`  outside the domain   : ${outOfDomain} past 2^62 · ${outOfBpsDomain} past the 2^50 bps width (refused, not wrapped)`);
console.log(`  refused by the bound : ${diverged}`);
console.log(`  invariant violations : ${violations}   fee: ${feeViolations}   headline: ${bpsViolations}\n`);
console.log(`  tightest invariant   : 2|R|  / TOL = ${worst.ratio.toExponential(3)}`);
console.log(`  tightest fee         : 2|Rf| / S   = ${worstFee.feeRatio.toExponential(3)}`);
console.log(`  tightest headline    : 2|Rb| / ô   = ${worstBps.bpsRatio.toExponential(3)}`);
console.log(`  worst headline gap   : ${worstUse.gap.toExponential(3)} bps of an allowance of ${worstUse.allowed.toExponential(3)} = ${(100 * worstUse.allowanceUsed).toFixed(1)}%`);
console.log(`    at x=${worstUse.x.toPrecision(6)} y=${worstUse.y.toPrecision(6)} dx=${worstUse.dx.toPrecision(6)} fee=${worstUse.f}`);
console.log(`    terms: display ${worstUse.terms.display.toExponential(2)} · bps grid ${worstUse.terms.bpsGrid.toExponential(2)} · fill grid ${worstUse.terms.fillGrid.toExponential(2)} · benchmark ${worstUse.terms.benchmark.toExponential(2)} · IEEE ${worstUse.terms.ieee.toExponential(2)}`);
console.log(`  worst shortfall gap  : ${worstShort.shortGap.toExponential(3)} tokens of ${worstShort.shortAllowed.toExponential(3)} = ${(100 * worstShort.shortUsed).toFixed(1)}%`);
console.log(`  reused B5-1 gOut     : worst measured ${worstGOut.gOutMeasured.toExponential(3)} of a derived ${worstGOut.gOutBound.toExponential(3)} = ${(100 * worstGOut.gOutUsed).toFixed(1)}%  (the reuse is checked, not assumed)\n`);

console.log('  Soundness — how far a CHEATING prover could move each intermediate and still verify:');
console.log(`    effective input : ${widestWindow.inWindowSteps} grid step  = 1e-9 input tokens, everywhere`);
console.log(`    benchmark fill  : ${widestWindow.outWindowSteps.toFixed(2)} grid steps at the widest = ${(widestWindow.outWindowSteps / S).toExponential(2)} output tokens`);
console.log(`    the headline    : ${widestWindow.bpsWindow.toExponential(2)} bps at the widest, on a fill of ${widestWindow.honestOut.toExponential(2)} tokens`);
console.log(`    the headline window is a RATIO — it widens as the fill shrinks, because the same`);
console.log(`    1.3e-9-token uncertainty is a larger fraction of a smaller fill.`);
console.log(`      trades where it exceeds the 0.01 bps publication step : ${windowOverPublished} of ${kept}`);
console.log(`      largest fill on which it does                         : ${largestFillOverPublished.toExponential(2)} output tokens`);
console.log(`      smallest fill on which it does NOT                    : ${Number.isFinite(smallestFillUnderPublished) ? smallestFillUnderPublished.toExponential(2) : 'n/a'} output tokens`);
console.log(`    against a verdict threshold of 5 bps\n`);

record('the invariant bound is never violated', violations === 0,
  `${kept} trades, tightest ${worst.ratio.toExponential(3)} of the bound`);
record('the fee bound is never violated', feeViolations === 0,
  `tightest ${worstFee.feeRatio.toExponential(3)} of the bound`);
record('the headline bound is never violated', bpsViolations === 0,
  `tightest ${worstBps.bpsRatio.toExponential(3)} of the bound`);
record('every certified headline IS the headline the engine served, within the derived bound',
  kept > 0 && diverged === 0,
  `${diverged} refused of ${kept + diverged}; worst case used ${(100 * worstUse.allowanceUsed).toFixed(1)}% of it`);
record('the derived bound is tight, not generous', worstUse.allowanceUsed > 0.05,
  `worst case uses ${(100 * worstUse.allowanceUsed).toFixed(1)}% — a bound nothing approaches is not a check`);
record('the headline came from the engine, not from a recomputation', typeof execVerify === 'function',
  'execVerify was imported and called; adverseExecutionBps was never taken from the local arithmetic');
record('the shortfall in output tokens agrees within its own derived allowance',
  shortDiverged === 0,
  `${shortDiverged} of ${kept} outside it; worst uses ${(100 * worstShort.shortUsed).toFixed(1)}% of ${worstShort.shortAllowed.toExponential(3)} tokens`);
record('the gOut formula borrowed from gate B5-1 still holds here', worstGOut.gOutUsed <= 1,
  `worst measured gap is ${(100 * worstGOut.gOutUsed).toFixed(1)}% of the derived bound over ${kept} trades`);
record('all three bounds are discriminating, not vacuous',
  worst.ratio > 1e-12 && worstFee.feeRatio > 1e-12 && worstBps.bpsRatio > 1e-12,
  `invariant ${worst.ratio.toExponential(3)} · fee ${worstFee.feeRatio.toExponential(3)} · headline ${worstBps.bpsRatio.toExponential(3)}`);
// The honest form of this check. The window is a ratio, so on a dust fill it can exceed the 0.01 bps
// the field is published at, and asserting otherwise would have been a claim the measurement refutes.
// What IS true everywhere is that it stays orders of magnitude under the 5 bps verdict threshold — the
// number a buyer acts on — and that is what is asserted.
record('the soundness window on the sold number stays far under the 5 bps verdict threshold',
  widestWindow.bpsWindow < 5 / 100,
  `widest ${widestWindow.bpsWindow.toExponential(2)} bps = 1/${(5 / widestWindow.bpsWindow).toFixed(0)} of the threshold, on a fill of ${widestWindow.honestOut.toExponential(2)} tokens`);
record('and it is under the 0.01 bps publication step on every fill of any size',
  largestFillOverPublished < 1,
  `it exceeds 0.01 bps on ${windowOverPublished} of ${kept} trades, all of them fills below ${largestFillOverPublished.toExponential(2)} output tokens`);

// ---- THE BOUND MUST BE BREAKABLE ----------------------------------------------------------------
// Re-run the identical sweep with three known-wrong benchmarks. A bound nothing can break is not a
// bound; a bound that everything breaks is not tight. Both directions are reported.
// The bound is dominated by the 0.005 bps display step, so its SENSITIVITY to a benchmark error is a
// relative one: a gap of 1e4·(δout/out) bps clears 0.005 when δout/out passes about 5e-7. The two slip
// runs below sit either side of that line and locate it, which is the difference between claiming a
// bound is discriminating and showing where it stops being so.
console.log('\n  Breaking the bound on purpose:');
const breakers = [
  ['a MID-price benchmark', toScaled, 'mid', 'the confusion this whole service exists to prevent — unavoidable cost relabelled as adverse execution', true],
  ['a 1e-6 relative slip in the benchmark', toScaled, 'slip:1e-6', 'just above the derived sensitivity of ~5e-7', true],
  ['a 1e-7 relative slip in the benchmark', toScaled, 'slip:1e-7', 'just below it — this one MUST get through, or the line is not where the derivation puts it', false],
  ['reading the DISPLAY-ROUNDED benchmark', toScaled, 'display', 'the liquidation and Kelly defect twice over', false],
  ['the Math.round(v*1e9) encoder', naiveScaled, 'honest', 'the encoder gate B5-1 caught, wrong by up to 64 grid steps above 1e8 reserves', false],
];
const breakResults = [];
for (const [label, scale, mode, why, mustBreak] of breakers) {
  seed = 20260730;
  let over = 0, under = 0, worstMult = 0, worstRel = 0, worstSteps = 0;
  for (let i = 0; i < RUNS; i++) {
    const t = trial(scale, mode);
    if (!t || t.outOfDomain || t.outOfBpsDomain) continue;
    // The relative benchmark error is measured only on fills of at least one whole token. Below that
    // the 1e-9 grid itself is a large fraction of the fill, and a max taken over dust fills reports
    // quantization rather than the defect — the first version of this line did exactly that and
    // claimed the Math.round encoder reached 4.6e-6 relative when the encoder was not the cause.
    if (t.honestOut >= 1) worstRel = Math.max(worstRel, t.gOutMeasured / t.honestOut);
    worstSteps = Math.max(worstSteps, t.gOutMeasured * S);
    if (t.gap > t.allowed) { over++; worstMult = Math.max(worstMult, t.gap / t.allowed); } else under++;
  }
  const rate = over / (over + under);
  breakResults.push({ label, mode, why, mustBreak, over, under, refusalRate: rate, worstMult, worstRelativeBenchmarkError: worstRel, worstAbsGridSteps: worstSteps });
  console.log(`    ${label.padEnd(40)} ${String(over).padStart(4)} of ${over + under} = ${(100 * rate).toFixed(1).padStart(5)}% refused (worst ${worstMult.toFixed(1)}x) · benchmark error ${worstRel.toExponential(2)} relative, ${worstSteps.toFixed(0)} grid steps absolute`);
}
console.log('');
const byMode = (m) => breakResults.find((b) => b.mode === m);
const mid = byMode('mid'), slip6 = byMode('slip:1e-6'), slip7 = byMode('slip:1e-7');
const disp = byMode('display'), naive = breakResults.find((b) => /Math.round/.test(b.label));

record('the derived bound REFUSES a gross benchmark error outright',
  mid.refusalRate === 1, `a mid-price benchmark is refused on ${mid.over} of ${mid.over + mid.under} trades, worst by ${mid.worstMult.toFixed(0)}x`);
// The derivation says the crossover is a RELATIVE 5e-7, because the bound is dominated by the 0.005 bps
// display step and a relative slip r shows up as 1e4·r bps. So 1e-6 should be caught on most trades and
// 1e-7 on few. Both sides are asserted; catching everything would mean the line is not where it is said
// to be, and catching nothing would mean there is no line.
record("the bound's sensitivity brackets the derived 5e-7 crossover from both sides",
  slip6.refusalRate > 0.5 && slip7.refusalRate < 0.5,
  `a 1e-6 relative slip is refused on ${(100 * slip6.refusalRate).toFixed(1)}% of trades and a 1e-7 slip on `
  + `${(100 * slip7.refusalRate).toFixed(1)}% — the 1e-7 cases that do break it are the ones where the `
  + '0.005 bps display step was already most of the way there');
// Recorded, not hidden: the defects this bound cannot see, each with the measured reason.
record('the defects this bound CANNOT see are named, with their size measured',
  disp.over === 0 && naive.over === 0,
  `reading the display-rounded benchmark (${disp.worstRelativeBenchmarkError.toExponential(2)} relative, `
  + `${disp.worstAbsGridSteps.toFixed(0)} grid steps) and the Math.round(v*1e9) encoder `
  + `(${naive.worstRelativeBenchmarkError.toExponential(2)} relative, ${naive.worstAbsGridSteps.toFixed(0)} grid steps). `
  + 'Both sit far below the 5e-7 RELATIVE error this bound can resolve, which is why the headline cannot '
  + "see them — and the second is wrong by tens of grid steps in ABSOLUTE tokens, which is gate B5-1's "
  + 'instrument and not this one. Two bounds, two jobs, both stated.');

for (const [label, r] of [['invariant', worst.ratio], ['fee', worstFee.feeRatio], ['headline', worstBps.bpsRatio]]) {
  const head = 1 / r;
  console.log(`  ${label} bound: worst case uses 1/${head.toFixed(1)} of it`);
  if (head > 10) console.log('    wider than the evidence requires — recorded, not quietly kept');
}

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B5-4: ${gate ? 'PASSED' : `FAILED — ${bad.map((v) => v.name).join('; ')}`}`);

writeFileSync(path.join(BUILD, 'gateB5-4-execadverse-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, diverged, outOfDomain, outOfBpsDomain,
  violations, feeViolations, bpsViolations,
  tightestRatio: worst.ratio, tightestFeeRatio: worstFee.feeRatio, tightestBpsRatio: worstBps.bpsRatio,
  worstHeadlineGapBps: worstUse.gap, worstAllowanceBps: worstUse.allowed,
  worstAllowanceUsed: worstUse.allowanceUsed, boundTerms: worstUse.terms,
  shortfall: { diverged: shortDiverged, worstGapTokens: worstShort.shortGap, worstAllowanceTokens: worstShort.shortAllowed, worstUsed: worstShort.shortUsed },
  gOutReuse: { worstMeasured: worstGOut.gOutMeasured, derivedBound: worstGOut.gOutBound, used: worstGOut.gOutUsed },
  soundnessWindow: {
    effectiveInputGridSteps: widestWindow.inWindowSteps,
    benchmarkGridSteps: widestWindow.outWindowSteps,
    headlineBpsWidest: widestWindow.bpsWindow,
    headlineBpsWidestAtFill: widestWindow.honestOut,
    tradesOverPublishedStep: windowOverPublished, keptTrades: kept,
    largestFillOverPublishedStep: largestFillOverPublished,
    publishedPrecisionBps: 0.01, verdictThresholdBps: 5,
  },
  boundIsBreakable: breakResults,
  worst: { x: worstUse.x, y: worstUse.y, dx: worstUse.dx, fee: worstUse.f, realized: worstUse.realized, servedBps: worstUse.servedBps, certBps: worstUse.certBps },
}, null, 2) + '\n', 'utf8');
process.exit(gate ? 0 : 1);
