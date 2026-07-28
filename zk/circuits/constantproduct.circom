pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Fixed-point restatement of Quiver's constant-product execution benchmark.
//
// exec-verify prices what an honest AMM fill WOULD have been, so a caller can
// tell the unavoidable cost of their own trade apart from value taken off them
// by a sandwich or a stale quote. Given pre-trade reserves x, y, an input dx and
// a fee fraction f:
//
//     inEff     = dx·(1 − f)
//     honestOut = y − x·y / (x + inEff)
//
// The circuit does not prove that division. It proves the invariant the division
// solves, which is the same statement with nothing to divide:
//
//     (x + inEff)·(y − honestOut) = x·y
//
// Scaled by SCALE the factors of S cancel exactly on both sides, which is the
// reason this circuit is cheaper than it looks:
//
//     (x̂ + în)·(ŷ − ô) = x̂·ŷ        R = (x̂ + în)·(ŷ − ô) − x̂·ŷ
//
// The fee is a second, separate statement, because inEff is itself a product:
//
//     în·S = dx̂·(S − f̂)             Rf = în·S − dx̂·(S − f̂)
//
// ── WHAT THIS PROOF DOES NOT SAY, and it matters more here than elsewhere ──
// The reserves are an INPUT. This proves the benchmark is correct arithmetic
// about the pool state it was handed; it says nothing about whether that state
// is the pool's real state, or the right block, or the state before an attacker
// front-ran the trade. The engine's own note says the same thing in English:
// "Benchmark uses the SUPPLIED pre-trade reserves." A proof here raises the
// arithmetic from re-runnable to succinct. It does not touch the input problem,
// which is Phase D, and any wording that suggests otherwise is a lie with a
// verifier attached.

template ConstantProduct(SCALE, NB_AMT, NB_FEE, NB_BOUND, NB_FEEBOUND, TOL_MULT) {
    signal input xHat;    // pre-trade reserve of the input token  * SCALE
    signal input yHat;    // pre-trade reserve of the output token * SCALE
    signal input dxHat;   // trade size in input units             * SCALE
    signal input fHat;    // fee as a fraction                     * SCALE
    signal input inHat;   // dx·(1−f)                              * SCALE
    signal input outHat;  // honestOut                             * SCALE

    signal output residual;      // R, the invariant's slack
    signal output feeResidual;   // Rf, the effective-input slack
    signal output tolerance;     // the bound R was held to
    signal output feeTolerance;  // the bound Rf was held to

    // ---- Range discipline --------------------------------------------------
    component rX  = Num2Bits(NB_AMT); rX.in  <== xHat;
    component rY  = Num2Bits(NB_AMT); rY.in  <== yHat;
    component rDx = Num2Bits(NB_AMT); rDx.in <== dxHat;
    component rIn = Num2Bits(NB_AMT); rIn.in <== inHat;
    component rO  = Num2Bits(NB_AMT); rO.in  <== outHat;
    component rF  = Num2Bits(NB_FEE); rF.in  <== fHat;

    // A pool with no reserves has no price, and a trade of nothing has no fill.
    component xNonZero = IsZero(); xNonZero.in <== xHat;  xNonZero.out === 0;
    component yNonZero = IsZero(); yNonZero.in <== yHat;  yNonZero.out === 0;
    component dNonZero = IsZero(); dNonZero.in <== dxHat; dNonZero.out === 0;

    // A fee is a fraction. Without this, f > 1 makes inEff negative and the
    // invariant can be satisfied by a fill that never could have happened.
    component fProper = LessThan(NB_FEE);
    fProper.in[0] <== fHat;
    fProper.in[1] <== SCALE;
    fProper.out === 1;

    // NO separate comparator for "the pool cannot pay out more than it holds", and
    // none for "effective input cannot exceed gross input". Both were real
    // constraints being asserted a second time, at about 126 R1CS between them.
    //
    // The payout bound falls out of two range checks that already exist: outHat is
    // pinned non-negative just above, and (yHat − outHat) is pinned non-negative
    // below, so 0 <= out <= y with no LessThan anywhere. BOTH are needed — dropping
    // the check on outHat alone would let a negative field element through, because
    // y − (p − k) wraps to y + k and looks perfectly small.
    //
    // The input bound falls out of the fee identity: in = dx·(S − f)/S with f < S
    // already forces in <= dx, and f < S is asserted immediately above.

    // ---- The fee: în·S = dx̂·(S − f̂) ----------------------------------------
    signal netFee;  netFee <== SCALE - fHat;
    signal grossIn; grossIn <== dxHat * netFee;

    signal Rf;  Rf <== inHat * SCALE - grossIn;
    feeResidual <== Rf;

    // în rounds by half a grid step over a factor of S, so |Rf| <= S/2. The bound
    // is a constant here rather than input-derived, because nothing a prover
    // supplies can widen it.
    feeTolerance <== SCALE;

    signal feeShift;
    feeShift <== 2 * Rf + SCALE;

    // 2S is under 2^31, so this window is 34 bits and not the 66 the invariant below
    // needs. A negative Rf still wraps to ~p and still fails the decomposition, which
    // is the only property the width has to preserve.
    component rFee = Num2Bits(NB_FEEBOUND);
    rFee.in <== feeShift;

    component feeWithin = LessEqThan(NB_FEEBOUND);
    feeWithin.in[0] <== feeShift;
    feeWithin.in[1] <== 2 * SCALE;
    feeWithin.out === 1;

    // ---- The invariant: (x̂ + în)(ŷ − ô) = x̂·ŷ -------------------------------
    signal xIn;    xIn    <== xHat + inHat;
    signal yOut;   yOut   <== yHat - outHat;

    // Load-bearing, per the note above: this is what makes out <= y true without a comparator.
    component rYOut = Num2Bits(NB_AMT);
    rYOut.in <== yOut;
    signal lhs;    lhs    <== xIn * yOut;
    signal rhs;    rhs    <== xHat * yHat;

    signal R;  R <== lhs - rhs;
    residual <== R;

    // ô rounding moves the product by up to (x̂ + în)/2, and în rounding by up to
    // (ŷ − ô)/2, so the slack scales with the POOL rather than with a constant.
    // A fixed budget would be far too tight on a large pool and meaningless on a
    // small one — the same defect the engine already fixed by making its own
    // check relative rather than absolute.
    tolerance <== TOL_MULT * (xIn + yOut);

    signal shifted;
    shifted <== 2 * R + TOL_MULT * (xIn + yOut);

    component rR = Num2Bits(NB_BOUND);
    rR.in <== shifted;

    component within = LessEqThan(NB_BOUND);
    within.in[0] <== shifted;
    within.in[1] <== 2 * TOL_MULT * (xIn + yOut);
    within.out === 1;
}

// SCALE    = 1e9   the shared grid
// NB_AMT   = 62    reserves up to 2^62/1e9 ~ 4.6e9 tokens, past any pool worth benchmarking
// NB_FEE   = 30    a fee fraction is <= 1e9
// NB_BOUND = 66    2·TOL stays under 2^65; a wrapped negative needs 254 bits and is rejected
// NB_FEEBOUND=34   the fee residual window only ever holds 2S, so it does not pay for the invariant width
// TOL_MULT = 1     provisional, tightened from what gateB5-1 measures against the real engine
component main {public [xHat, yHat, dxHat, fHat, inHat, outHat]} =
    ConstantProduct(1000000000, 62, 30, 66, 34, 1);
