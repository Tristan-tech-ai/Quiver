// PHASE 1 GATE — does the proof certify the number the service actually answered?
//
// The circuit carries every quantity as an integer on the 1e-9 grid. The engine carries doubles. So
// unless the service's inputs are ALSO on that grid, the circuit is proving an identity about a
// slightly different position than the one the caller was sold — up to 1.86e-4 away, per the earlier
// measurement. A proof of a nearby position is not a proof of the answer, and shipping one with a
// footnote would be worse than shipping none.
//
// This measures three variants over the same sampled positions:
//   (0) unsnapped        — what ships today
//   (1) snap the inputs  — entry price, size, mmr rounded to the grid before the engine runs
//   (2) snap M too       — margin is DERIVED from leverage, so it lands off-grid even when its
//                          ingredients are on it; this is the variant that has to work
//
// GATE: worst-case |engine − canonical| in variant 2 must be <= 1e-9, with variant 0 reported beside
// it so the improvement is a measurement rather than a claim.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const scale = require(path.join(__dirname, '..', 'src', 'scale.js'));

const SCALE = scale.SCALE;
const grid = (x) => scale.fromScaled(scale.toScaled(x, 'grid'));

// A deterministic sampler — no Math.random, so this run is reproducible and a regression is a real
// regression rather than a different sample.
function* positions(n) {
  const mmrTiers = [0.005, 0.0125, 0.02, 0.025, 0.04, 0.05];
  let seed = 20260728n;
  const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number(seed >> 11n) / 2 ** 53; };
  for (let i = 0; i < n; i++) {
    const P0 = 100 + next() * 199900;                 // 100 .. 200,000
    const q = 0.001 + next() * 999;                   // 0.001 .. 1000
    const lev = 1 + next() * 99;                      // 1x .. 100x
    const mmr = mmrTiers[Math.floor(next() * mmrTiers.length)];
    const s = next() < 0.5 ? 1 : -1;
    yield { P0, q, lev, mmr, s };
  }
}

function diverge({ P0, q, lev, mmr, s }, mode) {
  let p0 = P0, size = q, rate = mmr;
  let L = lev;
  if (mode >= 1) { p0 = grid(P0); size = grid(q); rate = grid(mmr); }
  if (mode === 3) L = grid(lev);
  let M = size * p0 / L;
  if (mode >= 2) M = grid(M);

  const enginePrice = scale.engineLiquidationPrice({ M, q: size, P0: p0, s, mmr: rate });
  if (!Number.isFinite(enginePrice) || enginePrice <= 0) return null;   // not a live position

  const enc = {
    mHat: scale.toScaled(M, 'M'), qHat: scale.toScaled(size, 'q'),
    p0Hat: scale.toScaled(p0, 'P0'), s, mmrHat: scale.toScaled(rate, 'mmr'),
  };
  if (enc.qHat === 0n || enc.mmrHat >= SCALE) return null;
  const canonical = scale.fromScaled(scale.canonicalLiquidationPrice(enc));
  if (!Number.isFinite(canonical) || canonical <= 0) return null;
  return Math.abs(enginePrice - canonical);
}

const N = Number(process.argv[2] || 2000);
const stats = [0, 1, 2, 3].map(() => ({ n: 0, worst: 0, exact: 0, over1e9: 0 }));
const sample = [...positions(N)];

for (const p of sample) {
  for (const mode of [0, 1, 2, 3]) {
    let d;
    try { d = diverge(p, mode); } catch { d = null; }
    if (d === null) continue;
    const st = stats[mode];
    st.n++;
    if (d > st.worst) st.worst = d;
    if (d === 0) st.exact++;
    if (d > 1e-9) st.over1e9++;
  }
}

const label = ['0  unsnapped (ships today)', '1  inputs snapped', '2  inputs + derived margin snapped', '3  inputs + leverage snapped (margin still derived)'];
console.log(`PHASE 1 GATE — grid snap — ${new Date().toISOString()}`);
console.log(`sampled ${N} positions (deterministic seed), SCALE = 1e-9\n`);
for (const m of [0, 1, 2, 3]) {
  const s = stats[m];
  console.log(`${label[m].padEnd(36)} n=${String(s.n).padStart(5)}  worst |engine-canonical| = ${s.worst.toExponential(2).padStart(9)}   exact ${(100 * s.exact / s.n).toFixed(1)}%   over 1e-9: ${s.over1e9}`);
}

const gate = stats[2].n > 0 && stats[2].worst <= 1e-9 && stats[2].over1e9 === 0;
console.log('');
console.log('GATE 1');
console.log(`  worst divergence, snapped   : ${stats[2].worst.toExponential(3)}  (bound 1e-9)`);
console.log(`  worst divergence, unsnapped : ${stats[0].worst.toExponential(3)}  <- what ships today`);
console.log(`  positions over the bound     : ${stats[2].over1e9}`);
console.log(`\n  ${gate ? 'GATE 1 PASSED — snapping makes the proof describe the position the service answered.' : 'GATE 1 FAILED — do not ship a proof of a different position.'}`);

fs.writeFileSync(path.join(__dirname, '..', 'build', 'gate1-gridsnap.json'), JSON.stringify({
  at: new Date().toISOString(), sampled: N,
  unsnappedWorst: stats[0].worst, inputsSnappedWorst: stats[1].worst, fullySnappedWorst: stats[2].worst,
  overBound: stats[2].over1e9, gate,
}, null, 2));
process.exit(gate ? 0 : 1);
