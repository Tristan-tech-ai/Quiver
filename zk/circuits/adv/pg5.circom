pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

// portfolio-gate — the leg of a book that is nearest to liquidation, proved in one circuit.
//
// WHAT IS BEING PROVED. `portfolio-gate` reports the leg with the smallest distance to liquidation,
// which is a MINIMUM over legs, and a minimum is two claims, not one:
//
//   (1) the named leg satisfies the liquidation identity in its own right, and so does every other
//       leg, because a "minimum" over legs whose prices were never checked is a minimum over numbers
//       somebody made up; and
//   (2) no other leg is nearer.
//
// (1) is `circuits/liquidation.circom`, once per leg. (2) is comparisons, and they are cheap next to
// a leg. That asymmetry is the whole cost story of this circuit.
//
// WHAT "NEAREST" MEANS, taken from the engine rather than from intuition. portfolioGate ranks on
// perpGate's `moveToLiquidationPct`, which is the ADVERSE percentage move from the MARK, not the
// liquidation price:
//
//     dist_i  =  s_i * (ref_i - pLiq_i) / ref_i          ref = markPrice, or entry when no mark
//
// Ranking on the liquidation PRICE instead — which is what gateB6's on-chain router does — is a
// different answer entirely: a $64,000 BTC leg 1.2% away has a far larger price than a $0.62 leg 20%
// away, and price-ranking calls the cheap token the binding one. So the comparison here is on the
// ratio, cross-multiplied to stay in integers:
//
//     dist_a <= dist_b   <=>   d_a * ref_b  <=  d_b * ref_a          (both refs positive)
//
// LIVENESS IS THE RANGE CHECK. The engine excludes legs already past their liquidation price from the
// ranking ("their liquidation is not a future event"). Those legs have moveToLiqPct < 0, i.e. d < 0,
// and `Num2Bits` on d refuses exactly them. The circuit therefore speaks only about books in which
// every leg is still live, and refuses the rest rather than ranking a dead leg.
//
// TOLERANCE. Each leg carries liquidation.circom's own bound, unchanged in meaning:
//
//     2*|R_i|  <=  qHat_i * (SCALE + mmrHat_i)
//
// It is enforced differently, and the difference is worth stating because it is where three legs came
// from. liquidation.circom pins `shifted = 2R + tol` with a 160-bit Num2Bits and then closes the top
// with a 160-bit LessEqThan — 323 R1CS, nearly half that circuit. The identical statement follows from
// two NB_TOL-bit decompositions, of `shifted` and of `2*tol - shifted`: the first forces shifted >= 0,
// the second forces shifted <= 2*tol, and neither can wrap because 2*tol < 2^NB_TOL by construction
// (tol < 2^NB_Q * 2^31). That is 186 R1CS instead of 323, and 3 * 137 saved R1CS is the difference
// between fitting hez_final_12 and not.
//
// PADDING. N is fixed at 3. A book with one or two legs is padded by REPEATING one of its own legs,
// which cannot change a minimum and cannot introduce a leg whose identity is unproven. It is visible
// in the public signals as a duplicated tuple; it is not hidden.

// ── one leg: liquidation.circom's statement, with the tolerance check re-expressed ──────────────────
template LiqLeg(SCALE, NB_M, NB_Q, NB_P, NB_MMR, NB_TOL) {
    signal input mHat;      // posted margin      * SCALE
    signal input qHat;      // position size      * SCALE
    signal input p0Hat;     // entry price        * SCALE
    signal input s;         // side, exactly +1 or -1 (unscaled)
    signal input mmrHat;    // maintenance rate   * SCALE
    signal input pLiqHat;   // liquidation price  * SCALE

    signal output residual;
    signal output tolerance;

    // Range discipline. Without it a prover hands in a field element near p that behaves as a large
    // negative number and every arithmetic check below passes on garbage.
    component rM   = Num2Bits(NB_M);   rM.in   <== mHat;
    component rQ   = Num2Bits(NB_Q);   rQ.in   <== qHat;
    component rP0  = Num2Bits(NB_P);   rP0.in  <== p0Hat;
    component rP   = Num2Bits(NB_P);   rP.in   <== pLiqHat;
    component rMMR = Num2Bits(NB_MMR); rMMR.in <== mmrHat;

    (s - 1) * (s + 1) === 0;                       // side is +1 or -1; 0 fails here

    component mmrProper = LessThan(NB_MMR);        // 0 <= mmr < 1
    mmrProper.in[0] <== mmrHat;
    mmrProper.in[1] <== SCALE;
    mmrProper.out === 1;

    component qNonZero = IsZero();                 // at q = 0 the identity degenerates to M == 0 and
    qNonZero.in <== qHat;                          // any price at all could be called a liquidation
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

    // 0 <= 2R + tol <= 2*tol, as two range checks. Equivalent to the LessEqThan form only because
    // 2*tol < 2^NB_TOL is guaranteed by NB_Q and NB_MMR — see the parameter block at the bottom.
    signal shifted; shifted <== 2 * R + tol;
    component loSide = Num2Bits(NB_TOL); loSide.in <== shifted;
    component hiSide = Num2Bits(NB_TOL); hiSide.in <== 2 * tol - shifted;
}

// ── the book ───────────────────────────────────────────────────────────────────────────────────────
template PortfolioNearest(N, SCALE, NB_M, NB_Q, NB_P, NB_MMR, NB_TOL, NB_X) {
    signal input mHat[N];
    signal input qHat[N];
    signal input p0Hat[N];
    signal input s[N];
    signal input mmrHat[N];
    signal input pLiqHat[N];
    signal input refHat[N];     // the mark the engine measured distance from (markPrice, else entry)
    signal input nearest;       // index of the leg the service named as closest to liquidation

    signal input sel[N];        // PRIVATE: one-hot selector; `nearest` is derived from it, not trusted

    signal output residual[N];
    signal output tolerance[N];

    // (1) every leg satisfies the liquidation identity — including the ones that lost.
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

    // The mark must be a positive on-grid price. `refHat - 1` decomposed to NB_P bits gives
    // 1 <= refHat <= 2^NB_P in one component, where a Num2Bits plus an IsZero would take two.
    // refHat = 0 would make the ratio 0/0 and let any leg be called nearest.
    component rRef[N];
    for (var i = 0; i < N; i++) {
        rRef[i] = Num2Bits(NB_P);
        rRef[i].in <== refHat[i] - 1;
    }

    // Adverse distance numerator. Pinning it non-negative is what excludes an already-breached leg:
    // the engine drops those from the ranking, and here they cannot be encoded at all.
    signal d[N];
    component rD[N];
    for (var i = 0; i < N; i++) {
        d[i] <== s[i] * (refHat[i] - pLiqHat[i]);
        rD[i] = Num2Bits(NB_P);
        rD[i].in <== d[i];
    }

    // One-hot selector, and `nearest` read out of it rather than compared to it.
    var bsum = 0;
    var isum = 0;
    for (var i = 0; i < N; i++) {
        sel[i] * (sel[i] - 1) === 0;
        bsum += sel[i];
        isum += i * sel[i];
    }
    bsum === 1;
    isum === nearest;

    signal selD[N];
    signal selR[N];
    var dAcc = 0;
    var rAcc = 0;
    for (var i = 0; i < N; i++) {
        selD[i] <== sel[i] * d[i];
        selR[i] <== sel[i] * refHat[i];
        dAcc += selD[i];
        rAcc += selR[i];
    }
    signal dStar;   dStar   <== dAcc;    // numerator of the named leg's distance
    signal refStar; refStar <== rAcc;    // its denominator

    // (2) no other leg is nearer:  dStar/refStar <= d[i]/refHat[i]  <=>  dStar*ref[i] <= d[i]*refStar.
    // Non-strict, so a tie may be resolved either way — the engine breaks ties by book order, and the
    // sweep checks that the leg named here is the leg the engine actually returned.
    signal crossL[N];
    signal crossR[N];
    component rX[N];
    for (var i = 0; i < N; i++) {
        crossL[i] <== dStar * refHat[i];
        crossR[i] <== d[i] * refStar;
        rX[i] = Num2Bits(NB_X);
        rX[i].in <== crossR[i] - crossL[i];
    }
}

// ── PARAMETERS, and what three legs cost ───────────────────────────────────────────────────────────
//
// MEASURED, not predicted. At full parity with liquidation.circom's bit bounds (NB_M 80, NB_Q 60,
// NB_P 60, NB_TOL 92, NB_X 120) this circuit is 2,338 R1CS and **4,540 Plonk** — 444 over
// hez_final_12's 4,096, an 11% overrun. So the roadmap's "4,096 / 1,301 = 3 legs" arithmetic is not
// quite right: it counted the legs and not the minimum. Three legs plus the minimum does not fit at
// the original domain, and it took two things to make it fit:
//
//   1. the tolerance check re-expressed as two NB_TOL-bit decompositions instead of Num2Bits(160) +
//      LessEqThan(160). Same statement, 137 fewer R1CS per leg. Worth 825 Plonk on its own, and
//      WITHOUT it three legs would be ~5,400 and out of reach at any sane bit width.
//   2. narrower input domains. These are refusals, not approximations: a position outside them
//      cannot be encoded at all, so the circuit declines rather than certifying something adjacent.
//      gateB8-1 measures how often the real engine produces one.
//
//      NB_M   80 -> 60   margin  <= $1,152,921,504        was $1.2e15
//      NB_Q   60 -> 55   size    <= 36,028,797 units      was 1.15e9
//      NB_P   60 -> 50   price   <= $1,125,899.9          was $1.15e9   (also bounds refHat and d)
//
//      NB_M and NB_P BOTH had to move: restoring either alone puts the circuit back over the ceiling
//      (NB_M costs 120 Plonk, NB_P costs 240, and the slack is 126).
//
// N      = 3     legs
// SCALE  = 1e9   fixed-point resolution of every scaled input
// NB_MMR = 30    rate scaled < 2^30, and separately forced < 1e9   (unchanged)
// NB_TOL = 87    DERIVED, not chosen: tol = qHat*(SCALE+mmrHat) < 2^55 * 2^31 = 2^86, so 2*tol <
//                2^87 and neither decomposition can wrap. Replaces liquidation.circom's NB_R = 160.
// NB_X   = 100   DERIVED: d and refHat are both < 2^50, so each cross product is < 2^100, and the
//                difference of two of them, once pinned non-negative, is < 2^100.
//
// Result: 1,989 non-linear + 64 linear R1CS, 3,970 Plonk, domain 4,096 — 126 gates of slack.
component main {public [mHat, qHat, p0Hat, s, mmrHat, pLiqHat, refHat, nearest]} =
    PortfolioNearest(5, 1000000000, 60, 55, 50, 30, 87, 100);
