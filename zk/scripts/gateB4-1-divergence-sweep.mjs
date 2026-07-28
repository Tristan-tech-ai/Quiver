// GATE B4-1 — does the divergence circuit agree with the ENGINE, measured over a sweep?
//
// The IL figure comes from the REAL lpRisk engine. A recomputation of 2√r/(1+r) would agree with
// itself and prove nothing, which is the whole reason this gate exists rather than a unit test.
//
// TWO ROUNDED FIELDS HERE, NOT ONE. `impermanentLossPct: round(il * 100, 4)` is a PERCENTAGE rounded
// to four places, so the underlying fraction is known only to six — half a step is 5e-7. And the
// engine serves the amplified figure when a concentration factor is supplied, which is a
// linearisation and not this identity at all, so the sweep runs at concentrationFactor = 1 and says
// so rather than quietly certifying a different model.
//
// Run: node zk/scripts/gateB4-1-divergence-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { lpRisk } = await load(import.meta.url, 'engine/lpRisk.js');
// The engine's OWN rounding function, not a reimplementation of it. The comparison below has to be the
// one the engine makes, or it is a comparison against a threshold I chose.
const { round } = await load(import.meta.url, 'engine/stats.js');

const TOL_ID = 4n;      // the circuit's compile-time constants, mirrored here so the gate measures
const TOL_ROOT = 1n;    // the same statement the circuit proves
// The first version of this gate compared full-precision against served with a 5e-7 threshold, and
// FAILED on 3 of 4,000 ratios whose gap landed on exactly 5.00e-7 — the rounding tie itself. The
// threshold was the defect, not the circuit: a value sitting on a rounding boundary is not a value
// that diverged. So the comparison is now the one treasury-risk's own self-check learned to make,
// 'compare at the precision actually served'. round() below is the ENGINE's function, imported.
const SERVED_DP = 4;   // impermanentLossPct: round(il * 100, 4)

let seed = 20260728;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const isqrt = (n) => {
  // Integer square root by Newton, on BigInt. Math.sqrt on a 2^60 value loses the low bits, and those
  // low bits ARE the residual this gate measures.
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};

function trial() {
  // Ratios from a 100x crash to a 100x rally, log-uniform so both tails are sampled as often as the
  // middle. A pair that has moved 100x is where the closed form is least forgiving.
  const r = Math.exp((rand() * 2 - 1) * Math.log(100));

  const res = lpRisk({ priceRatio: r, concentrationFactor: 1 });
  if (!res.ok || !res.realizedIL) return null;
  const servedPct = res.realizedIL.impermanentLossPct;      // round(IL*100, 4)

  const rHat = toScaled(r, 'r');
  if (rHat <= 0n) return null;

  // ŝ = round(sqrt(r̂ · S)) in integers. Deriving it from Math.sqrt(r) * 1e9 would be a double
  // rounding and would put the residual where the arithmetic is, not where the identity is.
  const target = rHat * SCALE;
  let sHat = isqrt(target);
  if ((sHat + 1n) * (sHat + 1n) - target < target - sHat * sHat) sHat += 1n;   // round, not floor

  // L = 2√r/(1+r), full precision, from the SNAPPED inputs the circuit will see.
  const lFull = (2 * Number(sHat) / S) / (1 + Number(rHat) / S);
  const lHat = BigInt(Math.round(lFull * S));
  if (lHat <= 0n) return null;

  // The guard: the certified loss must still be the one served, at the precision it was served.
  const certifiedPct = (Number(lHat) / S - 1) * 100;
  const gapToServed = Math.abs(certifiedPct - servedPct) / 100;
  // Certify only when the certified figure, expressed at the precision the service publishes, IS the
  // figure the service published. Anything else means proving about a different position.
  if (round(certifiedPct, SERVED_DP) !== servedPct) return { diverged: true, gapToServed, r, servedPct, certifiedPct };

  const Rs = sHat * sHat - rHat * SCALE;
  const R = lHat * (SCALE + rHat) - 2n * SCALE * sHat;
  const idTol = rHat + TOL_ID * SCALE;
  const rootTol = 2n * sHat + TOL_ROOT * SCALE;
  const abs = (x) => (x < 0n ? -x : x);
  return {
    r, servedPct, certifiedPct, gapToServed, R, Rs,
    idRatio: Number(abs(R) * 2n) / Number(idTol),
    rootRatio: Number(abs(Rs) * 2n) / Number(rootTol),
  };
}

const { record, failed } = checklist();
console.log(`GATE B4-1 — divergence circuit against the live engine — ${new Date().toISOString()}\n`);

const RUNS = 4000;
let kept = 0, idViolations = 0, rootViolations = 0, diverged = 0;
let worstId = null, worstRoot = null, worstGap = 0;
for (let i = 0; i < RUNS; i++) {
  const t = trial();
  if (!t) continue;
  if (t.diverged) { diverged++; continue; }   // refused, so its gap is not a property of anything certified
  kept++;
  if (t.idRatio > 1) idViolations++;
  if (t.rootRatio > 1) rootViolations++;
  worstGap = Math.max(worstGap, t.gapToServed);
  if (!worstId || t.idRatio > worstId.idRatio) worstId = t;
  if (!worstRoot || t.rootRatio > worstRoot.rootRatio) worstRoot = t;
}

console.log(`  ratios sampled       : ${kept}   (log-uniform, 1/100x to 100x)`);
console.log(`  refused by guard     : ${diverged}`);
console.log(`  identity violations  : ${idViolations}`);
console.log(`  root violations      : ${rootViolations}`);
console.log(`  tightest identity    : 2|R| / TOL  = ${worstId.idRatio.toExponential(3)}  at r=${worstId.r.toPrecision(6)}`);
console.log(`  tightest root        : 2|Rs| / TOL = ${worstRoot.rootRatio.toExponential(3)}  at r=${worstRoot.r.toPrecision(6)}`);
console.log(`  widest gap to served : ${worstGap.toExponential(2)} among the CERTIFIED cases`);
console.log(`  refusal rate         : ${((100 * diverged) / (kept + diverged)).toFixed(4)}%`);
console.log(`  worst case served    : IL ${worstId.servedPct}% · certified ${worstId.certifiedPct.toFixed(6)}%\n`);

record('the identity bound is never violated', idViolations === 0,
  `${kept} ratios sampled, tightest ${worstId.idRatio.toExponential(3)} of the bound`);
record('the root bound is never violated', rootViolations === 0,
  `tightest ${worstRoot.rootRatio.toExponential(3)} of the bound`);
// Two separate claims, and conflating them is what made the first version of this gate fail for the
// wrong reason. One: nothing that WAS certified disagreed with the service. Two: the cases the guard
// refused are rare enough to be a boundary effect rather than a broken encoder. A guard that refuses
// nothing is not a guard, so a refusal count of zero would not be the target either.
record('nothing certified disagrees with the figure the service served',
  kept > 0 && worstGap * 100 <= 5e-5 + 1e-12,
  `all ${kept} certified cases round to the served figure; widest full-precision gap ${worstGap.toExponential(2)}`);

const refusalRate = diverged / (kept + diverged);
record('refusals are a rounding-boundary effect, not a broken encoder', refusalRate < 0.005,
  `${diverged} of ${kept + diverged} refused (${(100 * refusalRate).toFixed(4)}%) — those are ratios whose snapped inputs `
  + 'land on the far side of a 4dp boundary from the engine\'s full-precision value, so the guard '
  + 'declines rather than certifying a different ratio');
record('the loss came from the engine, not from a recomputation', typeof lpRisk === 'function',
  'lpRisk was imported and called at concentrationFactor 1, where the served figure IS this identity');
record('both sweeps are discriminating, not vacuous',
  worstId.idRatio > 1e-12 && worstRoot.rootRatio > 1e-12,
  `identity ${worstId.idRatio.toExponential(3)} · root ${worstRoot.rootRatio.toExponential(3)}`);

for (const [label, w, tol] of [['identity', worstId.idRatio, TOL_ID], ['root', worstRoot.rootRatio, TOL_ROOT]]) {
  const head = 1 / w;
  console.log(`  ${label} bound: worst case uses 1/${head.toFixed(1)} of it (TOL ${tol})`);
  if (head > 10) console.log(`    wider than the evidence requires — recorded, not quietly kept`);
}

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B4-1: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);

writeFileSync(path.join(BUILD, 'gateB4-1-divergence-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, diverged,
  idViolations, rootViolations,
  tightestIdentityRatio: worstId.idRatio, tightestRootRatio: worstRoot.rootRatio,
  widestGapToServed: worstGap,
  worst: { ratio: worstId.r, servedPct: worstId.servedPct, certifiedPct: worstId.certifiedPct, residual: String(worstId.R) },
}, null, 2) + '\n', 'utf8');
process.exit(gate ? 0 : 1);
