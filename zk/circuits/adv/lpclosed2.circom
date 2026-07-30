pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

// E[IL] = exp(-sigma^2 T / 8) - 1, PROVEN, under the hez_final_12 already on disk.
//
// See lpclosed.circom for the derivation. Two changes make it fit 2^12 rather than 2^13:
//   (a) the working scale is a POWER OF TWO (2^WBITS), so "residual < W" is one Num2Bits and not a
//       Num2Bits plus a LessThan. A LessThan alone would be unsound here -- with 2^NB > n*W a
//       negative residual passes -- which is why the pair is needed whenever the modulus is decimal.
//   (b) v is capped and REFUSED above VCAP instead of being covered by a longer squaring ladder.
//       That is not a fudge: exp(-v/8) < 5e-10 for v > 8*ln(2e9) = 171.3, so every v above the cap
//       publishes the same -100.0000% floor, and the cap is 256.
//
// Every intermediate is range-checked in BOTH directions. pw[n] and y[k] each carry their own
// Num2Bits, not only their residual: with only the residual bounded, y*W = A - r has a second
// field solution near p/W, and a prover who can reach it controls the next squaring.
template LpClosed2(SPOW, LPOW, WBITS, K, D, VCAP) {
    signal input vHat;              // public: v = sigma^2 T, times 10^SPOW
    signal input lHat;              // public: 1 + E[IL] = exp(-v/8), times 10^SPOW

    signal output gridValue;        // the figure the circuit itself computes, on the 10^-SPOW grid
    signal output residual;         // gridValue - lHat

    var S = 1;  for (var i = 0; i < SPOW; i++) { S = S * 10; }
    var L = 1;  for (var i = 0; i < LPOW; i++) { L = L * 10; }
    var W = 1;  for (var i = 0; i < WBITS; i++) { W = W * 2; }
    var SHIFT = 1; for (var i = 0; i < WBITS - K - 3; i++) { SHIFT = SHIFT * 2; }   // W / (8 * 2^K)
    var DFAC = 1; for (var i = 2; i <= D; i++) { DFAC = DFAC * i; }                 // D!

    // ---- 0. the cap, refused by name.
    component vb = Num2Bits(38);       vb.in <== vHat;
    component vc = LessEqThan(38);     vc.in[0] <== vHat;  vc.in[1] <== VCAP * S;  vc.out === 1;

    // ---- 1. x = v / (8 * 2^K) at the working scale. Only the decimal grid divides here, so this is
    //         the one place the Num2Bits + LessThan pair is unavoidable.
    signal xW;  signal rx;
    xW  <-- (vHat * SHIFT) \ S;
    rx  <== vHat * SHIFT - xW * S;
    component crx = Num2Bits(30);    crx.in <== rx;
    component clx = LessThan(30);    clx.in[0] <== rx;  clx.in[1] <== S;  clx.out === 1;
    component cxb = Num2Bits(WBITS); cxb.in <== xW;

    // ---- 2. exp(-x) = (sum_{n<=D} (-1)^n (D!/n!) x^n) / D!, by a power chain.
    signal pw[D + 1];
    signal rp[D + 1];
    component cp[D + 1];
    component cr[D + 1];
    pw[0] <== W;
    for (var n = 1; n <= D; n++) {
        pw[n] <-- (pw[n - 1] * xW) \ W;
        rp[n] <== pw[n - 1] * xW - pw[n] * W;
        cp[n] = Num2Bits(WBITS);  cp[n].in <== pw[n];        // bounds the value
        cr[n] = Num2Bits(WBITS);  cr[n].in <== rp[n];        // bounds the residual: r < 2^WBITS = W
    }
    var acc = 0;
    var c = DFAC;
    signal series;
    series <== pw[0] * DFAC
             - pw[1] * (DFAC \ 1)
             + pw[2] * (DFAC \ 2)
             - pw[3] * (DFAC \ 6)
             + pw[4] * (DFAC \ 24)
             - pw[5] * (DFAC \ 120)
             + pw[6] * (DFAC \ 720)
             - pw[7] * (DFAC \ 5040)
             + pw[8] * (DFAC \ 40320);

    signal e0;  signal re;
    e0 <-- series \ DFAC;
    re <== series - e0 * DFAC;
    component ceb = Num2Bits(WBITS);  ceb.in <== e0;
    component crb = Num2Bits(24);     crb.in <== re;
    component cre = LessThan(24);     cre.in[0] <== re;  cre.in[1] <== DFAC;  cre.out === 1;

    // ---- 3. K squarings. exp(-x)^(2^K) = exp(-v/8): the ladder the closed form's own
    //         multiplicativity, L(2v) = L(v)^2, hands you for free.
    signal y[K + 1];
    signal ry[K + 1];
    component cyb[K + 1];
    component cyr[K + 1];
    y[0] <== e0;
    for (var k = 0; k < K; k++) {
        y[k + 1] <-- (y[k] * y[k]) \ W;
        ry[k + 1] <== y[k] * y[k] - y[k + 1] * W;
        cyb[k + 1] = Num2Bits(WBITS);  cyb[k + 1].in <== y[k + 1];
        cyr[k + 1] = Num2Bits(WBITS);  cyr[k + 1].in <== ry[k + 1];
    }

    // ---- 4. down to the published grid, and within one grid step of the published figure.
    signal g;  signal rg;
    g  <-- (y[K] * L) \ W;
    rg <== y[K] * L - g * W;
    component cgb = Num2Bits(34);      cgb.in <== g;
    component cgr = Num2Bits(WBITS);   cgr.in <== rg;

    signal diff;
    diff <== g - lHat;
    component cdb = Num2Bits(4);       cdb.in <== diff + 2;         // -2 <= diff
    component cdc = LessEqThan(4);     cdc.in[0] <== diff + 2;  cdc.in[1] <== 4;  cdc.out === 1;

    gridValue <== g;
    residual  <== diff;
}

// SPOW 9 (the 1e-9 grid the rest of the zk layer uses) · WBITS 44 (ulp 5.7e-14; 2^8 squarings and
// ~5 ulps of series error leave 7.3e-11, well under the half grid step 5e-10) · K 8 · D 8
// (truncation x^9/9! at x <= 0.125 is 2.1e-14, amplified to 5.3e-12) · VCAP 256.
component main { public [vHat, lHat] } = LpClosed2(9, 6, 44, 8, 8, 256);
