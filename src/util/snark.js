// Succinct proofs for the identities this service sells, built off the request path.
//
// TWO IDENTITIES NOW. This file opened with "the liquidation identity" and knew exactly one circuit,
// while `zk/scripts/lib/` held working encoders for five more — each proven by a gate that built its
// own witness, none of them reachable from a served response. That is the whole of what "we built a
// circuit" and "we build circuits" differ by, and it is what this file moving from one identity to
// two is for. `perp-gate` proves liquidation; `size-gate` proves discrete Kelly.
//
// WHAT IS SHARED AND WHAT IS NOT. The plumbing is shared and must be: one worker, one queue, one
// content-hash-keyed store, one durability path. The GUARD is not, and deliberately so — each circuit
// gets its own bound, derived from its own rounding rather than inherited from the one next door. The
// liquidation bound is built from `round(pLiq, 2)`, the Kelly bound from `round(f, 6)`, and they
// differ by four orders of magnitude. A single shared tolerance would be a number nobody measured.
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
// The fifth identity's encoder. It lives in its own file because it is the only one that has to call
// INTO the engine — `black76` and `probAbove`, lifted rather than restated, for the reason the header
// of that file gives — and this file's dependency set (scale.cjs, attest, proofStore) is deliberately
// free of src/engine so the engine keeps having no importers below it.
import { ncdfWitnessFor } from './ncdfWitness.js';
// The sixth identity's encoder, in its own file for the same reason and one more: it is the only
// witness generator here that has to run a SEARCH, so it carries a stopping rule, a refusal set and a
// bound of its own, which is a different shape from the closed-form encoders in scale.cjs.
import { bracketWitnessFor as lpBracketWitnessFor, lpDisplayRound, LP_DISPLAY_HALF_UNIT, _internalLp } from './lpBracket.js';
// The seventh identity's encoder — the same circuit as the fifth, a different service and six fields
// instead of one. Its own file for the fifth's reason (it calls into the engine for `black76`) plus one
// more: it carries the scope conditions that MAKE the six-field collapse true, and those are the
// mathematics rather than plumbing.
import { optionsRiskNcdfWitnessFor } from './optionsRiskNcdfWitness.js';

// The instruction a caller follows to check a proof. ONE source, because it was seven inline copies and
// all seven were wrong the same way: they said the key "is published at /proof/vk/<circuit>", which reads
// as though that endpoint returns a key. It returns the key WRAPPED, as {protocol, circuit, note,
// verificationKey}, so a reviewer following the sentence verbatim gets "Cannot read properties of
// undefined (reading toUpperCase)" out of snarkjs, on a proof that is perfectly good. Both paths were run
// before this was written: the wrapper crashes, the extracted field verifies.
//
// It is also called at SERVE time by /proof/:contentHash, not only at build time. A stored proof keeps
// whatever text was current when it was proved, so every proof built before the wording was fixed would
// otherwise keep publishing the broken command forever, and no amount of editing code would reach them.
// `verify` is documentation: it is in no hash preimage, so rewriting it changes nothing verifiable.
//
// node rather than jq deliberately. jq is not installed on the machine this was found on and is not
// guaranteed on a reviewer's, while anyone who can run snarkjs already has node. Publishing a command
// that needs a tool the reader may not have is a quieter version of the same defect.
export function verifyInstruction(circuit) {
  const ep = circuit ? `/proof/vk/${circuit}` : '/proof/vk';
  const keyfile = circuit ? `${circuit}_vk.json` : 'vk_plonk.json';
  return `The key is the \`verificationKey\` FIELD of ${ep}, not that document: the endpoint serves the `
    + 'key wrapped beside a note, and handing the whole response to snarkjs fails with "Cannot read '
    + 'properties of undefined (reading toUpperCase)". Extract it with the runtime snarkjs already needs '
    + `— curl -s <host>${ep} -o vkdoc.json && node -e "require('fs').writeFileSync('${keyfile}',`
    + `JSON.stringify(require('./vkdoc.json').verificationKey))" && snarkjs plonk verify ${keyfile} publicSignals proof`;
}

const require = createRequire(import.meta.url);
const scale = require('./scale.cjs');

const ZK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'zk');
const PROTOCOL = 'plonk';

// ── the three constants the divergence guard is built from ───────────────────────────────────────
//
// Each is a property of a rounding that actually happens somewhere, not a tuned threshold. None of
// them is a tolerance anybody chose: change one and you are describing a different machine.

// Half a grid step. `scale.canonicalLiquidationPrice` solves the identity exactly over the encoded
// integers and then rounds ONCE onto the 1/SCALE grid, half away from zero, so the price the circuit
// carries is within this of the exact rational — with equality reachable, at a tie.
const HALF_STEP = 0.5 / Number(scale.SCALE);

// Half an ulp, relatively. A double that survives the round trip through `toFixed(9)` — which is
// exactly the rounding `scale.toScaled` performs — is the nearest double to a 9-decimal value, so it
// sits at most half its own ulp from the number the circuit was handed. For everything else the grid
// can be half a step away, which is enormously larger.
const HALF_ULP = Number.EPSILON / 2;

// Half of the last digit the engine displays a price at: `liquidationPrice: round(pLiq, 2)`. This is
// NOT the agreement tolerance any more — that is the whole point of this file's guard — but it is
// still the width of the only number the engine publishes, so a position the 1e-9 grid cannot pin
// more tightly than this is one no proof can honestly be said to be about.
const DISPLAY_HALF_UNIT = 0.005;

// The engine's display rounding, reproduced: `round(x, 2)` in src/engine/stats.js is
// `Number(Number(x).toFixed(dp))`. Written out rather than imported so this file keeps its
// dependencies (scale.cjs, attest, proofStore) and the engine keeps having no importers below it;
// gates/gateW-divergence-guard.mjs asserts the two agree over the live universe and over a
// half-million synthetic positions, which is the only version of this claim worth anything.
const displayRound = (x) => Number(Number(x).toFixed(2));

/**
 * How far a float can sit from the 1e-9 grid the circuit encodes it onto.
 *
 * Two cases and they differ by seven orders of magnitude, which is why this is not just `HALF_STEP`
 * everywhere: the served paths run every input through `gridSnapFields` first, so `entryPrice`,
 * `size` and `maintMarginRate` normally arrive already ON the grid and cost nothing to encode. The
 * one that does not is `margin`, because the engine derives it from leverage and the quotient lands
 * wherever it lands. Charging every input half a step would make the bound below dominated by an
 * error that is not there.
 */
function encodingError(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return NaN;
  if (Math.abs(x) >= 1e21) return HALF_STEP;   // toFixed goes exponential past this and toScaled with it
  return Number(x.toFixed(scale.SCALE_DECIMALS)) === x ? Math.abs(x) * HALF_ULP : HALF_STEP;
}

/**
 * How far encoding the inputs can have moved the liquidation price — measured over the whole box the
 * encoding could have landed in, not linearised.
 *
 * THE OBVIOUS VERSION OF THIS IS WRONG AND WAS MEASURED WRONG. A first-order sensitivity sum —
 * |dP/dM|·h + |dP/dq|·h + … — is the natural way to write this bound and it fails: at a size near the
 * grid step itself the perturbation is a third of the value, Taylor says nothing, and 153 of 357,138
 * sampled positions exceeded a bound derived that way. So no derivatives. The price is a Möbius
 * function of each input separately, so between poles it is monotone in each, so its extremes over an
 * axis-aligned box are attained at the box's CORNERS — all sixteen are evaluated and the largest
 * excursion is the bound. A box that straddles a pole (zero size, or a maintenance rate reaching the
 * side sign) has no finite bound, and says so, rather than reporting a small number from two finite
 * corners that happen to sit either side of an infinity.
 *
 * `pLiq` is the engine's own unrounded price, passed in rather than recomputed, so the excursion is
 * measured from the same double the caller will compare against.
 */
function encodingShift({ M, q, P0, s, mmr, pLiq }) {
  const hM = encodingError(M), hq = encodingError(q), hP = encodingError(P0), hR = encodingError(mmr);
  if (!(hM >= 0 && hq >= 0 && hP >= 0 && hR >= 0)) return Infinity;
  if (!(q - hq > 0)) return Infinity;                                  // the box contains zero size
  if (!(Math.abs(s - (mmr + hR)) > 0 && Math.abs(s - (mmr - hR)) > 0)) return Infinity;
  let worst = 0;
  for (const dM of [-hM, hM]) for (const dq of [-hq, hq]) for (const dP of [-hP, hP]) for (const dR of [-hR, hR]) {
    const v = scale.engineLiquidationPrice({ M: M + dM, q: q + dq, P0: P0 + dP, s, mmr: mmr + dR });
    if (!Number.isFinite(v)) return Infinity;
    const d = Math.abs(v - pLiq);
    if (d > worst) worst = d;
  }
  return worst;
}

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

function prove(circuit, witness) {
  const w = ensureWorker();
  const id = nextJob++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.send({ id, circuit, witness });
  });
}

/**
 * Start the worker and have it load snarkjs and one circuit's proving key, without blocking boot and
 * without doing any of it on this thread. Safe to call more than once.
 *
 * ONE CIRCUIT, NAMED. Boot warms `liquidation` because that is the proof a caller is most likely to
 * ask for first and it is the largest key (5.3 MB against Kelly's 2.2 MB), so it is the one worth
 * paying for early. Warming both would move the second key's read into startup for every deploy,
 * including the ones where nobody ever asks size-gate for a proof — which is the cost this whole file
 * is arranged to defer.
 */
export function warmProver(circuit = 'liquidation') {
  const w = ensureWorker();
  w.send({ warm: true, circuit });
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

// EVICTION MUST NOT TAKE THE RECORD A BUILD IS STILL WRITING TO, and a plain FIFO eviction did.
//
// `answeredOrInFlight(contentHash)` is one half of the guard that stops the seven builders below proving
// the same content hash twice — `claimed` is the other half, and it is released as soon as the build is
// ENQUEUED, not when it settles. So between enqueue and `ready`, a `building` record in this map is the
// ONLY thing that marks the hash as in flight. Insertion-order eviction deletes it like any other entry:
//
//   a second request for the SAME inputs, arriving after MAX other proof requests, passes the guard,
//   starts a DUPLICATE build, hits MAX_QUEUED, and writes `unavailable: prover busy` OVER a proof that
//   is being proved right now. Every poller stops on any status that is not `building`, so the caller
//   is told the proof is unavailable while it is in the prover, and the real `ready` lands afterwards
//   with nobody looking.
//
// Measured on the served event-vol handler: one fixture call, then 20,200 further distinct-hash calls,
// then the same fixture again — `getProof` returns undefined at step 2 and `unavailable: prover busy`
// at step 3, for a request that answers `ready` in 3 s on its own. gates/proofstore-inflight.mjs is
// that reproduction, and it goes red without the two lines below.
//
// At most MAX_QUEUED records can be `building` at once, because the status is written only after the
// queue admits the build — so skipping them cannot empty the search. The fallback is here anyway: a
// guard that assumes its own invariant is a guard that cannot fail.
function evictOne() {
  for (const [k, v] of store) if (v.status !== 'building') { store.delete(k); return; }
  store.delete(store.keys().next().value);
}

function put(contentHash, rec) {
  if (store.size >= MAX && !store.has(contentHash)) evictOne();
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
  const certified = scale.fromScaled(pLiqHat);
  const gap = Math.abs(certified - Number(liquidationPrice));

  // THE ENGINE'S PRICE, UNROUNDED — and not re-derived here to get it.
  //
  // Comparing the witness against `liquidationPrice` alone cannot work below about a dollar, and no
  // choice of tolerance fixes that: the served price is `round(pLiq, 2)`, so the comparison carries
  // an absolute half-cent of display rounding whatever the price is, and half a cent of a $0.24
  // liquidation is two percent. Widening the tolerance makes it worse and scaling it by magnitude
  // does not help, because the rounding being measured is not proportional to anything. The rounding
  // has to leave the comparison, which means having the price before it was rounded.
  //
  // The rounding happens inside src/engine/perpGate.js and the engine must not change, so the
  // unrounded price is recomputed from the same echoed inputs — and re-deriving an engine expression
  // outside the engine is a defect class this repository has shipped three times, most recently a
  // `constantproduct` encoder that rearranged the algebra into a mathematically equal, numerically
  // different form and was wrong by 64 grid steps. So nothing is re-derived. The expression used is
  // `scale.engineLiquidationPrice`, which is already written down in the normative scale file, in the
  // engine's own order, for exactly this purpose: "(s * q * P0 - M) / (q * (s - mmr))". Its four
  // operands are the operands the engine used — `margin` above is derived q*P0 then /leverage, in
  // that order, for the reason the comment there gives.
  const enginePrice = scale.engineLiquidationPrice({ M: margin, q: size, P0: entryPrice, s, mmr: maintMarginRate });

  // What the circuit's price is allowed to differ from that by, derived rather than chosen: the one
  // grid rounding the canonical solve performs, plus however far encoding the inputs could have moved
  // the answer, plus the floating point of evaluating the expression at all. The last term is the
  // only generous one — it is sixteen ulps against a bound that is normally 5e-10 — and it is there
  // because a guard that fires on its own arithmetic noise is the defect being fixed, not a fix.
  const shift = encodingShift({ M: margin, q: size, P0: entryPrice, s, mmr: maintMarginRate, pLiq: enginePrice });
  const denom = Math.abs(size * (s - maintMarginRate));
  const fp = 8 * Number.EPSILON
    * ((Math.abs(size * entryPrice) + Math.abs(margin)) / denom + Math.abs(enginePrice) + (Number.isFinite(shift) ? shift : 0));

  return {
    witness: scale.toWitnessInput(full), encoded: full,
    // Unchanged, and still published on the finished proof: it is the distance to the number a reader
    // is holding, which is what `gapToServedPrice` has always meant. It is no longer what the guard
    // decides on, because it cannot tell display rounding from divergence.
    gapToServed: gap,
    enginePrice,
    gapToEngine: Math.abs(certified - enginePrice),
    encodingBound: HALF_STEP + shift + fp,
  };
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
 * Has this content hash already got an answer, or a build that is going to produce one?
 *
 * A REFUSAL IS NOT AN ANSWER, AND MUST NOT STAND IN FOR ONE. This was `store.has(contentHash)`, which
 * treats every record in the map as settled. Two of the four statuses this file writes are not settled
 * at all:
 *
 *   `unavailable: prover busy — 8 proofs already queued; retry shortly` is a statement about this
 *   PROCESS at one instant, and its own sentence tells the caller to retry. Measured on the served
 *   event-vol handler: saturate the queue, ask for a proof of a fresh body, get that refusal — then
 *   wait for the prover to go completely idle (12.2 s for the eight ahead of it) and re-issue the
 *   IDENTICAL body. `store.has` was true, so the builder returned before reaching a queue that would
 *   now have admitted it, and the record did not move: same status, same `at`. "Retry shortly" was
 *   unretryable until the entry fell out of the 200-entry cache — which for a hash nobody else is
 *   asking for means 200 further distinct proof requests.
 *
 *   `failed` is one exception in one worker — an OOM, a WASM fault, a worker that died mid-proof. The
 *   next attempt gets a fresh worker (ensureWorker respawns), so it is the same shape of transient.
 *
 * proofStore.js already had exactly this policy in writing, for the DURABLE layer, and had had it
 * longer: it refuses to persist `failed`/`unavailable` because "a refusal is a judgement made by one
 * build of the code. Persisting it would let a fixed prover keep serving the old refusal after a
 * deploy. Cheap to redo." The in-memory guard contradicted the store it writes through.
 *
 * WHY A POSITIVE LIST rather than `status !== 'unavailable' && status !== 'failed'`. A status added
 * tomorrow is then retryable by default. The two failure directions are not symmetric: re-deriving a
 * refusal costs the arithmetic of one witness and nothing else — every refusal in this file is written
 * BEFORE the queue is touched, so a re-attempt cannot occupy the prover — while memoising a status
 * that should have been retried costs a caller a proof they paid for and told them to retry for it.
 *
 * `building` still blocks, and that is load-bearing for a different defect: `claimed` is released when
 * the build is ENQUEUED, not when it settles, so from enqueue to `ready` this record is the only thing
 * marking the hash as in flight (see `evictOne`, and gates/gateIF-inflight-eviction.mjs).
 */
function answeredOrInFlight(contentHash) {
  const rec = store.get(contentHash);
  return !!rec && (rec.status === 'ready' || rec.status === 'building');
}

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
  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;
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
  // Refuse rather than certify a position that is not the one that was answered. This is the check
  // that makes the margin derivation above safe to have, and it used to be one line —
  // `gapToServed <= 0.005`, half a cent, sized off the engine's 2dp display rounding. Correct
  // reasoning, and it stopped being a guard below a dollar: measured over the live Hyperliquid
  // universe at ~$5,000 notional, 189 of 232 perps liquidate below $1, the gaps fill [0, 0.005]
  // almost uniformly with a median of 2.6e-3, and RUNE was REFUSED a proof with nothing wrong with
  // it — its unrounded price landed a hair above a half-cent boundary, the display rounded one way
  // and the grid the other, and the guard read the arithmetic of its own tolerance as tampering.
  // On the majority of the universe it could no longer tell display rounding from divergence at all.
  //
  // Three questions now, in the order a reader would ask them, each with its own refusal so the
  // stored record says which one failed.
  const served = Number(liquidationPrice);

  // 1. Is there an answer to be a proof OF? A position already at or below maintenance has no future
  //    liquidation threshold and the engine returns no price for one. The old guard reached this as
  //    `refusing to certify a different position, by NaN`, which is true and teaches nothing.
  if (!Number.isFinite(served)) {
    put(contentHash, { status: 'unavailable', error: 'this answer carries no liquidation price to certify — the position is at or below maintenance, so the threshold is behind it rather than ahead of it' });
    return;
  }

  // 2. Does the witness describe the position the engine PRICED? Asked against the engine's own
  //    display rounding rather than against a tolerance: the recomputed price, rounded the way the
  //    engine rounds it, must be the number that was served. This is the whole of what the old
  //    half-cent check could ever detect — a witness built on different inputs — and it is asked
  //    here as an equality, so the boundary case that refused RUNE cannot arise.
  if (displayRound(w.enginePrice) !== served) {
    put(contentHash, { status: 'unavailable', error: `witness prices this position at ${w.enginePrice}, which displays as ${displayRound(w.enginePrice)}; the answer served ${served} — refusing to certify a different position` });
    return;
  }

  // 3. Can the 1e-9 grid pin this position at all? For a size near the grid step itself, or a
  //    maintenance rate reaching the side sign, encoding the inputs moves the price further than the
  //    engine's own display width — and a proof whose certified price could sit a whole displayed
  //    unit from the answer is not a proof of the answer, however honest the arithmetic. The old
  //    guard refused most of these as a side effect of its absolute ceiling; this refuses them for
  //    the reason, and refuses 7,733 more that the ceiling happened to wave through.
  if (!(w.encodingBound <= DISPLAY_HALF_UNIT)) {
    put(contentHash, { status: 'unavailable', error: `the 1e-9 grid cannot pin this position tighter than ±${w.encodingBound} — wider than the ${DISPLAY_HALF_UNIT} the answer is displayed to, so no proof of it would be a proof of this answer` });
    return;
  }

  // 4. And does the circuit's integer solve actually agree with that price? Grid resolution now, not
  //    display resolution: 5e-10 where the inputs are already snapped, against the 5e-3 this used to
  //    allow — for a $0.24 liquidation that is four million times tighter. The worst honest position
  //    in the live universe uses 95% of this bound and none exceeds it; see DIVERGENCE_HEADROOM.md.
  if (!(w.gapToEngine <= w.encodingBound)) {
    put(contentHash, { status: 'unavailable', error: `witness diverges from the engine's own price by ${w.gapToEngine}, past the ±${w.encodingBound} the encoding admits — refusing to certify a different position` });
    return;
  }
  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove('liquidation', w.witness);
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
      verify: verifyInstruction(null),
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SECOND IDENTITY — discrete Kelly, for `size-gate`.
//
// Everything above is the liquidation identity. What follows is a second circuit reached from a
// second service, and the reason it is 200 lines rather than 20 is that every one of the defects
// `perp-gate` took to get right recurs here and none of them is inherited:
//
//   • its own bound, derived from its own rounding. `round(f, 6)` not `round(pLiq, 2)`.
//   • its own engine expression, LIFTED rather than re-derived. `(p*(b+1)-1)/b` in that order.
//   • its own domain refusals. Continuous mode has no discrete-Kelly identity at all; a non-positive
//     edge is a region the circuit excludes and the engine refuses to size.
//
// WHAT IS PROVEN IS `fullKellyFraction`, NOT THE RECOMMENDATION. The number this service leads with
// is `recommendedBetFraction` = lambda * f*, and the circuit has no term for lambda. So the proof
// covers the full-Kelly fraction — the ceiling the recommendation is a fraction OF — and the response
// says so in as many words. A proof of the ceiling advertised as a proof of the recommendation would
// be exactly the overclaim this repository keeps writing documents about.

// Half a grid step. `scale.canonicalKellyFraction` solves the identity exactly over the encoded
// integers and rounds ONCE onto the 1/SCALE grid, half away from zero, so the fraction the circuit
// carries is within this of the exact rational — with equality reachable, at a tie. Identical in form
// to HALF_STEP above and identical in value; written separately because it is a property of a
// DIFFERENT rounding, and collapsing the two would make a later change to one silently change the
// other.
const KELLY_HALF_STEP = 0.5 / Number(scale.SCALE);

// Half of the last digit the engine displays the fraction at: `fullKellyFraction: round(fullKelly, 6)`
// in src/engine/sizeGate.js. Ten thousand times finer than the 0.005 the price above is displayed to,
// which is the whole reason this constant is not shared: a Kelly bound sized off half a cent would
// admit a fraction 5,000 grid steps from the one that was served.
const KELLY_DISPLAY_HALF_UNIT = 0.5e-6;

// The engine's display rounding, reproduced: `round(x, 6)` in src/engine/stats.js is
// `Number(Number(x).toFixed(dp))`. Written out rather than imported for the same reason the 2dp
// version above is — this file keeps its dependency list and the engine keeps having no importers
// below it — and gates/gateK-kelly-snark.mjs asserts the two agree over a sweep weighted onto the
// boundaries, which is the only version of this claim worth anything.
const kellyDisplayRound = (x) => Number(Number(x).toFixed(6));

/**
 * How far encoding the inputs can have moved the Kelly fraction — measured over the whole box the
 * encoding could have landed in, not linearised.
 *
 * SAME ARGUMENT AS `encodingShift`, AND IT IS NOT AN ANALOGY. f = (p(b+1) - 1)/b is monotone in p at
 * fixed b (slope (b+1)/b > 0 wherever b > 0) and monotone in b at fixed p (slope (1-p)/b², one sign
 * throughout the box). A function monotone in each coordinate separately attains its extremes over an
 * axis-aligned box at the box's CORNERS, so all four are evaluated and the largest excursion is the
 * bound. No derivatives are taken: a first-order sensitivity sum is what failed on 153 of 357,138
 * liquidation positions, and at odds near the grid step itself the same thing would happen here.
 *
 * A box that straddles the pole at b = 0 has no finite bound and says so, rather than reporting a
 * small number from two finite corners that happen to sit either side of an infinity.
 *
 * `fEngine` is the engine's own unrounded fraction, passed in rather than recomputed, so the
 * excursion is measured from the same double the caller will compare against.
 */
function kellyEncodingShift({ p, b, fEngine }) {
  const hp = encodingError(p), hb = encodingError(b);
  if (!(hp >= 0 && hb >= 0)) return Infinity;
  if (!(b - hb > 0)) return Infinity;                // the box contains the pole at zero odds
  let worst = 0;
  for (const dp of [-hp, hp]) for (const db of [-hb, hb]) {
    const v = scale.engineKellyFraction({ pw: p + dp, b: b + db });
    if (!Number.isFinite(v)) return Infinity;
    const d = Math.abs(v - fEngine);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Build the witness for the discrete-Kelly identity from a size-gate result.
 *
 * Returns null when the bet is not one the circuit can speak about, rather than proving something
 * adjacent — a proof of a neighbouring bet is worse than no proof.
 *
 * @param echoedInputs  the request as echoed in `proof.inputs` — already grid-snapped by the handler
 * @param servedFullKelly  the `fullKellyFraction` the answer carries, i.e. round(f*, 6)
 */
export function kellyWitnessFor(echoedInputs, servedFullKelly) {
  const { winProb, winLossRatio, mode } = echoedInputs || {};
  // CONTINUOUS MODE HAS NO PROOF AND MUST NOT BE GIVEN ONE. `sizeGate` also answers
  // {expectedReturn, volatility} with f* = mu/sigma^2, which is a different identity that
  // `kelly.circom` contains no term for. The engine picks the mode by which pair is present, so the
  // same test is applied here rather than reading a `mode` the caller could have set to either.
  if (mode === 'continuous') return null;
  const p = Number(winProb), b = Number(winLossRatio);
  if (![p, b].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null;
  if (!(p < 1)) return null;                          // a probability is a proper fraction

  let enc;
  try {
    // The canonical integer solve IS what the circuit verifies, so `fHat` is derived here rather
    // than read back from the response: the service publishes `round(f*, 6)`, and certifying that
    // number would prove an identity about a bet up to 5e-7 — five hundred grid steps — from the one
    // that was sized. The same lesson `round(M, 2)` taught the liquidation witness, at a different
    // scale.
    enc = scale.toKellyCircuitInputs({ p, b });
  } catch { return null; }

  const certified = scale.fromScaled(enc.fHat);
  const gap = Math.abs(certified - Number(servedFullKelly));

  // THE ENGINE'S FRACTION, UNROUNDED — and not re-derived here to get it.
  //
  // Comparing the witness against `fullKellyFraction` alone cannot work for a thin edge, and no
  // choice of tolerance fixes it: the served fraction is `round(f*, 6)`, so the comparison carries an
  // absolute 5e-7 of display rounding whatever the edge is, and 5e-7 of a full-Kelly fraction of
  // 0.0001 is half a percent of the number. The rounding has to leave the comparison, which means
  // having the fraction before it was rounded. `scale.engineKellyFraction` is the engine's own line
  // in the engine's own order, written down in the normative scale file for exactly this purpose.
  const fEngine = scale.engineKellyFraction({ pw: p, b });

  // What the circuit's fraction is allowed to differ from that by, derived rather than chosen: the
  // one grid rounding the canonical solve performs, plus however far encoding the inputs could have
  // moved the answer, plus the floating point of evaluating the expression at all.
  //
  // The last term is the only generous one — sixteen ulps against a bound that is 5e-10 on every
  // served path — and it is sized for the CANCELLATION in `p*(b+1) - 1`, which is severe near
  // break-even where the two operands agree to their last bits. Both magnitudes are divided by b
  // because that is where the subtraction's absolute error lands. Measured over 197,902 bets across
  // four shapes: nothing exceeds the bound and the worst honest bet uses 99.998% of it.
  const shift = kellyEncodingShift({ p, b, fEngine });
  const fp = 8 * Number.EPSILON
    * ((Math.abs(p * (b + 1)) + 1) / b + Math.abs(fEngine) + (Number.isFinite(shift) ? shift : 0));

  return {
    witness: scale.toKellyWitnessInput(enc), encoded: enc,
    // The distance to the number a reader is holding. Dominated by the engine's 6dp display
    // rounding, not by grid error, exactly as `gapToServedPrice` is for the price.
    gapToServed: gap,
    engineFraction: fEngine,
    gapToEngine: Math.abs(certified - fEngine),
    encodingBound: KELLY_HALF_STEP + shift + fp,
    // The circuit's own two public outputs, computed on this side so a refusal can name them and so
    // the gate can check the residual it is about to see on chain rather than infer it.
    residual: scale.kellyResidual(enc),
    tolerance: scale.kellyToleranceBound(enc),
  };
}

/**
 * Build a Kelly proof in the background and record it under the response's content hash.
 *
 * The twin of `buildInBackground`, and a SEPARATE entry point rather than a fifth positional
 * argument on that one: the two guards ask different questions of different numbers, and a shared
 * function taking a circuit name would be one `if` away from asking the liquidation questions of a
 * Kelly witness. Returns a promise every caller on the request path deliberately ignores. It never
 * rejects.
 */
export async function buildKellyInBackground(contentHash, echoedInputs, servedFullKelly) {
  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;
  claimed.add(contentHash);
  try {
    await buildKellyOnce(contentHash, echoedInputs, servedFullKelly);
  } catch (e) {
    put(contentHash, { status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    claimed.delete(contentHash);
  }
}

async function buildKellyOnce(contentHash, echoedInputs, servedFullKelly) {
  const cold = await proofStore.read(contentHash);
  if (cold) { store.set(contentHash, cold); return; }
  const w = kellyWitnessFor(echoedInputs, servedFullKelly);
  if (!w) { put(contentHash, { status: 'unavailable', error: 'this bet is outside the circuit domain — kelly.circom states the DISCRETE identity f* = (p(b+1) - 1)/b over 0 < p < 1 and b > 0, so a continuous-mode answer (f* = mu/sigma^2) or a non-positive edge has no statement here to be proven' }); return; }

  const served = Number(servedFullKelly);

  // 1. Is there an answer to be a proof OF? A bet with no positive edge is one `sizeGate` declines to
  //    size and one the circuit excludes at the boundary, so there is no fraction to certify.
  if (!Number.isFinite(served) || !(served > 0)) {
    put(contentHash, { status: 'unavailable', error: 'this answer carries no positive full-Kelly fraction to certify — the edge is non-positive, so Kelly says do not bet and there is no size to prove' });
    return;
  }

  // 2. Does the witness describe the bet the engine SIZED? Asked against the engine's own display
  //    rounding rather than against a tolerance: the recomputed fraction, rounded the way the engine
  //    rounds it, must be the number that was served. This is the whole of what any tolerance could
  //    detect — a witness built on different inputs — and asking it as an equality means the boundary
  //    case that refused RUNE on the price side cannot arise here.
  if (kellyDisplayRound(w.engineFraction) !== served) {
    put(contentHash, { status: 'unavailable', error: `witness sizes this bet at ${w.engineFraction}, which displays as ${kellyDisplayRound(w.engineFraction)}; the answer served ${served} — refusing to certify a different bet` });
    return;
  }

  // 3. Can the 1e-9 grid pin this bet at all? For an OFF-GRID pair of odds below about 0.002 it
  //    cannot: f is (1-p)/b² sensitive in the odds, so a half-step of b moves the fraction further
  //    than the 5e-7 the answer is displayed to, and a proof whose certified fraction could sit a
  //    whole displayed unit from the answer is not a proof of the answer however honest its
  //    arithmetic.
  //
  //    ON THE SERVED PATH THIS NEVER FIRES, AND THAT IS THE POINT OF THE SNAP RATHER THAN AN
  //    ARGUMENT FOR DELETING THE CHECK. Both handlers run `gridSnapFields` first, so the encoding
  //    error is half an ulp instead of half a step and the bound collapses to the single rounding of
  //    the canonical solve: measured over 5,000 snapped bets, 5,000 are publishable and none comes
  //    near this ceiling. The 1,790 refusals in gate K's sweep are all in the off-grid shapes, every
  //    one with odds in [1e-4, 2e-3]. This function is exported and is called directly — by that
  //    gate, and by anything that reaches for it later — so it must be sound for inputs no handler
  //    snapped, which is exactly the assumption that made the MCP twin ship un-snapped for days.
  if (!(w.encodingBound <= KELLY_DISPLAY_HALF_UNIT)) {
    put(contentHash, { status: 'unavailable', error: `the 1e-9 grid cannot pin this bet tighter than ±${w.encodingBound} — wider than the ${KELLY_DISPLAY_HALF_UNIT} the answer is displayed to, so no proof of it would be a proof of this answer` });
    return;
  }

  // 4. And does the circuit's integer solve actually agree with that fraction? Grid resolution, not
  //    display resolution: 5e-10 on every served path, against the 5e-7 the display alone would
  //    allow — a thousand times tighter.
  if (!(w.gapToEngine <= w.encodingBound)) {
    put(contentHash, { status: 'unavailable', error: `witness diverges from the engine's own fraction by ${w.gapToEngine}, past the ±${w.encodingBound} the encoding admits — refusing to certify a different bet` });
    return;
  }

  // 5. And is the statement the circuit will be asked to prove actually true? `2*|R| <= b̂` holds by
  //    construction from the half-away-from-zero rounding in `canonicalKellyFraction`, and checking
  //    it here anyway costs two BigInt multiplications and turns an unsatisfiable-constraint failure
  //    deep inside the witness calculator into a refusal that names the residual.
  const abs2R = (w.residual < 0n ? -w.residual : w.residual) * 2n;
  if (!(abs2R <= w.tolerance)) {
    put(contentHash, { status: 'unavailable', error: `the integer residual 2|R| = ${abs2R} exceeds the circuit's own tolerance b̂ = ${w.tolerance} — this witness would not satisfy kelly.circom` });
    return;
  }

  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove('kelly', w.witness);
    await put(contentHash, {
      status: 'ready', protocol: PROTOCOL,
      // The ONE field that distinguishes this record from a liquidation one, and the reason every
      // already-published proof still serialises to the same bytes: it is written only when the
      // circuit is NOT the liquidation circuit, so a record built before this file knew a second
      // identity is unchanged, and `src/app.js` reads `rec.circuit || 'liquidation'`.
      circuit: 'kelly',
      proof, publicSignals,
      signalsAttestation: attestSignals(publicSignals),
      encoded: Object.fromEntries(Object.entries(w.encoded).map(([k, v]) => [k, String(v)])),
      // Named for what it is rather than reusing `gapToServedPrice`: this is a bankroll fraction, not
      // a price, and a reader parsing a field called "price" off a Kelly proof would be being lied to
      // by the schema.
      gapToServedFraction: w.gapToServed,
      verify: verifyInstruction('kelly'),
    });
  })
    .catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }))
    .finally(() => { queued--; });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE THIRD IDENTITY — the Herfindahl index, for `treasury-risk`.
//
// The one place where the circuit's inputs are NOT the caller's. `kelly.circom` takes the win
// probability and the odds, which a caller typed; `concentration.circom` takes the SHARES, which are
// quotients the engine formed by grouping the book and dividing. That has two consequences and both
// shape everything below:
//
//   • Snapping the request does not put the circuit's inputs on the grid, and nothing can. A share is
//     vᵢ/T and lands where the division lands. This is the same situation as the liquidation margin
//     derived from leverage, and it is why the encoding term here is a full half step per share
//     rather than the half ulp a snapped input costs.
//   • The grouping must be the ENGINE'S grouping. Two positions in USDC are one share, and an encoder
//     that formed one share per POSITION would certify a book with a different concentration than the
//     one that was priced — the two agree only when every asset appears once. `zk/scripts/lib` has no
//     encoder for this circuit at all, and the sweep gate that does the job re-derives the weights per
//     position, which is sound only because its generator gives each asset exactly one position.

// Half a grid step, from the single rounding `scale.canonicalHerfindahl` performs on Ĥ.
const HHI_HALF_STEP = 0.5 / Number(scale.SCALE);

// Half of the last digit the engine displays the index at: `hhi: round(H, 4)` in
// src/engine/treasuryRisk.js. Four decimals, so 5e-5 — ten thousand times coarser than the Kelly
// fraction's, and a hundred thousand times the grid the proof is stated over. That gap is not slack
// to be spent: it is why question 3 below never fires here and question 2 does all the work.
const HHI_DISPLAY_HALF_UNIT = 0.5e-4;

const hhiDisplayRound = (x) => Number(Number(x).toFixed(4));

/**
 * How far encoding the shares can have moved the index.
 *
 * H = Σwᵢ² is monotone in each wᵢ over wᵢ >= 0, so its extremes over the encoding box are at the
 * box's corners and all 2^N are evaluated — N is at most 8, so that is 256 evaluations of a sum of
 * eight squares, which costs nothing and avoids a separability argument that would have to be right.
 *
 * The sum is folded in the ENGINE'S order, left to right over the same array, because a sum of eight
 * doubles is not associative and re-associating it is the same class of defect as re-arranging an
 * expression.
 */
function hhiEncodingShift({ shares, hEngine }) {
  const hs = shares.map((w) => encodingError(w));
  if (!hs.every((h) => h >= 0)) return Infinity;
  let worst = 0;
  const n = shares.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const w = shares[i] + ((mask >> i) & 1 ? hs[i] : -hs[i]);
      acc = acc + w ** 2;
    }
    if (!Number.isFinite(acc)) return Infinity;
    const d = Math.abs(acc - hEngine);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Build the witness for the Herfindahl identity from a treasury-risk result.
 *
 * Takes the ENGINE'S OWN RESULT rather than the request, because the shares are the engine's
 * grouping and re-deriving that grouping here would be re-deriving an engine expression outside the
 * engine. `result.concentration.byAsset.shares[].usd` is published but rounded to cents, so the
 * amounts are re-grouped from the echoed inputs using the engine's own fold, and the gate asserts the
 * result reproduces the engine's index bit for bit.
 *
 * @param echoedInputs  the request as echoed in `proof.inputs`
 * @param result        the engine's own return value
 */
export function concentrationWitnessFor(echoedInputs, result) {
  const positions = Array.isArray(echoedInputs?.positions) ? echoedInputs.positions : null;
  if (!positions || !result || result.ok !== true) return null;
  const served = result.concentration?.byAsset?.hhi;
  if (typeof served !== 'number' || !Number.isFinite(served)) return null;

  // The engine's own filter and its own grouping, in its own order. `treasuryRisk.js` drops any
  // position whose amount is not strictly positive BEFORE anything is computed, then accumulates
  // `groups[p.asset] = (groups[p.asset] || 0) + p.amountUsd` and takes `Object.values`, which is
  // insertion order for string keys. Reproduced rather than imported for the reason the display
  // rounding is: this file has no importers below it into src/engine.
  const groups = {};
  for (const p of positions) {
    const amt = Number(p?.amountUsd);
    if (!(amt > 0)) continue;
    groups[p.asset] = (groups[p.asset] || 0) + amt;
  }
  const values = Object.values(groups);
  if (!values.length) return null;
  if (values.length > scale.CONCENTRATION_N) return null;

  const shares = scale.engineShares(values);
  if (!shares) return null;
  const hEngine = scale.engineHerfindahl(values);
  if (!(hEngine > 0)) return null;

  let enc;
  try {
    enc = scale.toConcentrationCircuitInputs(shares);
  } catch { return null; }

  const certified = scale.fromScaled(enc.hHat);
  const shift = hhiEncodingShift({ shares, hEngine });
  // The floating point of the fold itself: n additions of squares each below one, so the accumulated
  // error is bounded by n ulps of the running sum. Eight ulps against a bound already dominated by
  // the half grid step, and generous on purpose — a guard that fires on its own arithmetic noise is
  // the defect being avoided rather than a fix.
  const fp = 8 * Number.EPSILON * (shares.length + Math.abs(hEngine) + (Number.isFinite(shift) ? shift : 0));

  return {
    witness: scale.toConcentrationWitnessInput(enc), encoded: enc,
    gapToServed: Math.abs(certified - Number(served)),
    engineIndex: hEngine,
    gapToEngine: Math.abs(certified - hEngine),
    encodingBound: HHI_HALF_STEP + shift + fp,
    residual: scale.concentrationResidual({ wHats: enc.wHats, hHat: enc.hHat }),
    tolerance: scale.concentrationToleranceBound(),
    weightSlack: scale.concentrationWeightSlack(enc.wHats),
    served, groups: enc.groups, paddedLanes: enc.padded,
  };
}

/**
 * Build a Herfindahl proof in the background and record it under the response's content hash.
 * The twin of `buildInBackground` and `buildKellyInBackground`, separate for the same reason.
 */
export async function buildConcentrationInBackground(contentHash, echoedInputs, result) {
  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;
  claimed.add(contentHash);
  try {
    await buildConcentrationOnce(contentHash, echoedInputs, result);
  } catch (e) {
    put(contentHash, { status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    claimed.delete(contentHash);
  }
}

async function buildConcentrationOnce(contentHash, echoedInputs, result) {
  const cold = await proofStore.read(contentHash);
  if (cold) { store.set(contentHash, cold); return; }
  const w = concentrationWitnessFor(echoedInputs, result);
  if (!w) {
    const n = Object.keys((Array.isArray(echoedInputs?.positions) ? echoedInputs.positions : [])
      .filter((p) => Number(p?.amountUsd) > 0)
      .reduce((g, p) => { g[p.asset] = 1; return g; }, {})).length;
    put(contentHash, {
      status: 'unavailable',
      error: n > scale.CONCENTRATION_N
        ? `this book holds ${n} distinct assets and concentration.circom is compiled for ${scale.CONCENTRATION_N} — a wider book has no statement in it, and padding cannot help because the extra shares are real`
        : 'this book is outside the circuit domain — concentration.circom states the Herfindahl identity over at most eight positive shares of one book',
    });
    return;
  }

  // 1. Is there an answer to be a proof OF?
  if (!(w.served > 0)) {
    put(contentHash, { status: 'unavailable', error: 'this answer carries no positive concentration index to certify' });
    return;
  }

  // 2. Does the witness describe the book the engine PRICED? An equality against the engine's own
  //    display rounding, not a tolerance. The sweep gate under `zk/` compares at 4dp with a 5e-5
  //    threshold and measured its worst honest book at 4.9991e-5 — 99.98% of it consumed by display
  //    rounding alone, which is a threshold about to start refusing honest books. Asking the question
  //    as an equality removes the threshold rather than widening it.
  if (hhiDisplayRound(w.engineIndex) !== w.served) {
    put(contentHash, { status: 'unavailable', error: `witness measures this book at ${w.engineIndex}, which displays as ${hhiDisplayRound(w.engineIndex)}; the answer served ${w.served} — refusing to certify a different book` });
    return;
  }

  // 3. Can the 1e-9 grid pin this book at all? It can, with room to spare: the index is displayed to
  //    four decimals and the encoding moves it by nanometres. This check is kept anyway because the
  //    shares are quotients rather than caller inputs, so nothing upstream can guarantee the bound —
  //    a book of eight nearly-equal shares is a different shape from a book dominated by one.
  if (!(w.encodingBound <= HHI_DISPLAY_HALF_UNIT)) {
    put(contentHash, { status: 'unavailable', error: `the 1e-9 grid cannot pin this book tighter than ±${w.encodingBound} — wider than the ${HHI_DISPLAY_HALF_UNIT} the answer is displayed to` });
    return;
  }

  // 4. And does the circuit's integer sum agree with the engine's own unrounded index?
  if (!(w.gapToEngine <= w.encodingBound)) {
    put(contentHash, { status: 'unavailable', error: `witness diverges from the engine's own index by ${w.gapToEngine}, past the ±${w.encodingBound} the encoding admits — refusing to certify a different book` });
    return;
  }

  // 5. And are the two statements the circuit will check actually true? Both are constructions rather
  //    than hopes, and both are cheap to verify before a 400 ms proof discovers them the hard way.
  const abs2R = (w.residual < 0n ? -w.residual : w.residual) * 2n;
  if (!(abs2R <= w.tolerance)) {
    put(contentHash, { status: 'unavailable', error: `the integer residual 2|R| = ${abs2R} exceeds the circuit's tolerance ${w.tolerance} — this witness would not satisfy concentration.circom` });
    return;
  }
  if (!(w.weightSlack >= 0n && w.weightSlack <= 2n * BigInt(scale.CONCENTRATION_N))) {
    put(contentHash, { status: 'unavailable', error: `the encoded shares do not sum to the whole book within the grid rounding the circuit admits (slack ${w.weightSlack})` });
    return;
  }

  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove('concentration', w.witness);
    await put(contentHash, {
      status: 'ready', protocol: PROTOCOL, circuit: 'concentration',
      proof, publicSignals,
      signalsAttestation: attestSignals(publicSignals),
      encoded: {
        wHat: w.encoded.wHats.map(String), hHat: String(w.encoded.hHat),
        groups: String(w.encoded.groups), paddedLanes: String(w.encoded.padded),
      },
      gapToServedIndex: w.gapToServed,
      verify: verifyInstruction('concentration'),
    });
  })
    .catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }))
    .finally(() => { queued--; });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE FOURTH IDENTITY — adverse execution, for `exec-verify`.
//
// The first one whose circuit certifies THREE nested statements rather than one, and the first whose
// SOLD NUMBER is a ratio. Both facts shape the guard below.
//
//   • THREE STATEMENTS. `execadverse.circom` carries the constant-product benchmark forward (the fill
//     the pool honestly implied) and adds the shortfall — EXACT, no tolerance — and the headline in
//     basis points, which is the field the registered blurb leads with. The guard therefore has to
//     answer for two published quantities in two different units, not one.
//
//   • A RATIO. `adverseExecutionBps` is a fraction of the benchmark fill, so its absolute precision
//     collapses as the fill shrinks. This is exactly the trap `src/engine/execVerify.js` records
//     about its own invariant check — an absolute budget "grew far looser than the output it
//     certifies as pools get larger" — running the other way: an absolute budget on the HEADLINE is
//     unreachably tight on a dust fill. Measured, on a fill of 8.8e-8 output tokens the 1e-9 grid
//     cannot pin the headline closer than 91 bps, against a verdict threshold of 5. So there is a
//     ceiling, and 9.4% of a deliberately extreme sweep is REFUSED by it rather than served a proof
//     of a neighbouring trade.
//
// ── THE BOUND IS DERIVED HERE AND IS NOT gate B5-4's ────────────────────────────────────────────
// zk/scripts/gateB5-4 derived a bound for this same circuit and it is the WRONG NUMBER for this path,
// which is the whole reason this block does not import it. That gate feeds the encoder raw doubles, so
// its benchmark term carries `(1 + 2·y/x)/S` for snapping x, y and dx onto the grid. Both handlers
// here run `gridSnapFields` FIRST, so those three are on the grid to within half an ulp of a double
// and that term is two to ten times wider than anything it guards. Copying it across would have been
// the liquidation half-cent again — the bound that "stopped being a guard below a dollar" — in the
// generous direction instead of the tight one, and a bound nothing can approach cannot fail.
//
// Measured over 226,761 trades across five deliberately different pool shapes, the worst honest case
// uses 45.9% of the headline bound and 99.9% of the shortfall bound. gates/gateEX-execverify-snark.mjs
// re-measures both and shows each being exceeded.

const EXEC_HALF_STEP = 0.5 / Number(scale.SCALE);

// Half of the last digit the engine displays each published quantity at:
//   `adverseExecutionBps: round(adverseBps, 2)`   -> 0.005 bps
//   `adverseValueOut:     round(adverseValue, 8)` -> 0.5e-8 output tokens
// Two constants and not one, and they are four hundred thousand times apart. The Kelly guard exists
// as a separate object from the liquidation guard for this reason and this is the same reason again:
// a shortfall in tokens held to half a basis point would be meaningless, and a headline in basis
// points held to 5e-9 would refuse every trade this service has.
const EXEC_DISPLAY_HALF_BPS = 0.005;
const EXEC_DISPLAY_HALF_TOKENS = 0.5e-8;

// One whole fill, in basis points — the engine's own `* 1e4`.
const EXEC_BPS_FULL = 1e4;

/**
 * THE CEILING, and it is a RATIO because the number it protects is a ratio.
 *
 * The headline is published to 0.005 bps out of the 1e4 bps a whole fill is worth, so it is published
 * to a relative precision of 5e-7. Transferred onto the quantity the headline is a ratio OF, that is
 * how far the grid may have moved the benchmark fill and still leave a proof that is a proof of the
 * answer:  gOut <= honestOut · 5e-7.
 *
 * NOTHING HERE IS CHOSEN. The 0.005 is the engine's own `round(bps, 2)`; the 1e4 is the engine's own
 * basis-point scaling. Both are lifted from src/engine/execVerify.js, and the quotient is the only
 * arithmetic performed on them. The two arms are still tested SEPARATELY below, in their own units,
 * because `realized/honestOut` is not exactly 1 and collapsing them would hide the difference:
 * measured, the two arms refuse 21,311 and 21,370 of the same 226,761 trades.
 */
const EXEC_REL_CEILING = EXEC_DISPLAY_HALF_BPS / EXEC_BPS_FULL;

// The engine's display roundings, reproduced. `round(x, dp)` in src/engine/stats.js is
// `Number(Number(x).toFixed(dp))`; written out here rather than imported for the same reason the 2dp
// and 6dp versions above are, and gates/gateEX-execverify-snark.mjs asserts each agrees with the
// engine's own function over a sweep weighted onto the rounding boundaries.
const execDisplayRoundBps = (x) => Number(Number(x).toFixed(2));
const execDisplayRoundTokens = (x) => Number(Number(x).toFixed(8));

/**
 * How far encoding the inputs can have moved the BENCHMARK FILL — measured over the whole box the
 * encoding could have landed in, at the box's CORNERS, not linearised.
 *
 * O(x, y, in) = y·in/(x + in) is monotone in each coordinate separately: increasing in y and in in,
 * decreasing in x. A function monotone in each coordinate attains its extremes over an axis-aligned
 * box at the corners, so all eight are evaluated and the largest excursion is the bound. No
 * derivatives are taken, and the reason is not stylistic: O is CONCAVE in `in`, so a first-order
 * sensitivity term underestimates the downward excursion — the same shape as the sensitivity sum that
 * failed on 153 of 357,138 liquidation positions.
 *
 * The half-widths, each derived:
 *   x, y   on the grid after `gridSnapFields`, so the double sits within one ulp of the decimal that
 *          `toScaled` reads. Two half-ulps, relative.
 *   in     the DOMINANT term and the only one that is not an ulp: `în` is the grid rounding of an
 *          exact rational, worth half a step outright — plus the distance from the engine's own
 *          `inEff` double to that rational, which is dx and f encoding (one half-ulp each) and
 *          `fl(dx * fl(1 - f))` (two more). Eight half-ulps covers all four with slack, and it is
 *          carried rather than dropped as small because above a trade of ~1e6 tokens it OVERTAKES the
 *          half grid step.
 *
 * `honestOut` is the engine's own unrounded fill, passed in rather than recomputed, so the excursion
 * is measured from the same double the caller will compare against.
 */
function execEncodingShift({ x, y, inEff, honestOut }) {
  const hx = Math.abs(x) * 2 * HALF_ULP;
  const hy = Math.abs(y) * 2 * HALF_ULP;
  const hin = EXEC_HALF_STEP + Math.abs(inEff) * 8 * HALF_ULP;
  if (!(hx >= 0 && hy >= 0 && hin >= 0)) return Infinity;
  let worst = 0;
  for (const ex of [-hx, hx]) for (const ey of [-hy, hy]) for (const ei of [-hin, hin]) {
    const xx = x + ex, yy = y + ey, ii = inEff + ei;
    if (!(ii > 0) || !(xx + ii > 0)) return Infinity;   // the box crosses an empty pool
    const v = (yy * ii) / (xx + ii);                    // O, in the engine's own form and order
    if (!Number.isFinite(v)) return Infinity;
    const d = Math.abs(v - honestOut);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Build the witness for the adverse-execution identity from an exec-verify request.
 *
 * Returns null when the trade is not one the circuit can speak about, rather than proving something
 * adjacent. REFERENCE MODE IS THE FIRST SUCH CASE AND IT MATTERS: `execVerify` also answers
 * `{fairPrice}` with `bps = (fair - realized/dx)/fair · 1e4`, which is a different identity with no
 * pool model in it at all — `execadverse.circom` contains no term for a caller-supplied fair price,
 * and the reserves are what its invariant is about. The engine picks the mode by which fields are
 * present, so the same test is applied here rather than reading a `mode` the caller could set.
 *
 * @param echoedInputs  the request as echoed in `proof.inputs` — already grid-snapped by the handler
 */
export function execWitnessFor(echoedInputs) {
  const i = echoedInputs || {};
  const dx = Number(i.amountIn), realized = Number(i.amountOutRealized);
  const x = Number(i.reserveIn), y = Number(i.reserveOut), f = Number(i.feeTier);
  // The engine's own mode test, term for term: reserves AND a fee tier, or it is reference mode.
  const haveReserves = x > 0 && y > 0 && i.feeTier != null;
  if (!haveReserves) return null;
  if (![dx, realized, x, y].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (!(f >= 0 && f < 1)) return null;                  // the engine's own guard on the fee

  let enc;
  try {
    // The four derived integers are solved HERE and never read back from the response. The service
    // publishes `round(honestOut, 8)`, and gate B5-4 measured what certifying that instead costs: the
    // benchmark lands 30 grid steps out. The same lesson `round(M, 2)` taught the liquidation witness
    // and `round(f*, 6)` taught the Kelly one, a third time.
    enc = scale.toExecCircuitInputs({ dx, x, y, f, realized });
  } catch (e) { return { outsideDomain: String((e && e.message) || e) }; }

  // THE ENGINE'S OWN NUMBERS, UNROUNDED — lifted, not re-derived. `scale.engineHonestOut` and
  // `scale.engineAdverseBps` are the engine's own lines in the engine's own order, and
  // gates/gateEX-execverify-snark.mjs lifts those lines out of src/engine/execVerify.js, compiles
  // them, and requires Object.is agreement over a sweep rather than taking the copy on trust.
  const honestOut = scale.engineHonestOut(dx, x, y, f);
  if (!(honestOut > 0) || !Number.isFinite(honestOut)) return null;
  const bpsEngine = scale.engineAdverseBps(honestOut, realized);
  const avEngine = scale.engineAdverseValue(honestOut, realized);
  if (!Number.isFinite(bpsEngine) || !Number.isFinite(avEngine)) return null;

  const inEff = dx * (1 - f);
  const shift = execEncodingShift({ x, y, inEff, honestOut });
  // How far the certified benchmark fill can sit from the engine's: the one grid rounding
  // `canonicalHonestOut` performs, plus the encoding box above, plus the engine's own five-rounding
  // double chain — (1-f), dx·, y·, x+, and the division.
  const gOut = EXEC_HALF_STEP + shift + Math.abs(honestOut) * 8 * HALF_ULP;

  const certOut = scale.fromScaled(enc.outHat);
  const certBps = scale.fromScaled(enc.bpsHat);
  const certShortfall = scale.fromScaled(enc.sHat);

  // The headline's allowance, in BASIS POINTS.
  //
  // B(o, z) = 1e4·(o − z)/o is monotone in each argument separately — increasing in o wherever z > 0,
  // decreasing in z — so the same CORNER argument the benchmark uses applies, and for the same reason
  // it is not stylistic. B is convex in o, so dB/do·δ UNDERSTATES the downward excursion by a factor
  // 1/(1 − δ/o). The first version of this guard used that derivative and the worst honest case
  // measured 99.8% of it: a 0.2% empirical margin standing in for a term that was missing from the
  // derivation. That is the same mistake as the liquidation sensitivity sum, and "it has not failed
  // yet" is not a bound. Four corners, evaluated.
  const hz = Math.abs(realized) * 2 * HALF_ULP;
  let bpsShift = 0;
  for (const eo of [-gOut, gOut]) for (const ez of [-hz, hz]) {
    const oo = honestOut + eo, zz = realized + ez;
    if (!(oo > 0)) { bpsShift = Infinity; break; }
    const v = scale.engineAdverseBps(oo, zz);      // the engine's own form and order, at the corner
    if (!Number.isFinite(v)) { bpsShift = Infinity; break; }
    bpsShift = Math.max(bpsShift, Math.abs(v - bpsEngine));
  }
  const encodingBps = EXEC_HALF_STEP                                          // b̂ is one grid rounding
    + bpsShift                                                                // the box, at its corners
    + 4 * HALF_ULP * (EXEC_BPS_FULL + Math.abs(bpsEngine));                   // the engine's own chain
  // The shortfall's allowance, in OUTPUT TOKENS. ŝ = ô − ẑ is EXACT in the field, so every term here
  // is about the two operands rather than about the subtraction.
  const encodingTokens = gOut + realized * HALF_ULP + Math.abs(avEngine) * HALF_ULP;

  return {
    witness: scale.toExecWitnessInput(enc), encoded: enc,
    honestOut, bpsEngine, adverseValue: avEngine,
    certifiedHonestOut: certOut, certifiedBps: certBps, certifiedShortfall: certShortfall,
    gapToEngineOut: Math.abs(certOut - honestOut),
    gapToEngineBps: Math.abs(certBps - bpsEngine),
    gapToEngineShortfall: Math.abs(certShortfall - avEngine),
    benchmarkBound: gOut,
    // The ceiling, in the unit the arm is tested in. Published so a refusal can name a number.
    benchmarkCeiling: Math.abs(honestOut) * EXEC_REL_CEILING,
    encodingBps, encodingTokens,
    displayBps: EXEC_DISPLAY_HALF_BPS,
    displayTokens: EXEC_DISPLAY_HALF_TOKENS + Math.abs(avEngine) * HALF_ULP,
    // The circuit's own three residuals and the three tolerances it publishes as signals, computed on
    // this side so a refusal can name them and so a gate can check the residual it is about to see on
    // chain rather than infer it.
    feeResidual: scale.execFeeResidual(enc),
    feeTolerance: scale.execFeeToleranceBound(),
    invariantResidual: scale.execInvariantResidual(enc),
    invariantTolerance: scale.execInvariantToleranceBound(enc),
    bpsResidual: scale.execBpsResidual(enc),
    bpsTolerance: scale.execBpsToleranceBound(enc),
  };
}

/**
 * Build an adverse-execution proof in the background and record it under the response's content hash.
 *
 * A fourth entry point rather than a circuit-name argument on one of the three above, for the reason
 * the Kelly one gives: the guards ask different questions of different numbers in different units,
 * and a shared function taking a circuit name would be one `if` away from asking the Kelly questions
 * of an execution witness. Returns a promise every caller on the request path deliberately ignores.
 * It never rejects.
 */
export async function buildExecInBackground(contentHash, echoedInputs, result) {
  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;
  claimed.add(contentHash);
  try {
    await buildExecOnce(contentHash, echoedInputs, result);
  } catch (e) {
    put(contentHash, { status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    claimed.delete(contentHash);
  }
}

async function buildExecOnce(contentHash, echoedInputs, result) {
  const cold = await proofStore.read(contentHash);
  if (cold) { store.set(contentHash, cold); return; }
  const w = execWitnessFor(echoedInputs);
  if (!w) { put(contentHash, { status: 'unavailable', error: 'this trade is outside the circuit domain — execadverse.circom states the CONSTANT-PRODUCT identity over pre-trade reserves and a fee tier, so a reference-mode answer (bps against a caller-supplied fairPrice) has no pool state here to be proven about' }); return; }
  if (w.outsideDomain) { put(contentHash, { status: 'unavailable', error: `this trade is outside the circuit domain — ${w.outsideDomain}` }); return; }

  const servedBps = Number(result?.adverseExecutionBps);
  const servedValue = Number(result?.adverseValueOut);

  // 1. Is there an answer to be a proof OF? A refused request has no fill to certify.
  if (result?.ok !== true || result?.mode !== 'constant-product') {
    put(contentHash, { status: 'unavailable', error: 'this answer is not a constant-product execution verdict, so there is no pool identity to certify' });
    return;
  }
  if (!Number.isFinite(servedBps) || !Number.isFinite(servedValue)) {
    put(contentHash, { status: 'unavailable', error: 'this answer carries no adverseExecutionBps and adverseValueOut to certify' });
    return;
  }

  // 2. Does the witness describe the trade the engine PRICED? Asked as an EQUALITY against the
  //    engine's own display rounding rather than against a tolerance, which is the whole of what any
  //    tolerance could detect — a witness built on different inputs — and asked of BOTH published
  //    quantities, because the shortfall and the headline can disagree independently: the headline is
  //    a ratio and would absorb a proportional error in the benchmark that the shortfall would not.
  if (execDisplayRoundBps(w.bpsEngine) !== servedBps) {
    put(contentHash, { status: 'unavailable', error: `witness prices this trade at ${w.bpsEngine} bps, which displays as ${execDisplayRoundBps(w.bpsEngine)}; the answer served ${servedBps} — refusing to certify a different trade` });
    return;
  }
  if (execDisplayRoundTokens(w.adverseValue) !== servedValue) {
    put(contentHash, { status: 'unavailable', error: `witness puts the shortfall at ${w.adverseValue} output tokens, which displays as ${execDisplayRoundTokens(w.adverseValue)}; the answer served ${servedValue} — refusing to certify a different trade` });
    return;
  }

  // 3. Can the 1e-9 grid pin this trade at all? THE CEILING, both arms, in their own units. On a dust
  //    fill it cannot: the headline is a ratio, so the same 5e-10-token uncertainty in the benchmark
  //    is 91 bps of a fill of 8.8e-8 tokens — eighteen times the 5 bps threshold this same engine uses
  //    to call a fill a sandwich. A proof whose certified headline could sit past the verdict boundary
  //    from the served one is not a proof of the answer however honest its arithmetic.
  //
  //    Unlike the Kelly ceiling this one is REACHED on the served path, which is why it is a refusal
  //    with a measured number in it rather than a defensive check: 9.4% of a five-shape sweep lands
  //    here, all of it dust fills and pools lopsided past 100:1.
  if (!(w.benchmarkBound <= w.benchmarkCeiling)) {
    put(contentHash, { status: 'unavailable', error: `the 1e-9 grid cannot pin this benchmark fill tighter than ±${w.benchmarkBound} output tokens, wider than the ±${w.benchmarkCeiling} that the ${EXEC_DISPLAY_HALF_BPS}-bps step the headline is published to allows on a fill of ${w.honestOut} — so no proof of it would be a proof of this answer` });
    return;
  }
  if (!(w.encodingBps <= w.displayBps)) {
    put(contentHash, { status: 'unavailable', error: `the 1e-9 grid cannot pin this headline tighter than ±${w.encodingBps} bps — wider than the ${w.displayBps} bps the answer is displayed to, so no proof of it would be a proof of this answer` });
    return;
  }

  // 4. And do the circuit's integer solves actually agree with the engine's own doubles? Grid
  //    resolution, not display resolution, and asked of each published quantity against ITS OWN
  //    allowance in ITS OWN unit. The bound this repo is on record for getting wrong was reused
  //    across two quantities; these two are computed separately and neither reads the other.
  if (!(w.gapToEngineBps <= w.encodingBps)) {
    put(contentHash, { status: 'unavailable', error: `witness diverges from the engine's own headline by ${w.gapToEngineBps} bps, past the ±${w.encodingBps} the encoding admits — refusing to certify a different trade` });
    return;
  }
  if (!(w.gapToEngineShortfall <= w.encodingTokens)) {
    put(contentHash, { status: 'unavailable', error: `witness diverges from the engine's own shortfall by ${w.gapToEngineShortfall} output tokens, past the ±${w.encodingTokens} the encoding admits — refusing to certify a different trade` });
    return;
  }

  // 5. And are the three statements the circuit will be asked to prove actually true? All three hold
  //    by construction from the half-away-from-zero rounding in `scale.cjs`, and checking them here
  //    costs six BigInt multiplications and turns an unsatisfiable-constraint failure deep inside the
  //    witness calculator into a refusal that names which of the three residuals broke.
  const abs = (v) => (v < 0n ? -v : v);
  for (const [label, R, T] of [
    ['the effective input after the fee', w.feeResidual, w.feeTolerance],
    ['the constant-product invariant', w.invariantResidual, w.invariantTolerance],
    ['the headline in basis points', w.bpsResidual, w.bpsTolerance],
  ]) {
    if (!(2n * abs(R) <= T)) {
      put(contentHash, { status: 'unavailable', error: `the integer residual for ${label} is 2|R| = ${2n * abs(R)}, past the circuit's own tolerance ${T} — this witness would not satisfy execadverse.circom` });
      return;
    }
  }

  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove('execadverse', w.witness);
    await put(contentHash, {
      status: 'ready', protocol: PROTOCOL,
      circuit: 'execadverse',
      proof, publicSignals,
      signalsAttestation: attestSignals(publicSignals),
      encoded: Object.fromEntries(Object.entries(w.encoded).map(([k, v]) => [k, String(v)])),
      // Named for the two quantities they are, in their own units, and never merged into one
      // "gapToServed": one is a ratio in basis points and the other is a quantity of output tokens.
      gapToServedBps: Math.abs(w.certifiedBps - Number(result.adverseExecutionBps)),
      gapToServedShortfallOut: Math.abs(w.certifiedShortfall - Number(result.adverseValueOut)),
      verify: verifyInstruction('execadverse'),
    });
  })
    .catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }))
    .finally(() => { queued--; });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE FIFTH IDENTITY — the normal CDF itself, for `event-vol`.
//
// The first one on this host that certifies a TRANSCENDENTAL rather than an arithmetic rearrangement,
// and the first that reuses a circuit built for a different purpose with no new circuit, no new
// ceremony and no new verifier — `ncdf.circom` was compiled and gated (zk/scripts/gateB7-5) as a
// research answer to "erf is where this stops being arithmetic", and served nothing.
//
// WHY THE GUARD IS THINNER THAN THE OTHER FOUR, and it is not an oversight. Those four encode CALLER
// FIELDS onto a 1e-9 grid, so their guards spend most of their length bounding how far the grid moved
// a quotient of the caller's inputs. This circuit's public signals are not caller fields at all: they
// are (x, N(x), φ(x)), each DERIVED by the engine and rounded exactly once onto the 2^-40 grid inside
// src/util/ncdfWitness.js. There is no quotient of caller inputs to bound, which is also why this
// handler does NOT call `gridSnapFields` — see the block in gates/preflight.mjs, and size-gate's
// argument for leaving `bankroll` alone, which is the same argument twice.
//
// WHAT IS DELIBERATELY NOT PRE-CHECKED. The other four verify the circuit's own integer residuals
// before spending 700 ms discovering them the hard way. Doing that here needs Hart's 192-entry
// exponential table and both Horner polynomials, and zk/scripts/gateB7-5 refuses on principle to read
// them from `build/ncdf-consts.json` because that file and the circuit come from one generator run —
// so a copy shipped in the service would be a third statement of the same constants with nothing
// comparing it to the circuit. The gate parses the circom source and sweeps the honest engine against
// it instead: worst leg uses 20.71% of the 12-ulp CDF bound and 21.15% of the 10-ulp density bound
// over 20,000 legs. A witness that somehow fell outside surfaces as `failed`, not as a wrong proof.

/**
 * Build the ATM-straddle CDF proof in the background and record it under the response's content hash.
 * The fifth twin of `buildInBackground`, separate for the reason the other four are.
 */
export async function buildNcdfInBackground(contentHash, echoedInputs, result) {
  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;
  claimed.add(contentHash);
  try {
    await buildNcdfOnce(contentHash, echoedInputs, result);
  } catch (e) {
    put(contentHash, { status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    claimed.delete(contentHash);
  }
}

async function buildNcdfOnce(contentHash, echoedInputs, result) {
  const cold = await proofStore.read(contentHash);
  if (cold) { store.set(contentHash, cold); return; }

  // ONE CALL, AND EVERY REFUSAL CARRIES ITS OWN SENTENCE. `ncdfWitnessFor` runs the five published-
  // field equalities, both range conditions the circuit enforces, the display ceiling and the
  // encoding agreement, and returns `{ reason }` for whichever one broke. Restating those tests here
  // would be a second copy of a guard, which is what the four sections above each avoided by putting
  // their arithmetic in one place.
  const w = ncdfWitnessFor(echoedInputs, result);
  if (w.reason) { put(contentHash, { status: 'unavailable', error: w.reason }); return; }

  // The one condition that is this file's rather than the encoder's: the queue.
  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove('ncdf', w.witness);
    await put(contentHash, {
      status: 'ready', protocol: PROTOCOL,
      circuit: 'ncdf',
      proof, publicSignals,
      signalsAttestation: attestSignals(publicSignals),
      encoded: Object.fromEntries(Object.entries(w.encoded).map(([k, v]) => [k, String(v)])),
      // The reconstruction, published at full precision, because the served field is rounded to two
      // decimals and the whole point of the bounds below is that they are four orders of magnitude
      // tighter than that rounding. A reader who only ever sees `3645.45` cannot tell a 1e-8 proof
      // from a 1e-3 one.
      straddleFromProofUsd: w.reconstructedUsd,
      gapToServedUsd: w.gapToServedUsd,
      gapToEngineUsd: w.gapToEngineUsd,
      encodingBoundUsd: w.encodingBoundUsd,
      envelopeUsd: w.envelopeUsd,
      twoPointCollapseUlp: w.collapseUlp,
      reconstruct: 'straddleImpliedAbsMoveUsd = 2*spot*(2*nHat/2^40 - 1), with nHat the fifth public signal. The point x = xMag/2^40 is the fourth; check it against your own sigma and horizon by squaring: 4*x^2 = sigma^2*T.',
      verify: verifyInstruction('ncdf'),
    });
  })
    .catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }))
    .finally(() => { queued--; });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SIXTH IDENTITY — a bracket certificate, for `lp-risk`.
//
// The first one whose subject is the RESULT OF A SEARCH rather than the value of a formula, and the
// first where what is proven is a LOCATION rather than an evaluation.
//
// `lp-risk` publishes three blocks and only one of them is a closed form:
//
//   1. `realizedIL`         IL(r) = 2*sqrt(r)/(1+r) - 1. `divergence.circom` states this identity and
//                           gateB4 proves it. It is NOT the circuit reached from here, and no proof
//                           this block builds says anything about `realizedIL`.
//   2. `expectedDivergence` a 401-point quadrature over a lognormal — 802 exponentials and 402 roots
//                           per served figure, measured. NOT PROVEN. It enters the certificate as two
//                           public inputs and nothing certifies them.
//   3. `feeVsDivergence`    a 200-iteration bisection over block 2 — 163,608 exponentials and 82,016
//                           roots for one served answer, measured. `breakevenVolatility` is what is
//                           proven here.
//
// A bisection result is certified by its BRACKET rather than by replaying the search: two evaluations
// of g(v) = E[IL](v) + f that straddle, an ordering, a midpoint, a width, and the root on the squared
// quantity. Six inequalities over published integers, in 1,776 Plonk constraints. See
// zk/circuits/lpbracket.circom and src/util/lpBracket.js, which is the normative encoding.
//
// ── THE BOUND IS DERIVED IN lpBracket.js AND IS NOT THE OTHER FIVE'S ────────────────────────────
// `breakevenVolatility: round(breakevenSigma, 5)`, so the display half-unit is 0.5e-5 — a hundred
// times finer than the liquidation half-cent and ten times coarser than the Kelly half-millionth. A
// bound sized off either would be wrong by three or four orders of magnitude in one direction or the
// other, which is why there are five `_internal*` objects on this file and now a sixth.
//
// ── AND THE COMPARISON IS AGAINST THE ENGINE'S UNROUNDED FIGURE ─────────────────────────────────
// Not against the served one. `src/util/lpBracket.js` replays the engine's own 200-halving bisection
// (1.4 ms, measured, and this whole path is off the request path) so the certified volatility is
// compared to the number the engine actually computed. Comparing to the SERVED figure with an equality
// on the rounded value refused 28 of 770 honest cases on the first pass of this file's own sweep, all
// of them sitting on a 5th-decimal boundary — the same defect that refused RUNE a liquidation proof.
//
// Measured over 882 calls to the real engine across seven volatilities, seven horizons, nine fee
// levels and two concentration factors: 756 proved, 112 have no breakeven at all (the engine returns
// null when horizon fees exceed the 100% a bounded loss can reach), 14 refused by the ceiling, 0
// diverged. The worst honest case uses 99.7384% of the derived bound.

/**
 * Build a proof of the breakeven bracket in the background and record it under the response's content
 * hash. Never rejects; every caller on the request path ignores the promise.
 */
export async function buildLpBracketInBackground(contentHash, echoedInputs, result) {
  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;
  claimed.add(contentHash);
  try {
    await buildLpBracketOnce(contentHash, echoedInputs, result);
  } catch (e) {
    put(contentHash, { status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    claimed.delete(contentHash);
  }
}

/**
 * THE GUARD, as a pure function — the four questions asked of a built witness, in the order a reader
 * would ask them, each with its own refusal so the stored record says which one failed.
 *
 * EXPORTED, and that is not for convenience. The sweep in gates/gateLP-bracket-snark.mjs has to
 * exercise THIS code and not a paraphrase of it: the first draft of that gate re-implemented these
 * four checks inline, which meant 882 rows measured a copy of the guard while the shipped guard went
 * untested — a verifier that cannot fail, one level up. Proving 756 answers to reach the shipped guard
 * is eleven minutes of Plonk; calling it directly is milliseconds and is the same code.
 *
 * @returns {string|null} the refusal, or null when the witness may be proven
 */
export function lpBracketRefusal(w) {
  if (!w || w.refused) return w?.refused || 'no witness';

  // 1. Does the replay describe the answer the engine SERVED? An equality against the engine's own
  //    display rounding, asked of the REPLAY and not of the certificate — the replay is the engine's
  //    expression in the engine's order, so it reproduces the served digit exactly or the
  //    transcription has drifted. Measured: 0 disagreements in 770.
  if (!w.engineSigmaDisplaysAsServed) {
    return `the bisection replayed here lands on ${w.engineSigma}, which displays as ${lpDisplayRound(w.engineSigma)}; the answer served ${w.servedSigma} — refusing to certify a different breakeven`;
  }

  // 2. Can the 1e-9 grid pin this breakeven at all? THE CEILING, and it is REACHED on the served path.
  //    sigma = sqrt(v/T) has an unbounded slope at v = 0, so for a small enough breakeven variance the
  //    coarsest bracket whose straddle still survives the grid maps to a range of volatilities wider
  //    than the 0.5e-5 the figure is published to. Measured: 14 of 770 swept answers, all of them fee
  //    levels under about 0.012% APR at a one-period horizon, where the exceedance runs 2.2x to 26x.
  if (!(w.sigmaBound <= w.displayHalfUnit)) {
    return `the 1e-9 variance grid cannot pin this breakeven tighter than ±${w.sigmaBound} — wider than the ${w.displayHalfUnit} the answer is displayed to, so no proof of it would be a proof of this answer. The bracket this needed is ${w.hi - w.lo} wide in total variance, and at a breakeven variance of ${w.vStarEngine} that is ${w.sigmaBound} of volatility.`;
  }

  // 3. And does the certificate actually agree with the engine's own number? Grid resolution, not
  //    display resolution — the comparison is against the UNROUNDED bisection, because an equality on
  //    the rounded figure refused 28 of 770 honest cases sitting on a 5th-decimal boundary.
  if (!(w.gapToEngine <= w.sigmaBound)) {
    return `the certified breakeven diverges from the engine's own by ${w.gapToEngine}, past the ±${w.sigmaBound} the bracket and the grid admit — refusing to certify a different breakeven`;
  }

  // 4. And are the inequalities the circuit will be asked to prove actually true? All of them hold by
  //    construction from the encoder's refusals, and checking them here costs a handful of BigInt
  //    comparisons while turning an unsatisfiable-constraint failure deep inside the witness
  //    calculator into a refusal that names which one broke.
  const e = w.encoded;
  const abs = (v) => (v < 0n ? -v : v);
  const claims = [
    ['the bracket is ordered, lo < hi', e.loHat < e.hiHat],
    ['the straddle g(lo) > 0', e.eLoHat + e.feeHat > scale.SCALE],
    ['the straddle g(hi) <= 0', e.eHiHat + e.feeHat <= scale.SCALE],
    ['the endpoint values are in decreasing order', e.eHiHat <= e.eLoHat],
    ['the root is the bracket midpoint to one grid step', w.mid >= -1n && w.mid <= 1n],
    ['the bracket is inside its published width bound', w.widthSlack >= 0n],
    ['the root residual is inside the circuit\'s own tolerance', 2n * abs(w.rootResidual) <= w.rootTolerance],
  ];
  for (const [label, holds] of claims) {
    if (!holds) return `${label} does not hold over the encoded integers — this witness would not satisfy lpbracket.circom`;
  }
  return null;
}

async function buildLpBracketOnce(contentHash, echoedInputs, result) {
  const cold = await proofStore.read(contentHash);
  if (cold) { store.set(contentHash, cold); return; }

  // Is there an answer to be a proof OF, and is the witness generator still the engine? Both are
  // inside `bracketWitnessFor`, which refuses with a sentence rather than a null — including the
  // per-request check that its transcription of the engine's quadrature still reproduces the
  // 4-decimal figure this very answer published.
  const w = lpBracketWitnessFor(echoedInputs, result);
  const refusal = lpBracketRefusal(w);
  if (refusal) { put(contentHash, { status: 'unavailable', error: refusal }); return; }
  const e = w.encoded;

  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove('lpbracket', w.witness);
    await put(contentHash, {
      status: 'ready', protocol: PROTOCOL,
      circuit: 'lpbracket',
      proof, publicSignals,
      signalsAttestation: attestSignals(publicSignals),
      encoded: Object.fromEntries(Object.entries(w.encoded).map(([k, v]) => [k, String(v)])),
      // THE CERTIFIED FIGURE AT FULL PRECISION, because the served one is rounded to five decimals
      // and the bounds below are three orders of magnitude tighter than that rounding. A reader who
      // only ever sees `0.06648` cannot tell a 1e-9 certificate from a 1e-5 one.
      certifiedBreakevenVolatility: w.certifiedSigma,
      gapToServedBreakeven: w.gapToServed,
      gapToEngineBreakeven: w.gapToEngine,
      encodingBound: w.sigmaBound,
      displayHalfUnit: w.displayHalfUnit,
      boundUsed: w.boundUsed,
      // The bracket itself, and the two values that are ASSUMED rather than proven — published in the
      // record as well as in the public signals, because "which numbers were not certified" is the
      // single most important thing a reader of this particular proof has to know.
      bracket: { lo: w.lo, hi: w.hi, halvings: w.halvings, doublings: w.doublings, enginePerforms: 200 },
      assumedEndpointExpectations: {
        lHatLo: String(e.eLoHat), lHatHi: String(e.eHiHat),
        basis: 'L = E[IL] + 1 from the engine\'s 401-point quadrature at the two bracket ends. PUBLIC INPUTS, not proven by this circuit.',
        closedFormLo: w.closedFormLo, closedFormHi: w.closedFormHi,
        closedFormBasis: 'L = exp(-v/8), which is exact: 2*sqrt(r)/(1+r) = sech(ln r/2), and with a = sqrt(v)/2 the shift z = w + a leaves sech(a*w) against a pdf gaining cosh(a*w), whose product is 1. Check the two assumed values in one line each.',
        closedFormGapLo: Math.abs(w.eLo - w.closedFormLo),
        closedFormGapHi: Math.abs(w.eHi - w.closedFormHi),
        closedFormWorstMeasured: 1.419121e-9,
      },
      straddleMarginGridSteps: { lo: w.straddleMarginLo, hi: w.straddleMarginHi },
      reconstruct: 'The public signals are [midResidual, widthSlack, sigResidual, sigTolerance, feeHat, loHat, hiHat, vStarHat, eLoHat, eHiHat, sigHat, horizonT, widthHat]. breakevenVolatility = sigHat/1e9; the total variance it is the root of is vStarHat/1e9; check the root by squaring: sigHat^2 * horizonT - vStarHat * 1e9 is the third signal and is bounded by the fourth.',
      verify: verifyInstruction('lpbracket'),
    });
  })
    .catch((e2) => put(contentHash, { status: 'failed', error: String(e2 && e2.message || e2).slice(0, 200) }))
    .finally(() => { queued--; });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SEVENTH IDENTITY — the same normal CDF, for `options-risk`, and the first that pins SIX
// published fields off ONE circuit instance rather than one.
//
// Every file on this host that touched the question said options-risk could not be wired: `ncdf.circom`
// pins N(x) given x, and options-risk's x is d1 = [ln(F/K) + ½σ²T]/(σ√T), so pinning it needs a
// logarithm. gates/preflight.mjs said it in those words. All of that is true, and none of it was the
// whole question, because it was asked about the PRICE.
//
// The premium df·(F·N(d1) − K·N(d2)) does need two CDF points and is NOT proven here. But options-risk's
// headline is the `greeks` block, and at r = 0 all six greeks are rational functions of exactly two
// transcendentals taken at the SAME point d1 — N(d1) for delta, φ(d1) for the other five, with theta's
// r·price term vanishing precisely because r = 0. `ncdf.circom` publishes (x, N(x), φ(x)) and pins both.
// So one instance of the circuit that already exists pins the whole block.
//
// WHY THE GUARD LIVES ENTIRELY IN src/util/optionsRiskNcdfWitness.js. The scope conditions ARE the
// mathematics — one leg, r = 0, below the tail split — and each of them is the reason a particular
// greek would otherwise be a claim about a quantity this circuit does not carry. Splitting them between
// a guard and a handler would put half the argument where nothing reads it.
//
// WHAT IS DELIBERATELY NOT PRE-CHECKED, for event-vol's reason and not a new one: the circuit's own
// integer residuals. Verifying them needs Hart's 192-entry exponential table and both Horner
// polynomials, and a copy shipped in the service would be a third statement of the same constants with
// nothing comparing it to the circuit. zk/scripts/gateB7-7 parses the circom source and sweeps the real
// engine against it instead. A witness that somehow fell outside surfaces as `failed`, not as a wrong
// proof.

/**
 * Build the greeks-block CDF proof in the background and record it under the response's content hash.
 * The seventh twin of `buildInBackground`, separate for the reason the other six are.
 */
export async function buildOptionsRiskNcdfInBackground(contentHash, echoedInputs, result) {
  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;
  claimed.add(contentHash);
  try {
    await buildOptionsRiskNcdfOnce(contentHash, echoedInputs, result);
  } catch (e) {
    put(contentHash, { status: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    claimed.delete(contentHash);
  }
}

async function buildOptionsRiskNcdfOnce(contentHash, echoedInputs, result) {
  const cold = await proofStore.read(contentHash);
  if (cold) { store.set(contentHash, cold); return; }

  // ONE CALL, AND EVERY REFUSAL CARRIES ITS OWN SENTENCE. `optionsRiskNcdfWitnessFor` runs the scope
  // conditions, the twelve published-field equalities, every range condition the circuit enforces, the
  // per-greek display ceiling, the per-greek encoding agreement against the engine's own unrounded
  // values, and the per-greek display equality — and returns `{ reason }` for whichever one broke.
  const w = optionsRiskNcdfWitnessFor(echoedInputs, result);
  if (w.reason) { put(contentHash, { status: 'unavailable', error: w.reason }); return; }

  if (queued >= MAX_QUEUED) {
    put(contentHash, { status: 'unavailable', error: `prover busy — ${queued} proofs already queued; retry shortly` });
    return;
  }
  put(contentHash, { status: 'building' });
  queued++;
  queue = queue.then(async () => {
    const { proof, publicSignals } = await prove('ncdf', w.witness);
    await put(contentHash, {
      status: 'ready', protocol: PROTOCOL,
      circuit: 'ncdf',
      proof, publicSignals,
      signalsAttestation: attestSignals(publicSignals),
      encoded: Object.fromEntries(Object.entries(w.encoded).map(([k, v]) => [k, String(v)])),
      // All six reconstructions at FULL precision, because the served figures are rounded to six and
      // eight decimals and the bounds below are orders of magnitude tighter than that rounding. A
      // reader who only ever sees `1.082593` cannot tell a 1e-11 proof from a 1e-3 one.
      greeksFromProof: w.reconstructed,
      gapToEngine: w.gapToEngine,
      encodingBound: w.encodingBound,
      envelope: w.envelope,
      priceTerms: w.priceTerms,
      worstFractionOfEncodingBound: w.worstFractionOfEncodingBound,
      pointProven: w.point,
      reconstruct: 'With n = nHat/2^40 and p = pHat/2^40 the fifth and sixth public signals, and x = ±xMag/2^40 the third and fourth: delta = q·n (q·(n−1) for a put), gamma = q·p/(F·σ·√T), vega = q·F·p·√T/100, vanna = −q·p·d2/σ·0.01, volga = vega·d1·d2/σ·0.01, theta = −q·F·p·σ/(2·√T)/365, with d1 = x and d2 = x − σ·√T. Bind x to your own leg with ONE exponential: x is this leg\'s d1 iff K·exp(σ·√T·x − ½σ²T) = F.',
      verify: verifyInstruction('ncdf'),
    });
  })
    .catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }))
    .finally(() => { queued--; });
}

// The verification keys, one per circuit. `liquidation` keeps reading `vk_plonk.json` under that
// exact name — it is the file `/proof/vk` has served since this service had proofs, and renaming it
// would break a published URL for a cosmetic gain.
const VK_FILES = { liquidation: 'vk_plonk.json', kelly: 'kelly_vk.json', concentration: 'concentration_vk.json', execadverse: 'execadverse_vk.json', ncdf: 'ncdf_vk.json', lpbracket: 'lpbracket_vk.json' };
export const CIRCUITS = Object.keys(VK_FILES);

export function verificationKey(circuit = 'liquidation') {
  const file = VK_FILES[circuit];
  if (!file) return null;
  try { return JSON.parse(readFileSync(join(ZK, file), 'utf8')); } catch { return null; }
}

/**
 * The pieces the divergence guard is assembled from, exposed so gates/gateW-divergence-guard.mjs can
 * measure them rather than infer them from refusals. Nothing on a served path reads this — it exists
 * because the alternative is a gate that checks the guard by watching what it happens to reject,
 * which is how a bound stops being measurable and starts being asserted.
 */
export const _internal = { displayRound, encodingError, encodingShift, HALF_STEP, HALF_ULP, DISPLAY_HALF_UNIT };

/**
 * The same, for the Kelly guard. A SECOND object rather than more keys on the first, because the two
 * guards' constants are not interchangeable and a gate that reached for `DISPLAY_HALF_UNIT` while
 * measuring a Kelly bound would be off by a factor of ten thousand without anything going red.
 */
export const _internalKelly = {
  displayRound: kellyDisplayRound,
  encodingShift: kellyEncodingShift,
  HALF_STEP: KELLY_HALF_STEP,
  DISPLAY_HALF_UNIT: KELLY_DISPLAY_HALF_UNIT,
};

/** The same again, for the Herfindahl guard. A third object, for the second reason above. */
export const _internalHhi = {
  displayRound: hhiDisplayRound,
  encodingShift: hhiEncodingShift,
  HALF_STEP: HHI_HALF_STEP,
  DISPLAY_HALF_UNIT: HHI_DISPLAY_HALF_UNIT,
};

/**
 * And again, for the adverse-execution guard. A FOURTH object, and this one has two display constants
 * instead of one because the circuit certifies two published quantities in two units — a headline in
 * basis points and a shortfall in output tokens. A gate that reached for a single `DISPLAY_HALF_UNIT`
 * here would be measuring one of them with the other's ruler, four hundred thousand times off.
 */
export const _internalExec = {
  displayRoundBps: execDisplayRoundBps,
  displayRoundTokens: execDisplayRoundTokens,
  encodingShift: execEncodingShift,
  HALF_STEP: EXEC_HALF_STEP,
  DISPLAY_HALF_BPS: EXEC_DISPLAY_HALF_BPS,
  DISPLAY_HALF_TOKENS: EXEC_DISPLAY_HALF_TOKENS,
  BPS_FULL: EXEC_BPS_FULL,
  REL_CEILING: EXEC_REL_CEILING,
};

/**
 * And again, for the bracket guard. A FIFTH object on this file, whose constants live in
 * `src/util/lpBracket.js` because that is where they are derived — re-exported here so a gate reading
 * guards has one place to read them from, and so a gate that reached for `DISPLAY_HALF_UNIT` while
 * measuring a breakeven volatility would be off by a factor of a thousand instead of silently right.
 */
export const _internalLpBracket = {
  ..._internalLp,
  displayRound: lpDisplayRound,
  DISPLAY_HALF_UNIT: LP_DISPLAY_HALF_UNIT,
};
