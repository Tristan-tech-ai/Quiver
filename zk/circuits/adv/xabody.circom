pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/poseidon.circom";

// ADVERSARIAL-REVIEW SCRATCH COPY of zk/circuits/execadverse.circom.
// Constraint-generating content copied VERBATIM. The only change: the seven
// `signal output` declarations are demoted to plain (private) signals, because
// every one of them is a closed-form function of the eight public inputs and
// therefore carries no information a verifier could not recompute.
// Nothing here is intended to be committed to the repo.
template ExecAdverseBody(SCALE, NB_AMT, NB_FEE, NB_BOUND, NB_FEEBOUND, NB_BPS, BPS_OFF, TOL_MULT) {
    signal input xHat;
    signal input yHat;
    signal input dxHat;
    signal input fHat;
    signal input inHat;
    signal input outHat;
    signal input realizedHat;
    signal input bpsHat;

    component rX  = Num2Bits(NB_AMT); rX.in  <== xHat;
    component rY  = Num2Bits(NB_AMT); rY.in  <== yHat;
    component rDx = Num2Bits(NB_AMT); rDx.in <== dxHat;
    component rIn = Num2Bits(NB_AMT); rIn.in <== inHat;
    component rO  = Num2Bits(NB_AMT); rO.in  <== outHat;
    component rRz = Num2Bits(NB_AMT); rRz.in <== realizedHat;
    component rF  = Num2Bits(NB_FEE); rF.in  <== fHat;

    component xNonZero = IsZero(); xNonZero.in <== xHat;        xNonZero.out === 0;
    component yNonZero = IsZero(); yNonZero.in <== yHat;        yNonZero.out === 0;
    component dNonZero = IsZero(); dNonZero.in <== dxHat;       dNonZero.out === 0;
    component zNonZero = IsZero(); zNonZero.in <== realizedHat; zNonZero.out === 0;

    component fProper = LessThan(NB_FEE);
    fProper.in[0] <== fHat;
    fProper.in[1] <== SCALE;
    fProper.out === 1;

    signal netFee;  netFee <== SCALE - fHat;
    signal grossIn; grossIn <== dxHat * netFee;

    signal Rf;  Rf <== inHat * SCALE - grossIn;

    signal feeShift;
    feeShift <== 2 * Rf + SCALE;

    component rFee = Num2Bits(NB_FEEBOUND);
    rFee.in <== feeShift;

    component feeWithin = LessEqThan(NB_FEEBOUND);
    feeWithin.in[0] <== feeShift;
    feeWithin.in[1] <== 2 * SCALE;
    feeWithin.out === 1;

    signal xIn;    xIn    <== xHat + inHat;
    signal yOut;   yOut   <== yHat - outHat;

    component rYOut = Num2Bits(NB_AMT);
    rYOut.in <== yOut;

    signal lhs;    lhs    <== xIn * yOut;
    signal rhs;    rhs    <== xHat * yHat;

    signal R;  R <== lhs - rhs;

    signal shifted;
    shifted <== 2 * R + TOL_MULT * (xIn + yOut);

    component rR = Num2Bits(NB_BOUND);
    rR.in <== shifted;

    component within = LessEqThan(NB_BOUND);
    within.in[0] <== shifted;
    within.in[1] <== 2 * TOL_MULT * (xIn + yOut);
    within.out === 1;

    signal sHat;  sHat <== outHat - realizedHat;

    signal bpsShift;
    bpsShift <== bpsHat + BPS_OFF;
    component rBps = Num2Bits(NB_BPS + 1);
    rBps.in <== bpsShift;

    signal bpsProd;  bpsProd <== bpsHat * outHat;
    signal Rb;       Rb <== bpsProd - 10000 * SCALE * sHat;

    signal bpsW;
    bpsW <== 2 * Rb + outHat;

    component rBpsB = Num2Bits(NB_BOUND);
    rBpsB.in <== bpsW;

    component bpsWithin = LessEqThan(NB_BOUND);
    bpsWithin.in[0] <== bpsW;
    bpsWithin.in[1] <== 2 * outHat;
    bpsWithin.out === 1;
}

// Same body, plus a Poseidon commitment to the trade so the private-input
// version is a BINDING statement rather than an existence claim.
template ExecAdverseCommit(SCALE, NB_AMT, NB_FEE, NB_BOUND, NB_FEEBOUND, NB_BPS, BPS_OFF, TOL_MULT) {
    signal input xHat;
    signal input yHat;
    signal input dxHat;
    signal input fHat;
    signal input inHat;
    signal input outHat;
    signal input realizedHat;
    signal input bpsHat;
    signal output commit;

    component body = ExecAdverseBody(SCALE, NB_AMT, NB_FEE, NB_BOUND, NB_FEEBOUND, NB_BPS, BPS_OFF, TOL_MULT);
    body.xHat <== xHat;
    body.yHat <== yHat;
    body.dxHat <== dxHat;
    body.fHat <== fHat;
    body.inHat <== inHat;
    body.outHat <== outHat;
    body.realizedHat <== realizedHat;
    body.bpsHat <== bpsHat;

    component h = Poseidon(5);
    h.inputs[0] <== xHat;
    h.inputs[1] <== yHat;
    h.inputs[2] <== dxHat;
    h.inputs[3] <== fHat;
    h.inputs[4] <== realizedHat;
    commit <== h.out;
}
