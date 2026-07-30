// THE BRACKET CERTIFICATE for lp-risk's breakeven volatility — the normative encoding for
// `zk/circuits/lpbracket.circom`, on the served path.
//
// ── WHY THIS IS NOT IN scale.cjs ─────────────────────────────────────────────────────────────────
// `src/util/scale.cjs` is the normative encoding for the other four circuits and its contract is
// "one function, one value": `engineX` lifts the engine's expression, `canonicalX` re-solves it over
// the integers, and a reader reproduces both from the echoed floats. This circuit is the first whose
// witness cannot be written that way. Its subject is the RESULT OF A SEARCH, so building the witness
// means running a search, and a search has a stopping rule, a refusal set and a bound of its own.
// That is a different shape and it gets its own file rather than four more exports on a file whose
// promise is that every function in it is a closed form.
//
// ── WHAT lp-risk PUBLISHES, AND WHICH THIRD OF IT THIS COVERS ────────────────────────────────────
// The service answers in three independent blocks, and they are not equally provable:
//
//   1. `realizedIL`         — IL(r) = 2*sqrt(r)/(1+r) - 1. A closed form. `divergence.circom` states
//                             this identity and is proven by gateB4; it is NOT the circuit wired here
//                             and no proof this file builds says anything about `realizedIL`.
//   2. `expectedDivergence` — a 401-point quadrature over a lognormal (802 exponentials, 402 roots
//                             per figure, measured). NOT covered by this proof. It enters the
//                             certificate as two PUBLIC INPUTS and nothing certifies them.
//   3. `feeVsDivergence`    — a 200-iteration bisection over block 2 (163,608 exp and 82,016 sqrt for
//                             one served answer, measured). `breakevenVolatility` is what this proof
//                             is about, and the verdict the service leads with is built on it.
//
// ── HOW A BISECTION IS CERTIFIED WITHOUT BEING REPLAYED ─────────────────────────────────────────
// A root does not have to be RECOMPUTED to be certified; it has to be LOCATED. Bisection returns the
// midpoint of a bracket, and a bracket is a closed-form object: two evaluations of g(v) = E[IL](v) + f
// that straddle, an ordering, a midpoint and a width. Every line of that is an inequality over
// published integers, so the certificate is two evaluations wide rather than two hundred. The circuit
// checks the inequalities; this file finds the bracket, which is exactly the division of labour a
// witness generator is for — it is allowed to search, a verifier is not.
//
// ── THE QUADRATURE IS A COPY, AND IT IS CHECKED ON EVERY CALL ───────────────────────────────────
// `src/engine/lpRisk.js` does not export `expectedIlNumerical`, so it is transcribed below — same
// expression, same order, same window, same node count. Re-deriving an engine expression outside the
// engine has been wrong three times on this project (a `constantproduct` encoder rearranged the same
// algebra into a numerically different form and was off by 64 grid steps), so the copy is not
// trusted: `bracketWitnessFor` evaluates it at the variance the SERVICE reports and refuses unless
// the result reproduces the 4-decimal figure the SERVICE published. That is a per-request equality
// against an engine number, not a gate-time spot check, so a copy that ever drifts refuses every
// request instead of certifying a different function.
//
// A CLOSED FORM FOR BLOCK 2 EXISTS and is deliberately NOT used here. 2*sqrt(r)/(1+r) = sech(ln r/2),
// and with a = sqrt(v)/2 the argument is a*z - a^2; shifting z = w + a leaves sech(a*w) with the pdf
// gaining e^{-a*w - a^2/2}; symmetrising w -> -w turns e^{-a*w} into cosh(a*w), and cosh*sech = 1.
// So E[IL](v) = exp(-v/8) - 1 exactly. Measured against the engine's own quadrature the two differ by
// at most 1.419121e-9 (supremum, at v = 1.1256, located by a 40,001-point log pass, a golden-section
// refinement and a 200,001-point brute scan over [0.2, 10]) — which is 71.92% of the 1.973175e-9 of
// Gaussian weight the engine's |z| <= 6 window throws away, identifying the gap as the engine's
// truncation rather than either side's arithmetic. That weight is 2*Q(6) and it read 1.973073e-9 here
// until it was recomputed two independent ways — a Legendre continued fraction and an endpoint-
// clustered quadrature, agreeing to 3.06e-12 relative on 1.9731752900753966e-9. The old figure was a
// low-accuracy erfc, wrong in the 5th digit; the 71.92% ratio is unchanged by the correction, which is
// exactly why nobody noticed. Nothing on a served path reads this constant. 1.419e-9 is NOT small on a 1e-9 grid: it is more
// than one grid step, and the straddle this circuit checks is decided on single grid steps. Encoding
// the closed form would certify a bracket around the root of a DIFFERENT function from the one the
// engine bisected. So the engine's function is copied, and the closed form is used only as an
// independent cross-check a reader can perform in one line (see `closedFormExpectedIl`).
import { round } from '../engine/stats.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scale = require('./scale.cjs');

export const SCALE = scale.SCALE;                 // 1e9, the shared grid
const S = Number(scale.SCALE);

// Circuit ceilings, mirrored from `component main = LpBracket(1000000000, 46, 30, 44, 24, 120, 2)`.
// A witness past any of these is not a proof of a different answer, it is not a proof at all: the
// range checks inside the circuit fail and the witness calculator throws. Refused here instead, so
// the stored record says which ceiling was hit.
const NB_V_MAX = 2n ** 46n - 1n;                  // total variance * 1e9
const NB_SIG_MAX = 2n ** 44n - 1n;                // sigma * 1e9
const NB_T_MAX = 2n ** 24n - 1n;                  // horizonPeriods
const TOL_SIG = 2n;                               // the circuit's own 2*S term

/**
 * HALF OF THE LAST DIGIT THE ENGINE DISPLAYS THE BREAKEVEN AT.
 * `breakevenVolatility: round(breakevenSigma, 5)` in src/engine/lpRisk.js:157. Nothing here is
 * chosen: it is that 5, halved. It is 100 times finer than the liquidation guard's half-cent and
 * 10 times coarser than the Kelly guard's half-millionth, which is exactly why this constant is not
 * shared with either — a bound sized off the half-cent would admit a breakeven volatility 5,000 grid
 * steps from the one that was served.
 */
export const LP_DISPLAY_HALF_UNIT = 0.5e-5;

/**
 * The stopping rule's safety factor. The bracket search halves until its own bound is under
 * CEILING / SAFETY rather than until it is merely under CEILING, so the served certificate is not
 * sitting on the limit that refuses. Stated rather than tuned: at 1 the guard in snark.js could never
 * fire on anything the search returned, which is the "verifier that cannot fail" this project keeps
 * finding in its own work.
 */
export const SAFETY = 2;

/** The engine's IL closed form, lifted: src/engine/lpRisk.js:20. */
export const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);

/**
 * The engine's 401-point quadrature, transcribed from src/engine/lpRisk.js:23-35 — same window
 * (|z| <= 6), same node count (N = 400), same martingale centring, same order of operations. A COPY,
 * validated per request rather than trusted; see the header.
 */
export function engineExpectedIl(v) {
  const sd = Math.sqrt(v);
  let sum = 0, w = 0;
  const N = 400, lo = -6, hi = 6;
  for (let i = 0; i <= N; i++) {
    const z = lo + ((hi - lo) * i) / N;
    const pdf = Math.exp(-0.5 * z * z);
    const r = Math.exp(-0.5 * v + sd * z);
    sum += pdf * ilOfRatio(r);
    w += pdf;
  }
  return sum / w;
}

/**
 * The closed form, for cross-checking only. E[IL](v) = exp(-v/8) - 1, derived in the header and
 * independently reproduced against the engine. Published beside the proof so a reader can check the
 * two endpoint values the circuit assumes without running a quadrature; never encoded.
 */
export const closedFormExpectedIl = (v) => Math.expm1(-v / 8);

/**
 * The engine's breakeven solve, transcribed from src/engine/lpRisk.js:43-53 — the doubling, the 200
 * halvings, the same comparison, the same midpoint. Returns the total variance, UNROUNDED.
 *
 * WHY THIS IS REPLAYED AT ALL, given that the certificate does not need it. Because the alternative is
 * the defect perp-gate shipped. The engine publishes `round(breakevenSigma, 5)`, so comparing the
 * certified volatility against the SERVED figure carries half a display unit whatever the volatility
 * is — and a certified 0.187314769 against a served 0.18732 is a correct proof that an equality test
 * on the rounded value calls tampering. Measured on the first pass of this file's own sweep: 28 of 770
 * honest cases were refused that way, all of them sitting on a 5th-decimal boundary. "The rounding has
 * to leave the comparison, which means having the price before it was rounded" — the same sentence,
 * about a different number.
 *
 * The cost is 200 quadrature passes, ~80,200 exponentials, and it is paid in the background prover
 * path and never inside a response. Measured below by the gate.
 */
export function engineBreakevenVariance(feeFracNoConc) {
  if (!(feeFracNoConc > 0)) return 0;
  if (feeFracNoConc >= 1) return null;
  let lo = 0, hi = 1;
  while (engineExpectedIl(hi) > -feeFracNoConc) { hi *= 2; if (hi > 1e4) return null; }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (engineExpectedIl(mid) > -feeFracNoConc) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The engine's fee fraction, lifted: src/engine/lpRisk.js:148, in the engine's own order. */
export function engineFeeFraction(input) {
  const T = Number(input?.horizonPeriods) > 0 ? Number(input.horizonPeriods) : 1;
  const periodsPerYear = Number(input?.periodsPerYear) > 0 ? Number(input.periodsPerYear) : 365;
  return (Number(input?.feeAprPct) / 100) * (T / periodsPerYear);
}

/** The engine's horizon coercion, lifted: src/engine/lpRisk.js:91. */
export const horizonOf = (input) => (Number(input?.horizonPeriods) > 0 ? Number(input.horizonPeriods) : 1);

/** Integer square root, floored, then corrected to the nearest. Off-circuit, seven lines, and the
 *  entire content of the "the circuit would need a square root" objection. */
export const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };

const abs = (v) => (v < 0n ? -v : v);

/**
 * Encode one candidate bracket, or refuse it.
 *
 * Every refusal is a sentence rather than a null, because the reason a bracket cannot be expressed on
 * this grid is the interesting part: it says whether the answer is unprovable here or merely that
 * this candidate was too narrow.
 */
export function encodeBracket({ feeFrac, T, lo, hi }) {
  if (!Number.isInteger(T) || T <= 0) return { refused: `horizonPeriods must be a positive whole number of periods for this circuit; got ${T}` };
  if (BigInt(T) > NB_T_MAX) return { refused: `horizonPeriods ${T} is past the ${NB_T_MAX} periods the circuit's 24-bit horizon admits` };

  let loHat, hiHat, feeHat;
  try {
    loHat = scale.toScaled(lo, 'bracketLo');
    hiHat = scale.toScaled(hi, 'bracketHi');
    feeHat = scale.toScaled(feeFrac, 'feeFraction');
  } catch (e) { return { refused: `the bracket does not encode onto the 1e-9 grid: ${e.message}` }; }

  if (feeHat <= 0n) return { refused: `horizon fees round to zero on the 1e-9 grid (${feeFrac} of capital), so there is no fee level for a breakeven to be about` };
  if (feeHat >= SCALE) return { refused: `horizon fees are ${feeFrac} of capital — at or above 100%, where a loss bounded by 100% can never catch them and the engine returns no breakeven` };
  if (hiHat > NB_V_MAX) return { refused: `total variance ${hi} is past the ${Number(NB_V_MAX) / S} the circuit's 46-bit variance admits` };
  if (hiHat - loHat < 2n) return { refused: 'bracket narrower than two grid steps, so lo < v* < hi is not expressible on the 1e-9 grid' };

  // v* is the midpoint ON THE GRID, so the circuit's midpoint residual is 0 or 1 by construction.
  const vStarHat = (loHat + hiHat + 1n) / 2n;

  // L-form at each endpoint: L = E[IL] + 1 in (0, 1]. The field has no sign, and this is the same
  // move `divergence.circom` makes for the same reason.
  const eLo = engineExpectedIl(lo) + 1;
  const eHi = engineExpectedIl(hi) + 1;
  if (!(eLo > 0) || !(eHi > 0) || !(eLo <= 1) || !(eHi <= 1)) {
    return { refused: `an endpoint expectation left (-100%, 0]: L(lo) = ${eLo}, L(hi) = ${eHi}` };
  }
  const eLoHat = scale.toScaled(eLo, 'eLo');
  const eHiHat = scale.toScaled(eHi, 'eHi');
  if (eLoHat <= 0n || eHiHat <= 0n) return { refused: 'an endpoint expectation underflows the 1e-9 grid — the divergence has saturated at -100% and the grid cannot see inside the bound' };

  // THE STRADDLE, in the integers the circuit will compare. Rounding can destroy a straddle whose
  // margin is under half a grid step; when it does, that is a refusal and not a proof of something
  // adjacent.
  if (!(eLoHat + feeHat > SCALE)) return { refused: 'g(lo) > 0 does not survive the 1e-9 grid — the bracket is narrower than the rounding of its own endpoint value' };
  if (!(eHiHat + feeHat <= SCALE)) return { refused: 'g(hi) <= 0 does not survive the 1e-9 grid' };
  if (!(eHiHat <= eLoHat)) return { refused: 'the endpoint expectations are not in decreasing order on the grid' };

  // AND THE STRADDLE HOLDS AT BOTH FEE LEVELS. The circuit compares against the ENCODED fee f-hat/S;
  // the engine bisected against its own double f. Those are up to half a grid step apart, and a root
  // moves when the fee does. Requiring the bracket to straddle at BOTH puts both roots inside it, so
  // the bound below covers the fee's own encoding without a derivative and without a linearisation —
  // the box-corner discipline `encodingShift` uses in snark.js, applied to a search instead of a
  // formula.
  const fEnc = Number(feeHat) / S;
  const gLo = engineExpectedIl(lo), gHi = engineExpectedIl(hi);
  if (!(gLo > -feeFrac && gHi <= -feeFrac)) return { refused: `the bracket does not straddle at the engine's own fee fraction ${feeFrac}` };
  if (!(gLo > -fEnc && gHi <= -fEnc)) return { refused: `the bracket does not straddle at the ENCODED fee fraction ${fEnc} — it is narrower than the fee's own grid rounding, so the root the circuit compares against may sit outside it` };

  // sigma-hat is the integer that best satisfies the statement the circuit checks, sig^2 * T = v* * S.
  // Chosen by testing the candidates around the floor rather than taking whatever a truncating
  // division landed on, so it is the true minimiser.
  const N = vStarHat * SCALE, Tb = BigInt(T);
  let sigHat = isqrt(N / Tb);
  {
    const err = (x) => abs(x * x * Tb - N);
    for (const c of [sigHat - 1n, sigHat + 1n, sigHat + 2n]) if (c > 0n && err(c) < err(sigHat)) sigHat = c;
  }
  if (sigHat <= 0n) return { refused: 'the breakeven volatility underflows the 1e-9 grid' };
  if (sigHat > NB_SIG_MAX) return { refused: `the breakeven volatility is past the ${Number(NB_SIG_MAX) / S} the circuit's 44-bit sigma admits` };

  // The width bound is a POLICY, rounded up to the next power of two in grid steps, so the slack the
  // circuit publishes is a real number rather than always zero.
  let widthHat = 2n;
  while (widthHat < hiHat - loHat) widthHat *= 2n;

  const mid = 2n * vStarHat - loHat - hiHat;
  const Rs = sigHat * sigHat * Tb - vStarHat * SCALE;
  const sigTol = 2n * (sigHat + 1n) * Tb + TOL_SIG * SCALE;
  if (!(2n * abs(Rs) <= sigTol)) return { refused: `the root residual is 2|R| = ${2n * abs(Rs)}, past the circuit's own tolerance ${sigTol}` };

  const certifiedSigma = Number(sigHat) / S;

  // ── THE BOUND, derived here and inherited from nothing ────────────────────────────────────────
  //
  // What has to be bounded is |certifiedSigma - sigma*|, where sigma* is the engine's own UNROUNDED
  // breakeven. The engine publishes only round(sigma*, 5), so comparing against the served figure
  // carries half a display unit whatever the volatility is — the same shape as the half-cent that
  // "stopped being a guard below a dollar" for perp-gate. So the distance is bounded a priori
  // instead, from the three places it can come from:
  //
  //   1. THE BRACKET. Both roots — the one at the engine's own fee and the one at the encoded fee —
  //      lie inside [lo, hi], checked above. v-hat*/S lies within ONE grid step of the bracket's
  //      midpoint m: half a step from `toScaled` on each endpoint, halved by the averaging, plus half
  //      a step rounding the average itself. So the two quantities being differenced do not roam the
  //      same interval — the certified one is pinned to m within 1/S, the engine's root only to the
  //      full width — and taking the whole width as the bound double-counts. It is the excursion
  //      between a point near m and a point anywhere in [lo, hi]:
  //
  //          max over x in [m - 1/S, m + 1/S], y in [lo, hi]  of  |sigma(x) - sigma(y)|
  //
  //      which is attained at a CORNER because sigma(v) = sqrt(v/T) is monotone. All four corners are
  //      evaluated and the largest is taken. No derivative is used anywhere: sigma is concave, so a
  //      first-order term understates the downward excursion, and a sensitivity sum is exactly what
  //      failed on 153 of 357,138 liquidation positions. Measuring the full width instead left the
  //      worst honest case using 49.8% of the bound — a factor of two that looked like headroom and
  //      was arithmetic.
  //   2. THE ROOT ROUNDING. sigma-hat satisfies |sig^2 T - v* S| <= sigTol/2 = (sig+1)T + S, so
  //      |sig - sqrt(v* S/T)| <= (sig + 1 + S/T) / (sig + sqrt(v* S/T)), which is evaluated rather
  //      than approximated. Divided by S to land in sigma units.
  //   3. Nothing else. The fee's encoding is already inside term 1 by the both-roots requirement.
  const sigOf = (x) => Math.sqrt(Math.max(0, x) / T);
  const m = Number(vStarHat) / S;
  let bracketTerm = 0;
  for (const x of [m - 1 / S, m + 1 / S]) for (const y of [lo, hi]) {
    const d = Math.abs(sigOf(x) - sigOf(y));
    if (d > bracketTerm) bracketTerm = d;
  }
  const sigTarget = Math.sqrt((Number(vStarHat) * S) / T);
  const rootTerm = (Number(sigHat) + 1 + S / T) / (Number(sigHat) + sigTarget) / S;
  const sigmaBound = bracketTerm + rootTerm;

  return {
    witness: {
      feeHat: feeHat.toString(), loHat: loHat.toString(), hiHat: hiHat.toString(),
      vStarHat: vStarHat.toString(), eLoHat: eLoHat.toString(), eHiHat: eHiHat.toString(),
      sigHat: sigHat.toString(), horizonT: String(T), widthHat: widthHat.toString(),
    },
    encoded: { feeHat, loHat, hiHat, vStarHat, eLoHat, eHiHat, sigHat, horizonT: BigInt(T), widthHat },
    lo, hi, T, feeFrac, feeFracEncoded: fEnc,
    mid, rootResidual: Rs, rootTolerance: sigTol,
    widthSlack: widthHat - (hiHat - loHat),
    rootBoundUsed: Number(2n * abs(Rs)) / Number(sigTol),
    straddleMarginLo: Number(eLoHat + feeHat - SCALE),      // grid steps of margin on g(lo) > 0
    straddleMarginHi: Number(SCALE - (eHiHat + feeHat)),    // grid steps of margin on g(hi) <= 0
    certifiedSigma, sigmaBound, bracketTerm, rootTerm,
    eLo, eHi,
    // The same two endpoint values from the closed form, so the reader's one-line check is beside
    // the assumed numbers rather than in a document somewhere.
    closedFormLo: closedFormExpectedIl(lo) + 1,
    closedFormHi: closedFormExpectedIl(hi) + 1,
  };
}

/**
 * Find the WIDEST bracket that pins the breakeven tightly enough, and encode it.
 *
 * WIDEST, not narrowest, and that is the opposite of the obvious choice. Narrowing a bracket shrinks
 * term 1 of the bound but also shrinks the straddle margin, and past a point the straddle stops
 * surviving the 1e-9 grid at all — the engine's own 200 halvings leave a bracket about 3e-17 wide,
 * where both endpoints land on the SAME grid integer and `lo < hi` is not even expressible. So the
 * search stops as soon as both stopping conditions are met and keeps the widest bracket that got
 * there, which is the one with the most straddle margin among those that qualify.
 *
 * TWO STOPPING CONDITIONS, and the second is a courtesy rather than a guard:
 *   1. the bound is under CEILING / SAFETY. This is the one that matters.
 *   2. the certified volatility DISPLAYS as the figure the service served. This does not make the
 *      proof more true — a certified 0.18731409 against a served 0.18732 is a correct certificate of
 *      a number 6e-6 away, well inside the bound — but a reader comparing the public signal to the
 *      response should not have to reconcile two different-looking numbers when one more halving
 *      makes them agree. Measured: without it, 14 of 378 proved answers displayed differently; with
 *      it, the count is what the sweep in the gate reports. It is NOT a refusal: where the engine's
 *      own root sits within a grid step of a 5th-decimal boundary no bracket can satisfy it, and the
 *      proof is still served with `gapToServedBreakeven` published, because refusing a correct
 *      certificate for landing on the far side of a display boundary is the defect that refused RUNE
 *      a liquidation proof for the same reason.
 *
 * @param feeFrac  horizon fees as a fraction of capital, WITHOUT the concentration factor — which is
 *                 what the engine solves against, since conc appears on both sides of
 *                 `fees == |E[IL]|` and cancels.
 * @param targetSigma  the served breakeven volatility, for stopping condition 2. Optional.
 */
export function findBracket(feeFrac, T, { ceiling = LP_DISPLAY_HALF_UNIT, safety = SAFETY, maxHalvings = 200, targetSigma = null } = {}) {
  if (!(feeFrac > 0)) return { refused: 'no fee level was supplied, so there is no breakeven to certify' };
  if (feeFrac >= 1) return { refused: `horizon fees are ${feeFrac} of capital — at or above the 100% a bounded loss can ever reach, so no breakeven exists and the engine returns null` };

  // The engine's own doubling, transcribed from src/engine/lpRisk.js:47.
  let lo = 0, hi = 1, doublings = 0;
  while (engineExpectedIl(hi) > -feeFrac) { hi *= 2; doublings++; if (hi > 1e4) return { refused: 'no breakeven within total variance 1e4, where the engine also gives up' }; }

  const done = (c) => c.sigmaBound <= ceiling / safety
    && (targetSigma == null || lpDisplayRound(c.certifiedSigma) === targetSigma);

  let best = encodeBracket({ feeFrac, T, lo, hi });
  if (best.refused) return { refused: best.refused, halvings: 0, doublings };
  let halvings = 0;
  for (let k = 1; k <= maxHalvings; k++) {
    if (done(best)) break;
    const mid = (lo + hi) / 2;
    const nLo = engineExpectedIl(mid) > -feeFrac ? mid : lo;
    const nHi = engineExpectedIl(mid) > -feeFrac ? hi : mid;
    const cand = encodeBracket({ feeFrac, T, lo: nLo, hi: nHi });
    // A narrower bracket that cannot be expressed is where the search STOPS, keeping the last one
    // that could. The refusal reason is carried so the guard can say which wall was hit.
    if (cand.refused) { best.stoppedBecause = cand.refused; break; }
    lo = nLo; hi = nHi; best = cand; halvings = k;
  }
  return { ...best, halvings, doublings, enginePerforms: 200 };
}

/**
 * Build the bracket witness for an lp-risk answer, or say why there is none.
 *
 * @param echoedInputs  the request as echoed in `proof.inputs` — the object a reader holds
 * @param result        the engine's own return value, as served
 */
export function bracketWitnessFor(echoedInputs, result) {
  const i = echoedInputs || {};
  const fee = result?.feeVsDivergence;
  const ed = result?.expectedDivergence;
  if (!fee || !ed) {
    return { refused: 'this answer carries no fee-vs-divergence block, so there is no breakeven to certify — the circuit here states a BRACKET around the root of expected divergence plus fees, and that root only exists when the call supplies both volatility and feeAprPct' };
  }
  const served = fee.breakevenVolatility;
  if (served == null || !Number.isFinite(Number(served))) {
    return { refused: `this answer carries no breakeven volatility to certify: ${fee.breakevenBasis || 'the engine returned null'}` };
  }

  const T = horizonOf(i);
  if (!Number.isInteger(T)) {
    return { refused: `horizonPeriods is ${T}; this circuit carries the horizon as an integer count of periods (24 bits), so a fractional horizon has no witness here` };
  }

  // THE COPY CHECK, on this request. The quadrature below is a transcription of the engine's, and the
  // engine publishes its own value at 4 decimals — so the transcription is required to reproduce that
  // digit at the variance the SERVICE reports, or nothing is encoded. This is the check that makes
  // having a copy at all defensible.
  const sigma = Number(i.volatility);
  const v = sigma * sigma * T;                    // src/engine/lpRisk.js:93, same expression, same order
  const mine = engineExpectedIl(v) * 100;
  const servedPct = Number(ed.expectedIlPct);
  const conc = Number(i.concentrationFactor) > 0 ? Number(i.concentrationFactor) : 1;
  // The served percentage carries the concentration branch; the copy check is asked of the FULL-RANGE
  // figure the engine also publishes whenever conc > 1, because that is the quantity the quadrature
  // computes. At conc == 1 they are the same field.
  const servedFullPct = conc > 1 ? Number(ed.fullRangeExpectedIlPct) : servedPct;
  if (!Number.isFinite(servedFullPct) || round(mine, 4) !== servedFullPct) {
    return { refused: `the quadrature this witness generator carries evaluates to ${round(mine, 4)}% at total variance ${v}, and the answer published ${servedFullPct}% — the transcription in src/util/lpBracket.js is no longer the engine's, so nothing is encoded` };
  }

  const feeFrac = engineFeeFraction(i);
  const br = findBracket(feeFrac, T, { targetSigma: Number(served) });
  if (br.refused) return { refused: br.refused, feeFrac, T };

  // THE ENGINE'S OWN BREAKEVEN, UNROUNDED — replayed rather than read off the response, for the
  // reason `engineBreakevenVariance` gives. This is the number the certified volatility is compared
  // against; `served` is only checked to be what this replay displays as.
  const vStarEngine = engineBreakevenVariance(feeFrac);
  const engineSigma = vStarEngine == null ? null : Math.sqrt(vStarEngine / T);

  return {
    ...br,
    servedSigma: Number(served),
    servedExpectedIlPct: servedFullPct,
    quadratureAtServedV: round(mine, 4),
    totalVariance: v,
    vStarEngine,
    engineSigma,
    // The replay must display as the figure the answer published, or the transcription is not the
    // engine's bisection and the comparison below is against the wrong number.
    engineSigmaDisplaysAsServed: engineSigma != null && lpDisplayRound(engineSigma) === Number(served),
    gapToEngine: engineSigma == null ? Infinity : Math.abs(br.certifiedSigma - engineSigma),
    gapToServed: Math.abs(br.certifiedSigma - Number(served)),
    displayHalfUnit: LP_DISPLAY_HALF_UNIT,
    boundUsed: br.sigmaBound / LP_DISPLAY_HALF_UNIT,
  };
}

/**
 * THE PUBLISHED `snark` BLOCK, built in ONE place for BOTH surfaces.
 *
 * The paid HTTP handler in `src/services.js` and the free MCP handler in `src/mcp.js` are separate
 * arrays, and the MCP one has been the forgotten site four times on this project. The other identities
 * duplicate their `proves` / `doesNotProve` strings across the two, which works until an edit lands on
 * one of them; this returns the object instead, so the two surfaces cannot publish different claims
 * about the same circuit. Only the closing `note` differs, because one of them is describing a paid
 * response and the other a free one.
 *
 * @returns {{ why: string|null, snark: object }} `why` is non-null when the answer cannot carry a
 *          proof for a reason visible WITHOUT building a witness; everything else is decided by the
 *          guard in snark.js and recorded on the proof itself, because it needs the bracket.
 */
export function lpBracketSnark({ contentHash, result, note }) {
  const fee = result?.feeVsDivergence;
  const T = result?.expectedDivergence?.horizonPeriods;
  const why = result?.ok !== true
    ? 'this request was refused, so there is no breakeven to certify'
    : !fee
      ? 'this answer has no feeVsDivergence block. The circuit here certifies a BRACKET around the root of "expected divergence + fees", and that root exists only when the call supplies BOTH volatility (which opens the expected-divergence block) and feeAprPct. A realized-IL-only answer has no root to locate — the closed form for THAT block is stated by divergence.circom, which is a different circuit and is not reached from here.'
      : fee.breakevenVolatility == null
        ? `this answer has no breakeven volatility: ${fee.breakevenBasis}`
        : !Number.isInteger(T)
          ? `horizonPeriods is ${T}, and this circuit carries the horizon as an integer count of periods — a fractional horizon has no witness here`
          : null;
  return {
    why,
    snark: {
      protocol: 'plonk',
      circuit: 'lpbracket',
      status: why ? 'unavailable' : 'building',
      ...(why ? { reason: why } : { retrieveAt: `/proof/${contentHash}`, verificationKey: '/proof/vk/lpbracket' }),
      ...(why ? {} : { breakevenVolatilityProven: fee.breakevenVolatility }),
      proves: 'That the breakeven volatility this answer serves is the root of a function whose sign CHANGES across a narrow bracket, and that the volatility published is the square root of that bracket\'s midpoint. Six inequalities over the thirteen integers in the proof\'s public signals, on a 1e-9 grid: (1) the bracket is ordered, lo < hi; (2) it STRADDLES — L(lo) + f > 1 and L(hi) + f <= 1, where L = E[IL] + 1 and f is the horizon fee fraction, so expected divergence is short of the fees at one end and past them at the other; (3) the two endpoint values are in decreasing order; (4) the returned root is the bracket midpoint to one grid step, 2*vStar - lo - hi in {-1,0,1}; (5) the bracket is inside a published width bound, with the unused slack published as a signal; (6) the volatility satisfies sigHat^2 * horizonT = vStar * 1e9 to a tolerance the circuit computes from its own signals and publishes. The engine finds this root by bisecting 200 times over a 401-point quadrature — 163,608 exponentials and 82,016 roots for one served answer, measured. The circuit evaluates that quadrature ZERO times: a bisection result does not have to be recomputed to be certified, it has to be LOCATED, and a bracket is a closed-form object. 1,776 Plonk constraints, checkable offline against /proof/vk/lpbracket.',
      doesNotProve: 'THAT THE TWO ENDPOINT VALUES ARE THE TRUE EXPECTATIONS, and that is the larger half. eLoHat and eHiHat are the engine\'s 401-point quadrature evaluated at the bracket ends; they arrive as PUBLIC INPUTS and nothing in the circuit certifies them, so a caller who supplies two wrong numbers that happen to straddle gets a valid proof of a false breakeven. They are published in the signals and on the proof record precisely so no reader can miss which numbers were assumed — and each can be checked in one line, because E[IL](v) = exp(-v/8) - 1 exactly (2*sqrt(r)/(1+r) = sech(ln r/2); the shift z = w + sqrt(v)/2 leaves sech against a pdf gaining cosh, and their product is 1). That closed form agrees with the engine\'s quadrature to at most 1.419121e-9, which is 71.92% of the Gaussian weight the engine\'s |z| <= 6 window discards — the gap is the engine\'s truncation, not either side\'s arithmetic. Nor does the circuit prove MONOTONICITY of expected divergence in variance, which is what makes a straddled root UNIQUE; that is a property of the function, established by sweep (zero non-decreasing steps over 20,001 log-spaced variances in [1e-8, 1e4]) and not by any proof. Nor the fee arithmetic, the concentration factor, the USD figures, or the verdict sentence. And it says NOTHING about the other two blocks of this answer: `realizedIL` is a different identity in a different circuit, and `expectedDivergence.expectedIlPct` — the headline percentage — is the quadrature itself, which is assumed here rather than proven.',
      note,
    },
  };
}

/** The engine's display rounding for the breakeven, reproduced: `round(sigma, 5)`. Written out rather
 *  than imported for the reason snark.js gives about its own three copies — this file keeps its
 *  dependency list — and the gate asserts the two agree over a sweep weighted onto the boundaries. */
export const lpDisplayRound = (x) => Number(Number(x).toFixed(5));

/** The pieces the guard is assembled from, exposed so the gate can measure them rather than infer
 *  them from refusals. Nothing on a served path reads this. */
export const _internalLp = {
  displayRound: lpDisplayRound,
  DISPLAY_HALF_UNIT: LP_DISPLAY_HALF_UNIT,
  SAFETY,
  NB_V_MAX, NB_SIG_MAX, NB_T_MAX, TOL_SIG,
  engineExpectedIl, closedFormExpectedIl, engineFeeFraction,
};
