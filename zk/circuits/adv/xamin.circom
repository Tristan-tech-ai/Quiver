pragma circom 2.1.6;
include "./xabody.circom";
// Identical statement to execadverse.circom, seven redundant public outputs removed.
component main {public [xHat, yHat, dxHat, fHat, inHat, outHat, realizedHat, bpsHat]} =
    ExecAdverseBody(1000000000, 62, 30, 66, 34, 50, 1125899906842624, 1);
