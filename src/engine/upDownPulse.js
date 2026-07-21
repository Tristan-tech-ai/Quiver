// UpDownPulse — one call on the live Polymarket short-window BTC/ETH "up or down" market:
// the market's own implied odds, window mechanics, a spot observation, and a driftless remaining-risk
// estimate. It deliberately outputs NO directional fair-value / edge — short-horizon direction is
// empirically a coin flip, so a predictive number would be false precision (this is the honest read
// our whole positioning rests on: surface the market + the risk, refuse to fake an edge).
import * as pm from '../adapters/polymarket.js';
import * as data from '../adapters/data.js';
import { config } from '../config.js';
import { round } from './stats.js';

const COIN = {
  BTC: { slug: 'bitcoin', tickers: ['btc', 'bitcoin'], okx: { chain: 'ethereum', addr: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' } }, // wBTC px proxy
  ETH: { slug: 'ethereum', tickers: ['eth', 'ethereum'], okx: { chain: 'ethereum', addr: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' } }, // wETH
};

// STRICT coin match on a market/event slug — the slug is prefixed by the coin ticker
// (e.g. "btc-updown-5m-…", "eth-updown-5m-…"). Prevents a BTC request resolving a DOGE market.
function coinMatches(slug, tickers) {
  const s = String(slug || '').toLowerCase();
  return tickers.some((t) => s.startsWith(`${t}-`) || s.includes(`-${t}-`) || (t.length > 4 && s.includes(t)));
}

// Infer the window length (seconds) from the slug so the momentum model isn't hardcoded to 5 min.
function windowSeconds(slug) {
  const s = String(slug || '').toLowerCase();
  const m = s.match(/(\d+)\s*(m|min|h|hr|hour)\b/);
  if (m) { const n = Number(m[1]); return /h/.test(m[2]) ? n * 3600 : n * 60; }
  if (/hourly/.test(s)) return 3600;
  if (/daily/.test(s)) return 86400;
  return 300;
}

// Find the imminent open up/down window FOR THIS COIN (soonest-resolving, strictly coin-matched).
// Returns { win, lookupFailed }: both event-pool fetches failing means the market state is UNKNOWN —
// which must never be reported as "no open window" (absence-as-success).
async function findWindow(cfg, deps = pm) {
  const now = Date.now();
  let fails = 0;
  // Two pools: the coin-tagged events, and a broad recent pull (the tag alone leaks other coins).
  const pools = await Promise.all([
    deps.eventsSearch(`active=true&closed=false&limit=80&order=startDate&ascending=false&tag=${encodeURIComponent(cfg.slug)}`).catch(() => { fails += 1; return []; }),
    deps.eventsSearch('active=true&closed=false&limit=100&order=startDate&ascending=false').catch(() => { fails += 1; return []; }),
  ]);
  const lookupFailed = fails === 2;
  const candidates = [];
  const seen = new Set();
  for (const events of pools) {
    for (const ev of (Array.isArray(events) ? events : [])) {
      for (const m of ev.markets || []) {
        const slug = String(m.slug || '').toLowerCase();
        const evSlug = String(ev.slug || '').toLowerCase();
        if (!/up.?or.?down|updown/.test(`${slug} ${evSlug}`)) continue;
        if (!coinMatches(slug, cfg.tickers) && !coinMatches(evSlug, cfg.tickers)) continue; // enforce coin
        const end = m.endDate ? Date.parse(m.endDate) : (ev.endDate ? Date.parse(ev.endDate) : null);
        if (end && end > now && end - now < 24 * 3600 * 1000 && !seen.has(m.slug)) {
          seen.add(m.slug);
          candidates.push({ m, end, winSecs: windowSeconds(slug) || windowSeconds(evSlug) });
        }
      }
    }
  }
  candidates.sort((a, b) => a.end - b.end); // soonest-resolving = the imminent window
  return { win: candidates[0] || null, lookupFailed };
}

function impliedOdds(market) {
  try {
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    if (Array.isArray(prices) && prices.length >= 2) return { up: Number(prices[0]), down: Number(prices[1]) };
  } catch { /* fall through */ }
  return null;
}

export async function upDownPulse(coin = 'BTC', deps = pm) {
  const t0 = Date.now();
  const cur = String(coin).toUpperCase();
  const cfg = COIN[cur];
  if (!cfg) return { service: 'updown-pulse', version: config.version, coin: cur, verdict: 'UNSUPPORTED', note: 'Supported coins: BTC, ETH.' };

  const { win, lookupFailed } = await findWindow(cfg, deps);
  if (!win) {
    return lookupFailed
      ? { service: 'updown-pulse', version: config.version, coin: cur, verdict: 'MARKET_LOOKUP_FAILED', note: `Both Polymarket event lookups FAILED — the market state for ${cur} is UNKNOWN this call, not absent. Retry.` }
      : { service: 'updown-pulse', version: config.version, coin: cur, verdict: 'NO_OPEN_WINDOW', note: `The event lookups succeeded and no open up/down window matched ${cur} — genuinely no imminent market right now.` };
  }

  const now = Date.now();
  const secondsLeft = Math.round((win.end - now) / 1000);
  const winSecs = win.winSecs || 300;
  const implied = impliedOdds(win.m);

  // Recent 1m candles → an OBSERVATION of where spot is. Daily candles → a SOUND vol for the real horizon.
  const [c1mRaw, c1dRaw] = await Promise.all([
    data.candles(cfg.okx.chain, cfg.okx.addr, '1m', 15).catch(() => []),
    data.candles(cfg.okx.chain, cfg.okx.addr, '1D', 30).catch(() => []),
  ]);
  const toBars = (raw) => (Array.isArray(raw) ? raw : []).map((r) => Array.isArray(r) ? { t: Number(r[0]), c: Number(r[4]) } : { t: Number(r.ts), c: Number(r.c) }).filter((b) => b.c).sort((a, b) => a.t - b.t);
  const bars = toBars(c1mRaw), dbars = toBars(c1dRaw);
  const last = bars[bars.length - 1]?.c, prev5 = bars[Math.max(0, bars.length - 6)]?.c;
  const move5mPct = last && prev5 ? ((last - prev5) / prev5) * 100 : null;

  // DELIBERATELY NO fair-value / edge. Short-horizon directional prediction is empirically a coin flip
  // (retail directional accuracy ~50–52%; controlled deep-learning benchmarks find 54/54 model×horizon
  // combinations indistinguishable from 50%). A momentum "fair value" here would manufacture an edge our
  // whole product says nobody has. Instead we surface the MARKET's own odds + honest risk context.

  // These "5m"-slugged Polymarket markets actually resolve HOURS out, not in 5 minutes — the slug is a
  // SERIES label, not the horizon. Scale vol from DAILY returns (sound over a ~1-day horizon), NOT from a
  // 30-minute sample √t-extrapolated 46× to a day (which massively amplifies short-sample noise).
  const drets = [];
  for (let i = 1; i < dbars.length; i++) if (dbars[i].c > 0 && dbars[i - 1].c > 0) drets.push(Math.log(dbars[i].c / dbars[i - 1].c));
  let sigmaDaily = null;
  if (drets.length >= 8) { const m = drets.reduce((a, b) => a + b, 0) / drets.length; sigmaDaily = Math.sqrt(drets.reduce((a, b) => a + (b - m) ** 2, 0) / (drets.length - 1)); }
  const hoursLeft = secondsLeft / 3600;
  const typicalMoveToResolutionPct = sigmaDaily != null ? round(sigmaDaily * Math.sqrt(Math.max(secondsLeft, 0) / 86400) * 100, 2) : null; // driftless 1σ over the ACTUAL time to resolution

  // Verdict describes the MARKET, not a model.
  const upC = implied ? implied.up : null;
  const marketVerdict = upC == null ? 'NO_ODDS' : upC >= 0.55 ? 'MARKET_LEANS_UP' : upC <= 0.45 ? 'MARKET_LEANS_DOWN' : 'MARKET_TOSS_UP';

  return {
    service: 'updown-pulse',
    version: config.version,
    coin: cur,
    market: win.m.slug || win.m.question,
    verdict: marketVerdict,
    marketImplied: implied ? { upCents: round(implied.up * 100, 1), downCents: round(implied.down * 100, 1) } : null,
    window: {
      resolvesInHours: round(hoursLeft, 1), secondsLeft, endsAt: new Date(win.end).toISOString(),
      slugWindowLabel: `${winSecs}s`,
      note: 'The Polymarket slug (e.g. "…-5m-…") is a SERIES label; the market actually resolves at endsAt — often hours out, not in that many seconds.',
    },
    spotObservation: { last: last ? Number(last.toPrecision(8)) : null, move5mPct: round(move5mPct, 3), note: 'An observation of recent price action, NOT a prediction of the next move.' },
    remainingRisk: typicalMoveToResolutionPct == null ? null : {
      typicalMoveToResolutionPct,
      basis: `driftless 1σ from ${drets.length + 1} daily closes, scaled to the ${round(hoursLeft, 1)}h until resolution`,
      note: 'How much price could move before this resolves — magnitude only, NOT direction.',
    },
    edgeStance: 'This service outputs NO fair-value probability and NO "edge". Short-horizon up/down direction is empirically indistinguishable from a coin flip, so a predictive number would be false precision. It surfaces the market\'s own odds and honest risk context, and leaves the directional call to you.',
    method: 'Resolves the open Polymarket up/down market and reports its market-implied odds, the true time to resolution, an observation of recent spot action, and a driftless remaining-move estimate scaled from DAILY realized volatility (sound for the multi-hour horizon). No directional fair-value or edge is computed — by design.',
    limitations: 'Market odds are the market\'s, not ours. The remaining-move figure is a driftless 1σ magnitude, not a forecast. The "5m"-style slug is a series label, not the resolution horizon. Window discovery depends on Polymarket listing the series. Not financial advice.',
    elapsedMs: Date.now() - t0,
  };
}
