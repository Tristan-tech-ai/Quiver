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
  if (store.has(contentHash) || claimed.has(contentHash)) return;
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
      verify: 'snarkjs plonk verify kelly_vk.json publicSignals proof — the verification key is published at /proof/vk/kelly',
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
  if (store.has(contentHash) || claimed.has(contentHash)) return;
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
      verify: 'snarkjs plonk verify concentration_vk.json publicSignals proof — the verification key is published at /proof/vk/concentration',
    });
  })
    .catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }))
    .finally(() => { queued--; });
}

// The verification keys, one per circuit. `liquidation` keeps reading `vk_plonk.json` under that
// exact name — it is the file `/proof/vk` has served since this service had proofs, and renaming it
// would break a published URL for a cosmetic gain.
const VK_FILES = { liquidation: 'vk_plonk.json', kelly: 'kelly_vk.json', concentration: 'concentration_vk.json' };
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
