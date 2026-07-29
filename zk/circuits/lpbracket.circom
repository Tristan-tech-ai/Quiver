pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// A BISECTION RESULT CERTIFIED BY ITS BRACKET, not by replaying the bisection.
//
// lp-risk's `feeVsDivergence.breakevenVolatility` is the per-period volatility at which expected
// divergence exactly eats the horizon's fees. The engine finds it by bisecting 200 times on the total
// variance v, evaluating a 401-point numerical quadrature at every step — measured at 163,608 calls
// to exp and 82,016 to sqrt for one served answer. That was read as "unprovable", and read that way
// it is: no circuit replays 200 iterations of a quadrature.
//
// But a root does not have to be RECOMPUTED to be certified. It has to be LOCATED. Bisection returns
// the midpoint of a bracket, and a bracket is a closed-form object:
//
//     g(v) = E[IL](v) + f          the function being rooted (f = horizon fees as a fraction)
//     g(lo) > 0 >= g(hi)           the endpoints straddle
//     lo < v* < hi,  2v* = lo + hi the returned root is the midpoint
//     hi - lo <= w                 and the bracket is narrow
//
// Every line of that is an inequality over published integers. The 200 iterations are the SEARCH; the
// bracket is the CERTIFICATE, and the certificate is two evaluations of g wide, not two hundred.
//
// WORKING IN L-FORM, as `divergence.circom` does. L = E[IL] + 1 lies in (0, 1] where E[IL] lies in
// (-1, 0], and the field has no sign. So g(v) > 0 becomes L̂ + f̂ > S, and g(v) <= 0 becomes
// L̂ + f̂ <= S. Two comparisons, no division, no root, no series.
//
// THE SQUARE ROOT, AGAIN ON THE SQUARED QUANTITY. The engine publishes σ* = √(v*/T), not v* itself.
// A circuit does not take roots, so σ̂ arrives as a witness and is pinned by
//
//     σ̂² · T = v̂* · S
//
// exactly the move that let `divergence.circom` carry √r and that let `liquidation.circom` clear a
// division through three factors of SCALE. An integer square root is not a wall in a circuit; it is a
// statement written on the other side of the equals sign, and the rounded BigInt root belongs to the
// WITNESS GENERATOR, off-circuit, where it is seven lines of Newton.
//
// WHAT THIS DOES NOT PROVE, and it is the larger half.
//   1. It does not prove eLo and eHi are the true expectations. They are the quadrature, they arrive
//      as public inputs, and a caller who feeds two wrong numbers that happen to straddle gets a
//      valid proof of a false breakeven. That gap is the whole remaining problem and it is stated in
//      the public signals so no reader can miss which numbers were assumed.
//   2. It does not prove E[IL] is monotone in v. Monotonicity is what makes the straddled root
//      UNIQUE, and it is a property of the function, established by sweep (zero non-decreasing steps
//      over 20,001 log-spaced v in [1e-8, 1e4]) and not by this circuit. `eHi <= eLo` below is a
//      local order check on the two endpoints, nothing more.
//   3. It does not prove the fee arithmetic, the concentration factor, or the verdict string.
template LpBracket(SCALE, NB_V, NB_L, NB_SIG, NB_T, NB_BOUND, TOL_SIG) {
    signal input feeHat;    // horizon fees as a fraction of capital, × SCALE, in (0, S)
    signal input loHat;     // bracket low end,  total variance v × SCALE
    signal input hiHat;     // bracket high end, total variance v × SCALE
    signal input vStarHat;  // the returned root, v* × SCALE
    signal input eLoHat;    // L = E[IL](lo) + 1, × SCALE — A PUBLIC INPUT, NOT PROVEN HERE
    signal input eHiHat;    // L = E[IL](hi) + 1, × SCALE — A PUBLIC INPUT, NOT PROVEN HERE
    signal input sigHat;    // the served breakevenVolatility σ* × SCALE
    signal input horizonT;  // horizonPeriods, an integer count of periods
    signal input widthHat;  // the bracket width this proof is held to

    signal output midResidual;   // 2v* − lo − hi, the midpoint's slack
    signal output widthSlack;    // w − (hi − lo), how much of the width bound went unused
    signal output sigResidual;   // σ̂²·T − v̂*·S, the root's slack
    signal output sigTolerance;  // the bound σ's residual was held to

    // ---- Range discipline. Every input is bounded before it is used in a comparison, because a
    //      LessThan on an input wider than its declared bit count is not a comparison at all.
    component bV1 = Num2Bits(NB_V);   bV1.in <== loHat;
    component bV2 = Num2Bits(NB_V);   bV2.in <== hiHat;
    component bV3 = Num2Bits(NB_V);   bV3.in <== vStarHat;
    component bV4 = Num2Bits(NB_V);   bV4.in <== widthHat;
    component bL1 = Num2Bits(NB_L);   bL1.in <== eLoHat;
    component bL2 = Num2Bits(NB_L);   bL2.in <== eHiHat;
    component bL3 = Num2Bits(NB_L);   bL3.in <== feeHat;
    component bS  = Num2Bits(NB_SIG); bS.in  <== sigHat;
    component bT  = Num2Bits(NB_T);   bT.in  <== horizonT;

    // ---- Domains. A breakeven exists only where these hold, and where they do not the engine
    //      returns null rather than a number, so the circuit must refuse rather than certify.
    // 0 < f < S: fees at or above 100% of capital can never be caught by a loss bounded at 100%.
    component fPos = IsZero(); fPos.in <== feeHat; fPos.out === 0;
    component fLt  = LessThan(NB_L); fLt.in[0] <== feeHat; fLt.in[1] <== SCALE; fLt.out === 1;
    // 0 < L <= S at both endpoints: E[IL] ∈ (−100%, 0], the bound the service's own check asserts.
    component lo0 = IsZero(); lo0.in <== eLoHat; lo0.out === 0;
    component hi0 = IsZero(); hi0.in <== eHiHat; hi0.out === 0;
    component lLe = LessEqThan(NB_L); lLe.in[0] <== eLoHat; lLe.in[1] <== SCALE; lLe.out === 1;
    component hLe = LessEqThan(NB_L); hLe.in[0] <== eHiHat; hLe.in[1] <== SCALE; hLe.out === 1;
    // A horizon of zero periods has no variance and no breakeven.
    component t0 = IsZero(); t0.in <== horizonT; t0.out === 0;

    // ---- The bracket is a bracket: lo strictly below hi.
    component ord = LessThan(NB_V); ord.in[0] <== loHat; ord.in[1] <== hiHat; ord.out === 1;

    // ---- THE STRADDLE. This is the certificate.
    //   g(lo) > 0   <=>   L̂(lo) + f̂ >  S
    //   g(hi) <= 0  <=>   L̂(hi) + f̂ <= S
    // One extra bit on the comparison width, because the sum of two NB_L values needs it.
    component sLo = LessThan(NB_L + 2);
    sLo.in[0] <== SCALE;
    sLo.in[1] <== eLoHat + feeHat;
    sLo.out === 1;

    component sHi = LessEqThan(NB_L + 2);
    sHi.in[0] <== eHiHat + feeHat;
    sHi.in[1] <== SCALE;
    sHi.out === 1;

    // ---- Local order of the two endpoint values. E[IL] decreasing in v means L decreasing, so the
    //      high end of the bracket must not report a HIGHER value than the low end. This is not
    //      monotonicity of the function; see note 2 in the header.
    component eOrd = LessEqThan(NB_L); eOrd.in[0] <== eHiHat; eOrd.in[1] <== eLoHat; eOrd.out === 1;

    // ---- The returned root is the bracket's midpoint, to one grid step.
    //      2v* − lo − hi ∈ {−1, 0, 1}, checked by shifting it into [0, 2].
    signal mid; mid <== 2 * vStarHat - loHat - hiHat;
    midResidual <== mid;
    component bMid = Num2Bits(2);
    bMid.in <== mid + 1;
    component midOk = LessEqThan(2);
    midOk.in[0] <== mid + 1;
    midOk.in[1] <== 2;
    midOk.out === 1;

    // ---- The bracket is narrow: hi − lo <= w. Publishing the unused slack rather than a bare
    //      pass, so a reader who is told the width held also learns by how much.
    widthSlack <== widthHat - (hiHat - loHat);
    component bW = Num2Bits(NB_V);
    bW.in <== widthSlack;

    // ---- THE ROOT, on the squared quantity: σ̂² · T = v̂* · S.
    signal sq;      sq <== sigHat * sigHat;
    signal sqT;     sqT <== sq * horizonT;
    signal Rs;      Rs <== sqT - vStarHat * SCALE;
    sigResidual <== Rs;

    // σ̂ = round(σ·S) = σS + e with |e| <= 1/2, so σ̂² = σ²S² + 2σSe + e², and |2σSe| <= σ̂. That error
    // is multiplied by T. v̂*·S sits within S/2 of v*·S². So |Rs| <= (σ̂ + 1/4)·T + S/2, and because the
    // published convention here is 2|R| <= TOLERANCE — the same convention divergence.circom uses, and
    // the reason its TOL_ID reads 4 rather than 2 — the tolerance is TWICE that:
    //
    //     TOL = 2·(σ̂ + 1)·T + 2·S
    //
    // The first draft of this line omitted the factor of two and would have been exceeded by about
    // 2.0 on every honest witness, which is the residual shape this project has learned to read as a
    // scale error rather than a broken identity. The bound is a function of σ̂ and T, both signals of
    // this same statement, so widening it changes the breakeven being proven about.
    sigTolerance <== 2 * (sigHat + 1) * horizonT + TOL_SIG * SCALE;

    signal shifted;
    shifted <== 2 * Rs + sigTolerance;

    component bR = Num2Bits(NB_BOUND);
    bR.in <== shifted;

    component within = LessEqThan(NB_BOUND);
    within.in[0] <== shifted;
    within.in[1] <== 2 * sigTolerance;
    within.out === 1;
}

// SCALE     = 1e9   the shared grid
// NB_V      = 46    total variance up to 2^46/1e9 ≈ 70,368 — past where E[IL] is −100% to 1e-12 (v ≈ 209)
// NB_L      = 30    L <= 1e9 < 2^30, and f < 1e9 likewise
// NB_SIG    = 44    σ·1e9 up to 2^44 ≈ 1.76e13, i.e. σ ≈ 17,592 per period
// NB_T      = 24    horizons up to 16,777,215 periods
// NB_BOUND  = 120   σ̂² is under 2^88 and ·T under 2^112, so the shifted residual needs 113 bits at the
//                   declared ceilings; a wrapped negative needs 254 and is rejected
// TOL_SIG   = 2     the 2·S term above; the sweep reports how much of the bound the worst case uses
component main {public [feeHat, loHat, hiHat, vStarHat, eLoHat, eHiHat, sigHat, horizonT, widthHat]} =
    LpBracket(1000000000, 46, 30, 44, 24, 120, 2);
