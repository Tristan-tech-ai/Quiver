// DefiLlama public API (keyless; PROVEN reachable from Railway: /protocols 200/102ms).
import { config } from '../config.js';

const BASE = 'https://api.llama.fi';

async function get(path, timeoutMs = config.upstreamTimeoutMs) {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`defillama ${path} -> ${r.status}`);
  return r.json();
}

// Protocols that RENAMED. The registry only carries the current name, so the old one — which is often
// the far more famous one, and the one a human or an agent will actually type — resolves to nothing,
// or worse, to a same-named minnow ("maker" matched a $0.01B "Swaap Maker V2" by substring). An alias
// is consulted before any matching, so a legacy name lands on the real protocol instead of a lookalike.
const ALIASES = {
  makerdao: 'sky-lending', 'maker-dao': 'sky-lending', maker: 'sky-lending', mkr: 'sky-lending',
  eigenlayer: 'eigencloud', 'eigen-layer': 'eigencloud', eigen: 'eigencloud',
  instadapp: 'fluid-lending', 'insta-dapp': 'fluid-lending',
};

// Pure resolution over an already-fetched index: exact slug, exact name, alias, then a substring
// fallback RANKED BY TVL. Ranking matters: an unranked substring scan returns whichever lookalike
// happens to sit first in the registry, which is how an ambiguous query becomes a confident wrong
// answer. The largest match is the one a caller asking by a bare name almost always means.
export function pickProtocol(items, q) {
  if (!Array.isArray(items) || !items.length) return undefined;
  const qRaw = String(q).toLowerCase().trim();
  const ql = qRaw.replace(/\s+/g, '-');
  const bySlug = (s) => items.find((p) => p.slug === s);

  const exact = bySlug(ql) || items.find((p) => String(p.name).toLowerCase() === qRaw);
  if (exact) return exact;

  const aliased = ALIASES[ql] || ALIASES[qRaw];
  if (aliased) {
    const hit = bySlug(aliased) || items.find((p) => String(p.slug).startsWith(aliased));
    if (hit) return hit;
  }

  const matches = items.filter((p) => String(p.slug).includes(ql) || String(p.name).toLowerCase().includes(qRaw));
  if (!matches.length) return undefined;
  return matches.slice().sort((a, b) => (Number(b.tvl) || 0) - (Number(a.tvl) || 0))[0];
}

let protocolIndex = null; // cache: name/slug -> {slug, name}
export function _setProtocolIndex(items) { protocolIndex = items ? { t: Date.now(), items } : null; } // tests only
export async function resolveProtocol(q) {
  if (!protocolIndex || Date.now() - protocolIndex.t > 6 * 3600 * 1000) {
    const list = await get('/protocols');
    protocolIndex = { t: Date.now(), items: list.map((p) => ({ slug: p.slug, name: p.name, tvl: p.tvl, chains: p.chains, category: p.category })) };
  }
  return pickProtocol(protocolIndex.items, q);
}

export const protocol = (slug) => get(`/protocol/${slug}`);

let hacksCache = null;
export function _resetHacksCache() { hacksCache = null; } // tests only
export async function hacks(fetcher = get) {
  if (!hacksCache || Date.now() - hacksCache.t > 12 * 3600 * 1000) {
    try {
      const h = await fetcher('/hacks');
      hacksCache = { t: Date.now(), items: Array.isArray(h) ? h : h.hacks || [] };
    } catch (e) {
      // NEVER cache a failure as a clean record (a swallowed catch here once poisoned 12h of
      // "0 incidents"). With a previous real cache: serve it stale. With none: REJECT — the caller
      // (protocol-pulse) discloses registryUnavailable instead of fabricating a clean history.
      if (hacksCache) return hacksCache.items;
      throw e;
    }
  }
  return hacksCache.items;
}
