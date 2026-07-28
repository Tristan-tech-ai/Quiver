// CEX-symbol routing helpers for chart-press (strategy: chart-family CEX unlock). These pure functions
// are new → the file FAILS to import on the pre-fix code. www.okx.com is unreachable from the dev network
// (OKX host block, same as static.okx.com), so cexCandles() itself is verified live in prod, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normInstId, mapBar, looksLikeCexSymbol } from '../src/adapters/okx-market.js';
import { normaliseBar } from '../src/adapters/okx-rest.js';

test('normInstId: bare ticker gets USDT, separators normalize, case up', () => {
  assert.equal(normInstId('btc'), 'BTC-USDT');
  assert.equal(normInstId('BTC/USDT'), 'BTC-USDT');
  assert.equal(normInstId('eth_usdc'), 'ETH-USDC');
  assert.equal(normInstId('SOL-USDT'), 'SOL-USDT');
  assert.equal(normInstId(''), null);
});

test('mapBar: chart intervals map to OKX bar codes (UTC-aligned dailies)', () => {
  assert.equal(mapBar('4H'), '4H');
  assert.equal(mapBar('1D'), '1Dutc');
  assert.equal(mapBar('15m'), '15m');
  assert.equal(mapBar('1h'), '1H');
  assert.equal(mapBar('weird'), '1H'); // safe default

  // THE DEX PATH, LOCKED IN THE SAME PLACE, because the bug was the gap BETWEEN the two paths and a
  // check that only ever looks at one of them cannot see a gap. chart-press on a chain+address sends
  // its interval through `normaliseBar` in okx-rest.js instead of `mapBar`, and for a while sent it
  // through nothing at all: `1h` went upstream verbatim, OKX answered `code:51000` with no rows, and
  // chart-press reported DATA_UNAVAILABLE blaming an upstream outage for a bar code Quiver itself sent.
  //
  // Measured against the keyed endpoint on 28 July: `bar=1H` returns `code:"0"` with rows, `bar=1h`
  // returns `code:51000` with none. Then confirmed on the deployed service afterwards, where 1H, 1h,
  // 4H, 4h, 15m, 1D and 1d all return a chart from `okx-dex` for a token that has history.
  assert.equal(normaliseBar('1h'), '1H');
  assert.equal(normaliseBar('4h'), '4H');
  assert.equal(normaliseBar('1d'), '1D');
  assert.equal(normaliseBar('1w'), '1W');

  // Already-correct codes must come back untouched, or the fix would move contentHashes for callers
  // who were never broken.
  for (const already of ['1H', '4H', '1D', '1W', '5m', '15m', '30m']) {
    assert.equal(normaliseBar(already), already, `${already} was already valid and must not be rewritten`);
  }

  // THE ONE THAT MATTERS MOST, and the reason the normaliser is a targeted regex rather than a
  // `toUpperCase()`. In OKX's vocabulary `1m` is one MINUTE and `1M` is one MONTH. The first version of
  // this fix upper-cased every trailing letter, which turns a minute chart into a monthly one while
  // every downstream number stays plausible. A wrong answer that looks right is worse than an outage.
  assert.equal(normaliseBar('1m'), '1m');
  assert.equal(normaliseBar('15m'), '15m');
  assert.notEqual(normaliseBar('15m'), '15M');

  // Empty and missing fall back rather than sending OKX a bare unit.
  assert.equal(normaliseBar(undefined), '1H');
  assert.equal(normaliseBar(''), '1H');

  // The two paths must agree on the cases they share, which is the invariant the bug violated.
  for (const i of ['1h', '4h', '15m', '5m', '30m']) {
    assert.equal(normaliseBar(i), mapBar(i), `CEX and DEX must send the same bar code for ${i}`);
  }
});

test('looksLikeCexSymbol: rejects EVM/Solana addresses, accepts pairs/tickers', () => {
  assert.equal(looksLikeCexSymbol('BTC-USDT'), true);
  assert.equal(looksLikeCexSymbol('ETH'), true);
  assert.equal(looksLikeCexSymbol('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'), false, 'EVM address is not a symbol');
  assert.equal(looksLikeCexSymbol('So11111111111111111111111111111111111111112'), false, 'Solana address is not a symbol');
  assert.equal(looksLikeCexSymbol(''), false);
});
