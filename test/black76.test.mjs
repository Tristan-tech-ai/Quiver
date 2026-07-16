// Locks the CORE options math to model-free invariants. If any of these breaks, a probability or greek
// we serve is wrong — and these are the checks a quant reviewer runs first. Nothing here depends on live
// data; they are identities that must hold for ANY inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { black76, probAbove, probAboveSmile, rndDensity, rndDistribution, probTouchAbove, probTouchBelow, atmForwardIv } from '../src/engine/black76.js';

const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: |${a} - ${b}| = ${Math.abs(a - b)} > ${tol}`);
const F = 64000, T = 30 / 365;

test('put-call parity is exact (model-free): C − P = e^{-rT}(F − K)', () => {
  for (const r of [0, 0.03, 0.08]) for (const K of [55000, 64000, 72000]) for (const sig of [0.4, 0.8]) {
    const c = black76(F, K, T, sig, 'call', r).price;
    const p = black76(F, K, T, sig, 'put', r).price;
    approx(c - p, Math.exp(-r * T) * (F - K), 1e-6, `parity r=${r} K=${K} σ=${sig}`);
  }
});

test('put-call delta parity: Δc − Δp = e^{-rT}', () => {
  for (const r of [0, 0.05]) for (const K of [58000, 64000, 70000]) {
    const g = black76(F, K, T, 0.6, 'call', r), h = black76(F, K, T, 0.6, 'put', r);
    approx(g.delta - h.delta, Math.exp(-r * T), 1e-9, `delta parity r=${r} K=${K}`);
  }
});

test('greeks obey their sign/bound invariants', () => {
  for (const K of [55000, 64000, 73000]) for (const type of ['call', 'put']) {
    const g = black76(F, K, T, 0.6, type, 0);
    assert.ok(g.gamma >= 0, 'gamma ≥ 0');
    assert.ok(g.vega >= 0, 'vega ≥ 0');
    if (type === 'call') assert.ok(g.delta >= 0 && g.delta <= 1, 'call delta ∈ [0,1]');
    else assert.ok(g.delta >= -1 && g.delta <= 0, 'put delta ∈ [-1,0]');
    assert.ok(g.theta <= 1e-9, 'theta ≤ 0 for a long option (r=0)');
  }
});

test('gamma and vega are identical for call and put at the same strike', () => {
  const c = black76(F, 65000, T, 0.6, 'call', 0), p = black76(F, 65000, T, 0.6, 'put', 0);
  approx(c.gamma, p.gamma, 1e-12, 'gamma call=put');
  approx(c.vega, p.vega, 1e-12, 'vega call=put');
});

test('ATM call delta ≈ 0.5 and deep ITM→1 / deep OTM→0', () => {
  approx(black76(F, F, T, 0.6, 'call', 0).delta, 0.5, 0.05, 'ATM ≈ 0.5');
  assert.ok(black76(F, F * 0.3, T, 0.6, 'call', 0).delta > 0.98, 'deep ITM → 1');
  assert.ok(black76(F, F * 3, T, 0.6, 'call', 0).delta < 0.02, 'deep OTM → 0');
});

test('call price is decreasing in K, put price increasing in K (no calendar/strike arb)', () => {
  let prevC = Infinity, prevP = -Infinity;
  for (let K = 50000; K <= 80000; K += 2000) {
    const c = black76(F, K, T, 0.6, 'call', 0).price, p = black76(F, K, T, 0.6, 'put', 0).price;
    assert.ok(c <= prevC + 1e-6, `call decreasing at K=${K}`); prevC = c;
    assert.ok(p >= prevP - 1e-6, `put increasing at K=${K}`); prevP = p;
  }
});

test('probAbove is a valid CDF-complement: ∈[0,1], strictly decreasing in K', () => {
  let prev = 1.0001;
  for (let K = 45000; K <= 90000; K += 2500) {
    const p = probAbove(F, K, T, 0.6, 0);
    assert.ok(p >= 0 && p <= 1, `∈[0,1] at K=${K}`);
    assert.ok(p <= prev + 1e-9, `decreasing at K=${K}`); prev = p;
  }
});

test('★ probAboveSmile matches an INDEPENDENT numerical −e^{rT}·dC/dK on a skewed smile (the BL fix)', () => {
  // Realistic BTC put-skew smile.
  const smile = [[56000, .46], [60000, .40], [62000, .365], [64000, .335], [66000, .32], [68000, .322], [70000, .335], [74000, .37]].map(([strike, iv]) => ({ strike, iv }));
  const ivFn = (K) => { const a = atmForwardIv(smile, K); return a && a.iv; };
  const call = (K) => black76(F, K, T, ivFn(K), 'call', 0).price;
  for (const K of [60000, 62000, 64000, 66000, 68000, 70000]) {
    const h = K * 0.0004;
    const numerical = -(call(K + h) - call(K - h)) / (2 * h); // r=0
    const analytic = probAboveSmile(F, K, T, ivFn, 0);
    approx(analytic, numerical, 0.003, `BL at K=${K}`); // within 0.3pt of the independent method
  }
});

test('probAboveSmile differs from plain N(d2) on a skewed smile (proves the smile term is applied)', () => {
  const smile = [[58000, .42], [62000, .36], [64000, .33], [66000, .315], [70000, .33]].map(([strike, iv]) => ({ strike, iv }));
  const ivFn = (K) => { const a = atmForwardIv(smile, K); return a && a.iv; };
  const K = 62000;
  const withSmile = probAboveSmile(F, K, T, ivFn, 0);
  const naive = probAbove(F, K, T, ivFn(K), 0);
  assert.ok(Math.abs(withSmile - naive) > 0.01, 'smile correction must move the number by >1pt on a real skew');
});

test('one-touch ≥ finish-in-the-money, and touch is bounded [0,1] with touch(H=F)=1', () => {
  for (const H of [66000, 70000, 78000]) {
    const touch = probTouchAbove(F, H, T, 0.6), finish = probAbove(F, H, T, 0.6, 0);
    assert.ok(touch >= finish - 1e-9, `touchAbove ≥ finish at H=${H}`);
    assert.ok(touch >= 0 && touch <= 1, 'touch ∈ [0,1]');
  }
  for (const L of [62000, 58000, 50000]) {
    const touch = probTouchBelow(F, L, T, 0.6), finish = 1 - probAbove(F, L, T, 0.6, 0);
    assert.ok(touch >= finish - 1e-9, `touchBelow ≥ finish at L=${L}`);
  }
  approx(probTouchAbove(F, F, T, 0.6), 1, 1e-9, 'touch(H=F)=1');
});

test('risk-neutral density from a FLAT smile is non-negative and integrates to ≈1', () => {
  const ivFn = () => 0.6; // constant vol → lognormal density, must be a proper density
  let integral = 0, minD = Infinity;
  const lo = F * 0.3, hi = F * 3.2, dK = (hi - lo) / 4000;
  for (let K = lo; K <= hi; K += dK) { const d = rndDensity(F, K, T, ivFn, 0); if (d == null) continue; if (d < minD) minD = d; integral += d * dK; }
  assert.ok(minD >= -1e-9, `density ≥ 0 (min ${minD})`);
  approx(integral, 1, 0.02, 'density integrates to 1');
});

// Second-order vol greeks: the analytic closed forms must equal the numerical derivatives of the
// first-order greeks. This is the ground truth — if vanna ≠ ∂vega/∂F or volga ≠ ∂vega/∂σ, the formula is
// wrong regardless of what any reference says.
const approxRel = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * (Math.abs(a) + 1e-12) + 1e-12, `${msg}: ${a} vs ${b}`);

test('★ vanna = ∂vega/∂F = 0.01·∂delta/∂σ (finite-difference verified)', () => {
  const r = 0.03, hF = F * 1e-4, hS = 1e-4;
  for (const K of [56000, 64000, 72000]) for (const sig of [0.4, 0.7]) {
    const g = black76(F, K, T, sig, 'call', r);
    const dVega_dF = (black76(F + hF, K, T, sig, 'call', r).vega - black76(F - hF, K, T, sig, 'call', r).vega) / (2 * hF);
    const dDelta_dSig = (black76(F, K, T, sig + hS, 'call', r).delta - black76(F, K, T, sig - hS, 'call', r).delta) / (2 * hS);
    approxRel(g.vanna, dVega_dF, 1e-3, `vanna=∂vega/∂F K=${K} σ=${sig}`);
    approxRel(g.vanna, dDelta_dSig * 0.01, 1e-3, `vanna=0.01·∂delta/∂σ K=${K} σ=${sig}`);
  }
});

test('★ volga (vomma) = ∂vega/∂σ (finite-difference verified); volga ≥ 0 where d1·d2 > 0', () => {
  const r = 0.03, hS = 1e-4;
  for (const K of [56000, 64000, 72000]) for (const sig of [0.4, 0.7]) {
    const g = black76(F, K, T, sig, 'call', r);
    const dVega_dSig = (black76(F, K, T, sig + hS, 'call', r).vega - black76(F, K, T, sig - hS, 'call', r).vega) / (2 * hS);
    approxRel(g.volga, dVega_dSig * 0.01, 2e-3, `volga=∂vega/∂σ K=${K} σ=${sig}`);
    if (g.d1 * g.d2 > 0) assert.ok(g.volga >= -1e-12, `volga ≥ 0 where d1·d2>0 (K=${K})`);
  }
});

test('vanna and volga are put/call-identical (they are strike/vol curvature, not direction)', () => {
  for (const K of [58000, 64000, 71000]) {
    const c = black76(F, K, T, 0.6, 'call', 0.02), p = black76(F, K, T, 0.6, 'put', 0.02);
    approx(c.vanna, p.vanna, 1e-12, `vanna call=put K=${K}`);
    approx(c.volga, p.volga, 1e-12, `volga call=put K=${K}`);
  }
});

test('★ RND distribution: mass≈1, martingale mean≈F, monotone quantiles, lognormal shape (flat smile)', () => {
  const sig = 0.6, ivFn = () => sig;
  const d = rndDistribution(F, T, ivFn, 0);
  assert.ok(d, 'distribution computed on a flat smile');
  approx(d.mass, 1, 0.02, 'density integrates to ≈1');
  // martingale property under the forward measure: E[S_T] = F. This is the load-bearing correctness check.
  assert.ok(Math.abs(d.meanVsForwardPct) < 0.5, `E[S_T]≈F (got ${d.meanVsForwardPct}% off)`);
  const q = d.quantiles;
  assert.ok(q.p05 < q.p25 && q.p25 < q.p50 && q.p50 < q.p75 && q.p75 < q.p95, 'quantiles strictly increasing');
  // lognormal terminal price: median = F·e^{-σ²T/2}, right-skewed with positive excess kurtosis.
  approx(q.p50, F * Math.exp(-0.5 * sig * sig * T), F * 0.01, 'median matches lognormal');
  assert.ok(d.skew > 0, 'lognormal RND is right-skewed');
  assert.ok(d.excessKurtosis > 0, 'lognormal RND is leptokurtic');
  // tail expected shortfalls sit beyond the 5/95 quantiles.
  assert.ok(d.es.left5 < q.p05 && d.es.right5 > q.p95, 'ES tails are beyond the quantiles');
});
