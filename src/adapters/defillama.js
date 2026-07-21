// DefiLlama public API (keyless; PROVEN reachable from Railway: /protocols 200/102ms).
import { config } from '../config.js';

const BASE = 'https://api.llama.fi';

async function get(path, timeoutMs = config.upstreamTimeoutMs) {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`defillama ${path} -> ${r.status}`);
  return r.json();
}

let protocolIndex = null; // cache: name/slug -> {slug, name}
export async function resolveProtocol(q) {
  const ql = String(q).toLowerCase().trim().replace(/\s+/g, '-');
  if (!protocolIndex || Date.now() - protocolIndex.t > 6 * 3600 * 1000) {
    const list = await get('/protocols');
    protocolIndex = { t: Date.now(), items: list.map((p) => ({ slug: p.slug, name: p.name, tvl: p.tvl, chains: p.chains, category: p.category })) };
  }
  const items = protocolIndex.items;
  return items.find((p) => p.slug === ql) || items.find((p) => p.name.toLowerCase() === String(q).toLowerCase())
    || items.find((p) => p.slug.includes(ql) || p.name.toLowerCase().includes(String(q).toLowerCase()));
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
