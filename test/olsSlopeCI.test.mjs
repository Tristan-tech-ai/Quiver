// Kyle-λ confidence interval (opening #5, the HONEST version — token-scan's heuristic wash-share is NOT a
// CI target, but the λ OLS slope is). olsSlopeCI is new → FAILS on pre-fix code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { olsSlopeCI } from '../src/engine/stats.js';

test('olsSlopeCI: clean linear signal → tight CI that EXCLUDES zero', () => {
  const xs = [], ys = [];
  for (let i = 0; i < 40; i++) { xs.push(i); ys.push(2 * i + (i % 2 ? 0.01 : -0.01)); } // slope 2, tiny noise
  const r = olsSlopeCI(xs, ys);
  assert.ok(Math.abs(r.slope - 2) < 0.01, `slope ${r.slope} ≈ 2`);
  assert.equal(r.excludesZero, true);
  assert.ok(r.ciLo > 0 && r.ciHi > 0, 'both bounds positive');
  assert.ok(r.r2 > 0.99);
});

test('olsSlopeCI: pure noise → CI SPANS zero (impact indeterminate)', () => {
  // deterministic pseudo-noise, no real x→y relationship
  const xs = [], ys = [];
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  for (let i = 0; i < 40; i++) { xs.push(rnd()); ys.push(rnd()); }
  const r = olsSlopeCI(xs, ys);
  assert.equal(r.excludesZero, false, 'noise must not produce a significant slope');
  assert.ok(r.ciLo < 0 && r.ciHi > 0, 'CI must straddle zero');
});

test('olsSlopeCI: wider noise widens the CI (SE grows with residual variance)', () => {
  const xs = Array.from({ length: 30 }, (_, i) => i);
  const tight = olsSlopeCI(xs, xs.map((x) => x + (x % 2 ? 0.1 : -0.1)));
  const loose = olsSlopeCI(xs, xs.map((x) => x + (x % 2 ? 5 : -5)));
  assert.ok(loose.se > tight.se, `looser fit must have larger SE (${loose.se} > ${tight.se})`);
});

test('olsSlopeCI: degenerate inputs return null (no x-variance / too few points)', () => {
  assert.equal(olsSlopeCI([1, 1, 1, 1], [1, 2, 3, 4]), null, 'no x-variance');
  assert.equal(olsSlopeCI([1, 2], [1, 2]), null, 'n<3');
});
