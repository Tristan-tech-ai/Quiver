import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventVol } from '../src/engine/eventVol.js';

test('event-vol: 1σ move = spot·σ·√T and straddle self-check passes', () => {
  const r = eventVol({ spot: 64000, atmIvPct: 60, daysToEvent: 1 });
  const expected1sig = 64000 * 0.6 * Math.sqrt(1 / 365);
  assert.ok(Math.abs(r.expectedMove.oneSigmaUsd - expected1sig) < 1, `1σ=${r.expectedMove.oneSigmaUsd}`);
  assert.ok(r.checks[0].pass, 'straddle == numerical E|ΔS| must hold');
});

test('event-vol: straddle ≈ √(2/π)·(1σ move) for short horizons', () => {
  const r = eventVol({ spot: 64000, atmIvPct: 60, daysToEvent: 1 });
  const ratio = r.expectedMove.straddleImpliedAbsMoveUsd / r.expectedMove.oneSigmaUsd;
  assert.ok(Math.abs(ratio - Math.sqrt(2 / Math.PI)) < 0.01, `ratio=${ratio}`);
});

test('event-vol: event isolation from the term structure (Wright) — after>before variance', () => {
  const r = eventVol({ spot: 64000, atmIvPct: 65, daysToEvent: 8, ivBeforePct: 55, daysBefore: 7, ivAfterPct: 70, daysAfter: 8 });
  assert.equal(r.eventIsolation.valid, true);
  assert.ok(r.eventIsolation.eventMovePct > 0);
  // event var = 0.70²·(8/365) − 0.55²·(7/365); move = √var
  const ev = 0.7 * 0.7 * (8 / 365) - 0.55 * 0.55 * (7 / 365);
  assert.ok(Math.abs(r.eventIsolation.eventMovePct - 100 * Math.sqrt(ev)) < 1e-2);
});

test('event-vol: an inverted term structure is disclosed, not fabricated', () => {
  const r = eventVol({ spot: 64000, atmIvPct: 60, daysToEvent: 8, ivBeforePct: 80, daysBefore: 7, ivAfterPct: 50, daysAfter: 8 });
  assert.equal(r.eventIsolation.valid, false);
  assert.equal(r.eventIsolation.eventMove1SigmaUsd, null, 'no fabricated event move when variance is negative');
});

test('event-vol: prob-beyond thresholds are valid probabilities', () => {
  const r = eventVol({ spot: 64000, atmIvPct: 60, daysToEvent: 5, thresholdsPct: [1, 3, 10] });
  for (const t of r.probabilityMoveBeyond) assert.ok(t.probPct >= 0 && t.probPct <= 100);
  // larger threshold -> smaller probability
  const p = r.probabilityMoveBeyond.map((t) => t.probPct);
  assert.ok(p[0] >= p[1] && p[1] >= p[2]);
});

test('event-vol: rejects missing inputs (no fabrication)', () => {
  assert.equal(eventVol({ spot: 64000 }).ok, false);
});
