'use strict';

// The transformation from the engine's IEEE-754 inputs to the circuit's field
// elements. This file is the normative definition of that translation: a reader
// checking a proof should be able to reproduce every scaled value from the floats
// echoed in `proof.inputs` using nothing but what is written here.
//
// There are two distinct error terms and they must not be conflated:
//
//   (A) ENCODING error. The engine's float inputs are snapped to a 1/SCALE grid.
//       The circuit says nothing about this step; a reader checks it by rerunning
//       `toScaled` on the echoed floats. Bounded by half an ulp of SCALE per input.
//
//   (B) RESIDUAL. Within the encoded integer domain the inputs are exact by
//       definition, and the only inexact quantity is the derived liquidation
//       price, which must be rounded to the grid. The circuit proves a bound on
//       the imbalance this rounding induces. This is (B) and only (B).
//
// Getting this split wrong is how the whole thing becomes theatre: if the
// liquidation price is taken from the engine's float pipeline while the residual
// is evaluated against rounded inputs, the residual absorbs (A) as well and no
// honest bound exists. So the canonical liquidation price is recomputed here from
// the scaled integers as an exact rational, then rounded once.

const SCALE = 10n ** 9n;
const SCALE_DECIMALS = 9;

// Bit bounds, mirrored from circuits/liquidation.circom.
const BOUNDS = { mHat: 80n, qHat: 60n, p0Hat: 60n, mmrHat: 30n, pLiqHat: 60n };

function abs(x) {
  return x < 0n ? -x : x;
}

// Exact double -> scaled integer.
//
// Deliberately NOT `Math.round(x * 1e9)`: for x above ~9e6 that product exceeds
// 2^53 and the rounding silently lands on the wrong integer. `toFixed(9)` is
// specified to round the exact decimal value of the double, so it stays correct
// across the whole supported range.
function toScaled(x, name) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new Error(`${name}: expected a finite number, got ${x}`);
  }
  const s = x.toFixed(SCALE_DECIMALS);
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(int) * SCALE + BigInt(frac);
  return neg ? -v : v;
}

function fromScaled(v) {
  return Number(v) / Number(SCALE);
}

// Round-half-away-from-zero division on BigInts.
function roundDiv(num, den) {
  if (den === 0n) throw new Error('roundDiv: zero denominator');
  const neg = (num < 0n) !== (den < 0n);
  const n = abs(num);
  const d = abs(den);
  const q = (2n * n + d) / (2n * d);
  return neg ? -q : q;
}

// The engine's computation, in doubles, exactly as stated in the brief. Retained
// so the canonical integer path can be checked against it.
function engineLiquidationPrice({ M, q, P0, s, mmr }) {
  return (s * q * P0 - M) / (q * (s - mmr));
}

// The canonical liquidation price, as an exact rational over the scaled integers,
// rounded once to the 1/SCALE grid.
//
//   P_liq = (s*q*P0 - M) / (q*(s - mmr))
//
// substituting M = mHat/S, q = qHat/S, P0 = p0Hat/S, mmr = mmrHat/S and
// multiplying by S to land back on the grid:
//
//   pLiqHat = round( S * (s*qHat*p0Hat - mHat*S) / (qHat*(s*S - mmrHat)) )
function canonicalLiquidationPrice({ mHat, qHat, p0Hat, s, mmrHat }) {
  const sBig = BigInt(s);
  const num = SCALE * (sBig * qHat * p0Hat - mHat * SCALE);
  const den = qHat * (sBig * SCALE - mmrHat);
  return roundDiv(num, den);
}

// The integer residual the circuit constrains:
//   R = M*SCALE^2 + s*q*(P - P0)*SCALE - q*P*mmr
// R equals SCALE^3 * (account value - maintenance requirement), in quote currency.
function residual({ mHat, qHat, p0Hat, s, mmrHat, pLiqHat }) {
  const sBig = BigInt(s);
  const lhs = mHat * SCALE * SCALE + sBig * qHat * (pLiqHat - p0Hat) * SCALE;
  const rhs = qHat * pLiqHat * mmrHat;
  return lhs - rhs;
}

// The tolerance, derived from the inputs rather than fixed.
//
// R is linear in pLiqHat with slope dR/dP = qHat*(s*SCALE - mmrHat), so rounding
// the price by at most half a grid step moves R by at most
// (1/2)*qHat*(SCALE + mmrHat). Doubling clears the fraction:
//
//   2*|R|  <=  qHat * (SCALE + mmrHat)
//
// This scales with position size and maintenance rate, which is the shape the
// measured data has. It is also not gameable: the prover cannot widen it without
// changing the position it is proving about.
function toleranceBound({ qHat, mmrHat }) {
  return qHat * (SCALE + mmrHat);
}

// Full float -> field-element translation, with the range discipline applied on
// this side too so failures are legible.
function toCircuitInputs({ M, q, P0, s, mmr }, pLiqOverride) {
  if (s !== 1 && s !== -1) throw new Error(`s: expected +1 or -1, got ${s}`);

  const base = {
    mHat: toScaled(M, 'M'),
    qHat: toScaled(q, 'q'),
    p0Hat: toScaled(P0, 'P0'),
    s,
    mmrHat: toScaled(mmr, 'mmr'),
  };

  if (base.qHat === 0n) throw new Error('q: must be non-zero');
  if (base.mmrHat >= SCALE) throw new Error(`mmr: must be < 1, got ${fromScaled(base.mmrHat)}`);

  const pLiqHat =
    pLiqOverride !== undefined ? pLiqOverride : canonicalLiquidationPrice(base);

  const inputs = { ...base, pLiqHat };

  for (const [name, bits] of Object.entries(BOUNDS)) {
    const v = inputs[name];
    if (v < 0n) throw new Error(`${name}: negative (${v}); circuit requires non-negative`);
    if (v >= 1n << bits) throw new Error(`${name}: ${v} exceeds the ${bits}-bit bound`);
  }

  return inputs;
}

// What circom's witness generator wants: decimal strings, negatives left for the
// field to absorb (s = -1 becomes p-1).
function toWitnessInput(inputs) {
  return {
    mHat: inputs.mHat.toString(),
    qHat: inputs.qHat.toString(),
    p0Hat: inputs.p0Hat.toString(),
    s: inputs.s.toString(),
    mmrHat: inputs.mmrHat.toString(),
    pLiqHat: inputs.pLiqHat.toString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND IDENTITY: discrete Kelly, for `size-gate`.
//
// Everything above translates ONE engine. This block translates a second, and it
// is written here rather than in a new file for the reason the header gives: this
// file is the normative definition of the float -> field-element step, and a
// reader checking a size-gate proof needs the same guarantee a reader checking a
// perp-gate proof gets — that every scaled value is reproducible from the floats
// echoed in `proof.inputs` using nothing but what is written here.
//
// The same two error terms apply and must not be conflated. (A) encoding: p and b
// are snapped onto the 1/SCALE grid by the service before the engine ever sees
// them, so on a served path this term is half an ulp rather than half a step.
// (B) residual: within the encoded integers the only inexact quantity is the
// derived Kelly fraction, which is rounded to the grid ONCE, below.

// Bit bounds, mirrored from circuits/kelly.circom's `KellyIdentity(1e9, 30, 45, 45, 100)`.
const KELLY_BOUNDS = { pHat: 30n, bHat: 45n, fHat: 45n };

// The engine's computation, in doubles, in the engine's own order — the exact
// counterpart of `engineLiquidationPrice` above and lifted from the same place:
// `src/engine/sizeGate.js` states it as `fullKelly = (pw * (b + 1) - 1) / b`.
//
// COPIED, NOT REARRANGED. `(p*b + p - 1) / b` is the same identity and a
// different double; a `constantproduct` encoder that made exactly that move was
// wrong by 64 grid steps. gates/gateK-kelly-snark.mjs does not take the copy on
// trust — it lifts the engine's own source line, compiles it, and requires
// Object.is agreement over a sweep, the way gate W does for the price above.
// The parameter is `pw` and not `p` because that is what `sizeGate.js` calls it. Matching the engine's
// own identifiers is not fussiness: gates/gateK-kelly-snark.mjs compares the two source lines as TEXT
// before it compares them as numbers, and a rename would force that comparison to normalise — which is
// a fudge in exactly the check that exists to catch a silent rewrite.
function engineKellyFraction({ pw, b }) {
  return (pw * (b + 1) - 1) / b;
}

// The canonical Kelly fraction, as an exact rational over the scaled integers,
// rounded once to the 1/SCALE grid.
//
//   f = (p*(b + 1) - 1) / b
//
// substituting p = pHat/S and b = bHat/S and multiplying by S to land back on
// the grid:
//
//   fHat = round( (pHat*bHat + S*pHat - S^2) / bHat )
//
// This is the solve the circuit's residual is measured against, so rounding it
// half-away-from-zero here is what makes `2*|R| <= bHat` hold by construction
// rather than by luck: R is linear in fHat with slope bHat, so a half-step
// rounding moves R by at most bHat/2. Measured over 197,902 bets spanning four
// deliberately different shapes, zero violate it.
function canonicalKellyFraction({ pHat, bHat }) {
  return roundDiv(pHat * bHat + SCALE * pHat - SCALE * SCALE, bHat);
}

// The integer residual the circuit constrains:
//   R = fHat*bHat - pHat*bHat - S*pHat + S^2
// R equals S^2 times the gap between the two sides of the cross-multiplied
// identity, measured in bankroll fractions — a quantity a reader can interpret.
// Term for term what `kelly.circom` computes.
function kellyResidual({ pHat, bHat, fHat }) {
  return fHat * bHat - pHat * bHat - SCALE * pHat + SCALE * SCALE;
}

// The tolerance, derived from the inputs rather than fixed, and published by the
// circuit as a public signal of its own so a prover cannot widen it without
// changing the bet being proven about.
function kellyToleranceBound({ bHat }) {
  return bHat;
}

// Full float -> field-element translation for the Kelly identity, with the range
// discipline applied on this side too so failures are legible rather than
// arriving as an unsatisfied constraint deep inside the witness calculator.
function toKellyCircuitInputs({ p, b }, fHatOverride) {
  const base = { pHat: toScaled(p, 'winProb'), bHat: toScaled(b, 'winLossRatio') };
  if (base.pHat <= 0n) throw new Error('winProb: must be > 0');
  if (base.pHat >= SCALE) throw new Error(`winProb: must be < 1, got ${fromScaled(base.pHat)}`);
  if (base.bHat <= 0n) throw new Error('winLossRatio: must be > 0');

  const fHat = fHatOverride !== undefined ? fHatOverride : canonicalKellyFraction(base);
  // The circuit demands a positive edge — `sizeGate` itself refuses to size a bet
  // when f* <= 0, so proving about that region would be proving about something
  // the service never sold.
  if (fHat <= 0n) throw new Error('fullKelly: no positive edge to prove about');

  const inputs = { ...base, fHat };
  for (const [name, bits] of Object.entries(KELLY_BOUNDS)) {
    const v = inputs[name];
    if (v < 0n) throw new Error(`${name}: negative (${v}); circuit requires non-negative`);
    if (v >= 1n << bits) throw new Error(`${name}: ${v} exceeds the ${bits}-bit bound`);
  }
  return inputs;
}

function toKellyWitnessInput(inputs) {
  return {
    pHat: inputs.pHat.toString(),
    bHat: inputs.bHat.toString(),
    fHat: inputs.fHat.toString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE THIRD IDENTITY: the Herfindahl index, for `treasury-risk`.
//
// Same two error terms, and here they separate more cleanly than anywhere else.
// (A) encoding: the SHARES are not caller inputs, they are quotients — vᵢ/T — so
//     they land off the grid however carefully the request was written, exactly
//     as the liquidation margin does when it is derived from leverage. Snapping
//     the amounts does not put the shares on the grid, and nothing can.
// (B) residual: within the encoded integers the only inexact quantity is Ĥ,
//     rounded to the grid once, below.

// Assets per book, mirrored from circuits/concentration.circom's
// `Concentration(1e9, 8, 30, 30, 40, 1)`. Fixed at compile time.
const CONCENTRATION_N = 8;
const CONCENTRATION_BOUNDS = { wHat: 30n, hHat: 30n };

/**
 * The engine's own Herfindahl computation, in doubles, in the engine's own order.
 *
 * COPIED FROM `hhi` IN src/engine/stats.js, both folds, term for term. The total
 * is the fold over the VALUES this function is handed — which is the fold over
 * the GROUPED sums, not the fold over positions that treasuryRisk.js:29 performs
 * for its own purposes. The two agree to within a bit and are not the same
 * double, and using the wrong one would put a rounding error where the identity
 * should be. gates/gateH-concentration-snark.mjs lifts the engine's two lines,
 * compiles them, and requires Object.is agreement over a sweep.
 */
function engineHerfindahl(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return values.reduce((acc, v) => acc + (v / total) ** 2, 0);
}

/**
 * The shares the circuit is handed, as doubles, in the order the engine formed them.
 *
 * Split out from `engineHerfindahl` rather than inlined because the circuit takes
 * the SHARES as public inputs while the engine takes the amounts, so the two
 * boundaries are genuinely in different places. `(v / total) ** 2` and
 * `w ** 2` where `w = v / total` are the same two operations on the same doubles
 * in the same order, so folding these shares reproduces `engineHerfindahl`
 * exactly — asserted rather than assumed, over a sweep, in the gate.
 */
function engineShares(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return values.map((v) => v / total);
}

// The canonical Herfindahl index, as an exact sum over the scaled integers,
// rounded once to the 1/SCALE grid:
//
//   H = Σ wᵢ²   →   Ĥ = round( Σ ŵᵢ² / S )
//
// The squares are exact in BigInt, so this is the only rounding in the integer
// path, which is what makes 2·|R| <= S hold by construction: R is Ĥ·S − Σŵᵢ², and
// a half-step rounding of Ĥ moves it by at most S/2.
function canonicalHerfindahl(wHats) {
  const sumSq = wHats.reduce((a, w) => a + w * w, 0n);
  return roundDiv(sumSq, SCALE);
}

// The integer residual the circuit constrains: R = Ĥ·S − Σŵᵢ².
function concentrationResidual({ wHats, hHat }) {
  return hHat * SCALE - wHats.reduce((a, w) => a + w * w, 0n);
}

// The tolerance, a compile-time constant in the circuit (TOL_MULT = 1) rather
// than a function of the inputs, because the only rounding it has to absorb is
// the one grid step above and that does not scale with the book.
function concentrationToleranceBound() {
  return SCALE;
}

// How far the encoded shares may drift from summing to the whole book. The
// circuit computes `Σŵ − S + N` and requires it to land in [0, 2N]; N shares each
// rounding by half a step can drift by N/2, so the allowance is loose by a factor
// of two on purpose. Reproduced here so a book that would fail that constraint is
// refused with a sentence rather than as an unsatisfied constraint.
function concentrationWeightSlack(wHats) {
  return wHats.reduce((a, w) => a + w, 0n) - SCALE + BigInt(CONCENTRATION_N);
}

/**
 * Full float -> field-element translation for the Herfindahl identity.
 *
 * PADDING IS PART OF THE TRANSLATION, not a caller's problem. A book with fewer
 * than N assets pads with ŵ = 0, which contributes nothing to either accumulator,
 * so one circuit serves every book up to N. The padded lanes are still
 * range-checked by the circuit, so a zero there is a genuine zero rather than a
 * hole a prover can fill.
 */
function toConcentrationCircuitInputs(shares, hHatOverride) {
  if (!Array.isArray(shares) || shares.length === 0) throw new Error('shares: empty book');
  if (shares.length > CONCENTRATION_N) {
    throw new Error(`shares: ${shares.length} groups exceeds the ${CONCENTRATION_N} this circuit was compiled for`);
  }
  const wHats = shares.map((w, i) => toScaled(w, `share[${i}]`));
  for (const [i, w] of wHats.entries()) {
    if (w < 0n) throw new Error(`share[${i}]: negative`);
    if (w >= 1n << CONCENTRATION_BOUNDS.wHat) throw new Error(`share[${i}]: ${w} exceeds the ${CONCENTRATION_BOUNDS.wHat}-bit bound`);
  }
  const padded = [...wHats, ...Array(CONCENTRATION_N - wHats.length).fill(0n)];

  const hHat = hHatOverride !== undefined ? hHatOverride : canonicalHerfindahl(padded);
  // A zero index would mean an empty book, which the engine refuses to price, and
  // the circuit refuses with it.
  if (hHat <= 0n) throw new Error('hhi: a zero index means an empty book');
  if (hHat > SCALE) throw new Error(`hhi: ${hHat} exceeds 1, which no Herfindahl index can`);

  const slack = concentrationWeightSlack(padded);
  if (slack < 0n || slack > 2n * BigInt(CONCENTRATION_N)) {
    throw new Error(`shares: encoded weights sum to ${padded.reduce((a, w) => a + w, 0n)}, outside the ${2 * CONCENTRATION_N} grid steps of ${SCALE} the circuit admits`);
  }
  return { wHats: padded, hHat, groups: wHats.length, padded: CONCENTRATION_N - wHats.length };
}

function toConcentrationWitnessInput(inputs) {
  return {
    wHat: inputs.wHats.map((w) => w.toString()),
    hHat: inputs.hHat.toString(),
  };
}

module.exports = {
  SCALE, SCALE_DECIMALS, BOUNDS, KELLY_BOUNDS, CONCENTRATION_N, CONCENTRATION_BOUNDS,
  abs, toScaled, fromScaled, roundDiv,
  engineLiquidationPrice, canonicalLiquidationPrice,
  residual, toleranceBound, toCircuitInputs, toWitnessInput,
  engineKellyFraction, canonicalKellyFraction,
  kellyResidual, kellyToleranceBound, toKellyCircuitInputs, toKellyWitnessInput,
  engineHerfindahl, engineShares, canonicalHerfindahl,
  concentrationResidual, concentrationToleranceBound, concentrationWeightSlack,
  toConcentrationCircuitInputs, toConcentrationWitnessInput,
};
