// optionsRiskNcdfWitness.js — the witness `options-risk` hands to `ncdf.circom`, and the guard that
// refuses to build one for an answer it would not describe.
//
// ── WHY options-risk REACHES THIS CIRCUIT AFTER ALL ──────────────────────────────────────────────
//
// Every file on this host that touched the question said options-risk could not be wired. `ncdf.circom`
// pins N(x) GIVEN x; options-risk's x is d1 = [ln(F/K) + ½σ²T]/(σ√T), so pinning x needs a logarithm,
// and event-vol reached the circuit only because its straddle is struck AT the forward (K = F kills the
// log). All of that is true and none of it is the whole question, because it was asked about the PRICE.
//
// options-risk publishes three blocks and the headline is not the price. Read `black76` at r = 0
// (df = 1) and all SIX greeks are rational functions of exactly two transcendentals, both at the SAME
// point d1:
//
//     delta = N(d1)                 or N(d1) − 1 for a put     <- the CDF
//     gamma = φ(d1)/(F·σ·√T)                                   <- the density
//     vega  = F·φ(d1)·√T/100
//     vanna = −φ(d1)·d2/σ · 0.01
//     volga = vega·d1·d2/σ · 0.01
//     theta = −F·φ(d1)·σ/(2√T) / 365      <- the r·price term VANISHES at r = 0, and only there
//
// `ncdf.circom` publishes (x, N(x), φ(x)) at one point and pins BOTH. So one instance of it pins the
// WHOLE greeks block — six fields, where event-vol got one. That is why this file exists and why the
// scope conditions below are exactly the ones that make the collapse true.
//
// ── AND WHAT IT STILL CANNOT REACH, which is why the scope is narrow rather than apologetic ───────
//
//   `portfolioValue` is df·(F·N(d1) − K·N(d2)). N(d2) is a SECOND point. One instance of this circuit
//   carries one point, the proof store holds one proof per content hash, and the two points are not
//   related by any identity once K ≠ F — event-vol's N(d2) = 1 − N(d1) is exactly the collapse that
//   needs K = F. So the premium is NOT proven, and neither is anything derived from it.
//
//   `spanMargin` is the worst of 366 repricings of the book (122 price steps × 3 vol shifts), each one
//   two CDF points per leg. It is not a formula, it is a search over 732 transcendentals per leg, and
//   nothing here says anything about it.
//
//   r ≠ 0 breaks theta (it regains the r·price term, which needs N(d2)) and puts a discount factor
//   e^{−rT} in front of the other five. Refused by name rather than covered for five of six.
//
//   MORE THAN ONE LEG. A one-leg book's aggregate greeks ARE that leg's greeks, so the published
//   `greeks` block is what gets pinned. For an n-leg book the aggregate is a SUM over n points and the
//   store holds one proof, so a proof of leg 0 would leave the headline unpinned while looking like it
//   did not. Refused by name.
//
// ── THE ONE THING THAT IS NOT PROVEN AND IS NOT A SCOPE LIMIT ────────────────────────────────────
//
// x itself. The circuit takes the point as given. event-vol's residual binding was a SQUARING that a
// reader does in rational arithmetic; here it is x = [ln(F/K) + ½σ²T]/(σ√T), and the honest form of
// what a reader must do is the EXPONENTIAL rather than the logarithm:
//
//     x is this leg's d1  ⟺  K·exp(σ√T·x − ½σ²T) = F
//
// That is one exp, and it is the same gadget `ncdf.circom` already contains (e^{−w} factored over the
// binary expansion of w) run in the other direction — so it is another instance of this block and not
// a new problem. IT IS NOT BUILT. What a reader gets instead of trust is that exp is not where CDF
// implementations disagree: the whole reason this circuit exists is that Abramowitz-Stegun 7.1.26 and
// Hart differ by up to 7.5e-8 in N, which is 82,000 grid steps, while every libm exp agrees to under
// an ulp. The residue is moved from the function nobody agrees on to the one everybody does.
import { black76 } from '../engine/black76.js';
import { round } from '../engine/stats.js';
import { NCDF } from './ncdfWitness.js';

// The six greeks, their display precision as `optionsRisk` rounds them, and WHICH of the two proven
// quantities each one is affine in. Read off src/engine/optionsRisk.js's return block; the gate
// re-reads that file and fails if any of these drifts.
const GREEKS = ['delta', 'gamma', 'vega', 'vanna', 'volga', 'theta'];
const DP = { delta: 6, gamma: 8, vega: 6, vanna: 6, volga: 6, theta: 6 };

// N is Lipschitz with constant max φ = 1/√(2π); φ is Lipschitz with constant max|x|φ(x) = φ(1). These
// convert half a step of x into a bound on N and on φ. Neither is tuned.
const PHI_MAX = 1 / Math.sqrt(2 * Math.PI);
const PHI_AT_1 = Math.exp(-0.5) / Math.sqrt(2 * Math.PI);

// THE BUYER'S ENVELOPE, in absolute units of N and of φ.
//
// TOLC is used whole rather than as the TOLC/2 band the circuit actually enforces, and that is a
// decision. The gap between TOLC/2 and TOLC is the fixed-point evaluator's own error against real
// Hart, which cannot be measured here without a third copy of the 192-entry exponential table — so it
// is COVERED rather than counted, admissibly and only while TOLC ≥ TOLC/2 + evaluator. gateB7-5
// measures that evaluator error and gateB7-7 asserts the inequality against its artifact instead of
// assuming it. event-vol's encoder makes the same choice with the same constant, which is why the two
// services quote the same envelope on N.
export const EPS_N = (NCDF.TOLC + 0.5 * PHI_MAX) * NCDF.ULP;
export const EPS_P = (NCDF.TOLP + 0.5 * PHI_AT_1) * NCDF.ULP;

// The longest float chain among the six, COUNTED off black76 rather than chosen:
//   volga = ((df*F)*p*sqrtT/100)*d1*d2/sigma*0.01, then *qty — nine operations.
// The reconstruction performs those same nine on an operand perturbed by at most half a 2^-40 step, so
// the two results differ by the affine term plus at most one double-ulp per operation.
const FP_OPS = 9;

/**
 * The six greeks as functions of the two PROVEN quantities.
 *
 * A constantproduct encoder once rearranged an engine expression into a mathematically equal,
 * numerically different form and was wrong by 64 grid steps; that class has appeared three times on
 * this host. So every line below is the corresponding line of `black76` with exactly one substitution
 * — ncdf(d1) → n, npdf(d1) → p — and nothing else reassociated, reordered or simplified. `d1`, `d2`
 * and the leg's own parameters come from the engine's own return value.
 *
 * This is a re-derivation and it is the one place in this file that could not be avoided: the greeks
 * must be expressed in terms of the proven pair, and `black76` computes them from its own internal
 * CDF. It is therefore not defended by argument but by AGREEMENT OVER THE DOMAIN — gateB7-7 sweeps it
 * against the real engine over 20,000 legs and reports the worst residual as a fraction of the bound
 * below, and `agreesWithEngine` re-checks it per request against the engine's own unrounded values.
 */
function greeksFromProvenPair(n, p, F, T, sigma, isCall, d1, d2) {
  const sqrtT = Math.sqrt(T);
  const df = 1;                                     // r = 0 is a scope condition, checked before we get here
  const delta = df * (isCall ? n : n - 1);
  const gamma = df * p / (F * sigma * sqrtT);
  const vega = df * F * p * sqrtT / 100;
  const vanna = (-df * p * d2 / sigma) * 0.01;
  const volga = vega * d1 * d2 / sigma * 0.01;
  const theta = ((-df * F * p * sigma) / (2 * sqrtT)) / 365;
  return { delta, gamma, vega, vanna, volga, theta };
}

/**
 * |∂greek/∂(the proven quantity)| for each greek. Each greek is AFFINE in n or in p, so these are
 * exact coefficients and not linearisations — a bound on the pair times one of these IS a bound on the
 * greek, with no derivative estimate anywhere.
 */
function sensitivities(F, T, sigma, d1, d2) {
  const sqrtT = Math.sqrt(T);
  const vegaC = F * sqrtT / 100;
  return {
    delta: { on: 'N', c: 1 },
    gamma: { on: 'P', c: 1 / (F * sigma * sqrtT) },
    vega: { on: 'P', c: vegaC },
    vanna: { on: 'P', c: Math.abs(d2 / sigma) * 0.01 },
    volga: { on: 'P', c: Math.abs(vegaC * d1 * d2 / sigma * 0.01) },
    theta: { on: 'P', c: (F * sigma / (2 * sqrtT)) / 365 },
  };
}

/**
 * The single leg, reconstructed from the echoed inputs the way `optionsRisk` parses it.
 *
 * These lines mirror src/engine/optionsRisk.js's own mapping, which is local to that function and not
 * exported — and src/engine must not be touched to export it. Every consequence of misreading any of
 * them is caught by `agreesWithServed`, which compares TWELVE published fields.
 */
function reconstructLeg(input) {
  const raw = Array.isArray(input?.positions) ? input.positions : [];
  if (raw.length !== 1) return { reason: `this book has ${raw.length} legs. A one-leg book's aggregate greeks ARE that leg's greeks, which is what makes them provable from one CDF point; for ${raw.length} legs the aggregate is a sum over ${raw.length} points and the proof store holds one proof per response, so a proof of one leg would leave the published greeks unpinned while looking like it did not` };
  const p = raw[0];
  const sharedF = Number(input.forward) > 0 ? Number(input.forward) : null;
  const type = p.type === 'put' ? 'put' : 'call';
  const K = Number(p.strike);
  const T = Number(p.T) > 0 ? Number(p.T) : (Number(p.expiryDays) > 0 ? Number(p.expiryDays) / 365 : NaN);
  const sigma = Number(p.iv);
  const qty = Number(p.quantity);
  const F = Number(p.forward) > 0 ? Number(p.forward) : sharedF;
  if (!(K > 0) || !(T > 0) || !(sigma > 0) || !Number.isFinite(qty) || qty === 0 || !(F > 0)) {
    return { reason: 'this leg does not carry a strike, expiry, vol, quantity and forward that the engine would price' };
  }
  return { leg: { type, K, T, sigma, qty, F, isCall: type === 'call' } };
}

/**
 * Does the reconstruction describe the answer that was SERVED? Twelve equalities against twelve
 * published fields — the six greeks, the four leg descriptors the engine echoes back, the leg count,
 * and the leg's own mark. Equalities, not tolerances: both sides are the engine's own rounded output,
 * and a tolerance here would be a number nobody measured.
 *
 * The six greeks are the ones being certified, so they are compared to the engine's freshly computed
 * value; the descriptors are what pin the reconstruction to the right leg. A reconstruction that
 * misread `expiryDays` for `T`, or a `"PUT"` for a put, fails several of these at once.
 */
function agreesWithServed(leg, g, result) {
  const pos = Array.isArray(result?.positions) ? result.positions[0] : null;
  if (!pos) return 'this answer carries no per-position block to certify against';
  const want = [
    ['positionsCount', 1, result.positionsCount],
    ['positions[0].strike', leg.K, pos.strike],
    ['positions[0].T', round(leg.T, 5), pos.T],
    ['positions[0].iv', leg.sigma, pos.iv],
    ['positions[0].quantity', leg.qty, pos.quantity],
    ['positions[0].forward', leg.F, pos.forward],
    ['positions[0].value', round(g.price * leg.qty, 6), pos.value],
  ];
  for (const k of GREEKS) want.push([`greeks.${k}`, round(g[k] * leg.qty, DP[k]), result.greeks?.[k]]);
  for (const [name, mine, served] of want) {
    if (mine !== served) return `reconstruction gives ${name} = ${mine} and the answer served ${served} — refusing to certify a different answer`;
  }
  return null;
}

/**
 * The witness, the reconstruction a buyer performs from it, and BOTH bounds.
 *
 * TWO BOUNDS, AND THEY ARE DIFFERENT CLAIMS. Conflating them is how a guard ends up either refusing
 * honest answers or promising more than the circuit does.
 *
 *   `encodingBound` per greek is what the SERVER may assert, because it holds both numbers: the only
 *   thing between the reconstruction and the engine's own unrounded greek is one rounding of the pair
 *   onto the 2^-40 grid (half a step) carried through an exact affine coefficient, plus nine float
 *   operations' slack. Measured over 19,734 legs of the real engine, the worst honest leg uses
 *   99.9965% of it — a bound landing on itself rather than near itself.
 *
 *   `envelope` per greek is what a BUYER is entitled to, because a buyer knows only what the circuit
 *   promises: TOLC ulp on N and TOLP on φ, not half a step. It is ~24x wider, and the whole of the
 *   difference is a promise `ncdf.circom` makes that the engine does not need.
 *
 * AND THE FIRST VERSION OF THIS COMPARISON COULD NOT FAIL. It compared the reconstruction to the
 * SERVED (rounded) greek against `envelope + half a display digit` and reported 99.98% of bound used
 * on all six — a real number and a meaningless one, because the envelope on delta is 1.11e-11 against
 * a display half-digit of 5e-7, so 99.998% of that bound WAS the rounding: a term every honest leg
 * saturates and nothing violates. That is the liquidation half-cent again. So the display digit is
 * handled where it belongs — by an equality on the rounded value, a different test with a different
 * failure mode — and the bound compares against the engine's unrounded figure.
 */
export function optionsRiskNcdfWitnessFor(echoedInputs, result) {
  if (result?.ok !== true) return { reason: 'this request was refused, so there is no answer to certify' };

  // SCOPE, and each condition is the reason a different one of the six greeks would otherwise be a
  // claim about something this circuit does not carry.
  const r = Number(echoedInputs?.r) || 0;
  if (r !== 0) {
    return { reason: `r = ${r}. At r ≠ 0 theta regains its r·price term, and price needs N(d2) — a second CDF point this circuit does not carry — while the other five gain a discount factor e^{-rT} that is itself a transcendental nothing here pins. Refusing rather than certifying five of six greeks under a heading that says six` };
  }
  const lr = reconstructLeg(echoedInputs);
  if (lr.reason) return { reason: lr.reason };
  const leg = lr.leg;

  // The engine's own call, in the engine's own argument order. Not rearranged, not reimplemented.
  const g = black76(leg.F, leg.K, leg.T, leg.sigma, leg.type, 0);
  if (!g) return { reason: 'Black-76 does not evaluate at these parameters' };

  const disagreement = agreesWithServed(leg, g, result);
  if (disagreement) return { reason: disagreement };

  // ── the two proven quantities, LIFTED off the engine's own return ──
  // N(d1) comes out of delta: the engine's delta IS ncdf(d1) for a call and ncdf(d1) − 1 for a put, at
  // df = 1. The put's +1 is not a precision problem in the reachable domain: |d1| < 7.0711 bounds
  // N(d1) below by N(−7.0711) = 7.7e-13, whose complement needs 41 bits below the point and so is
  // exact in a double — and the residual is bounded absolutely by 2^-53 = 1.1e-16 regardless, which is
  // 1.2e-4 of one 2^-40 step. φ(d1) comes out of gamma by multiplying the engine's own division back
  // out, which is gateB7-5's recovery rather than a fresh exponential.
  const d1 = g.d1, d2 = g.d2;
  const nEngine = leg.isCall ? g.delta : g.delta + 1;
  const phi = g.gamma * leg.F * leg.sigma * Math.sqrt(leg.T);

  const xSign = d1 < 0 ? 1 : 0;
  const xMag = Math.round(Math.abs(d1) * NCDF.ONE);
  const nHat = Math.round(nEngine * NCDF.ONE);
  const pHat = Math.round(phi * NCDF.ONE);

  // Every range condition the circuit enforces, checked here so a witness that cannot satisfy one is
  // refused with a sentence rather than surfacing as a `failed` proof nobody can read.
  if (!(xMag < NCDF.ZSPLIT)) {
    return { reason: `d1 = ${d1} is past the ${NCDF.ZSPLIT / NCDF.ONE} tail split, where ncdf.circom proves a BOUND on the tail instead of evaluating the CDF. A bounded N and a bounded φ cannot reconstruct a delta or a gamma, so this answer gets no proof rather than a proof of a weaker statement` };
  }
  if (!(nHat >= 0 && nHat <= NCDF.ONE)) return { reason: `N(d1) encodes to ${nHat}, outside the [0, 2^40] the circuit range-checks` };
  if (!(pHat >= 0 && pHat < NCDF.ONE)) return { reason: `the density encodes to ${pHat}, outside the [0, 2^40) the circuit range-checks` };
  // The circuit's own upper-tail check, restated on the encoded values so a violation is a sentence
  // and not a witness failure: cHat = 1 − n for x ≥ 0 and n for x < 0, and a tail never exceeds a half.
  const cHat = xSign === 1 ? nHat : NCDF.ONE - nHat;
  if (!(cHat <= NCDF.ONE / 2)) {
    return { reason: `the upper tail encodes to ${cHat}, above the 2^39 the circuit's own c ≤ ½ check admits for x with sign bit ${xSign}` };
  }

  // ── the reconstruction, and the two bounds, per greek ──
  const nGrid = nHat / NCDF.ONE, pGrid = pHat / NCDF.ONE;
  const rec = greeksFromProvenPair(nGrid, pGrid, leg.F, leg.T, leg.sigma, leg.isCall, d1, d2);
  const sens = sensitivities(leg.F, leg.T, leg.sigma, d1, d2);

  const reconstructed = {}, envelope = {}, encodingBound = {}, gapToEngine = {};
  for (const k of GREEKS) {
    const mine = rec[k] * leg.qty;
    const engineExact = g[k] * leg.qty;
    const halfStep = Math.abs(leg.qty) * sens[k].c * (0.5 * NCDF.ULP);
    reconstructed[k] = mine;
    envelope[k] = Math.abs(leg.qty) * sens[k].c * (sens[k].on === 'N' ? EPS_N : EPS_P);
    encodingBound[k] = halfStep + FP_OPS * Number.EPSILON * Math.abs(engineExact);
    gapToEngine[k] = Math.abs(mine - engineExact);
  }

  // THE DISPLAY CEILING, per greek. A proof whose envelope is wider than the last digit the greek was
  // served at is a proof about a NEIGHBOURING number, and this refuses rather than serves it. It is
  // reachable: gamma's envelope is EPS_P/(F·σ·√T) against a 5e-9 half-digit, so a small forward, a low
  // vol and a short expiry together push it over — gateB7-7 constructs such a leg and shows this line
  // firing, because a ceiling nothing reaches is a ceiling nobody has tested.
  for (const k of GREEKS) {
    const half = 0.5 * 10 ** -DP[k];
    if (!(envelope[k] <= half)) {
      return { reason: `the circuit's envelope on ${k} is ±${envelope[k].toExponential(3)} at this leg, wider than the ${half.toExponential(1)} half-digit ${k} is displayed to — no proof of this shape is about the number that was served` };
    }
  }
  // The server's own bound, against the engine's unrounded greek.
  for (const k of GREEKS) {
    if (!(gapToEngine[k] <= encodingBound[k])) {
      return { reason: `the reconstructed ${k} sits ${gapToEngine[k].toExponential(3)} from the engine's own unrounded value, past the ±${encodingBound[k].toExponential(3)} the 2^-40 encoding admits — refusing to certify a different answer` };
    }
  }
  // And that a buyer reconstructing from the public signals lands on the digits they were served.
  for (const k of GREEKS) {
    if (round(reconstructed[k], DP[k]) !== result.greeks[k]) {
      return { reason: `the reconstructed ${k} displays as ${round(reconstructed[k], DP[k])} and the answer served ${result.greeks[k]} — refusing to certify a number the buyer cannot reproduce` };
    }
  }

  // IN PRICE TERMS, because a greek is not a price and a buyer counts money. The dollar delta is the
  // directional exposure this envelope can misstate; vega and theta are already quote-unit quantities.
  // Reported against the forward and never against the premium: a deep out-of-the-money premium is
  // 1e-70 and a ratio to it is a number about nothing (gateB7-5 measured that same denominator saying
  // 19.4% at one seed and 18,526% at another).
  const priceTerms = {
    dollarDeltaEnvelope: Math.abs(leg.qty) * leg.F * EPS_N,
    vegaEnvelope: envelope.vega,
    thetaEnvelope: envelope.theta,
    envelopeBpsOfForward: EPS_N * 1e4,
  };

  return {
    witness: { xSign: String(xSign), xMag: String(xMag), nHat: String(nHat), pHat: String(pHat) },
    encoded: { xSign, xMag, nHat, pHat },
    point: d1, d2, nEngine, phi,
    leg,
    reconstructed, envelope, encodingBound, gapToEngine, priceTerms,
    worstFractionOfEncodingBound: Math.max(...GREEKS.map((k) => gapToEngine[k] / encodingBound[k])),
  };
}

/**
 * THE PUBLISHED `snark` BLOCK, BUILT ONCE FOR BOTH SURFACES.
 *
 * The five oldest proof-emitting handlers each write this block inline, twice — once in
 * src/services.js and once in src/mcp.js — and the MCP array has been the forgotten site four times on
 * this project. lp-risk stopped doing that by putting its block in its own encoder; this follows it, so
 * the `proves`/`doesNotProve` pair physically cannot say two different things on two surfaces.
 *
 * Returns `{ why, snark }`: `why` is the refusal sentence or null, so a caller knows whether to start
 * the background build without asking the same question twice.
 */
export function optionsRiskSnark({ contentHash, inputs, result }) {
  const w = optionsRiskNcdfWitnessFor(inputs, result);
  const why = w.reason || null;
  return {
    why,
    snark: {
      protocol: 'plonk',
      circuit: 'ncdf',
      status: why ? 'unavailable' : 'building',
      ...(why
        ? { reason: why }
        : {
          retrieveAt: `/proof/${contentHash}`,
          verificationKey: '/proof/vk/ncdf',
          fieldsProven: GREEKS.map((k) => `greeks.${k}`),
          pointProven: w.point,
          cdfAtPoint: w.nEngine,
          densityAtPoint: w.phi,
          envelope: w.envelope,
          priceTerms: w.priceTerms,
        }),
      proves: 'That the six published `greeks` are the Black-76 greeks of this one-leg book for the public point x, with N(x) and φ(x) EVALUATED INSIDE THE CIRCUIT by Hart (1968) rather than asserted. Every multiply in that evaluator carries a range-checked remainder, so the prover cannot choose a rounding: N is pinned to 12 ulp of 2^-40 (1.09e-11) and the density to 10 ulp. At r = 0 that pins all six — delta = N(x), and gamma, vega, vanna, volga and theta are each φ(x) times a rational coefficient in F, K, T and σ, theta included precisely because its r·price term vanishes at r = 0. x, N(x) and φ(x) are public signals, so a reader sees the point the CDF was taken at instead of being asked to accept a number about it. This is the statement the greek CONSISTENCY identities cannot make: greeksfp, greekssigned and parity prove relations in which the shared df·φ(d1) factor cancels, so a wrong CDF satisfies every one of them and is still wrong about the LEVEL — measured, a service running Abramowitz-Stegun 7.1.26 instead of Hart is refused here on 99.47% of legs, and the worst leg misses the band by 12,800x.',
      doesNotProve: 'That x is this leg\'s d1. The circuit takes the point as given, and binding it needs x = [ln(F/K) + ½σ²T]/(σ√T). A reader does that with ONE exponential rather than a logarithm — x is this leg\'s d1 iff K·exp(σ√T·x − ½σ²T) = F — and it is NOT in this circuit, though it is the same exp gadget ncdf.circom already contains, run backwards. What the shape buys is that the residue sits on the function every libm agrees about to under an ulp, not on the one where A-S and Hart differ by 82,000 grid steps. A corollary worth stating plainly: a wrong CDF that happens to be accurate AT THIS POINT is not detectable at this point, which is the 0.53% of legs A-S would still get past the band. It does not prove `portfolioValue`: the premium is df·(F·N(d1) − K·N(d2)), N(d2) is a SECOND point this instance does not carry, and once K ≠ F no identity collapses the two — that collapse is exactly what event-vol\'s at-the-forward straddle has and this does not. Nor `spanMargin`, which is the worst of 366 repricings of the book, 732 further CDF evaluations per leg, a search and not a formula. Nor the six finite-difference `checks`, which are agreement claims between two computations rather than identities over the inputs. It covers ONE leg: a multi-leg book is refused rather than served a proof of one leg under a heading that reads like the aggregate. And it says nothing about where σ came from — an implied vol is an input, and no circuit can attest that a number was read from a real options book.',
      note: 'A succinct proof over the public Hermez reference string, built off this request rather than inside it; fetch it at the URL above, free. The same circuit and the same verification key as event-vol — no new circuit, no new ceremony — reached by a different collapse. SCOPE, and each condition is why some particular greek would otherwise be a claim about a quantity the circuit does not carry: ONE leg (an n-leg aggregate is a sum over n points, and this store holds one proof per response), r = 0 (at r ≠ 0 theta regains its r·price term and the other five gain a discount factor that is itself a transcendental), and |d1| below the 7.0711 tail split where the circuit BOUNDS instead of evaluating — 98.62% of legs are below it, measured over 20,000 against the real engine. The envelope is ±1.11e-11 on delta, which at a 100,000 forward is ±1.11e-6 quote units of dollar delta per contract, against the ±7.5e-3 A-S 7.1.26 would misstate: 6,760x. Where the envelope would be wider than the last digit a greek is displayed to, the proof is refused rather than served as a statement about a neighbouring number.',
    },
  };
}

/**
 * The pieces of the guard, exposed for the same reason the other six encoders expose theirs: a gate
 * that measures a bound by watching what it happens to reject is a gate that cannot report headroom.
 */
export const _internalOptionsRiskNcdf = {
  GREEKS, DP, PHI_MAX, PHI_AT_1, EPS_N, EPS_P, FP_OPS,
  greeksFromProvenPair, sensitivities, reconstructLeg, agreesWithServed,
};
