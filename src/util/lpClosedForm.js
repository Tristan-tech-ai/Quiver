// The exact expected impermanent loss, computed OUTSIDE the engine from fields the response already
// publishes. No engine change, so no codeHash movement and no contentHash movement.
//
// WHY THIS IS POSSIBLE AT ALL. `zk/build/probe-lpclosed-cost.json` concluded that a closed-form circuit
// fits the existing ceremony with room to spare (3,023 of 4,096 constraints) but that wiring it was
// blocked because "the engine serves a quadrature and this would certify the closed form ... the fix is
// engine-side and src/engine/ is frozen". That asked whether the engine SERVES the exact value. The
// question that decides it is whether the exact value can be COMPUTED from what is already published, and
// it can: `expectedDivergence.volatility` and `expectedDivergence.horizonPeriods` are published verbatim
// and unrounded, and they also appear in `proof.inputs`, so v = sigma^2 * T is recoverable exactly.
// Verified against the live service: volatility 0.0123456789 and horizonPeriods 7 both come back
// unrounded, giving v = 0.0010669105125133366.
//
// NOT `totalVariance`. That field is rounded to 6dp, and rebuilding v from it is lossier than the
// quadrature error this whole exercise is about: at sigma = 0.0123456789, T = 7 it shifts the answer by
// 1.12e-6 percentage points, roughly eight times the 1.4191e-7 pp quadrature envelope.
//
// THE ARITHMETIC. IL(r) = 2*sqrt(r)/(1+r) - 1, which is sech(X/2) - 1 for r = e^X. Under the martingale
// lognormal the engine assumes, X ~ N(-v/2, v), and E[sech(X/2)] = exp(-v/8), the same value as E[sqrt(r)].
// Measured against an independent fine midpoint rule at v = 0.5, 1, 5, 20, 50, 100 and 200: agreement to
// 1.3e-13 or better everywhere, so this is the exact expectation and the engine's 401-point trapezoid is
// the approximation. Its truncation error peaks at 1.4191e-7 percentage points at v = 1.1255.
//
// FAIL CLOSED. The served figure is rounded to 4dp. On most of the domain the exact value rounds to the
// same four decimals and a proof would agree with the response digit for digit. On a small part it does
// not, and there `agrees` is false: nothing here ever asserts a digit it cannot back. A caller wiring a
// proof must attach it only when `agrees` is true, and disclose otherwise.
const round4 = (x) => Math.round(x * 1e4) / 1e4;

// The measured worst-case gap between the engine's 401-point quadrature and this closed form, in
// percentage points, over v in (0, 20] sampled at 40,000 points and over [1e-8, 1e4] log-spaced at
// 200,001 points. Recorded rather than derived: it is an empirical maximum of a truncation error, and a
// number nobody measured is exactly what this project keeps finding wrong in its own work.
export const QUADRATURE_ENVELOPE_PCT = 1.4191207675651185e-7;

// v = sigma^2 * T, exactly, from unrounded published fields. Returns null rather than a guess.
export function totalVarianceFromPublished(volatility, horizonPeriods) {
  const s = Number(volatility);
  const t = Number(horizonPeriods);
  if (!Number.isFinite(s) || !Number.isFinite(t) || s <= 0 || t <= 0) return null;
  const v = s * s * t;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// The exact expectation as a percentage, on the same sign convention the engine uses (negative = loss).
// expm1 rather than exp(x) - 1 because for the small v that dominates real requests the subtraction loses
// most of the significant digits: at v = 0.001 the answer is -1.25e-4, where exp(x) - 1 keeps about 12
// digits and expm1 keeps all of them.
export function exactExpectedIlPct(volatility, horizonPeriods) {
  const v = totalVarianceFromPublished(volatility, horizonPeriods);
  if (v == null) return null;
  return Math.expm1(-v / 8) * 100;
}

// Compare the exact value against what a response served. One way: it can refuse, and it never edits.
//
// `conc` is the concentration factor. The engine multiplies the full-range expectation by it and reverts
// to the full-range figure when that would pass -100%, so this only claims agreement in the full-range
// case (conc == 1). Anything else is out of scope for the closed form and returns agrees false with a
// reason, rather than silently comparing two different quantities.
export function checkAgreesWithServed(expectedDivergence) {
  const ed = expectedDivergence || {};
  const v = totalVarianceFromPublished(ed.volatility, ed.horizonPeriods);
  if (v == null) {
    return { agrees: false, why: 'volatility and horizonPeriods are not both published as finite positives', v: null };
  }
  const served = Number(ed.expectedIlPct);
  if (!Number.isFinite(served)) {
    return { agrees: false, why: 'expectedIlPct is not a finite number in the response', v };
  }
  const conc = ed.concentrationFactor == null ? 1 : Number(ed.concentrationFactor);
  if (Number.isFinite(conc) && conc !== 1) {
    return {
      agrees: false, v,
      why: `concentrationFactor is ${conc}, so the served figure is an amplified or reverted expectation, `
        + 'not the full-range closed form this compares against',
    };
  }
  const exactPct = Math.expm1(-v / 8) * 100;
  const exact4 = round4(exactPct);
  const agrees = exact4 === served;
  // TWO different gaps, kept apart on purpose. `gapVsServedPct` compares the exact value against a figure
  // the engine already rounded to 4dp, so it is dominated by the display grid (up to 5e-5 pp) and says
  // almost nothing about the quadrature. `gapVsQuadraturePct` is the one the envelope bounds. Collapsing
  // them is a mistake this project has already shipped once, in a proof guard that was measuring display
  // rounding and therefore measured nothing below a dollar.
  const DISPLAY_HALF_STEP_PCT = 0.5e-4;
  return {
    agrees,
    v,
    exactPct,
    exactRounded4: exact4,
    servedPct: served,
    gapVsServedPct: Math.abs(exactPct - served),
    maxGapVsServedPct: DISPLAY_HALF_STEP_PCT + QUADRATURE_ENVELOPE_PCT,
    displayHalfStepPct: DISPLAY_HALF_STEP_PCT,
    envelopePct: QUADRATURE_ENVELOPE_PCT,
    why: agrees
      ? 'the exact closed form rounds to the same four decimals the response served'
      : `the exact closed form rounds to ${exact4} but the response served ${served}: the served figure is a `
        + '401-point trapezoid of the same integral and this v sits within its truncation envelope of a '
        + 'rounding boundary, so the last printed digit is not certifiable',
  };
}
