pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

// ADVERSARIAL PROBE CIRCUIT — the shape that is neither of the two the investigator compared.
//
// They built (a) one WIDE circuit that proves N legs AND takes the argmin inside, and (b) N SEPARATE
// per-leg proofs with the argmin taken on chain. (a) hit a ceiling; (b) needs N proofs and N workers.
//
// This is (c): ONE proof over N legs, with the argmin moved OUT — exactly their per-leg insight
// applied to the batched circuit instead of to a single leg. Publishing (d_i, ref_i) for every leg
// lets a contract cross-multiply the minimum outside, so the whole ranking apparatus disappears from
// the circuit: no one-hot selector, no dStar/refStar, no N cross-products, no NB_X decompositions.
//
// And the room that buys is spent on the bit widths the investigator said three legs "could not
// afford": NB_M 80, NB_Q 60, NB_P 60, NB_TOL 92 — full parity with liquidation.circom.
//
// LiqLeg is copied verbatim from circuits/portfoliogate.circom. Nothing in the arithmetic is new here;
// the only change is what is NOT in the circuit.

template LiqLeg(SCALE, NB_M, NB_Q, NB_P, NB_MMR, NB_TOL) {
    signal input mHat;
    signal input qHat;
    signal input p0Hat;
    signal input s;
    signal input mmrHat;
    signal input pLiqHat;

    signal output residual;
    signal output tolerance;

    component rM   = Num2Bits(NB_M);   rM.in   <== mHat;
    component rQ   = Num2Bits(NB_Q);   rQ.in   <== qHat;
    component rP0  = Num2Bits(NB_P);   rP0.in  <== p0Hat;
    component rP   = Num2Bits(NB_P);   rP.in   <== pLiqHat;
    component rMMR = Num2Bits(NB_MMR); rMMR.in <== mmrHat;

    (s - 1) * (s + 1) === 0;

    component mmrProper = LessThan(NB_MMR);
    mmrProper.in[0] <== mmrHat;
    mmrProper.in[1] <== SCALE;
    mmrProper.out === 1;

    component qNonZero = IsZero();
    qNonZero.in <== qHat;
    qNonZero.out === 0;

    signal dP;   dP   <== pLiqHat - p0Hat;
    signal sq;   sq   <== s * qHat;
    signal term; term <== sq * dP;
    signal lhs;  lhs  <== mHat * SCALE * SCALE + term * SCALE;
    signal qP;   qP   <== qHat * pLiqHat;
    signal rhs;  rhs  <== qP * mmrHat;
    signal R;    R    <== lhs - rhs;
    residual <== R;

    signal tol;  tol  <== qHat * (SCALE + mmrHat);
    tolerance <== tol;

    signal shifted; shifted <== 2 * R + tol;
    component loSide = Num2Bits(NB_TOL); loSide.in <== shifted;
    component hiSide = Num2Bits(NB_TOL); hiSide.in <== 2 * tol - shifted;
}

// ── the book, batched, with the minimum left outside ───────────────────────────────────────────────
template PortfolioBatch(N, SCALE, NB_M, NB_Q, NB_P, NB_MMR, NB_TOL) {
    signal input mHat[N];
    signal input qHat[N];
    signal input p0Hat[N];
    signal input s[N];
    signal input mmrHat[N];
    signal input pLiqHat[N];
    signal input refHat[N];

    signal residual[N];
    signal tolerance[N];
    signal output dOut[N];        // adverse-distance numerator, PUBLISHED so the min is takeable outside

    component leg[N];
    for (var i = 0; i < N; i++) {
        leg[i] = LiqLeg(SCALE, NB_M, NB_Q, NB_P, NB_MMR, NB_TOL);
        leg[i].mHat    <== mHat[i];
        leg[i].qHat    <== qHat[i];
        leg[i].p0Hat   <== p0Hat[i];
        leg[i].s       <== s[i];
        leg[i].mmrHat  <== mmrHat[i];
        leg[i].pLiqHat <== pLiqHat[i];
        residual[i]  <== leg[i].residual;
        tolerance[i] <== leg[i].tolerance;
    }

    // 1 <= refHat <= 2^NB_P, in one component. refHat = 0 would make every ratio 0/0.
    component rRef[N];
    for (var i = 0; i < N; i++) {
        rRef[i] = Num2Bits(NB_P);
        rRef[i].in <== refHat[i] - 1;
    }

    // Adverse distance, pinned non-negative — the same liveness refusal as the wide circuit: a leg
    // already past its liquidation price cannot be encoded, so it cannot enter a ranking.
    component rD[N];
    for (var i = 0; i < N; i++) {
        dOut[i] <== s[i] * (refHat[i] - pLiqHat[i]);
        rD[i] = Num2Bits(NB_P);
        rD[i].in <== dOut[i];
    }
}

// NB_TOL = 92   DERIVED: tol = qHat*(SCALE+mmrHat) < 2^60 * 2^31 = 2^91, so 2*tol < 2^92.
component main {public [mHat, qHat, p0Hat, s, mmrHat, pLiqHat, refHat]} =
    PortfolioBatch(7, 1000000000, 80, 60, 60, 30, 92);
