// Factor-beta correlated stress (deep methodology, dispatch-directed). New exports → FAIL on pre-fix code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { betaFor, factorBetaStress, CRASH_BETAS } from '../src/engine/portfolioGate.js';

const legs = (specs) => specs.map(([asset, side, liqDist, notional]) => ({ asset, side, notional, liquidation: { moveToLiqPct: liqDist } }));

test('betaFor: caller betas > MEASURED table > alt-median prior; Oct-10 anchors present', () => {
  assert.equal(betaFor('BTC'), 1.0);
  assert.equal(betaFor('SOL'), 2.2);   // measured Oct-10 HL 4h
  assert.equal(betaFor('ETH'), 1.5);   // measured (news −12% was window endpoints; peak→trough −26% → 1.5)
  assert.equal(betaFor('XRP'), 3.3);
  assert.equal(betaFor('SOMETHINGNEW'), 3.5, 'unknown → measured alt-median prior');
  assert.equal(betaFor('BTC', { BTC: 3 }), 3, 'caller override wins');
  assert.ok(CRASH_BETAS.SOL > CRASH_BETAS.BTC && CRASH_BETAS.AI16Z > CRASH_BETAS.XRP, 'measured beta ladder holds');
});

test('CRASH_BETAS is the MEASURED table (guard against reverting to the guessed priors)', () => {
  // These exact values come from measured-betas.json (HL 4h Oct-10 peak→trough / BTC −17.7%). If a future
  // edit silently reverts to the old guess (ETH 0.9, SOL 2.6), this fails.
  assert.equal(CRASH_BETAS.ETH, 1.5);
  assert.equal(CRASH_BETAS.LINK, 3.8);
  assert.equal(CRASH_BETAS.PENGU, 4.7);
  assert.notEqual(CRASH_BETAS.ETH, 0.9, 'must not be the pre-validation guess');
});

test('factor-beta: a high-beta alt liquidates at a SMALLER market move than the ρ=1 view', () => {
  // LINK long, liq 30% away. ρ=1: needs a 30% MARKET move. beta model: LINK beta 3.8 → 30/3.8 ≈ 7.9% market move.
  const wl = legs([['LINK', 'long', 30, 1000]]);
  const s = factorBetaStress(wl, [7, 8, 20], null, 1000);
  assert.equal(s.find((x) => x.marketMovePct === 7).onDownMove.legsLiquidated, 0, '3.8·7=26.6 < 30, not yet');
  assert.equal(s.find((x) => x.marketMovePct === 8).onDownMove.legsLiquidated, 1, '3.8·8=30.4 ≥ 30, liquidated');
});

test('factor-beta: beta=1 override reproduces the ρ=1 count exactly', () => {
  const wl = legs([['BTC', 'long', 15, 500], ['SOL', 'long', 15, 500]]);
  const betas = { BTC: 1, SOL: 1 };
  const s = factorBetaStress(wl, [10, 15, 20], betas, 1000);
  assert.equal(s.find((x) => x.marketMovePct === 10).onDownMove.legsLiquidated, 0);
  assert.equal(s.find((x) => x.marketMovePct === 15).onDownMove.legsLiquidated, 2, 'both cross at exactly 15% when beta=1');
});

test('factor-beta: down move hits longs, up move hits shorts; monotone in shock', () => {
  const wl = legs([['SOL', 'long', 30, 100], ['ETH', 'short', 10, 100]]);
  const s = factorBetaStress(wl, [5, 12, 25], null, 200);
  // longs (SOL beta 2.6) only on down; shorts (ETH beta 0.9) only on up
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].onDownMove.legsLiquidated >= s[i - 1].onDownMove.legsLiquidated, 'down monotone');
    assert.ok(s[i].onUpMove.legsLiquidated >= s[i - 1].onUpMove.legsLiquidated, 'up monotone');
  }
  assert.equal(s[s.length - 1].onDownMove.legsLiquidated, 1, 'SOL long liquidates on a big down move');
});
