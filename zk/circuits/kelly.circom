pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Fixed-point restatement of the Quiver discrete-Kelly sizing identity.
//
// The engine works in IEEE-754 doubles and computes
//
//     f* = (p*(b + 1) - 1) / b
//
// This circuit does NOT prove that division. It proves the cross-multiplied
// restatement, where every quantity is an integer scaled by SCALE:
//
//     f*·b = p·b + p - 1        =>        f̂·b̂ = p̂·b̂ + S·p̂ - S²
//
// giving the integer residual
//
//     R = f̂·b̂ - p̂·b̂ - S·p̂ + S²
//
// R is exactly S² times the gap between the two sides measured in bankroll
// fractions, so it is a quantity a reader can interpret rather than a number
// that only the circuit understands.
//
// The tolerance is derived from the inputs, not fixed. R is linear in f̂ with
// slope b̂, so rounding the Kelly fraction onto the 1e-9 grid moves R by at most
// half that. Hence the proven statement:
//
//     2*|R|  <=  b̂
//
// Because b̂ is a public signal of the same statement, a prover cannot widen the
// bound without changing the bet being proven about.

template KellyIdentity(SCALE, NB_P, NB_B, NB_F, NB_R) {
    signal input pHat;   // win probability * SCALE, a proper fraction
    signal input bHat;   // net win/loss odds * SCALE, strictly positive
    signal input fHat;   // full-Kelly fraction * SCALE, positive edge only

    signal output residual;   // R, so a verifier sees the slack actually used
    signal output tolerance;  // the bound R was held to, likewise visible

    // ---- Range discipline --------------------------------------------------
    // Every input is pinned to a non-negative integer below an explicit bound.
    // Without this a prover could hand in a field element near p that behaves as
    // a negative number, and the residual check below would pass on garbage.
    component rP = Num2Bits(NB_P); rP.in <== pHat;
    component rB = Num2Bits(NB_B); rB.in <== bHat;
    component rF = Num2Bits(NB_F); rF.in <== fHat;

    // A probability is a proper fraction: 0 < p < 1.
    component pProper = LessThan(NB_P);
    pProper.in[0] <== pHat;
    pProper.in[1] <== SCALE;
    pProper.out === 1;

    component pNonZero = IsZero();
    pNonZero.in <== pHat;
    pNonZero.out === 0;

    // Odds must be strictly positive: at b = 0 the engine's divisor vanishes and
    // the identity degenerates, which would otherwise let any fraction whatsoever
    // be proven as the Kelly bet.
    component bNonZero = IsZero();
    bNonZero.in <== bHat;
    bNonZero.out === 0;

    // Positive edge only. The engine itself refuses to size a bet when f* <= 0,
    // so proving about that region would be proving about something the service
    // never sold. A zero fraction is the boundary and is excluded with it.
    component fNonZero = IsZero();
    fNonZero.in <== fHat;
    fNonZero.out === 0;

    // ---- The identity, as an integer residual ------------------------------
    signal fb;  fb  <== fHat * bHat;
    signal pb;  pb  <== pHat * bHat;

    signal R;   R   <== fb - pb - SCALE * pHat + SCALE * SCALE;
    residual <== R;

    // ---- 2*|R| <= b̂ --------------------------------------------------------
    tolerance <== bHat;

    // The field has no order, so bound the shifted value instead: 2R + b̂ must
    // land in [0, 2*b̂]. Num2Bits pins it to a genuine small non-negative integer
    // (a negative R large enough to wrap becomes ~p and blows the bit
    // decomposition), and the comparator closes the upper end.
    signal shifted;
    shifted <== 2 * R + bHat;

    component rR = Num2Bits(NB_R);
    rR.in <== shifted;

    component within = LessEqThan(NB_R);
    within.in[0] <== shifted;
    within.in[1] <== 2 * bHat;
    within.out === 1;
}

// SCALE = 1e9   fixed-point resolution of every scaled input
// NB_P  = 30    probability scaled < 2^30, and separately forced < 1e9
// NB_B  = 45    odds  < 2^45 / 1e9 ~ 35,000 : far past any real book
// NB_F  = 45    fraction likewise; Kelly can exceed 1 on long odds, so it is not capped at SCALE
// NB_R  = 100   |2R| < 2^92 under the above and 2*b̂ < 2^46, so 100 bits cannot wrap
component main {public [pHat, bHat, fHat]} =
    KellyIdentity(1000000000, 30, 45, 45, 100);
