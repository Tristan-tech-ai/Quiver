// An adversarial review found the sharpest realistic-harm surface in the catalogue: portfolio-gate
// solves every liquidation under ISOLATED per-leg margin, and the nearest-liquidation headline closed
// with an unconditional "that is the whole book's real distance to first blood". On a cross-margined
// account the shared equity pool carries each leg far past its isolated price — Section 5.18 reports
// a real five-leg book where the isolated view read 3% away while the venue's cross prices sat 240%
// to 62,000% away. The sentence was most confident exactly where the model does not apply, and an
// autonomous caller polling this endpoint takes the default.
//
// These tests FAIL on the pre-fix engine, which emitted the same absolute claim regardless of what
// the caller said about margin mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioGate } from '../src/engine/portfolioGate.js';

const leg = (extra = {}) => ({ venue: 'hyperliquid', symbol: 'BTC', side: 'long', entryPrice: 64000, size: 1, leverage: 10, markPrice: 65105.9, maintMarginRate: 0.0125, ...extra });

test('a cross-margined leg must not be told the isolated distance is the book\'s real one', () => {
  const r = portfolioGate({ positions: [leg({ marginMode: 'cross' })] });
  assert.equal(r.ok, true);
  const note = r.nearestLiquidation.note;
  assert.doesNotMatch(note, /whole book's real distance/,
    'the claim is false on a cross book and must not be made there');
  assert.match(note, /NOT the whole book/i);
  assert.match(note, /crossMarginLiquidation/, 'and it must point at the figure that IS comparable');
});

test('silence about margin mode is disclosed as an assumption, not read as isolated', () => {
  const r = portfolioGate({ positions: [leg()] });   // no marginMode supplied
  const note = r.nearestLiquidation.note;
  assert.doesNotMatch(note, /whole book's real distance/,
    'nobody said this account is isolated, so the strong claim is not available');
  assert.match(note, /ASSUMED/);
  assert.equal(r.nearestLiquidation.marginModelAssumed, 'isolated per-leg margin');
});

test('when every leg is declared isolated, the strong claim IS available', () => {
  // The guard against over-correcting: a fix that simply deleted the sentence would pass the two
  // tests above while making the response less useful on the book where the claim is true.
  const r = portfolioGate({ positions: [leg({ marginMode: 'isolated' })] });
  assert.match(r.nearestLiquidation.note, /whole book's real distance to first blood/);
});

test('the headline always says which margin model it solved under', () => {
  for (const mode of ['cross', 'isolated', undefined]) {
    const r = portfolioGate({ positions: [leg(mode ? { marginMode: mode } : {})] });
    assert.match(r.nearestLiquidation.note, /ISOLATED margin/,
      `mode=${mode}: the model behind the number must be named in the number's own note`);
  }
});

test('margin mode is echoed per leg rather than silently dropped', () => {
  const r = portfolioGate({ positions: [leg({ marginMode: 'cross' }), leg({ symbol: 'ETH', marginMode: 'isolated' })] });
  assert.equal(r.positions[0].marginMode, 'cross');
  assert.equal(r.positions[1].marginMode, 'isolated');
  assert.equal(portfolioGate({ positions: [leg()] }).positions[0].marginMode, null,
    'unknown stays null — not defaulted to isolated in the echoed inputs');
});
