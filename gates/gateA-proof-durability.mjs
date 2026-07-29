// GATE A — does a proof survive the process that built it?
//
// The claim being tested is the one Phase A of the roadmap makes: "a proof survives a redeploy and a
// second replica; /proof/<hash> answers identically from any instance; a test kills the process
// between build and fetch and the fetch still succeeds."
//
// So this does not check that a Map remembers a value. It spawns a REAL child process, has it build a
// real proof, waits for that process to exit, and then reads the proof from a second, unrelated
// process. Any test that stays inside one process would pass whether or not the feature exists, and a
// test that cannot fail is not evidence. The first case carries its own negative control: a third
// process with no store configured must NOT find the same proof.
//
// EVERY CASE BELOW RUNS TWICE, once per backend — the filesystem store and the S3 store — with the
// same assertions. The filesystem half needs nothing: no credentials, no network, no container. The
// S3 half runs against a real S3 implementation when QUIVER_TEST_S3_ENDPOINT names one, and otherwise
// against the emulator in gates/s3-emulator.mjs, which holds the objects in THIS process's memory —
// so the child that builds a proof still exits and the store still outlives it. The gate prints which
// of the two it used; see PHASE_A_S3.md for what each can and cannot establish.
//
//   node --test gates/gateA-proof-durability.mjs        (npm run gate:a)
//   node gates/gateA-revert.mjs                         (npm run gate:a-revert) — proves it goes red
//
//   QUIVER_TEST_S3_ENDPOINT=http://127.0.0.1:9010 QUIVER_TEST_S3_BUCKET=quiver-proofs \
//     AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… npm run gate:a     — against a real S3 server
//
// WHY THIS LIVES IN gates/ AND NOT IN test/, AND WHY IT IS STAYING THERE
// An earlier version of this comment said the file would move into `test/` "when the durable store
// ships". It is not moving, and the reason is the same one that put it here. The paper — served live
// at /paper/1..7 and byte-identical to the copy in this repo — states the size of the model-free
// suite, and that sentence describes the SHIPPED service. Moving these cases into `test/` changes the
// suite size in the repo while the live paper keeps the old number, and the only way to reconcile the
// two is a deploy of the paper. The durable store is opt-in and OFF in the live deployment, so the
// paper would have to be re-cut to describe a feature that is not running. Meanwhile a gate is not a
// lesser thing than a test here: gates/ holds the checks that spawn processes, bind sockets and talk
// to networks, and this one does all three. It stays, it is wired into package.json as `gate:a`, it
// has a scripted revert, and it is documented in the README rather than hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startS3 } from './s3-emulator.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));   // gates/

// On Windows an absolute path in an ESM import is parsed as a URL, so `C:\...` becomes scheme "c:"
// and the loader refuses it. The child scripts below are generated, so their imports must be real
// file:// URLs rather than paths that only happen to work on one platform.
const asImport = (rel) => JSON.stringify(pathToFileURL(join(HERE, rel)).href);

// A position the rest of the suite does not prove, so a passing run can never be a warm cache left
// behind by another test. Deliberately the same discipline that fixed the MCP proof test.
const POSITION = { side: 'long', entryPrice: 2317.75, size: 3.5, leverage: 8, maintMarginRate: 0.006 };

const SCRIPTS = mkdtempSync(join(tmpdir(), 'quiver-child-'));

/**
 * Run a snippet in a fresh node process with the given env, wait for that process to EXIT, and return
 * whatever it printed as JSON.
 *
 * Deliberately NOT execFileSync, which is what this used to be. execFileSync blocks the calling
 * thread, and the S3 emulator these children talk to runs on THIS thread — so a synchronous wait
 * deadlocks: the child asks the parent for a socket the parent will not service until the child has
 * exited. It presented as an 8-second SDK timeout inside the child followed by a two-minute hang, and
 * it is worth recording because the same shape is waiting for anyone who adds a child process to a
 * gate that also serves one. Awaiting `exit` gives the identical guarantee — the process is gone
 * before the assertions run — without owning the event loop while it happens.
 */
function inChildProcess(source, env) {
  // Written outside the proof directory on purpose: a script file sitting in the store would make
  // the "exactly one file, named by its hash" assertion below pass for the wrong reason.
  const file = join(SCRIPTS, `child-${process.pid}-${source.length}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, source);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child did not exit within 120s. stdout:\n${out}\nstderr:\n${err}`)); }, 120_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      try { rmSync(file); } catch { /* the temp dir goes anyway */ }
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (!line) return reject(new Error(`child exited ${code} without printing a JSON result.\nstdout:\n${out}\nstderr:\n${err}`));
      resolve(JSON.parse(line));
    });
  });
}

// Built through the SAME two calls the paid route makes — engine, then proofEnvelope, then
// buildInBackground on the envelope's hash. Handing the store a hash of my own making would test the
// store against itself rather than against the thing the endpoint actually serves.
//
// `flushProofWrites()` before printing, because with a network store `status: ready` is true in memory
// some milliseconds before it is true anywhere a second process can see it. Without that wait this
// child would race its own proof to the exit and the gate would flake — which is a real property of
// the production path too, and is why src/server.js drains on SIGTERM.
const BUILDER = `
import { perpGate } from ${asImport('../src/engine/perpGate.js')};
import { proofEnvelope } from ${asImport('../src/engine/proof.js')};
import { buildInBackground, getProof, stopProver, flushProofWrites } from ${asImport('../src/util/snark.js')};
const r = perpGate(${JSON.stringify(POSITION)});
const env = proofEnvelope('perp-gate', ${JSON.stringify(POSITION)}, r, 'gate-a');
const hash = env.proof.contentHash;
buildInBackground(hash, env.proof.inputs, r.liquidationPrice);
for (let i = 0; i < 200; i++) {
  const rec = await getProof(hash);
  if (rec && rec.status !== 'building') break;
  await new Promise((s) => setTimeout(s, 100));
}
const rec = await getProof(hash);
await flushProofWrites();
await stopProver();
console.log(JSON.stringify({ hash, status: rec && rec.status, publicSignals: rec && rec.publicSignals, pid: process.pid }));
`;

const READER = (hash) => `
import { getProof } from ${asImport('../src/util/snark.js')};
const rec = await getProof(${JSON.stringify(hash)});
console.log(JSON.stringify({ found: !!rec, status: rec && rec.status, publicSignals: rec && rec.publicSignals, pid: process.pid }));
`;

// A whole service, in its own process, with the store configured — so the assertion is on the BYTES
// /proof/<hash> serves and not on what the store returns to a caller who remembered to await it.
const SERVER = `
import app from ${asImport('../src/app.js')};
const s = app.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: s.address().port, pid: process.pid })));
`;

/** Boot src/app.js in a child, wait for it to print its port, and hand back a fetcher and a kill. */
async function serviceInChildProcess(env) {
  const file = join(SCRIPTS, `server-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, SERVER);
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const hello = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the service child never printed a port. stderr:\n${err}`)), 60_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(t); resolve(JSON.parse(line)); }
    });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`the service child exited with ${c}. stderr:\n${err}`)); });
  });
  return {
    pid: hello.pid,
    get: async (path) => {
      const res = await fetch(`http://127.0.0.1:${hello.port}${path}`);
      return { status: res.status, body: await res.json() };
    },
    stop: () => { try { child.kill(); } catch { /* already gone */ } try { rmSync(file); } catch { /* temp */ } },
  };
}

// ── the two backends, behind one interface ───────────────────────────────────────────────────────
// Everything below is written once and run against both. A backend that only satisfied a test written
// for it would prove nothing about the property; the point is that the SAME assertions hold.

const REAL_S3 = process.env.QUIVER_TEST_S3_ENDPOINT || null;

/**
 * Set env for a test and hand back the undo. Save-and-restore rather than delete-when-done: the S3
 * backend's env includes AWS_ACCESS_KEY_ID, and when this was a `delete` loop it wiped the operator's
 * real credentials out of the runner after the first S3 case, so the third one failed with
 * InvalidAccessKeyId against a perfectly working bucket. A cleanup that destroys the state it was
 * only supposed to shadow makes the case that runs after it fail for a reason that has nothing to do
 * with what it tests.
 */
function withEnv(env) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

function filesystemBackend() {
  const dir = mkdtempSync(join(tmpdir(), 'quiver-proofs-'));
  return {
    name: 'filesystem',
    where: dir,
    env: { QUIVER_PROOF_DIR: dir, QUIVER_PROOF_S3_BUCKET: '' },
    blindEnv: { QUIVER_PROOF_DIR: '', QUIVER_PROOF_S3_BUCKET: '' },
    expectedKind: 'content-addressed files',
    stored: () => readdirSync(dir).filter((f) => f.endsWith('.json')),
    poke: (hash, text) => writeFileSync(join(dir, `${hash}.json`), text),
    close: async () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

async function s3Backend() {
  // A unique prefix per run, so two runs — or a run against a bucket somebody else is also using —
  // cannot see each other's objects and turn a stale proof into a pass.
  const prefix = `gate-a/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  const emulator = REAL_S3 ? null : await startS3({ buckets: ['quiver-gate-a'] });
  const bucket = REAL_S3 ? (process.env.QUIVER_TEST_S3_BUCKET || 'quiver-proofs') : 'quiver-gate-a';
  const endpoint = REAL_S3 || emulator.endpoint;
  const env = {
    QUIVER_PROOF_DIR: '',
    QUIVER_PROOF_S3_BUCKET: bucket,
    QUIVER_PROOF_S3_ENDPOINT: endpoint,
    QUIVER_PROOF_S3_PREFIX: prefix,
    QUIVER_PROOF_S3_REGION: process.env.QUIVER_TEST_S3_REGION || 'us-east-1',
    // The emulator does not check signatures — see its header for what that does and does not prove —
    // but the SDK refuses to send a request it cannot sign, so it still needs something to sign with.
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'gate-a',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'gate-a-secret',
  };
  // Listing through the store's own client keeps the "what is actually stored" question answerable
  // for a real endpoint as well as for the emulator, rather than only for the one we can reach into.
  // Credentials passed explicitly rather than read from process.env: this client is built while a
  // test is holding shadowed environment, and a helper that silently picks up whatever happens to be
  // ambient is how the previous version of this file failed against a working bucket.
  const helper = async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    return new S3Client({
      region: env.QUIVER_PROOF_S3_REGION, endpoint, forcePathStyle: true,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    });
  };
  const list = async () => {
    if (emulator) return emulator.keys().filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const r = await (await helper()).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    return (r.Contents || []).map((o) => o.Key.slice(prefix.length));
  };
  const put = async (key, text) => {
    if (emulator) return emulator.poke(prefix + key, text);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await helper()).send(new PutObjectCommand({ Bucket: bucket, Key: prefix + key, Body: text }));
  };
  return {
    name: REAL_S3 ? `S3 (real endpoint ${endpoint})` : 'S3 (in-process emulator)',
    where: `s3://${bucket}/${prefix}`,
    emulator,
    env,
    blindEnv: { QUIVER_PROOF_DIR: '', QUIVER_PROOF_S3_BUCKET: '' },
    expectedKind: 'content-addressed objects in S3',
    stored: async () => (await list()).filter((k) => k.endsWith('.json')),
    poke: (hash, text) => put(`${hash}.json`, text),
    close: async () => { if (emulator) await emulator.close(); },
  };
}

const BACKENDS = [filesystemBackend, s3Backend];

// ── the cases ────────────────────────────────────────────────────────────────────────────────────

for (const make of BACKENDS) {
  const label = make === filesystemBackend ? 'filesystem' : 's3';

  test(`[${label}] a proof outlives the process that built it, and the endpoint serves it`, { timeout: 300_000 }, async (t) => {
    const backend = await make();
    let service = null;
    try {
      t.diagnostic(`backend: ${backend.name} at ${backend.where}`);

      // ---- process 1: build, then die ----------------------------------------------------------
      const built = await inChildProcess(BUILDER, backend.env);
      assert.equal(built.status, 'ready', `the builder process must produce a proof, got ${built.status}`);
      assert.ok(Array.isArray(built.publicSignals) && built.publicSignals.length === 8,
        'a liquidation proof has eight public signals');

      // The builder is gone by now: inChildProcess resolves on the child's exit event.
      const stored = await backend.stored();
      assert.deepEqual(stored, [`${built.hash}.json`],
        'exactly the finished proof should be in the store, named by its own content hash');

      // ---- process 2: a different pid reads it -------------------------------------------------
      const read = await inChildProcess(READER(built.hash), backend.env);
      assert.notEqual(read.pid, built.pid, 'the reader must genuinely be a different process');
      assert.equal(read.found, true, 'the second process must find the proof the first one built');
      assert.equal(read.status, 'ready');
      assert.deepEqual(read.publicSignals, built.publicSignals,
        'and it must be the same proof, signal for signal, not merely some proof');

      // ---- the same read WITHOUT the store must fail -------------------------------------------
      // Inline negative control. Without this, every assertion above would still pass if getProof
      // silently rebuilt the proof, and the test would be measuring the prover rather than the store.
      const blind = await inChildProcess(READER(built.hash), backend.blindEnv);
      assert.equal(blind.found, false,
        'a process with no durable store configured must NOT find the proof — otherwise this test is not measuring durability');

      // ---- process 3: the SERVICE, in its own process, serving /proof/<hash> --------------------
      // This is the assertion that catches the specific way this change could go wrong. The store is
      // asynchronous now; a route that reads it without awaiting gets a Promise, `res.json` renders a
      // Promise as `{}`, and the endpoint answers 200 with an empty body that reads exactly like a
      // cache miss. Asserting on the store's return value would not see that. Asserting on the bytes
      // this route serves does.
      service = await serviceInChildProcess(backend.env);
      assert.notEqual(service.pid, built.pid, 'the service must not be the process that built the proof');
      const served = await service.get(`/proof/${built.hash}`);
      assert.equal(served.status, 200, `/proof/<hash> must answer 200 from a replica that never built it, got ${served.status}`);
      assert.equal(served.body.status, 'ready');
      assert.deepEqual(served.body.publicSignals, built.publicSignals,
        'the endpoint must serve the same eight signals the builder produced');
      assert.ok(served.body.proof && Object.keys(served.body.proof).length > 0,
        'the served proof must not be an empty object — an unawaited store read serialises as {}');

      // ---- and /build must report the backend it is actually using ------------------------------
      const build = await service.get('/build');
      assert.equal(build.body.proofStorage.durable, true, '/build must report the store as durable');
      assert.equal(build.body.proofStorage.kind, backend.expectedKind,
        '`kind` must name the backend that is live, not a generic word');
      assert.ok(build.body.proofStorage.stored >= 1, 'and it must count the proof that is really there');
      assert.deepEqual(Object.keys(build.body.proofStorage).sort(), ['durable', 'kind', 'note', 'stored'],
        'the published shape of /build.proofStorage must not move');

      t.diagnostic(`built by pid ${built.pid}, read by pid ${read.pid}, served by pid ${service.pid}, invisible to a pid with no store`);
    } finally {
      if (service) service.stop();
      await backend.close();
    }
  });

  test(`[${label}] only finished proofs are persisted, and a damaged record reads as a miss`, async () => {
    const backend = await make();
    const restore = withEnv(backend.env);
    try {
      const store = await import(`../src/util/proofStore.js?fresh=${label}${Date.now()}`);
      assert.equal(await store.durable(), true, 'a writable store must register as durable');
      assert.equal(store.kind(), backend.expectedKind);

      const h = 'a'.repeat(64);
      const ready = { status: 'ready', proof: { A: ['1', '2'] }, publicSignals: ['3', '4'], gapToServedPrice: 0.0012 };

      // Every non-ready status is refused, because a refusal or an in-flight build is a fact about a
      // process and not about arithmetic.
      for (const status of ['building', 'failed', 'unavailable']) {
        assert.equal(await store.write(h, { status, error: 'x' }), false, `${status} must not be persisted`);
      }
      assert.equal((await backend.stored()).length, 0);

      assert.equal(await store.write(h, ready), true);
      assert.deepEqual(await store.read(h), ready, 'what comes back must be what went in, field for field');

      // A key that is not a content hash must not be reachable, or the store is a traversal primitive
      // — on disk it escapes the directory, and on S3 `../` is a legal key that silently addresses a
      // different prefix rather than erroring.
      assert.equal(await store.write('../../escape', ready), false);
      assert.equal(await store.read('../../escape'), null);

      // A truncated record is a miss, not a crash: a miss rebuilds, an exception takes the endpoint down.
      await backend.poke(h, '{"status":"rea');
      assert.equal(await store.read(h), null, 'a damaged record must read as a miss');
      await assert.doesNotReject(() => store.read(h));

      // And a well-formed record that is not `ready` must not be served either, whatever put it there.
      await backend.poke(h, JSON.stringify({ status: 'building' }));
      assert.equal(await store.read(h), null);
    } finally {
      restore();
      await backend.close();
    }
  });

  test(`[${label}] the durable store stays bounded`, async () => {
    const backend = await make();
    const restore = withEnv({ ...backend.env, QUIVER_PROOF_MAX: '10', QUIVER_PROOF_COUNT_TTL_MS: '0' });
    try {
      const store = await import(`../src/util/proofStore.js?bounded=${label}${Date.now()}`);

      const hashes = [];
      for (let i = 0; i < 25; i++) {
        const h = i.toString(16).padStart(64, '0');
        hashes.push(h);
        // Awaited one at a time. Concurrent writes would race their own pruning and the surviving set
        // would depend on scheduling, which is a flaky test dressed up as a concurrency test.
        await store.write(h, { status: 'ready', publicSignals: [String(i)] });
      }
      const left = (await backend.stored()).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
      assert.ok(left.length <= 10, `the store must stay bounded, found ${left.length} records`);
      assert.equal(await store.count(), left.length, 'the count reported to /build must be the real one');

      // Bounded is only useful if it keeps the RECENT ones: evicting the newest would mean a proof is
      // gone the moment it is built under load.
      assert.notEqual(await store.read(hashes.at(-1)), null, 'the most recent proof must survive pruning');
      assert.equal(left.includes(`${hashes[0]}.json`), false, 'the oldest must be the one evicted');
    } finally {
      restore();
      await backend.close();
    }
  });
}

test('with no store configured, nothing is written and nothing changes', async () => {
  const restore = withEnv({ QUIVER_PROOF_DIR: '', QUIVER_PROOF_S3_BUCKET: '' });
  try {
    const store = await import(`../src/util/proofStore.js?off=${Date.now()}`);
    assert.equal(await store.durable(), false, 'durability is opt-in; unset must mean off');
    assert.equal(store.kind(), 'in-memory only');
    assert.equal(await store.write('b'.repeat(64), { status: 'ready' }), false);
    assert.equal(await store.read('b'.repeat(64)), null);
    assert.equal(await store.count(), 0);
    assert.match(String(await store.durabilityNote()), /QUIVER_PROOF_DIR/,
      'and it must say WHY it is off, so a deploy that meant to enable it can tell that it did not');
    assert.match(String(await store.durabilityNote()), /QUIVER_PROOF_S3_BUCKET/,
      'naming both ways of turning it on, because naming one sends an operator to fix the wrong thing');
  } finally {
    restore();
  }
});

test('an unwritable directory reports itself off rather than pretending', async () => {
  // A path under a regular FILE cannot be created as a directory on any platform, which is the
  // portable way to produce "configured but unusable" without depending on unix permissions.
  const blocker = join(mkdtempSync(join(tmpdir(), 'quiver-blocker-')), 'not-a-dir');
  writeFileSync(blocker, 'x');
  const restore = withEnv({ QUIVER_PROOF_DIR: join(blocker, 'proofs'), QUIVER_PROOF_S3_BUCKET: '' });
  try {
    const store = await import(`../src/util/proofStore.js?broken=${Date.now()}`);
    assert.equal(await store.durable(), false, 'an unusable path must not report as durable');
    assert.equal(await store.write('c'.repeat(64), { status: 'ready' }), false);
    assert.ok(await store.durabilityNote(), 'and the reason must be available, not swallowed');
    assert.equal(readFileSync(blocker, 'utf8'), 'x', 'and nothing may be written over the blocker');
  } finally {
    restore();
    rmSync(blocker, { force: true });
  }
});

test('a bucket that does not exist is a NAMED refusal, not a silent miss', async () => {
  // The failure this whole rebuild is designed against: point the store at something that is not
  // there and have it quietly answer "no such proof" forever while /build says everything is fine.
  // Three separate things have to hold — durable() is false, the reason names the cause, and the
  // ENDPOINT repeats it — because a store that knows and does not say is the same as one that does
  // not know.
  const emulator = await startS3({ buckets: ['a-bucket-that-is-not-the-one-we-ask-for'] });
  const env = {
    QUIVER_PROOF_DIR: '',
    QUIVER_PROOF_S3_BUCKET: 'no-such-bucket',
    QUIVER_PROOF_S3_ENDPOINT: emulator.endpoint,
    QUIVER_PROOF_S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'gate-a',
    AWS_SECRET_ACCESS_KEY: 'gate-a-secret',
  };
  const restore = withEnv(env);
  let service = null;
  try {
    const store = await import(`../src/util/proofStore.js?nobucket=${Date.now()}`);
    assert.equal(await store.durable(), false, 'a bucket that is not there must not report as durable');
    const why = String(await store.durabilityNote());
    assert.match(why, /NoSuchBucket|404/, `the refusal must name the cause; got: ${why}`);
    assert.match(why, /no-such-bucket/, 'and it must name what it was pointed at');
    assert.equal(await store.write('d'.repeat(64), { status: 'ready' }), false);
    assert.equal(await store.read('d'.repeat(64)), null);

    service = await serviceInChildProcess(env);
    const build = await service.get('/build');
    assert.equal(build.body.proofStorage.durable, false, '/build must not claim durability it does not have');
    assert.equal(build.body.proofStorage.kind, 'content-addressed objects in S3',
      'and it must still say which backend was CONFIGURED — "in-memory only" here would hide the misconfiguration');
    assert.match(build.body.proofStorage.note, /NoSuchBucket|404/,
      'the endpoint must publish the reason, not just the false');
    const miss = await service.get(`/proof/${'d'.repeat(64)}`);
    assert.equal(miss.status, 404);
    assert.match(miss.body.note, /CONFIGURED BUT NOT WORKING/,
      'a 404 from a broken store must not read like a 404 from a store nobody turned on');
  } finally {
    if (service) service.stop();
    restore();
    await emulator.close();
  }
});

test('a store that breaks AFTER it was healthy stops claiming to be durable', async () => {
  // The dangerous case is not a bucket that was never there — that is caught at boot. It is a store
  // that probes clean, serves for an hour, and then starts refusing: an IAM policy edited underneath
  // us, a bucket policy change, an outage. If a write failure is swallowed, the process keeps
  // answering `durable: true` and quietly reverts to being a Map, which is the exact claim the
  // endpoint exists to not make.
  const emulator = await startS3({ buckets: ['quiver-gate-a'] });
  const restore = withEnv({
    QUIVER_PROOF_DIR: '',
    QUIVER_PROOF_S3_BUCKET: 'quiver-gate-a',
    QUIVER_PROOF_S3_ENDPOINT: emulator.endpoint,
    QUIVER_PROOF_S3_REGION: 'us-east-1',
    QUIVER_PROOF_S3_MAX_ATTEMPTS: '1',
    QUIVER_PROOF_S3_RETRY_MS: '15000',
    AWS_ACCESS_KEY_ID: 'gate-a',
    AWS_SECRET_ACCESS_KEY: 'gate-a-secret',
  });
  try {
    const store = await import(`../src/util/proofStore.js?broke=${Date.now()}`);
    const h = 'e'.repeat(64);
    assert.equal(await store.durable(), true, 'it starts healthy, or this test proves nothing');
    assert.equal(await store.write(h, { status: 'ready', publicSignals: ['1'] }), true);

    emulator.setFault('deny');   // every request now answers 403 AccessDenied
    assert.equal(await store.write('f'.repeat(64), { status: 'ready', publicSignals: ['2'] }), false,
      'a write that S3 refused must return false, not a shrug');
    assert.equal(await store.durable(), false,
      'and the store must stop reporting itself durable — a silent fall back to memory is the failure this gate exists for');
    const why = String(await store.durabilityNote());
    assert.match(why, /AccessDenied|403/, `the reason must name the cause; got: ${why}`);

    emulator.setFault(null);
    // And it must recover on its own once the cause is gone, or an operator who fixes an IAM policy
    // has to restart every replica to be believed.
    process.env.QUIVER_PROOF_S3_RETRY_MS = '0';
    const recovered = await import(`../src/util/proofStore.js?recover=${Date.now()}`);
    assert.equal(await recovered.durable(), true, 'a fixed store must be usable again without a redeploy');
  } finally {
    restore();
    await emulator.close();
  }
});

test('the S3 half of this gate ran against something, and says which', async () => {
  // A gate that skips silently is worse than no gate: it is a green tick for a code path nobody
  // executed. So the fact of WHICH endpoint the S3 cases used is itself asserted and printed.
  const backend = await s3Backend();
  try {
    assert.ok(backend.env.QUIVER_PROOF_S3_ENDPOINT, 'the S3 cases must have had an endpoint to talk to');
    assert.match(backend.name, REAL_S3 ? /real endpoint/ : /emulator/);
    console.log(`\n  S3 cases ran against: ${backend.name}`);
    console.log(REAL_S3
      ? '  A real S3 implementation: signatures are verified, so credentials and SigV4 are covered.'
      : '  The in-process emulator: wiring, cross-process durability and error shapes are covered;\n'
        + '  SigV4 and IAM are NOT — set QUIVER_TEST_S3_ENDPOINT to cover those too.');
  } finally {
    await backend.close();
  }
});
