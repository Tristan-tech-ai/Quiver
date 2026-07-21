// Fixes from the day-1 buyer-QA session (sentinel desk). Each test FAILS on the pre-fix code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isChargeable, settledStatus } from '../src/x402.js';
import { SERVICES } from '../src/services.js';
import { protocolPulse } from '../src/engine/protocolPulse.js';

// BUG-010 — billing contract: an input the engine rejected (ok:false) is NOT a delivered result → free.
test('BUG-010 isChargeable: ok:false is free; a delivered answer is charged', () => {
  assert.equal(isChargeable({ ok: false, errors: ['bad input'] }), false);
  assert.equal(isChargeable({ ok: true, recommendedSize: 43 }), true);
  assert.equal(isChargeable({ verdict: 'CLEAN' }), true, 'no ok field = a real answer, chargeable');
  assert.equal(isChargeable({ ok: true, hasEdge: false }), true, 'a valid negative verdict is still a delivered answer');
  assert.equal(isChargeable(null), true, 'defensive: never skip settlement on a malformed result');
});

// BUG-005 — settle receipt must never say success:true alongside status:"timeout".
test('BUG-005 settledStatus: facilitator "timeout" normalizes to a settled label', () => {
  assert.equal(settledStatus({ status: 'timeout' }), 'settled');
  assert.equal(settledStatus({ status: 'settled' }), 'settled');
  assert.equal(settledStatus({ status: 'success' }), 'success');
  assert.equal(settledStatus({ status: 'confirmed' }), 'confirmed');
  assert.equal(settledStatus({}), 'settled');
});

// BUG-008 — macro-sentry is time-filtered (events still ahead of "now") → observation, not proof.
test('BUG-008 macro-sentry ships an observation envelope (not a re-runnable proof)', () => {
  const svc = SERVICES.find((s) => s.name === 'macro-sentry');
  const r = svc.run({ hours: 72 });
  assert.ok(r.observation, 'observation envelope present');
  assert.equal(r.proof, undefined, 'must NOT claim a deterministic proof');
  assert.equal(r.observation.deterministic, false);
  assert.ok(r.observation.observedAtUtc, 'timestamped');
});

// BUG-009 — a transient upstream (DefiLlama) failure returns a clean DATA_UNAVAILABLE, never a raw throw/500.
test('BUG-009 protocol-pulse: upstream throw → DATA_UNAVAILABLE ok:false (both fetch stages)', async () => {
  const stage1Boom = { resolveProtocol: async () => { throw new Error('ETIMEDOUT'); }, protocol: async () => ({}), hacks: async () => [] };
  const r1 = await protocolPulse('uniswap', stage1Boom);
  assert.equal(r1.verdict, 'DATA_UNAVAILABLE');
  assert.equal(r1.ok, false, 'a non-answer must be free under the billing contract');

  const stage2Boom = { resolveProtocol: async () => ({ slug: 'uniswap' }), protocol: async () => { throw new Error('502 bad gateway'); }, hacks: async () => [] };
  const r2 = await protocolPulse('uniswap', stage2Boom);
  assert.equal(r2.verdict, 'DATA_UNAVAILABLE');

  // NOT_FOUND (a real "we looked, doesn't exist") stays distinct and is not conflated with unavailability.
  const notFound = { resolveProtocol: async () => null, protocol: async () => ({}), hacks: async () => [] };
  const r3 = await protocolPulse('nope', notFound);
  assert.equal(r3.verdict, 'NOT_FOUND');
});

// BUG-004 — perp-gate & portfolio-gate express their OR-constraints in the schema (machine-checkable),
// not only inside validate().
test('BUG-004 schemas express OR-constraints a buyer validator can see', () => {
  const perp = SERVICES.find((s) => s.name === 'perp-gate');
  assert.ok(Array.isArray(perp.inputSchema.allOf), 'perp-gate declares allOf of anyOf groups');
  const groups = perp.inputSchema.allOf;
  assert.ok(groups.some((g) => g.anyOf?.some((o) => o.required?.includes('margin')) && g.anyOf?.some((o) => o.required?.includes('leverage'))), 'collateral margin|leverage');
  assert.ok(groups.some((g) => g.anyOf?.some((o) => o.required?.includes('size')) && g.anyOf?.some((o) => o.required?.includes('notional'))), 'size|notional');

  const pg = SERVICES.find((s) => s.name === 'portfolio-gate');
  assert.ok(pg.inputSchema.anyOf?.some((o) => o.required?.includes('positions')), 'positions option');
  assert.ok(pg.inputSchema.anyOf?.some((o) => o.required?.includes('account')), 'account option');
});
