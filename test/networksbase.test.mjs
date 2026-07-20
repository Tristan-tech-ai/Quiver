// Base activation via the Coinbase CDP facilitator. Set the Base env BEFORE importing config (config reads
// env at module load). Node runs each test file in its own process, so this env does not affect other tests.
// Values below are the real Base mainnet USDC address + placeholder CDP credentials — enough to exercise the
// activation logic (the presence of both CDP keys is what gates the rail; their validity is not checked here).
process.env.BASE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
process.env.CDP_API_KEY_ID = 'test-key-id';
process.env.CDP_API_KEY_SECRET = 'test-key-secret';

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { config } = await import('../src/config.js');

test('networks: Base activates when BASE_ASSET + CDP keys are set', () => {
  assert.equal(config.networks.length, 2, 'primary + Base');
});

test('networks: adding Base PRESERVES the primary as entry 0 (X Layer loop untouched)', () => {
  const p = config.networks[0];
  assert.equal(p.network, 'eip155:196');
  assert.equal(p.facilitatorAuth, 'okx');
  assert.equal(p.key, 'xlayer');
});

test('networks: the Base entry is CDP-correct and defaults sensibly', () => {
  const b = config.networks[1];
  assert.equal(b.network, 'eip155:8453');             // CAIP-2 for x402 v2 (certified against CDP /supported)
  assert.equal(b.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(b.assetDecimals, 6);
  assert.equal(b.facilitatorAuth, 'cdp');             // default is CDP keys, not a static bearer token
  assert.equal(b.facilitatorBase, 'https://api.cdp.coinbase.com/platform/v2/x402'); // CDP default URL
  assert.equal(b.payTo, config.networks[0].payTo);    // falls back to primary payTo when BASE_PAY_TO unset
  assert.equal(b.eip712Name, 'USD Coin');             // USDC domain default
});
