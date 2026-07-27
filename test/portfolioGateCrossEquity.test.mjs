// portfolio-gate cross-margin liquidation, found by sweeping the LIVE service with ordinary inputs
// rather than by review: a single-leg book returned ok:true with allSelfChecksPass:false, on the
// 0.05 flagship, and had been doing so while charging for it.
//
// The invariant that makes this decidable: a cross-margin book with ONE leg *is* that leg's isolated
// book — same equity, same position, same maintenance — so the account liquidation and the isolated
// liquidation must agree. Two compounding defects broke that agreement:
//   1. total maintenance was held at today's notional while equity fell, but maintenance is charged on
//      the notional at the MOVED price and shrinks with it;
//   2. the equity pool summed `marginUsed`, which is sized off the MARK notional and therefore drops
//      the position's unrealized PnL.
// Both push the account liquidation nearer than it is. Measured live on BTC long 64000/1/10x at a mark
// of 65105.9: the engine said 9.0% while its own isolated leg said 10.409%.
import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioGate } from '../src/engine/portfolioGate.js';

// The live shape, with markPrice pinned so the case is deterministic instead of tracking spot.
const ONE_LEG = {
  positions: [{ venue: 'hyperliquid', symbol: 'BTC', side: 'long', entryPrice: 64000, size: 1, leverage: 10, markPrice: 65105.9, maintMarginRate: 0.0125 }],
};

// The 0.25 scan grid means the account figure lands on the next grid point above the exact answer, so
// the tolerance carries the grid and nothing more. It is deliberately tighter than the 1.409-point
// error the defect produced — a tolerance wider than the effect it certifies would certify nothing.
const GRID_TOL = 0.5;

test('a one-leg cross-margin book liquidates where its isolated leg does', () => {
  const r = portfolioGate(ONE_LEG);
  assert.equal(r.ok, true);
  const iso = r.nearestLiquidation.moveToLiquidationPct;
  const acct = r.crossMarginLiquidation.accountLiquidationDownMovePct;
  assert.ok(acct != null, 'the account liquidation must be computed for a single funded leg');
  assert.ok(Math.abs(acct - iso) <= GRID_TOL,
    `one-leg cross must equal isolated: account ${acct}% vs isolated ${iso}% (delta ${(acct - iso).toFixed(3)}pts)`);
});

test('the engine no longer contradicts itself on an ordinary single position', () => {
  const r = portfolioGate(ONE_LEG);
  assert.equal(r.proof?.allSelfChecksPass ?? r.checks.every((c) => c.pass !== false), true,
    'this exact input shipped allSelfChecksPass:false live, and was charged for');
  const crossCheck = r.checks.find((c) => c.name.startsWith('cross-margin account liquidation'));
  assert.ok(crossCheck, 'the cross-margin check must actually run on this book, not be skipped');
  assert.equal(crossCheck.pass, true);
});

test('the equity pool is posted margin plus unrealized PnL, not margin re-derived at the mark', () => {
  const r = portfolioGate(ONE_LEG);
  const leg = r.positions[0];
  // posted margin = size x entry / leverage = 6400; PnL = 1 x (65105.9 - 64000) = 1105.90
  assert.equal(leg.unrealizedPnlUsd, 1105.9);
  assert.equal(leg.equityUsd, 7505.9);
  assert.equal(r.crossMarginLiquidation.poolEquityUsd, 7505.9,
    'the pre-fix pool was 6510.6 — the mark-sized margin, with the gain discarded');
});

// Guards. A fix that simply pushed the account liquidation further out would also satisfy the tests
// above, so these pin the behaviour that must NOT change.
test('a hedged two-leg book still liquidates LATER than its nearest isolated leg', () => {
  const r = portfolioGate({ positions: [
    { venue: 'hyperliquid', symbol: 'BTC', side: 'long', entryPrice: 64000, size: 1, leverage: 10, markPrice: 65105.9, maintMarginRate: 0.0125 },
    { venue: 'dydx', symbol: 'ETH', side: 'short', entryPrice: 3200, size: 5, leverage: 5, markPrice: 3200, maintMarginRate: 0.0125 },
  ] });
  assert.equal(r.ok, true);
  const acct = r.crossMarginLiquidation.accountLiquidationDownMovePct;
  assert.ok(acct === null || acct >= r.nearestLiquidation.moveToLiquidationPct,
    'the shared pool and the short hedge can only extend survival');
});

test('an already-underwater book still reports a breach at zero rather than withholding', () => {
  // Equity below maintenance at today's marks: a long that has lost almost all of its posted margin.
  const r = portfolioGate({ positions: [
    { venue: 'hyperliquid', symbol: 'BTC', side: 'long', entryPrice: 64000, size: 1, leverage: 10, markPrice: 57800, maintMarginRate: 0.0125 },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.crossMarginLiquidation.available, true, 'negative equity is a real state, not a reason to refuse');
  assert.equal(r.crossMarginLiquidation.accountLiquidationDownMovePct, 0);
});

test('cross-margin is still withheld when equity genuinely cannot be known', () => {
  const r = portfolioGate({ positions: [
    { venue: 'hyperliquid', symbol: 'BTC', side: 'long', entryPrice: 64000, size: 1, markPrice: 65105.9, maintMarginRate: 0.0125 },
  ] });
  assert.equal(r.crossMarginLiquidation.available, false, 'no margin and no leverage = no pool; it must not be invented');
});
