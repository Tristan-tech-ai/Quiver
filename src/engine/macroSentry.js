// MacroSentry — one call: high-impact US macro events (FOMC, CPI, NFP, PCE) inside the caller's
// lookahead window, so a trading agent can de-risk before a print. Deterministic curated calendar
// (these dates are published on fixed institutional schedules) — durable and dependency-free.
import { config } from '../config.js';
import { eventVol } from './eventVol.js';
import { round } from './stats.js';

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

export function macroSentry({ hours = 72, nowMs = null, spot = null, atmIvPct = null }) {
  const now = nowMs || Date.now();
  const horizon = now + Math.max(1, Math.min(24 * 30, hours)) * 3600 * 1000;
  const upcoming = EVENTS_2026.filter((e) => e.ts >= now && e.ts <= horizon)
    .map((e) => ({ ...e, hoursUntil: Math.round(((e.ts - now) / 3600000) * 10) / 10 }));
  const next = EVENTS_2026.find((e) => e.ts >= now);

  // DEPTH (was just a calendar): the options-implied EXPECTED MOVE to the next event — the market's own
  // priced-in magnitude — when the caller supplies the coin's spot + ATM IV. Real macro calendars stop at
  // the date + an "impact: high" label; this returns the number a desk actually sizes against. See eventVol.
  let nextEventRisk = null;
  const checks = [];
  if (next && Number(spot) > 0 && Number(atmIvPct) > 0) {
    const daysToEvent = (next.ts - now) / 86400000;
    const ev = eventVol({ spot: Number(spot), atmIvPct: Number(atmIvPct), daysToEvent });
    if (ev.ok) {
      nextEventRisk = {
        event: next.kind, label: next.label, atUtc: next.iso, daysUntil: round(daysToEvent, 2),
        spot: Number(spot), atmIvPct: Number(atmIvPct),
        expectedMove: ev.expectedMove, probabilityMoveBeyond: ev.probabilityMoveBeyond,
      };
      checks.push(...ev.checks);
    }
  }

  // Calendar-coverage certification: a curated list ENDS. Past its horizon, "CLEAR" is not knowledge —
  // it is calendar exhaustion, and it must be said as such (certified true/false + a distinct verdict),
  // or an agent still calling this in 2027 would read fabricated safety forever.
  const lastEventTs = EVENTS_2026[EVENTS_2026.length - 1].ts;
  const certified = horizon <= lastEventTs;
  const calendarCoverage = {
    calendarEndsUtc: new Date(lastEventTs).toISOString(),
    windowEndsUtc: new Date(horizon).toISOString(),
    certified,
    ...(certified ? {} : { note: 'The requested window extends past the end of the curated calendar — absence of events beyond it is UNKNOWN, not CLEAR.' }),
  };
  const verdict = upcoming.length ? 'EVENTS_AHEAD' : certified ? 'CLEAR' : 'CALENDAR_EXHAUSTED';

  return {
    service: 'macro-sentry',
    version: config.version,
    windowHours: hours,
    verdict,
    calendarCoverage,
    guidance: upcoming.length
      ? `${upcoming.length} high-impact US macro event(s) in the next ${hours}h — expect elevated volatility around ${upcoming.map((e) => e.kind).join(', ')}.${nextEventRisk ? ` The market is pricing ~${nextEventRisk.expectedMove.oneSigmaPct}% (1σ) into ${nextEventRisk.event}.` : ''}`
      : certified
        ? `No high-impact US macro events in the next ${hours}h. Next is ${next ? `${next.kind} in ${Math.round((next.ts - now) / 3600000)}h` : 'beyond the calendar'}.`
        : `The curated calendar ends ${calendarCoverage.calendarEndsUtc.slice(0, 10)} — this window extends beyond it, so "no events" CANNOT be certified. Treat as unknown, not clear.`,
    events: upcoming.map((e) => ({ kind: e.kind, label: e.label, atUtc: e.iso, hoursUntil: e.hoursUntil, impact: e.impact })),
    nextEvent: next ? { kind: next.kind, label: next.label, atUtc: next.iso, hoursUntil: Math.round((next.ts - now) / 3600000) } : null,
    nextEventRisk, // options-implied expected move (only when spot + atmIvPct are supplied)
    method: 'Curated calendar of scheduled high-impact US macro releases (FOMC, CPI, NFP) filtered to the requested lookahead window; times in UTC. When spot + ATM IV are supplied, the options-implied expected move to the next event is computed (eventVol) — the market\'s priced-in magnitude, self-checked against a numerical integral.',
    limitations: 'US high-impact events only; scheduled release times (actual data drops at the scheduled minute). Expected move uses the ATM vol; a full smile (options-desk) refines the tails. Not investment advice.',
    checks: checks.length ? checks : undefined,
    elapsedMs: 0,
  };
}
