pragma circom 2.1.6;

// ADVERSARIAL MEASUREMENT ONLY — is the leg price really too big for one circuit?
//
// The investigator wrote: "price = F*N(d1) - K*N(d2) needs ncdf twice: 2 x 3740 = 7480 Plonk against
// a 4096 ceiling". That is an ADDITION, not a build. This file builds it: two NormalCdf instances,
// the linear spread relation, the moneyness relation F*p1 = K*p2 (no logarithm), and the price.
include "./lib40.circom";

template LegPrice(S) {
    signal input xSign1;
    signal input xMag1;
    signal input nHat1;
    signal input pHat1;
    signal input xSign2;
    signal input xMag2;
    signal input nHat2;
    signal input pHat2;
    signal input Fhat;          // F at 2^S
    signal input Khat;          // K at 2^S
    signal input sHat;          // sigma*sqrt(T) at 2^S
    signal input priceHat;      // the claimed leg price at 2^S

    signal output computed;

    component c1 = NormalCdf();
    c1.xSign <== xSign1;  c1.xMag <== xMag1;  c1.nHat <== nHat1;  c1.pHat <== pHat1;
    component c2 = NormalCdf();
    c2.xSign <== xSign2;  c2.xMag <== xMag2;  c2.nHat <== nHat2;  c2.pHat <== pHat2;
    computed <== c1.computed * c2.computed;

    // R1: x1 - x2 = s, with the signs folded in. Linear, therefore free.
    signal x1;  x1 <== xMag1 - 2 * xSign1 * xMag1;
    signal x2;  x2 <== xMag2 - 2 * xSign2 * xMag2;
    x1 - x2 === sHat;

    // R2: F*phi(d1) = K*phi(d2). One multiply each side. This is the moneyness pin, and it needs no
    // logarithm: with R1 it determines x1 = ln(F/K)/s + s/2 uniquely.
    signal m1;  m1 <== Fhat * pHat1;
    signal m2;  m2 <== Khat * pHat2;
    // tolerance: TOLP ulp on each density, scaled by (F+K)
    signal tolM;  tolM <== 10 * (Fhat + Khat);
    signal mShift;  mShift <== 2 * (m1 - m2) + tolM;
    component mOk = LessEqThan(200);  mOk.in[0] <== mShift;  mOk.in[1] <== 2 * tolM;  mOk.out === 1;

    // R3: price*2^S = F*n1 - K*n2, with the truncation remainder range checked.
    signal fn;  fn <== Fhat * nHat1;
    signal kn;  kn <== Khat * nHat2;
    signal tolP2;  tolP2 <== 12 * (Fhat + Khat);
    signal pShift2;  pShift2 <== 2 * (priceHat * (1 << S) - (fn - kn)) + tolP2;
    component pOk2 = LessEqThan(200);  pOk2.in[0] <== pShift2;  pOk2.in[1] <== 2 * tolP2;  pOk2.out === 1;
}

component main {public [xSign1, xMag1, nHat1, pHat1, xSign2, xMag2, nHat2, pHat2, Fhat, Khat, sHat, priceHat]} = LegPrice(40);
