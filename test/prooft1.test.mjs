// T1 signing test. The key is set BEFORE importing proof.js because the signer is cached lazily on first
// use. This is the ONLY test file that touches proof.js, so setting the env here does not affect others.
// The key below is the well-known anvil/hardhat account #0 — a PUBLIC test fixture, never a real key.
process.env.QUIVER_SIGNING_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMessage } from 'ethers';
const { proofEnvelope } = await import('../src/engine/proof.js');

const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

test('proof T1: signs the content hash; signature independently recovers to the signer', () => {
  const result = { value: 42, checks: [{ name: 'demo-invariant', pass: true }] };
  const env = proofEnvelope('demo-engine', { a: 1 }, result, '0.1.0');
  assert.ok(env.proof.signature, 'signature present when a key is configured');
  assert.equal(env.proof.signature.signer, ANVIL0);
  assert.ok(env.proof.attestation.startsWith('T1'), `attestation=${env.proof.attestation}`);
  // Verify the signature over the contentHash WITHOUT trusting the envelope's own claim.
  const recovered = verifyMessage(env.proof.contentHash, env.proof.signature.signature);
  assert.equal(recovered, ANVIL0, 'signature must recover to the configured signer address');
});

test('proof T1: signature is deterministic (RFC-6979) for identical content', () => {
  const r = { value: 7, checks: [] };
  const a = proofEnvelope('demo', { x: 1 }, r, '0');
  const b = proofEnvelope('demo', { x: 1 }, r, '0');
  assert.equal(a.proof.contentHash, b.proof.contentHash);
  assert.equal(a.proof.signature.signature, b.proof.signature.signature);
});

test('proof T1: a tampered result changes the content hash and breaks the signature match', () => {
  const env = proofEnvelope('demo', { x: 1 }, { value: 1, checks: [] }, '0');
  // If someone swaps the result but keeps the old signature, verification no longer matches the new hash.
  const tamperedHash = env.proof.contentHash.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  const recovered = verifyMessage(tamperedHash, env.proof.signature.signature);
  assert.notEqual(recovered, ANVIL0, 'a tampered content hash must not verify to the signer');
});
