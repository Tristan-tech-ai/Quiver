// IV RANK / PERCENTILE (gap 1) — where does current implied vol sit vs its own recent history?
// Rank   = (current - min) / (max - min) over the window, in [0,100].
// Pctile = share of past closes strictly below current, in [0,100].
// "Is vol cheap or rich" — the single most-requested context on a vol desk.
import { round } from './stats.js';

function windowStat(closes, current, days) {
  const w = closes.slice(-days);
  if (w.length < Math.min(10, days)) return null; // need enough history to be meaningful
  const lo = Math.min(...w), hi = Math.max(...w);
  const rank = hi > lo ? ((current - lo) / (hi - lo)) * 100 : 50;
  const below = w.filter((v) => v < current).length;
  const pctile = (below / w.length) * 100;
  return { days: w.length, min: round(lo, 1), max: round(hi, 1), rank: round(Math.max(0, Math.min(100, rank)), 1), percentile: round(pctile, 1) };
}

// dvolDaily: array of daily closes (oldest->newest). current: live DVOL value.
export function ivRank(dvolDaily, current) {
  const closes = (dvolDaily || []).filter((v) => Number.isFinite(v) && v > 0);
  if (closes.length < 10 || !(current > 0)) return null;
  const w30 = windowStat(closes, current, 30);
  const w90 = windowStat(closes, current, 90);
  const w365 = windowStat(closes, current, 365);
  const primary = w365 || w90 || w30;
  const p = primary?.percentile ?? 50;
  const regime = p >= 80 ? 'RICH' : p >= 60 ? 'ELEVATED' : p <= 20 ? 'CHEAP' : p <= 40 ? 'SUBDUED' : 'NORMAL';
  return {
    current: round(current, 1),
    rank30d: w30, rank90d: w90, rank365d: w365,
    historyDays: closes.length,
    regime, // interpretation of the deepest available window
    note: closes.length < 300 ? `IV rank computed over ${closes.length} days of DVOL history (deepest reachable window).` : undefined,
  };
}
