// Locks the SVI arbitrage-free guarantee: an ACCEPTED slice must produce a non-negative risk-neutral
// density (no butterfly arbitrage) and satisfy the Gatheral–Jacquier g(k)≥0 and Roger-Lee wing bound.
// This is the guarantee we advertise; a test proves it rather than asserting it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sviW, sviG, fitSVI, sviIvFn, sviIvFnAtT } from '../src/engine/ssvi.js';
import { rndDensity, probAboveSmile, black76 } from '../src/engine/black76.js';

// Build a synthetic but realistic skewed slice from an SVI ground-truth, then re-fit it.
function syntheticSlice(T, F, Ptrue) {
  const pts = [];
  for (let k = -0.30; k <= 0.30 + 1e-9; k += 0.03) {
    const w = sviW(k, Ptrue);
    if (w > 0) pts.push({ k, sigma: Math.sqrt(w / T) });
  }
  return { T, F, theta: sviW(0, Ptrue), pts };
}

test('sviG (butterfly g(k)) is ≥ 0 for a benign parameter set across all k', () => {
  const P = { a: 0.002, b: 0.04, rho: -0.3, m: 0.0, sig: 0.1 };
  for (let k = -0.5; k <= 0.5; k += 0.02) assert.ok(sviG(k, P) >= -1e-9, `g(${k.toFixed(2)}) ≥ 0`);
});

test('fitSVI recovers a skewed slice: converges, low RMSE, butterfly + wing-bound satisfied', () => {
  const T = 7 / 365, F = 64000;
  const slice = syntheticSlice(T, F, { a: 0.0009, b: 0.05, rho: -0.35, m: 0.0, sig: 0.08 });
  const fit = fitSVI([slice], { minTdays: 1 });
  const s = fit.perSlice[0];
  assert.ok(s.ok, `slice fitted (${s.reason || ''})`);
  assert.ok(s.rmseVolPts <= 1.5, `RMSE ${s.rmseVolPts} ≤ 1.5 vol pts`);
  assert.ok(s.butterflyMinG >= -1e-6, `min g(k) ≥ 0 (${s.butterflyMinG})`);
  assert.ok(s.wingBoundOk, 'Roger-Lee wing bound b(1+|ρ|)<2 holds');
});

test('★ an accepted SVI fit yields a NON-NEGATIVE density (the arbitrage-free guarantee)', () => {
  const T = 7 / 365, F = 64000;
  const slice = syntheticSlice(T, F, { a: 0.001, b: 0.055, rho: -0.4, m: 0.0, sig: 0.07 });
  const fit = fitSVI([slice], { minTdays: 1 });
  assert.ok(fit.perSlice[0].ok, 'fit accepted');
  const ivFn = sviIvFn(fit, F, T);
  assert.ok(ivFn, 'ivFn available for the fitted slice');
  let negs = 0, n = 0;
  for (let K = F * 0.75; K <= F * 1.30; K += F * 0.004) { const d = rndDensity(F, K, T, ivFn, 0); if (d == null) continue; n += 1; if (d < -1e-9) negs += 1; }
  assert.equal(negs, 0, `no negative density across ${n} grid points`);
});

test('the fitted-smile CDF (probAboveSmile) is monotone decreasing and bounded', () => {
  const T = 7 / 365, F = 64000;
  const fit = fitSVI([syntheticSlice(T, F, { a: 0.001, b: 0.05, rho: -0.3, m: 0, sig: 0.08 })], { minTdays: 1 });
  const ivFn = sviIvFn(fit, F, T);
  let prev = 1.0001;
  for (let K = F * 0.8; K <= F * 1.25; K += F * 0.01) {
    const p = probAboveSmile(F, K, T, ivFn, 0);
    assert.ok(p >= 0 && p <= 1, `∈[0,1] at K=${K}`);
    assert.ok(p <= prev + 1e-6, `decreasing at K=${K}`); prev = p;
  }
});

test('near-expiry slices are EXCLUDED by design (jump-dominated, not force-fitted)', () => {
  const F = 64000;
  const near = syntheticSlice(0.5 / 365, F, { a: 0.0002, b: 0.05, rho: -0.3, m: 0, sig: 0.08 }); // ~12h
  const fit = fitSVI([near], { minTdays: 1.5 });
  assert.equal(fit.perSlice[0].ok, false);
  assert.ok(fit.perSlice[0].excluded, 'flagged as excluded, not silently fitted');
});

test('★ sviIvFnAtT interpolates total variance CALENDAR-arbitrage-free (w=σ²T non-decreasing in T)', () => {
  const Fx = 64000;
  // Two hand-built arbitrage-free slices with w2(k) ≥ w1(k) ∀k (no calendar arb between them).
  const fit = { perSlice: [
    { ok: true, T: 0.05, params: { a: 0.010, b: 0.040, rho: 0, m: 0, sigma: 0.20 } },
    { ok: true, T: 0.15, params: { a: 0.020, b: 0.080, rho: 0, m: 0, sigma: 0.20 } },
  ] };
  // At a fixed strike, total variance w(T)=σ(K,T)²·T must be monotone non-decreasing across T.
  for (const K of [58000, 64000, 70000]) {
    let prevW = -Infinity;
    for (const T of [0.05, 0.07, 0.10, 0.13, 0.15]) {
      const r = sviIvFnAtT(fit, Fx, T);
      const sig = r.fn(K);
      assert.ok(sig > 0, `σ defined at K=${K} T=${T}`);
      const w = sig * sig * T;
      assert.ok(w >= prevW - 1e-9, `total variance non-decreasing in T at K=${K} (T=${T}: ${w} < ${prevW})`);
      prevW = w;
    }
  }
  // Basis flags: inside the range → interpolated; outside → flat-extrapolated (disclosed).
  assert.equal(sviIvFnAtT(fit, Fx, 0.10).basis, 'interpolated');
  assert.equal(sviIvFnAtT(fit, Fx, 0.03).basis, 'flat-extrapolated');
  assert.equal(sviIvFnAtT(fit, Fx, 0.30).basis, 'flat-extrapolated');
});
