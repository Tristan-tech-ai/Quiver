// PROBE 4 — same fixed-point restatement, seeded at the GRID CENTRE instead of the left tail.
// Probe 3 seeded at z=-6, where ŝ is the smallest number on the grid and its relative error is
// worst; the geometric chain then multiplied that error forward into every node. Worse, once
// ŝ(z=-6) underflowed to 0 the chain stayed 0 for the whole grid, so the HIGH tail read zero too
// and the figure collapsed onto the -100% floor. Seeding at z=0 (ŝ = exp(-v/4)) puts the best-
// conditioned value at the start and lets both tails degrade in the direction where degradation is
// harmless: IL(0) = -1 is the correct limit, and IL(inf) = -1 as well.
import __P from '../paths.mjs';
const ENGINE = __P.vtUrl("src/engine/lpRisk.js");
const { lpRisk } = await import(ENGINE);
const { round } = await import(__P.vtUrl("src/engine/stats.js"));

const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);
function engineQuad(v) {
  const sd = Math.sqrt(v); let sum = 0, w = 0;
  for (let i = 0; i <= 400; i++) {
    const z = -6 + 0.03 * i, pdf = Math.exp(-0.5 * z * z);
    sum += pdf * ilOfRatio(Math.exp(-0.5 * v + sd * z)); w += pdf;
  }
  return sum / w;
}

const rdiv = (a, b) => (2n * a + b) / (2n * b);

// stride 5 over the engine's own 401 nodes -> 81 nodes, index 40 is z = 0 exactly.
const STRIDE = 5, IDX = [];
for (let i = 0; i <= 400; i += STRIDE) IDX.push(i);
const MID = IDX.indexOf(200);   // z = 0
if (MID < 0) throw new Error('stride does not contain z=0');

function fixedQuad(v, SPOW) {
  const SS = 10n ** BigInt(SPOW);          // scale for s and t
  const SR = SS * SS;                      // r = s^2 lives on the squared scale
  const PDFHAT = IDX.map((i) => BigInt(Math.round(Math.exp(-0.5 * (-6 + 0.03 * i) ** 2) * 1e9)));
  const WHAT = PDFHAT.reduce((a, b) => a + b, 0n);
  const sd = Math.sqrt(v);
  const sMid = BigInt(Math.round(Math.exp(-v / 4) * Number(SS)));      // seed at z = 0
  const p = BigInt(Math.round(Math.exp(STRIDE * 0.015 * sd) * Number(SS)));  // one step right
  const s = new Array(IDX.length);
  s[MID] = sMid;
  for (let k = MID + 1; k < IDX.length; k++) s[k] = rdiv(s[k - 1] * p, SS);
  for (let k = MID - 1; k >= 0; k--) s[k] = p === 0n ? 0n : rdiv(s[k + 1] * SS, p);
  let acc = 0n, zeros = 0;
  for (let k = 0; k < IDX.length; k++) {
    const r = rdiv(s[k] * s[k], SS);                 // r on scale SS (r = s^2 / SS)
    const t = rdiv(2n * s[k] * SS, SS + r);          // t = 2s/(1+r), on scale SS
    acc += PDFHAT[k] * t;
    if (s[k] === 0n) zeros++;
  }
  const lHat = rdiv(acc, WHAT);                      // on scale SS
  return { lFrac: Number(lHat) / Number(SS), zeros, maxR: s.reduce((m, x) => (x > m ? x : m), 0n), sMid, p, SR };
}

for (const SPOW of [9, 12, 18]) {
  console.log(`\n=== s-grid 1e-${SPOW}, seeded at z=0, 81 nodes ===`);
  console.log('    v          float E[IL]        fixed E[IL]        |gap|      ŝ=0 nodes  ŝ(z=0)');
  let worst = 0, worstV = 0;
  for (const v of [1e-4, 0.01, 0.25, 1, 5, 10, 20, 36, 60, 100, 150, 200, 250]) {
    const f = engineQuad(v), q = fixedQuad(v, SPOW);
    const fx = q.lFrac - 1, g = Math.abs(f - fx);
    if (g > worst) { worst = g; worstV = v; }
    console.log(`  ${String(v).padEnd(9)}  ${f.toFixed(12)}  ${fx.toFixed(12)}  ${g.toExponential(2)}  ${String(q.zeros).padStart(6)}     ${q.sMid}`);
  }
  console.log(`  worst |gap| sampled: ${worst.toExponential(3)} at v=${worstV}`);
}

// ---- the real test: against the SERVICE, with a guard, and a measured refusal rate -----------
console.log('\n=== against the live engine, 3000 v, with the round-to-served guard ===');
console.log('  s-grid   certified  refused  worst gap among CERTIFIED   refusal band in v');
for (const SPOW of [9, 12, 18]) {
  let kept = 0, refused = 0, worstGap = 0, worstCase = null;
  let bandLo = Infinity, bandHi = -Infinity;
  const T = 30;
  for (let k = 1; k <= 3000; k++) {
    const v = Math.exp(Math.log(1e-6) + (k / 3000) * (Math.log(250) - Math.log(1e-6)));
    const res = lpRisk({ volatility: Math.sqrt(v / T), horizonPeriods: T });
    if (!res.ok || !res.expectedDivergence) continue;
    const served = res.expectedDivergence.expectedIlPct;
    const q = fixedQuad(res.expectedDivergence.totalVariance, SPOW);
    const certPct = (q.lFrac - 1) * 100;
    if (round(certPct, 4) !== served) { refused++; bandLo = Math.min(bandLo, v); bandHi = Math.max(bandHi, v); continue; }
    kept++;
    const gap = Math.abs(certPct - served) / 100;
    if (gap > worstGap) { worstGap = gap; worstCase = { v, served, certPct }; }
  }
  console.log(`  1e-${String(SPOW).padEnd(4)}  ${String(kept).padEnd(10)} ${String(refused).padEnd(8)} ${worstGap.toExponential(3)} at v=${worstCase.v.toPrecision(6).padEnd(12)} ${refused ? `[${bandLo.toPrecision(4)}, ${bandHi.toPrecision(4)}]` : 'none'}`);
}
