// Hyperliquid public info API (keyless, no auth) — live perp context for perp-gate enrichment.
//
// POST https://api.hyperliquid.xyz/info  {type:'metaAndAssetCtxs'}
//   -> [ { universe: [ {name, maxLeverage, szDecimals}, ... ] }, [ {markPx, funding, oraclePx, openInterest, ...}, ... ] ]
// The two arrays are index-aligned by asset. `funding` is the HOURLY rate (Hyperliquid funds hourly), and
// positive funding = longs pay shorts — the exact convention perp-gate expects. maxLeverage per asset gives
// the maintenance rate via the documented relationship mmr = 0.5 / maxLeverage.
//
// Verified reachable 2026-07-18 from this host (Deribit is geo-blocked here; Hyperliquid is not):
//   232 assets, BTC maxLeverage 40 (=> mmr 1.25%, matching the docs), markPx ~63995, funding 1.25e-5.
import { round } from '../engine/stats.js';
import { dydxContext } from './dydx.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
let _cache = null, _at = 0;
const TTL_MS = 30000;

/** Map<SYMBOL, { maxLeverage, markPx, fundingHourly, oraclePx, openInterest }>. Cached 30s. */
export async function fetchPerpContexts({ timeoutMs = 12000, force = false } = {}) {
  if (!force && _cache && Date.now() - _at < TTL_MS) return _cache;
  const res = await fetch(INFO_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`hyperliquid info ${res.status}`);
  const j = await res.json();
  const map = parseMetaAndAssetCtxs(j); // pure — separately unit-testable with a fixture
  if (map.size === 0) throw new Error('hyperliquid: no valid contexts parsed');
  _cache = map; _at = Date.now();
  return map;
}

/** Pure parser (no network) so the decode logic is testable against a fixture. */
export function parseMetaAndAssetCtxs(j) {
  const universe = j?.[0]?.universe;
  const ctxs = j?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs) || universe.length !== ctxs.length) {
    throw new Error('hyperliquid: unexpected metaAndAssetCtxs shape');
  }
  // marginTables: [ [tableId, {description, marginTiers:[{lowerBound, maxLeverage}]}], ... ] → tableId → tiers.
  // Notional-tiered maintenance margin: a larger position sits in a lower-max-leverage tier ⇒ higher mmr ⇒
  // closer liquidation. perp-gate selects the tier by notional; here we just decode + attach the table.
  const tiersById = new Map();
  for (const t of (j?.[0]?.marginTables || [])) {
    const id = t?.[0], mt = t?.[1]?.marginTiers;
    if (id != null && Array.isArray(mt)) {
      const tiers = mt.map((x) => ({ lowerBound: Number(x.lowerBound), maxLeverage: Number(x.maxLeverage) }))
        .filter((x) => x.maxLeverage > 0 && Number.isFinite(x.lowerBound));
      if (tiers.length) tiersById.set(id, tiers);
    }
  }
  const map = new Map();
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i] || {}, c = ctxs[i] || {};
    const maxLeverage = Number(u.maxLeverage);
    const markPx = Number(c.markPx);
    const funding = Number(c.funding);
    if (!(maxLeverage > 0) || !(markPx > 0)) continue; // skip malformed / delisted
    map.set(String(u.name).toUpperCase(), {
      maxLeverage,
      marginTiers: tiersById.get(u.marginTableId) || null, // notional tiers (null if the asset has none)
      markPx,
      fundingHourly: Number.isFinite(funding) ? funding : null,
      oraclePx: Number(c.oraclePx) > 0 ? Number(c.oraclePx) : null,
      openInterest: Number(c.openInterest) >= 0 ? Number(c.openInterest) : null,
    });
  }
  return map;
}

export async function perpContext(symbol, opts) {
  const map = await fetchPerpContexts(opts);
  return map.get(String(symbol || '').toUpperCase()) || null;
}

/**
 * Merge live Hyperliquid context into perp-gate inputs, filling ONLY fields the caller did not provide.
 * The proof envelope echoes the enriched inputs, so the computation stays reproducible from exactly the
 * values used, and `live.filled` discloses which fields came from live data (provenance, never hidden).
 * `getContext` is injectable so this is testable offline.
 */
// Venue registry — the perp-gate MATH is venue-agnostic (any venue's maxLeverage/mark/funding work via
// manual params); only live-symbol enrichment is venue-specific. Adding a venue = one perpContext-shaped
// async fn returning { maxLeverage, markPx, fundingHourly }. Only Hyperliquid is wired here, because it is
// the one venue verified reachable + correct from this host — we do not ship a provider we cannot test.
const PROVIDERS = { hyperliquid: perpContext, dydx: dydxContext };
export const supportedVenues = () => Object.keys(PROVIDERS);

export async function enrichPerpInputs(input, getContext) {
  if (!input || !input.symbol) return input;
  const venue = String(input.venue || 'hyperliquid').toLowerCase();
  const provider = getContext || PROVIDERS[venue];
  if (!provider) return { ...input, live: { venue, error: `unsupported venue "${venue}" — supported: ${Object.keys(PROVIDERS).join(', ')}. (perp-gate math is venue-agnostic: pass maxLeverage/markPrice/fundingRateHourly manually for any venue.)` } };
  let ctx;
  try { ctx = await provider(input.symbol); }
  catch (e) { return { ...input, live: { venue, error: `unavailable: ${String(e.message || e).slice(0, 120)}` } }; }
  if (!ctx) return { ...input, live: { venue, error: `symbol "${input.symbol}" not found on ${venue}` } };

  const out = { ...input };
  const filled = {};
  // Maintenance-rate source, only if the caller supplied none: notional tiers (HL) > explicit mmr (dYdX) > max leverage.
  if (out.maintMarginRate == null && out.maxLeverage == null && out.marginTiers == null) {
    if (Array.isArray(ctx.marginTiers) && ctx.marginTiers.length) { out.marginTiers = ctx.marginTiers; filled.marginTiers = ctx.marginTiers.length; }
    else if (Number(ctx.maintMarginRate) > 0) { out.maintMarginRate = ctx.maintMarginRate; filled.maintMarginRate = ctx.maintMarginRate; }
    else if (Number(ctx.maxLeverage) > 0) { out.maxLeverage = ctx.maxLeverage; filled.maxLeverage = ctx.maxLeverage; }
  }
  if (out.markPrice == null && ctx.markPx > 0) { out.markPrice = ctx.markPx; filled.markPrice = ctx.markPx; }
  if (out.entryPrice == null && ctx.markPx > 0) { out.entryPrice = ctx.markPx; filled.entryPrice = ctx.markPx; filled._entryDefaultedToMark = true; }
  if (out.fundingRateHourly == null && ctx.fundingHourly != null) { out.fundingRateHourly = ctx.fundingHourly; filled.fundingRateHourly = ctx.fundingHourly; }
  out.live = {
    venue,
    source: `${venue} live context`,
    symbol: String(input.symbol).toUpperCase(),
    filled,
    note: filled._entryDefaultedToMark ? 'entryPrice was not supplied and was defaulted to the live mark — pass entryPrice for an existing position.' : undefined,
  };
  return out;
}

/**
 * Enrich each perp leg of a portfolio with live Hyperliquid context (mark, maxLeverage, notional margin-tiers)
 * from ONE cached fetch — fills only the fields the caller did not provide. Legs without a recognised symbol
 * pass through unchanged. `getMap` is injectable so this is testable offline. Used by portfolio-gate.
 */
export async function enrichPortfolioLegs(positions, getContext) {
  const legs = Array.isArray(positions) ? positions : [];
  return Promise.all(legs.map(async (l) => {
    if (!l) return l;
    // Needs live context when ANY fillable gap is open: no maintenance-rate source (mmr/maxLeverage/tiers)
    // OR missing marks. The old condition required marks to be missing too, so an account-mode leg — which
    // arrives WITH mark+entry from clearinghouseState but WITHOUT any mmr source — was skipped and every
    // leg failed downstream with "need maintMarginRate…" (caught live on a real 5-leg book).
    const noMmrSource = l.maintMarginRate == null && l.maxLeverage == null && l.marginTiers == null;
    const needsLive = (l.symbol || l.asset) && (noMmrSource || l.markPrice == null || l.entryPrice == null);
    if (!needsLive) return l;
    const provider = getContext || PROVIDERS[String(l.venue || 'hyperliquid').toLowerCase()]; // route each leg by its venue
    if (!provider) return l;                                                    // unknown venue → pass through
    let ctx; try { ctx = await provider(l.symbol || l.asset); } catch { ctx = null; }
    if (!ctx) return l;
    const out = { ...l };
    if (out.markPrice == null && ctx.markPx > 0) out.markPrice = ctx.markPx;
    if (out.entryPrice == null && ctx.markPx > 0) out.entryPrice = ctx.markPx;
    if (out.maintMarginRate == null && out.maxLeverage == null && out.marginTiers == null) {
      if (Array.isArray(ctx.marginTiers) && ctx.marginTiers.length) out.marginTiers = ctx.marginTiers;
      else if (Number(ctx.maintMarginRate) > 0) out.maintMarginRate = ctx.maintMarginRate;
      else if (Number(ctx.maxLeverage) > 0) out.maxLeverage = ctx.maxLeverage;
    }
    return out;
  }));
}

/**
 * Pure parser for {type:'clearinghouseState'} — the FULL live account book, keyless. Throws on an
 * unexpected shape: a failed/blocked fetch must surface as an error, never as an empty book
 * (absence-as-success discipline). Notable fields per position: szi (signed size), entryPx, marginUsed,
 * leverage {type: cross|isolated, value}, positionValue (|szi|·mark → mark), and liquidationPx — the
 * VENUE'S OWN liquidation price, which portfolio-gate uses as an external cross-check on its computed one.
 */
export function parseClearinghouseState(j) {
  const ms = j?.marginSummary;
  const aps = j?.assetPositions;
  if (!ms || !Array.isArray(aps)) throw new Error('hyperliquid: unexpected clearinghouseState shape');
  const positions = [];
  for (const ap of aps) {
    const p = ap?.position;
    if (!p) continue;
    const szi = Number(p.szi);
    if (!Number.isFinite(szi) || szi === 0) continue; // flat coins are omitted, open ones must parse
    const size = Math.abs(szi);
    const positionValue = Number(p.positionValue);
    const mark = positionValue > 0 ? positionValue / size : null;
    positions.push({
      venue: 'hyperliquid',
      asset: String(p.coin || '').toUpperCase(),
      side: szi > 0 ? 'long' : 'short',
      size,
      entryPrice: Number(p.entryPx) > 0 ? Number(p.entryPx) : mark,
      ...(mark > 0 ? { markPrice: round(mark, 6) } : {}),
      ...(Number(p.marginUsed) > 0 ? { margin: Number(p.marginUsed) } : {}),
      ...(Number(p.leverage?.value) > 0 ? { leverage: Number(p.leverage.value) } : {}),
      ...(p.leverage?.type ? { marginMode: String(p.leverage.type) } : {}),
      ...(Number(p.liquidationPx) > 0 ? { venueLiquidationPx: Number(p.liquidationPx) } : {}),
    });
  }
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
  return {
    positions,
    accountEquityUsd: num(ms.accountValue),
    totalNotionalUsd: num(ms.totalNtlPos),
    totalMarginUsedUsd: num(ms.totalMarginUsed),
    withdrawableUsd: num(j.withdrawable),
  };
}

/** Fetch one address's full live Hyperliquid book (positions + account equity). Keyless, public. */
export async function fetchHlAccount(address, { timeoutMs = 12000 } = {}) {
  const res = await fetch(INFO_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`hyperliquid clearinghouseState ${res.status}`);
  return parseClearinghouseState(await res.json());
}

export { round };
