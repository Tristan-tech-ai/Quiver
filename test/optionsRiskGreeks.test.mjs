// Regression lock for the options-risk verifier-coverage fix: the engine reports SIX greeks
// (delta, gamma, vega, vanna, volga, theta) but the pre-fix code finite-difference-checked only TWO
// (delta, gamma) — so a wrong vega/vanna/volga/theta shipped silently (a "verifier that cannot fail").
// These tests FAIL on the pre-fix code (which returns checks.length === 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsRisk } from '../src/engine/optionsRisk.js';

const book = {
  forward: 60000,
  positions: [
    { type: 'call', strike: 62000, expiryDays: 7, iv: 0.65, quantity: 3 },
    { type: 'put', strike: 58000, expiryDays: 7, iv: 0.70, quantity: -2 },
    { type: 'call', strike: 65000, expiryDays: 30, iv: 0.60, quantity: -1 },
    { type: 'put', strike: 55000, expiryDays: 30, iv: 0.72, quantity: 1 },
  ],
};
const GREEKS = ['delta', 'gamma', 'vega', 'vanna', 'volga', 'theta'];

test('options-risk self-checks ALL SIX greeks, not just delta+gamma (fails on pre-fix code)', () => {
  const r = optionsRisk(book);
  assert.ok(r.ok, 'engine ran');
  assert.equal(r.checks.length, 6, 'every reported greek must carry a finite-difference self-check');
  for (const g of GREEKS) {
    const c = r.checks.find((x) => x.name.startsWith(g + ' '));
    assert.ok(c, `missing self-check for ${g}`);
    assert.ok(Number.isFinite(c.residual) && Number.isFinite(c.tolerance) && c.tolerance > 0, `${g} check must be a real FD comparison, not a stub`);
    assert.equal(c.pass, true, `${g} self-check must pass on a correct book (res ${c.residual} > tol ${c.tolerance})`);
  }
});

test('options-risk second-order vol greeks (vega/vanna/volga/theta) DISCRIMINATE — residual ≪ tolerance', () => {
  const r = optionsRisk(book);
  // A discriminating check has residual well below tolerance (analytic == FD to high precision); a loose
  // rubber-stamp would sit near tolerance. This confirms the new checks would actually catch a wrong greek.
  for (const g of ['vega', 'vanna', 'volga', 'theta']) {
    const c = r.checks.find((x) => x.name.startsWith(g + ' '));
    assert.ok(c.residual < c.tolerance, `${g}: residual ${c.residual} must be < tolerance ${c.tolerance}`);
  }
});
