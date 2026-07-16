// OI snapshot store (gap 3, delta-OI) — persists per-currency open-interest snapshots to disk so a
// later call can diff and surface where positioning built or unwound. The container FS is writable
// but resets on redeploy, so the baseline window is honest ("since first seen ~N min ago"), never faked.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = process.env.OI_STORE_DIR || path.join(os.tmpdir(), 'quiver-oistore');
const MAX_SNAPS = 60;              // ring buffer per currency
const MAX_AGE_MS = 3 * 86400000;   // drop snapshots older than 3 days

function file(cur) { return path.join(DIR, `oi-${String(cur).toUpperCase()}.json`); }
function load(cur) { try { return JSON.parse(fs.readFileSync(file(cur), 'utf8')); } catch { return []; } }
function save(cur, snaps) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file(cur), JSON.stringify(snaps)); } catch { /* best-effort */ } }

// oiMap: { instId: oiCoin }. minAgeMs: how old the baseline must be for delta to be meaningful.
// Returns { baselineAgeMin, builds:[...], unwinds:[...] } or { pending } on first sight.
export function deltaOi(currency, oiMap, { minAgeMs = 40 * 60000, topN = 6 } = {}) {
  const now = Date.now();
  let snaps = load(currency).filter((s) => now - s.ts < MAX_AGE_MS);
  // baseline = newest snapshot at least minAgeMs old
  const baseline = [...snaps].reverse().find((s) => now - s.ts >= minAgeMs);

  // record current snapshot (append, trim)
  snaps.push({ ts: now, oi: oiMap });
  if (snaps.length > MAX_SNAPS) snaps = snaps.slice(snaps.length - MAX_SNAPS);
  save(currency, snaps);

  if (!baseline) {
    const oldest = snaps[0];
    return { pending: true, note: oldest && oldest.ts < now ? `Baseline building; OI-change available once a snapshot ages past ~${Math.round(minAgeMs / 60000)} min.` : 'First snapshot captured; OI-change available on the next call.' };
  }

  const changes = [];
  for (const [instId, oi] of Object.entries(oiMap)) {
    const prev = baseline.oi[instId];
    if (prev == null) continue;
    const d = oi - prev;
    if (Math.abs(d) > 0) changes.push({ instId, deltaOi: d, prevOi: prev, oi });
  }
  changes.sort((a, b) => Math.abs(b.deltaOi) - Math.abs(a.deltaOi));
  return {
    baselineAgeMin: Math.round((now - baseline.ts) / 60000),
    builds: changes.filter((c) => c.deltaOi > 0).slice(0, topN),
    unwinds: changes.filter((c) => c.deltaOi < 0).slice(0, topN),
  };
}
