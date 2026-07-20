// Locks the Martingale-OT bound engine. The two self-checks below are EXACT identities that any correct
// martingale-transport LP must satisfy for ANY marginals — so they can fail, and they did: on 2026-07-17
// they caught a broken LP (same grid for μ and ν makes the extreme atoms of μ untransportable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motBounds, convexOrderExact, marginalX } from '../src/engine/mot.js';

// two slices in strict convex order (w increasing in T at every k)
const P1 = { a: 0.0009, b: 0.030, rho: -0.20, m: 0.0, sig: 0.09 };
const P2 = { a: 0.0035, b: 0.055, rho: -0.20, m: 0.0, sig: 0.13 };
const F1 = 63000, T1 = 4 / 365, F2 = 63100, T2 = 18 / 365;

test('★ MOT: a payoff depending only on Y is coupling-independent (sup = inf = E_ν[Y] = 1)', () => {
  const r = motBounds(P1, F1, T1, P2, F2, T2, (x, y) => y);
  assert.ok(r.ok, `bounds returned (${r.reason || ''})`);
  assert.ok(r.selfChecks.marginalConsistency, 'sup and inf of a Y-only payoff both equal E_ν[Y]');
  assert.ok(Math.abs(r.lower - 1) < 1e-6 && Math.abs(r.upper - 1) < 1e-6, `both bounds = 1 (got [${r.lower}, ${r.upper}])`);
});

test('★ MOT: the martingale property holds exactly — sup E[Y − X] = 0', () => {
  const r = motBounds(P1, F1, T1, P2, F2, T2, (x, y) => y - x);
  assert.ok(r.ok, 'bounds returned');
  assert.ok(r.selfChecks.martingaleProperty, 'E[Y−X] = 0 under every admissible coupling');
  assert.ok(Math.abs(r.upper) < 1e-6, `sup E[Y−X] = 0 (got ${r.upper})`);
});

test('★ MOT: a genuinely coupling-dependent payoff yields a NON-DEGENERATE band that brackets both bounds', () => {
  const r = motBounds(P1, F1, T1, P2, F2, T2, (x, y) => Math.max(y - x, 0));
  assert.ok(r.ok, 'bounds returned');
  assert.ok(r.lower >= 0, 'a call payoff cannot be negatively priced');
  assert.ok(r.upper > r.lower, `the model-free band is non-degenerate (got [${r.lower}, ${r.upper}])`);
  assert.ok(r.width > 0 && r.width < 1, 'band width is finite and sane');
});

test('★ MOT REFUSES when convex order fails (Strassen): no martingale coupling ⇒ no arbitrage-free price', () => {
  // deliberately invert the pair: the LATER marginal has LESS total variance -> calendar arbitrage
  const r = motBounds(P2, F2, T2, P1, F1, T1, (x, y) => Math.max(y - x, 0));
  assert.equal(r.ok, false, 'must not return a price');
  assert.equal(r.refused, true, 'must refuse explicitly');
  assert.ok(/convex order|Strassen|calendar/i.test(r.reason), 'refusal names the actual reason');
  assert.ok(r.convexOrder.minDw < 0, 'reports the measured violation');
});

test('convexOrderExact agrees with the calendar condition it encodes (w non-decreasing in T)', () => {
  const good = convexOrderExact(P1, P2);
  assert.ok(good.ok && good.minDw >= 0, 'ordered pair passes');
  const bad = convexOrderExact(P2, P1);
  assert.ok(!bad.ok && bad.minDw < 0, 'inverted pair fails, with the violating k reported');
  assert.ok(Number.isFinite(bad.atK), 'the violating log-moneyness is reported');
});

test('marginalX produces a normalised martingale marginal (mass 1, mean 1)', () => {
  const m = marginalX(P1, F1, T1);
  assert.ok(m, 'marginal built');
  const mass = m.p.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(mass - 1) < 1e-9, `mass = 1 (got ${mass})`);
  assert.ok(Math.abs(m.mean - 1) < 1e-9, `E[X] = 1 (got ${m.mean})`);
});
