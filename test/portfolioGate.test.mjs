// portfolio-gate — cross-venue exposure, nearest liquidation, correlated-crash stress. The self-checks are
// exact identities; a wrong aggregation fails its own check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioGate } from '../src/engine/portfolioGate.js';

const book = {
  positions: [
    { venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 10, entryPrice: 60000, leverage: 10, maxLeverage: 40 },
    { venue: 'binance', asset: 'BTC', side: 'long', size: 5, entryPrice: 60000, leverage: 8, maxLeverage: 40 },
    { venue: 'binance', asset: 'ETH', side: 'long', size: 100, entryPrice: 3000, leverage: 12, maxLeverage: 25 },
    { venue: 'okx', asset: 'SOL', side: 'short', size: 500, entryPrice: 150, leverage: 5, maxLeverage: 20 },
  ],
};

test('portfolio-gate: net exposure per underlying = Σ signed notional (reconciles)', () => {
  const r = portfolioGate(book);
  assert.ok(r.ok);
  assert.equal(r.netExposureByAsset.find((e) => e.asset === 'BTC').netNotional, 900000); // (10+5)×60000 long
  assert.equal(r.netExposureByAsset.find((e) => e.asset === 'SOL').netNotional, -75000); // 500×150 short
  assert.equal(r.checks.find((c) => c.name.startsWith('exposure reconciliation')).pass, true);
});

test('portfolio-gate: nearestLiquidation is the true minimum distance-to-liq across all legs', () => {
  const r = portfolioGate(book);
  const minMove = Math.min(...r.positions.filter((p) => p.liquidation).map((p) => p.liquidation.moveToLiqPct));
  assert.equal(r.nearestLiquidation.moveToLiquidationPct, minMove);
  assert.equal(r.checks.find((c) => c.name.startsWith('nearestLiquidation')).pass, true);
});

test('portfolio-gate: a correlated crash liquidates correlated LONGS together (monotone, ≥2 at scale)', () => {
  const r = portfolioGate(book);
  const s = r.correlatedShockStress.scenarios;
  for (let i = 1; i < s.length; i++) assert.ok(s[i].onDownMove.legsLiquidated >= s[i - 1].onDownMove.legsLiquidated);
  assert.ok(s[s.length - 1].onDownMove.legsLiquidated >= 2, 'a large correlated crash liquidates multiple long legs simultaneously — the "secretly one bet" failure');
  assert.equal(r.checks.find((c) => c.name.startsWith('correlated')).pass, true);
});

test('portfolio-gate: all self-checks pass on a valid book; empty book is rejected (no fabrication)', () => {
  const r = portfolioGate(book);
  assert.ok(r.checks.length >= 6); // 4 original + 2 factor-beta (+ cross-margin dominance when margins known)
  assert.ok(r.checks.every((c) => c.pass));
  assert.ok(r.betaScaledStress && Array.isArray(r.betaScaledStress.scenarios), 'factor-beta stress present');
  assert.equal(portfolioGate({ positions: [] }).ok, false);
});
