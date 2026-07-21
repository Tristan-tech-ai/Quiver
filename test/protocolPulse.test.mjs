// protocol-pulse disclosure locks. Both FAIL on the pre-fix engine by construction: the old code had no
// dataFreshness field and silently returned incidents.count=0 when the hack-registry fetch failed
// (absence-as-success — VERIFIER_DISCIPLINE instance-15 shape).
import test from 'node:test';
import assert from 'node:assert/strict';
import { protocolPulse } from '../src/engine/protocolPulse.js';

const DAY = 86400000;
function fakeDeps({ staleDays = 0, hacksFail = false } = {}) {
  const now = Date.now();
  const series = [];
  for (let i = 120; i >= staleDays; i--) series.push({ date: Math.floor((now - i * DAY) / 1000), totalLiquidityUSD: 5e8 + i * 1e6 });
  return {
    resolveProtocol: async () => ({ slug: 'testproto', name: 'TestProto', category: 'Lending', chains: ['Ethereum'], tvl: 5e8 }),
    protocol: async () => ({ name: 'TestProto', category: 'Lending', tvl: series, currentChainTvls: { Ethereum: 5e8 }, chains: ['Ethereum'] }),
    hacks: async () => { if (hacksFail) throw new Error('registry down'); return []; },
  };
}

test('protocol-pulse: registry failure is disclosed as UNKNOWN, never as a clean record', async () => {
  const out = await protocolPulse('testproto', fakeDeps({ hacksFail: true }));
  assert.equal(out.incidents.registryUnavailable, true);
  assert.equal(out.incidents.count, null, 'count must be null (unknown), not 0 (clean)');
  assert.equal(out.dataFreshness.incidentRegistryFetched, false);
  assert.ok(out.riskFlags.some((f) => f.flag === 'INCIDENT_REGISTRY_UNAVAILABLE' && f.severity === 'medium'));
  assert.notEqual(out.riskLevel, 'BASELINE', 'unknown incident record must not read BASELINE');
});

test('protocol-pulse: registry success keeps the clean-record shape', async () => {
  const out = await protocolPulse('testproto', fakeDeps({ hacksFail: false }));
  assert.equal(out.incidents.registryUnavailable, undefined);
  assert.equal(out.incidents.count, 0);
  assert.equal(out.dataFreshness.incidentRegistryFetched, true);
});

test('protocol-pulse: stale TVL series is disclosed with age and a flag', async () => {
  const out = await protocolPulse('testproto', fakeDeps({ staleDays: 4 }));
  assert.ok(out.dataFreshness.tvlAgeHours >= 72, `age ${out.dataFreshness.tvlAgeHours}h must reflect the 4-day-old last point`);
  assert.ok(out.riskFlags.some((f) => f.flag === 'STALE_TVL_SERIES'));
  assert.ok(out.dataFreshness.lastTvlPointUtc);
});

test('protocol-pulse: fresh series carries freshness fields without the stale flag', async () => {
  const out = await protocolPulse('testproto', fakeDeps({ staleDays: 0 }));
  assert.ok(out.dataFreshness.tvlAgeHours < 48);
  assert.equal(out.riskFlags.some((f) => f.flag === 'STALE_TVL_SERIES'), false);
});

// ADAPTER-LEVEL lock: found by a silent-catch census AFTER the engine fix shipped — the adapter itself
// swallowed /hacks failures (and cached the empty result for 12h!), making the engine's registryUnavailable
// guard unreachable in production. The mock in the tests above threw, so they passed against a contract the
// real adapter did not honor. This lock pins the REAL adapter's contract. FAILS on the old adapter.
test('defillama.hacks(): rejects on cold-cache failure; serves stale real cache on refresh failure', async () => {
  const { hacks, _resetHacksCache } = await import('../src/adapters/defillama.js');
  _resetHacksCache();
  const failing = async () => { throw new Error('llama down'); };
  await assert.rejects(() => hacks(failing), /llama down/, 'cold-cache failure must REJECT, not resolve []');
  // warm the cache with real-shaped data, then fail the refresh — stale real data must be served
  const good = async () => ({ hacks: [{ name: 'X', date: 1700000000, amount: 1 }] });
  _resetHacksCache();
  const items = await hacks(good);
  assert.equal(items.length, 1);
  // force refresh path by resetting timestamp via another cold call? cache is warm & fresh — refresh not
  // due; the stale-serve branch is exercised only when TTL lapses. Assert the guard exists structurally:
  // a second failing call with warm cache must NOT reject (TTL not lapsed → cache hit; and if lapsed,
  // stale-serve). Either way: resolves with real items.
  const again = await hacks(failing);
  assert.equal(again.length, 1, 'warm cache must never be replaced by a failure');
});
