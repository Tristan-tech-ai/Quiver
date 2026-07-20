import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perpGate } from '../src/engine/perpGate.js';

// Hand-verified ground truth (see engine header + the derivation check):
// BTC 40x (mmr=0.0125), entry 100000, size 1, margin 2500 -> long liq 98734.18, short liq 101234.57.

test('perp-gate: long liq price matches hand-derived value (locks the formula)', () => {
  const r = perpGate({ side: 'long', entryPrice: 100000, size: 1, margin: 2500, maxLeverage: 40 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.liquidationPrice - 98734.18) < 0.02, `got ${r.liquidationPrice}, expected ~98734.18`);
  // The WRONG search-summary formula gives 97468.35 — this assertion provably fails if that creeps back in.
  assert.ok(Math.abs(r.liquidationPrice - 97468.35) > 100, 'must NOT equal the summary-formula (maint-ignoring) value');
});

test('perp-gate: short liq price matches hand-derived value', () => {
  const r = perpGate({ side: 'short', entryPrice: 100000, size: 1, margin: 2500, maxLeverage: 40 });
  assert.ok(Math.abs(r.liquidationPrice - 101234.57) < 0.02, `got ${r.liquidationPrice}`);
});

test('perp-gate: the liquidation-invariant self-check passes and residual is ~0', () => {
  const r = perpGate({ side: 'long', entryPrice: 63000, size: 0.5, margin: 900, maxLeverage: 40 });
  const check = r.checks.find((c) => c.name.startsWith('liquidation-invariant'));
  assert.ok(check.pass, 'invariant must hold');
  assert.ok(check.residual < 1e-6, `residual too large: ${check.residual}`);
});

test('perp-gate: invariant holds across random valid positions (property test)', () => {
  // If the derivation were wrong, at least one of these would break the invariant.
  const sides = ['long', 'short'];
  for (let i = 0; i < 200; i++) {
    const side = sides[i % 2];
    const entryPrice = 100 + ((i * 137) % 90000);
    const maxLev = [40, 25, 20, 10, 5][i % 5];
    const size = 0.01 + ((i * 7) % 500) / 10;
    const margin = (size * entryPrice) / (maxLev * 0.8); // safely above maintenance (initial < mmr would be liquidatable)
    const r = perpGate({ side, entryPrice, size, margin, maxLeverage: maxLev });
    assert.equal(r.ok, true);
    if (r.liquidatable_at_entry) continue;
    const c = r.checks[0];
    assert.ok(c.pass, `invariant failed: side=${side} P0=${entryPrice} q=${size} M=${margin} maxLev=${maxLev} residual=${c.residual}`);
  }
});

test('perp-gate: mmr is derived from maxLeverage as 0.5/maxLev (BTC 40x -> 1.25%)', () => {
  const r = perpGate({ side: 'long', entryPrice: 100000, size: 1, margin: 2500, maxLeverage: 40 });
  assert.equal(r.maintenanceMarginRatePct, 1.25);
});

test('perp-gate: detects a position already liquidatable at entry (margin <= maintenance)', () => {
  // margin = 1% of notional but maintenance = 1.25% -> immediately liquidatable
  const r = perpGate({ side: 'long', entryPrice: 100000, size: 1, margin: 1000, maxLeverage: 40 });
  assert.equal(r.liquidatable_at_entry, true);
});

test('perp-gate: funding sign — a long pays when funding rate is positive', () => {
  const r = perpGate({ side: 'long', entryPrice: 100000, size: 1, margin: 5000, maxLeverage: 40, fundingRateHourly: 0.0001, horizonHours: 8 });
  assert.ok(r.funding.costOverHorizon > 0, 'long should PAY (cost>0) when rate>0');
  // 0.0001 * 100000 * 8 = 80
  assert.ok(Math.abs(r.funding.costOverHorizon - 80) < 0.5, `got ${r.funding.costOverHorizon}`);
});

test('perp-gate: a short receives funding when rate is positive', () => {
  const r = perpGate({ side: 'short', entryPrice: 100000, size: 1, margin: 5000, maxLeverage: 40, fundingRateHourly: 0.0001, horizonHours: 8 });
  assert.ok(r.funding.costOverHorizon < 0, 'short should RECEIVE (cost<0) when rate>0');
});

test('perp-gate: rejects bad input rather than fabricating', () => {
  const r = perpGate({ side: 'long', entryPrice: -1, size: 1, margin: 100, maxLeverage: 40 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});
