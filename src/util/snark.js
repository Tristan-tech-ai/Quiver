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
// snarkjs costs 2,066 ms to import cold. That is started at boot without being awaited, so a request
// arriving later finds it resolved and the cold-start cost lands on the container, not the caller.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { attestSignals } from './attest.js';

const require = createRequire(import.meta.url);
const scale = require('./scale.cjs');

const ZK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'zk');
const PROTOCOL = 'plonk';

let snarkjsP = null;      // the import, started eagerly and awaited lazily
let zkey = null;
let wasm = null;
let witnessCalcP = null;

/** Start loading the prover without blocking boot. Safe to call more than once. */
export function warmProver() {
  if (snarkjsP) return snarkjsP;
  snarkjsP = import('snarkjs')
    .then((m) => m.default ?? m)
    .catch((e) => { snarkjsP = null; throw e; });
  return snarkjsP;
}

function artifacts() {
  if (!zkey) zkey = new Uint8Array(readFileSync(join(ZK, 'liquidation_plonk.zkey')));
  if (!wasm) wasm = readFileSync(join(ZK, 'liquidation_js', 'liquidation.wasm'));
  if (!witnessCalcP) {
    const builder = require(join(ZK, 'liquidation_js', 'witness_calculator.cjs'));
    witnessCalcP = builder(wasm);
  }
  return witnessCalcP;
}

// Content-hash-keyed store. Identical inputs produce an identical proof, so a repeat request is
// answered from here rather than re-proved. Bounded, because an unbounded cache on a public endpoint
// is a memory-exhaustion primitive.
const MAX = 200;
const store = new Map();   // contentHash -> { status, proof?, publicSignals?, error?, at }

export function getProof(contentHash) {
  return store.get(contentHash) || null;
}

function put(contentHash, rec) {
  if (store.size >= MAX) store.delete(store.keys().next().value);
  store.set(contentHash, { ...rec, at: new Date().toISOString() });
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

/** Build a proof in the background and record it under the response's content hash. */
export function buildInBackground(contentHash, echoedInputs, liquidationPrice) {
  if (store.has(contentHash)) return;
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
  put(contentHash, { status: 'building' });
  (async () => {
    const sj = await warmProver();
    const calc = await artifacts();
    const wtns = await calc.calculateWTNSBin(w.witness, 0);
    const { proof, publicSignals } = await sj[PROTOCOL].prove(zkey, wtns);
    put(contentHash, {
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
    });
  })().catch((e) => put(contentHash, { status: 'failed', error: String(e && e.message || e).slice(0, 200) }));
}

export function verificationKey() {
  try { return JSON.parse(readFileSync(join(ZK, 'vk_plonk.json'), 'utf8')); } catch { return null; }
}
