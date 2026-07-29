pragma circom 2.1.6;

include "kellybatch.circom";

// N = 1: 1 Kelly answer(s) in one statement, packed into 1 public field element(s).
//
// SCALE = 1e9   fixed-point resolution, identical to kelly.circom
// NB_P  = 30    probability scaled < 2^30, and separately forced < 1e9
// NB_B  = 45    odds  < 2^45 / 1e9 ~ 35,000 : far past any real book
// NB_F  = 45    fraction likewise; Kelly can exceed 1 on long odds, so it is not capped at SCALE
// NB_R  = 100   |2R| < 2^92 under the above and 2*b < 2^46, so 100 bits cannot wrap
component main {public [packed]} = KellyBatch(1, 1000000000, 30, 45, 45, 100);
