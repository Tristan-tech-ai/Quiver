// Verify the adversary's claim: E[IL](v) == exp(-v/8) - 1 exactly, where v = sigma^2 * T.
// I do NOT use their code. I reimplement the engine's own quadrature from its source shape and
// also call the engine itself, then compare both to the closed form.
import __P from '../paths.mjs';
const ENGINE = __P.vtUrl("src/engine/lpRisk.js");
const { lpRisk } = await import(ENGINE);

// ---- 1. Independent Gauss-Legendre-free check: the engine's own trapezoid grid, reimplemented.
// z_i = -6 + 0.03 i, i = 0..400. integrand = (2 sqrt(r) / (1+r) - 1) * phi(z), r = exp(sqrt(v) z - v/2).
function quad(v, zmax = 6, N = 400) {
  const h = (2 * zmax) / N;
  let s = 0;
  for (let i = 0; i <= N; i++) {
    const z = -zmax + h * i;
    const r = Math.exp(Math.sqrt(v) * z - v / 2);
    const il = (2 * Math.sqrt(r)) / (1 + r) - 1;
    const pdf = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
    const w = (i === 0 || i === N) ? 0.5 : 1;
    s += w * il * pdf * h;
  }
  return s;
}
const closed = (v) => Math.expm1(-v / 8);

// ---- 2. Does the closed form match the quadrature, and is the residual the QUADRATURE's?
let worst = 0, worstV = 0;
for (let i = 0; i <= 20000; i++) {
  const v = Math.pow(10, -8 + (12 * i) / 20000); // 1e-8 .. 1e4
  const g = Math.abs(quad(v) - closed(v));
  if (g > worst) { worst = g; worstV = v; }
}
console.log(`zmax=6  N=400   worst |quad - closed| = ${worst.toExponential(4)} at v=${worstV.toExponential(4)}`);

// If the residual belongs to the truncation of the |z|<=6 window, it must SHRINK when the
// window widens and be INVARIANT in N. Both are falsifiable predictions.
for (const [zm, N] of [[6, 400], [6, 1600], [8, 400], [8, 1600], [16, 25600]]) {
  let w = 0;
  for (let i = 0; i <= 2000; i++) {
    const v = Math.pow(10, -8 + (12 * i) / 2000);
    w = Math.max(w, Math.abs(quad(v, zm, N) - closed(v)));
  }
  console.log(`  zmax=${zm} N=${N}: worst ${w.toExponential(4)}`);
}

// ---- 3. Against the LIVE ENGINE's published field, not my quadrature.
const rows = [];
for (const [sigma, T] of [[0.3, 30], [0.5, 90], [0.6, 365], [0.8, 7], [1.2, 180], [0.129854598, 304]]) {
  const out = lpRisk({
    volatility: sigma, horizonPeriods: T, capitalUsd: 100000,
  });
  const ed = out?.expectedDivergence;
  if (!ed) { rows.push({ sigma, T, note: 'no expectedDivergence', keys: Object.keys(out || {}) }); continue; }
  const v = ed.totalVariance;
  const pub = ed.expectedIlPct;
  const pred = closed(v) * 100;
  rows.push({
    sigma, T, v, publishedPct: pub, closedFormPct: +pred.toFixed(10),
    absGap: +Math.abs(pub - pred).toExponential(3),
    leadingOrderPub: ed.expectedIlLeadingOrderPct,
    // the adversary's second claim: 1 + pct/100 == exp(leadingOrder/100)
    logIdentity: +Math.abs((1 + pub / 100) - Math.exp(ed.expectedIlLeadingOrderPct / 100)).toExponential(3),
    approxGapPub: ed.approximationGapPct,
    approxGapPred: ed.approximationGapPct == null ? null
      : +((Math.expm1(-v / 8) - (-v / 8)) * 100).toFixed(4),
  });
}
console.log('\nLIVE ENGINE vs closed form:');
console.log(JSON.stringify(rows, null, 1));

// ---- 4. Breakeven inversion: v* = -8 ln(1 - fee) instead of 200 bisection steps.
console.log('\nbreakeven closed form v* = -8 ln(1-f):');
for (const f of [1e-6, 0.01, 0.1, 0.5, 0.99]) {
  console.log(`  f=${f}  v*=${(-8 * Math.log(1 - f)).toExponential(8)}`);
}
// the lp-risk report measured the boundedness defect threshold at v = 116.0687404
console.log(`\n-8*ln(5e-7) = ${(-8 * Math.log(5e-7)).toFixed(7)}   (report measured 116.0687404)`);
