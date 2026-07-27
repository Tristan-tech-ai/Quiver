// Two findings from an adversarial live-access review of the deployed service. Both are about the
// envelope claiming more than it delivered, and both FAIL on the pre-fix code.
//
// 1. A live-provenance block was sealed inside a DETERMINISTIC proof envelope. `proof.inputs` cannot
//    produce it, so re-running the engine on those inputs yields a different content hash — from an
//    envelope whose own text says a mismatch means the response was altered. The reviewer ran the
//    published recipe and got REPRODUCED: NO on an honest answer. This had already been found and
//    fixed at three call sites on three separate occasions; the fourth was the free MCP path. Fixing
//    call sites one at a time demonstrably did not work, so the rule now lives in proofEnvelope.
//
// 2. `allSelfChecksPass` read an explicitly SKIPPED check as a passing one, so a response where
//    nothing was checked published `true`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { proofEnvelope, observationEnvelope, _internal } from '../src/engine/proof.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test('a result carrying live provenance is never sealed as a deterministic proof', () => {
  const inputs = { side: 'long', entryPrice: 64000, size: 1, leverage: 10 };
  const result = {
    ok: true,
    liquidationPrice: 58329.11,
    checks: [{ name: 'liquidation-invariant', residual: 2.05e-12, tolerance: 0.064, pass: true }],
    live: { venue: 'hyperliquid', markPrice: 65105.9, fetchedAt: '2026-07-27T10:00:00.000Z' },
  };
  const env = proofEnvelope('perp-gate', inputs, result, '0.1.0');
  assert.equal(env.proof, undefined, 'a live read is not re-runnable, so it must not carry a proof envelope');
  assert.ok(env.observation, 'it must carry the observation envelope instead');
  assert.equal(env.observation.deterministic, false);
  assert.ok(env.observation.observedAtUtc, 'and the instant it was observed');
});

test('the deterministic path is untouched when nothing was fetched', () => {
  const inputs = { side: 'long', entryPrice: 64000, size: 1, leverage: 10 };
  const result = { ok: true, liquidationPrice: 58329.11, checks: [{ name: 'x', pass: true }] };
  const env = proofEnvelope('perp-gate', inputs, result, '0.1.0');
  assert.ok(env.proof, 'a call with no live read is still a proof');
  assert.equal(env.proof.deterministic, true);
});

test('the content hash of a proof is reproducible from its own echoed inputs', () => {
  // The property the whole service is built on, asserted directly: re-running produces the same
  // result object, and hashing it the documented way reproduces the published contentHash.
  const inputs = { side: 'long', entryPrice: 64000, size: 1, leverage: 10 };
  const compute = () => ({ ok: true, liquidationPrice: 58329.11, checks: [{ name: 'x', pass: true }] });
  const env = proofEnvelope('perp-gate', inputs, compute(), '0.1.0');
  const { proof, ...served } = env;
  const recomputed = sha256(_internal.canonical({
    engine: 'perp-gate', codeHash: proof.codeHash, inputs: proof.inputs, result: JSON.parse(JSON.stringify(compute())),
  }));
  assert.equal(recomputed, proof.contentHash, 'the published recipe must reproduce the published hash');
});

test('allSelfChecksPass is null — not true — when every check was skipped', () => {
  const result = {
    ok: true,
    adverseExecutionBps: 166.7,
    checks: [{ name: 'constant-product invariant', skipped: true, pass: null, reason: 'reference mode: no pool state' }],
  };
  const env = proofEnvelope('exec-verify', { fairPrice: 3.0 }, result, '0.1.0');
  assert.equal(env.proof.allSelfChecksPass, null,
    'nothing was checked, so the honest answer is "nothing conclusive", not "everything held"');
  assert.doesNotMatch(env.proof.attestation, /self-checked/,
    'and the attestation must not advertise a self-check that never ran');
  assert.match(env.proof.attestation, /no self-check was asserted/);
});

test('a failed check still reads false, and an all-passing set still reads true', () => {
  const failed = proofEnvelope('lp-risk', {}, { ok: true, checks: [{ name: 'a', pass: true }, { name: 'b', pass: false }] }, '0');
  assert.equal(failed.proof.allSelfChecksPass, false);
  const passed = proofEnvelope('lp-risk', {}, { ok: true, checks: [{ name: 'a', pass: true }] }, '0');
  assert.equal(passed.proof.allSelfChecksPass, true);
  assert.match(passed.proof.attestation, /self-checked/);
});

test('the same skipped-check rule holds on the observation envelope', () => {
  // The branch next door. Fixing one envelope and not the other is the exact pattern that produced
  // finding 1 above, four times.
  const env = observationEnvelope('perp-gate', {}, { ok: true, checks: [{ name: 'x', skipped: true, pass: null }] }, '0');
  assert.equal(env.observation.allSelfChecksPass, null);
});
