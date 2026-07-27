// A live-access reviewer pointed a perp-gate call at `venue: "okx"` — a value the tool's own schema
// declares outside its enum — and got HTTP 200, ok:true, correct maths, and an error object welded
// into the signed result, with allSelfChecksPass:true. On an OKX submission, of all the values to
// degrade that way. It is neither a refusal nor a usable answer.
//
// The engine is venue-agnostic, so the honest response is to refuse the resolution, name what IS
// resolvable, and say how to get the number anyway. Refusals are free under the billing contract.
// These tests FAIL on the pre-fix adapter, which returned the complaint as a served field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichPerpInputs, supportedVenues } from '../src/adapters/hyperliquid.js';
import { isChargeable } from '../src/x402.js';

test('an unresolvable venue is flagged as a CALLER error, distinctly from an upstream outage', async () => {
  const e = await enrichPerpInputs({ symbol: 'BTC-USDT-SWAP', venue: 'okx', side: 'long', size: 1, leverage: 10 });
  assert.equal(e.live.unsupportedVenue, true,
    'without this marker the handler cannot tell "you named a venue we do not have" from "the venue is down"');
  assert.deepEqual(e.live.supported, supportedVenues(),
    'and the response must carry what IS supported, not just what is not');
  assert.match(e.live.error, /okx/);
});

test('a supported venue carries no such marker', async () => {
  // Guard against a fix that flags everything. No network is touched: the provider is injected.
  const e = await enrichPerpInputs(
    { symbol: 'BTC', venue: 'hyperliquid', side: 'long', size: 1, leverage: 10 },
    async () => ({ markPrice: 65000, maxLeverage: 40, fundingRateHourly: 0.00001 }),
  );
  assert.notEqual(e.live?.unsupportedVenue, true);
});

test('the refusal a handler builds from it is free under the billing contract', () => {
  const refusal = { ok: false, errors: ['unsupported venue "okx" — supported: hyperliquid, dydx.'], supportedVenues: ['hyperliquid', 'dydx'] };
  assert.equal(isChargeable(refusal), false,
    'a caller who names a venue we cannot resolve must not pay for being told so');
});

test('the refusal names the supported venues rather than only rejecting', () => {
  // The self-teaching property: a caller must be able to fix the request from the error alone.
  return enrichPerpInputs({ symbol: 'X', venue: 'binance', side: 'long', size: 1, leverage: 5 }).then((e) => {
    const refusal = { ok: false, errors: [e.live.error], supportedVenues: e.live.supported };
    assert.ok(refusal.supportedVenues.length > 0);
    assert.match(refusal.errors[0], /pass maxLeverage\/markPrice\/fundingRateHourly manually/,
      'and it must say how to get the number anyway, since the maths is venue-agnostic');
  });
});
