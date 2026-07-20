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

// ---------------------------------------------------------------------------------------------------
// REGRESSION LOCKS for four defects found live on 2026-07-17 against the shipped BTC surface.
// Every one was the same disease: a check that could not fail.
//   1. quadratic penalty on a one-sided constraint -> small violations were nearly free
//   2. butterfly min reported on the SAME grid the optimiser was penalised on -> unfalsifiable
//   3. no calendar coupling across slices -> w(k,T) crossed (14/470 nodes live)
//   4. arb verified on full-precision params, then ROUNDED params shipped -> guarantee not on the artifact
// ---------------------------------------------------------------------------------------------------

// Audit helpers deliberately use an OFFSET, DENSER grid than the fitter's penalty grid.
const auditGrid = (kBand = 0.35, n = 977, off = 0.0031) => {
  const g = []; for (let i = 0; i <= n; i++) g.push(-kBand + off + (2 * kBand - 2 * off) * i / n); return g;
};
const shippedP = (s) => ({ a: s.params.a, b: s.params.b, rho: s.params.rho, m: s.params.m, sig: s.params.sigma });

// The params below are the ACTUAL live BTC 3.8d fit (2026-07-17) that shipped with butterfly
// arbitrage: it reported butterflyMinG=+9.93e-8 on its own 12-node training grid while the true minimum
// was -1.69e-3 across k in [0.175,0.204] (4.2% of the band). A benign synthetic slice does NOT reproduce
// this — the fit must be driven ONTO the constraint boundary for the defect to appear. Locking the real case.
const LIVE_BTC_3D8 = { a: -0.002597, b: 0.0358, rho: 0.3629, m: 0.0649, sig: 0.1027 };

test('★ butterfly g(k)≥0 on an OFFSET DENSE grid for the SHIPPED params (real boundary-hugging slice)', () => {
  const T = 3.8 / 365, F = 63188;
  const slice = syntheticSlice(T, F, LIVE_BTC_3D8);
  const fit = fitSVI([slice], { minTdays: 1 });
  const s = fit.perSlice[0];
  // The contract is conditional: we may REJECT this slice (honest) — but we must never ACCEPT it with arb.
  if (s.ok) {
    let minG = Infinity;
    for (const k of auditGrid()) minG = Math.min(minG, sviG(k, shippedP(s)));
    assert.ok(minG >= 0, );
  }
  assert.ok(true);
});

test('★ the FITTED ANCHORS are calendar-ordered: w(k,T) non-decreasing in T for the SHIPPED params', () => {
  // Two slices whose independent best fits would cross at the wing unless the fitter couples them in T.
  const slices = [
    syntheticSlice(4 / 365, 64000, { a: 0.0004, b: 0.030, rho: 0.30, m: 0.05, sig: 0.09 }),
    syntheticSlice(14 / 365, 64000, { a: 0.0009, b: 0.034, rho: -0.10, m: 0.01, sig: 0.12 }),
  ];
  const fit = fitSVI(slices, { minTdays: 1 });
  const ok = fit.perSlice.filter((s) => s.ok);
  assert.ok(ok.length >= 2, 'both slices accepted');
  let worst = Infinity;
  for (const k of auditGrid()) worst = Math.min(worst, sviW(k, shippedP(ok[1])) - sviW(k, shippedP(ok[0])));
  assert.ok(worst >= 0, `w(k,T2) ≥ w(k,T1) must hold at every k, worst Δw=${worst.toExponential(3)}`);
  // and the fitter must SAY so, on the artifact it ships
  assert.ok(ok[1].calendarOk, 'fitter reports calendarOk for the later slice');
  assert.ok(ok[1].calendarMinDw >= 0, `reported calendarMinDw ≥ 0 (${ok[1].calendarMinDw})`);
});

test('★ a slice that cannot be fitted arbitrage-free is REJECTED, never shipped with arbitrage', () => {
  const T = 7 / 365, F = 64000;
  const slice = syntheticSlice(T, F, { a: 0.0009, b: 0.05, rho: -0.35, m: 0.0, sig: 0.08 });
  const fit = fitSVI([slice], { minTdays: 1 });
  for (const s of fit.perSlice) {
    if (!s.ok || s.excluded) continue;
    // invariant: anything marked ok MUST be arb-free on the shipped params, audited off-grid
    let minG = Infinity;
    for (const k of auditGrid()) minG = Math.min(minG, sviG(k, shippedP(s)));
    assert.ok(minG >= 0, 'an ACCEPTED slice is arbitrage-free on the shipped params');
    assert.ok(s.wingBoundOk, 'an ACCEPTED slice satisfies the wing bound');
  }
});
