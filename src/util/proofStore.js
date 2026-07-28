// proofStore.js — Phase A of the roadmap: the proof outlives the process.
//
// Until now the proof store was a `Map`. That is fine for a demonstration and wrong for anything a
// contract depends on: a redeploy cleared every proof, and a second replica answered 404 for a proof
// the first replica had just built. The endpoint said so out loud, which was honest but not a fix.
//
// A proof is immutable and is already NAMED BY ITS OWN CONTENT HASH, so durability here is a lookup
// change and not a design change: write the finished record under its hash, read it back on a memory
// miss. There is no cache-invalidation problem to get wrong, because a given hash can only ever have
// one correct answer.
//
// Nothing in this file is inside `src/engine/`, so none of it moves the published codeHash.
//
// WHAT IS DELIBERATELY NOT PERSISTED
//   `building`  — process-local state. A crash mid-proof would otherwise leave a permanent "building"
//                 on disk that no process is working on, and every later reader would poll it forever.
//   `failed` / `unavailable` — a refusal is a judgement made by one build of the code. Persisting it
//                 would let a fixed prover keep serving the old refusal after a deploy. Cheap to redo.
// Only `ready` is written, because only `ready` is a fact about arithmetic rather than about a process.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Unset = memory only, which is exactly the behaviour that shipped. Durability is opt-in so that
// turning it on is a deploy-time decision and not a silent change to how the service answers.
const DIR = process.env.QUIVER_PROOF_DIR || null;

// The directory is as public as the endpoint, so it needs the same bound the Map had. Proofs are
// ~7 kB and take most of a second to build, so a scan-per-write costs nothing next to the proving.
const MAX_FILES = Number(process.env.QUIVER_PROOF_MAX || 500);

let ready = false;
let disabledReason = DIR ? null : 'QUIVER_PROOF_DIR is not set';

/** True when a proof written now would survive this process dying. Checked, not assumed. */
export function durable() {
  if (!DIR) return false;
  if (ready) return true;
  try {
    mkdirSync(DIR, { recursive: true });
    // A directory that exists but cannot be written to is the failure mode that would otherwise be
    // discovered by a 404 in production, so it is discovered here instead.
    const probe = join(DIR, '.writable');
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    ready = true;
    disabledReason = null;
  } catch (e) {
    disabledReason = String((e && e.message) || e).slice(0, 120);
    ready = false;
  }
  return ready;
}

/** Why durability is off, for the endpoint to tell the truth with. Null when it is on. */
export function durabilityNote() {
  durable();
  return ready ? null : disabledReason;
}

const pathFor = (contentHash) => join(DIR, `${contentHash}.json`);

// A content hash is 64 lowercase hex characters and nothing else. This is not a courtesy check: the
// hash reaches here from a URL parameter, and `join(DIR, '../../etc/passwd.json')` is a path traversal
// if it is ever trusted. The route validates too; a store that can be handed a hash must not depend on
// its caller having done so.
const wellFormed = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/**
 * Read a persisted record. Returns null for anything that is not a readable, parseable, `ready`
 * record — a damaged file behaves as a cache miss, which rebuilds, rather than as an error that
 * takes the endpoint down with it.
 */
export function read(contentHash) {
  if (!durable() || !wellFormed(contentHash)) return null;
  try {
    const rec = JSON.parse(readFileSync(pathFor(contentHash), 'utf8'));
    return rec && rec.status === 'ready' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Persist a finished record. Silent no-op for every non-ready status and whenever durability is off,
 * so callers never have to branch on it.
 */
export function write(contentHash, rec) {
  if (!durable() || !wellFormed(contentHash) || !rec || rec.status !== 'ready') return false;
  try {
    // Write-then-rename, because a reader can arrive mid-write. A half-written JSON file would parse
    // as damaged and be treated as a miss, which is survivable but would silently re-prove; rename is
    // atomic within a directory and removes the window entirely.
    const tmp = `${pathFor(contentHash)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, pathFor(contentHash));
    prune();
    return true;
  } catch {
    return false;
  }
}

/** Keep the directory bounded, oldest first. Failure here must never fail the write that triggered it. */
function prune() {
  try {
    const files = readdirSync(DIR).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    if (files.length <= MAX_FILES) return;
    const withAge = files
      .map((f) => { try { return { f, at: statSync(join(DIR, f)).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);
    for (const { f } of withAge.slice(0, withAge.length - MAX_FILES)) {
      try { unlinkSync(join(DIR, f)); } catch { /* another replica may have pruned it first */ }
    }
  } catch { /* a full or unreadable directory is not a reason to lose the proof just written */ }
}

/** Count of persisted proofs, for /build to report rather than claim. */
export function count() {
  if (!durable()) return 0;
  try {
    return readdirSync(DIR).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}
