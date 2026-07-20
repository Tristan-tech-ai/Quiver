// The signing key must be set BEFORE importing (proof.js caches the signer on first use). Node runs each test
// file in its own process, so this env is isolated. Fixture: the standard anvil account #0.
process.env.QUIVER_SIGNING_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTypedData } from 'ethers';
import { riskAttest } from '../src/engine/riskAttest.js';

const hashes = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32), '44'.repeat(32)];
const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // anvil #0
const TYPES = { QuiverRiskAttestation: [{ name: 'merkleRoot', type: 'bytes32' }, { name: 'itemCount', type: 'uint256' }, { name: 'engineVersion', type: 'string' }] };

test('risk-attest: emits an EIP-712 typed (EAS-ready) attestation over the root, recoverable to the signer', () => {
  const r = riskAttest({ contentHashes: hashes });
  assert.ok(r.easAttestation, 'EAS attestation present when a signing key is configured');
  assert.equal(r.easAttestation.signer, SIGNER);
  // Independently recover the signer from the typed data — the exact check a third party (or EAS) would run.
  const recovered = verifyTypedData(r.easAttestation.domain, TYPES, r.easAttestation.message, r.easAttestation.signature);
  assert.equal(recovered, SIGNER, 'typed signature recovers to the Quiver signer');
  assert.equal(r.easAttestation.message.merkleRoot, r.merkleRoot);
  assert.equal(r.easAttestation.message.itemCount, hashes.length);
});

test('risk-attest: the EIP-712 attestation is deterministic (same batch → same signature, re-runnable)', () => {
  assert.equal(riskAttest({ contentHashes: hashes }).easAttestation.signature, riskAttest({ contentHashes: hashes }).easAttestation.signature);
});

test('risk-attest: all self-checks pass including the EIP-712 signature recovery check', () => {
  const r = riskAttest({ contentHashes: hashes });
  assert.equal(r.checks.length, 3);
  assert.ok(r.checks.every((c) => c.pass));
});
