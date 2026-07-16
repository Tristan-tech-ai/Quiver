// Locks the variance-risk-premium estimator: recovers a known ratio, computes the honest significance at
// the EFFECTIVE sample (not the inflated overlapping-pair count), and refuses to fabricate on thin data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realizedVolPct, estimateVrp, realWorldVol } from '../src/engine/vrp.js';

const DAY = 86400000;
const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: |${a}-${b}| > ${tol}`);

test('realizedVolPct is 0 for a flat series and rises with dispersion', () => {
  const flat = Array(40).fill(100);
  assert.ok((realizedVolPct(flat) || 0) < 1e-6, 'flat → ~0 vol');
  const wiggly = Array.from({ length: 40 }, (_, i) => 100 * (1 + (i % 2 ? 0.02 : -0.02)));
  assert.ok(realizedVolPct(wiggly) > 10, 'alternating ±2% → high annualized vol');
});

test('realizedVolPct returns null on too-little data (no fabrication)', () => {
  assert.equal(realizedVolPct([100, 101, 102]), null);
});

test('estimateVrp recovers a known premium: if realized ≈ 0.8×implied, ratioUsed ≈ 0.8', () => {
  // Construct a spot path whose forward 30d realized vol is a known fraction of a constant DVOL.
  // Easiest faithful construction: constant daily log-return magnitude → constant realized vol.
  const ivConst = 60; // DVOL 60%
  const targetRatio = 0.8;
  const rvTarget = ivConst * targetRatio; // 48%
  const dailySigma = (rvTarget / 100) / Math.sqrt(365); // per-day stdev of log-returns
  const now = Date.UTC(2026, 0, 1);
  const spot = [], dvol = [];
  let p = 1000;
  for (let i = 0; i < 200; i++) {
    const ts = now + i * DAY;
    // deterministic ±dailySigma zig-zag → sample stdev ≈ dailySigma
    p = p * Math.exp((i % 2 ? 1 : -1) * dailySigma);
    spot.push({ ts, c: p });
    dvol.push({ ts, iv: ivConst });
  }
  const vrp = estimateVrp(dvol, spot, 30);
  assert.ok(vrp, 'vrp fitted');
  approx(vrp.ratioRvToIv, targetRatio, 0.06, 'median ratio ≈ target');
  assert.ok(vrp.sample.effectiveIndependent < vrp.sample.pairs, 'effective n < pair count (overlap acknowledged)');
});

test('estimateVrp reports significance honestly (p-value present, boolean gate)', () => {
  const now = Date.UTC(2026, 0, 1);
  const spot = [], dvol = [];
  let p = 1000; const ds = 0.4 / Math.sqrt(365);
  for (let i = 0; i < 200; i++) { p *= Math.exp((i % 2 ? 1 : -1) * ds); spot.push({ ts: now + i * DAY, c: p }); dvol.push({ ts: now + i * DAY, iv: 60 }); }
  const vrp = estimateVrp(dvol, spot, 30);
  assert.ok(vrp.significance && typeof vrp.significance.pValue === 'number', 'p-value computed');
  assert.ok(typeof vrp.significance.significantAt05 === 'boolean', 'significance is a boolean gate');
  assert.ok(vrp.significance.pValue >= 0 && vrp.significance.pValue <= 1, 'p ∈ [0,1]');
});

test('estimateVrp returns null on too-little history', () => {
  assert.equal(estimateVrp([{ ts: 0, iv: 50 }], [{ ts: 0, c: 100 }], 30), null);
});

test('realWorldVol scales implied vol by the fitted ratio', () => {
  approx(realWorldVol(0.60, { ratioUsed: 0.85 }), 0.51, 1e-9, 'scale');
  approx(realWorldVol(0.60, null), 0.60, 1e-9, 'no vrp → unchanged');
});
