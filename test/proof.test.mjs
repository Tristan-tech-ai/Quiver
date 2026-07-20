import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proofEnvelope } from '../src/engine/proof.js';
// No QUIVER_SIGNING_KEY here -> T0 path (node runs each test file in its own process).

test('proof: echoes the EXACT inputs so "reproduce" is self-contained, not a bare claim', () => {
  const inputs = { a: 1, b: 'x', nested: { z: 2 } };
  const env = proofEnvelope('demo', inputs, { value: 42, checks: [{ name: 'inv', pass: true }] }, '0.1.0');
  assert.deepEqual(env.proof.inputs, inputs, 'proof.inputs must echo the hashed inputs');
  assert.ok(env.proof.contentHash);
  assert.ok(env.proof.reproduce.includes('proof.inputs'));
  assert.ok(env.proof.attestation.startsWith('T0'), 'no key configured -> T0');
  assert.equal(env.proof.allSelfChecksPass, true);
});

test('proof: content hash is deterministic and input-sensitive', () => {
  const r = { v: 1, checks: [] };
  const a = proofEnvelope('e', { x: 1 }, r, '0');
  const b = proofEnvelope('e', { x: 1 }, r, '0');
  const c = proofEnvelope('e', { x: 2 }, r, '0');
  assert.equal(a.proof.contentHash, b.proof.contentHash, 'same inputs+result -> same hash');
  assert.notEqual(a.proof.contentHash, c.proof.contentHash, 'changed input -> changed hash');
});

test('proof: no checks -> allSelfChecksPass is null (honest "nothing to attest", not a false pass)', () => {
  const env = proofEnvelope('e', {}, { v: 1 }, '0');
  assert.equal(env.proof.allSelfChecksPass, null);
});

test('proof: a failing self-check surfaces as allSelfChecksPass=false', () => {
  const env = proofEnvelope('e', {}, { v: 1, checks: [{ name: 'x', pass: true }, { name: 'y', pass: false }] }, '0');
  assert.equal(env.proof.allSelfChecksPass, false);
});
