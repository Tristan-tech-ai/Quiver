// Observation envelope (opening #2) + the wire-form hash fix. The consumer's own verification recipe —
// recompute the contentHash from the response AS RECEIVED (post JSON serialization) — must succeed. On
// pre-fix code the proofEnvelope hash was taken over the raw in-memory object, so any result containing an
// undefined-valued key or a Date verified in memory but FALSE-FAILED on the wire → the proof test below
// fails on old code (fail-on-revert lock); observationEnvelope is a new export (import fails on old code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { proofEnvelope, observationEnvelope, _internal } from '../src/engine/proof.js';
import { createRiskBrain } from '../sdk/index.js';

const { canonical, sha256 } = _internal;
const wire = (x) => JSON.parse(JSON.stringify(x)); // what res.json delivers to the consumer

// A result with every wire-mutating value class: undefined key (dropped), Date (→ISO), NaN (→null).
const trickyResult = () => ({ verdict: 'OK', maybe: undefined, at: new Date('2026-07-21T10:00:00Z'), bad: NaN, checks: [{ name: 'x', pass: true }] });

test('proofEnvelope: contentHash verifies from the response AS RECEIVED (undefined/Date/NaN survive the wire)', () => {
  const resp = wire(proofEnvelope('unit-test', { a: 1, skip: undefined }, trickyResult(), '9.9'));
  const { proof, ...result } = resp;
  const recomputed = sha256(canonical({ engine: proof.engine, codeHash: proof.codeHash, inputs: proof.inputs, result }));
  assert.equal(recomputed, proof.contentHash, 'consumer recompute per proof.verifyContentHash must match');
  assert.ok(proof.verifyContentHash.includes('`proof`'), 'recipe names the envelope key to strip');
});

test('observationEnvelope: contentHash verifies from the response AS RECEIVED; semantics are honest', () => {
  const resp = wire(observationEnvelope('options-desk', { currency: 'BTC' }, trickyResult(), '9.9'));
  const { observation, ...result } = resp;
  const recomputed = sha256(canonical({ engine: observation.engine, codeHash: observation.codeHash, observedAtUtc: observation.observedAtUtc, inputs: observation.inputs, result }));
  assert.equal(recomputed, observation.contentHash, 'consumer recompute per observation.verifyContentHash must match');
  assert.equal(observation.kind, 'OBSERVATION');
  assert.equal(observation.deterministic, false, 'live data must NOT claim determinism');
  assert.ok(/NOT re-runnable/.test(observation.semantics), 'the non-reproducibility is stated, not hidden');
  assert.ok(/EAS/.test(observation.semantics), 'anchoring path stated');
  assert.equal(observation.allSelfChecksPass, true, 'checks array aggregated');
});

test('observationEnvelope: self-check failure surfaces; non-object results pass through unwrapped', () => {
  const r = observationEnvelope('t', {}, { checks: [{ name: 'a', pass: false }] }, '1');
  assert.equal(r.observation.allSelfChecksPass, false);
  assert.equal(observationEnvelope('t', {}, null, '1'), null, 'null result → no envelope fabricated');
  const arr = [1, 2]; assert.equal(observationEnvelope('t', {}, arr, '1'), arr, 'array result → untouched');
});

test('sdk.verify(): accepts a genuine observation envelope, rejects a tampered one, refuses reproduce()', () => {
  const rb = createRiskBrain();
  const resp = wire(observationEnvelope('tape-pulse', { chain: 'sol', address: 'X' }, trickyResult(), '9.9'));
  const ok = rb.verify(resp);
  assert.deepEqual({ valid: ok.valid, kind: ok.envelopeKind }, { valid: true, kind: 'observation' });
  const tampered = { ...resp, verdict: 'FLIPPED' };
  assert.equal(rb.verify(tampered).contentHashOk, false, 'one changed field must break the hash');
  assert.match(rb.reproduce(resp).reason, /not re-runnable/, 'reproduce() refuses live snapshots honestly');
});

test('proof vs observation: the two claims stay distinct (deterministic re-run vs committed snapshot)', () => {
  const p = proofEnvelope('e', {}, { v: 1 }, '1');
  const o = observationEnvelope('e', {}, { v: 1 }, '1');
  assert.equal(p.proof.deterministic, true);
  assert.ok(/re-run/i.test(p.proof.reproduce), 'proof promises reproduction');
  assert.equal(o.observation.deterministic, false);
  assert.ok(o.observation.observedAtUtc && !p.proof.observedAtUtc, 'observation is timestamped; proof needs no clock');
});
