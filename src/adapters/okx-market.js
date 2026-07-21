// OKX public spot/CEX candles (keyless v5 market data). Powers chart-press for CEX symbols (BTC-USDT)
// alongside the DEX-by-chain+address path — the chart-image niche competitors (Birdeye/DEXScreener/
// GeckoTerminal) don't serve, and the CEX universe chart-img gets only via TradingView. Same host as
// okx-options (probed reachable from Railway). Best-effort: throws on a real API error so the caller can
// distinguish an outage from an unknown symbol.
import { config } from '../config.js';

const BASE = 'https://www.okx.com/api/v5';
const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

// chart-press interval -> OKX bar code. UTC-aligned for daily/weekly/monthly so bar boundaries are stable.
const BAR = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc', '1mon': '1Mutc' };
export function mapBar(interval) { return BAR[String(interval || '1H').toLowerCase()] || '1H'; }

// "btc" -> BTC-USDT · "btc-usdt"/"BTC/USDT" -> BTC-USDT · "ETH-USDC" stays. Uppercased, quote defaults USDT.
export function normInstId(sym) {
  let s = String(sym || '').toUpperCase().replace(/[/_]/g, '-').trim();
  if (!s) return null;
  if (!s.includes('-')) s = `${s}-USDT`;
  return /^[A-Z0-9]+-[A-Z0-9]+$/.test(s) ? s : null;
}

// A CEX symbol looks like BTC / BTC-USDT / ETH/USDC — NOT a 0x address. Used to route chart-press input.
export function looksLikeCexSymbol(s) {
  const v = String(s || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return false;      // EVM token address
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false; // Solana base58
  return /^[A-Za-z0-9]{2,10}([-/_][A-Za-z0-9]{2,10})?$/.test(v);
}

export async function cexCandles(sym, interval = '1H', limit = 100) {
  const instId = normInstId(sym);
  if (!instId) throw new Error(`unrecognized symbol "${sym}"`);
  const bar = mapBar(interval);
  const r = await fetch(`${BASE}/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(Math.max(limit, 10), 300)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
  const j = await r.json();
  if (j.code && j.code !== '0') throw new Error(`okx candles ${instId} code ${j.code} ${j.msg || ''}`.trim());
  const rows = j.data || [];
  const bars = rows
    .map((x) => ({ t: num(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[5]) }))
    .filter((b) => b.t && b.o && b.h && b.l && b.c)
    .sort((a, b) => a.t - b.t); // OKX returns newest-first
  return { instId, bar, bars };
}
