pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// WIDENING: one circuit that states N Kelly answers at once.
//
// This is not recursion. Recursion aggregates PROOFS; this aggregates STATEMENTS. Quiver holds every
// witness it sells, so it can restate N answers in one circuit, and it cannot fold a proof somebody
// else made. The measured arrival rate on X Layer is one paid call every 7.4 minutes, so the batch
// Quiver can actually assemble is two, three or four answers — never the hundred both Phase C research
// passes costed. This file is built for the batch that occurs.
//
// THE PACKING, and why it is not a hash. A rolling Poseidon commitment is cheaper on chain and puts
// every member OFF chain: the contract would certify a root and be unable to see what is under it. So
// the answers themselves are the public input, packed into 254-bit field elements:
//
//     lane = pHat (30 bits) | bHat (45 bits) | fHat (45 bits)      = 120 bits
//     word = lane(2i) | lane(2i+1)                                 = 240 bits, two answers
//
// A reader on chain recovers answer i with a shift and a mask; `zk/scripts/gateB9-2-widening-evm.mjs`
// compiles a Solidity reader that does exactly that and measures what it costs.
//
// WHAT IS NOT PUBLISHED, deliberately. `kelly.circom` publishes `residual` and `tolerance` alongside
// the three inputs, five public signals for one answer. Both are FUNCTIONS of the published answer:
//
//     R_i = f_i*b_i - p_i*b_i - S*p_i + S^2        tolerance_i = b_i
//
// so publishing them buys a reader nothing they could not compute from the packed word, and costs
// about 822 gas of execution plus 145 of calldata per signal. The batch publishes only the packed
// words. The residuals are still reported by the gates, computed the way any reader would compute
// them.
//
// CANONICAL ENCODING. When N is odd the last word has one empty lane. Its top 120 bits are constrained
// to zero, so a given batch of answers has exactly ONE valid packed representation. Without that, a
// prover could publish the same three answers under 2^120 different words, and any contract that
// deduplicated on the word would be fooled.

// One member of the batch.
//
// Deliberately NOT `KellyIdentity` from kelly.circom: that template range-checks pHat, bHat and fHat
// with its own Num2Bits, and in a batch those checks are already paid for by the 240-bit split of the
// packed word. A value reconstructed from t verified bits is below 2^t by construction. Re-deriving it
// would cost 120 constraints per member for a fact already established, which is 480 of the 4,096 the
// ceremony file on hand allows at N=4.
//
// Everything else is character-for-character the statement kelly.circom proves.
template KellyMember(SCALE, NB_P, NB_R) {
    signal input pHat;   // < 2^NB_P, guaranteed by the caller's bit decomposition
    signal input bHat;
    signal input fHat;

    signal output residual;   // not a public signal here; the batch does not expose member outputs

    // A probability is a proper fraction: 0 < p < 1. LessThan(NB_P) needs both operands below 2^NB_P;
    // pHat is by construction and SCALE = 1e9 < 2^30 is by arithmetic.
    component pProper = LessThan(NB_P);
    pProper.in[0] <== pHat;
    pProper.in[1] <== SCALE;
    pProper.out === 1;

    component pNonZero = IsZero(); pNonZero.in <== pHat; pNonZero.out === 0;

    // b = 0 makes the engine's divisor vanish and the identity degenerate, which would let any
    // fraction whatsoever be proven as the Kelly bet.
    component bNonZero = IsZero(); bNonZero.in <== bHat; bNonZero.out === 0;

    // Positive edge only, as the engine itself refuses to size a bet when f* <= 0.
    component fNonZero = IsZero(); fNonZero.in <== fHat; fNonZero.out === 0;

    // The identity, cross-multiplied so there is no division:  f*b = p*b + S*p - S^2
    signal fb;  fb <== fHat * bHat;
    signal pb;  pb <== pHat * bHat;
    signal R;   R  <== fb - pb - SCALE * pHat + SCALE * SCALE;
    residual <== R;

    // 2*|R| <= b. The field has no order, so bound the shifted value: 2R + b in [0, 2b].
    signal shifted;
    shifted <== 2 * R + bHat;

    component rR = Num2Bits(NB_R);
    rR.in <== shifted;

    component within = LessEqThan(NB_R);
    within.in[0] <== shifted;
    within.in[1] <== 2 * bHat;
    within.out === 1;
}

template KellyBatch(N, SCALE, NB_P, NB_B, NB_F, NB_R) {
    var LANE  = NB_P + NB_B + NB_F;         // 120
    var WORDS = (N + 1) \ 2;                // two answers per 254-bit field element

    signal input packed[WORDS];

    component split[WORDS];
    for (var s = 0; s < WORDS; s++) {
        split[s] = Num2Bits(2 * LANE);
        split[s].in <== packed[s];
    }

    // Canonicity for an odd batch: the unused high lane of the final word must be zero. The bits are
    // already constrained boolean by Num2Bits, so a single constraint on their sum forces all of them.
    if (N % 2 == 1) {
        var tail = 0;
        for (var t = LANE; t < 2 * LANE; t++) { tail += split[WORDS - 1].out[t]; }
        tail === 0;
    }

    component member[N];
    for (var i = 0; i < N; i++) {
        var s   = i \ 2;
        var off = (i % 2) * LANE;

        var p = 0; var w = 1;
        for (var t = 0; t < NB_P; t++) { p += split[s].out[off + t] * w; w = w * 2; }

        var b = 0; w = 1;
        for (var t = 0; t < NB_B; t++) { b += split[s].out[off + NB_P + t] * w; w = w * 2; }

        var f = 0; w = 1;
        for (var t = 0; t < NB_F; t++) { f += split[s].out[off + NB_P + NB_B + t] * w; w = w * 2; }

        member[i] = KellyMember(SCALE, NB_P, NB_R);
        member[i].pHat <== p;
        member[i].bHat <== b;
        member[i].fHat <== f;
    }
}
