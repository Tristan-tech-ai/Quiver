pragma circom 2.1.6;
include "./xabody.circom";
// Same constraints + a Poseidon commitment to (x,y,dx,f,realized).
// Public: the commitment (an output) and the sold headline. nPublic = 2.
component main {public [bpsHat]} =
    ExecAdverseCommit(1000000000, 62, 30, 66, 34, 50, 1125899906842624, 1);
