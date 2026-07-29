// Packing, unpacking and diagnosis for the widened Kelly circuit.
//
// This is a NEW file rather than an addition to gatekit.mjs, because gatekit is shared with circuits
// another session is working on and the packing is specific to `kellybatch*.circom`.
//
// THE LAYOUT, which the circuit and every reader must agree on:
//
//     lane = pHat (bits 0..29) | bHat (bits 30..74) | fHat (bits 75..119)      120 bits
//     word = lane(2i) at bits 0..119  |  lane(2i+1) at bits 120..239           240 bits
//
// Two answers per 254-bit field element. For an odd batch the top lane of the final word is zero, and
// the circuit constrains it to be, so a batch of answers has exactly one valid encoding.
//
// WHY THE DIAGNOSIS BELONGS HERE. The whole argument for publishing the answers instead of a Poseidon
// root is that a rejected batch must not be opaque: a reader holding only the public signals has to be
// able to say WHICH member is wrong. `firstBadMember` is that reader, written once so the gate and the
// Solidity version in gateB9-2 are checking the same rule.
import { load } from '../service-root.mjs';

export const SCALE = 1_000_000_000n;
export const S = Number(SCALE);

export const NB_P = 30;
export const NB_B = 45;
export const NB_F = 45;
export const LANE = NB_P + NB_B + NB_F;      // 120
export const LANES_PER_WORD = 2;

const MASK = (bits) => (1n << BigInt(bits)) - 1n;

/** Round the DECIMAL, never the scaled product: `Math.round(x * 1e9)` is wrong above ~9e6. */
export const snap = (x) => Number(x.toFixed(9));

/** Exact at every magnitude: `toFixed(9)` is the correctly-rounded decimal, reassembled in BigInt. */
export const toScaled = (x, name = 'value') => {
  const v = Number(x);
  if (!Number.isFinite(v)) throw new Error(`${name}: not finite`);
  if (v < 0) throw new Error(`${name}: negative`);
  const [whole, frac = ''] = v.toFixed(9).split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(9, '0'));
};

export const wordsFor = (n) => (n + 1) >> 1;

/**
 * Pack N answers into ceil(N/2) field elements.
 *
 * Every field is range-checked HERE and the failure names the member, because a lane that overflows
 * its width would silently corrupt its neighbour instead of failing: a bHat of 2^45 would set the
 * bottom bit of fHat and produce a perfectly well-formed word describing a different bet.
 */
export function pack(answers) {
  const words = new Array(wordsFor(answers.length)).fill(0n);
  answers.forEach((a, i) => {
    const p = BigInt(a.pHat), b = BigInt(a.bHat), f = BigInt(a.fHat);
    if (p < 0n || p > MASK(NB_P)) throw new Error(`member ${i}: pHat ${p} does not fit ${NB_P} bits`);
    if (b < 0n || b > MASK(NB_B)) throw new Error(`member ${i}: bHat ${b} does not fit ${NB_B} bits`);
    if (f < 0n || f > MASK(NB_F)) throw new Error(`member ${i}: fHat ${f} does not fit ${NB_F} bits`);
    const lane = p | (b << BigInt(NB_P)) | (f << BigInt(NB_P + NB_B));
    words[i >> 1] |= lane << BigInt((i % LANES_PER_WORD) * LANE);
  });
  return words;
}

/** The inverse, and the thing an on-chain reader does with a shift and a mask. */
export function unpack(words, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const lane = (BigInt(words[i >> 1]) >> BigInt((i % LANES_PER_WORD) * LANE)) & MASK(LANE);
    out.push({
      pHat: lane & MASK(NB_P),
      bHat: (lane >> BigInt(NB_P)) & MASK(NB_B),
      fHat: (lane >> BigInt(NB_P + NB_B)) & MASK(NB_F),
    });
  }
  return out;
}

/** R = f*b - p*b - S*p + S^2, the integer residual the circuit bounds. Exactly kelly.circom's. */
export const residualOf = ({ pHat, bHat, fHat }) =>
  BigInt(fHat) * BigInt(bHat) - BigInt(pHat) * BigInt(bHat) - SCALE * BigInt(pHat) + SCALE * SCALE;

/** The proven bound, per member: 2*|R| <= b. Returns the fraction of the bound this member uses. */
export function memberCheck(a) {
  const R = residualOf(a);
  const abs2 = (R < 0n ? -R : R) * 2n;
  const b = BigInt(a.bHat);
  return { R, abs2, bHat: b, ok: b > 0n && abs2 <= b, usage: b > 0n ? Number(abs2) / Number(b) : Infinity };
}

/**
 * Given ONLY the public signals, name the first member that breaks the statement.
 *
 * This is the property the packing buys and a hash commitment does not. A verifier can say no; this
 * says which one, from data that is already on chain.
 */
export function firstBadMember(words, n) {
  const members = unpack(words, n);
  for (let i = 0; i < n; i++) {
    const m = members[i];
    if (m.pHat === 0n) return { index: i, reason: 'pHat is zero', member: m };
    if (m.pHat >= SCALE) return { index: i, reason: 'pHat is not a proper fraction (p >= 1)', member: m };
    if (m.bHat === 0n) return { index: i, reason: 'bHat is zero, the identity degenerates', member: m };
    if (m.fHat === 0n) return { index: i, reason: 'fHat is zero, no positive edge', member: m };
    const c = memberCheck(m);
    if (!c.ok) return { index: i, reason: `2|R| = ${c.abs2} exceeds the tolerance b = ${c.bHat}`, member: m, ...c };
  }
  return null;
}

/**
 * One honest answer, taken from the REAL engine.
 *
 * The Kelly fraction is NOT read back from `sizeGate`'s reply: the service publishes
 * `round(fullKelly, 6)`, and certifying that number would prove an identity about a bet up to 5e-7 —
 * five hundred grid steps — away from the one that was sized. It is recomputed at full precision using
 * the engine's own expression, in the engine's own order, from the SNAPPED inputs the circuit sees,
 * and then checked back against what the engine served. Past six decimals the answer is refused rather
 * than quietly certified as a different bet. This is the fix the liquidation circuit needed for
 * `round(M, 2)` and the Kelly circuit needed for `round(f, 6)`.
 */
export function encodeFromEngine(sizeGate, p, b, { displayRounding = 5e-7 } = {}) {
  const r = sizeGate({ winProb: p, winLossRatio: b });
  if (!r.ok || !(r.fullKellyFraction > 0)) return null;

  const pHat = toScaled(p, 'p');
  const bHat = toScaled(b, 'b');
  if (pHat <= 0n || pHat >= SCALE || bHat <= 0n) return null;

  const pS = Number(pHat) / S;
  const bS = Number(bHat) / S;
  const fFull = (pS * (bS + 1) - 1) / bS;
  if (!(fFull > 0)) return null;
  const fHat = toScaled(fFull, 'f');
  if (fHat <= 0n) return null;

  const gapToServed = Math.abs(fFull - r.fullKellyFraction);
  if (gapToServed > displayRounding) return { diverged: true, gapToServed, p, b };

  return { pHat, bHat, fHat, p, b, f: fFull, served: r.fullKellyFraction, gapToServed, ...memberCheck({ pHat, bHat, fHat }) };
}

/** `await engine()` -> the live sizeGate, resolved through whichever layout this checkout is. */
export async function engine(importMetaUrl) {
  const { sizeGate } = await load(importMetaUrl, 'engine/sizeGate.js');
  return sizeGate;
}

/** Deterministic generator, so a failure is reproducible and a pass is not luck of the draw. */
export function rng(seed = 20260729) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** A realistic book: b in [0.1, 50], p above the break-even 1/(b+1) so the edge is positive. */
export function drawBet(rand, { onGrid = true } = {}) {
  let b = 0.1 + rand() * 49.9;
  const breakEven = 1 / (b + 1);
  let p = breakEven + rand() * (1 - breakEven) * 0.98;
  if (onGrid) { b = snap(b); p = snap(p); }
  return { p, b };
}

/** The witness object the circuit's wasm expects. */
export const witnessFor = (answers) => ({ packed: pack(answers).map(String) });
