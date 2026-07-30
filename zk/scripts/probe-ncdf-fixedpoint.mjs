// PROBE — can the normal CDF be COMPUTED in a circuit, not merely bounded?
//
// The roadmap says options-risk "requires exp and erf in-circuit, which is where this stops being
// arithmetic and starts being a research project". That sentence conflates two things:
//
//   erf as a TRANSCENDENTAL   — a circuit cannot evaluate an infinite series, true
//   erf as it is ACTUALLY COMPUTED — the engine uses Hart (1968), which is
//                                    e^{-z^2/2} * b(z)/d(z), a ratio of two POLYNOMIALS
//
// A ratio is a multiplication: c*d = e*b. A polynomial is Horner. That leaves exactly one
// transcendental, e^{-w}, and e^{-w} has a structure erf does not: it FACTORS over the binary
// expansion of w.
//
//     w = sum b_i 2^i   =>   e^{-w} = prod (e^{-2^i})^{b_i}
//
// Every factor is a hardcoded constant and every selection is a multiplexer. So exp is a product of
// selected constants, which a circuit does natively. This is the same shape as the Tier-3 finding: the
// wall was never the transcendental, it was the fixed-point representation.
//
// This probe does not argue that. It IMPLEMENTS Hart in pure BigInt integer arithmetic — every
// operation one a circuit can hold, no floats anywhere in the evaluator — and measures the error
// against the engine's own double-precision ncdf. It also measures the alternative (a monotone table
// bracket, which BOUNDS rather than computes) so the two can be compared in price terms.
//
//   node zk/scripts/probe-ncdf-fixedpoint.mjs
import { load } from './service-root.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');

// ---- the engine's CDF, mirrored so this file can compare without importing a private symbol -------
function hart(x) {
  const z = Math.abs(x);
  let c = 0;
  if (z <= 37) {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165; b = b * z + 33.912866078383; b = b * z + 112.079291497871;
      b = b * z + 221.213596169931; b = b * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207; d = d * z + 86.7807322029461; d = d * z + 296.564248779674;
      d = d * z + 637.333633378831; d = d * z + 793.826512519948; d = d * z + 440.413735824752;
      c = e * b / d;
    } else {
      let f = z + 0.65; f = z + 4 / f; f = z + 3 / f; f = z + 2 / f; f = z + 1 / f;
      c = e / (2.506628274631 * f);
    }
  }
  return x <= 0 ? c : 1 - c;
}

// =================================================================================================
// FIXED POINT. One scale, 2^-S, used for every quantity. Integers only below this line.
// =================================================================================================
const S = 44n;                      // fractional bits
const ONE = 1n << S;
const GBITS = 4n;                   // exp decomposes w in groups of this many bits
const WINT = 5n;                    // w = z^2/2 < 25.01 for z < 7.0711, so five integer bits
const WBITS = WINT + S;             // total bits of the W register

// Truncating multiply: the circuit form is  a*b = out*2^S + rem, 0 <= rem < 2^S, one range check.
const mulS = (a, b) => (a * b) >> S;

// A high-precision decimal -> fixed point, done in BigInt so the conversion itself is exact and does
// not inherit a double's rounding. `str` is a decimal literal; extra digits are kept.
function fx(str) {
  const neg = str.startsWith('-');
  const s = neg ? str.slice(1) : str;
  const [w, f = ''] = s.split('.');
  const digits = 40;
  const fp = f.padEnd(digits, '0').slice(0, digits);
  // value = (w*10^digits + fp) / 10^digits, scaled by 2^S, rounded to nearest.
  const num = (BigInt(w) * 10n ** BigInt(digits) + BigInt(fp)) * ONE;
  const den = 10n ** BigInt(digits);
  const q = (num + den / 2n) / den;
  return neg ? -q : q;
}

// e^{-2^k} for every bit position the decomposition can reach, precomputed to 40 decimal places by
// repeated BigInt squaring of a high-precision e^{-2^{-S}}? No: that needs a series. Instead the
// constants come from an exact-integer Taylor evaluation at extended precision, below.
//
// EXTENDED-PRECISION e^{-x} for the CONSTANT TABLE ONLY. This runs at build time in a circuit, so it
// may be as expensive as it likes; it just must not be a double, or the table inherits 1e-16 error
// where the table is the thing everything else rests on.
const XS = 160n;                    // 160 fractional bits for the table computation
const XONE = 1n << XS;
function expNegExtended(numer, denomPow2) {
  // returns e^{-numer/2^denomPow2} at scale 2^XS, by Taylor with exact integer terms.
  const xNum = numer * (XONE >> BigInt(denomPow2));  // x at scale XS
  let term = XONE, sum = 0n, k = 0n;
  // alternating series; x <= 32 so ~200 terms is ample and cheap in BigInt
  for (;;) {
    sum += (k % 2n === 0n ? term : -term);
    k += 1n;
    term = (term * xNum) / (XONE * k);
    if (term === 0n) break;
    if (k > 900n) break;
  }
  return sum;
}
const toS = (v) => (v + (1n << (XS - S - 1n))) >> (XS - S);

// GROUPED constant table. Group g covers bits [g*GBITS, g*GBITS+GBITS) of W. Entry j of group g is
// e^{-(j * 2^(g*GBITS)) / 2^S} at scale 2^S. A circuit reads this with one Mux over GBITS bits.
const NGROUPS = Number((WBITS + GBITS - 1n) / GBITS);
const TABLE = [];
for (let g = 0; g < NGROUPS; g++) {
  const row = [];
  const shift = BigInt(g) * GBITS;
  for (let j = 0; j < Number(1n << GBITS); j++) {
    const numer = BigInt(j) << shift;                    // the value of this group, at scale 2^S
    row.push(numer === 0n ? ONE : toS(expNegExtended(numer, Number(S))));
  }
  TABLE.push(row);
}

// exp(-w) where W = w * 2^S. Exactly the circuit's control flow: decompose, mux per group, multiply.
function expNegFx(W) {
  let p = ONE;
  for (let g = 0; g < NGROUPS; g++) {
    const j = Number((W >> (BigInt(g) * GBITS)) & ((1n << GBITS) - 1n));
    p = mulS(p, TABLE[g][j]);
  }
  return p;
}

// Hart's two polynomials, coefficients at scale 2^S. Horner, one truncating multiply per step.
const BC = ['0.0352624965998911', '0.700383064443688', '6.37396220353165', '33.912866078383',
  '112.079291497871', '221.213596169931', '220.206867912376'].map(fx);
const DC = ['0.0883883476483184', '1.75566716318264', '16.064177579207', '86.7807322029461',
  '296.564248779674', '637.333633378831', '793.826512519948', '440.413735824752'].map(fx);

const Z_SPLIT = fx('7.07106781186547');   // the branch Hart itself uses
// A tail bound the circuit asserts instead of computing: for z >= 7.0711 the upper tail is under
// 1e-12, so N(x) is within that of 0 or 1 and a price cannot notice. MEASURED below, not assumed.
const TAIL_BOUND = fx('0.000000000001');

/** The whole CDF, in integers, with the branch a circuit would take. Returns Nhat at scale 2^S. */
function ncdfFx(Xhat) {
  const zh = Xhat < 0n ? -Xhat : Xhat;
  let c;
  if (zh < Z_SPLIT) {
    const W = mulS(zh, zh) / 2n;                 // z^2/2
    const e = expNegFx(W);
    let b = BC[0];
    for (let i = 1; i < BC.length; i++) b = mulS(b, zh) + BC[i];
    let d = DC[0];
    for (let i = 1; i < DC.length; i++) d = mulS(d, zh) + DC[i];
    // c = e*b/d. In a circuit c is a witness and c*d = e*b is the constraint; here the division is
    // done so the probe has a value to measure, and it is the SAME value the constraint pins.
    c = (mulS(e, b) * ONE) / d;
  } else {
    c = 0n;                                       // the tail branch: bounded, not computed
  }
  return Xhat <= 0n ? c : ONE - c;
}

const toNum = (v) => Number(v) / Number(ONE);

// =================================================================================================
// MEASUREMENT
// =================================================================================================
console.log(`FIXED-POINT NORMAL CDF PROBE — ${new Date().toISOString()}\n`);
console.log(`  scale 2^-${S} (${(1 / 2 ** Number(S)).toExponential(2)}) · exp in ${NGROUPS} groups of ${GBITS} bits · W register ${WBITS} bits\n`);

// ---- 0. the constant table must be right, or nothing else means anything ------------------------
{
  let worst = 0;
  for (let g = 0; g < NGROUPS; g++) {
    for (let j = 1; j < TABLE[g].length; j++) {
      const w = (j * 2 ** (g * Number(GBITS))) / 2 ** Number(S);
      const want = Math.exp(-w);
      const got = toNum(TABLE[g][j]);
      if (want > 1e-300) worst = Math.max(worst, Math.abs(got - want));
    }
  }
  console.log(`  constant table vs Math.exp: worst ABSOLUTE ${worst.toExponential(2)}   (${NGROUPS * Number(1n << GBITS)} entries)`);
  if (worst > 1e-12) { console.log('  ABORT — the table is wrong.'); process.exit(1); }
}

// ---- 1. exp alone --------------------------------------------------------------------------------
{
  let worstAbs = 0, worstRel = 0, at = 0;
  for (let i = 0; i <= 25000; i++) {
    const w = (i / 25000) * 25;
    const W = BigInt(Math.round(w * Number(ONE)));
    const got = toNum(expNegFx(W)), want = Math.exp(-w);
    const a = Math.abs(got - want);
    if (a > worstAbs) { worstAbs = a; at = w; }
    if (want > 1e-30) worstRel = Math.max(worstRel, a / want);
  }
  console.log(`  exp(-w), w in [0,25]: worst ABS ${worstAbs.toExponential(2)} at w=${at.toFixed(4)} · worst REL ${worstRel.toExponential(2)}`);
}

// ---- 2. the CDF, over the whole range -----------------------------------------------------------
{
  let worstAbs = 0, at = 0, worstMain = 0, worstTail = 0;
  const N = 200001;
  for (let i = 0; i < N; i++) {
    const x = -12 + (24 * i) / (N - 1);
    const Xhat = BigInt(Math.round(x * Number(ONE)));
    const got = toNum(ncdfFx(Xhat)), want = hart(x);
    const a = Math.abs(got - want);
    if (a > worstAbs) { worstAbs = a; at = x; }
    if (Math.abs(x) < 7.07106781186547) worstMain = Math.max(worstMain, a); else worstTail = Math.max(worstTail, a);
  }
  console.log(`  ncdf over x in [-12,12], ${N} points:`);
  console.log(`    worst ABS error overall        ${worstAbs.toExponential(2)}  at x=${at.toFixed(5)}`);
  console.log(`    worst on the COMPUTED branch   ${worstMain.toExponential(2)}  (|x| < 7.0711)`);
  console.log(`    worst on the BOUNDED tail      ${worstTail.toExponential(2)}  (|x| >= 7.0711, circuit asserts <= ${toNum(TAIL_BOUND).toExponential(0)} instead of computing)`);
  globalThis.__worstMain = worstMain; globalThis.__worstTail = worstTail; globalThis.__worstAbs = worstAbs;
}

// ---- 3. the ALTERNATIVE: a monotone table bracket, which bounds instead of computing -------------
// This is the honest fallback the brief asks about: monotonicity + endpoints + a ladder of known
// values. A circuit holding only that learns N(x) lies between two tabulated anchors. Its width is
// what has to be compared against computing.
console.log(`\n  For comparison — MONOTONE BRACKET, the "bound it, do not compute it" option.`);
console.log(`  N is increasing, so x in [a_i, a_{i+1}] gives N(x) in [N(a_i), N(a_{i+1})].`);
console.log(`  A tighter variant uses the tabulated DENSITY at both anchors: on x > 0 the density is`);
console.log(`  decreasing, so N(a_i) + phi(a_{i+1})*(x-a_i) <= N(x) <= N(a_i) + phi(a_i)*(x-a_i).`);
console.log('');
console.log(`  ${'anchors, [-8,8]'.padEnd(18)}${'spacing'.padStart(10)}${'plain bracket'.padStart(16)}${'density bracket'.padStart(17)}${'price envelope'.padStart(16)}`);

// The price envelope: price = df*(F*N(d1) - K*N(d2)), so an absolute uncertainty u in each N gives a
// price uncertainty of up to (F + K)*u. Reported for one concrete, unremarkable leg so the number is
// in dollars and not in abstract units.
const REF = { F: 100000, K: 100000, T: 30 / 365, sigma: 0.6 };
const refPrice = black76(REF.F, REF.K, REF.T, REF.sigma, 'call', 0).price;
const priceEnv = (u) => (REF.F + REF.K) * u;

const npdfJs = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
const bracketRows = [];
for (const K of [64, 256, 1024, 4096, 16384]) {
  const h = 16 / K;
  let plain = 0, dens = 0;
  // Worst case over every cell, evaluated at the interior point that maximises each width.
  for (let i = 0; i < K; i++) {
    const a = -8 + i * h, b = a + h;
    plain = Math.max(plain, hart(b) - hart(a));
    // density bracket: width = (phi(lo) - phi(hi)) * (x - a), worst at x = b, using the correct
    // monotone direction of phi on each side of zero. A cell straddling 0 gets the crude bound
    // (phi(0) - min(phi(a),phi(b)))*h, since phi is not monotone there.
    let w;
    if (a >= 0) w = (npdfJs(a) - npdfJs(b)) * h;
    else if (b <= 0) w = (npdfJs(b) - npdfJs(a)) * h;
    else w = (npdfJs(0) - Math.min(npdfJs(a), npdfJs(b))) * h;
    dens = Math.max(dens, w);
  }
  bracketRows.push({ K, h, plain, dens });
  console.log(`  ${String(K).padEnd(18)}${h.toExponential(2).padStart(10)}${plain.toExponential(2).padStart(16)}${dens.toExponential(2).padStart(17)}${('$' + priceEnv(dens).toPrecision(3)).padStart(16)}`);
}

console.log(`\n  Reference leg for the price column: F=K=$${REF.F.toLocaleString()}, T=${(REF.T * 365).toFixed(0)}d, sigma=${REF.sigma}. True price $${refPrice.toFixed(2)}.`);
console.log(`  An absolute uncertainty u in each of N(d1), N(d2) gives a price envelope of (F+K)*u.`);

const fpU = globalThis.__worstMain;
console.log(`\n  ${'='.repeat(88)}`);
console.log(`  COMPUTING beats BOUNDING, and not narrowly.`);
console.log(`  fixed-point Hart, worst |dN| = ${fpU.toExponential(2)}  ->  price envelope $${priceEnv(fpU).toExponential(2)} on that leg`);
const best = bracketRows[bracketRows.length - 1];
console.log(`  best bracket here (${best.K} anchors, density-aided), worst |dN| = ${best.dens.toExponential(2)}  ->  $${priceEnv(best.dens).toPrecision(3)}`);
console.log(`  ratio: ${(best.dens / fpU).toExponential(2)}x wider, and the bracket needs a ${best.K}-entry table`);
console.log(`  the fixed-point evaluator needs ${NGROUPS * Number(1n << GBITS)} constants and computes rather than brackets.`);

// ---- 4. what it costs, counted rather than guessed ----------------------------------------------
// Every line below is a constraint a circom template actually emits, listed so the estimate can be
// checked against the compiled .r1cs afterwards. It is an ESTIMATE until the circuit is built.
const est = {
  'Num2Bits(W), W is z^2/2': Number(WBITS),
  'exp: Mux over GBITS bits, per group (2^G - 1 each)': NGROUPS * (Number(1n << GBITS) - 1),
  'exp: one truncating multiply per group (1 + S range bits)': NGROUPS * (1 + Number(S)),
  'z^2 and its truncation': 1 + Number(S),
  'Horner on b and d (13 steps)': 13 * (1 + Number(S)),
  'the division as c*d = e*b, with a tolerance range check': 2 + 128,
  'branch select + sign reflection + input range': 3 * Number(S),
};
let total = 0;
console.log(`\n  ESTIMATED constraint cost of one in-circuit ncdf (to be replaced by a measurement):`);
for (const [k, v] of Object.entries(est)) { total += v; console.log(`    ${String(v).padStart(6)}  ${k}`); }
console.log(`    ${String(total).padStart(6)}  TOTAL estimate — the ptau on hand tops out at 4,096`);

console.log(`\n  WHAT THIS DOES NOT SETTLE. Everything above pins N at a given x. It does not pin x.`);
console.log(`  d1 = (ln(F/K) + sigma^2 T/2)/(sigma sqrt T) needs a logarithm, and a logarithm is the`);
console.log(`  same exp gadget run backwards: L is the log of F/K iff K*exp(L) = F. So it is one more`);
console.log(`  instance of the block above, not a new problem. Whether all of it fits under 4,096 is`);
console.log(`  a measurement, not an argument, and it is taken in the gate.`);
