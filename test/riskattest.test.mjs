import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { riskAttest, verifyInclusion } from '../src/engine/riskAttest.js';

const mk = (n) => Array.from({ length: n }, (_, i) => createHash('sha256').update('item' + i).digest('hex'));

test('risk-attest: no self-check fails for 1..8 leaves, and a check that cannot run says so', () => {
  for (const n of [1, 2, 3, 4, 5, 8]) {
    const r = riskAttest({ contentHashes: mk(n) });
    assert.equal(r.leafCount, n);
    // Same semantics the proof envelope uses: a check that did not run is not a failure. Asserting
    // `every(c => c.pass)` instead would have forced the internal-node check to claim a pass at
    // n<=2, where there is no internal node to present — which is how it came to certify nothing.
    assert.ok(r.checks.every((c) => c.pass !== false), `n=${n}: a check FAILED`);
    const node = r.checks.find((c) => /INTERNAL NODE/.test(c.name));
    if (n <= 2) {
      assert.equal(node.skipped, true, `n=${n}: no internal node exists, so the check must be marked skipped, not passed`);
      assert.equal(node.pass, null);
      assert.match(node.reason, /no internal node/);
    } else {
      assert.equal(node.pass, true, `n=${n}: the check must actually run`);
      assert.ok(!node.skipped);
    }
  }
});

test('risk-attest: every returned proof independently reconstructs the root', () => {
  const r = riskAttest({ contentHashes: mk(5) });
  const root = r.merkleRoot.slice(2);
  for (const a of r.attestations) {
    assert.ok(verifyInclusion(a.contentHash.slice(2), a.proof.map((p) => p.slice(2)), root), `leaf ${a.index}`);
  }
});

test('risk-attest: a fabricated non-member leaf does NOT verify (soundness)', () => {
  const r = riskAttest({ contentHashes: mk(5) });
  const evil = createHash('sha256').update('EVIL').digest('hex');
  assert.equal(verifyInclusion(evil, r.attestations[0].proof.map((p) => p.slice(2)), r.merkleRoot.slice(2)), false);
});

test('risk-attest: accepts proof envelopes and extracts contentHash', () => {
  const r = riskAttest({ items: [{ proof: { contentHash: 'aa'.repeat(32) } }, { contentHash: 'bb'.repeat(32) }] });
  assert.equal(r.leafCount, 2);
  assert.ok(r.checks.every((c) => c.pass !== false));
});

test('risk-attest: discloses duplicate leaves and rejects empty input', () => {
  assert.equal(riskAttest({ contentHashes: ['aa'.repeat(32), 'aa'.repeat(32)] }).duplicateLeaves, 1);
  assert.equal(riskAttest({ items: [] }).ok, false);
});

test('risk-attest: root is deterministic for the same batch', () => {
  const hs = mk(6);
  assert.equal(riskAttest({ contentHashes: hs }).merkleRoot, riskAttest({ contentHashes: hs }).merkleRoot);
});
