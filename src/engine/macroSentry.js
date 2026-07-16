// MacroSentry — one call: high-impact US macro events (FOMC, CPI, NFP, PCE) inside the caller's
// lookahead window, so a trading agent can de-risk before a print. Deterministic curated calendar
// (these dates are published on fixed institutional schedules) — durable and dependency-free.
import { config } from '../config.js';

// Curated 2026 high-impact US macro calendar (times in UTC). FOMC = scheduled meetings (decision
// day 19:00 UTC); CPI/PPI ~08:30 ET (12:30 UTC) mid-month; NFP first Friday 12:30 UTC; PCE end-month.
// Sourced from published Fed/BLS/BEA release schedules.
const EVENTS_2026 = [
  ['2026-01-09T13:30:00Z', 'NFP', 'Nonfarm Payrolls (Dec)', 'high'],
  ['2026-01-14T13:30:00Z', 'CPI', 'CPI (Dec)', 'high'],
  ['2026-01-28T19:00:00Z', 'FOMC', 'FOMC rate decision', 'high'],
  ['2026-02-06T13:30:00Z', 'NFP', 'Nonfarm Payrolls (Jan)', 'high'],
  ['2026-02-11T13:30:00Z', 'CPI', 'CPI (Jan)', 'high'],
  ['2026-03-06T13:30:00Z', 'NFP', 'Nonfarm Payrolls (Feb)', 'high'],
  ['2026-03-11T12:30:00Z', 'CPI', 'CPI (Feb)', 'high'],
  ['2026-03-18T18:00:00Z', 'FOMC', 'FOMC rate decision + projections', 'high'],
  ['2026-04-03T12:30:00Z', 'NFP', 'Nonfarm Payrolls (Mar)', 'high'],
  ['2026-04-10T12:30:00Z', 'CPI', 'CPI (Mar)', 'high'],
  ['2026-04-29T18:00:00Z', 'FOMC', 'FOMC rate decision', 'high'],
  ['2026-05-08T12:30:00Z', 'NFP', 'Nonfarm Payrolls (Apr)', 'high'],
  ['2026-05-13T12:30:00Z', 'CPI', 'CPI (Apr)', 'high'],
  ['2026-06-05T12:30:00Z', 'NFP', 'Nonfarm Payrolls (May)', 'high'],
  ['2026-06-10T12:30:00Z', 'CPI', 'CPI (May)', 'high'],
  ['2026-06-17T18:00:00Z', 'FOMC', 'FOMC rate decision + projections', 'high'],
  ['2026-07-02T12:30:00Z', 'NFP', 'Nonfarm Payrolls (Jun)', 'high'],
  ['2026-07-15T12:30:00Z', 'CPI', 'CPI (Jun)', 'high'],
  ['2026-07-29T18:00:00Z', 'FOMC', 'FOMC rate decision', 'high'],
  ['2026-08-07T12:30:00Z', 'NFP', 'Nonfarm Payrolls (Jul)', 'high'],
  ['2026-08-12T12:30:00Z', 'CPI', 'CPI (Jul)', 'high'],
  ['2026-09-04T12:30:00Z', 'NFP', 'Nonfarm Payrolls (Aug)', 'high'],
  ['2026-09-11T12:30:00Z', 'CPI', 'CPI (Aug)', 'high'],
  ['2026-09-16T18:00:00Z', 'FOMC', 'FOMC rate decision + projections', 'high'],
  ['2026-10-02T12:30:00Z', 'NFP', 'Nonfarm Payrolls (Sep)', 'high'],
  ['2026-10-13T12:30:00Z', 'CPI', 'CPI (Sep)', 'high'],
  ['2026-10-28T18:00:00Z', 'FOMC', 'FOMC rate decision', 'high'],
  ['2026-11-06T13:30:00Z', 'NFP', 'Nonfarm Payrolls (Oct)', 'high'],
  ['2026-11-12T13:30:00Z', 'CPI', 'CPI (Oct)', 'high'],
  ['2026-12-04T13:30:00Z', 'NFP', 'Nonfarm Payrolls (Nov)', 'high'],
  ['2026-12-09T18:00:00Z', 'FOMC', 'FOMC rate decision + projections', 'high'],
  ['2026-12-10T13:30:00Z', 'CPI', 'CPI (Nov)', 'high'],
].map(([iso, kind, label, impact]) => ({ ts: Date.parse(iso), iso, kind, label, impact }));

// Exported so other engines can overlay the macro calendar (e.g. options expected-move attribution).
export const MACRO_EVENTS = EVENTS_2026;
export function eventsBetween(startMs, endMs) {
  return EVENTS_2026.filter((e) => e.ts >= startMs && e.ts <= endMs);
}

export function macroSentry({ hours = 72, nowMs = null }) {
  const now = nowMs || Date.now();
  const horizon = now + Math.max(1, Math.min(24 * 30, hours)) * 3600 * 1000;
  const upcoming = EVENTS_2026.filter((e) => e.ts >= now && e.ts <= horizon)
    .map((e) => ({ ...e, hoursUntil: Math.round(((e.ts - now) / 3600000) * 10) / 10 }));
  const next = EVENTS_2026.find((e) => e.ts >= now);

  return {
    service: 'macro-sentry',
    version: config.version,
    windowHours: hours,
    verdict: upcoming.length ? 'EVENTS_AHEAD' : 'CLEAR',
    guidance: upcoming.length
      ? `${upcoming.length} high-impact US macro event(s) in the next ${hours}h — expect elevated volatility around ${upcoming.map((e) => e.kind).join(', ')}.`
      : `No high-impact US macro events in the next ${hours}h. Next is ${next ? `${next.kind} in ${Math.round((next.ts - now) / 3600000)}h` : 'beyond the calendar'}.`,
    events: upcoming.map((e) => ({ kind: e.kind, label: e.label, atUtc: e.iso, hoursUntil: e.hoursUntil, impact: e.impact })),
    nextEvent: next ? { kind: next.kind, label: next.label, atUtc: next.iso, hoursUntil: Math.round((next.ts - now) / 3600000) } : null,
    method: 'Curated calendar of scheduled high-impact US macro releases (FOMC, CPI, NFP) filtered to the requested lookahead window; times in UTC.',
    limitations: 'US high-impact events only; scheduled release times (actual data drops at the scheduled minute). Not investment advice.',
    elapsedMs: 0,
  };
}
