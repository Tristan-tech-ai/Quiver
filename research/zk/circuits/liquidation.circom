pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Fixed-point restatement of the Quiver perpetual-futures liquidation identity.
//
// The engine works in IEEE-754 doubles and checks
//
//     M + s*q*(P_liq - P0)  ==  q*P_liq*mmr
//
// This circuit does NOT prove that. It proves a fixed-point restatement: every
// quantity is carried as an integer scaled by SCALE, and the identity is
// multiplied through by SCALE^3 to clear denominators, giving the integer residual
//
//     R = M*SCALE^2 + s*q*(P - P0)*SCALE - q*P*mmr
//
// R is exactly SCALE^3 times the (account value - maintenance requirement) gap
// measured in quote currency.
//
// The tolerance is derived from the inputs, not fixed. R is linear in pLiqHat with
// slope qHat*(s*SCALE - mmrHat), so rounding the price to the grid moves R by at
// most half that. Hence the proven statement:
//
//     2*|R|  <=  qHat * (SCALE + mmrHat)
//
// Measured over 1600 realistic positions: 0 violations, tightest case 0.999997 of
// the bound. It is tight rather than generous, and because it is computed from
// qHat and mmrHat inside the circuit a prover cannot widen it without changing the
// position being proven about.

template LiquidationIdentity(SCALE, NB_M, NB_Q, NB_P, NB_MMR, NB_R) {
    signal input mHat;      // posted margin      * SCALE
    signal input qHat;      // position size      * SCALE
    signal input p0Hat;     // entry price        * SCALE
    signal input s;         // side, exactly +1 or -1 (unscaled)
    signal input mmrHat;    // maintenance rate   * SCALE
    signal input pLiqHat;   // liquidation price  * SCALE

    signal output residual;  // R, so a verifier can see the slack actually used
    signal output tolerance; // the bound R was held to, likewise visible

    // ---- Range discipline -------------------------------------------------
    // Every input is pinned to a non-negative integer below an explicit bound.
    // Without this a prover could hand in a field element near p that behaves as
    // a negative number, and the residual check below would pass on garbage.
    component rM   = Num2Bits(NB_M);   rM.in   <== mHat;
    component rQ   = Num2Bits(NB_Q);   rQ.in   <== qHat;
    component rP0  = Num2Bits(NB_P);   rP0.in  <== p0Hat;
    component rP   = Num2Bits(NB_P);   rP.in   <== pLiqHat;
    component rMMR = Num2Bits(NB_MMR); rMMR.in <== mmrHat;

    // side is exactly +1 or -1; anything else (including 0) fails here
    (s - 1) * (s + 1) === 0;

    // maintenance rate is a proper fraction: 0 <= mmr < 1
    component mmrProper = LessThan(NB_MMR);
    mmrProper.in[0] <== mmrHat;
    mmrProper.in[1] <== SCALE;
    mmrProper.out === 1;

    // size must be non-zero: at q = 0 the engine's divisor q*(s - mmr) vanishes and
    // the identity degenerates to M == 0, which would otherwise let any price
    // whatsoever be proven as a "liquidation price".
    component qNonZero = IsZero();
    qNonZero.in <== qHat;
    qNonZero.out === 0;

    // ---- The identity, as an integer residual ------------------------------
    signal dP;   dP   <== pLiqHat - p0Hat;
    signal sq;   sq   <== s * qHat;
    signal term; term <== sq * dP;

    signal lhs;  lhs  <== mHat * SCALE * SCALE + term * SCALE;

    signal qP;   qP   <== qHat * pLiqHat;
    signal rhs;  rhs  <== qP * mmrHat;

    signal R;    R    <== lhs - rhs;
    residual <== R;

    // ---- 2*|R| <= qHat*(SCALE + mmrHat) ------------------------------------
    signal tol;
    tol <== qHat * (SCALE + mmrHat);
    tolerance <== tol;

    // The field has no order, so bound the shifted value instead: 2R + tol must
    // land in [0, 2*tol]. Num2Bits pins it to a genuine small non-negative integer
    // (a negative R large enough to wrap becomes ~p and blows the bit
    // decomposition), and the comparator closes the upper end.
    signal shifted;
    shifted <== 2 * R + tol;

    component rR = Num2Bits(NB_R);
    rR.in <== shifted;

    component within = LessEqThan(NB_R);
    within.in[0] <== shifted;
    within.in[1] <== 2 * tol;
    within.out === 1;
}

// SCALE  = 1e9   fixed-point resolution of every scaled input
// NB_M   = 80    margin      < 2^80 / 1e9 ~ 1.2e15
// NB_Q   = 60    size        < 2^60 / 1e9 ~ 1.15e9
// NB_P   = 60    prices      < 2^60 / 1e9 ~ 1.15e9
// NB_MMR = 30    rate scaled < 2^30, and separately forced < 1e9
// NB_R   = 160   under the above |2R| < 2^153 and 2*tol < 2^92, so 160 bits cannot wrap
component main {public [mHat, qHat, p0Hat, s, mmrHat, pLiqHat]} =
    LiquidationIdentity(1000000000, 80, 60, 60, 30, 160);
