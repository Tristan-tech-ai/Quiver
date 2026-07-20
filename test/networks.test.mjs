import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, atomicAmount } from '../src/config.js';

test('networks: default is single-network X Layer (backward compatible, no Base leak)', () => {
  assert.equal(config.networks.length, 1, 'exactly one network unless Base is configured');
  const n = config.networks[0];
  assert.equal(n.network, 'eip155:196');
  assert.equal(n.facilitatorAuth, 'okx');
  // flat fields still mirror the primary network
  assert.equal(config.network, 'eip155:196');
  assert.equal(config.asset, n.asset);
  assert.equal(config.payTo, n.payTo);
});

test('atomicAmount: decimals param defaults to primary, and is explicit-safe', () => {
  assert.equal(atomicAmount('0.01'), '10000');          // 6 decimals default
  assert.equal(atomicAmount('0.01', 6), '10000');
  assert.equal(atomicAmount('1'), '1000000');
  assert.equal(atomicAmount('0.000001', 6), '1');
});
