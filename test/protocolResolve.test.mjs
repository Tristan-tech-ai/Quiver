// Protocol resolution: a famous legacy name must reach the real protocol, and an ambiguous name must
// not land on a lookalike minnow. Both FAIL on the pre-fix resolver, which had no aliases and took the
// first substring hit in registry order ("maker" -> Swaap Maker V2 at $0.01B instead of Sky at $5.95B).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickProtocol } from '../src/adapters/defillama.js';

// A miniature registry shaped like DefiLlama's /protocols, with the lookalikes that caused the bug
// deliberately placed BEFORE the real protocols, as they are in the live list.
const INDEX = [
  { slug: 'swaap-maker-v2', name: 'Swaap Maker V2', tvl: 1.0e7 },
  { slug: 'maker-mock-dust', name: 'Maker Mock', tvl: 5.0e5 },
  { slug: 'sky-lending', name: 'Sky Lending', tvl: 5.95e9 },
  { slug: 'eigencloud', name: 'EigenCloud', tvl: 4.99e9 },
  { slug: 'fluid-lending', name: 'Fluid Lending', tvl: 6.5e8 },
  { slug: 'aave-v3', name: 'Aave V3', tvl: 1.36e10 },
  { slug: 'aave-v2', name: 'Aave V2', tvl: 2.0e7 },
  { slug: 'uniswap-v3', name: 'Uniswap V3', tvl: 1.48e9 },
];

test('renamed protocols resolve from their legacy names', () => {
  assert.equal(pickProtocol(INDEX, 'makerdao').slug, 'sky-lending');
  assert.equal(pickProtocol(INDEX, 'maker dao').slug, 'sky-lending');
  assert.equal(pickProtocol(INDEX, 'eigenlayer').slug, 'eigencloud');
  assert.equal(pickProtocol(INDEX, 'EigenLayer').slug, 'eigencloud');
  assert.equal(pickProtocol(INDEX, 'instadapp').slug, 'fluid-lending');
});

test('an ambiguous name resolves to the real protocol, not a same-named minnow', () => {
  const r = pickProtocol(INDEX, 'maker');
  assert.equal(r.slug, 'sky-lending', 'must not return Swaap Maker V2 ($0.01B) for "maker"');
});

test('substring fallback ranks by TVL instead of registry order', () => {
  assert.equal(pickProtocol(INDEX, 'aave').slug, 'aave-v3', 'the $13.6B V3, not the $0.02B V2');
});

test('exact slug and exact name still win over everything', () => {
  assert.equal(pickProtocol(INDEX, 'aave-v2').slug, 'aave-v2');
  assert.equal(pickProtocol(INDEX, 'Swaap Maker V2').slug, 'swaap-maker-v2');
  assert.equal(pickProtocol(INDEX, 'uniswap-v3').slug, 'uniswap-v3');
});

test('a genuinely unknown protocol still resolves to nothing (NOT_FOUND stays honest)', () => {
  assert.equal(pickProtocol(INDEX, '0xnot-a-protocol'), undefined);
  assert.equal(pickProtocol([], 'aave'), undefined);
});
