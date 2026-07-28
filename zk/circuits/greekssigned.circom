pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// The three signed Black-76 identities: volga, vanna and theta.
//
// `greeksfp.circom` proves vega against gamma, and both are strictly positive so a field with no sign
// was never a problem there. These three are. theta is negative for a long option, vanna takes either
// sign, and d1 and d2 each cross zero at their own strike. A field element cannot be negative, so a
// value has to arrive as a magnitude and a sign bit and the identity has to be split in two:
//
//     the MAGNITUDES satisfy a positive product identity
//     the SIGNS satisfy a boolean relation
//
// Both halves are constrained. Proving only the magnitudes would certify |theta| against |vega| and
// say nothing about whether the option decays or appreciates, which is the entire content of theta.
//
// ── THE THREE, with r = 0 ──
//
//   C   volga·σ = vega·d1·d2·0.01      |volga|·σ = vega·|d1|·|d2|·0.01   ·   s_volga = s_d1 XOR s_d2
//   D   vanna·F·(d1−d2) = −vega·d2     |vanna|·F·(d1−d2) = vega·|d2|     ·   s_vanna = NOT s_d2
//   E   theta·730·T = −vega·100·σ      |theta|·730·T = vega·100·σ        ·   s_theta = 1
//
// d1 − d2 = σ·√T is positive always, which is why D's left side needs no sign of its own beyond
// vanna's, and it is also identity A from the same family — proven here as a by-product rather than
// as a separate statement.
//
// r = 0 IS A RESTRICTION AND IT IS STATED. At r ≠ 0 identity E gains a `+ 2·T·r·price` term, which
// makes the right side a sum of two quantities with opposite signs and needs a comparison rather than
// a product identity. Crypto futures options are quoted at r = 0 and the engine's own callers pass
// nothing else, but a circuit that silently assumed it would be lying by omission.
//
// Every quantity carries its own power-of-ten exponent, exactly as in greeksfp: nine significant
// digits whatever the magnitude, because vanna and volga vanish on the wings just as gamma does.

template SignedGreeks(NB_M, NB_E, NB_R, CMIN, CMAX, DMIN, DMAX, EMIN, EMAX, RELATIVE_D) {
    // Magnitudes, nine significant digits each.
    signal input vegaM;
    signal input sigM;
    signal input tM;
    signal input fM;
    signal input d1M;
    signal input d2M;
    signal input dDiffM;    // |d1 − d2|, which is σ√T and therefore positive
    signal input volgaM;
    signal input vannaM;
    signal input thetaM;

    // Exponents.
    signal input vegaE;
    signal input sigE;
    signal input tE;
    signal input fE;
    signal input d1E;
    signal input d2E;
    signal input dDiffE;
    signal input volgaE;
    signal input vannaE;
    signal input thetaE;

    // Sign bits: 0 positive, 1 negative. vega, sigma, T, F and |d1−d2| have no sign input because
    // each is positive by construction and giving a prover a bit to set would be handing them a way
    // to describe an option that cannot exist.
    signal input d1S;
    signal input d2S;
    signal input volgaS;
    signal input vannaS;
    signal input thetaS;

    signal output volgaResidual;
    signal output vannaResidual;
    signal output thetaResidual;
    signal output tolerance;

    // THREE ranges, not one shared one. Measured: dC in [7,10], dD in [-10,-7], dE in [-3,0]. Forcing
    // all three into a single [-12,12] window cost 75 selector entries where 24 do the work, and the
    // 51 wasted entries were exactly what pushed the residual range check over the ptau ceiling.
    var KC = CMAX - CMIN + 1;
    var KD = DMAX - DMIN + 1;
    var KE = EMAX - EMIN + 1;
    var NV = 10;

    // ---- Mantissas are normalised to [1e8, 1e9) -----------------------------
    signal mant[NV];
    mant[0] <== vegaM;  mant[1] <== sigM;   mant[2] <== tM;      mant[3] <== fM;
    mant[4] <== d1M;    mant[5] <== d2M;    mant[6] <== dDiffM;
    mant[7] <== volgaM; mant[8] <== vannaM; mant[9] <== thetaM;

    // TWO checks per mantissa, not three. Decomposing (m − 1e8) rather than m proves m >= 1e8 for
    // free: a value below the floor wraps to ~p and blows the decomposition. So the separate
    // GreaterEqThan is redundant, and dropping it across ten values saved 310 R1CS — which is what
    // the circuit was over the ceremony ceiling by.
    component rM[NV];
    component hiM[NV];
    for (var i = 0; i < NV; i++) {
        rM[i] = Num2Bits(NB_M);   rM[i].in <== mant[i] - 100000000;
        hiM[i] = LessThan(NB_M);  hiM[i].in[0] <== mant[i]; hiM[i].in[1] <== 1000000000; hiM[i].out === 1;
    }

    signal expo[NV];
    expo[0] <== vegaE;  expo[1] <== sigE;   expo[2] <== tE;      expo[3] <== fE;
    expo[4] <== d1E;    expo[5] <== d2E;    expo[6] <== dDiffE;
    expo[7] <== volgaE; expo[8] <== vannaE; expo[9] <== thetaE;
    component rE[NV];
    for (var i = 0; i < NV; i++) { rE[i] = Num2Bits(NB_E); rE[i].in <== expo[i]; }

    // ---- Sign bits are bits -------------------------------------------------
    d1S * (d1S - 1) === 0;
    d2S * (d2S - 1) === 0;
    volgaS * (volgaS - 1) === 0;
    vannaS * (vannaS - 1) === 0;
    thetaS * (thetaS - 1) === 0;

    // ---- The sign relations -------------------------------------------------
    // XOR of two bits, as a quadratic: a + b − 2ab.
    signal d1d2Xor;
    d1d2Xor <== d1S + d2S - 2 * d1S * d2S;
    volgaS === d1d2Xor;                    // C: volga follows the sign of d1·d2

    vannaS === 1 - d2S;                    // D: vanna is opposite in sign to d2

    thetaS === 1;                          // E: a long option always decays at r = 0

    // ---- Alignment selectors ------------------------------------------------
    // One per identity, each pinning its own 10^dE. Written as a function-free block three times
    // rather than a template, because circom cannot return a signal from a function and a template
    // instance per identity costs the same constraints with more indirection.
    signal dC;  dC <== (vegaE + d1E + d2E + 2) - (volgaE + sigE);
    signal dD;  dD <== (vegaE + d2E) - (vannaE + fE + dDiffE);
    // NO "+3" here. The first version compensated for treating 730 as 7.3·10^2, but 730 appears as a
    // literal on the left side already, so there was nothing to compensate. The sweep caught it as a
    // residual off by a factor of exactly ten, which is the signature of a single wrong exponent.
    signal dE_;  dE_ <== (vegaE + sigE + 2) - (thetaE + tE);

    // TWO multipliers per identity, not one. The alignment exponents were assumed non-negative and
    // MEASURED otherwise: dC lands in [7,10] but dD in [-10,-7] and dE in [-3,0]. A negative alignment
    // means the factor belongs on the OTHER side, and a one-sided design would have needed a division.
    // Both come out of the same one-hot, as constants chosen per entry, so the second costs one
    // accumulator rather than a second selector.
    signal selC[KC]; signal oneC[KC+1]; signal idxC[KC+1]; signal pLC[KC+1]; signal pRC[KC+1];
    signal selD[KD]; signal oneD[KD+1]; signal idxD[KD+1]; signal pLD[KD+1]; signal pRD[KD+1];
    signal selE[KE]; signal oneE[KE+1]; signal idxE[KE+1]; signal pLE[KE+1]; signal pRE[KE+1];
    oneC[0] <== 0; idxC[0] <== 0; pLC[0] <== 0; pRC[0] <== 0;
    oneD[0] <== 0; idxD[0] <== 0; pLD[0] <== 0; pRD[0] <== 0;
    oneE[0] <== 0; idxE[0] <== 0; pLE[0] <== 0; pRE[0] <== 0;
    for (var k = 0; k < KC; k++) {
        var d = CMIN + k;
        var tenL = 1; var tenR = 1;
        for (var j = 0; j < d; j++) { tenL = tenL * 10; }
        for (var j = 0; j < 0 - d; j++) { tenR = tenR * 10; }
        selC[k] <-- (dC == d) ? 1 : 0;   selC[k] * (selC[k] - 1) === 0;
        oneC[k+1] <== oneC[k] + selC[k];
        idxC[k+1] <== idxC[k] + selC[k] * d;
        pLC[k+1] <== pLC[k] + selC[k] * tenL;
        pRC[k+1] <== pRC[k] + selC[k] * tenR;
    }
    for (var k = 0; k < KD; k++) {
        var d = DMIN + k;
        var tenL = 1; var tenR = 1;
        for (var j = 0; j < d; j++) { tenL = tenL * 10; }
        for (var j = 0; j < 0 - d; j++) { tenR = tenR * 10; }
        selD[k] <-- (dD == d) ? 1 : 0;   selD[k] * (selD[k] - 1) === 0;
        oneD[k+1] <== oneD[k] + selD[k];
        idxD[k+1] <== idxD[k] + selD[k] * d;
        pLD[k+1] <== pLD[k] + selD[k] * tenL;
        pRD[k+1] <== pRD[k] + selD[k] * tenR;
    }
    for (var k = 0; k < KE; k++) {
        var d = EMIN + k;
        var tenL = 1; var tenR = 1;
        for (var j = 0; j < d; j++) { tenL = tenL * 10; }
        for (var j = 0; j < 0 - d; j++) { tenR = tenR * 10; }
        selE[k] <-- (dE_ == d) ? 1 : 0;   selE[k] * (selE[k] - 1) === 0;
        oneE[k+1] <== oneE[k] + selE[k];
        idxE[k+1] <== idxE[k] + selE[k] * d;
        pLE[k+1] <== pLE[k] + selE[k] * tenL;
        pRE[k+1] <== pRE[k] + selE[k] * tenR;
    }
    oneC[KC] === 1; idxC[KC] === dC;
    oneD[KD] === 1; idxD[KD] === dD;
    oneE[KE] === 1; idxE[KE] === dE_;

    // ---- C: |volga|·σ·10^dC = vega·|d1|·|d2| --------------------------------
    // Three signals multiplied together is CUBIC and circom takes one multiplication per constraint,
    // so the product is split. The compiler catching this is the good failure mode: a silently
    // accepted cubic term would have been a constraint that does not constrain.
    signal cL0; cL0 <== volgaM * sigM;
    signal cL;  cL  <== cL0 * pLC[KC];
    signal cR0; cR0 <== vegaM * d1M;
    signal cR1; cR1 <== cR0 * d2M;
    signal cR;  cR  <== cR1 * pRC[KC];
    signal rc;  rc <== cL - cR;
    volgaResidual <== rc;

    signal cShift; cShift <== 2 * rc * RELATIVE_D + (cL + cR);
    component rcBits = Num2Bits(NB_R); rcBits.in <== cShift;
    component cOk = LessEqThan(NB_R); cOk.in[0] <== cShift; cOk.in[1] <== 2 * (cL + cR); cOk.out === 1;

    // ---- D: |vanna|·F·(d1−d2)·10^dD = vega·|d2| -----------------------------
    signal dL0; dL0 <== vannaM * fM;
    signal dL1; dL1 <== dL0 * dDiffM;
    signal dL;  dL  <== dL1 * pLD[KD];
    signal dR0; dR0 <== vegaM * d2M;
    signal dR;  dR  <== dR0 * pRD[KD];
    signal rd;  rd  <== dL - dR;
    vannaResidual <== rd;

    signal dShift; dShift <== 2 * rd * RELATIVE_D + (dL + dR);
    component rdBits = Num2Bits(NB_R); rdBits.in <== dShift;
    component dOk = LessEqThan(NB_R); dOk.in[0] <== dShift; dOk.in[1] <== 2 * (dL + dR); dOk.out === 1;

    // ---- E: |theta|·730·T·10^dE = vega·100·σ --------------------------------
    signal eL0; eL0 <== (thetaM * 730) * tM;
    signal eL;  eL  <== eL0 * pLE[KE];
    signal eR0; eR0 <== (vegaM * 100) * sigM;
    signal eR;  eR  <== eR0 * pRE[KE];
    signal re;  re  <== eL - eR;
    thetaResidual <== re;

    signal eShift; eShift <== 2 * re * RELATIVE_D + (eL + eR);
    component reBits = Num2Bits(NB_R); reBits.in <== eShift;
    component eOk = LessEqThan(NB_R); eOk.in[0] <== eShift; eOk.in[1] <== 2 * (eL + eR); eOk.out === 1;

    tolerance <== RELATIVE_D;
}

// NB_M       = 30    a mantissa is < 1e9
// NB_E       = 9     exponents reach into the fifties on the wings; 9 bits is 511
// NB_R       = 165   the widest side is |vanna|·F·|d1−d2|·10^12 at ~2^130, times the divisor   the widest product is vega·|d1|·|d2| at ~2^90, times the divisor and the shift
// DE_MIN/MAX = -12/12 measured: dC [7,10], dD [-10,-7], dE [-3,0]. Two spare entries each side. Wider's window because three different alignments share one selector
//                    range, and the cost of a spare entry is one constraint
// RELATIVE_D = 2.5e7 the same 8e-8 relative bound greeksfp settled on, for the same reason
component main {public [
    vegaM, sigM, tM, fM, d1M, d2M, dDiffM, volgaM, vannaM, thetaM,
    vegaE, sigE, tE, fE, d1E, d2E, dDiffE, volgaE, vannaE, thetaE,
    d1S, d2S, volgaS, vannaS, thetaS
]} = SignedGreeks(30, 9, 165, 4, 13, -13, -4, -6, 3, 25000000);
