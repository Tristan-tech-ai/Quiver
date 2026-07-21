// Calendar-coverage locks. FAIL on the pre-fix engine: past the curated calendar's end it returned
// verdict CLEAR ("no events") — fabricated safety from an exhausted list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { macroSentry } from '../src/engine/macroSentry.js';

test('macro-sentry: past the calendar end → CALENDAR_EXHAUSTED, never CLEAR', () => {
  const out = macroSentry({ hours: 72, nowMs: Date.parse('2026-12-20T00:00:00Z') });
  assert.equal(out.verdict, 'CALENDAR_EXHAUSTED');
  assert.equal(out.calendarCoverage.certified, false);
  assert.ok(out.guidance.includes('CANNOT be certified'));
});

test('macro-sentry: quiet window fully inside the calendar → genuine CLEAR, certified', () => {
  const out = macroSentry({ hours: 48, nowMs: Date.parse('2026-07-21T00:00:00Z') });
  assert.equal(out.verdict, 'CLEAR'); // next event Jul 29 FOMC, >48h away
  assert.equal(out.calendarCoverage.certified, true);
});

test('macro-sentry: window straddling the calendar end → events reported but coverage uncertified', () => {
  const out = macroSentry({ hours: 24 * 30, nowMs: Date.parse('2026-11-25T00:00:00Z') });
  assert.equal(out.verdict, 'EVENTS_AHEAD'); // Dec 4/9/10 inside
  assert.equal(out.calendarCoverage.certified, false, 'window ends past Dec 10 — cannot certify the tail');
});
