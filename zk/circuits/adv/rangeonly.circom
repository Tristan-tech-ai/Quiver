pragma circom 2.1.6;
include "../../node_modules/circomlib/circuits/bitify.circom";
template T(NB_R, NB_L){
  signal input rHat; signal input lHat; signal output o;
  component a=Num2Bits(NB_R); a.in<==rHat;
  component b=Num2Bits(NB_L); b.in<==lHat;
  o<==rHat+lHat;
}
component main {public [rHat,lHat]} = T(44,30);
