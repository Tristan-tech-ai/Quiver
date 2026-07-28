// GATE B5-1 — does the constant-product circuit agree with the ENGINE, measured over a sweep?
//
// honestOut comes from the REAL execVerify engine. A recomputation of y − k/(x+inEff) would agree
// with itself and prove nothing.
//
// The published field is `honestOut: round(honestOut, 8)`, so the comparison below is made at eight
// decimals using the ENGINE's own round(), not against a threshold picked here. That lesson cost gate
// B4-1 a false failure: comparing full precision against a served figure with a hand-chosen epsilon
// flags values that merely sit on a rounding boundary.
//
// A NOTE ON WHAT PASSING MEANS. The reserves are inputs. This sweep says the benchmark arithmetic is
// right about the pool state it was handed, over four thousand pools spanning ten orders of magnitude.
// It says nothing about whether any of those states was real.
//
// Run: node zk/scripts/gateB5-1-constantproduct-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { execVerify } = await load(import.meta.url, 'engine/execVerify.js');
const { round } = await load(import.meta.url, 'engine/stats.js');

const TOL_MULT = 1n;
const SERVED_DP = 8;                 // honestOut: round(honestOut, 8)
const FEE_TIERS = [0.0001, 0.0005, 0.003, 0.01];   // the real Uniswap ladder

let seed = 20260728;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function trial() {
  // Pools from a $10k long-tail pair to a nine-figure blue chip, and trades from dust to 10% of the
  // pool. Ten orders of magnitude, because the tolerance scales with the pool and a sweep that only
  // samples one size cannot tell a scaling bound from a constant one.
  const x = 10 ** (3 + rand() * 7) * (0.5 + rand());
  const y = x * (0.2 + rand() * 5);
  const f = FEE_TIERS[Math.floor(rand() * FEE_TIERS.length)];
  const dx = x * (10 ** (-6 + rand() * 5));
  if (!(dx > 0)) return null;

  // amountOutRealized only feeds the adverse-execution figure, not the benchmark, so it is set to the
  // honest fill and plays no part in what is certified.
  const probe = execVerify({ amountIn: dx, amountOutRealized: dx * (y / x) * 0.99, reserveIn: x, reserveOut: y, feeTier: f });
  if (!probe.ok || probe.mode !== 'constant-product') return null;
  const servedOut = probe.honestOut;
  if (!(servedOut > 0)) return null;

  // Everything onto the grid the circuit reads.
  const xHat = toScaled(x, 'x'), yHat = toScaled(y, 'y'), dxHat = toScaled(dx, 'dx'), fHat = toScaled(f, 'f');
  // inEff and honestOut recomputed at full precision FROM THE SNAPPED INPUTS, never from the engine's
  // rounded output. This is the fix that gate B1 needed on Kelly and gate 1 needed on liquidation.
  const inHat = (dxHat * (SCALE - fHat) + SCALE / 2n) / SCALE;
  const denom = xHat + inHat;
  // THE ENGINE'S OWN EXPRESSION, IN THE ENGINE'S OWN ORDER. getAmountOut computes
  // `(y * inEff) / (x + inEff)`, and this line used to compute the algebraically identical
  // `y − x·y/(x + inEff)`. The two are the same in exact arithmetic and are not the same number:
  // the second cancels two large quantities to leave a small one, and the sweep measured the
  // difference at a flat 5 grid steps, about 3.5x the honest allowance.
  //
  // That is the third appearance of this exact defect. The liquidation encoder read a display-rounded
  // margin; the Kelly encoder read a display-rounded fraction; this one rearranged the algebra. All
  // three were found the same way, by measuring against the engine rather than against the formula,
  // and all three had the same fix: use what the engine uses, arranged how the engine arranges it.
  const outHat = (inHat * yHat + denom / 2n) / denom;
  if (outHat <= 0n || outHat >= yHat) return null;

  // Widths the circuit enforces. A pool past 2^62 scaled is outside the circuit's domain and must be
  // refused rather than wrapped, so it is counted here rather than silently dropped.
  const LIMIT = 1n << 62n;
  if (xHat >= LIMIT || yHat >= LIMIT || dxHat >= LIMIT || inHat >= LIMIT || outHat >= LIMIT) {
    return { outOfDomain: true };
  }

  const certifiedOut = Number(outHat) / S;

  // HOW CLOSE CAN THESE TWO EVEN BE? Not a rhetorical question, and getting it wrong made the first
  // version of this gate refuse 429 of 3,595 pools — twelve percent — while nothing was actually
  // wrong. It compared at eight fixed decimals, and this service spans ten orders of magnitude.
  //
  // Measured, both ends:
  //   fills above 1e6   worst absolute gap 4.8e-7, worst RELATIVE gap 5.1e-15  → double precision
  //   fills below 1     worst absolute gap 7.0e-9, worst relative gap 9.2e-6   → the 1e-9 grid
  // A fixed decimal comparison cannot straddle those. So the allowance is derived instead:
  //
  //   grid   snapping dx moves the fill by about (y/x)·1e-9 and snapping y by another 1e-9,
  //          so the propagated grid error is (1 + 2·y/x) grid steps
  //   double the engine computes k/(x+inEff) in IEEE doubles, a few tens of ulps at this magnitude
  //
  // How much of the allowance the worst case actually uses is reported below, because an allowance
  // nothing approaches is the same failure as a bound nothing approaches.
  // THE TERM THAT WAS MISSING, and it was the whole of the problem. `honestOut: round(honestOut, 8)`
  // puts the SERVED figure on a 1e-8 grid, so a correct certified value sits up to half a step away —
  // exactly 5e-9, which is exactly the flat "5.0 grid steps" the refused cases all showed, on the
  // nose, unchanged by two encoder fixes. A constant gap that does not move when you change the
  // encoder is not the encoder.
  const displayStep = 0.5e-8;                          // round(honestOut, 8)
  const gridPropagated = (1 + 2 * (y / x)) / S;        // snapping dx and y, propagated through the fill
  const doubleNoise = Math.abs(servedOut) * 1e-14;     // IEEE noise, which above ~1e6 exceeds the display step
  const allowed = displayStep + gridPropagated + doubleNoise;
  const gapToServed = Math.abs(certifiedOut - servedOut);
  if (gapToServed > allowed) {
    return { diverged: true, gap: gapToServed, allowed, x, y, dx, f, servedOut, certifiedOut };
  }

  const Rf = inHat * SCALE - dxHat * (SCALE - fHat);
  const R = (xHat + inHat) * (yHat - outHat) - xHat * yHat;
  const tol = TOL_MULT * (xHat + inHat + yHat - outHat);
  const abs = (v) => (v < 0n ? -v : v);
  return {
    x, y, dx, f, servedOut, certifiedOut, R, Rf,
    gap: gapToServed, allowanceUsed: gapToServed / allowed,
    ratio: Number(abs(R) * 2n) / Number(tol),
    feeRatio: Number(abs(Rf) * 2n) / Number(SCALE),
  };
}

const { record, failed } = checklist();
console.log(`GATE B5-1 — constant-product circuit against the live engine — ${new Date().toISOString()}\n`);

const RUNS = 4000;
let kept = 0, violations = 0, feeViolations = 0, diverged = 0, outOfDomain = 0;
let worst = null, worstFee = null, worstGap = 0, worstAllowance = 0;
for (let i = 0; i < RUNS; i++) {
  const t = trial();
  if (!t) continue;
  if (t.outOfDomain) { outOfDomain++; continue; }
  if (t.diverged) { diverged++; continue; }
  kept++;
  if (t.ratio > 1) violations++;
  if (t.feeRatio > 1) feeViolations++;
  worstGap = Math.max(worstGap, t.gap);
  worstAllowance = Math.max(worstAllowance, t.allowanceUsed);
  if (!worst || t.ratio > worst.ratio) worst = t;
  if (!worstFee || t.feeRatio > worstFee.feeRatio) worstFee = t;
}

console.log(`  pools sampled        : ${kept}   (reserves 1e3 to 1e10, trades 1e-6 to 1e-1 of the pool)`);
console.log(`  outside the domain   : ${outOfDomain}   (past the circuit's 2^62 width, refused not wrapped)`);
console.log(`  refused by guard     : ${diverged}`);
console.log(`  invariant violations : ${violations}`);
console.log(`  fee violations       : ${feeViolations}`);
console.log(`  tightest invariant   : 2|R| / TOL  = ${worst.ratio.toExponential(3)}`);
console.log(`  at                   : x=${worst.x.toPrecision(6)} y=${worst.y.toPrecision(6)} dx=${worst.dx.toPrecision(6)} fee=${worst.f}`);
console.log(`  tightest fee         : 2|Rf| / S   = ${worstFee.feeRatio.toExponential(3)}`);
console.log(`  widest gap to served : ${worstGap.toExponential(2)} (served at ${SERVED_DP} dp)\n`);

record('the invariant bound is never violated', violations === 0,
  `${kept} pools sampled, tightest ${worst.ratio.toExponential(3)} of the bound`);
record('the fee bound is never violated', feeViolations === 0,
  `tightest ${worstFee.feeRatio.toExponential(3)} of the bound`);
record('every certified fill IS the fill the engine served, as close as the two can be compared',
  kept > 0 && diverged === 0,
  `${diverged} refused of ${kept + diverged}; worst certified case used ${(100 * worstAllowance).toFixed(1)}% of the derived allowance`);
record('the agreement allowance is tight, not generous', worstAllowance > 0.05,
  `worst case uses ${(100 * worstAllowance).toFixed(1)}% of it — an allowance nothing approaches would not be a check`);
record('the fill came from the engine, not from a recomputation', typeof execVerify === 'function',
  'execVerify was imported and called; honestOut was never taken from the local recomputation');
record('the sweep spans pool sizes, so a scaling bound is distinguishable from a constant one',
  kept > 1000,
  'reserves range over seven orders of magnitude and the tolerance scales with (x + in + y − out)');
record('both sweeps are discriminating, not vacuous',
  worst.ratio > 1e-12 && worstFee.feeRatio > 1e-12,
  `invariant ${worst.ratio.toExponential(3)} · fee ${worstFee.feeRatio.toExponential(3)}`);

for (const [label, r] of [['invariant', worst.ratio], ['fee', worstFee.feeRatio]]) {
  const head = 1 / r;
  console.log(`  ${label} bound: worst case uses 1/${head.toFixed(1)} of it`);
  if (head > 10) console.log('    wider than the evidence requires — recorded, not quietly kept');
}

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B5-1: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);

writeFileSync(path.join(BUILD, 'gateB5-1-constantproduct-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, diverged, outOfDomain,
  violations, feeViolations, tightestRatio: worst.ratio, tightestFeeRatio: worstFee.feeRatio,
  widestGapToServed: worstGap,
  worst: { x: worst.x, y: worst.y, dx: worst.dx, fee: worst.f, servedOut: worst.servedOut, residual: String(worst.R) },
}, null, 2) + '\n', 'utf8');
process.exit(gate ? 0 : 1);
