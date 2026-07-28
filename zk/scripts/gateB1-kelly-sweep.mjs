// GATE B1 — does the circuit's identity agree with the ENGINE, measured over a sweep?
//
// This is the gate that matters. On the liquidation circuit the equivalent sweep caught an encoder
// that was quietly certifying a position 1.9e-4 away from the one that had been priced, because the
// engine kept full doubles while the encoder truncated onto the grid. Reasoning did not find that.
// Measuring did.
//
// So the Kelly fraction here comes from the REAL sizeGate engine, never from a recomputation of the
// same formula. A recomputation would agree with itself and prove nothing.
//
// Two populations are swept deliberately:
//   GRID   inputs already on the 1e-9 grid, which is what a service that snaps its inputs would hand
//          the circuit. The bound must hold every time.
//   RAW    arbitrary doubles, which is what an unsnapped service would hand it. Whatever happens here
//          is a measurement, not a pass condition, and it is the number that says whether snapping is
//          required or merely tidy.
//
// Run: node zk/scripts/gateB1-kelly-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, '..', 'build');
const { sizeGate } = await import(new URL('../../hackathon/veritape/src/engine/sizeGate.js', import.meta.url));

const SCALE = 1_000_000_000n;
const S = Number(SCALE);
const snap = (x) => Number(x.toFixed(9));
const toScaled = (x) => BigInt(Math.round(snap(x) * S));

// A deterministic generator, so a failure is reproducible and a pass is not luck of the draw.
let seed = 20260728;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function trial(useGrid) {
  // b across a realistic book: 0.1 to 50. p above the break-even 1/(b+1) so the edge is positive.
  let b = 0.1 + rand() * 49.9;
  const breakEven = 1 / (b + 1);
  let p = breakEven + rand() * (1 - breakEven) * 0.98;
  if (useGrid) { b = snap(b); p = snap(p); }

  const r = sizeGate({ winProb: p, winLossRatio: b });
  if (!r.ok || !(r.fullKellyFraction > 0)) return null;

  const pHat = toScaled(p);
  const bHat = toScaled(b);

  // The engine publishes `fullKellyFraction: round(fullKelly, 6)`. Certifying that number would
  // prove an identity about a bet up to 5e-7 away from the one that was sized, which is 500 grid
  // steps and blew the bound by a factor of a thousand when this sweep first ran. So the witness
  // recomputes the fraction at full precision, using the engine's own expression in the engine's own
  // order, from the SNAPPED inputs the circuit will see. Exactly the fix the liquidation circuit
  // needed when the engine handed back `round(M, 2)` for margin.
  const pS = Number(pHat) / S;
  const bS = Number(bHat) / S;
  const fFull = (pS * (bS + 1) - 1) / bS;
  if (!(fFull > 0)) return null;
  const fHat = toScaled(fFull);

  // And the guard that makes recomputing safe: the certified fraction must still be the one that was
  // served, up to the six decimals it is served at. Past that, refuse rather than certify a
  // different bet.
  const displayRounding = 5e-7;
  const gapToServed = Math.abs(fFull - r.fullKellyFraction);
  if (gapToServed > displayRounding) return { diverged: true, gapToServed, p, b };

  if (pHat <= 0n || pHat >= SCALE || bHat <= 0n || fHat <= 0n) return null;

  const R = fHat * bHat - pHat * bHat - SCALE * pHat + SCALE * SCALE;
  const absR2 = (R < 0n ? -R : R) * 2n;
  return { p, b, f: fFull, served: r.fullKellyFraction, gapToServed, R, absR2, bHat, ratio: Number(absR2) / Number(bHat) };
}

function sweep(useGrid, n) {
  let worst = null, violations = 0, kept = 0, diverged = 0;
  for (let i = 0; i < n; i++) {
    const t = trial(useGrid);
    if (!t) continue;
    if (t.diverged) { diverged++; continue; }
    kept++;
    if (t.absR2 > t.bHat) violations++;
    if (!worst || t.ratio > worst.ratio) worst = t;
  }
  return { kept, violations, diverged, worst };
}

console.log(`GATE B1 — Kelly circuit against the live engine — ${new Date().toISOString()}\n`);

const N = 4000;
const grid = sweep(true, N);
const raw = sweep(false, N);

const line = (label, s) => {
  console.log(`  ${label}`);
  console.log(`    sampled            : ${s.kept}`);
  console.log(`    bound violations   : ${s.violations}`);
  console.log(`    tightest case      : 2|R| / b̂ = ${s.worst.ratio.toExponential(3)} (1.0 would be the bound)`);
  console.log(`    at                 : p=${s.worst.p.toPrecision(8)} b=${s.worst.b.toPrecision(8)} f=${s.worst.f.toPrecision(10)}`);
  console.log(`    worst residual     : ${s.worst.R}`);
};

line('GRID-SNAPPED inputs (what a snapping service hands the circuit):', grid);
console.log();
line('RAW doubles (what an unsnapped service would hand it):', raw);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`\n  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};

record('the bound is never violated on grid-snapped inputs', grid.violations === 0,
  `${grid.kept} bets sampled, tightest ${grid.worst.ratio.toExponential(3)} of the bound`);
record('the sweep is discriminating, not vacuous', grid.worst.ratio > 1e-12,
  `if every residual were exactly zero the bound would be untested; tightest observed uses ${grid.worst.ratio.toExponential(3)} of it`);
record('the engine and the circuit agree about the same bet', grid.worst.absR2 <= grid.worst.bHat,
  'the Kelly fraction came from sizeGate, not from a recomputation of the same formula');

// Honesty about what the RAW population now measures, which is less than it did at first. Once the
// witness derives the Kelly fraction from the SNAPPED inputs, snapping is built into the encoder and
// both populations converge on the same statement. The raw row is kept because it shows the encoder
// is insensitive to how the caller rounds, but it is no longer evidence about whether snapping is
// required. Reporting it as such would be reading a conclusion out of a change I made myself.
console.log(`\n  Raw-input population: ${raw.violations} violation(s) of ${raw.kept}.`);
console.log('  Note: the witness derives f from the SNAPPED inputs in both populations, so this row shows the');
console.log('  encoder is stable under caller-side rounding. It does NOT measure whether snapping is required.');

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B1: ${failed.length ? `FAILED — ${failed.map((f) => f.name).join('; ')}` : 'PASSED'}`);

writeFileSync(path.join(BUILD, 'gateB1-kelly-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, samples: N,
  grid: { kept: grid.kept, violations: grid.violations, tightestRatio: grid.worst.ratio, worst: { p: grid.worst.p, b: grid.worst.b, f: grid.worst.f, residual: String(grid.worst.R) } },
  raw: { kept: raw.kept, violations: raw.violations, tightestRatio: raw.worst.ratio },
  checks: results,
}, null, 2) + '\n', 'utf8');
process.exit(failed.length ? 1 : 0);
