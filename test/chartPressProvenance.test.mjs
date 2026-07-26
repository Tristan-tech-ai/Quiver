// chart-press told a checkable lie: its provenance said every fact came from the SAME candle series
// drawn on the image and "cannot drift from the picture", while priceUsd and change24hPct actually came
// from the token price feed. A live render made it visible — the image labelled 64,418.50 and facts
// said 64,352.8 — so a reader following the response's own reconciliation claim found a mismatch the
// response asserted was impossible. These tests fail on the pre-fix code, which had no priceSource,
// no lastDrawnCandleClose, and a reconciledTo that made the false claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPress } from '../src/engine/chartPress.js';

// 72 four-hour bars ending on a known close, so the drawn series is fully determined.
function bars(n = 72, lastClose = 64418.5) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const c = i === n - 1 ? lastClose : 64000 + (i % 7) * 120 - (i % 3) * 90;
    const o = c - 40;
    rows.push([Date.UTC(2026, 6, 14) + i * 4 * 3600e3, o, Math.max(o, c) + 60, Math.min(o, c) - 55, c, 1000 + i]);
  }
  return rows;
}
const depsWithFeed = (feedPrice) => ({
  candles: async () => bars(),
  priceInfo: async () => ({ price: feedPrice, priceChange24H: 0.47, volume24H: 19665890, liquidity: 4769788714, holders: 187903, tokenSymbol: 'WBTC' }),
  trades: async () => [],
});
const depsNoFeed = {
  candles: async () => bars(),
  priceInfo: async () => ({}),                 // the feed did not answer
  trades: async () => [],
};

test('chart-press: priceUsd from the feed is LABELLED as such, and the drawn close is reported beside it', async () => {
  const r = await chartPress('ethereum', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', { interval: '4H', bars: 72 }, depsWithFeed(64352.8));
  assert.equal(r.facts.priceUsd, 64352.8);
  assert.match(r.facts.priceSource, /price-feed/, 'the response must say where the price came from');
  assert.equal(r.facts.lastDrawnCandleClose, 64418.5, 'the number the image labels must be reported');
  assert.notEqual(r.facts.priceUsd, r.facts.lastDrawnCandleClose,
    'precondition: these are genuinely two different measurements, which is the whole point');
  assert.match(r.facts.change24hSource, /price-feed/);
});

test('chart-press: provenance no longer claims the price came from the drawn candles', async () => {
  const r = await chartPress('ethereum', '0xabc', { interval: '4H', bars: 72 }, depsWithFeed(64352.8));
  const rc = r.provenance.reconciledTo;
  // The guarantee must no longer be a BLANKET one over the whole facts block. "cannot drift from the
  // picture" is fine where it is now scoped to high/low; what must be gone is the claim covering price.
  assert.doesNotMatch(rc, /facts block \(price, 24h change/,
    'the old guarantee named price and 24h change among the fields taken from the drawn series');
  assert.doesNotMatch(rc, /The facts block \(.*\) is computed from the SAME candle series/);
  assert.match(rc, /NOT from the drawn candles/, 'it must state plainly which fields are not from the series');
  assert.match(rc, /facts\.lastDrawnCandleClose/, 'and point at the field that makes the comparison possible');
  // The guarantee that IS true must survive: high/low really are from the drawn bars.
  assert.match(rc, /facts\.high and facts\.low are computed from the SAME candle series/);
  assert.doesNotMatch(r.method, /mirrors the exact numbers on the image/);
});

test('chart-press: high and low still come from the drawn series exactly', async () => {
  const rows = bars();
  const r = await chartPress('ethereum', '0xabc', { interval: '4H', bars: 72 }, depsWithFeed(64352.8));
  assert.equal(r.facts.high, Math.max(...rows.map((b) => b[2])));
  assert.equal(r.facts.low, Math.min(...rows.map((b) => b[3])));
});

test('chart-press: with no price feed, priceUsd IS the drawn close and says so', async () => {
  const r = await chartPress('ethereum', '0xabc', { interval: '4H', bars: 72 }, depsNoFeed);
  assert.equal(r.facts.priceUsd, r.facts.lastDrawnCandleClose,
    'without a feed the fallback must be the drawn close');
  assert.match(r.facts.priceSource, /last drawn candle close/);
  assert.match(r.facts.change24hSource, /drawn candle/);
  assert.match(r.provenance.reconciledTo, /the price feed did not answer/);
});
