// FAIL-SAFE gate: BASE_ASSET is set but NO usable facilitator credential is present. Base MUST stay DORMANT
// — never advertise a rail we cannot settle (that would 402 a real payer *after* they signed). The service
// must fall back to byte-identical single-network X Layer. Env is set before importing config; Node isolates
// each test file in its own process.
process.env.BASE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base — asset alone is NOT enough
delete process.env.CDP_API_KEY_ID;
delete process.env.CDP_API_KEY_SECRET;
delete process.env.BASE_FACILITATOR_TOKEN;
delete process.env.BASE_FACILITATOR_AUTH; // default 'cdp' -> requires CDP keys, which are absent

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { config } = await import('../src/config.js');

test('networks: Base stays DORMANT when BASE_ASSET is set but CDP keys are missing', () => {
  assert.equal(config.networks.length, 1, 'X Layer only — an unsettleable Base rail must never be advertised');
  assert.equal(config.networks[0].key, 'xlayer');
  assert.equal(config.networks[0].facilitatorAuth, 'okx');
});
