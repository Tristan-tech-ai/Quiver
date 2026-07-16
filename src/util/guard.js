// Input validation + tiny per-IP rate limit + TTL cache.
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHAINS = new Set(['ethereum', 'solana', 'base', 'bsc', 'xlayer', 'polygon', 'arbitrum']);

export function validateScanInput(body) {
  const chain = String(body?.chain || '').toLowerCase().trim();
  const address = String(body?.address || '').trim();
  if (!CHAINS.has(chain)) return { error: `unsupported chain "${chain}" — supported: ${[...CHAINS].join(', ')}` };
  if (!EVM_RE.test(address) && !SOL_RE.test(address)) return { error: 'address must be a 0x… EVM address or a base58 Solana address' };
  return { chain, address };
}

const buckets = new Map();
export function rateLimit(ip, { perMinute = 30 } = {}) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; buckets.set(ip, b); }
  b.count += 1;
  if (buckets.size > 10000) buckets.clear(); // crude memory guard
  return b.count <= perMinute;
}

const cache = new Map();
export function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return Promise.resolve(fn()).then((v) => {
    cache.set(key, { t: Date.now(), v });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return v;
  });
}
