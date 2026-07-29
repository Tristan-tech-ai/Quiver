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
// Nothing in this file is inside `src/engine/`, so none of it moves the published codeHash. That is
// checked rather than asserted: buildId() walks `src/engine` recursively and hashes only `*.js` under
// that root, and `src/util/` is not under it.
//
// TWO BACKENDS, CHOSEN BY ENVIRONMENT
//   QUIVER_PROOF_S3_BUCKET  →  S3 (or any S3-compatible endpoint). Shared by every replica.
//   QUIVER_PROOF_DIR        →  a directory on this container's filesystem.
//   neither                 →  memory only, which is exactly the behaviour that shipped.
// The filesystem backend is kept, not superseded. It is the one a clone can exercise with no
// credentials and no network, which is what makes `npm run gate:a` runnable unattended; deleting it
// would mean deleting the only durability test that anyone can run.
//
// WHY S3 AND NOT A RAILWAY VOLUME. The claim Phase A makes is that a proof survives a redeploy AND a
// second replica, and that /proof/<hash> answers identically from any instance. A Railway volume
// cannot carry that claim: Railway's own reference documents it as "Replicas cannot be used with
// volumes", one volume per service, pinned to that service's region, and it refuses to have two
// deployments mounted at once. A volume would give us the redeploy half and silently fail the replica
// half — the worse outcome, because the endpoint would keep claiming both.
//
// WHY EVERYTHING HERE IS ASYNC. The S3 SDK is. A store whose `read()` is synchronous for one backend
// and a Promise for the other is the worst shape available: `res.json(await-less-read)` serialises a
// Promise as `{}`, and /proof/<hash> would answer 200 with an empty body that looks exactly like a
// cache miss. So there is no synchronous read at all, for either backend — a caller that forgets to
// await gets a Promise every time, on every code path, and fails loudly on the first test rather than
// intermittently in production.
//
// WHAT IS DELIBERATELY NOT PERSISTED
//   `building`  — process-local state. A crash mid-proof would otherwise leave a permanent "building"
//                 on disk that no process is working on, and every later reader would poll it forever.
//   `failed` / `unavailable` — a refusal is a judgement made by one build of the code. Persisting it
//                 would let a fixed prover keep serving the old refusal after a deploy. Cheap to redo.
// Only `ready` is written, because only `ready` is a fact about arithmetic rather than about a process.
import { mkdir, readFile, writeFile, unlink, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// S3 keys are '/'-separated whatever the host OS is, so path.basename is the wrong tool here: on
// Windows it also splits on '\', which is a legal character in an S3 key.
const keyTail = (k) => String(k || '').split('/').pop();

// ── configuration ────────────────────────────────────────────────────────────────────────────────
// Unset = memory only. Durability is opt-in so that turning it on is a deploy-time decision and not a
// silent change to how the service answers.
const DIR = process.env.QUIVER_PROOF_DIR || null;
const BUCKET = process.env.QUIVER_PROOF_S3_BUCKET || null;

// S3 wins when both are set, and the choice is REPORTED rather than guessed at — see kind(). An
// operator who sets both has almost certainly just added the bucket and not yet removed the old path,
// and silently preferring the local directory would put the proofs on the disk that is about to be
// thrown away.
const BACKEND = BUCKET ? 's3' : DIR ? 'fs' : 'off';

const S3 = {
  bucket: BUCKET,
  region: process.env.QUIVER_PROOF_S3_REGION || process.env.AWS_REGION || 'us-east-1',
  // Trailing slash normalised so `prefix` and `prefix/` name the same place. An operator who writes
  // one and reads the other would otherwise get a store that is durable and permanently empty.
  prefix: (process.env.QUIVER_PROOF_S3_PREFIX ?? 'proofs/').replace(/\/*$/, (m) => (m === '' ? '' : '/')),
  endpoint: process.env.QUIVER_PROOF_S3_ENDPOINT || null,
  // MinIO, R2 and most self-hosted gateways serve path style only; real S3 serves both. Default to
  // path style whenever a custom endpoint is set, because that is the one that works on both.
  forcePathStyle: process.env.QUIVER_PROOF_S3_FORCE_PATH_STYLE
    ? process.env.QUIVER_PROOF_S3_FORCE_PATH_STYLE !== 'false'
    : !!process.env.QUIVER_PROOF_S3_ENDPOINT,
};
// A prefix that is not empty must end in exactly one slash; the replace above only fixes a trailing
// run, so a prefix given without any slash still needs one.
if (S3.prefix && !S3.prefix.endsWith('/')) S3.prefix += '/';

// The store is as public as the endpoint, so it needs the same bound the Map had. Proofs are ~7 kB
// and take most of a second to build, so a listing per write costs nothing next to the proving.
const MAX_FILES = Number(process.env.QUIVER_PROOF_MAX || 500);

// A network call must not be able to hold a request open. Every S3 operation is bounded twice: the
// SDK's own connect/request timeouts, and an outer race that cannot be defeated by a handler that
// never settles.
const OP_TIMEOUT_MS = Number(process.env.QUIVER_PROOF_S3_TIMEOUT_MS || 8000);
// How long a KNOWN-BAD configuration is believed before it is probed again. Without this, a wrong
// bucket name costs every /build request a full round trip to discover the same 404.
const RETRY_MS = Number(process.env.QUIVER_PROOF_S3_RETRY_MS || 15000);

// ── state ────────────────────────────────────────────────────────────────────────────────────────
let ready = false;
let disabledReason = BACKEND === 'off'
  ? 'neither QUIVER_PROOF_S3_BUCKET nor QUIVER_PROOF_DIR is set'
  : null;
let lastProbeAt = 0;
let probeInFlight = null;
// /build is a public endpoint and a listing is a billed API call, so the S3 count is cached. It is
// invalidated by every write this process makes, and expires anyway so that another replica's writes
// show up. The filesystem count is not cached: a readdir is free.
let countCache = null;
const COUNT_TTL_MS = Number(process.env.QUIVER_PROOF_COUNT_TTL_MS ?? 15000);

/**
 * Which backend is configured, without doing any I/O. Reported by /build so a reader can tell which
 * of the three worlds a deploy is in without inferring it from whether things happen to work.
 */
export function kind() {
  if (BACKEND === 's3') return 'content-addressed objects in S3';
  if (BACKEND === 'fs') return 'content-addressed files';
  return 'in-memory only';
}

/** Where the store points, for a note or an error to name. Never includes a credential. */
export function location() {
  if (BACKEND === 's3') return `s3://${S3.bucket}/${S3.prefix}${S3.endpoint ? ` @ ${S3.endpoint}` : ''}`;
  if (BACKEND === 'fs') return DIR;
  return null;
}

// ── the S3 client, imported lazily ───────────────────────────────────────────────────────────────
// 15 MB of SDK and 3,305 files are not loaded into a deploy that does not use them. The import is
// also the one dependency failure that must NOT look like an outage: if the package is missing the
// store says so by name instead of throwing on the first proof.
let s3 = null;
let s3mod = null;

async function client() {
  if (s3) return s3;
  s3mod = await import('@aws-sdk/client-s3');
  s3 = new s3mod.S3Client({
    region: S3.region,
    ...(S3.endpoint ? { endpoint: S3.endpoint } : {}),
    forcePathStyle: S3.forcePathStyle,
    // Credentials are deliberately NOT read from bespoke variables. The SDK's default chain covers
    // AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, a shared profile, and — the one that matters in
    // production — an IAM role with no long-lived secret anywhere. Inventing our own names would
    // force an operator to keep a static key.
    maxAttempts: Number(process.env.QUIVER_PROOF_S3_MAX_ATTEMPTS || 3),
    requestHandler: { connectionTimeout: 3000, requestTimeout: OP_TIMEOUT_MS },
  });
  return s3;
}

/** An operation that hangs is indistinguishable from one that failed, and costs more. Bound both. */
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); }),
  ]);
}

/**
 * Turn an SDK error into a sentence that names the cause. This is the whole point of the exercise:
 * a 403 and a missing bucket and a DNS failure must not all arrive as "durable: false" with nothing
 * to act on. `err.name` carries the S3 error code (NoSuchBucket, AccessDenied, NotFound…) and
 * `$metadata.httpStatusCode` the status; both are printed because a same-named error can arrive with
 * different statuses from different S3-compatible implementations.
 */
function describe(e) {
  const name = (e && (e.name || e.Code)) || 'Error';
  const status = e && e.$metadata && e.$metadata.httpStatusCode;
  const msg = String((e && e.message) || e).slice(0, 160);
  return `${name}${status ? ` (HTTP ${status})` : ''}: ${msg}`;
}

const keyFor = (contentHash) => `${S3.prefix}${contentHash}.json`;
const PROBE_KEY = () => `${S3.prefix}.writable`;

// ── durability ───────────────────────────────────────────────────────────────────────────────────

/**
 * True when a proof written now would survive this process dying. CHECKED, not assumed — and the
 * check is a write, not a lookup, because "the bucket exists" and "we may put objects in it" are
 * different facts and only the second one is the one being claimed.
 *
 * Never throws. A caller gets `false` and `durabilityNote()` gets the reason.
 */
export async function durable() {
  if (BACKEND === 'off') return false;
  if (ready) return true;
  // A known-bad configuration is not re-probed on every request; a wrong bucket name would otherwise
  // add a round trip to every /build. It IS re-probed eventually, because the common cause is an IAM
  // policy or a bucket that is still being created, and a store that gave up permanently would go on
  // reporting a stale failure long after it was fixed.
  if (disabledReason && Date.now() - lastProbeAt < RETRY_MS) return false;
  if (probeInFlight) return probeInFlight;
  probeInFlight = (BACKEND === 's3' ? probeS3() : probeFs())
    .then((ok) => ok)
    .finally(() => { lastProbeAt = Date.now(); probeInFlight = null; });
  return probeInFlight;
}

async function probeFs() {
  try {
    await mkdir(DIR, { recursive: true });
    // A directory that exists but cannot be written to is the failure mode that would otherwise be
    // discovered by a 404 in production, so it is discovered here instead.
    const probe = join(DIR, '.writable');
    await writeFile(probe, 'ok');
    await unlink(probe);
    ready = true;
    disabledReason = null;
  } catch (e) {
    disabledReason = String((e && e.message) || e).slice(0, 160);
    ready = false;
  }
  return ready;
}

async function probeS3() {
  let c;
  try {
    c = await client();
  } catch (e) {
    // The one failure that is a deploy mistake rather than an outage, so it says so in those words.
    disabledReason = `QUIVER_PROOF_S3_BUCKET is set but the S3 client could not be loaded — is @aws-sdk/client-s3 installed? ${String((e && e.message) || e).slice(0, 120)}`;
    ready = false;
    return false;
  }
  try {
    // A write probe rather than HeadBucket, deliberately. HeadBucket needs s3:ListBucket, which a
    // least-privilege policy for this store does not otherwise require, so probing with it would
    // report a perfectly working store as broken. This probes exactly the permission the store uses.
    await withTimeout(c.send(new s3mod.PutObjectCommand({
      Bucket: S3.bucket, Key: PROBE_KEY(), Body: 'ok', ContentType: 'text/plain',
    })), OP_TIMEOUT_MS, 'S3 write probe');
    ready = true;
    disabledReason = null;
    // Tidying up is best-effort: a policy that grants PutObject and not DeleteObject is a working
    // store, and refusing to use it because the probe object survives would be absurd. The key is
    // fixed, so at worst one stray object exists, overwritten on every boot.
    try {
      await withTimeout(c.send(new s3mod.DeleteObjectCommand({ Bucket: S3.bucket, Key: PROBE_KEY() })), OP_TIMEOUT_MS, 'S3 probe cleanup');
    } catch { /* see above */ }
  } catch (e) {
    ready = false;
    // Classify, so the note distinguishes "you named a bucket that does not exist" from "your
    // credentials are refused" from "the endpoint did not answer". These lead to three different
    // fixes and arriving at all three as `durable: false` is the failure this store exists to avoid.
    let hint = '';
    const name = String((e && e.name) || '');
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    if (name === 'NoSuchBucket' || status === 404) hint = ' — the bucket does not exist at this endpoint/region';
    else if (name === 'AccessDenied' || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || status === 403) hint = ' — credentials were rejected, or the policy does not grant s3:PutObject on this prefix';
    else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out/i.test(String((e && e.message) || ''))) hint = ' — the endpoint could not be reached';
    disabledReason = `${location()} is unusable: ${describe(e)}${hint}`;
  }
  return ready;
}

/** Why durability is off, for the endpoint to tell the truth with. Null when it is on. */
export async function durabilityNote() {
  await durable();
  return ready ? null : disabledReason;
}

// A content hash is 64 lowercase hex characters and nothing else. This is not a courtesy check: the
// hash reaches here from a URL parameter, and `join(DIR, '../../etc/passwd.json')` is a path traversal
// if it is ever trusted — and on S3 the same string is a key, where `../` is a legal character
// sequence that silently addresses a DIFFERENT prefix rather than erroring. The route validates too;
// a store that can be handed a hash must not depend on its caller having done so.
const wellFormed = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

const pathFor = (contentHash) => join(DIR, `${contentHash}.json`);

// ── read ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read a persisted record. ALWAYS returns a Promise. Resolves to null for anything that is not a
 * readable, parseable, `ready` record — a damaged object behaves as a cache miss, which rebuilds,
 * rather than as an error that takes the endpoint down with it.
 */
export async function read(contentHash) {
  if (!wellFormed(contentHash)) return null;
  if (!(await durable())) return null;
  try {
    const raw = BACKEND === 's3' ? await readS3(contentHash) : await readFile(pathFor(contentHash), 'utf8');
    if (raw == null) return null;
    const rec = JSON.parse(raw);
    return rec && rec.status === 'ready' ? rec : null;
  } catch {
    return null;
  }
}

async function readS3(contentHash) {
  const c = await client();
  try {
    const out = await withTimeout(c.send(new s3mod.GetObjectCommand({ Bucket: S3.bucket, Key: keyFor(contentHash) })), OP_TIMEOUT_MS, 'S3 get');
    return await out.Body.transformToString();
  } catch (e) {
    // A genuine miss is the expected case and must stay silent. Anything else means the store is not
    // working, and a store that answers "no such proof" while it is broken is precisely the silent
    // fallback this whole file exists to prevent — so it is recorded and the next durable() re-probes.
    const name = String((e && e.name) || '');
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return null;
    ready = false;
    lastProbeAt = Date.now();
    disabledReason = `${location()} read failed: ${describe(e)}`;
    return null;
  }
}

// ── write ────────────────────────────────────────────────────────────────────────────────────────

// Every write in flight, so a process that is about to exit can wait for the proof it just built to
// actually land. With a synchronous store this was free; with a network round trip it is not, and a
// container that took SIGTERM one millisecond after `status: ready` would otherwise lose the proof
// while telling the caller it had one.
const inFlight = new Set();
let tmpSeq = 0;

/**
 * Persist a finished record. ALWAYS returns a Promise. Resolves false for every non-ready status and
 * whenever durability is off, so callers never have to branch on it. Never rejects.
 *
 * Not `async`, on purpose: the returned promise is registered for drain() BEFORE the first await, so
 * a process that calls write() and immediately calls drain() in the same tick still waits for it.
 */
export function write(contentHash, rec) {
  const p = writeOnce(contentHash, rec).catch(() => false);
  inFlight.add(p);
  p.then(() => inFlight.delete(p));
  return p;
}

async function writeOnce(contentHash, rec) {
  if (!wellFormed(contentHash) || !rec || rec.status !== 'ready') return false;
  if (!(await durable())) return false;
  return BACKEND === 's3' ? writeS3(contentHash, rec) : writeFs(contentHash, rec);
}

async function writeFs(contentHash, rec) {
  try {
    // Write-then-rename, because a reader can arrive mid-write. A half-written JSON file would parse
    // as damaged and be treated as a miss, which is survivable but would silently re-prove; rename is
    // atomic within a directory and removes the window entirely.
    const tmp = `${pathFor(contentHash)}.${process.pid}.${tmpSeq++}.tmp`;
    await writeFile(tmp, JSON.stringify(rec));
    await rename(tmp, pathFor(contentHash));
    await prune();
    return true;
  } catch (e) {
    // A write that fails means this store is not durable right now, whatever the probe said a minute
    // ago. Saying so is the difference between an operator seeing a full disk and an operator seeing
    // proofs quietly stop persisting.
    ready = false;
    lastProbeAt = Date.now();
    disabledReason = `${location()} write failed: ${String((e && e.message) || e).slice(0, 160)}`;
    return false;
  }
}

async function writeS3(contentHash, rec) {
  try {
    const c = await client();
    // No temp-and-rename here, and none is needed: S3 PutObject is atomic for the whole object, so a
    // concurrent GET returns either the previous object or the new one and never a truncated body.
    // (S3 has been read-after-write consistent for new objects and overwrites since December 2020.)
    await withTimeout(c.send(new s3mod.PutObjectCommand({
      Bucket: S3.bucket, Key: keyFor(contentHash), Body: JSON.stringify(rec), ContentType: 'application/json',
    })), OP_TIMEOUT_MS, 'S3 put');
    countCache = null;
    await prune();
    return true;
  } catch (e) {
    ready = false;
    lastProbeAt = Date.now();
    disabledReason = `${location()} write failed: ${describe(e)}`;
    return false;
  }
}

/**
 * Wait for every write started so far to finish. A long-lived server does not need this; a process
 * that is about to exit — a worker, a container taking SIGTERM, the child in gate A — does, because
 * the record is in memory the instant it is `ready` and on the far side of a network round trip some
 * milliseconds later.
 */
export async function drain() {
  // A loop rather than one Promise.all: a write can start another (prune), and settling the first
  // batch is not the same as being finished.
  for (let i = 0; i < 20 && inFlight.size; i++) {
    await Promise.allSettled([...inFlight]);
  }
}

// ── bounds ───────────────────────────────────────────────────────────────────────────────────────

/** Keep the store bounded, oldest first. Failure here must never fail the write that triggered it. */
async function prune() {
  try {
    if (BACKEND === 's3') return await pruneS3();
    const files = (await readdir(DIR)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    if (files.length <= MAX_FILES) return;
    const withAge = (await Promise.all(files.map(async (f) => {
      try { return { f, at: (await stat(join(DIR, f))).mtimeMs }; } catch { return null; }
    }))).filter(Boolean).sort((a, b) => a.at - b.at);
    for (const { f } of withAge.slice(0, withAge.length - MAX_FILES)) {
      try { await unlink(join(DIR, f)); } catch { /* another replica may have pruned it first */ }
    }
  } catch { /* a full or unreadable store is not a reason to lose the proof just written */ }
}

async function pruneS3() {
  const c = await client();
  // One listing capped at MAX+1. If it comes back short and untruncated there is nothing to prune AND
  // we have learned the exact count for free, which is what /build reports — so the common case costs
  // one call and the count endpoint costs none.
  const first = await withTimeout(c.send(new s3mod.ListObjectsV2Command({
    Bucket: S3.bucket, Prefix: S3.prefix, MaxKeys: MAX_FILES + 1,
  })), OP_TIMEOUT_MS, 'S3 list');
  const keep = (first.Contents || []).filter((o) => /^[0-9a-f]{64}\.json$/.test(keyTail(o.Key)));
  if (!first.IsTruncated && keep.length <= MAX_FILES) {
    countCache = { n: keep.length, at: Date.now() };
    return;
  }
  const all = await listAll(c);
  if (all.length <= MAX_FILES) { countCache = { n: all.length, at: Date.now() }; return; }
  const doomed = all.sort((a, b) => new Date(a.LastModified || 0) - new Date(b.LastModified || 0))
    .slice(0, all.length - MAX_FILES);
  for (let i = 0; i < doomed.length; i += 1000) {
    try {
      await withTimeout(c.send(new s3mod.DeleteObjectsCommand({
        Bucket: S3.bucket,
        Delete: { Objects: doomed.slice(i, i + 1000).map((o) => ({ Key: o.Key })), Quiet: true },
      })), OP_TIMEOUT_MS, 'S3 delete');
    } catch { /* another replica may have pruned it first */ }
  }
  countCache = { n: all.length - doomed.length, at: Date.now() };
}

async function listAll(c) {
  const out = [];
  let token;
  // Bounded on purpose. An unbounded pagination loop against a bucket somebody else also writes to is
  // a way to hang a request forever; 20 pages is 20,000 objects, forty times the default cap.
  for (let page = 0; page < 20; page++) {
    const r = await withTimeout(c.send(new s3mod.ListObjectsV2Command({
      Bucket: S3.bucket, Prefix: S3.prefix, ContinuationToken: token,
    })), OP_TIMEOUT_MS, 'S3 list');
    for (const o of r.Contents || []) if (/^[0-9a-f]{64}\.json$/.test(keyTail(o.Key))) out.push(o);
    if (!r.IsTruncated) break;
    token = r.NextContinuationToken;
  }
  return out;
}

// ── count ────────────────────────────────────────────────────────────────────────────────────────

/** Count of persisted proofs, for /build to report rather than claim. */
export async function count() {
  if (!(await durable())) return 0;
  try {
    if (BACKEND === 's3') {
      if (countCache && Date.now() - countCache.at < COUNT_TTL_MS) return countCache.n;
      const n = (await listAll(await client())).length;
      countCache = { n, at: Date.now() };
      return n;
    }
    return (await readdir(DIR)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}
