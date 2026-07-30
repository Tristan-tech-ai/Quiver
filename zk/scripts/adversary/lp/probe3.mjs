// PROBE 3 — the decisive one. Can the expectation be restated in SCALED INTEGERS on the shared
// 1e-9 grid, as BigInt, and still reproduce the figure the service serves at the precision it
// serves it? If not, no circuit exists regardless of how the transcendentals are handled.
import __P from '../paths.mjs';
const ENGINE = __P.vtUrl("src/engine/lpRisk.js");
const { lpRisk } = await import(ENGINE);

const SCALE = 1000000000n, S = 1e9;
const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);
function engineQuad(v) {
  const sd = Math.sqrt(v); let sum = 0, w = 0;
  for (let i = 0; i <= 400; i++) {
    const z = -6 + 0.03 * i, pdf = Math.exp(-0.5 * z * z);
    sum += pdf * ilOfRatio(Math.exp(-0.5 * v + sd * z)); w += pdf;
  }
  return sum / w;
}

// ---- the sub-grid, chosen by probe2: stride 5, 81 of the same 401 nodes -----------------
const STRIDE = 5, NODES = [];
for (let i = 0; i <= 400; i += STRIDE) NODES.push(i);
// pdf weights are compile-time constants: they do not depend on v at all. Scaled to 1e9.
const PDFHAT = NODES.map((i) => BigInt(Math.round(Math.exp(-0.5 * (-6 + 0.03 * i) ** 2) * S)));
const WHAT = PDFHAT.reduce((a, b) => a + b, 0n);

const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const rsqrt = (n) => { let s = isqrt(n); if ((s + 1n) * (s + 1n) - n < n - s * s) s += 1n; return s; };
const rdiv = (a, b) => (2n * a + b) / (2n * b);   // round(a/b) for positive b

// ---- the fixed-point restatement -------------------------------------------------------
//   sdHat  = round(sqrt(v)·S)                 forced by sdHat^2 == vHat·S
//   s0Hat  = round(exp(-v/4 - 3 sd)·S)        seed, pinnable by Taylor+squaring (probe2a)
//   pHat   = round(exp(0.015 sd)·S)           seed, pinnable by Taylor (probe2a)
//   s_{k+1} = round(s_k · p / S)              the geometric chain, one multiply per node
//   r_k     = round(s_k^2 / S)
//   t_k     = round(2·s_k·S / (S + r_k))      the only division, one per node
//   Ehat+S  = round(sum(pdf_k · t_k) / W)
function fixedQuad(v) {
  const vHat = BigInt(Math.round(v * S));
  const sdHat = rsqrt(vHat * SCALE);
  const s0 = BigInt(Math.round(Math.exp(-v / 4 - 3 * Math.sqrt(v)) * S));
  // The chain ratio is the SUB-GRID step, not the full-grid step: z advances by STRIDE·0.03 per
  // node, so p = exp(STRIDE·0.015·sd). Using 0.015 walked only 1/STRIDE of the grid and sampled
  // nothing but the left tail — which is why the first run of this probe read -0.86 where the
  // engine reads -0.12, a 23x shape that is a truncated domain and not a scale error.
  const p = BigInt(Math.round(Math.exp(STRIDE * 0.015 * Math.sqrt(v)) * S));
  let s = s0, acc = 0n;
  const trace = [];
  for (let k = 0; k < NODES.length; k++) {
    const r = rdiv(s * s, SCALE);
    const t = (SCALE + r) === 0n ? 0n : rdiv(2n * s * SCALE, SCALE + r);
    acc += PDFHAT[k] * t;
    trace.push({ s, r, t });
    if (k + 1 < NODES.length) s = rdiv(s * p, SCALE);
  }
  const lHat = rdiv(acc, WHAT);          // L = E[IL] + 1, in (0, S]
  return { lHat, vHat, sdHat, s0, p, trace };
}

console.log('=== A. fixed-point (BigInt, 1e-9 grid) vs the float quadrature ===');
console.log('    v          float E[IL]        fixed E[IL]        |gap|      max r̂ bits  min ŝ');
let worst = 0, worstV = 0;
for (const v of [1e-4, 0.01, 0.0625, 0.25, 1, 2.5, 5, 10, 20, 36, 60, 100, 200, 250]) {
  const f = engineQuad(v), q = fixedQuad(v);
  const fx = Number(q.lHat) / S - 1;
  const g = Math.abs(f - fx);
  if (g > worst) { worst = g; worstV = v; }
  const maxR = q.trace.reduce((m, x) => (x.r > m ? x.r : m), 0n);
  const minS = q.trace.reduce((m, x) => (x.s < m ? x.s : m), q.trace[0].s);
  console.log(`  ${String(v).padEnd(9)}  ${f.toFixed(12)}  ${fx.toFixed(12)}  ${g.toExponential(2)}  ${String(maxR.toString(2).length).padStart(5)}      ${minS}`);
}
console.log(`  worst |gap| on the sampled v: ${worst.toExponential(3)} at v=${worstV}`);

console.log('\n=== B. does the fixed-point figure ROUND to the figure the service served? ===');
// 3000 log-spaced v, each turned into a real (volatility, horizonPeriods) call so the comparison is
// against the SERVICE, not against my own float copy.
const { round } = await import(__P.vtUrl("src/engine/stats.js"));
let kept = 0, mismatch = 0, worstGap = 0, worstCase = null, maxRbits = 0, zeroS = 0;
const T = 30;
for (let k = 1; k <= 3000; k++) {
  const v = Math.exp(Math.log(1e-6) + (k / 3000) * (Math.log(250) - Math.log(1e-6)));
  const sigma = Math.sqrt(v / T);
  const res = lpRisk({ volatility: sigma, horizonPeriods: T });
  if (!res.ok || !res.expectedDivergence) continue;
  const served = res.expectedDivergence.expectedIlPct;          // round(frac*100, 4)
  const q = fixedQuad(res.expectedDivergence.totalVariance);    // the v the SERVICE reports, rounded to 6dp
  const certPct = (Number(q.lHat) / S - 1) * 100;
  kept++;
  const gap = Math.abs(certPct - served) / 100;
  if (gap > worstGap) { worstGap = gap; worstCase = { v, sigma, served, certPct }; }
  if (round(certPct, 4) !== served) mismatch++;
  maxRbits = Math.max(maxRbits, q.trace.reduce((m, x) => (x.r > m ? x.r : m), 0n).toString(2).length);
  if (q.trace.some((x) => x.s === 0n)) zeroS++;
}
console.log(`  v sampled                 : ${kept}   (log-spaced in [1e-6, 250], each a real service call at T=30)`);
console.log(`  rounded-figure mismatches : ${mismatch}`);
console.log(`  widest full-precision gap : ${worstGap.toExponential(3)}  (half a served step is 5.000e-7)`);
console.log(`  worst case                : v=${worstCase.v.toPrecision(6)} sigma=${worstCase.sigma.toPrecision(6)} served ${worstCase.served}%  fixed ${worstCase.certPct.toFixed(8)}%`);
console.log(`  widest r̂ seen             : ${maxRbits} bits`);
console.log(`  v where the low tail underflows the grid to ŝ=0 : ${zeroS} of ${kept} cases (harmless: IL(0) = -1 is the correct limit)`);

console.log('\n=== C. where does the low tail actually underflow, and does it matter? ===');
for (const v of [10, 20, 24, 30, 40, 60, 100]) {
  const q = fixedQuad(v);
  const zeros = q.trace.filter((x) => x.s === 0n).length;
  const f = engineQuad(v), fx = Number(q.lHat) / S - 1;
  console.log(`  v=${String(v).padEnd(5)} ŝ=0 at ${String(zeros).padStart(2)} of 81 nodes   |gap to float| ${Math.abs(f - fx).toExponential(2)}`);
}
