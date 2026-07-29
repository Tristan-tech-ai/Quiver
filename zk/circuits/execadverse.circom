pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// The HEADLINE of exec-verify, with a circuit signal.
//
// constantproduct.circom proves the benchmark: that honestOut is the fill a
// constant-product pool implied for the supplied state and size. That is the
// number a caller cannot compute for themselves, and it was the right thing to
// prove first. But it is NOT what the service leads with. The registered blurb
// leads with "how many bps a swap lost to adverse execution", and the response
// leads with `adverseExecutionBps`. A proof that stops at the benchmark leaves
// the sold number outside the statement, and the realized fill — the other half
// of that number — is not even a signal.
//
// This circuit closes that. It carries the whole benchmark forward unchanged and
// adds two statements about the trade:
//
//     shortfall = honestOut − realized                    EXACT, no tolerance
//     bps       = shortfall / honestOut · 10000           one rounded division
//
// The shortfall needs no tolerance at all, and that is not a technicality. Both
// terms are already on the shared grid, so the subtraction is exact in the field
// and `adverseValueOut` — the loss in output tokens, which is the figure a
// dispute is actually about — is certified to the last unit of the grid, with no
// allowance of any kind. Only the conversion to basis points has to round.
//
// Scaled by S, the bps identity clears its denominator:
//
//     b̂·ô = 10000·S·ŝ            Rb = b̂·ô − 10000·S·ŝ
//
// b̂ rounds by half a grid step over a factor of ô, so |Rb| <= ô/2. The bound is
// PROPORTIONAL TO THE FILL, like the invariant's and unlike a constant, for the
// reason the engine itself learned when it made its own self-check relative: a
// budget that does not scale with the quantity it guards is too tight on a small
// pool and vacuous on a large one.
//
// ── WHAT THIS PROOF DOES NOT SAY ────────────────────────────────────────────
// Everything constantproduct.circom disclaims, it disclaims too, and the
// disclaimer is the load-bearing part: the reserves are an INPUT. So is the
// realized fill. This proves the headline is correct ARITHMETIC about a pool
// state and a fill it was handed. It does not prove the pool state was real, or
// the right block, or the state before an attacker front-ran the trade; and it
// does not prove the caller's realized amount is the amount they received. What
// it removes is the last place the service's own arithmetic could be wrong
// without anyone noticing. The input problem is Phase D and is not touched here.
//
// It also does not prove the VERDICT, and does not need to. The engine's verdict
// is the predicate `bps > 5`, and b̂ is a public signal — anyone holding the
// proof can evaluate that threshold themselves, on a number the proof pins. A
// comparator in here would spend constraints re-deciding something already
// decidable from the public output.

template ExecAdverse(SCALE, NB_AMT, NB_FEE, NB_BOUND, NB_FEEBOUND, NB_BPS, BPS_OFF, TOL_MULT) {
    signal input xHat;         // pre-trade reserve of the input token  * SCALE
    signal input yHat;         // pre-trade reserve of the output token * SCALE
    signal input dxHat;        // trade size in input units             * SCALE
    signal input fHat;         // fee as a fraction                     * SCALE
    signal input inHat;        // dx·(1−f)                              * SCALE
    signal input outHat;       // honestOut                             * SCALE
    signal input realizedHat;  // amountOutRealized                     * SCALE
    signal input bpsHat;       // adverseExecutionBps                   * SCALE  (signed)

    signal output residual;      // R,  the invariant's slack
    signal output feeResidual;   // Rf, the effective-input slack
    signal output bpsResidual;   // Rb, the headline's slack
    signal output tolerance;     // the bound R was held to
    signal output feeTolerance;  // the bound Rf was held to
    signal output bpsTolerance;  // the bound Rb was held to
    signal output shortfall;     // honestOut − realized, EXACT (signed)

    // ---- Range discipline --------------------------------------------------
    component rX  = Num2Bits(NB_AMT); rX.in  <== xHat;
    component rY  = Num2Bits(NB_AMT); rY.in  <== yHat;
    component rDx = Num2Bits(NB_AMT); rDx.in <== dxHat;
    component rIn = Num2Bits(NB_AMT); rIn.in <== inHat;
    component rO  = Num2Bits(NB_AMT); rO.in  <== outHat;
    component rRz = Num2Bits(NB_AMT); rRz.in <== realizedHat;
    component rF  = Num2Bits(NB_FEE); rF.in  <== fHat;

    // A pool with no reserves has no price, a trade of nothing has no fill, and a
    // fill of nothing has no execution quality to report.
    component xNonZero = IsZero(); xNonZero.in <== xHat;        xNonZero.out === 0;
    component yNonZero = IsZero(); yNonZero.in <== yHat;        yNonZero.out === 0;
    component dNonZero = IsZero(); dNonZero.in <== dxHat;       dNonZero.out === 0;
    component zNonZero = IsZero(); zNonZero.in <== realizedHat; zNonZero.out === 0;

    // A fee is a fraction. Without this, f > 1 makes inEff negative and the
    // invariant can be satisfied by a fill that never could have happened.
    component fProper = LessThan(NB_FEE);
    fProper.in[0] <== fHat;
    fProper.in[1] <== SCALE;
    fProper.out === 1;

    // ---- The fee: în·S = dx̂·(S − f̂) ----------------------------------------
    signal netFee;  netFee <== SCALE - fHat;
    signal grossIn; grossIn <== dxHat * netFee;

    signal Rf;  Rf <== inHat * SCALE - grossIn;
    feeResidual <== Rf;
    feeTolerance <== SCALE;

    signal feeShift;
    feeShift <== 2 * Rf + SCALE;

    component rFee = Num2Bits(NB_FEEBOUND);
    rFee.in <== feeShift;

    component feeWithin = LessEqThan(NB_FEEBOUND);
    feeWithin.in[0] <== feeShift;
    feeWithin.in[1] <== 2 * SCALE;
    feeWithin.out === 1;

    // ---- The invariant: (x̂ + în)(ŷ − ô) = x̂·ŷ -------------------------------
    signal xIn;    xIn    <== xHat + inHat;
    signal yOut;   yOut   <== yHat - outHat;

    // Load-bearing: with outHat pinned non-negative above, this is what makes
    // 0 <= out <= y true without a comparator anywhere.
    component rYOut = Num2Bits(NB_AMT);
    rYOut.in <== yOut;

    signal lhs;    lhs    <== xIn * yOut;
    signal rhs;    rhs    <== xHat * yHat;

    signal R;  R <== lhs - rhs;
    residual <== R;
    tolerance <== TOL_MULT * (xIn + yOut);

    signal shifted;
    shifted <== 2 * R + TOL_MULT * (xIn + yOut);

    component rR = Num2Bits(NB_BOUND);
    rR.in <== shifted;

    component within = LessEqThan(NB_BOUND);
    within.in[0] <== shifted;
    within.in[1] <== 2 * TOL_MULT * (xIn + yOut);
    within.out === 1;

    // ---- The shortfall: ŝ = ô − ẑ, exactly ---------------------------------
    // NO range check and NO window. Both terms are already pinned to NB_AMT bits
    // above, so |ŝ| < 2^NB_AMT follows and a signed guard here would be a third
    // copy of a bound that already holds. A negative ŝ is a fill BETTER than the
    // benchmark, which is a real and reportable outcome, not an error.
    signal sHat;  sHat <== outHat - realizedHat;
    shortfall <== sHat;

    // ---- The headline: b̂·ô = 10000·S·ŝ -------------------------------------
    // b̂ is signed and prover-supplied, so unlike ŝ it does need its magnitude
    // pinned: without this a prover could offer a b̂ so large that the product
    // aliases modulo the field and the window below becomes meaningless.
    // BPS_OFF is 2^NB_BPS written out, because the offset has to be a constant the
    // parameter list can carry and a shift expression is not one.
    signal bpsShift;
    bpsShift <== bpsHat + BPS_OFF;
    component rBps = Num2Bits(NB_BPS + 1);
    rBps.in <== bpsShift;

    signal bpsProd;  bpsProd <== bpsHat * outHat;
    signal Rb;       Rb <== bpsProd - 10000 * SCALE * sHat;
    bpsResidual <== Rb;
    bpsTolerance <== outHat;

    signal bpsW;
    bpsW <== 2 * Rb + outHat;

    component rBpsB = Num2Bits(NB_BOUND);
    rBpsB.in <== bpsW;

    component bpsWithin = LessEqThan(NB_BOUND);
    bpsWithin.in[0] <== bpsW;
    bpsWithin.in[1] <== 2 * outHat;
    bpsWithin.out === 1;
}

// SCALE     = 1e9   the shared grid
// NB_AMT    = 62    reserves and fills up to 2^62/1e9 ~ 4.6e9 tokens
// NB_FEE    = 30    a fee fraction is <= 1e9
// NB_BOUND  = 66    holds 2·TOL for the invariant; also holds 2·ô for the bps window with room
// NB_FEEBOUND= 34   the fee residual window only ever holds 2S
// NB_BPS    = 50    |bps| <= 2^50/1e9 ~ 1.13e6 bps, i.e. a fill up to 113x off the benchmark.
//                   Past that the circuit REFUSES rather than wrapping; gate B5-4 measures how
//                   often a realistic fill gets anywhere near it.
// BPS_OFF   = 2^50  the same number written out, for the signed range check
// TOL_MULT  = 1     as measured against the real engine by gate B5-1
component main {public [xHat, yHat, dxHat, fHat, inHat, outHat, realizedHat, bpsHat]} =
    ExecAdverse(1000000000, 62, 30, 66, 34, 50, 1125899906842624, 1);
