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
//   node --test gates/gateA-proof-durability.mjs        (npm run gate:a)
//   node gates/gateA-revert.mjs                         (npm run gate:a-revert) — proves it goes red
//
// WHY THIS LIVES IN gates/ AND NOT IN test/
// The durable store is opt-in and IS NOT DEPLOYED. The paper — which is served live at /paper/1..7
// and is byte-identical to the copy in this repo — states the size of the model-free suite, and that
// sentence describes the shipped service. Adding five tests to `test/` would move that number in the
// repo while the live paper kept the old one, and the only way to reconcile them is a deploy. So this
// gate sits beside zk/scripts/gateB*.mjs, which are outside the suite for the same reason, and it is
// documented in the README rather than hidden. When the durable store ships, this file moves into
// `test/` and the paper's count moves with it, in the same deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));   // gates/

// On Windows an absolute path in an ESM import is parsed as a URL, so `C:\...` becomes scheme "c:"
// and the loader refuses it. The child scripts below are generated, so their imports must be real
// file:// URLs rather than paths that only happen to work on one platform.
const asImport = (rel) => JSON.stringify(pathToFileURL(join(HERE, rel)).href);

// A position the rest of the suite does not prove, so a passing run can never be a warm cache left
// behind by another test. Deliberately the same discipline that fixed the MCP proof test.
const POSITION = { side: 'long', entryPrice: 2317.75, size: 3.5, leverage: 8, maintMarginRate: 0.006 };

const SCRIPTS = mkdtempSync(join(tmpdir(), 'quiver-child-'));

/** Run a snippet in a fresh node process with the given env, and return whatever it prints as JSON. */
function inChildProcess(source, env) {
  // Written outside the proof directory on purpose: a script file sitting in the store would make
  // the "exactly one file, named by its hash" assertion below pass for the wrong reason.
  const file = join(SCRIPTS, `child-${process.pid}-${source.length}.mjs`);
  writeFileSync(file, source);
  try {
    const out = execFileSync(process.execPath, [file], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    });
    const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    assert.ok(line, `child printed no JSON result. Output was:\n${out}`);
    return JSON.parse(line);
  } finally {
    try { rmSync(file); } catch { /* the temp dir goes anyway */ }
  }
}

// Built through the SAME two calls the paid route makes — engine, then proofEnvelope, then
// buildInBackground on the envelope's hash. Handing the store a hash of my own making would test the
// store against itself rather than against the thing the endpoint actually serves.
const BUILDER = `
import { perpGate } from ${asImport('../src/engine/perpGate.js')};
import { proofEnvelope } from ${asImport('../src/engine/proof.js')};
import { buildInBackground, getProof, stopProver } from ${asImport('../src/util/snark.js')};
const r = perpGate(${JSON.stringify(POSITION)});
const env = proofEnvelope('perp-gate', ${JSON.stringify(POSITION)}, r, 'gate-a');
const hash = env.proof.contentHash;
buildInBackground(hash, env.proof.inputs, r.liquidationPrice);
for (let i = 0; i < 200; i++) {
  const rec = getProof(hash);
  if (rec && rec.status !== 'building') break;
  await new Promise((s) => setTimeout(s, 100));
}
const rec = getProof(hash);
await stopProver();
console.log(JSON.stringify({ hash, status: rec && rec.status, publicSignals: rec && rec.publicSignals, pid: process.pid }));
`;

const READER = (hash) => `
import { getProof } from ${asImport('../src/util/snark.js')};
const rec = getProof(${JSON.stringify(hash)});
console.log(JSON.stringify({ found: !!rec, status: rec && rec.status, publicSignals: rec && rec.publicSignals, pid: process.pid }));
`;

test('a proof outlives the process that built it', { timeout: 240_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quiver-proofs-'));
  try {
    // ---- process 1: build, then die ------------------------------------------------------------
    const built = inChildProcess(BUILDER, { QUIVER_PROOF_DIR: dir });
    assert.equal(built.status, 'ready', `the builder process must produce a proof, got ${built.status}`);
    assert.ok(Array.isArray(built.publicSignals) && built.publicSignals.length === 8,
      'a liquidation proof has eight public signals');

    // The builder is gone by now: execFileSync does not return until the child exits.
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.deepEqual(onDisk, [`${built.hash}.json`],
      'exactly the finished proof should be on disk, named by its own content hash');

    // ---- process 2: a different pid reads it ---------------------------------------------------
    const read = inChildProcess(READER(built.hash), { QUIVER_PROOF_DIR: dir });
    assert.notEqual(read.pid, built.pid, 'the reader must genuinely be a different process');
    assert.equal(read.found, true, 'the second process must find the proof the first one built');
    assert.equal(read.status, 'ready');
    assert.deepEqual(read.publicSignals, built.publicSignals,
      'and it must be the same proof, signal for signal, not merely some proof');

    // ---- the same read WITHOUT the store must fail ---------------------------------------------
    // Inline negative control. Without this, every assertion above would still pass if getProof
    // silently rebuilt the proof, and the test would be measuring the prover rather than the store.
    const blind = inChildProcess(READER(built.hash), { QUIVER_PROOF_DIR: '' });
    assert.equal(blind.found, false,
      'a process with no durable store configured must NOT find the proof — otherwise this test is not measuring durability');

    t.diagnostic(`built by pid ${built.pid}, read by pid ${read.pid}, invisible to a pid with no store`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only finished proofs are persisted, and a damaged file reads as a miss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiver-proofs-'));
  try {
    process.env.QUIVER_PROOF_DIR = dir;
    const store = await import(`../src/util/proofStore.js?fresh=${Date.now()}`);
    assert.equal(store.durable(), true, 'a writable directory must register as durable');

    const h = 'a'.repeat(64);
    const ready = { status: 'ready', proof: { A: ['1', '2'] }, publicSignals: ['3', '4'], gapToServedPrice: 0.0012 };

    // Every non-ready status is refused, because a refusal or an in-flight build is a fact about a
    // process and not about arithmetic.
    for (const status of ['building', 'failed', 'unavailable']) {
      assert.equal(store.write(h, { status, error: 'x' }), false, `${status} must not be persisted`);
    }
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0);

    assert.equal(store.write(h, ready), true);
    assert.deepEqual(store.read(h), ready, 'what comes back must be what went in, field for field');

    // A path that is not a content hash must not be reachable, or the store is a traversal primitive.
    assert.equal(store.write('../../escape', ready), false);
    assert.equal(store.read('../../escape'), null);

    // A truncated file is a miss, not a crash: a miss rebuilds, an exception takes the endpoint down.
    writeFileSync(join(dir, `${h}.json`), '{"status":"rea');
    assert.equal(store.read(h), null, 'a damaged record must read as a miss');
    assert.doesNotThrow(() => store.read(h));

    // And a well-formed file that is not `ready` must not be served either, whatever put it there.
    writeFileSync(join(dir, `${h}.json`), JSON.stringify({ status: 'building' }));
    assert.equal(store.read(h), null);
  } finally {
    delete process.env.QUIVER_PROOF_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the durable store stays bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiver-proofs-'));
  try {
    process.env.QUIVER_PROOF_DIR = dir;
    process.env.QUIVER_PROOF_MAX = '10';
    const store = await import(`../src/util/proofStore.js?bounded=${Date.now()}`);

    const hashes = [];
    for (let i = 0; i < 25; i++) {
      const h = i.toString(16).padStart(64, '0');
      hashes.push(h);
      store.write(h, { status: 'ready', publicSignals: [String(i)] });
    }
    const left = readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    assert.ok(left.length <= 10, `the directory must stay bounded, found ${left.length} files`);
    assert.equal(store.count(), left.length, 'the count reported to /build must be the real one');

    // Bounded is only useful if it keeps the RECENT ones: evicting the newest would mean a proof is
    // gone the moment it is built under load.
    assert.equal(store.read(hashes.at(-1)) !== null, true, 'the most recent proof must survive pruning');
    assert.equal(existsSync(join(dir, `${hashes[0]}.json`)), false, 'the oldest must be the one evicted');
  } finally {
    delete process.env.QUIVER_PROOF_DIR;
    delete process.env.QUIVER_PROOF_MAX;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no store configured, nothing is written and nothing changes', async () => {
  delete process.env.QUIVER_PROOF_DIR;
  const store = await import(`../src/util/proofStore.js?off=${Date.now()}`);
  assert.equal(store.durable(), false, 'durability is opt-in; unset must mean off');
  assert.equal(store.write('b'.repeat(64), { status: 'ready' }), false);
  assert.equal(store.read('b'.repeat(64)), null);
  assert.equal(store.count(), 0);
  assert.match(String(store.durabilityNote()), /QUIVER_PROOF_DIR/,
    'and it must say WHY it is off, so a deploy that meant to enable it can tell that it did not');
});

test('an unwritable directory reports itself off rather than pretending', async () => {
  // A path under a regular FILE cannot be created as a directory on any platform, which is the
  // portable way to produce "configured but unusable" without depending on unix permissions.
  const blocker = join(mkdtempSync(join(tmpdir(), 'quiver-blocker-')), 'not-a-dir');
  writeFileSync(blocker, 'x');
  try {
    process.env.QUIVER_PROOF_DIR = join(blocker, 'proofs');
    const store = await import(`../src/util/proofStore.js?broken=${Date.now()}`);
    assert.equal(store.durable(), false, 'an unusable path must not report as durable');
    assert.equal(store.write('c'.repeat(64), { status: 'ready' }), false);
    assert.ok(store.durabilityNote(), 'and the reason must be available, not swallowed');
    assert.equal(readFileSync(blocker, 'utf8'), 'x', 'and nothing may be written over the blocker');
  } finally {
    delete process.env.QUIVER_PROOF_DIR;
    rmSync(blocker, { force: true });
  }
});
