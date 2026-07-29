// Succinct proofs for the liquidation identity, built off the request path.
//
// WHY OFF THE PATH. Plonk proving is 703 ms median, measured; Groth16 is 32 ms. The fast one is not
// available to us honestly — its circuit-specific ceremony had a single participant and it was our
// machine, so anyone holding that secret can forge. Plonk uses the public Hermez reference string.
// The 703 ms is not a parsing problem that a bigger machine fixes: reading the 5.3 MB key accounts
// for 187 ms of it and the remaining ~510 ms is FFT and MSM work in WASM. Moving that to Lambda makes
// it slower, not faster.
//
// So the caller does not wait for it. A caller who wants an on-chain proof is going to submit it in a
// transaction that takes seconds to confirm; 703 ms is invisible next to block time, and making the
// synchronous path pay for it would be optimising the wrong thing. The paid response returns at its
// usual speed carrying a retrieval URL, the proof is built in the background, and a free GET fetches
// it by content hash — which also lets a third party pull the proof for someone else's answer.
//
// AND IT LEAVES THIS THREAD. Deferring the work off the request path was not enough. Node runs one
// thread, so a proof being built for caller A blocked the event loop for up to 506 ms — measured —
// and caller B, who asked for no proof at all, paid for it. Production showed that as a p95 of one
// full second. The prover now lives in a worker (proverWorker.mjs) along with the snarkjs import and
// the 5.3 MB key, and this file keeps only integer encoding and a queue.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { attestSignals } from './attest.js';
import * as proofStore from './proofStore.js';

const require = createRequire(import.meta.url);
const scale = require('./scale.cjs');

const ZK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'zk');
const PROTOCOL = 'plonk';

// One long-lived worker. Spawning per proof would pay the snarkjs import and the 5.3MB zkey read
// every time; keeping one alive pays it once and leaves the main thread untouched either way.
let worker = null;
let nextJob = 1;
const pending = new Map();   // job id -> { resolve, reject }

function ensureWorker() {
  if (worker) return worker;
  worker = fork(fileURLToPath(new URL('./proverWorker.mjs', import.meta.url)), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  worker.on('message', (m) => {
    if (!m || m.warmed !== undefined) return;              // warm acknowledgement, nothing to settle
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
  });
  // If the worker dies — OOM, an unhandled fault in WASM — every job waiting on it must be told,
  // or a caller polls `building` forever and the queue never drains. The next request respawns it.
  const die = (why) => {
    for (const [, p] of pending) p.reject(new Error(`prover worker ${why}`));
    pending.clear();
    worker = null;
  };
  worker.on('error', (e) => die(`failed: ${e && e.message}`));
  worker.on('exit', (code) => { if (worker) die(`exited with code ${code}`); });
  worker.unref();   // a proving process must never be the reason the parent refuses to shut down
  return worker;
}

function prove(witness) {
  const w = ensureWorker();
  const id = nextJob++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.send({ id, witness });
  });
}

/**
 * Start the worker and have it load snarkjs and the proving key, without blocking boot and without
 * doing any of it on this thread. Safe to call more than once.
 */
export function warmProver() {
  const w = ensureWorker();
  w.send({ warm: true });
  return Promise.resolve(w);
}

/** Shut the prover down. Tests need this; a long-lived server does not. */
export async function stopProver() {
  if (!worker) return;
  const w = worker;
  worker = null;
  w.kill();
}

// Content-hash-keyed store. Identical inputs produce an identical proof, so a repeat request is
// answered from here rather than re-proved. Bounded, because an unbounded cache on a public endpoint
// is a memory-exhaustion primitive.
const MAX = 200;
const store = new Map();   // contentHash -> { status, proof?, publicSignals?, error?, at }

// On a memory miss, ask the durable store before answering 404: the proof may have been built by a
// process that no longer exists, or by a different replica.
//
// ASYNC, ALWAYS. It used to be synchronous, and the comment here defended that: a disk read is a few
// kilobytes and making it async would change the shape of every caller. The S3 backend removes the
// choice — the SDK is async — and a function that returned a record for one backend and a Promise
// for the other would be the worst possible outcome, because `res.json()` serialises a Promise as
// `{}` and /proof/<hash> would answer 200 with an empty body that reads exactly like a cache miss.
// So it is a Promise on every path, including the memory hit, and a forgotten `await` fails on the
// first call rather than only on the deploy that has S3 configured.
export async function getProof(contentHash) {
  const hot = store.get(contentHash);
  if (hot) return hot;
  const cold = await proofStore.read(contentHash);
  if (cold) store.set(contentHash, cold);   // hydrate, so the next poll costs nothing
  return cold || null;
}

function put(contentHash, rec) {
  if (store.size >= MAX) store.delete(store.keys().next().value);
  const full = { ...rec, at: new Date().toISOString() };
  store.set(contentHash, full);
  // No-op unless durability is configured, and only ever for `ready`. See proofStore.js for why a
  // `building` or `failed` record must not outlive the process that decided it. The promise is
  // returned rather than dropped: with a network store the record is in memory some milliseconds
  // before it is anywhere else, and something has to be able to wait for that.
  return proofStore.write(contentHash, full);
}

/**
 * Settle everything: the proving queue, then every durable write it started. A long-lived server does
 * not need this. A process that is about to exit does — the store call is a network round trip now,
 * and `status: ready` is true in memory before it is true anywhere a second process can see it.
 */
export async function flushProofWrites() {
  await queue.catch(() => {});
  await proofStore.drain();
}

/**
 * Build the witness for the liquidation identity from a perp-gate result.
 * Returns null when the position is not one the circuit can speak about, rather than proving
 * something adjacent — a proof of a different position is worse than no proof.
 */
export function witnessFor(echoedInputs, liquidationPrice) {
  const { side, entryPrice, size, maintMarginRate, leverage } = echoedInputs || {};
  // The engine takes EITHER margin or leverage and derives the other. It does echo a `margin` back,
  // but as `round(M, 2)` for display, so reading it would certify a position up to half a cent of
  // margin away from the one that was priced — and the divergence guard would wave that through,
  // because the liquidation price only moves 0.00015 in response. So margin is recomputed here at
  // full precision, with the engine's expression in the engine's order:
  //   notionalEntry = q * P0;  M = margin ?? notionalEntry / leverage
  // Any other arrangement of the same algebra can land on a different double, and a witness built on
  // a different double is a proof about a different position.
  const margin = echoedInputs && echoedInputs.margin != null
    ? Number(echoedInputs.margin)
    : (Number(leverage) > 0 && Number.isFinite(size) && Number.isFinite(entryPrice) ? (size * entryPrice) / Number(leverage) : NaN);
  if (![entryPrice, size, margin, maintMarginRate].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null;
  if (side !== 'long' && side !== 'short') return null;
  const s = side === 'long' ? 1 : -1;
  let enc;
  try {
    enc = {
      mHat: scale.toScaled(margin, 'margin'),
      qHat: scale.toScaled(size, 'size'),
      p0Hat: scale.toScaled(entryPrice, 'entryPrice'),
      s,
      mmrHat: scale.toScaled(maintMarginRate, 'maintMarginRate'),
    };
  } catch { return null; }
  if (enc.qHat === 0n || enc.mmrHat >= scale.SCALE) return null;

  // The served liquidationPrice is rounded for display; the circuit needs the value on the grid. The
  // canonical integer solve IS what the circuit verifies, and it agrees with the engine's float to
  // within 5.53e-10 once inputs are snapped (measured over 3,000 positions).
  const pLiqHat = scale.canonicalLiquidationPrice(enc);
  if (pLiqHat <= 0n) return null;
  const full = { ...enc, pLiqHat };
  const gap = Math.abs(scale.fromScaled(pLiqHat) - Number(liquidationPrice));
  return { witness: scale.toWitnessInput(full), encoded: full, gapToServed: gap };
}

// Proving costs ~700ms of one core, and the MCP endpoint that can now ask for it is FREE. At the
// standing 60 requests/minute rate limit a single caller could otherwise demand 42 seconds of CPU
// per minute — enough to starve the paid endpoints that share the process. So proofs are built one
// at a time behind a short queue, and callers past the backlog are told no rather than silently
// stacking up work. One core in, one core out, whatever arrives.
const MAX_QUEUED = 8;
let queue = Promise.resolve();
let queued = 0;

// The window between "this hash is not in memory" and "this hash is marked building" used to be zero
// instructions wide, because the store lookup in front of it was synchronous. It is now a round trip,
// and two requests for the same position arriving in the same tick would both sail through it and
// both enqueue the same proof. Cheap to hold the claim explicitly; the entries live only until `put`
// writes a `building` record, which the memory check below then sees.
const claimed = new Set();

/**
 * Build a proof in the background and record it under the response's content hash.
 *
 * Returns a promise, and every caller on the request path deliberately ignores it — the whole point
 * is that the response does not wait for 703 ms of Plonk. It never rejects.
 *
 * `provenance` is OPTIONAL and is stored verbatim on the finished record. It exists because a proof
 * outlives the answer it came from: /proof/<hash> is free and deliberately fetchable by a third party
 * who never saw the response, and a proof whose entry price was READ FROM A VENUE looks, at that
 * endpoint, exactly like one whose entry price the caller typed. The circuit cannot tell them apart —
 * it has no term for where a number came from — so the distinction has to travel beside the proof or
 * it does not travel at all. Callers who supplied every input pass nothing and their records are
 * unchanged to the byte, which is what keeps every already-published proof reproducing.
 */
export async function buildInBackground(contentHash, echoedInputs, liquidationPrice, provenance) {
  // The memory check is first and synchronous, so a repeat request costs no round trip at all.
  if (store.has(contentHash) || claimed.has(contentHash)) return;
  claimed.add(contentHash);
  try {
    await buildOnce(contentHash, echoedInputs, liquidationPrice, provenance);
  } catch (e) {
    put(contentHash, { status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    claimed.delete(contentHash);
  }
}

async function buildOnce(contentHash, echoedInputs, liquidationPrice, provenance) {
  // A proof already in the durable store — built by an earlier process, or by another replica — must
  // not be re-proved. Hydrated into memory so the poll that follows costs nothing.
  const cold = await proofStore.read(contentHash);
  if (cold) { store.set(contentHash, cold); return; }
  const w = witnessFor(echoedInputs, liquidationPrice);
  if (!w) { put(contentHash, { status: 'unavailable', error: 'this position is outside the circuit domain' }); return; }
  // Refuse rather than certify a position that is not the one that was answered. The served price is
  // rounded to 2dp, so half a cent is the honest ceiling for agreement; anything past it means the
  // witness and the engine parted ways, and publishing that proof would be publishing a lie that
  // verifies. This is the check that makes the margin derivation above safe to have.
  const DISPLAY_ROUNDING = 0.005;
  if (!(w.gapToServed <= DISPLAY_ROUNDING)) {
    put(contentHash, { status: 'unavailable', error: `witness diverges from the served price by ${w.gapToServed} — refusing to certify a different position` });
    return;
  }
  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove(w.witness);
    // AWAITED, unlike every other `put` in this function. The others write nothing — only `ready` is
    // persisted — so awaiting them would be waiting on an already-resolved promise. This one is the
    // network round trip, and holding the queue slot until it lands is what makes flushProofWrites()
    // able to promise anything.
    await put(contentHash, {
      status: 'ready', protocol: PROTOCOL, proof, publicSignals,
      // Signed here rather than at request time because the signals do not exist until the witness
      // is built — and signing anything earlier would be signing a guess at them.
      signalsAttestation: attestSignals(publicSignals),
      encoded: Object.fromEntries(Object.entries(w.encoded).map(([k, v]) => [k, String(v)])),
      // Distance between the circuit's integer solve and the price as SERVED. The served price is
      // rounded to 2dp for display, so this is dominated by that rounding, not by grid error — the
      // grid divergence itself is below 1e-9 (see util/grid.js). Published so a verifier can see
      // exactly which number the proof is about.
      gapToServedPrice: w.gapToServed,
      verify: 'snarkjs plonk verify vk_plonk.json publicSignals proof — the verification key is published at /proof/vk',
      // Spread, not assigned, so a record whose inputs were all supplied by the caller is byte-for-byte
      // what it was before this field existed. Every published proof keeps reproducing on that basis.
      ...(provenance ? { provenance } : {}),
    });
  })
    .catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }))
    // The counter has to come down whether the proof succeeded or not, and the chain has to be left
    // in a resolved state — a rejected `queue` would poison every proof that came after it.
    .finally(() => { queued--; });
}

export function verificationKey() {
  try { return JSON.parse(readFileSync(join(ZK, 'vk_plonk.json'), 'utf8')); } catch { return null; }
}
