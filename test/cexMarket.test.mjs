// CEX-symbol routing helpers for chart-press (strategy: chart-family CEX unlock). These pure functions
// are new → the file FAILS to import on the pre-fix code. www.okx.com is unreachable from the dev network
// (OKX host block, same as static.okx.com), so cexCandles() itself is verified live in prod, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normInstId, mapBar, looksLikeCexSymbol } from '../src/adapters/okx-market.js';

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
});

test('looksLikeCexSymbol: rejects EVM/Solana addresses, accepts pairs/tickers', () => {
  assert.equal(looksLikeCexSymbol('BTC-USDT'), true);
  assert.equal(looksLikeCexSymbol('ETH'), true);
  assert.equal(looksLikeCexSymbol('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'), false, 'EVM address is not a symbol');
  assert.equal(looksLikeCexSymbol('So11111111111111111111111111111111111111112'), false, 'Solana address is not a symbol');
  assert.equal(looksLikeCexSymbol(''), false);
});
