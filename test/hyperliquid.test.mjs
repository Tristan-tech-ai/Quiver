import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetaAndAssetCtxs, enrichPerpInputs, supportedVenues } from '../src/adapters/hyperliquid.js';

const FIXTURE = [
  { universe: [{ name: 'BTC', maxLeverage: 40, szDecimals: 5 }, { name: 'ETH', maxLeverage: 25, szDecimals: 4 }, { name: 'DEAD', maxLeverage: 0 }] },
  [{ markPx: '64000', funding: '0.0000125', oraclePx: '63990', openInterest: '1000' },
   { markPx: '3400', funding: '-0.00001', oraclePx: '3399', openInterest: '5000' },
   { markPx: '0', funding: '0' }],
];

test('hyperliquid parse: decodes index-aligned universe/ctx, skips malformed', () => {
  const m = parseMetaAndAssetCtxs(FIXTURE);
  assert.equal(m.get('BTC').maxLeverage, 40);
  assert.equal(m.get('BTC').markPx, 64000);
  assert.equal(m.get('BTC').fundingHourly, 0.0000125);
  assert.equal(m.get('ETH').fundingHourly, -0.00001); // negative funding preserved (shorts pay)
  assert.equal(m.has('DEAD'), false, 'zero markPx/leverage entry skipped, not fabricated');
});

test('hyperliquid parse: throws on shape mismatch rather than guessing', () => {
  assert.throws(() => parseMetaAndAssetCtxs([{ universe: [{ name: 'BTC', maxLeverage: 40 }] }, []]));
  assert.throws(() => parseMetaAndAssetCtxs(null));
});

const getCtx = async (sym) => ({ BTC: { maxLeverage: 40, markPx: 64000, fundingHourly: 0.0000125 } }[String(sym).toUpperCase()] || null);

test('enrichPerpInputs: fills live fields and defaults entry to mark, disclosing provenance', async () => {
  const e = await enrichPerpInputs({ symbol: 'BTC', size: 1, margin: 2500 }, getCtx);
  assert.equal(e.maxLeverage, 40);
  assert.equal(e.markPrice, 64000);
  assert.equal(e.entryPrice, 64000);       // defaulted to mark
  assert.equal(e.fundingRateHourly, 0.0000125);
  assert.equal(e.live.filled.maxLeverage, 40);
  assert.equal(e.live.filled._entryDefaultedToMark, true);
});

test('enrichPerpInputs: NEVER overwrites caller-supplied values', async () => {
  const e = await enrichPerpInputs({ symbol: 'BTC', size: 1, margin: 2500, entryPrice: 100000, maxLeverage: 20 }, getCtx);
  assert.equal(e.entryPrice, 100000, 'caller entry preserved');
  assert.equal(e.maxLeverage, 20, 'caller leverage preserved');
  assert.equal(e.markPrice, 64000, 'only the missing field is filled');
  assert.equal(e.live.filled.entryPrice, undefined);
});

test('enrichPerpInputs: no symbol -> input returned unchanged', async () => {
  const inp = { entryPrice: 100000, size: 1, margin: 2500, maxLeverage: 40 };
  const e = await enrichPerpInputs(inp, getCtx);
  assert.deepEqual(e, inp);
});

test('enrichPerpInputs: graceful on fetch failure and unknown symbol (no fabrication)', async () => {
  const boom = async () => { throw new Error('network down'); };
  const e1 = await enrichPerpInputs({ symbol: 'BTC', size: 1, margin: 2500 }, boom);
  assert.ok(e1.live.error.includes('unavailable'));
  assert.equal(e1.markPrice, undefined, 'no fabricated live values on failure');
  const e2 = await enrichPerpInputs({ symbol: 'NOPE', size: 1, margin: 2500 }, getCtx);
  assert.ok(e2.live.error.includes('not found'));
});

test('enrichPerpInputs: venue routing — hyperliquid supported, unknown venue errors clearly', async () => {
  assert.ok(supportedVenues().includes('hyperliquid'));
  const bad = await enrichPerpInputs({ symbol: 'BTC', venue: 'binance', size: 1, margin: 5000 });
  assert.ok(/unsupported venue/.test(bad.live.error), 'unknown venue must error, not fabricate');
  assert.equal(bad.markPrice, undefined);
});
