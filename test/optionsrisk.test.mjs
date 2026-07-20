import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsRisk } from '../src/engine/optionsRisk.js';

const F = 64000;
const leg = (type, strike, quantity, iv = 0.6) => ({ type, strike, expiryDays: 30, iv, quantity });

test('options-risk: synthetic forward (+call −put same strike) => delta 1, gamma 0 (put-call parity lock)', () => {
  const r = optionsRisk({ forward: F, positions: [leg('call', F, 1), leg('put', F, -1)] });
  assert.ok(Math.abs(r.greeks.delta - 1) < 1e-4, `delta=${r.greeks.delta}`);
  assert.ok(Math.abs(r.greeks.gamma) < 1e-6, `gamma=${r.greeks.gamma}`);
  assert.ok(r.checks.every((c) => c.pass), 'FD self-checks must pass');
});

test('options-risk: short straddle => negative gamma, positive theta, negative vega, positive margin', () => {
  const r = optionsRisk({ forward: F, positions: [leg('call', F, -1), leg('put', F, -1)] });
  assert.ok(r.greeks.gamma < 0, `gamma=${r.greeks.gamma}`);
  assert.ok(r.greeks.theta > 0, `theta=${r.greeks.theta}`);
  assert.ok(r.greeks.vega < 0, `vega=${r.greeks.vega}`);
  assert.ok(r.spanMargin.requirement > 0);
});

test('options-risk: FD self-checks pass on a mixed book (analytic greeks == numerical derivatives)', () => {
  const r = optionsRisk({ forward: F, positions: [leg('call', 60000, 2, 0.62), leg('put', 66000, -1, 0.59), leg('call', 70000, -1, 0.57)] });
  const d = r.checks.find((c) => c.name.startsWith('delta'));
  const g = r.checks.find((c) => c.name.startsWith('gamma'));
  assert.ok(d.pass, `delta residual ${d.residual} > tol ${d.tolerance}`);
  assert.ok(g.pass, `gamma residual ${g.residual} > tol ${g.tolerance}`);
});

test('options-risk: SPAN worst scenario for a short straddle is a large underlying move', () => {
  const r = optionsRisk({ forward: F, positions: [leg('call', F, -1), leg('put', F, -1)] });
  assert.ok(Math.abs(r.spanMargin.worstScenario.underlyingMovePct) >= 10);
});

test('options-risk: per-position forwards supported (multi-expiry book), self-checks still hold', () => {
  const r = optionsRisk({ positions: [
    { type: 'call', strike: 64000, expiryDays: 7, iv: 0.7, quantity: 1, forward: 63800 },
    { type: 'put', strike: 64000, expiryDays: 60, iv: 0.6, quantity: 1, forward: 64500 },
  ] });
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.pass));
});

test('options-risk: rejects a position with no forward (no shared, none per-position) — no fabrication', () => {
  const r = optionsRisk({ positions: [leg('call', F, 1)] });
  assert.equal(r.ok, false);
});
