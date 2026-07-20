// dYdX v4 public indexer (keyless, no auth) — the SECOND live perp venue for perp-gate / portfolio-gate.
// The perp-gate MATH is venue-agnostic; this just supplies dYdX's live mark, hourly funding, and maintenance
// rate. Verified reachable + correct from this host (2026-07): BTC oraclePrice ~64647, maintMarginFraction
// 0.012 (1.2%), initialMarginFraction 0.02 (⇒ 50× max), nextFundingRate hourly.
//   GET https://indexer.dydx.trade/v4/perpetualMarkets
//     -> { markets: { "BTC-USD": { oraclePrice, nextFundingRate, maintenanceMarginFraction, initialMarginFraction, ... }, ... } }
// dYdX gives the maintenance-margin RATE directly (unlike Hyperliquid's notional tiers) — so we return
// maintMarginRate, and perp-gate uses it verbatim (no 0.5/maxLeverage derivation, no fabricated tiers).
import { round } from '../engine/stats.js';

const INDEXER = 'https://indexer.dydx.trade/v4/perpetualMarkets';
let _cache = null, _at = 0;
const TTL_MS = 30000;

/** Pure parser (no network) so the decode logic is testable against a fixture. */
export function parsePerpetualMarkets(j) {
  const markets = j?.markets;
  if (!markets || typeof markets !== 'object') throw new Error('dydx: unexpected perpetualMarkets shape');
  const map = new Map();
  for (const [ticker, m] of Object.entries(markets)) {
    const markPx = Number(m?.oraclePrice);
    const mmr = Number(m?.maintenanceMarginFraction);
    if (!(markPx > 0) || !(mmr > 0)) continue; // skip malformed / inactive
    const sym = String(ticker).replace(/-USD$/i, '').toUpperCase(); // BTC-USD -> BTC
    const imf = Number(m?.initialMarginFraction);
    map.set(sym, {
      maintMarginRate: mmr,                                    // dYdX publishes mmr directly
      markPx,
      fundingHourly: Number.isFinite(Number(m?.nextFundingRate)) ? Number(m.nextFundingRate) : null, // dYdX funds hourly
      maxLeverage: imf > 0 ? round(1 / imf, 2) : null,         // 1/initialMarginFraction, informational
    });
  }
  return map;
}

async function fetchAll({ timeoutMs = 12000, force = false } = {}) {
  if (!force && _cache && Date.now() - _at < TTL_MS) return _cache;
  const res = await fetch(INDEXER, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`dydx indexer ${res.status}`);
  const map = parsePerpetualMarkets(await res.json());
  if (map.size === 0) throw new Error('dydx: no valid markets parsed');
  _cache = map; _at = Date.now();
  return map;
}

/** Context for one symbol, shaped identically to the Hyperliquid provider. Cached 30s. */
export async function dydxContext(symbol, opts) {
  const map = await fetchAll(opts);
  return map.get(String(symbol || '').toUpperCase()) || null;
}
