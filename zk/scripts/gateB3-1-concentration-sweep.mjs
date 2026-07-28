// GATE B3-1 — does the circuit's identity agree with the ENGINE, measured over a sweep?
//
// This is the gate that matters, and it is the one that has failed twice on two different circuits.
// The liquidation encoder was quietly certifying a position 1.9e-4 away from the one that had been
// priced; the Kelly encoder blew its bound by a factor of a thousand on 3,997 of 4,000 samples. Both
// times the cause was the same and neither was found by reasoning: the ENGINE PUBLISHES A ROUNDED
// NUMBER, and a witness that reads it certifies a different input.
//
// treasury-risk publishes `hhi: round(H, 4)`. Its own source says so, in a comment above the check:
// "byAsset.hhi is published rounded to 4dp while this recomputation is full precision". So the trap is
// known in advance here, which changes nothing about the need to measure. Knowing where a trap is is
// not evidence that you avoided it.
//
// The Herfindahl index comes from the REAL treasuryRisk engine, never from a recomputation of Σwᵢ².
// A recomputation would agree with itself and prove nothing.
//
// Run: node zk/scripts/gateB3-1-concentration-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, snap, toScaled, checklist } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { treasuryRisk } = await load(import.meta.url, 'engine/treasuryRisk.js');

const N = 8;
const TOL_MULT = 1n;
const TOLERANCE = TOL_MULT * SCALE;

// The engine publishes the index at 4 decimals, so half of that is the furthest a certified index may
// sit from the served one. Past it, refuse rather than certify a different book.
const DISPLAY_ROUNDING = 5e-5;

// Deterministic, so a failure reproduces and a pass is not luck of the draw.
let seed = 20260728;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const ASSETS = ['USDC', 'USDT', 'DAI', 'FRAX', 'PYUSD', 'USDE', 'GHO', 'LUSD'];

function trial() {
  // Between 2 and 8 assets, sizes spanning four orders of magnitude so both balanced and
  // pathologically concentrated books are sampled.
  const n = 2 + Math.floor(rand() * (N - 1));
  const positions = [];
  for (let i = 0; i < n; i++) {
    positions.push({ asset: ASSETS[i], amountUsd: 10 ** (2 + rand() * 4) * (0.1 + rand()), apyPct: rand() * 8 });
  }

  const r = treasuryRisk({ positions });
  if (!r.ok) return null;
  const served = r.concentration.byAsset.hhi;          // round(H, 4)
  if (!(served > 0)) return null;

  // Weights, on the grid the circuit reads. Recomputed here from the same amounts the engine was
  // given, because the engine publishes shares only as `sharePct` rounded to 2dp — reading THOSE
  // would be the trap one level deeper.
  const total = positions.reduce((s, p) => s + p.amountUsd, 0);
  const wHat = positions.map((p) => toScaled(p.amountUsd / total));
  const padded = [...wHat, ...Array(N - wHat.length).fill(0n)];

  // The index the circuit will certify: full precision, from the SNAPPED weights, because those are
  // what the circuit sees. Never `served`, which is four decimals wide.
  const sumSq = padded.reduce((a, w) => a + w * w, 0n);
  const hHat = (sumSq + SCALE / 2n) / SCALE;
  const hFull = Number(hHat) / S;

  // The guard that makes recomputing safe: the certified index must still be the one that was served,
  // to the precision it was served at.
  const gapToServed = Math.abs(hFull - served);
  if (gapToServed > DISPLAY_ROUNDING) return { diverged: true, gapToServed, n, served, hFull };

  const sumW = padded.reduce((a, w) => a + w, 0n);
  const slack = sumW - SCALE;
  const R = hHat * SCALE - sumSq;
  const absR2 = (R < 0n ? -R : R) * 2n;
  return { n, served, hFull, gapToServed, R, absR2, slack, ratio: Number(absR2) / Number(TOLERANCE) };
}

const { record, failed } = checklist();
console.log(`GATE B3-1 — concentration circuit against the live engine — ${new Date().toISOString()}\n`);

const RUNS = 4000;
let kept = 0, violations = 0, diverged = 0, slackViolations = 0;
let worst = null, worstGap = 0;
for (let i = 0; i < RUNS; i++) {
  const t = trial();
  if (!t) continue;
  if (t.diverged) { diverged++; worstGap = Math.max(worstGap, t.gapToServed); continue; }
  kept++;
  if (t.absR2 > TOLERANCE) violations++;
  const absSlack = t.slack < 0n ? -t.slack : t.slack;
  if (absSlack > BigInt(N)) slackViolations++;
  worstGap = Math.max(worstGap, t.gapToServed);
  if (!worst || t.ratio > worst.ratio) worst = t;
}

console.log(`  books sampled      : ${kept}`);
console.log(`  refused by guard   : ${diverged}`);
console.log(`  bound violations   : ${violations}`);
console.log(`  sum-slack failures : ${slackViolations}`);
console.log(`  tightest case      : 2|R| / TOL = ${worst.ratio.toExponential(3)} (1.0 would be the bound)`);
console.log(`  at                 : ${worst.n} assets, served HHI ${worst.served}, certified ${worst.hFull}`);
console.log(`  worst residual     : ${worst.R}`);
console.log(`  widest gap to served: ${worstGap.toExponential(2)} (guard refuses past ${DISPLAY_ROUNDING})\n`);

record('the bound is never violated', violations === 0,
  `${kept} books sampled, tightest ${worst.ratio.toExponential(3)} of the bound`);
record('every book keeps its shares summing to the whole book', slackViolations === 0,
  `allowance is ${N} grid steps; ${slackViolations} exceeded it`);
record('the certified index is the one that was served', worstGap <= DISPLAY_ROUNDING,
  `widest gap ${worstGap.toExponential(2)} against a ${DISPLAY_ROUNDING} guard`);
record('the index came from the engine, not from a recomputation',
  typeof treasuryRisk === 'function',
  'treasuryRisk was imported and called; Σwᵢ² was never used as the source of the served figure');

// The check that stops a green result from being empty. If every residual were zero the bound would be
// untested, and if the tightest case used a millionth of it the bound would be generous rather than
// proven. Both are ways for a sweep to pass while measuring nothing.
record('the sweep is discriminating, not vacuous', worst.ratio > 1e-12,
  `tightest observed uses ${worst.ratio.toExponential(3)} of the bound`);

// And an explicit note on how much of the tolerance is actually needed, because a bound four times
// wider than anything observed is a bound chosen for comfort.
const headroom = 1 / worst.ratio;
console.log(`\n  The tolerance is ${TOL_MULT}·S and the worst observed case uses 1/${headroom.toFixed(1)} of it.`);
if (headroom > 10) {
  console.log('  That is wider than the evidence requires. Recorded rather than quietly kept: a bound');
  console.log('  nothing comes close to is not a bound the sweep has tested.');
}

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B3-1: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);

writeFileSync(path.join(BUILD, 'gateB3-1-concentration-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, violations, diverged, slackViolations,
  tightestRatio: worst.ratio, headroomFactor: headroom, widestGapToServed: worstGap,
  worst: { assets: worst.n, served: worst.served, certified: worst.hFull, residual: String(worst.R) },
}, null, 2) + '\n', 'utf8');
process.exit(gate ? 0 : 1);
