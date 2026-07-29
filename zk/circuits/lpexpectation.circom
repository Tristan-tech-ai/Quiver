pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// THE EXPECTATION, AS A CIRCUIT. This one does not fit the ceremony file on hand, and it exists so
// that the sentence "it does not fit" is a measured number rather than an opinion.
//
// `expectedDivergence.expectedIlPct` was called unprovable because it is a 401-point numerical
// quadrature over a lognormal — 802 exponentials and 402 roots per served figure, measured. Three
// separate things turn out to be true about that, none of which is "no closed form exists":
//
// 1. THE GRID IS GEOMETRIC. The engine's nodes are z_i = −6 + 0.03·i, so
//        r_i = exp(−v/2 + √v·z_i)   and   s_i := √r_i = exp(−v/4 + (√v/2)·z_i)
//    satisfy s_{i+1} = s_i · p with p = exp(0.015·√v) FIXED across the whole grid. Two exponentials
//    and a chain of multiplications reproduce all 401 nodes — measured to a worst gap of 5.218e-15
//    against the engine's own pass over 4,000 log-spaced v in [1e-6, 200]. The Gaussian weights do
//    not depend on v at all: they are compile-time constants.
//
// 2. THE TWO SEEDS ARE POLYNOMIAL. p = exp(0.015·√v) has a small argument and a 9-term Taylor series
//    reaches 1.25e-13 relative for v <= 250; the centre value exp(−v/4) reaches 7.74e-13 in 10 terms
//    plus 9 squarings. So no transcendental primitive is required, only fixed-point care — the same
//    correction the roadmap already had to make about Black-76.
//
// 3. EIGHTY-ONE OF THE 401 NODES SUFFICE. Striding the engine's own grid by 5 reproduces the served
//    4-decimal figure on 3,000 of 3,000 sampled v, worst gap to the full sum 4.702e-10 against a
//    published half-step of 5e-7. Striding by 8 does not: its worst gap is 2.845e-8, still under the
//    half-step, and 3 of 3,000 rounded figures differ anyway — a gap under half a step is not the
//    same claim as rounding to the same figure, and conflating them is what made an earlier gate in
//    this project fail for the wrong reason.
//
// WHAT ACTUALLY BLOCKS IT is the ceremony file. This template at 81 nodes compiles, and its constraint
// count is printed by `zk/scripts/gateLP2-expectation-cost.mjs`; hez_final_12 allows 4,096. The
// binding cost is the per-node division bound: t_k = 2·s_k/(1+r_k) needs a signed residual range
// check, and at the s-grid the tails require, that residual is wide.
//
// THE SEEDS ARE WITNESSES HERE. This template pins the CHAIN and the SUMMATION, not the two seed
// exponentials — those arrive as inputs. Pinning them by Taylor is item 2 above and is not in this
// file. So this is a cost measurement of the reducible part, and an honest floor on the whole.
template LpExpectation(NODES, SPOW, NB_S, NB_T, NB_CHAIN, NB_DIV, NB_SUM, TOL) {
    signal input sMid;              // exp(−v/4) on the s-grid: the BEST-conditioned node, index MID
    signal input p;                 // exp(stride·0.015·√v) on the s-grid: one step right
    signal input s[NODES];          // the chain, supplied and then forced
    signal input t[NODES];          // t_k = 2·s_k/(1 + r_k), supplied and then forced
    signal input eHat;              // L = E[IL] + 1 on the s-grid, the published figure
    signal input pdfSum;            // Σ pdf_k, a constant of the grid, echoed so a reader sees it
    signal input pdf[NODES];        // the Gaussian weights: constants of the grid, echoed likewise

    signal output residual;         // the summation's slack
    signal output tolerance;

    var SS = 1;
    for (var i = 0; i < SPOW; i++) { SS = SS * 10; }

    var MID = (NODES - 1) \ 2;

    // ---- the centre is the seed. Seeding at the LEFT TAIL instead — which is the obvious reading of
    //      "start at i = 0" — puts the smallest number on the grid at the head of a multiplicative
    //      chain and carries its relative error into every later node; worse, once that value
    //      underflows to zero the chain stays zero and the HIGH tail reads zero too, collapsing the
    //      whole figure onto the −100% floor. Measured: the engine reads −94.5819% at v = 23.32 where
    //      a left-seeded chain reads −99.99999980%. Seeding at z = 0 sends both tails toward the one
    //      place degeneracy is harmless, since IL(0) = IL(∞) = −1.
    s[MID] === sMid;

    // ---- the chain: s_{k+1}·SS = s_k·p, to half a grid step.
    component cb[NODES];
    component cw[NODES];
    signal chainR[NODES];
    for (var k = 0; k < NODES - 1; k++) {
        chainR[k] <== s[k] * p - s[k + 1] * SS;
        cb[k] = Num2Bits(NB_CHAIN);
        cb[k].in <== 2 * chainR[k] + SS;
        cw[k] = LessEqThan(NB_CHAIN);
        cw[k].in[0] <== 2 * chainR[k] + SS;
        cw[k].in[1] <== 2 * SS;
        cw[k].out === 1;
    }

    // ---- per node: r_k = s_k² / SS, and the ONE division, t_k·(SS + r_k) = 2·s_k·SS.
    //      The division is cleared by cross-multiplication, exactly as liquidation.circom clears its
    //      own through three factors of SCALE, so nothing here inverts anything.
    component db[NODES];
    component dw[NODES];
    signal rr[NODES];
    signal divR[NODES];
    signal acc[NODES];
    for (var k = 0; k < NODES; k++) {
        rr[k] <== s[k] * s[k];                                  // = r_k · SS
        divR[k] <== t[k] * (SS * SS + rr[k]) - 2 * s[k] * SS * SS;
        db[k] = Num2Bits(NB_DIV);
        db[k].in <== 2 * divR[k] + TOL * SS * SS;
        dw[k] = LessEqThan(NB_DIV);
        dw[k].in[0] <== 2 * divR[k] + TOL * SS * SS;
        dw[k].in[1] <== 2 * TOL * SS * SS;
        dw[k].out === 1;
        acc[k] <== (k == 0 ? 0 : acc[k - 1]) + pdf[k] * t[k];
    }

    // ---- the summation: eHat · Σpdf = Σ pdf_k·t_k, to half a weight.
    residual <== eHat * pdfSum - acc[NODES - 1];
    tolerance <== pdfSum;
    component sb = Num2Bits(NB_SUM);
    sb.in <== 2 * residual + pdfSum;
    component sw = LessEqThan(NB_SUM);
    sw.in[0] <== 2 * residual + pdfSum;
    sw.in[1] <== 2 * pdfSum;
    sw.out === 1;
}

// NODES = 81   the engine's own 401 nodes strided by 5, which reproduces the served 4-dp figure
// SPOW  = 18   the s-grid the tails need: at 1e-9 the refusal band runs to v ≈ 115, at 1e-18 to 10.4
component main {public [eHat]} = LpExpectation(81, 18, 64, 32, 64, 152, 64, 1);
