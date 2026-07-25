// Wrong-endpoint guard (the 1-star-review class of failure): when a caller reaches the wrong service
// — because its agent picked wrong, or because the marketplace funnel dropped the service params —
// the service must REFUSE (free, per the billing contract) and point at the service actually wanted.
// It must never silently default a REQUIRED subject parameter and answer a question nobody asked.
// Each test FAILS on the pre-fix code, which turned a missing currency/coin into a confident BTC read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/services.js';

const svc = (n) => SERVICES.find((s) => s.name === n);

test('options-desk: a missing currency is refused, not defaulted to BTC', () => {
  const v = svc('options-desk');
  for (const body of [{}, { currency: '' }, { currency: '   ' }, { currency: null }, { focus: 'all' }]) {
    const r = v.validate(body);
    assert.ok(r.error, `must refuse ${JSON.stringify(body)} instead of answering`);
    assert.equal(r.currency, undefined, 'must not fabricate a subject');
  }
});

test('options-desk: refusal routes the caller to the service they meant', () => {
  const v = svc('options-desk');
  assert.match(v.validate({}).error, /protocol-pulse/, 'missing param names the likely service');
  assert.match(v.validate({ currency: 'aave' }).error, /protocol-pulse/, 'a protocol name is routed, not just rejected');
  assert.match(v.validate({ currency: 'aave' }).error, /aave/i, 'echoes what was actually sent');
});

test('options-desk: a real request still works, case and whitespace tolerant', () => {
  const v = svc('options-desk');
  assert.deepEqual(v.validate({ currency: 'btc' }), { currency: 'BTC', focus: undefined });
  assert.equal(v.validate({ currency: ' eth ' }).currency, 'ETH');
  assert.equal(v.validate({ currency: 'SOL', focus: 'expiries' }).focus, 'expiries');
});

test('updown-pulse: a missing coin is refused, not defaulted to BTC', () => {
  const v = svc('updown-pulse');
  for (const body of [{}, { coin: '' }, { coin: null }]) {
    const r = v.validate(body);
    assert.ok(r.error);
    assert.equal(r.coin, undefined);
  }
  assert.match(v.validate({}).error, /perp-gate|protocol-pulse/, 'refusal names an alternative service');
  assert.match(v.validate({ coin: 'aave' }).error, /protocol-pulse/);
});

test('updown-pulse: a real request still works', () => {
  const v = svc('updown-pulse');
  assert.deepEqual(v.validate({ coin: 'eth' }), { coin: 'ETH' });
  assert.deepEqual(v.validate({ coin: 'BTC' }), { coin: 'BTC' });
});

test('no service declares a required param and then silently defaults it', () => {
  // Structural guard against re-introducing the bug elsewhere: for every REQUIRED string property,
  // validate() must reject an empty body rather than invent a value for it.
  for (const s of SERVICES) {
    const required = s.inputSchema?.required;
    if (!Array.isArray(required) || required.length === 0 || typeof s.validate !== 'function') continue;
    let out;
    try { out = s.validate({}); } catch { continue; } // a throw is also a refusal
    if (!out || out.error) continue; // refused — correct
    for (const key of required) {
      assert.equal(out[key], undefined, `${s.name}: required "${key}" was fabricated from an empty body`);
    }
  }
});
