pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Fixed-point restatement of Quiver's constant-product divergence identity.
//
// The engine computes, for a realized price ratio r = P1/P0 on a full-range V2
// position:
//
//     IL(r) = 2·√r / (1 + r) − 1
//
// which is the LP's value relative to simply holding the two tokens.
//
// A SQUARE ROOT IS NOT COMPUTED HERE, IT IS PROVEN. Circuits do not take roots.
// Instead ŝ arrives as a witness and the circuit forces ŝ² = r̂·S, which pins ŝ
// to √r on the grid, and a bit decomposition forces it non-negative so the other
// root cannot be substituted. That done, the identity cross-multiplies to a
// polynomial with no division left in it.
//
// Working with L = IL + 1 rather than IL itself, because L = 2√r/(1+r) lies in
// (0, 1] while IL is negative, and the field has no sign. L is also the more
// honest quantity to publish: it is the LP's value as a fraction of HODL, so
// L = 0.98 says "two percent behind holding" without a minus sign to misread.
//
//     L·(1 + r) = 2·√r        =>        L̂·(S + r̂) = 2·S·ŝ
//
// giving two integer residuals:
//
//     R  = L̂·(S + r̂) − 2·S·ŝ        the identity itself
//     Rs = ŝ² − r̂·S                 the root
//
// Both are published, because a reader who is told the identity holds and not
// how much slack it used has been told half of it.
//
// SCOPE. This proves the closed form for a price ratio it is handed. It says
// nothing about whether that ratio was observed, and nothing about the EXPECTED
// divergence figure the same service publishes, which rests on a numerical
// expectation rather than an identity. That one is not in this circuit and the
// paper should not imply otherwise.

template Divergence(SCALE, NB_R, NB_S, NB_L, NB_BOUND, TOL_ID, TOL_ROOT) {
    signal input rHat;   // price ratio P1/P0 * SCALE
    signal input sHat;   // sqrt(r) * SCALE, supplied and then forced
    signal input lHat;   // (IL + 1) * SCALE, the LP's value as a fraction of HODL

    signal output residual;      // R, the identity's slack
    signal output rootResidual;  // Rs, the root's slack
    signal output tolerance;     // the bound R was held to
    signal output rootTolerance; // the bound Rs was held to

    // ---- Range discipline --------------------------------------------------
    component rR = Num2Bits(NB_R); rR.in <== rHat;
    component rS = Num2Bits(NB_S); rS.in <== sHat;
    component rL = Num2Bits(NB_L); rL.in <== lHat;

    // A ratio of zero means the pair went to zero, where the identity degenerates
    // and the engine returns the −100% floor rather than a curve value.
    component rNonZero = IsZero(); rNonZero.in <== rHat; rNonZero.out === 0;
    component sNonZero = IsZero(); sNonZero.in <== sHat; sNonZero.out === 0;

    // L <= 1 always: an LP never beats HODL on a constant product, and equals it
    // only at r = 1. This is the inequality the whole service exists to quantify,
    // so it is asserted rather than left as a property of the arithmetic.
    component lProper = LessEqThan(NB_L);
    lProper.in[0] <== lHat;
    lProper.in[1] <== SCALE;
    lProper.out === 1;

    // ---- The root: ŝ² = r̂·S ------------------------------------------------
    signal ss;  ss <== sHat * sHat;
    signal Rs;  Rs <== ss - rHat * SCALE;
    rootResidual <== Rs;

    // ŝ is round(√r·S), so ŝ² − r·S² is bounded by about ŝ, and r̂·S sits within
    // S/2 of r·S². The bound is derived from ŝ, a signal of this same statement,
    // so widening it means changing the ratio being proven about.
    rootTolerance <== 2 * sHat + TOL_ROOT * SCALE;

    signal rootShift;
    rootShift <== 2 * Rs + 2 * sHat + TOL_ROOT * SCALE;

    component rRoot = Num2Bits(NB_BOUND);
    rRoot.in <== rootShift;

    component rootWithin = LessEqThan(NB_BOUND);
    rootWithin.in[0] <== rootShift;
    rootWithin.in[1] <== 2 * (2 * sHat + TOL_ROOT * SCALE);
    rootWithin.out === 1;

    // ---- The identity: L̂·(S + r̂) = 2·S·ŝ -----------------------------------
    signal onePlusR;  onePlusR <== SCALE + rHat;
    signal lhs;       lhs <== lHat * onePlusR;

    signal R;  R <== lhs - 2 * SCALE * sHat;
    residual <== R;

    // L̂ rounds by half a step over a factor of (S + r̂); ŝ and r̂ each contribute
    // their own half-step. TOL_ID·S covers the terms that do not scale with r̂.
    tolerance <== rHat + TOL_ID * SCALE;

    signal shifted;
    shifted <== 2 * R + rHat + TOL_ID * SCALE;

    component rIdent = Num2Bits(NB_BOUND);
    rIdent.in <== shifted;

    component within = LessEqThan(NB_BOUND);
    within.in[0] <== shifted;
    within.in[1] <== 2 * (rHat + TOL_ID * SCALE);
    within.out === 1;
}

// SCALE    = 1e9   the shared grid
// NB_R     = 44    ratio up to 2^44/1e9 ~ 17,500x, far past any pair worth pricing
// NB_S     = 38    sqrt of the above, times SCALE
// NB_L     = 30    L <= 1e9 < 2^30
// NB_BOUND = 72    the shifted residuals stay under 2^70; a wrapped negative needs 254 and is rejected
// TOL_ID   = 4     provisional, tightened from what gateB4-1 measures against the real engine
// TOL_ROOT = 1
component main {public [rHat, sHat, lHat]} =
    Divergence(1000000000, 44, 38, 30, 72, 4, 1);
