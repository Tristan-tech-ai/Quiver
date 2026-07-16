// In-memory artifact store for rendered cards (PNG). TTL-bounded; Railway FS is ephemeral so
// this is per-instance and short-lived by design — fine for the post-it-now content loop.
const store = new Map();
const TTL_MS = 60 * 60 * 1000; // 1h

// Deterministic-ish id without Math.random (unavailable in some contexts): counter + time-in-body.
let counter = 0;
export function putCard(buffer, contentType = 'image/png') {
  counter = (counter + 1) % 1e6;
  const id = `${Date.now().toString(36)}${counter.toString(36)}`;
  store.set(id, { buffer, contentType, t: Date.now() });
  // opportunistic sweep
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.t > TTL_MS) store.delete(k);
  }
  return id;
}

export function getCard(id) {
  const c = store.get(id);
  if (!c) return null;
  if (Date.now() - c.t > TTL_MS) { store.delete(id); return null; }
  return c;
}
