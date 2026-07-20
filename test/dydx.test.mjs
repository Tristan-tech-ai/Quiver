// dYdX v4 indexer parser — pure decode logic, tested against a fixture (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePerpetualMarkets } from '../src/adapters/dydx.js';

const fixture = {
  markets: {
    'BTC-USD': { oraclePrice: '64647.14', nextFundingRate: '0.000003625', maintenanceMarginFraction: '0.012', initialMarginFraction: '0.02' },
    'ETH-USD': { oraclePrice: '3000', nextFundingRate: '-0.00001', maintenanceMarginFraction: '0.03', initialMarginFraction: '0.05' },
    'BAD-USD': { oraclePrice: '0', maintenanceMarginFraction: '0.05' }, // skipped: bad mark
  },
};

test('dydx: parses markets → mmr / mark / hourly funding / maxLeverage; strips -USD; skips malformed', () => {
  const m = parsePerpetualMarkets(fixture);
  assert.equal(m.size, 2, 'BAD-USD (mark 0) is skipped, not fabricated');
  const btc = m.get('BTC');
  assert.equal(btc.maintMarginRate, 0.012, 'dYdX publishes the maintenance rate directly');
  assert.equal(btc.markPx, 64647.14);
  assert.equal(btc.fundingHourly, 0.000003625, 'dYdX funds hourly');
  assert.equal(btc.maxLeverage, 50, '1 / initialMarginFraction');
  assert.equal(m.get('ETH').fundingHourly, -0.00001);
});

test('dydx: rejects an unexpected shape rather than fabricating', () => {
  assert.throws(() => parsePerpetualMarkets({ notMarkets: 1 }));
});
