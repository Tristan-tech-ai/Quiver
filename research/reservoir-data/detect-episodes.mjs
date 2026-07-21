// Episode detection — find every correlated-stress episode in the archive window (2025-07-29 → now)
// from FREE keyless Hyperliquid 4h BTC candles. An episode = a cluster of days where the rolling 48h
// peak→trough BTC drawdown ≥ 5%. Severity tiers: mild 5–8%, moderate 8–12%, severe ≥12%.
// Output: episodes.json (start/end/troughTs/peakPx/troughPx/ddPct/severity) — the raw material for
// per-episode beta measurement. Detection only; no validation metrics are computed here (pre-registration
// comes first).
import fs from 'fs';

const INFO = 'https://api.hyperliquid.xyz/info';
const START = Date.parse('2025-07-25T00:00:00Z'); // few days before archive start for rolling window
const NOW = Date.now();

async function candles(coin, startTime, endTime, interval = '4h') {
  const r = await fetch(INFO, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`candles ${coin} ${r.status}`);
  return (await r.json()).map((c) => ({ t: c.t, h: +c.h, l: +c.l, c: +c.c }));
}

// Paginate if needed (HL returns up to ~5000 candles; 4h over ~1y ≈ 2200 — one call should do).
const btc = await candles('BTC', START, NOW);
if (!btc.length) throw new Error('no BTC candles');
console.log(`BTC 4h candles: ${btc.length} | ${new Date(btc[0].t).toISOString().slice(0, 10)} → ${new Date(btc[btc.length - 1].t).toISOString().slice(0, 10)}`);

// Rolling 48h (12 candles) peak→trough drawdown ending at each candle.
const W = 12;
const marks = [];
for (let i = 0; i < btc.length; i++) {
  const win = btc.slice(Math.max(0, i - W + 1), i + 1);
  let peak = -Infinity, dd = 0, peakPx = 0, troughPx = 0;
  for (const c of win) {
    if (c.h > peak) peak = c.h;
    const d = (peak - c.l) / peak;
    if (d > dd) { dd = d; peakPx = peak; troughPx = c.l; }
  }
  marks.push({ t: btc[i].t, dd: dd * 100, peakPx, troughPx });
}

// Cluster consecutive marks ≥5% into episodes; episode dd = max dd in cluster.
const episodes = [];
let cur = null;
for (const m of marks) {
  if (m.dd >= 5) {
    if (!cur) cur = { start: m.t, end: m.t, dd: m.dd, at: m.t, peakPx: m.peakPx, troughPx: m.troughPx };
    else { cur.end = m.t; if (m.dd > cur.dd) { cur.dd = m.dd; cur.at = m.t; cur.peakPx = m.peakPx; cur.troughPx = m.troughPx; } }
  } else if (cur) {
    // close cluster after 24h (6 candles) below threshold
    if (m.t - cur.end > 24 * 3600 * 1000) { episodes.push(cur); cur = null; }
  }
}
if (cur) episodes.push(cur);

const sev = (dd) => (dd >= 12 ? 'severe' : dd >= 8 ? 'moderate' : 'mild');
const out = episodes.map((e) => ({
  start: new Date(e.start).toISOString().slice(0, 10),
  end: new Date(e.end).toISOString().slice(0, 10),
  troughAtUtc: new Date(e.at).toISOString(),
  btcDdPct: Math.round(e.dd * 100) / 100,
  severity: sev(e.dd),
}));
fs.writeFileSync(new URL('./episodes.json', import.meta.url), JSON.stringify({ generatedAtUtc: new Date().toISOString(), method: 'HL 4h BTC candles, rolling 48h peak→trough, cluster ≥5%, close after 24h calm', episodes: out }, null, 2));
console.table(out);
console.log(`${out.length} episodes | severe: ${out.filter((e) => e.severity === 'severe').length}, moderate: ${out.filter((e) => e.severity === 'moderate').length}, mild: ${out.filter((e) => e.severity === 'mild').length}`);
