// OKX options (v5 public market data, keyless) — a SECOND venue alongside Deribit.
// opt-summary carries per-instrument Black-Scholes greeks + mark vol + forward; open-interest gives OI;
// instruments gives strike/expiry/contract multiplier. Reachable from Railway (probed 200).
// Everything here is best-effort: any failure returns [] so the desk degrades to Deribit-only, never errors.
import { config } from '../config.js';

const BASE = 'https://www.okx.com/api/v5';

async function g(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
  const j = await r.json();
  if (j.code && j.code !== '0') throw new Error(`okx ${path.split('?')[0]} code ${j.code}`);
  return j.data || [];
}

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

// OKX option instId: "BTC-USD-260731-60000-C". Parse -> {strike, expiry(Date), type}.
export function parseInstId(instId) {
  const m = String(instId).match(/^([A-Z0-9]+)-([A-Z0-9]+)-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/);
  if (!m) return null;
  const yy = 2000 + Number(m[3].slice(0, 2)), mm = Number(m[3].slice(2, 4)) - 1, dd = Number(m[3].slice(4, 6));
  return { base: m[1], expiry: new Date(Date.UTC(yy, mm, dd, 8, 0, 0)), strike: Number(m[4]), type: m[5] === 'C' ? 'call' : 'put' };
}

// Returns a merged chain: [{ instId, strike, expiry, type, ivPct, oiCoin, oiUsd, greeks:{delta,gamma,vega,theta}, fwd }]
// ivPct is normalized to PERCENT (OKX quotes vol as a decimal, e.g. 0.65 -> 65). Deribit uses percent already.
export async function optChain(currency) {
  const cur = String(currency).toUpperCase();
  const fam = `${cur}-USD`;
  // instFamily is the current param; uly is the legacy alias. Try instFamily, fall back to uly.
  const summ = await g(`/public/opt-summary?instFamily=${fam}`).catch(() => g(`/public/opt-summary?uly=${fam}`).catch(() => []));
  const [oi, inst] = await Promise.all([
    g(`/public/open-interest?instType=OPTION&instFamily=${fam}`).catch(() => g(`/public/open-interest?instType=OPTION&uly=${fam}`).catch(() => [])),
    g(`/public/instruments?instType=OPTION&instFamily=${fam}`).catch(() => []),
  ]);
  if (!summ.length) return [];

  const oiById = new Map();
  for (const o of oi) oiById.set(o.instId, o);
  const instById = new Map();
  for (const i of inst) instById.set(i.instId, i);

  const out = [];
  for (const s of summ) {
    const meta = parseInstId(s.instId);
    if (!meta) continue;
    const oiRow = oiById.get(s.instId);
    const iRow = instById.get(s.instId);
    // mark vol: markVol (decimal). Some payloads only carry bidVol/askVol -> mid.
    let iv = num(s.markVol);
    if (iv == null) { const bv = num(s.bidVol), av = num(s.askVol); iv = bv != null && av != null ? (bv + av) / 2 : (av ?? bv); }
    // OKX Black-Scholes greeks (…BS) are the ones directly comparable to a spot-referenced model.
    const greeks = {
      delta: num(s.deltaBS ?? s.delta), gamma: num(s.gammaBS ?? s.gamma),
      vega: num(s.vegaBS ?? s.vega), theta: num(s.thetaBS ?? s.theta),
    };
    // OI in coin: prefer oiCcy (underlying units), matching Deribit's contract==1-coin convention.
    const oiCoin = oiRow ? num(oiRow.oiCcy) : null;
    out.push({
      instId: s.instId, strike: meta.strike, expiry: meta.expiry, type: meta.type,
      ivPct: iv != null ? iv * 100 : null,
      oiCoin, oiUsd: oiRow ? num(oiRow.oiUsd) : null,
      greeks, fwd: num(s.fwdPx),
      ctVal: iRow ? num(iRow.ctVal) : null,
    });
  }
  return out;
}

export const hasOptions = (currency) => ['BTC', 'ETH'].includes(String(currency).toUpperCase());

// Daily spot series (oldest->newest) from OKX public candles. Uses the UTC-aligned daily bar (1Dutc) so
// it lines up with Deribit's UTC DVOL dailies — required for the variance-risk-premium fit.
// Returns [{ ts, c }]; [] on any failure.
export async function spotDailySeries(currency, days = 300) {
  const cur = String(currency).toUpperCase();
  try {
    const rows = await g(`/market/candles?instId=${cur}-USDT&bar=1Dutc&limit=${Math.min(days, 300)}`);
    return rows.map((r) => ({ ts: num(r[0]), c: num(r[4]) })).filter((p) => p.ts && p.c > 0).reverse();
  } catch { return []; }
}

// Daily spot closes (oldest->newest) — realized-vol regime substitute where DVOL is absent (alts).
export async function spotDailyCloses(currency, days = 60) {
  return (await spotDailySeries(currency, days)).map((p) => p.c);
}
