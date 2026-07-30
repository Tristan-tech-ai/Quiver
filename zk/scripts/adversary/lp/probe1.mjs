// PROBE — attack the "no closed form" framing on the quadrature and the bisection.
// Everything here is measured against the engine's own arithmetic, re-derived, never recalled.
import __P from '../paths.mjs';
const ENGINE = __P.vtUrl("src/engine/lpRisk.js");
const { lpRisk } = await import(ENGINE);

// ---- the engine's quadrature, copied verbatim from src/engine/lpRisk.js so the probe compares
//      against the same arithmetic (the engine does not export it).
const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);
function engineQuad(v) {
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
// Sanity: the copy must reproduce what the SERVICE serves, or nothing below means anything.
{
  const v = 0.05 * 0.05 * 30;
  const served = lpRisk({ volatility: 0.05, horizonPeriods: 30 }).expectedDivergence.expectedIlPct;
  const mine = engineQuad(v) * 100;
  console.log(`[0] quadrature copy fidelity: served ${served}  mine ${mine.toFixed(10)}  |gap| ${Math.abs(mine - Math.round(mine * 1e4) / 1e4).toExponential(2)}`);
  if (Math.round(mine * 1e4) / 1e4 !== served) throw new Error('copy does not reproduce the service');
}

// ================================================================================
// 1. THE GRID IS GEOMETRIC. 401 exponentials collapse to TWO plus a multiply chain.
//    z_i = -6 + 0.03 i, so  s_i := sqrt(r_i) = exp(-v/4 - 3 sd) * exp(0.015 sd)^i.
//    r_i = s_i^2. pdf_i does not depend on v at all — it is 401 compile-time constants.
// ================================================================================
const N = 400, LO = -6, HI = 6, H = (HI - LO) / N;   // H = 0.03
const PDF = Array.from({ length: N + 1 }, (_, i) => Math.exp(-0.5 * (LO + H * i) ** 2));
const W = PDF.reduce((a, b) => a + b, 0);

function geomQuad(v) {
  const sd = Math.sqrt(v);
  const s0 = Math.exp(-v / 4 + (LO / 2) * sd);   // exp(-v/4 - 3 sd)
  const p = Math.exp((H / 2) * sd);              // exp(0.015 sd)
  let s = s0, sum = 0;
  for (let i = 0; i <= N; i++) {
    const r = s * s;
    sum += PDF[i] * ((2 * s) / (1 + r) - 1);
    if (i < N) s *= p;
  }
  return sum / W;
}

console.log('\n=== 1. geometric-chain restatement of the 401-point quadrature ===');
console.log('    v            engine E[IL]        chain E[IL]         |gap|        exps used');
let worstGeom = 0, worstGeomV = 0;
for (const v of [1e-4, 0.01, 0.0625, 0.25, 1, 2.5, 5, 10, 40, 100]) {
  const a = engineQuad(v), b = geomQuad(v);
  const g = Math.abs(a - b);
  if (g > worstGeom) { worstGeom = g; worstGeomV = v; }
  console.log(`  ${String(v).padEnd(8)}  ${a.toFixed(15)}  ${b.toFixed(15)}  ${g.toExponential(2)}   2 vs 802`);
}
console.log(`  worst |gap| over the sampled v: ${worstGeom.toExponential(3)} at v=${worstGeomV}`);

// A denser sweep, because ten points is not a sweep.
{
  let w = 0, wv = 0, n = 0;
  for (let k = 1; k <= 4000; k++) {
    const v = Math.exp(Math.log(1e-6) + (k / 4000) * (Math.log(200) - Math.log(1e-6)));
    const g = Math.abs(engineQuad(v) - geomQuad(v));
    if (g > w) { w = g; wv = v; }
    n++;
  }
  console.log(`  dense sweep, ${n} log-spaced v in [1e-6, 200]: worst |gap| ${w.toExponential(3)} at v=${wv.toPrecision(6)}`);
}

// ================================================================================
// 2. IS E[IL](v) MONOTONE? The bracket certificate only pins a UNIQUE root if it is.
//    The engine's comment asserts monotone decreasing. Assertions are not measurements.
// ================================================================================
console.log('\n=== 2. monotonicity of E[IL](v), measured not assumed ===');
{
  let violations = 0, worstRise = 0, worstAt = 0, prev = null, prevV = null, n = 0;
  for (let k = 0; k <= 20000; k++) {
    const v = Math.exp(Math.log(1e-8) + (k / 20000) * (Math.log(1e4) - Math.log(1e-8)));
    const e = engineQuad(v);
    if (prev !== null) {
      const d = e - prev;                  // must be <= 0 for decreasing
      if (d > 0) { violations++; if (d > worstRise) { worstRise = d; worstAt = v; } }
    }
    prev = e; prevV = v; n++;
  }
  console.log(`  ${n} log-spaced v in [1e-8, 1e4]: ${violations} non-decreasing steps` +
    (violations ? `, worst rise ${worstRise.toExponential(3)} at v=${worstAt.toPrecision(6)}` : ''));
  console.log(`  E[IL](1e-8)=${engineQuad(1e-8).toExponential(4)}   E[IL](1e4)=${engineQuad(1e4).toFixed(12)}`);
}
// Where does it SATURATE? Past saturation the root is not unique in floating point.
{
  let satV = null;
  for (let k = 0; k <= 4000; k++) {
    const v = Math.exp(Math.log(1) + (k / 4000) * (Math.log(1e4) - Math.log(1)));
    if (engineQuad(v) <= -1 + 1e-12) { satV = v; break; }
  }
  console.log(`  first v where E[IL] is within 1e-12 of the -100% floor: ${satV === null ? 'none in [1,1e4]' : satV.toPrecision(6)}`);
  for (const v of [50, 100, 200, 500, 1000]) console.log(`    E[IL](${String(v).padEnd(5)}) = ${engineQuad(v).toFixed(15)}`);
}

// ================================================================================
// 3. THE BRACKET. What the engine returns is (lo+hi)/2 after 200 halvings of [0, hi0].
//    Certificate: g(lo) > 0 >= g(hi), hi - lo <= width, root in [lo, hi].
//    Cost: TWO quadrature evaluations instead of 200. Does the bracket actually pin
//    the served figure to the precision it is served at?
// ================================================================================
console.log('\n=== 3. bracket certificate for the bisection ===');
function bracketOf(feeFrac, iters) {
  if (!(feeFrac > 0)) return { lo: 0, hi: 0 };
  if (feeFrac >= 1) return null;
  let lo = 0, hi = 1, doublings = 0;
  while (engineQuad(hi) > -feeFrac) { hi *= 2; doublings++; if (hi > 1e4) return null; }
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    if (engineQuad(mid) > -feeFrac) lo = mid; else hi = mid;
  }
  return { lo, hi, doublings, root: (lo + hi) / 2 };
}
console.log('  feeFrac    doublings  hi-lo after 200      g(lo)>0        g(hi)<=0     served sigma matches?');
for (const [aprPct, T, ppy] of [[20, 30, 365], [0.001, 30, 365], [5, 1, 365], [80, 365, 365], [99.9, 365, 365], [200, 7, 365]]) {
  const feeFrac = (aprPct / 100) * (T / ppy);
  const br = bracketOf(feeFrac, 200);
  if (!br) { console.log(`  apr ${aprPct}% T=${T}: no bracket (feeFrac ${feeFrac.toFixed(6)}) — engine returns null too: ${lpRisk({ volatility: 0.1, horizonPeriods: T, periodsPerYear: ppy, feeAprPct: aprPct }).feeVsDivergence.breakevenVolatility}`); continue; }
  const gLo = engineQuad(br.lo) + feeFrac, gHi = engineQuad(br.hi) + feeFrac;
  const sigmaFromBracket = Math.sqrt(br.root / T);
  const served = lpRisk({ volatility: 0.1, horizonPeriods: T, periodsPerYear: ppy, feeAprPct: aprPct }).feeVsDivergence.breakevenVolatility;
  const roundedMatch = Math.round(sigmaFromBracket * 1e5) / 1e5 === served;
  console.log(`  ${String(feeFrac.toPrecision(4)).padEnd(10)} ${String(br.doublings).padEnd(10)} ${(br.hi - br.lo).toExponential(3).padEnd(20)} ${gLo.toExponential(2).padEnd(14)} ${gHi.toExponential(2).padEnd(12)} ${roundedMatch} (${sigmaFromBracket.toPrecision(8)} vs ${served})`);
}

// How WIDE can the bracket be and still pin the served 5-dp sigma? That decides whether the
// certificate has to carry 200 halvings or far fewer.
console.log('\n  how few halvings still pin the served 5-dp breakevenVolatility?');
for (const [aprPct, T, ppy] of [[20, 30, 365], [0.001, 30, 365], [80, 365, 365]]) {
  const feeFrac = (aprPct / 100) * (T / ppy);
  const served = lpRisk({ volatility: 0.1, horizonPeriods: T, periodsPerYear: ppy, feeAprPct: aprPct }).feeVsDivergence.breakevenVolatility;
  let need = null;
  for (let it = 1; it <= 200; it++) {
    const br = bracketOf(feeFrac, it);
    const loS = Math.sqrt(br.lo / T), hiS = Math.sqrt(br.hi / T);
    // the whole bracket must round to the served figure — otherwise it does not pin it
    if (Math.round(loS * 1e5) / 1e5 === served && Math.round(hiS * 1e5) / 1e5 === served) { need = it; break; }
  }
  console.log(`    apr ${String(aprPct).padEnd(6)} T=${String(T).padEnd(4)} served sigma ${served} -> ${need} halvings suffice (engine does 200)`);
}
