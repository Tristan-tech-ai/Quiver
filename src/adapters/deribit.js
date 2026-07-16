// Deribit public API (keyless; PROVEN reachable from Railway during harvest:
// get_book_summary_by_currency 200/196ms, ticker w/ greeks 200, DVOL 200/159ms).
import { config } from '../config.js';

const BASE = 'https://www.deribit.com/api/v2/public';

async function get(pathq) {
  const r = await fetch(`${BASE}/${pathq}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
  if (!r.ok) throw new Error(`deribit ${pathq.split('?')[0]} -> ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`deribit error: ${JSON.stringify(j.error).slice(0, 120)}`);
  return j.result;
}

// Full option chain summary: mark_price, mark_iv, open_interest, underlying per instrument.
// BTC/ETH have their own books; SOL/alts settle under the USDC book (filter by base_currency).
export async function optionChain(currency) {
  const cur = String(currency).toUpperCase();
  if (cur === 'BTC' || cur === 'ETH') return get(`get_book_summary_by_currency?currency=${cur}&kind=option`);
  const usdc = await get('get_book_summary_by_currency?currency=USDC&kind=option');
  return usdc.filter((c) => String(c.instrument_name).toUpperCase().startsWith(`${cur}_`) || String(c.instrument_name).toUpperCase().startsWith(`${cur}-`));
}
export const hasDvol = (currency) => ['BTC', 'ETH'].includes(String(currency).toUpperCase());

// Per-instrument ticker with greeks + IV.
export const ticker = (instrument) => get(`ticker?instrument_name=${instrument}`);

// DVOL index history: resolution seconds, count via ms timestamps.
export const dvol = (currency, hours = 24) => {
  const end = Date.now();
  const start = end - hours * 3600 * 1000;
  return get(`get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`);
};

// DVOL history over many days (daily candles by default) for IV rank / percentile.
export const dvolHistory = (currency, days = 365, resolution = 86400) => {
  const end = Date.now();
  const start = end - days * 86400 * 1000;
  return get(`get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=${resolution}`);
};

// Futures book summary (per-expiry forward via mark/underlying) — used to imply the rate curve.
export const futures = (currency) => get(`get_book_summary_by_currency?currency=${currency}&kind=future`);

export const lastTrades = (currency, count = 100) =>
  get(`get_last_trades_by_currency?currency=${currency}&kind=option&count=${count}&include_old=true`);

export const indexPrice = (currency) => get(`get_index_price?index_name=${currency.toLowerCase()}_usd`);

// Parse "BTC-26SEP26-100000-C" or "SOL_USDC-26SEP26-200-C" -> {expiry: Date, strike, type}
export function parseInstrument(name) {
  const m = String(name).match(/^([A-Z]+(?:_[A-Z]+)?)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/);
  if (!m) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const expiry = new Date(Date.UTC(2000 + Number(m[4]), months[m[3]], Number(m[2]), 8, 0, 0)); // 08:00 UTC expiry
  return { currency: m[1].split('_')[0], expiry, strike: Number(String(m[5]).replace('d', '.')), type: m[6] === 'C' ? 'call' : 'put' };
}
