// Per-episode beta measurement + H1 evaluation, exactly as PRE-REGISTERED in QUIVER_MISSION_CONTROL.md
// (Jul21 ~12:55Z entry). Betas from free HL 4h candles; one full-history fetch per asset, all episode
// windows computed locally. Outputs: episode-betas.json (all episodes × assets), beta-calibration.json
// (beta_cal + severity tiers, CALIBRATION side only), h1-result.json (per-episode Spearman + verdict).
import fs from 'fs';

const INFO = 'https://api.hyperliquid.xyz/info';
const ASSETS = ['BTC','ETH','BNB','SOL','ZEC','XRP','LTC','ADA','DOGE','LINK','AVAX','POPCAT','CRV','PUMP','ENA','LDO','WIF','kBONK','PENGU','SUI','FARTCOIN','AI16Z','HYPE'];
const CUTOFF = Date.parse('2026-01-01T00:00:00Z');
const { episodes } = JSON.parse(fs.readFileSync(new URL('./episodes.json', import.meta.url)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function candles(coin) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '4h', startTime: Date.parse('2025-07-25T00:00:00Z'), endTime: Date.now() } }),
        signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(1200); continue; }
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()).map((c) => ({ t: c.t, h: +c.h, l: +c.l }));
    } catch (e) { if (a === 2) return null; await sleep(800); }
  }
  return null;
}

// Peak→trough drawdown of a candle series restricted to [t0, t1].
function dd(series, t0, t1) {
  const win = series.filter((c) => c.t >= t0 && c.t <= t1);
  if (win.length < 3) return null;
  let peak = -Infinity, best = 0;
  for (const c of win) { if (c.h > peak) peak = c.h; const d = (peak - c.l) / peak; if (d > best) best = d; }
  return best * 100;
}

const all = {};
for (const a of ASSETS) {
  all[a] = await candles(a);
  console.log(a.padEnd(9), all[a] ? `${all[a].length} candles` : 'UNAVAILABLE');
  await sleep(350);
}

// Episode windows: [start 00:00Z, end 23:59Z].
const rows = [];
for (const ep of episodes) {
  const t0 = Date.parse(ep.start + 'T00:00:00Z'), t1 = Date.parse(ep.end + 'T23:59:59Z');
  const btcDd = dd(all.BTC, t0, t1);
  if (!btcDd || btcDd < 4) { console.log('skip (no BTC dd):', ep.start); continue; }
  const betas = {};
  for (const a of ASSETS) {
    if (a === 'BTC') { betas[a] = 1.0; continue; }
    const d = all[a] ? dd(all[a], t0, t1) : null;
    betas[a] = d != null ? Math.round((d / btcDd) * 100) / 100 : null;
  }
  rows.push({ ...ep, btcDdMeasured: Math.round(btcDd * 100) / 100, betas, side: t0 < CUTOFF ? 'calibration' : 'validation' });
}
fs.writeFileSync(new URL('./episode-betas.json', import.meta.url), JSON.stringify(rows, null, 1));

// beta_cal: MEDIAN across CALIBRATION episodes with BTC dd ≥ 8 (pre-registered).
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const calEps = rows.filter((r) => r.side === 'calibration' && r.btcDdMeasured >= 8);
const valEps = rows.filter((r) => r.side === 'validation' && r.btcDdMeasured >= 8);
console.log('\ncalibration ≥8% episodes:', calEps.map((e) => `${e.start}(${e.btcDdMeasured}%)`).join(', '));
console.log('validation ≥8% episodes:', valEps.map((e) => `${e.start}(${e.btcDdMeasured}%)`).join(', '));

const betaCal = {};
for (const a of ASSETS) betaCal[a] = a === 'BTC' ? 1.0 : median(calEps.map((e) => e.betas[a]));

// Severity tiers (calibration side only): mild <8, moderate 8-12, severe ≥12.
const tier = (lo, hi) => { const eps = rows.filter((r) => r.side === 'calibration' && r.btcDdMeasured >= lo && r.btcDdMeasured < hi); const t = {}; for (const a of ASSETS) t[a] = a === 'BTC' ? 1.0 : median(eps.map((e) => e.betas[a])); return { episodes: eps.length, betas: t }; };
const tiers = { mild: tier(4, 8), moderate: tier(8, 12), severe: tier(12, 99) };
fs.writeFileSync(new URL('./beta-calibration.json', import.meta.url), JSON.stringify({ generatedAtUtc: new Date().toISOString(), cutoff: '2025-12-31T23:59Z', method: 'median per-episode beta, calibration side only; episode beta = asset 4h peak→trough dd ÷ BTC dd in the episode window', betaCal, tiers }, null, 1));

// H1: Spearman(beta_cal, realized) per validation episode ≥8%.
function spearman(pairs) {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = Array(v.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j + 2) / 2; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
  const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((s, x) => s + x, 0) / rx.length, my = ry.reduce((s, x) => s + x, 0) / ry.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
const h1 = valEps.map((e) => {
  const pairs = ASSETS.filter((a) => a !== 'BTC' && betaCal[a] != null && e.betas[a] != null).map((a) => [betaCal[a], e.betas[a]]);
  return { episode: e.start, btcDd: e.btcDdMeasured, assets: pairs.length, spearman: Math.round(spearman(pairs) * 1000) / 1000 };
});
const h1Median = median(h1.map((x) => x.spearman));
const verdict = { h1PerEpisode: h1, medianSpearman: h1Median, threshold: 0.6, PASS: h1Median >= 0.6 };
fs.writeFileSync(new URL('./h1-result.json', import.meta.url), JSON.stringify(verdict, null, 1));
console.log('\nH1 per-episode:'); console.table(h1);
console.log(`H1 MEDIAN Spearman = ${h1Median} (threshold 0.6) → ${verdict.PASS ? 'PASS' : 'FAIL'}`);
