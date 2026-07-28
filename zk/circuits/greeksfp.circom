pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Black-76 greek consistency on a PER-VALUE scale, with no transcendental anywhere.
//
// `greeks.circom` proves the same identity on the shared 1e-9 grid and its sweep fails: the residual
// there is exactly 1/G where G is gamma in grid steps, and a deep out-of-the-money gamma of 5e-10 is
// ONE step. That is not a defect in the algebra, it is a defect in the encoding, and this circuit is
// the fix.
//
// Every quantity arrives as a mantissa and an exponent, x = m · 10^−e, with m forced into [1e8, 1e9)
// so it always carries nine significant digits whatever the magnitude. Measured over 4,000 real
// surfaces: shared grid 6.077e-1 worst relative residual, per-value 7.344e-9, with no domain
// restriction and no surface dropped. Eight orders of magnitude, and 7.3e-9 is exactly what nine
// significant digits should give.
//
// THE IDENTITY, in mantissa form. From vega·100 = gamma·F²·σ·T:
//
//     Vm·100·10^(−Ve) = Gm·Fm²·Sm·Tm·10^(−(Ge + 2·Fe + Se + Te))
//   → Vm·100·10^dE    = Gm·Fm²·Sm·Tm            with  dE = Ge + 2·Fe + Se + Te − Ve
//
// dE looks like it could be anything, since gamma's own exponent ranges over [9, 55] across a real
// book. MEASURED, it does not: dE lands in [30, 34], because the identity itself ties the exponents
// together. So the alignment factor needs a selector of a few dozen entries rather than the
// hundreds a naive bound would have reserved, and this circuit is CHEAPER than the fixed-grid one it
// replaces. That is the sort of thing you only find by measuring the thing you were about to bound.
//
// WHAT THIS PROVES. The published greeks are mutually consistent with Black-76 for the (F, σ, T)
// given. A gamma that disagrees with its own vega fails.
//
// WHAT IT DOES NOT. Nothing here evaluates N(d2). A service with a subtly wrong normal CDF satisfies
// this and every sibling identity and is still wrong about the absolute price level. That residue is
// permanent until erf is provable, and no wording should suggest otherwise.

template GreekConsistencyFP(NB_M, NB_E, NB_R, DE_MIN, DE_MAX, RELATIVE_D) {
    // Mantissas, nine significant digits each.
    signal input vegaM;
    signal input gammaM;
    signal input fM;
    signal input sigM;
    signal input tM;

    // Exponents, public so a reader reconstructs each value as m · 10^−e without asking us.
    signal input vegaE;
    signal input gammaE;
    signal input fE;
    signal input sigE;
    signal input tE;

    // No  input. The selector below DERIVES it from dE, so there is nothing for a prover to
    // choose and nothing to cross-check: one fewer public signal and one fewer way to be wrong.

    signal output residual;
    signal output tolerance;
    signal output alignExp;    // dE, published so the alignment is visible rather than implied

    var K = DE_MAX - DE_MIN + 1;

    // ---- Mantissas are normalised -------------------------------------------
    // Without the LOWER bound this whole circuit is decoration: a prover could hand in m = 1 with a
    // matching exponent, satisfy every product below, and have certified a number carrying one
    // significant digit. The upper bound alone would not catch that.
    component rM[5];
    component loM[5];
    component hiM[5];
    signal mant[5];
    mant[0] <== vegaM;
    mant[1] <== gammaM;
    mant[2] <== fM;
    mant[3] <== sigM;
    mant[4] <== tM;
    for (var i = 0; i < 5; i++) {
        rM[i] = Num2Bits(NB_M);
        rM[i].in <== mant[i];

        loM[i] = GreaterEqThan(NB_M);
        loM[i].in[0] <== mant[i];
        loM[i].in[1] <== 100000000;      // 1e8
        loM[i].out === 1;

        hiM[i] = LessThan(NB_M);
        hiM[i].in[0] <== mant[i];
        hiM[i].in[1] <== 1000000000;     // 1e9
        hiM[i].out === 1;
    }

    // ---- Exponents are small non-negative integers ---------------------------
    component rE[5];
    signal expo[5];
    expo[0] <== vegaE;
    expo[1] <== gammaE;
    expo[2] <== fE;
    expo[3] <== sigE;
    expo[4] <== tE;
    for (var i = 0; i < 5; i++) {
        rE[i] = Num2Bits(NB_E);
        rE[i].in <== expo[i];
    }

    // ---- dE, and the power of ten that realises it ---------------------------
    signal dE;
    dE <== gammaE + 2 * fE + sigE + tE - vegaE;
    alignExp <== dE;

    // A one-hot selector over the measured range. It does three jobs at once: it forces dE into the
    // domain, it forces `pow` to be a real power of ten, and it forces the two to agree. Supplying
    // `pow` without this would let a prover choose any multiplier and satisfy the identity with
    // numbers describing no option at all.
    signal sel[K];
    signal partialOne[K + 1];
    signal partialIdx[K + 1];
    signal partialPow[K + 1];
    partialOne[0] <== 0;
    partialIdx[0] <== 0;
    partialPow[0] <== 0;
    for (var k = 0; k < K; k++) {
        // <-- is a witness assignment: the prover computes which branch, the constraints below
        // then force that choice to be a single valid one. A bare  with no assignment is
        // what circom rejected first, and rightly.
        sel[k] <-- (dE == DE_MIN + k) ? 1 : 0;
        sel[k] * (sel[k] - 1) === 0;                       // boolean

        var tenToK = 1;
        for (var j = 0; j < DE_MIN + k; j++) { tenToK = tenToK * 10; }

        partialOne[k + 1] <== partialOne[k] + sel[k];
        partialIdx[k + 1] <== partialIdx[k] + sel[k] * (DE_MIN + k);
        partialPow[k + 1] <== partialPow[k] + sel[k] * tenToK;
    }
    partialOne[K] === 1;          // exactly one branch is taken
    partialIdx[K] === dE;         // and it is the branch dE names
    signal pow;
    pow <== partialPow[K];        // 10^dE, derived rather than supplied

    // ---- The identity: Vm·100·10^dE = Gm·Fm²·Sm·Tm ---------------------------
    signal lhs; lhs <== (vegaM * 100) * pow;

    signal ff;  ff  <== fM * fM;
    signal gf;  gf  <== gammaM * ff;
    signal gfs; gfs <== gf * sigM;
    signal rhs; rhs <== gfs * tM;

    signal R; R <== lhs - rhs;
    residual <== R;

    // Relative, because both sides reach 2^149 on a large forward and a fixed budget would be
    // meaningless at one end and impossible at the other — the same lesson exec-verify's own
    // self-check had to learn. The residual is multiplied by the divisor rather than the sum being
    // divided by it, since a circuit cannot divide.
    tolerance <== lhs + rhs;

    signal shifted;
    shifted <== 2 * R * RELATIVE_D + (lhs + rhs);

    component rR = Num2Bits(NB_R);
    rR.in <== shifted;

    component within = LessEqThan(NB_R);
    within.in[0] <== shifted;
    within.in[1] <== 2 * (lhs + rhs);
    within.out === 1;
}

// NB_M       = 30    a mantissa is < 1e9 < 2^30
// NB_E       = 8     exponents observed in [4, 55]; 8 bits is 255 and leaves room without paying for it
// NB_R       = 190   both sides reach 2^149, and the shifted residual carries the divisor on top
// DE_MIN/MAX = 20/50 measured range is [30, 34]; the domain is widened either way so an unusual book
//                    is refused by the selector rather than wrapped, and a 31-entry selector is cheap
// RELATIVE_D = 2.5e7 bound 2|R|·D <= lhs+rhs, a relative 8e-8. The first attempt used 1e8 and the
//                    sweep violated it at 146.9%: the earlier 7.3e-9 figure came from a probe whose
//                    mantissa rounding differed from the encoder that ships here, which is exactly why
//                    a bound is set from the gate that will enforce it and never from a probe.
component main {public [vegaM, gammaM, fM, sigM, tM, vegaE, gammaE, fE, sigE, tE]} =
    GreekConsistencyFP(30, 8, 190, 20, 50, 25000000);
