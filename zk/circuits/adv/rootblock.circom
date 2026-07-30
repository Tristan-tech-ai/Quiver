pragma circom 2.1.6;
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
// exactly the root block of divergence.circom, and nothing else
template T(SCALE,NB_R,NB_S,NB_L,NB_BOUND,TOL_ROOT){
  signal input rHat; signal input sHat; signal input lHat;
  signal output rootResidual; signal output rootTolerance;
  component a=Num2Bits(NB_R); a.in<==rHat;
  component b=Num2Bits(NB_L); b.in<==lHat;
  component c=Num2Bits(NB_S); c.in<==sHat;
  component sNZ=IsZero(); sNZ.in<==sHat; sNZ.out===0;
  signal ss; ss<==sHat*sHat;
  signal Rs; Rs<==ss-rHat*SCALE;
  rootResidual<==Rs;
  rootTolerance<==2*sHat+TOL_ROOT*SCALE;
  signal shift; shift<==2*Rs+2*sHat+TOL_ROOT*SCALE;
  component br=Num2Bits(NB_BOUND); br.in<==shift;
  component w=LessEqThan(NB_BOUND); w.in[0]<==shift; w.in[1]<==2*(2*sHat+TOL_ROOT*SCALE); w.out===1;
}
component main {public [rHat,sHat,lHat]} = T(1000000000,44,38,30,72,1);
