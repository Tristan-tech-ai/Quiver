pragma circom 2.1.6;
include "./xabody.circom";
// Same constraints; only the sold number and the fill are public.
component main {public [outHat, bpsHat]} =
    ExecAdverseBody(1000000000, 62, 30, 66, 34, 50, 1125899906842624, 1);
