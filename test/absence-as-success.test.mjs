// Absence-as-success trio locks (from the silent-catch census). Each FAILS on the pre-fix engines, which
// reported a FAILED upstream fetch as an empty/negative business fact (NO_OPEN_POSITIONS / NO_OPEN_WINDOW /
// INSUFFICIENT_CANDLES).
import test from 'node:test';
import assert from 'node:assert/strict';
import { polyDesk } from '../src/engine/polyDesk.js';
import { upDownPulse } from '../src/engine/upDownPulse.js';
import { chartPress } from '../src/engine/chartPress.js';

test('poly-desk: failed positions fetch → DATA_UNAVAILABLE, never NO_OPEN_POSITIONS', async () => {
  const out = await polyDesk('0xW', { positions: async () => { throw new Error('down'); }, activity: async () => [] });
  assert.equal(out.verdict, 'DATA_UNAVAILABLE');
  assert.equal(out.dataCompleteness.positionsFetched, false);
});

test('poly-desk: succeeded-but-empty positions → genuine NO_OPEN_POSITIONS with completeness', async () => {
  const out = await polyDesk('0xW', { positions: async () => [], activity: async () => [] });
  assert.equal(out.verdict, 'NO_OPEN_POSITIONS');
  assert.equal(out.dataCompleteness.positionsFetched, true);
});

test('updown-pulse: both event lookups failing → MARKET_LOOKUP_FAILED, never NO_OPEN_WINDOW', async () => {
  const out = await upDownPulse('BTC', { eventsSearch: async () => { throw new Error('down'); } });
  assert.equal(out.verdict, 'MARKET_LOOKUP_FAILED');
  assert.ok(out.note.includes('UNKNOWN'));
});

test('updown-pulse: lookups succeed with no match → genuine NO_OPEN_WINDOW', async () => {
  const out = await upDownPulse('BTC', { eventsSearch: async () => [] });
  assert.equal(out.verdict, 'NO_OPEN_WINDOW');
  assert.ok(out.note.includes('succeeded'));
});

test('chart-press: failed candle fetch → DATA_UNAVAILABLE, never INSUFFICIENT_CANDLES', async () => {
  const failing = { candles: async () => { throw new Error('down'); }, priceInfo: async () => ({}), trades: async () => [] };
  const out = await chartPress('ethereum', '0xabc', {}, failing);
  assert.equal(out.verdict, 'DATA_UNAVAILABLE');
  assert.ok(out.note.includes('FAILED'));
});

test('chart-press: succeeded-but-thin candles → genuine INSUFFICIENT_CANDLES', async () => {
  const thin = { candles: async () => [[1, 1, 1, 1, 1, 1]], priceInfo: async () => ({}), trades: async () => [] };
  const out = await chartPress('ethereum', '0xabc', {}, thin);
  assert.equal(out.verdict, 'INSUFFICIENT_CANDLES');
  assert.ok(out.note.includes('SUCCEEDED'));
});
