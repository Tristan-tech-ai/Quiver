pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Fixed-point restatement of Quiver's treasury concentration identity.
//
// The engine computes the Herfindahl index over USD shares:
//
//     total = Σ vᵢ ,   wᵢ = vᵢ / total ,   H = Σ wᵢ²
//
// This circuit does NOT prove the division that produces the weights. It proves
// the identity the weights satisfy once they exist, with every quantity an
// integer scaled by SCALE:
//
//     H·S² = Σ ŵᵢ²        =>        Ĥ·S = Σ ŵᵢ²
//
// giving the integer residual
//
//     R = Ĥ·S − Σ ŵᵢ²
//
// The weights are inputs rather than derived, and that bounds what this proves:
// it says the published concentration figure is the correct Herfindahl index OF
// THE PUBLISHED SHARES. It does not say the shares were read correctly from a
// real book. Nothing in a circuit can say that, and Phase D is where that lives.
//
// WHERE THE RESIDUAL COMES FROM, corrected by measurement.
// The first draft of this comment counted two rounding sources and derived
// |R| ≲ 1.5·S. That was wrong, and gateB3-1 said so: the worst of 4,000 real
// books used a quarter of a 4·S bound, i.e. |R| ≤ 0.5·S exactly.
//
// The reason is that Σŵᵢ² is computed FROM the snapped weights, so weight
// rounding does not enter the residual at all — it changes which book is being
// described, not how well the identity holds for it. The only source left is
// rounding Σŵᵢ²/S onto the grid to get Ĥ, and that is bounded by half a grid
// step by definition. So the bound is S, not 4·S, and the proven statement is
//
//     2·|R|  <=  TOL_MULT · S        with TOL_MULT = 1
//
// with TOL_MULT a compile-time constant a prover cannot touch. At TOL_MULT = 1
// this says something worth saying: Ĥ is the CORRECTLY ROUNDED Herfindahl index
// of the published shares, not merely a number near it. A bound four times wider
// than anything observed would have been chosen for comfort, and the sweep would
// have passed without testing it.
//
// PADDING. A book with fewer than N assets pads with ŵ = 0, which contributes
// nothing to either sum, so one circuit serves every book up to N assets.

template Concentration(SCALE, N, NB_W, NB_H, NB_R, TOL_MULT) {
    signal input wHat[N];   // per-asset USD share * SCALE, zero-padded
    signal input hHat;      // Herfindahl index * SCALE

    signal output residual;     // R, so a verifier sees the slack actually used
    signal output tolerance;    // the bound R was held to, likewise visible
    signal output weightSlack;  // |Σŵ − S| + N, published so grid drift is not hidden

    // ---- Range discipline --------------------------------------------------
    // Without this a prover could hand in a field element near p that behaves as
    // a negative share, making a concentrated book look diversified.
    component rW[N];
    for (var i = 0; i < N; i++) {
        rW[i] = Num2Bits(NB_W);
        rW[i].in <== wHat[i];
    }

    // No per-share comparator against SCALE, and that is a saving rather than an omission. Num2Bits
    // above forces every share non-negative, and the sum constraint below pins Σŵ to within N of S,
    // so each individual share is already at most S + N: a share cannot exceed a book it is summed
    // into. Eight LessEqThan components were doing that work a second time, at roughly 500 Plonk
    // constraints, which is a third of this circuit spent re-deriving something the sum already says.

    component rH = Num2Bits(NB_H);
    rH.in <== hHat;

    // H <= 1 always, by Cauchy-Schwarz given Σŵ = S and ŵ >= 0. Asserted rather
    // than assumed, because it is one comparator and it is half of the bound the
    // engine publishes as `1/n <= HHI <= 1`.
    component hProper = LessEqThan(NB_H);
    hProper.in[0] <== hHat;
    hProper.in[1] <== SCALE;
    hProper.out === 1;

    // A zero index would mean an empty book, which the engine refuses to price.
    component hNonZero = IsZero();
    hNonZero.in <== hHat;
    hNonZero.out === 0;

    // ---- Shares sum to the whole book, within grid rounding -----------------
    // Each ŵ can round by half a grid step, so N shares can drift by N/2 in total.
    // The allowance is N, which is loose by a factor of two on purpose: tightening
    // it would reject honest books to save nothing, since the residual bound below
    // is what actually constrains the answer.
    signal partialSum[N + 1];
    partialSum[0] <== 0;
    for (var i = 0; i < N; i++) {
        partialSum[i + 1] <== partialSum[i] + wHat[i];
    }

    signal sumShift;
    sumShift <== partialSum[N] - SCALE + N;      // lands in [0, 2N] when honest

    component rSum = Num2Bits(8);            // sumShift lives in [0, 2N]; 30 bits was 22 wasted
    rSum.in <== sumShift;

    component sumWithin = LessEqThan(8);
    sumWithin.in[0] <== sumShift;
    sumWithin.in[1] <== 2 * N;
    sumWithin.out === 1;

    weightSlack <== sumShift;

    // ---- The identity, as an integer residual ------------------------------
    signal sq[N];
    signal acc[N + 1];
    acc[0] <== 0;
    for (var i = 0; i < N; i++) {
        sq[i] <== wHat[i] * wHat[i];
        acc[i + 1] <== acc[i] + sq[i];
    }

    signal R;
    R <== hHat * SCALE - acc[N];
    residual <== R;

    // ---- 2*|R| <= TOL_MULT * S ---------------------------------------------
    tolerance <== TOL_MULT * SCALE;

    // The field has no order, so bound the shifted value instead. Num2Bits pins
    // it to a genuine small non-negative integer: a negative R large enough to
    // wrap becomes ~p and blows the bit decomposition.
    signal shifted;
    shifted <== 2 * R + TOL_MULT * SCALE;

    component rR = Num2Bits(NB_R);
    rR.in <== shifted;

    component within = LessEqThan(NB_R);
    within.in[0] <== shifted;
    within.in[1] <== 2 * TOL_MULT * SCALE;
    within.out === 1;
}

// SCALE    = 1e9   fixed-point resolution, the same grid every Quiver circuit uses
// N        = 8     assets per book; a stablecoin treasury with nine issuers is not a book we price
// NB_W     = 30   a share is <= 1e9 < 2^30; the sum-shift check gets its own width below
// NB_H     = 30    the index is likewise <= 1e9
// NB_R     = 40    2·TOL = 8e9 needs 34 bits. A NEGATIVE R wraps to ~p and needs 254, so any width
//                  between those two rejects it; 40 leaves margin at both ends. This was 100, which
//                  cost ~230 Plonk constraints to buy nothing, and 230 was the difference between a
//                  2048-point evaluation domain and a 1024-point one.
// TOL_MULT = 1     1·S. Measured, not derived: gateB3-1 puts the worst of 4,000 real books at 0.998
//                  of this bound, so it is tight rather than generous, which is what makes it evidence
component main {public [wHat, hHat]} =
    Concentration(1000000000, 8, 30, 30, 40, 1);
