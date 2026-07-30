// Is the engine's 401-point quadrature a closed form?
//
// E[IL] = E[ 2 sqrt(r)/(1+r) ] - 1 with ln r ~ N(-v/2, v).
// 2 sqrt(r)/(1+r) = sech(ln r / 2). Write a = sqrt(v)/2, so ln r / 2 = a*z - a^2 with z ~ N(0,1).
// Shift z = w + a:  sech(a*w).  pdf picks up exp(-a*w - a^2/2).
// Symmetrise w -> -w:  (e^{-aw} + e^{aw})/2 = cosh(a*w), and cosh(a*w)*sech(a*w) = 1 EXACTLY.
// So E[sech] = e^{-a^2/2} = e^{-v/8}.  ==>  E[IL] = exp(-v/8) - 1.
//
// Test it against the engine's own function, reproduced verbatim from src/engine/lpRisk.js.

import __P from '../paths.mjs';
const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);
function expectedIlNumerical(v) {           // verbatim copy of the engine's quadrature
  const sd = Math.sqrt(v);
  let sum = 0, w = 0;
  const N = 400, lo = -6, hi = 6;
  for (let i = 0; i <= N; i++) {
    const z = lo + ((hi - lo) * i) / N;
    const pdf = Math.exp(-0.5 * z * z);
    const r = Math.exp(-0.5 * v + sd * z);
    sum += pdf * ilOfRatio(r);
    w += pdf;
  }
  return sum / w;
}
const closed = (v) => Math.expm1(-v / 8);

// ---- 1. absolute agreement over a wide log-spaced sweep
let worst = 0, worstV = 0, worstRel = 0, worstRelV = 0;
const M = 20001;
for (let i = 0; i < M; i++) {
  const v = Math.pow(10, -8 + (12 * i) / (M - 1));      // 1e-8 .. 1e4
  const a = expectedIlNumerical(v), b = closed(v);
  const d = Math.abs(a - b);
  if (d > worst) { worst = d; worstV = v; }
  const rel = d / Math.max(1e-300, Math.abs(b));
  if (rel > worstRel) { worstRel = rel; worstRelV = v; }
}
console.log(`sweep 1e-8..1e4, ${M} log-spaced v`);
console.log(`  worst ABS gap quadrature vs exp(-v/8)-1 : ${worst.toExponential(4)}  at v=${worstV.toExponential(6)}`);
console.log(`  worst REL gap                           : ${worstRel.toExponential(4)}  at v=${worstRelV.toExponential(6)}`);

// ---- 2. does the served 4-dp figure agree? round(E*100, 4)
const round = (x, d) => { const p = Math.pow(10, d); return Math.round(x * p) / p; };
let diff4 = 0, firstDiff = null;
const K = 5000;
for (let i = 0; i < K; i++) {
  const v = Math.pow(10, -6 + (8 * i) / (K - 1));       // 1e-6 .. 1e2
  const a = round(expectedIlNumerical(v) * 100, 4), b = round(closed(v) * 100, 4);
  if (a !== b) { diff4++; if (!firstDiff) firstDiff = { v, a, b }; }
}
console.log(`  served round(.*100,4) differs on ${diff4} of ${K} v in [1e-6,1e2]`, firstDiff ? JSON.stringify(firstDiff) : '');

// ---- 3. spot values, printed so a reader can check by hand
console.log('\n  v            quadrature (%)         exp(-v/8)-1 (%)        gap');
for (const v of [1e-6, 0.01, 0.1, 1, 4, 9, 16, 25, 100, 116.0687404, 200, 1000]) {
  const a = expectedIlNumerical(v) * 100, b = closed(v) * 100;
  console.log(`  ${String(v).padEnd(12)} ${a.toFixed(10).padStart(20)} ${b.toFixed(10).padStart(22)}   ${Math.abs(a - b).toExponential(3)}`);
}

// ---- 4. the boundedness defect threshold, predicted analytically
// round(E*100,4) hits exactly -100 when E*100 > -100 requires exp(-v/8)*100 >= 0.00005
const vPred = -8 * Math.log(0.00005 / 100);
console.log(`\n  boundedness-defect threshold predicted from the closed form: v = -8*ln(5e-7) = ${vPred.toFixed(7)}`);
console.log(`  investigator MEASURED the engine's threshold at            v = 116.0687404`);

// ---- 5. breakeven in closed form: E[IL](v) = -fee  =>  v = -8 ln(1-fee). No bisection.
function breakevenVarianceExact(feeFrac) {                 // verbatim copy
  if (!(feeFrac > 0)) return 0;
  if (feeFrac >= 1) return null;
  let lo = 0, hi = 1;
  while (expectedIlNumerical(hi) > -feeFrac) { hi *= 2; if (hi > 1e4) return null; }
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (expectedIlNumerical(mid) > -feeFrac) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const bkClosed = (fee) => -8 * Math.log(1 - fee);
console.log('\n  fee          bisection v*            -8 ln(1-fee)            rel gap      sigma agree to 5dp?');
let sigmaDiff = 0, tested = 0;
for (const fee of [1e-6, 1e-4, 0.001, 0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.9, 0.99]) {
  const a = breakevenVarianceExact(fee), b = bkClosed(fee);
  const T = 304;
  const sa = Math.sqrt(a / T), sb = Math.sqrt(b / T);
  const ok = round(sa, 5) === round(sb, 5);
  tested++; if (!ok) sigmaDiff++;
  console.log(`  ${String(fee).padEnd(12)} ${a.toFixed(12).padStart(20)} ${b.toFixed(12).padStart(22)}   ${(Math.abs(a - b) / b).toExponential(2)}   ${ok ? 'yes' : 'NO  ' + round(sa, 5) + ' vs ' + round(sb, 5)}`);
}
console.log(`  5-dp sigma disagreements: ${sigmaDiff} of ${tested}`);

// ---- 6. count transcendentals: engine vs closed form, instrumented not inferred
let nExp = 0, nSqrt = 0;
const RE = Math.exp, RS = Math.sqrt, RL = Math.log;
Math.exp = (x) => { nExp++; return RE(x); };
Math.sqrt = (x) => { nSqrt++; return RS(x); };
breakevenVarianceExact(0.05);
const engineCalls = { exp: nExp, sqrt: nSqrt };
nExp = 0; nSqrt = 0; let nLog = 0;
Math.log = (x) => { nLog++; return RL(x); };
bkClosed(0.05);
Math.exp = RE; Math.sqrt = RS; Math.log = RL;
console.log(`\n  transcendentals for ONE breakeven solve: engine ${engineCalls.exp} exp + ${engineCalls.sqrt} sqrt = ${engineCalls.exp + engineCalls.sqrt}`);
console.log(`                                     closed form ${nExp} exp + ${nSqrt} sqrt + ${nLog} log = ${nExp + nSqrt + nLog}`);
