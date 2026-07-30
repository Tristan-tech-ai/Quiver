pragma circom 2.1.6;
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
// The SAME identity with the square root eliminated by squaring both sides:
//   L(1+r) = 2*sqrt(r)   =>   L^2 (1+r)^2 = 4 r
// scaled:  Lhat^2 (S + rhat)^2 = 4 * rhat * S^3.   No sHat signal exists here at all.
template T(SCALE,NB_R,NB_L,NB_BOUND,TOL){
  signal input rHat; signal input lHat;
  signal output residual; signal output tolerance;
  component a=Num2Bits(NB_R); a.in<==rHat;
  component b=Num2Bits(NB_L); b.in<==lHat;
  component rNZ=IsZero(); rNZ.in<==rHat; rNZ.out===0;
  component lP=LessEqThan(NB_L); lP.in[0]<==lHat; lP.in[1]<==SCALE; lP.out===1;
  signal l2; l2<==lHat*lHat;
  signal opr; opr<==SCALE+rHat;
  signal opr2; opr2<==opr*opr;
  signal lhs; lhs<==l2*opr2;
  signal R; R<==lhs-4*rHat*SCALE*SCALE*SCALE;
  residual<==R;
  // the squared identity's slack scales with the squared quantities, so the bound does too
  tolerance<==2*lHat*opr2+TOL*SCALE*SCALE*SCALE;
  signal shift; shift<==2*R+tolerance;
  component br=Num2Bits(NB_BOUND); br.in<==shift;
  component w=LessEqThan(NB_BOUND); w.in[0]<==shift; w.in[1]<==2*tolerance; w.out===1;
}
component main {public [rHat,lHat]} = T(1000000000,44,30,160,1);
