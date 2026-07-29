pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// portfolio-leg — ONE leg of a book, carrying the adverse distance the ranking is done on.
//
// WHY THIS EXISTS. `portfoliogate.circom` proves the whole minimum inside one circuit, which forces
// every leg into a single evaluation domain. A leg costs about 660 R1CS, so three legs plus the
// minimum is 2,053 R1CS / 3,970 Plonk and fills hez_final_12's 4,096-gate domain with 126 gates to
// spare. A fourth leg is 2,736 R1CS / 5,295 Plonk — MEASURED by asking snarkjs to set it up and
// reading the number out of its refusal — which needs domain 8,192 and a 2^13 ceremony file. The
// service's own tests exercise an eleven-leg book, and the service accepts an unbounded number of
// legs (there is no maxItems anywhere in it), so raising the ceremony one power buys one leg against
// a gap of eight and moves the wall rather than removing it.
//
// THE MINIMUM DOES NOT HAVE TO BE INSIDE THE CIRCUIT. portfolio-gate's claim is two claims, and the
// header of portfoliogate.circom says so plainly:
//
//   (1) every leg satisfies the liquidation identity in its own right, and
//   (2) no other leg is nearer.
//
// (1) is per-leg and independent. (2) is a comparison between numbers, and if each leg's proof
// PUBLISHES the two integers its distance is the ratio of, then (2) is arithmetic over public values
// that any verifier — including a contract — can redo without trusting anybody. That is what this
// circuit is for: it proves (1) for one leg and publishes (d, refHat) so that (2) can be taken
// outside. n legs is n independent proofs and a comparison, at no domain cost whatsoever.
//
// WHAT IS AND IS NOT GIVEN UP. Nothing about soundness. The wide circuit does not prove the book is
// COMPLETE either — its legs are public inputs, so a prover who omits the leg that is actually
// nearest gets a true statement about the legs it did submit, exactly as here. Book completeness is
// the input problem (an exchange-attested read), not a circuit-shape problem, and neither shape
// addresses it. What per-leg proving does cost is gas, measured in the gate rather than guessed.
//
// AND IT BUYS THE INPUT DOMAIN BACK. Three legs only fitted 4,096 gates after the bit bounds were
// narrowed — margin to $1.15e9, size to 3.6e7, price to $1.1e6 — and those narrowings are refusals:
// a position outside them cannot be encoded at all. One leg has room, so this circuit runs at FULL
// parity with liquidation.circom's original widths (NB_M 80, NB_Q 60, NB_P 60). The eleven-leg route
// is therefore not merely wider in legs, it is wider in every leg.

// ── the leg, plus the one thing the leg circuit never had: the mark ────────────────────────────────
template PortfolioLeg(SCALE, NB_M, NB_Q, NB_P, NB_MMR, NB_TOL) {
    signal input mHat;      // posted margin      * SCALE
    signal input qHat;      // position size      * SCALE
    signal input p0Hat;     // entry price        * SCALE
    signal input s;         // side, exactly +1 or -1 (unscaled)
    signal input mmrHat;    // maintenance rate   * SCALE
    signal input pLiqHat;   // liquidation price  * SCALE
    signal input refHat;    // the mark the engine measured distance FROM (markPrice, else entry)

    signal output residual;   // R, so a reader sees the slack actually used
    signal output tolerance;  // the bound R was held to
    signal output dOut;       // adverse-distance NUMERATOR — the number the ranking is done on

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

    // The liquidation identity, as an integer residual. Identical to liquidation.circom.
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

    // 0 <= 2R + tol <= 2*tol, as two NB_TOL-bit decompositions rather than Num2Bits(160) plus a
    // LessEqThan(160). Same statement, 137 fewer R1CS, and it cannot wrap because 2*tol < 2^NB_TOL by
    // construction — see the parameter block below.
    signal shifted; shifted <== 2 * R + tol;
    component loSide = Num2Bits(NB_TOL); loSide.in <== shifted;
    component hiSide = Num2Bits(NB_TOL); hiSide.in <== 2 * tol - shifted;

    // ── the mark, and the distance the ranking orders on ──────────────────────────────────────────
    //
    // refHat - 1 decomposed to NB_P bits gives 1 <= refHat <= 2^NB_P in ONE component where a
    // Num2Bits plus an IsZero would take two. refHat = 0 would make the distance ratio 0/0 and let
    // any leg at all be called nearest.
    component rRef = Num2Bits(NB_P);
    rRef.in <== refHat - 1;

    // dist = s * (ref - pLiq) / ref, the ADVERSE move from the mark — perpGate's
    // `moveToLiquidationPct`, which is what the engine ranks on. Ranking on the liquidation PRICE
    // instead is a different answer entirely: a $64,000 BTC leg 1.2% away has a far larger price than
    // a $0.62 leg 20% away, and price-ranking names the cheap token as the binding one. gateB6's
    // router did exactly that. This circuit publishes the numerator and the denominator separately so
    // the ratio comparison can be done exactly, in integers, by cross-multiplication.
    //
    // Pinning d non-negative is what excludes an already-breached leg. The engine drops legs past
    // their liquidation price from the ranking ("their liquidation is not a future event"); those have
    // d < 0 and Num2Bits refuses exactly them, so this circuit speaks only about live legs.
    signal d;   d <== s * (refHat - pLiqHat);
    component rD = Num2Bits(NB_P);
    rD.in <== d;
    dOut <== d;
}

// ── PARAMETERS ────────────────────────────────────────────────────────────────────────────────────
//
// FULL PARITY with liquidation.circom, which the three-leg circuit could not afford:
//
//   NB_M   = 80    margin      < 2^80 / 1e9 ~ 1.2e15      (portfoliogate had to cut this to 60)
//   NB_Q   = 60    size        < 2^60 / 1e9 ~ 1.15e9      (portfoliogate had to cut this to 55)
//   NB_P   = 60    prices      < 2^60 / 1e9 ~ 1.15e9      (portfoliogate had to cut this to 50)
//   NB_MMR = 30    rate scaled < 2^30, and separately forced < 1e9
//   NB_TOL = 92    DERIVED, not chosen: tol = qHat*(SCALE+mmrHat) < 2^60 * 2^31 = 2^91, so
//                  2*tol < 2^92 and neither decomposition can wrap.
//
// NB_P bounds refHat and d as well as the two prices, so the cross products a verifier forms are
// each below 2^120 and two of them subtract inside a uint256 without any possibility of overflow.
//
// Public signals: 7 public inputs + 3 outputs = 10.
component main {public [mHat, qHat, p0Hat, s, mmrHat, pLiqHat, refHat]} =
    PortfolioLeg(1000000000, 80, 60, 60, 30, 92);
