// Regression lock for the perp-gate margin-tier fix: the pre-fix engine used only the headline (tier-0)
// maxLeverage, which UNDERSTATES liquidation risk for large positions (bigger notional → lower-leverage tier
// → higher mmr → closer liq). It ignored marginTiers entirely, so passing ONLY marginTiers errored (ok:false)
// — these tests fail on that code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perpGate } from '../src/engine/perpGate.js';

// Real Hyperliquid BTC tiers (verified live from meta.marginTables): 40× to $150M notional, 20× above.
const BTC_TIERS = [{ lowerBound: 0, maxLeverage: 40 }, { lowerBound: 150000000, maxLeverage: 20 }];

test('perp-gate applies NOTIONAL margin tiers — large position → higher mmr + closer liq (fails on pre-fix)', () => {
  const small = perpGate({ side: 'long', entryPrice: 100000, size: 1000, leverage: 10, marginTiers: BTC_TIERS }); // $100M < $150M
  const large = perpGate({ side: 'long', entryPrice: 100000, size: 2000, leverage: 10, marginTiers: BTC_TIERS }); // $200M > $150M
  assert.ok(small.ok && large.ok, 'engine must accept marginTiers as the maintenance-rate source');
  assert.equal(small.marginTier.appliedMaxLeverage, 40, 'small position → base 40× tier');
  assert.equal(large.marginTier.appliedMaxLeverage, 20, 'large position → tiered-down 20× tier');
  assert.equal(small.maintenanceMarginRatePct, 1.25);
  assert.equal(large.maintenanceMarginRatePct, 2.5);
  assert.ok(large.maintenanceMarginRatePct > small.maintenanceMarginRatePct, 'larger notional ⇒ higher mmr');
  assert.ok(large.moveToLiquidationPct < small.moveToLiquidationPct, 'tiered-down position liquidates CLOSER');
  assert.equal(large.checks[0].pass, true, 'liquidation invariant holds at the tiered mmr');
});

test('perp-gate: base-tier-only UNDERSTATES the same large position vs the true tier', () => {
  const tiered = perpGate({ side: 'long', entryPrice: 100000, size: 2000, leverage: 10, marginTiers: BTC_TIERS });
  const headline = perpGate({ side: 'long', entryPrice: 100000, size: 2000, leverage: 10, maxLeverage: 40 }); // pre-fix behaviour
  assert.ok(tiered.maintenanceMarginRatePct > headline.maintenanceMarginRatePct, 'tier mmr > headline mmr');
  assert.ok(tiered.moveToLiquidationPct < headline.moveToLiquidationPct, 'headline leverage reports liquidation further than it truly is');
});
