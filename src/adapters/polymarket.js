// Polymarket public APIs (keyless; PROVEN reachable from Railway: gamma 200/206ms, clob 200/35ms).
import { config } from '../config.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA = 'https://data-api.polymarket.com';

async function getJson(url, timeoutMs = config.upstreamTimeoutMs) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'okxai-asp/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`polymarket ${new URL(url).pathname} -> ${r.status}`);
  return r.json();
}

// Resolve a market by slug, conditionId, or free text (best-effort search).
export async function resolveMarket(q) {
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
    const arr = await getJson(`${GAMMA}/markets?condition_ids=${q}`);
    if (arr?.length) return arr[0];
  }
  // slug fast-path
  const bySlug = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(q)}`).catch(() => []);
  if (Array.isArray(bySlug) && bySlug.length) return bySlug[0];
  // text search over active markets by volume
  const list = await getJson(`${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=100`);
  const ql = q.toLowerCase();
  const hit = list.find((m) => (m.question || '').toLowerCase().includes(ql) || (m.slug || '').includes(ql));
  if (!hit) throw new Error(`no active Polymarket market matched "${q}"`);
  return hit;
}

// Order book for a CLOB token id.
export const book = (tokenId) => getJson(`${CLOB}/book?token_id=${tokenId}`);

// Market list helpers
export const marketsByTag = (tag, limit = 50) =>
  getJson(`${GAMMA}/markets?active=true&closed=false&limit=${limit}&tag=${encodeURIComponent(tag)}`);

export const eventsSearch = (params) => getJson(`${GAMMA}/events?${params}`);

// Wallet positions (data-api; public read).
export const positions = (wallet) => getJson(`${DATA}/positions?user=${wallet}&sizeThreshold=0.1&limit=200`);
export const activity = (wallet, limit = 100) => getJson(`${DATA}/activity?user=${wallet}&limit=${limit}`);

export function clobTokenIds(market) {
  // gamma market.clobTokenIds is a JSON-encoded array string
  try {
    const ids = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
    if (Array.isArray(ids) && ids.length >= 2) return { yes: ids[0], no: ids[1] };
  } catch { /* fall through */ }
  throw new Error('market has no CLOB token ids (not a binary CLOB market)');
}
