pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Put-call parity, the last two of the eight measured Black-76 identities.
//
//     F   C − P = df·(F − K)
//     G   Δcall − Δput = df
//
// These are the only two of the eight that reach the PRICE rather than the greeks. Every other
// identity in this family relates derivatives to each other and would be satisfied by a service whose
// price level was uniformly wrong.
//
// PARITY DOES NOT FIX THAT, AND THIS HEADER USED TO SAY IT DID. It claimed parity "ties a call to a put
// at the same strike, so a price that drifts on one side and not the other fails here". It cannot. In
// Black-76 the put is not an independent quotation: for ANY N with N(−x) = 1 − N(x) — which every
// tail-plus-branch implementation has, and which this repository's `ncdf` has by construction, returning
// `x <= 0 ? c : 1 - c` — the CDF cancels out of C − P = df·(F − K) algebraically. Two lines of algebra,
// and it was checked by hand. A whole book repriced with Abramowitz-Stegun 7.1.26, wrong by $0.004763 on
// a $2,688 call, produces a parity witness that VERIFIES.
//
// So parity is not a weak check on the price level. It is not a check on the price level at all. What it
// constrains is the DIFFERENCE C − P: both prices can be wrong by the same amount and satisfy it, and the
// absolute level rests on N(d2).
//
// The second sentence that was here is also gone: it said the residue "stays until erf is provable".
// `ncdf.circom` computes the CDF as of 30 July 2026, and the engine never computed `erf` in the first
// place, so the sentence named a blocker that did not exist. What is true is narrower: nothing in THIS
// circuit evaluates N(d2), so this circuit does not reach the absolute level.
//
// ── WHY THIS IS A SEPARATE CIRCUIT ──
// The other six take one option. These take two, a call and a put at one strike, plus the discount
// factor they share. That is a different witness shape, not a harder problem, and bolting a second
// option onto greekssigned would have made every caller carry a put they may not have.
//
// ── df, AND AN HONEST NOTE ABOUT IT ──
// df = e^{−rT} is transcendental and this circuit does NOT compute it. It arrives as a witness. So
// what is proven is conditional: GIVEN this discount factor, the call and put are priced against each
// other consistently. At r = 0, which is how crypto futures options are quoted and what the engine's
// callers pass, df = 1 exactly and the condition is vacuous — parity becomes C − P = F − K and there
// is nothing left to trust. Away from r = 0, a caller who cares must check df themselves.
//
// ── SIGNS ──
// F − K is negative for an in-the-money put, and C − P carries the same sign, which is the content of
// parity. Both arrive as magnitude plus a sign bit and the circuit forces the two signs EQUAL. A
// version that checked only magnitudes would accept a book where every call and put were swapped.

template Parity(SCALE, NB_V, NB_R, TOL) {
    signal input callHat;    // call price   * SCALE
    signal input putHat;     // put price    * SCALE
    signal input fHat;       // forward      * SCALE
    signal input kHat;       // strike       * SCALE
    signal input dfHat;      // e^{-rT}      * SCALE, a witness; see the header
    signal input cpDiffHat;  // |C − P|      * SCALE
    signal input fkDiffHat;  // |F − K|      * SCALE
    signal input diffSign;   // 0 when F > K, 1 when K > F; shared by both differences

    signal input dCallHat;   // call delta   * SCALE
    signal input dPutHat;    // |put delta|  * SCALE, always negative in Black-76 so the sign is fixed

    signal output priceResidual;
    signal output deltaResidual;
    signal output tolerance;

    // ---- Range discipline ---------------------------------------------------
    component rC  = Num2Bits(NB_V); rC.in  <== callHat;
    component rP  = Num2Bits(NB_V); rP.in  <== putHat;
    component rF  = Num2Bits(NB_V); rF.in  <== fHat;
    component rK  = Num2Bits(NB_V); rK.in  <== kHat;
    component rD  = Num2Bits(NB_V); rD.in  <== dfHat;
    component rCP = Num2Bits(NB_V); rCP.in <== cpDiffHat;
    component rFK = Num2Bits(NB_V); rFK.in <== fkDiffHat;
    component rDC = Num2Bits(NB_V); rDC.in <== dCallHat;
    component rDP = Num2Bits(NB_V); rDP.in <== dPutHat;

    diffSign * (diffSign - 1) === 0;

    // A discount factor is in (0, 1]. Above one it would be a discount that pays you, and at zero the
    // option is worthless and parity says nothing.
    component dfLe = LessEqThan(NB_V);
    dfLe.in[0] <== dfHat;
    dfLe.in[1] <== SCALE;
    dfLe.out === 1;
    component dfNZ = IsZero(); dfNZ.in <== dfHat; dfNZ.out === 0;

    // ---- The differences are the differences --------------------------------
    // Stated as an unsigned magnitude plus a shared sign, then reconstructed both ways round. Taking
    // the magnitudes on trust would let a prover pair |C−P| from one strike with |F−K| from another.
    signal cpSigned; cpSigned <== callHat - putHat;
    signal fkSigned; fkSigned <== fHat - kHat;

    // When diffSign = 0 the magnitude equals the signed value; when 1 it equals its negation. Written
    // as one linear relation rather than a branch, since a circuit has no branches.
    cpSigned + 2 * diffSign * cpDiffHat === cpDiffHat;
    fkSigned + 2 * diffSign * fkDiffHat === fkDiffHat;

    // ---- F: |C − P|·SCALE = df·|F − K| --------------------------------------
    signal fLhs; fLhs <== cpDiffHat * SCALE;
    signal fRhs; fRhs <== dfHat * fkDiffHat;
    signal rF_;  rF_  <== fLhs - fRhs;
    priceResidual <== rF_;

    // Both sides round by half a grid step over the other's magnitude, so the slack scales with the
    // strike rather than being a constant. A fixed budget is meaningless across a book that spans a
    // dollar option and a hundred-thousand-dollar one.
    tolerance <== TOL * (fkDiffHat + SCALE);

    signal fShift; fShift <== 2 * rF_ + TOL * (fkDiffHat + SCALE);
    component rFB = Num2Bits(NB_R); rFB.in <== fShift;
    component fOk = LessEqThan(NB_R);
    fOk.in[0] <== fShift;
    fOk.in[1] <== 2 * (TOL * (fkDiffHat + SCALE));
    fOk.out === 1;

    // ---- G: Δcall + |Δput| = df ---------------------------------------------
    // Δput is negative in Black-76, so Δcall − Δput = Δcall + |Δput|, and no sign bit is needed: the
    // sign is a fact about the model rather than something a prover may choose.
    signal gLhs; gLhs <== dCallHat + dPutHat;
    signal rG;   rG <== gLhs - dfHat;
    deltaResidual <== rG;

    // Three grid STEPS, which is the integer 3 and not 3*SCALE. Writing 3*SCALE allowed a delta error
    // of three whole units on a quantity that lives in [0, 1], so the bound was nine orders of
    // magnitude too wide and the sweep reported it using 0.0% of it. A bound nothing can violate is
    // not a bound. Each of the two deltas rounds by half a step and df by half, so three is right.
    signal gShift; gShift <== 2 * rG + 3;
    component rGB = Num2Bits(NB_R); rGB.in <== gShift;
    component gOk = LessEqThan(NB_R);
    gOk.in[0] <== gShift;
    gOk.in[1] <== 6;
    gOk.out === 1;
}

// SCALE = 1e9   the shared grid. Prices and strikes are large but not unbounded, and unlike the greeks
//               they do not vanish on the wings, so the per-value encoding greeksfp needed is not
//               needed here. A deep-OTM call price CAN go to zero, and the sweep reports how often.
// NB_V  = 60    values up to 2^60/1e9 ~ 1.15e9
// NB_R  = 128   the widest product is df·|F−K| at ~2^90, and the shifted residual clears it
// TOL   = 2     two grid steps, scaled by the strike. Tightened from what gateB7-4 measures.
component main {public [callHat, putHat, fHat, kHat, dfHat, cpDiffHat, fkDiffHat, diffSign, dCallHat, dPutHat]} =
    Parity(1000000000, 60, 128, 2);
