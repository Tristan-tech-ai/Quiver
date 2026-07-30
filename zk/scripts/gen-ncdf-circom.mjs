// Emit circuits/ncdf.circom, constants and all.
//
// The circuit needs 208 exponential constants and 15 polynomial coefficients as field literals. circom
// cannot compute e^x at compile time, so they have to be written into the source — and a table written
// by hand, or copied from a double, is the trust root of the whole circuit and the easiest place for a
// silent defect. So it is GENERATED here from an exact-integer Taylor series at 200 fractional bits,
// and gateB7-5 RE-DERIVES every constant independently and refuses if one differs by a single unit.
//
//   node zk/scripts/gen-ncdf-circom.mjs          writes circuits/ncdf.circom and build/ncdf-consts.json
//
// The generator is deliberately dumb: no float arithmetic anywhere, one code path, and the parameters
// at the top are the only thing to change.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- parameters, chosen from probe-ncdf-params.mjs -----------------------------------------------
export const P = {
  // Fractional bits, and this is the ONLY real knob. The truncation range check after each of the
  // (NG + 13) multiplies costs S constraints, so the circuit's size is roughly linear in S and so is
  // the number of correct digits. MEASURED, at G=4:
  //
  //     S    worst |dN|     R1CS     Plonk    verdict
  //    44      1.65e-13     2555      4810    REFUSED — hez_final_12 tops out at 4,096
  //    40      2.69e-12        ?         ?
  //
  // 44 was built first and does not fit the ceremony file on hand. That is a measurement, not a
  // preference, and it is why S is 40: the largest scale that fits without fetching a bigger ptau,
  // which the standing rule says is a deliberate act and not a build side effect.
  S: 40,
  G: 4,           // exp decomposes W in groups of G bits: 2^G constants per group, one Mux per group
  WINT: 5,        // W = z^2/2 < 25.001 on the computed branch, so five integer bits
  XINT: 12,       // |x| < 4096 accepted; the widest |d| any sampled book produced was 386.7

  // Tolerances, in ulp, and these decide what the circuit is FOR.
  //
  // A tolerance covering only the floor remainders (TOLC = 1) makes the statement "n is the
  // fixed-point evaluation" — true, and useless to a buyer, because the service publishes a double
  // rounded to six places and that is 2.2 ulp away. A tolerance covering the fixed-point error too
  // makes the statement "n is within TOLC ulp of the TRUE normal CDF at x", which is the claim
  // somebody would pay for and which accepts the number the service already publishes.
  //
  // DERIVED in probe-ncdf-tol.mjs, term by term: 19 ulp of accumulated exp error times b/d <= 0.5,
  // plus 3.4e-3 from b, 1.7e-3 from d, plus 1.0023 for the c relation's own remainder = 10.507 ulp,
  // worst at z = 0. TOLC = ceil + 1. The sweep's worst real leg uses 18.3% of it: the derivation is
  // conservative because it adds twelve independent truncations as if they all pushed the same way.
  TOLC: 12,
  TOLP: 10,       // one SQRT2PI remainder plus 19/sqrt(2*pi) = 8.580, +1
};

// ---- exact-integer transcendentals, at 200 fractional bits --------------------------------------
const XS = 200n, XONE = 1n << XS;

/** e^{-numer/2^den} at scale 2^XS, by alternating Taylor with integer terms. No float anywhere. */
function expNegExt(numer, den) {
  const x = numer * (XONE >> BigInt(den));
  let term = XONE, sum = 0n, k = 0n;
  for (;;) {
    sum += (k % 2n === 0n ? term : -term);
    k += 1n;
    term = (term * x) / (XONE * k);
    if (term === 0n) break;
    if (k > 1500n) throw new Error('Taylor did not terminate');
  }
  return sum;
}

/** Integer sqrt of n (floor), Newton. Used for sqrt(2*pi) at 2^XS. */
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/** pi at scale 2^XS, by Machin: pi = 16*atan(1/5) - 4*atan(1/239), atan by integer series. */
function piExt() {
  const atanInv = (n) => {              // atan(1/n) at scale 2^XS
    const n2 = BigInt(n) * BigInt(n);
    let term = XONE / BigInt(n), sum = 0n, k = 0n;
    while (term !== 0n) {
      sum += (k % 2n === 0n ? term / (2n * k + 1n) : -(term / (2n * k + 1n)));
      k += 1n;
      term = term / n2;
    }
    return sum;
  };
  return 16n * atanInv(5) - 4n * atanInv(239);
}

export function constants({ S, G, WINT }) {
  const Sb = BigInt(S), ONE = 1n << Sb;
  const WBITS = WINT + S;
  const NG = Math.ceil(WBITS / G);
  const toS = (v) => (v + (1n << (XS - Sb - 1n))) >> (XS - Sb);   // round-to-nearest down to 2^-S

  // exp table: group g, entry j  ->  e^{-(j << (g*G)) / 2^S}
  const EXP = [];
  for (let g = 0; g < NG; g++) {
    const row = [];
    for (let j = 0; j < 2 ** G; j++) {
      const numer = BigInt(j) << BigInt(g * G);
      row.push(numer === 0n ? ONE : toS(expNegExt(numer, S)));
    }
    EXP.push(row);
  }

  // Hart's coefficients. Decimal literals -> 2^-S by exact BigInt rounding, never through a double.
  const fx = (str) => {
    const D = 45;
    const [w, f = ''] = str.split('.');
    const num = (BigInt(w) * 10n ** BigInt(D) + BigInt(f.padEnd(D, '0').slice(0, D))) * ONE;
    const den = 10n ** BigInt(D);
    return (num + den / 2n) / den;
  };
  const BC = ['0.0352624965998911', '0.700383064443688', '6.37396220353165', '33.912866078383',
    '112.079291497871', '221.213596169931', '220.206867912376'].map(fx);
  const DC = ['0.0883883476483184', '1.75566716318264', '16.064177579207', '86.7807322029461',
    '296.564248779674', '637.333633378831', '793.826512519948', '440.413735824752'].map(fx);

  // sqrt(2*pi), for the density. Computed, not quoted: sqrt(2*pi) at 2^S = isqrt(2*pi * 2^(2S)).
  const pi = piExt();
  const twoPiAt2S = (2n * pi * (1n << (2n * Sb))) >> XS;
  const SQRT2PI = isqrt(twoPiAt2S);

  // The branch point Hart itself uses, and it is not arbitrary: 7.07106781186547^2 = 50.0000..., so
  // z^2/2 = 25 exactly at the split and WINT = 5 bits is the tight choice rather than a guess.
  const ZSPLIT = fx('7.07106781186547');

  // ---- the two tail bounds, and the first attempt at these was WRONG ---------------------------
  // Above the split the circuit asserts a bound instead of computing. Both functions are decreasing
  // there, so the bound is the value AT the split. The obvious way to get it is to run the S-scaled
  // recurrences at the split — and at S=40 that produced PHI_TAIL = 6 ulp against a true 6.09 ulp, a
  // bound the real tail VIOLATES. e^{-25} at 2^-40 is the integer 15, and every relative error in a
  // 15 is 6.7%; the bound inherited it. Diagnostic shape: a value at the representation floor cannot
  // be used to derive a bound on itself.
  //
  // So both are computed at 200 fractional bits, rounded UP, plus one ulp of margin. gateB7-5
  // measures the true maximum over the tail and refuses if either constant is under it.
  const fxExt = (str) => {
    const D = 45;
    const [w2, f = ''] = str.split('.');
    const num = (BigInt(w2) * 10n ** BigInt(D) + BigInt(f.padEnd(D, '0').slice(0, D))) * XONE;
    return (num + 10n ** BigInt(D) / 2n) / 10n ** BigInt(D);
  };
  const mulX = (a, b) => (a * b) >> XS;
  const zX = ZSPLIT << (XS - Sb);                 // the split point, at 2^-XS
  const eX = expNegExt(ZSPLIT * ZSPLIT, 2 * S + 1);   // e^{-z^2/2} at the split, exactly
  const sqrt2piX = isqrt((2n * pi) << XS);
  let bX = fxExt('0.0352624965998911');
  for (const c of ['0.700383064443688', '6.37396220353165', '33.912866078383', '112.079291497871',
    '221.213596169931', '220.206867912376']) bX = mulX(bX, zX) + fxExt(c);
  let dX = fxExt('0.0883883476483184');
  for (const c of ['1.75566716318264', '16.064177579207', '86.7807322029461', '296.564248779674',
    '637.333633378831', '793.826512519948', '440.413735824752']) dX = mulX(dX, zX) + fxExt(c);
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const shiftDown = XS - Sb;
  // NOT mulX(eX, XONE) / sqrt2piX. mulX already shifts down by XS, so that expression divides a plain
  // integer by a 2^XS-scaled one and floors to nothing: it returned PHI_TAIL = 1 where 8 is right.
  // Diagnostic shape — the answer was low by a clean 2^XS, which is a wrong-exponent bug, not a
  // wrong formula. The scale has to survive the divide, so the numerator carries XONE.
  const PHI_TAIL = ceilDiv((eX * XONE) / sqrt2piX, 1n << shiftDown) + 1n;
  const CDF_TAIL = ceilDiv(mulX(eX, bX) * XONE / dX, 1n << shiftDown) + 1n;

  return { S, G, WINT, WBITS, NG, ONE, EXP, BC, DC, SQRT2PI, ZSPLIT, PHI_TAIL, CDF_TAIL, pi };
}

// ---- emit ----------------------------------------------------------------------------------------
function emit(C, P) {
  const { S, G, WBITS, NG, ONE, EXP, BC, DC, SQRT2PI, ZSPLIT, PHI_TAIL, CDF_TAIL } = C;
  const NB_X = P.XINT + S;                       // |x| register

  // Residual widths, DERIVED from the coefficients rather than rounded up to a comfortable number. A
  // generous NB_R is not free: LessEqThan(n) decomposes n+1 bits, so every spare bit on these two is a
  // constraint, and 130 where 104 does the work is 52 wasted constraints across the pair. That is a
  // third of what this circuit was over the ceremony ceiling by.
  const bits = (v) => BigInt(v).toString(2).length;
  const bMax = BC.reduce((a, c) => (a * ZSPLIT >> BigInt(S)) + c, 0n);   // b(7.0711), same recurrence
  const dMax = DC.reduce((a, c) => (a * ZSPLIT >> BigInt(S)) + c, 0n);
  // cShift = 2*(cHat*dHat - eHat*bHat) + (dHat + ONE); cHat <= ONE/2, eHat <= ONE.
  const NB_R = Math.max(bits(ONE / 2n * dMax), bits(ONE * bMax)) + 2;
  // pShift = 2*(pHat*SQRT2PI - eHat*ONE) + SQRT2PI; pHat < ONE.
  const NB_P = Math.max(bits(ONE * SQRT2PI), bits(ONE * ONE)) + 2;
  const L = [];
  const w = (s = '') => L.push(s);

  w('pragma circom 2.1.6;');
  w('');
  w('// GENERATED by zk/scripts/gen-ncdf-circom.mjs — do not hand-edit. Regenerate and re-gate.');
  w('//');
  w('// THE STANDARD NORMAL CDF, COMPUTED IN A CIRCUIT.');
  w('//');
  w('// The roadmap said options-risk "requires exp and erf in-circuit, which is where this stops being');
  w('// arithmetic and starts being a research project", and greeksfp/greekssigned/parity were built to');
  w('// route around it by proving CONSISTENCY identities that cancel the transcendental instead of');
  w('// evaluating it. probe-cdf-residue.mjs measured the cost of that route: a service using');
  w('// Abramowitz-Stegun 7.1.26 instead of Hart satisfies ALL EIGHT identities to 3.3e-14 and prices a');
  w('// leg 19.4% wrong. So the identities are blind to the thing that matters, and put-call parity is');
  w('// blind too — the put is P = df*(K*N(-d2) - F*N(-d1)), so any N with N(-x) = 1 - N(x) makes');
  w('// C - P = df*(F - K) hold ALGEBRAICALLY with N cancelling.');
  w('//');
  w('// The premise was wrong, in the same way the Tier-3 premise was wrong. "erf" is not what the');
  w('// engine computes. The engine computes HART (1968):');
  w('//');
  w('//     N(-z) = e^{-z^2/2} * b(z) / d(z)        for 0 <= z < 7.0711');
  w('//');
  w('// A ratio is a multiplication: c*d = e*b. A polynomial is Horner. That leaves one transcendental,');
  w('// e^{-w} — and e^{-w} FACTORS over the binary expansion of w in a way erf does not:');
  w('//');
  w('//     w = sum_i b_i 2^i    =>    e^{-w} = prod_i (e^{-2^i})^{b_i}');
  w('//');
  w('// Every factor is a constant and every choice is a multiplexer, so exp is a product of selected');
  w('// constants — which is what a circuit does natively. The wall was never the transcendental. It was');
  w('// the fixed-point representation, exactly as it was for Tier 3.');
  w('//');
  w('// ── WHAT IS PROVEN ──');
  w('//   for the public point x, the public value n is the normal CDF at x, and the public value p is');
  w('//   its density, both evaluated by the recurrences below. The evaluator is pinned, not asserted:');
  w('//   every multiply carries a range-checked remainder, so the prover cannot choose a rounding.');
  w('//');
  w('// ── WHAT IS NOT ──');
  w('//   this pins n GIVEN x. It does not pin x. For options-risk, x is d1 or d2, and pinning those');
  w('//   needs ln(F/K) — which is the same exp gadget run backwards (L is the log of F/K iff');
  w('//   K*exp(L) = F), so it is another instance of this block and not a new problem. NOT BUILT HERE.');
  w('//   What IS measured in gateB7-5: n and p together over-determine x, so a caller who binds p to a');
  w('//   published gamma and n to a published delta pins x without any logarithm at all.');
  w('//');
  w('// ── THE TAIL ──');
  w('//   Hart switches to a continued fraction at z = 7.0711. This circuit does NOT carry that branch.');
  w('//   Above the split it proves a BOUND instead: the upper tail is under ' + CDF_TAIL.toString() + ' / 2^' + S + ', and the');
  w('//   density under ' + PHI_TAIL.toString() + ' / 2^' + S + '. That is a real weakening and it is published as `computed`, so a');
  w('//   reader can see which of the two statements they were given. Measured over a listed-book shape,');
  w('//   1.03% of legs land there; over a one-hour-to-one-week wing, 46.79% do.');
  w('//');
  w(`// ── SCALE ── every quantity is an integer at 2^-${S}. The truncating multiply`);
  w('//   out * 2^S + rem = a * b,  0 <= rem < 2^S');
  w('//   is one constraint plus an S-bit range check, and it is the dominant cost: 26 of them.');
  w('');
  w('include "../node_modules/circomlib/circuits/bitify.circom";');
  w('include "../node_modules/circomlib/circuits/comparators.circom";');
  w('include "../node_modules/circomlib/circuits/mux4.circom";');
  w('');

  // --- the truncating multiply, as its own template so there is one copy of it -------------------
  w('// a * b >> S, with the discarded remainder range-checked so the prover cannot pick a rounding.');
  w('// Without the range check `out` is unconstrained below the S-th bit and the whole evaluator is');
  w('// decoration — the same failure the mantissa lower bound in greeksfp existed to prevent.');
  w('template MulShift(S) {');
  w('    signal input a;');
  w('    signal input b;');
  w('    signal output out;');
  w('    signal rem;');
  w('    signal prod;');
  w('    prod <== a * b;');
  w('    out <-- prod \\ (1 << S);');
  w('    rem <-- prod % (1 << S);');
  w('    prod === out * (1 << S) + rem;');
  w('    component rb = Num2Bits(S);');
  w('    rb.in <== rem;');
  w('}');
  w('');

  w(`template NormalCdf() {`);
  w(`    var S      = ${S};`);
  w(`    var ONE    = ${ONE};                 // 1.0`);
  w(`    var NB_X   = ${NB_X};`);
  w(`    var NB_R   = ${NB_R};                       // derived: max(cHat*dHat, eHat*bHat) + 2, not rounded up`);
  w(`    var NB_P   = ${NB_P};`);
  w(`    var TOLC   = ${P.TOLC};                        // ulp; derived, see the block at the c relation`);
  w(`    var TOLP   = ${P.TOLP};`);
  w(`    var ZSPLIT = ${ZSPLIT};      // 7.07106781186547, where Hart changes branch`);
  w(`    var SQRT2PI = ${SQRT2PI};     // computed by Machin + integer sqrt, not quoted from a table`);
  w(`    var CDF_TAIL = ${CDF_TAIL};                   // N(-7.0711), the tail bound`);
  w(`    var PHI_TAIL = ${PHI_TAIL};                  // phi(7.0711), the density bound`);
  w('');
  w('    // ---- public interface -----------------------------------------------------------------');
  w('    signal input xSign;      // 0 when x >= 0, 1 when x < 0');
  w('    signal input xMag;       // |x| * 2^S');
  w('    signal input nHat;       // the claimed N(x) * 2^S');
  w('    signal input pHat;       // the claimed density phi(x) * 2^S');
  w('');
  w('    signal output computed;  // 1 when the CDF was evaluated, 0 when only the tail bound was proven');
  w('    signal output tailC;     // the bound in force above the split, published so it is not implied');
  w('    signal output tailP;');
  w('    tailC <== CDF_TAIL;');
  w('    tailP <== PHI_TAIL;');
  w('');
  w('    xSign * (xSign - 1) === 0;');
  w('    component rx = Num2Bits(NB_X);   rx.in <== xMag;');
  w('    component rn = Num2Bits(S + 1);  rn.in <== nHat;      // N is in [0,1], so S+1 bits is exact');
  w('    component rp = Num2Bits(S);      rp.in <== pHat;      // phi <= 0.3990 < 1');
  w('    component nLe = LessEqThan(S + 2); nLe.in[0] <== nHat; nLe.in[1] <== ONE; nLe.out === 1;');
  w('');
  w('    // ---- which branch -------------------------------------------------------------------');
  w('    component split = LessThan(NB_X + 1);');
  w('    split.in[0] <== xMag;');
  w('    split.in[1] <== ZSPLIT;');
  w('    computed <== split.out;');
  w('');
  w('    // The evaluator ALWAYS runs, on a clamped argument, so its own range checks can never be the');
  w('    // thing that fails on a tail input. Only the binding of its output to nHat/pHat is conditional.');
  w('    // Running it on the raw xMag instead would make W overflow at |x| = 386, which a real book');
  w('    // reaches, and the circuit would refuse where it means to bound.');
  w('    signal zc;');
  w('    zc <== xMag + (1 - computed) * (ZSPLIT - 1 - xMag);');
  w('');
  w('    // ---- W = z^2 / 2, at 2^-S ------------------------------------------------------------');
  w('    signal sq;');
  w('    sq <== zc * zc;');
  w('    signal W;');
  w('    signal wRem;');
  w(`    W    <-- sq \\ (1 << ${S + 1});`);
  w(`    wRem <-- sq % (1 << ${S + 1});`);
  w(`    sq === W * (1 << ${S + 1}) + wRem;`);
  w(`    component wrb = Num2Bits(${S + 1});  wrb.in <== wRem;`);
  w(`    component wbits = Num2Bits(${WBITS});  wbits.in <== W;`);
  w('');
  w(`    // ---- e^{-W}: ${NG} groups of ${G} bits, one Mux4 and one MulShift each -------------------------`);
  w(`    // ${NG * 2 ** G} constants, generated at 200 fractional bits and re-derived by the gate.`);
  w(`    component mx[${NG}];`);
  w(`    component em[${NG}];`);
  w(`    signal acc[${NG + 1}];`);
  w('    acc[0] <== ONE;');
  for (let g = 0; g < NG; g++) {
    w(`    mx[${g}] = Mux4();`);
    for (let j = 0; j < 2 ** G; j++) w(`    mx[${g}].c[${j}] <== ${EXP[g][j]};`);
    for (let k = 0; k < G; k++) {
      const bit = g * G + k;
      w(`    mx[${g}].s[${k}] <== ${bit < WBITS ? `wbits.out[${bit}]` : '0'};`);
    }
    w(`    em[${g}] = MulShift(S);   em[${g}].a <== acc[${g}];   em[${g}].b <== mx[${g}].out;   acc[${g + 1}] <== em[${g}].out;`);
  }
  w('    signal eHat;');
  w(`    eHat <== acc[${NG}];`);
  w('');
  w('    // ---- Hart\'s two polynomials, Horner ----------------------------------------------------');
  w(`    component bm[${BC.length - 1}];`);
  w(`    signal bh[${BC.length}];`);
  w(`    bh[0] <== ${BC[0]};`);
  for (let i = 1; i < BC.length; i++) {
    w(`    bm[${i - 1}] = MulShift(S);   bm[${i - 1}].a <== bh[${i - 1}];   bm[${i - 1}].b <== zc;   bh[${i}] <== bm[${i - 1}].out + ${BC[i]};`);
  }
  w(`    component dm[${DC.length - 1}];`);
  w(`    signal dh[${DC.length}];`);
  w(`    dh[0] <== ${DC[0]};`);
  for (let i = 1; i < DC.length; i++) {
    w(`    dm[${i - 1}] = MulShift(S);   dm[${i - 1}].a <== dh[${i - 1}];   dm[${i - 1}].b <== zc;   dh[${i}] <== dm[${i - 1}].out + ${DC[i]};`);
  }
  w('    signal bHat;  signal dHat;');
  w(`    bHat <== bh[${BC.length - 1}];`);
  w(`    dHat <== dh[${DC.length - 1}];`);
  w('');
  w('    // ---- c, the upper tail, and its relation to n -----------------------------------------');
  w('    // Hart returns the UPPER tail c and the CDF is c for x <= 0 and 1 - c for x > 0. Written as');
  w('    // one quadratic rather than a branch, since a circuit has no branches.');
  w('    signal cHat;');
  w('    cHat <== ONE - nHat + xSign * (2 * nHat - ONE);');
  w('    // c is an upper tail at |x| >= 0, so it never exceeds a half. Cheap, and it stops a prover');
  w('    // handing in the complement and letting the sign bit absorb it.');
  w('    component cLe = LessEqThan(S + 2);  cLe.in[0] <== cHat;  cLe.in[1] <== ONE \\ 2;  cLe.out === 1;');
  w('');
  w('    // c*d = e*b, which is the division without dividing. An absolute error of T ulp in c shows up');
  w('    // here as T*dHat, so the tolerance is TOLC*dHat and TOLC reads directly in ulp.');
  w(`    // TOLC = ${P.TOLC}, DERIVED in probe-ncdf-tol.mjs and not chosen: 19 ulp of accumulated exp error`);
  w('    // times b/d <= 0.5, plus 3.4e-3 from b, 1.7e-3 from d, plus 1.0023 for this relation\'s own');
  w('    // floor remainder = 10.507 ulp worst, at z = 0. The real engine\'s worst leg uses 18.3% of it,');
  w(`    // and gateB7-5 shows a value ${P.TOLC + 1} ulp out IS refused — otherwise it is not a bound.`);
  w('    signal lhs;   lhs <== cHat * dHat;');
  w('    signal eb;    eb  <== eHat * bHat;');
  w('    signal resid; resid <== computed * (lhs - eb);');
  w('    signal tolC;  tolC <== TOLC * dHat;');
  w('    signal cShift; cShift <== 2 * resid + tolC;');
  w('    // NO separate Num2Bits on cShift. LessEqThan(n) already decomposes in[0] + 2^n - in[1] into');
  w('    // n+1 bits, so a cShift that is out of range — including a field-wrapped negative one — makes');
  w('    // that decomposition unsatisfiable and the prover cannot produce a witness at all. The extra');
  w('    // check the sibling circuits carry can only turn an accept into a refusal, never the reverse,');
  w('    // and it costs NB_R constraints. gateB7-5 confirms the refusal by hand rather than trusting');
  w('    // this paragraph.');
  w('    component cOk = LessEqThan(NB_R); cOk.in[0] <== cShift; cOk.in[1] <== 2 * tolC; cOk.out === 1;');
  w('');
  w('    // ---- the density, which the CDF has already computed ----------------------------------');
  w('    // phi(x) = e^{-x^2/2}/sqrt(2*pi), and e^{-x^2/2} is `eHat`, the exp intermediate above. So the');
  w('    // density costs one multiply. This matters more than it looks: df*phi(d1) is the factor that');
  w('    // CANCELS between any two greeks, which is what let the consistency identities exist without a');
  w('    // transcendental. Pinning it is what stops it cancelling.');
  w('    signal pd;    pd <== pHat * SQRT2PI;');
  w('    signal pe;    pe <== eHat * ONE;');
  w('    signal presid; presid <== computed * (pd - pe);');
  w('    signal tolP;  tolP <== TOLP * SQRT2PI;');
  w('    signal pShift; pShift <== 2 * presid + tolP;');
  w('    component pOk = LessEqThan(NB_P); pOk.in[0] <== pShift; pOk.in[1] <== 2 * tolP; pOk.out === 1;');
  w('');
  w('    // ---- above the split, the bound ------------------------------------------------------');
  w('    // Both functions are decreasing on the tail, so their value AT the split is the maximum over');
  w('    // it. gateB7-5 measures the true maximum and refuses if either constant is under it.');
  w('    signal tailc;  tailc <== (1 - computed) * cHat;');
  w('    component tcOk = LessEqThan(S + 2); tcOk.in[0] <== tailc; tcOk.in[1] <== CDF_TAIL; tcOk.out === 1;');
  w('    signal tailp;  tailp <== (1 - computed) * pHat;');
  w('    component tpOk = LessEqThan(S + 2); tpOk.in[0] <== tailp; tpOk.in[1] <== PHI_TAIL; tpOk.out === 1;');
  w('}');
  w('');
  w('component main {public [xSign, xMag, nHat, pHat]} = NormalCdf();');
  w('');
  return L.join('\n');
}

const C = constants(P);
const src = emit(C, P);
mkdirSync(path.join(ZK, 'build'), { recursive: true });
writeFileSync(path.join(ZK, 'circuits', 'ncdf.circom'), src, 'utf8');
writeFileSync(path.join(ZK, 'build', 'ncdf-consts.json'), JSON.stringify({
  params: P,
  S: C.S, G: C.G, WINT: C.WINT, WBITS: C.WBITS, NG: C.NG,
  ONE: C.ONE.toString(), ZSPLIT: C.ZSPLIT.toString(), SQRT2PI: C.SQRT2PI.toString(),
  CDF_TAIL: C.CDF_TAIL.toString(), PHI_TAIL: C.PHI_TAIL.toString(),
  EXP: C.EXP.map((r) => r.map(String)), BC: C.BC.map(String), DC: C.DC.map(String),
}, null, 2) + '\n', 'utf8');

console.log(`wrote circuits/ncdf.circom  (${src.split('\n').length} lines)`);
console.log(`wrote build/ncdf-consts.json (${C.NG * 2 ** C.G} exp constants, ${C.BC.length + C.DC.length} coefficients)`);
console.log(`  S=${C.S} · G=${C.G} · ${C.NG} groups · W register ${C.WBITS} bits`);
console.log(`  ZSPLIT ${C.ZSPLIT}  SQRT2PI ${C.SQRT2PI}`);
console.log(`  CDF_TAIL ${C.CDF_TAIL} (= ${Number(C.CDF_TAIL) / Number(C.ONE)})  PHI_TAIL ${C.PHI_TAIL} (= ${Number(C.PHI_TAIL) / Number(C.ONE)})`);
