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

/**
 * The pieces the divergence guard is assembled from, exposed so gates/gateW-divergence-guard.mjs can
 * measure them rather than infer them from refusals. Nothing on a served path reads this — it exists
 * because the alternative is a gate that checks the guard by watching what it happens to reject,
 * which is how a bound stops being measurable and starts being asserted.
 */
export const _internal = { displayRound, encodingError, encodingShift, HALF_STEP, HALF_ULP, DISPLAY_HALF_UNIT };
