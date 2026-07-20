// A DOUBLE-0x prefix ("0x0x…") is a common paste mistake — the exact one that kept the live key at T0.
// The signer must normalize it and still produce the correct signature. Public anvil#0 fixture key.
process.env.QUIVER_SIGNING_KEY = '0x0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMessage } from 'ethers';
const { proofEnvelope } = await import('../src/engine/proof.js');

const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

test('proof: a double-0x-prefixed key is normalized and signs to the correct address', () => {
  const env = proofEnvelope('demo', { a: 1 }, { v: 1, checks: [] }, '0');
  assert.ok(env.proof.signature, 'double-0x key must still activate T1 after normalization');
  assert.equal(env.proof.signature.signer, ANVIL0);
  assert.equal(verifyMessage(env.proof.contentHash, env.proof.signature.signature), ANVIL0);
  assert.ok(env.proof.attestation.startsWith('T1'));
});
