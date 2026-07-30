pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

// THE EXPECTATION, PROVEN — no quadrature, no bracket, no ceremony file.
//
// The 401-point quadrature in src/engine/lpRisk.js computes a closed form:
//
//     E[IL](v) = exp(-v/8) - 1,     v = sigma^2 * T
//
// Proof (elementary). E[IL] = E[sech(X/2)] - 1 with X = ln r ~ N(-v/2, v), because
// 2*sqrt(r)/(1+r) = sech(ln(r)/2). Put a = sqrt(v)/2 and X/2 = a*z - a^2 with z ~ N(0,1):
//     E[sech(X/2)] = INT phi(z) sech(a z - a^2) dz          [shift z = w + a]
//                  = INT phi(w + a) sech(a w) dw
//                  = e^{-a^2/2} INT phi(w) e^{-a w} sech(a w) dw
//                  = e^{-a^2/2} INT phi(w) cosh(a w) sech(a w) dw    [phi even, symmetrise]
//                  = e^{-a^2/2}                                       [cosh * sech == 1]
//                  = e^{-v/8}.
// Measured: the engine's own quadrature agrees to 1.4e-9 worst case over 20,001 log-spaced v in
// [1e-8, 1e4]; widening its truncation from |z|<=6 to |z|<=8 collapses that to 1.0e-15 and to
// 2.8e-17 at |z|<=16, N=25600 -- i.e. the 1.4e-9 is the ENGINE's error, not the closed form's.
// An independent 120-node Golub-Welsch Gauss-Hermite rule sharing no code agrees to 1.4e-17.
//
// So there is nothing to reduce. The 36,613-constraint 81-node restatement, the 932-constraint
// bracket certificate for a 200-step bisection, and the 2^16..2^17 powers-of-tau they need are all
// certifying a numerical method for a quantity with an exact answer. This template certifies the
// answer instead.
//
// CORRECTED 30 July 2026. This used to end "in ~2k constraints, under the hez_final_12 already on
// disk". Both halves were wrong, and wrong the same way probe-lpclosed-cost.json was: an R1CS count
// read as though it were a Plonk domain. Compiled and measured, not estimated:
//
//     3,854 R1CS  ->  7,471 Plonk  ->  domain 8,192
//
// and snarkjs refuses the smaller ceremony in as many words: "circuit too big for this power of tau
// ceremony. 7471 > 2**12". So this template needs hez_final_13, a public download that moves no hash.
// lpclosed2.circom is the variant that genuinely fits 2^12, at 1,847 R1CS and 3,554 Plonk, and it pays
// for that with a power-of-two working scale and a v cap of 256. R1CS to Plonk inflation measured over
// four of this repo's own zkeys is 1.86x to 1.95x; this circuit came out at 1.9385x.
//
// Gated by zk/scripts/gateLPC-closed-form.mjs, which ASSERTS the 2^12 refusal rather than restating it.
//
// SHAPE. Horner-evaluate exp(-x) for x = v/(8 * 2^K) -- small, so the series is short and every
// intermediate sits in [0.98, 1] where fixed point behaves -- then K squarings to reach exp(-v/8).
// Squaring is the right ladder because the closed form is multiplicative: L(2v) = L(v)^2.
//
// WHAT IS PUBLIC. vHat (v on a 1e-9 grid) and lHat (1 + E[IL] on a 1e-9 grid, i.e. the published
// expectedIlPct with its sign and scale undone). Nothing is a trusted endpoint value: unlike the
// bracket certificate, there is no eLoHat/eHiHat a caller can lie about, because the circuit
// computes the expectation rather than checking two claimed samples of it straddle a root.
//
// template args: SPOW = grid decimals (9), WPOW = working decimals, K = squarings, D = Horner depth
template LpClosed(SPOW, WPOW, K, D, NB_SEED, NB_HORNER, NB_SQ, NB_CMP, TOL) {
    signal input vHat;              // public: v = sigma^2 T, times 10^SPOW
    signal input lHat;              // public: 1 + E[IL] = exp(-v/8), times 10^SPOW

    signal output residual;         // |y_K - lHat * 10^(WPOW-SPOW)|, at the working scale
    signal output tolerance;

    var W = 1;  for (var i = 0; i < WPOW; i++) { W = W * 10; }
    var S = 1;  for (var i = 0; i < SPOW; i++) { S = S * 10; }
    var TWOK = 1; for (var i = 0; i < K; i++) { TWOK = TWOK * 2; }
    var DEN = 8 * TWOK * S;         // x = vHat / DEN, at the working scale

    // ---- 1. the seed argument x = v / (8 * 2^K), rounded down with a range-checked residual.
    signal xW;  signal rx;
    xW <-- (vHat * W) \ DEN;
    rx <== vHat * W - xW * DEN;
    component crx = Num2Bits(NB_SEED);   crx.in <== rx;            // rx >= 0
    component clx = LessThan(NB_SEED);   clx.in[0] <== rx;  clx.in[1] <== DEN;  clx.out === 1;

    // ---- 2. exp(-x) by Horner: h_D = 1, h_n = 1 - (x/n) h_{n+1}. Every h_n lies in [0.98W, W]
    //         for the x this K admits, so no intermediate is ill-conditioned and none underflows.
    signal h[D + 1];
    signal q[D + 1];
    signal rh[D + 1];
    component cq[D + 1];
    component cl[D + 1];
    h[D] <== W;
    for (var n = D; n >= 1; n--) {
        q[n] <-- (xW * h[n]) \ (n * W);
        rh[n] <== xW * h[n] - q[n] * (n * W);
        cq[n] = Num2Bits(NB_HORNER);  cq[n].in <== rh[n];
        cl[n] = LessThan(NB_HORNER);  cl[n].in[0] <== rh[n];  cl[n].in[1] <== n * W;  cl[n].out === 1;
        h[n - 1] <== W - q[n];
    }

    // ---- 3. K squarings: y_{k+1} = y_k^2 / W. exp(-x)^(2^K) = exp(-v/8).
    signal y[K + 1];
    signal ry[K + 1];
    component cy[K + 1];
    component cz[K + 1];
    y[0] <== h[0];
    for (var k = 0; k < K; k++) {
        y[k + 1] <-- (y[k] * y[k]) \ W;
        ry[k + 1] <== y[k] * y[k] - y[k + 1] * W;
        cy[k + 1] = Num2Bits(NB_SQ);  cy[k + 1].in <== ry[k + 1];
        cz[k + 1] = LessThan(NB_SQ);  cz[k + 1].in[0] <== ry[k + 1];  cz[k + 1].in[1] <== W;  cz[k + 1].out === 1;
    }

    // ---- 4. the published figure, to half a grid step plus the chain's own accumulated ulps.
    var SCALE = 1;  for (var i = 0; i < WPOW - SPOW; i++) { SCALE = SCALE * 10; }
    signal diff;
    diff <== y[K] - lHat * SCALE;
    component cd = Num2Bits(NB_CMP);   cd.in <== diff + TOL;                 // diff >= -TOL
    component ce = LessEqThan(NB_CMP); ce.in[0] <== diff + TOL;  ce.in[1] <== 2 * TOL;  ce.out === 1;
    residual  <== diff;
    tolerance <== TOL;
}

// K = 16 squarings covers the engine's whole admissible range: the bisection caps v at 1e4, so
// x = v/524288 <= 0.019 and Horner depth 10 truncates at x^11/11! <= 2.9e-27, which 2^16 squarings
// amplify to 1.9e-22 -- twelve orders below the 1e-9 grid. TOL = half a grid step at the working
// scale (5e8) plus 2^16 working ulps.
component main { public [vHat, lHat] } = LpClosed(9, 18, 16, 10, 64, 68, 64, 68, 500065536);
