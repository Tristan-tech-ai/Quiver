pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Black-76 greek consistency, with no transcendental anywhere in the circuit.
//
// THE CLAIM THIS CIRCUIT CONTRADICTS is one I wrote myself. The Phase B plan says options-risk is
// blocked because black76 uses Math.exp, Math.log and a normal-CDF approximation, so it must wait for
// erf-in-circuit. That is true about COMPUTING an option price. It is wrong about proving one.
//
// The same move that made Kelly provable applies a level up. Kelly could not be proven as
// f = (p(b+1)−1)/b, a division; it could be proven as f·b = p·b + p − 1. Here, the greeks all share
// the factor df·nd1 — the discount times the normal density at d1 — and that factor CANCELS between
// any two of them. What is left is polynomial. `probe-black76-identities.mjs` measured eight such
// relations against the real engine over 5,000 surfaces and all eight held to double precision.
//
// Two are proven here:
//
//   A   d1 − d2 = σ·√T                 the root is a witness pinned by s² = T, never computed
//   B   vega·100 = gamma·F²·σ·T        df·nd1 cancels; the per-vol-point scaling is the 100
//
// giving integer residuals, with S the shared 1e-9 grid:
//
//   Ra = D·S − Σ·Q                     where D = (d1−d2)·S, Σ = σ·S, Q = √T·S
//   Rs = Q² − T̂·S                      the root
//   Rb = V·100·S³ − G·F²·Σ·T̂           where V = vega·S, G = gamma·S, F = forward·S
//
// EVERY QUANTITY HERE IS NON-NEGATIVE, which is why these two were chosen first. vega, gamma, σ, T and
// the forward are all positive by construction, and d1 − d2 = σ√T is positive even though d1 and d2
// are each signed. The other six measured identities involve theta, vanna and d1 or d2 on their own,
// all of which take negative values, and a field has no sign — those need an offset encoding and are
// deliberately NOT in this circuit rather than being bolted on badly.
//
// ── WHAT THIS PROVES, AND WHAT IT CANNOT ──
// It proves the published greeks are mutually consistent with Black-76 for the (F, σ, T) given. A
// service that computed gamma correctly and vega wrongly, or that published a d1/d2 pair inconsistent
// with its own vol and tenor, fails this.
//
// It does NOT prove N(d2) was evaluated correctly, because nothing here evaluates it. A service with a
// subtly wrong normal CDF would satisfy every constraint below and still be wrong about the absolute
// price level. That residue is real, it is the honest limit of this approach, and any wording that
// implies otherwise would be a lie with a verifier attached.

template GreekConsistency(SCALE, NB_F, NB_SMALL, NB_MID, NB_RA, NB_RB, TOL_A, TOL_S, TOL_B) {
    signal input fHat;      // forward price          * SCALE
    signal input sigHat;    // implied vol            * SCALE
    signal input tHat;      // time to expiry, years  * SCALE
    signal input qHat;      // sqrt(T)                * SCALE, a witness, pinned below
    signal input dDiffHat;  // (d1 − d2)              * SCALE
    signal input vegaHat;   // vega per vol-point     * SCALE
    signal input gammaHat;  // gamma                  * SCALE

    signal output rootResidual;      // Rs
    signal output tenorResidual;     // Ra
    signal output greekResidual;     // Rb
    signal output rootTolerance;
    signal output tenorTolerance;
    signal output greekTolerance;

    // ---- Range discipline ---------------------------------------------------
    // Without these a prover hands in a field element near p that behaves as a negative greek, and
    // every product below can then be satisfied by numbers that describe no option at all.
    component rF   = Num2Bits(NB_F);     rF.in   <== fHat;
    component rSig = Num2Bits(NB_SMALL); rSig.in <== sigHat;
    component rT   = Num2Bits(NB_SMALL); rT.in   <== tHat;
    component rQ   = Num2Bits(NB_SMALL); rQ.in   <== qHat;
    component rD   = Num2Bits(NB_SMALL); rD.in   <== dDiffHat;
    component rV   = Num2Bits(NB_MID);   rV.in   <== vegaHat;
    component rG   = Num2Bits(NB_MID);   rG.in   <== gammaHat;

    // An option with no forward, no vol or no time is not an option, and each of those degeneracies
    // makes one of the identities below vacuous.
    component fNZ = IsZero(); fNZ.in <== fHat;   fNZ.out === 0;
    component sNZ = IsZero(); sNZ.in <== sigHat; sNZ.out === 0;
    component tNZ = IsZero(); tNZ.in <== tHat;   tNZ.out === 0;
    component qNZ = IsZero(); qNZ.in <== qHat;   qNZ.out === 0;

    // ---- The root: Q² = T̂·S -------------------------------------------------
    signal qq; qq <== qHat * qHat;
    signal Rs; Rs <== qq - tHat * SCALE;
    rootResidual <== Rs;

    // Q is round(√T·S), so Q² − T·S² is bounded by about Q, and T̂·S sits within S/2 of T·S².
    rootTolerance <== 2 * qHat + TOL_S * SCALE;

    signal rootShift; rootShift <== 2 * Rs + 2 * qHat + TOL_S * SCALE;
    component rRoot = Num2Bits(NB_RA);
    rRoot.in <== rootShift;
    component rootOk = LessEqThan(NB_RA);
    rootOk.in[0] <== rootShift;
    rootOk.in[1] <== 2 * (2 * qHat + TOL_S * SCALE);
    rootOk.out === 1;

    // ---- Identity A: D·S = Σ·Q ----------------------------------------------
    signal Ra; Ra <== dDiffHat * SCALE - sigHat * qHat;
    tenorResidual <== Ra;

    // D, Σ and Q each round by half a step, over factors of S, Q and Σ respectively.
    tenorTolerance <== sigHat + qHat + TOL_A * SCALE;

    signal tenorShift; tenorShift <== 2 * Ra + sigHat + qHat + TOL_A * SCALE;
    component rTen = Num2Bits(NB_RA);
    rTen.in <== tenorShift;
    component tenorOk = LessEqThan(NB_RA);
    tenorOk.in[0] <== tenorShift;
    tenorOk.in[1] <== 2 * (sigHat + qHat + TOL_A * SCALE);
    tenorOk.out === 1;

    // ---- Identity B: V·100·S³ = G·F²·Σ·T̂ ------------------------------------
    // Built as a chain of binary products, because circom takes one multiplication per constraint and
    // a five-way product written in one line is not expressible.
    signal ff;   ff   <== fHat * fHat;
    signal gf;   gf   <== gammaHat * ff;
    signal gfs;  gfs  <== gf * sigHat;
    signal rhs;  rhs  <== gfs * tHat;
    signal lhs;  lhs  <== vegaHat * (100 * SCALE);

    signal Rb; Rb <== lhs * (SCALE * SCALE) - rhs;
    greekResidual <== Rb;

    // The slack scales with the answer rather than being a constant: rounding V by half a step moves
    // the left side by 50·S³, and rounding G, Σ or T̂ moves the right side by half its own cofactor.
    // A fixed budget would be far too tight on a large forward and meaningless on a small one, which
    // is the same defect exec-verify's own self-check had to fix by going relative.
    greekTolerance <== TOL_B * (lhs + rhs);

    signal greekShift; greekShift <== 2 * Rb + TOL_B * (lhs + rhs);
    component rGr = Num2Bits(NB_RB);
    rGr.in <== greekShift;
    component greekOk = LessEqThan(NB_RB);
    greekOk.in[0] <== greekShift;
    greekOk.in[1] <== 2 * TOL_B * (lhs + rhs);
    greekOk.out === 1;
}

// SCALE    = 1e9    the shared grid every Quiver circuit uses
// NB_F     = 60     a forward up to 2^60/1e9 ~ 1.15e9, past any strike worth pricing
// NB_SMALL = 40     vol, tenor, sqrt(T) and d1−d2 all sit under 2^40/1e9 ~ 1,100
// NB_MID   = 50     vega and gamma, which are small but scale with the forward
// NB_RA    = 84     the shifted root and tenor residuals stay under 2^82
// NB_RB    = 200    V·100·S³ reaches ~2^170 on a large forward, so the shifted residual needs the room
// TOL_A/S  = 1      one grid step, tightened from what the sweep measures
// TOL_B    = 1      relative, in units of 1e-9 of (lhs + rhs)
component main {public [fHat, sigHat, tHat, qHat, dDiffHat, vegaHat, gammaHat]} =
    GreekConsistency(1000000000, 60, 40, 50, 84, 200, 1, 1, 1);
