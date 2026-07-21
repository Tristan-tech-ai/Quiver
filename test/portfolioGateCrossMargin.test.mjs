// Cross-margin account liquidation (deep methodology). crossMarginLiquidation is new → FAILS on pre-fix code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crossMarginLiquidation, portfolioGate } from '../src/engine/portfolioGate.js';

const leg = (asset, side, notional, marginUsed, moveToLiqPct = 9) => ({ asset, side, notional, marginUsed, markPrice: 100, liquidation: { mmrPct: 0.5, moveToLiqPct } });

test('cross-margin: a hedged (long+short same asset) book survives FAR beyond the isolated per-leg liq', () => {
  const r = crossMarginLiquidation([leg('BTC', 'long', 60000, 6000), leg('BTC', 'short', 60000, 6000)], null, { BTC: 1 }, true);
  assert.equal(r.available, true);
  // offsetting legs → a correlated move is ~net-flat → survives a 100% move (null), unlike the 9% isolated view
  assert.equal(r.accountLiquidationDownMovePct, null);
  assert.equal(r.accountLiquidationUpMovePct, null);
});

test('cross-margin: an all-long book DOES liquidate, and higher-beta legs pull the account move in', () => {
  const lowBeta = crossMarginLiquidation([leg('BTC', 'long', 50000, 5000), leg('ETH', 'long', 50000, 5000)], null, { BTC: 1, ETH: 1 }, true);
  const hiBeta = crossMarginLiquidation([leg('BTC', 'long', 50000, 5000), leg('SOL', 'long', 50000, 5000)], null, { BTC: 1, SOL: 3 }, true);
  assert.ok(lowBeta.accountLiquidationDownMovePct > 0);
  assert.ok(hiBeta.accountLiquidationDownMovePct < lowBeta.accountLiquidationDownMovePct, 'high-beta leg liquidates the account at a smaller market move');
});

test('cross-margin: explicit accountEquityUsd overrides the summed-margin pool proxy', () => {
  const proxy = crossMarginLiquidation([leg('BTC', 'long', 50000, 5000)], null, { BTC: 1 }, true);
  const rich = crossMarginLiquidation([leg('BTC', 'long', 50000, 5000)], 50000, { BTC: 1 }, true);
  assert.equal(proxy.equitySource, 'Σ per-leg margin (pool proxy)');
  assert.equal(rich.equitySource, 'accountEquityUsd (caller)');
  assert.equal(rich.poolEquityUsd, 50000);
  assert.ok(rich.accountLiquidationDownMovePct > proxy.accountLiquidationDownMovePct, 'more equity → survives a bigger move');
});

test('cross-margin: unknown per-leg margin AND no accountEquity → disclosed unavailable, not fabricated', () => {
  const r = crossMarginLiquidation([leg('BTC', 'long', 50000, null)], null, null, false);
  assert.equal(r.available, false);
  assert.ok(r.note.includes('accountEquityUsd') && r.note.includes('Not assumed'));
});

test('cross-margin: the dominance self-check passes on a full portfolio-gate call', () => {
  const r = portfolioGate({ positions: [
    { venue: 'hl', asset: 'BTC', side: 'long', size: 1, entryPrice: 64000, margin: 6400, maxLeverage: 40 },
    { venue: 'hl', asset: 'SOL', side: 'long', size: 100, entryPrice: 150, margin: 3000, maxLeverage: 20 },
  ] });
  assert.equal(r.crossMarginLiquidation.available, true);
  const cmCheck = r.checks.find((c) => c.name.includes('cross-margin account liquidation'));
  assert.ok(cmCheck && cmCheck.pass, 'cross-margin dominance self-check present and passing');
  assert.ok(r.checks.every((c) => c.pass));
});
