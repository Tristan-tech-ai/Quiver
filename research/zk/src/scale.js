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

module.exports = {
  SCALE, SCALE_DECIMALS, BOUNDS,
  abs, toScaled, fromScaled, roundDiv,
  engineLiquidationPrice, canonicalLiquidationPrice,
  residual, toleranceBound, toCircuitInputs, toWitnessInput,
};
