// PROBE — can `ncdf.circom` say anything about options-risk, and how wide is the envelope IN PRICE TERMS?
//
// gateB7-5 built the circuit and gateB7-6 wired it to event-vol, whose straddle is struck AT the
// forward so ln(F/K) = 0. options-risk's legs are struck anywhere, so d1 needs a logarithm and the
// straddle collapse does not exist here. The question this probe answers is what is LEFT.
//
// THE OBSERVATION THIS TURNS ON. options-risk publishes three blocks: `greeks`, `portfolioValue` and
// `spanMargin`. Read `src/engine/black76.js` at r = 0 (df = 1) and every one of the six greeks is a
// RATIONAL function of exactly two transcendentals, both taken at the SAME point d1:
//
//     delta = N(d1)  or  N(d1) - 1          <- the CDF
//     gamma = phi(d1) / (F*sigma*sqrtT)     <- the density
//     vega  = F*phi(d1)*sqrtT/100
//     vanna = -phi(d1)*d2/sigma * 0.01
//     volga = vega*d1*d2/sigma * 0.01
//     theta = -F*phi(d1)*sigma/(2*sqrtT)/365    <- the r*price term VANISHES at r = 0
//
// `ncdf.circom` publishes (x, N(x), phi(x)) at one point. So ONE instance of it pins the WHOLE greeks
// block of a one-leg book at r = 0 — six fields, not one. `portfolioValue` does not follow: the premium
// is df*(F*N(d1) - K*N(d2)) and N(d2) is a SECOND point this circuit does not carry. Neither does
// `spanMargin`, which is 366 repricings of the book.
//
// Run: node zk/scripts/probe-optionsrisk-ncdf.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const ZK = path.join(BUILD, '..');
const { black76 } = await load(import.meta.url, 'engine/black76.js');
const { optionsRisk } = await load(import.meta.url, 'engine/optionsRisk.js');

// ── 1. the circuit's constants, PARSED FROM THE CIRCOM SOURCE ────────────────────────────────────
// Not from build/ncdf-consts.json: that file and the circuit come out of one generator run, so
// agreeing with it proves nothing about the circuit that will actually be proved against.
const SRC = readFileSync(path.join(ZK, 'circuits', 'ncdf.circom'), 'utf8');
const konst = (name) => {
  const m = SRC.match(new RegExp(`var\\s+${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`${name} not found in ncdf.circom — the probe cannot proceed on a guess`);
  return Number(m[1]);
};
const S = konst('S'), TOLC = konst('TOLC'), TOLP = konst('TOLP');
const ZSPLIT = konst('ZSPLIT');
const ONE = 2 ** S, ULP = 2 ** -S;
console.log(`CIRCUIT (parsed from circuits/ncdf.circom): S=${S} TOLC=${TOLC} TOLP=${TOLP} ZSPLIT=${ZSPLIT / ONE}`);
console.log(`  ulp = 2^-${S} = ${ULP.toExponential(4)}`);

// ── 2. MY OWN ENVELOPE, DERIVED ──────────────────────────────────────────────────────────────────
// Three terms, and the third is the one a bound written off the circuit alone would miss.
//
//  (a) THE BAND. The circuit constrains 2*resid + tol <= 2*tol, i.e. |resid| <= TOLC/2 ulp on the CDF
//      and TOLP/2 on the density. That is TOLC/2 = 6 and TOLP/2 = 5.
//  (b) THE EVALUATOR. Hart in fixed point is not Hart in reals; gateB7-5 measures the gap over 2e6
//      points. I do NOT re-measure it here (that needs the 192-entry exp table, a third copy of
//      constants nothing compares) and I do not INHERIT it either: instead the bound below uses the
//      FULL TOLC as the (a)+(b) term, which is admissible exactly while TOLC >= TOLC/2 + evaluator.
//      The gate asserts that inequality against gateB7-5's own artifact rather than assuming it.
//  (c) THE x GRID. x is rounded once onto 2^-40, half a step. N is Lipschitz with constant
//      max phi = 1/sqrt(2pi), so that moves N by <= 0.5/sqrt(2pi) ulp. phi is Lipschitz with constant
//      max |x|phi(x) = phi(1), so it moves phi by <= 0.5*phi(1) ulp. Neither is tuned.
const PHI_MAX = 1 / Math.sqrt(2 * Math.PI);
const PHI_AT_1 = Math.exp(-0.5) / Math.sqrt(2 * Math.PI);
const ulpN = TOLC + 0.5 * PHI_MAX;
const ulpP = TOLP + 0.5 * PHI_AT_1;
const epsN = ulpN * ULP, epsP = ulpP * ULP;
console.log(`\nENVELOPE, DERIVED:`);
console.log(`  on N   : ${TOLC} (band+evaluator, conservative) + ${(0.5 * PHI_MAX).toFixed(5)} (x grid) = ${ulpN.toFixed(5)} ulp = ${epsN.toExponential(4)}`);
console.log(`  on phi : ${TOLP} + ${(0.5 * PHI_AT_1).toFixed(5)} = ${ulpP.toFixed(5)} ulp = ${epsP.toExponential(4)}`);
// Cross-check against gateB7-5's TIGHT derivation. This is a DOMINANCE check, not an inheritance:
// if the tight number ever exceeds the conservative one, the conservative one was never conservative.
const g75 = JSON.parse(readFileSync(path.join(BUILD, 'gateB7-5-ncdf.json'), 'utf8'));
console.log(`  gateB7-5's tight derivation: ${g75.envelope.envelopeUlpN.toFixed(4)} ulp on N, ${g75.envelope.envelopeUlpP.toFixed(4)} on phi`);
console.log(`  dominance: ${ulpN > g75.envelope.envelopeUlpN ? 'OK' : 'BROKEN'} on N (${(ulpN / g75.envelope.envelopeUlpN).toFixed(3)}x), ` +
  `${ulpP > g75.envelope.envelopeUlpP ? 'OK' : 'BROKEN'} on phi (${(ulpP / g75.envelope.envelopeUlpP).toFixed(3)}x)`);

// ── 3. THE RECONSTRUCTION, IN THE ENGINE'S OWN FLOAT ORDER ───────────────────────────────────────
// A constantproduct encoder once rearranged an engine expression into a mathematically equal,
// numerically different form and was wrong by 64 grid steps; that class has appeared three times. So
// every line below is the corresponding line of `black76` with ONE substitution — ncdf(d1) -> n,
// npdf(d1) -> p — and nothing else reassociated. d1, d2 and sqrtT come from the engine's own return.
function greeksFrom(n, p, F, T, sigma, isCall, d1, d2) {
  const sqrtT = Math.sqrt(T);
  const df = 1;                                       // r = 0; the probe and the encoder both require it
  const delta = df * (isCall ? n : n - 1);
  const gamma = df * p / (F * sigma * sqrtT);
  const vega = df * F * p * sqrtT / 100;
  const vanna = (-df * p * d2 / sigma) * 0.01;
  const volga = vega * d1 * d2 / sigma * 0.01;
  const theta = ((-df * F * p * sigma) / (2 * sqrtT)) / 365;
  return { delta, gamma, vega, vanna, volga, theta };
}
// The coefficient |dg/dV| for each greek, so an envelope on N or phi becomes an envelope on the greek.
// Affine in n and p, so these are exact, not linearisations.
function coeffs(F, T, sigma, d1, d2) {
  const sqrtT = Math.sqrt(T), vegaC = F * sqrtT / 100;
  return {
    delta: { on: 'N', c: 1 },
    gamma: { on: 'P', c: 1 / (F * sigma * sqrtT) },
    vega: { on: 'P', c: vegaC },
    vanna: { on: 'P', c: Math.abs(d2 / sigma) * 0.01 },
    volga: { on: 'P', c: Math.abs(vegaC * d1 * d2 / sigma * 0.01) },
    theta: { on: 'P', c: (F * sigma / (2 * sqrtT)) / 365 },
  };
}

// ── 4. SWEEP AGAINST THE REAL ENGINE ─────────────────────────────────────────────────────────────
// `optionsRisk` itself, called the way the service calls it, not black76 and not a recomputation.
const GREEKS = ['delta', 'gamma', 'vega', 'vanna', 'volga', 'theta'];
const DP = { delta: 6, gamma: 8, vega: 6, vanna: 6, volga: 6, theta: 6 };
let seed = 987654321;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// THE FIRST VERSION OF THIS SWEEP MEASURED A BOUND THAT COULD NOT FAIL, and it is recorded rather
// than quietly fixed. It compared the reconstruction to the SERVED (rounded) greek against a bound of
// `envelope + half a display digit`, and reported 99.98% of bound used on all six. That number was
// real and it was meaningless: the envelope on delta is 1.11e-11 and half its display digit is 5e-7,
// so 99.998% of the bound WAS the rounding, a term saturated by every honest leg and violated by
// nothing. That is the liquidation half-cent again — a guard whose width is set by a term that admits
// everything. So the comparison below is against the engine's OWN UNROUNDED greek, bounded by the
// encoding alone, and the display digit is handled where it belongs: by an EQUALITY on the rounded
// value, which is a different test with a different failure mode.
const worstFrac = Object.fromEntries(GREEKS.map((g) => [g, 0]));
const worstAbs = Object.fromEntries(GREEKS.map((g) => [g, 0]));
let displayMismatch = 0;
// The longest float chain among the six, COUNTED off black76: volga = ((df*F)*p*sqrtT/100)*d1*d2/sigma*0.01
// then *qty — nine operations. The reconstruction performs the identical nine on an operand perturbed
// by at most half a 2^-40 step, so the two differ by the affine term plus at most one double-ulp per
// operation. Nine is read off the source, not chosen.
const FP_OPS = 9;
let n = 0, offSplit = 0, outOfRange = 0, displayCeil = 0;
const N_LEGS = 20000;
for (let i = 0; i < N_LEGS; i++) {
  const F = 10 ** (1 + rand() * 4);
  const K = F * (0.3 + rand() * 2.7);
  const T = 1 / 365 + rand() * 2;
  const sigma = 0.15 + rand() * 2.35;
  const isCall = rand() < 0.5;
  const qty = (rand() < 0.5 ? 1 : -1) * (0.1 + rand() * 10);
  const inp = { forward: F, r: 0, positions: [{ type: isCall ? 'call' : 'put', strike: K, T, iv: sigma, quantity: qty }] };
  const res = optionsRisk(inp);
  if (res.ok !== true) continue;
  const g = black76(F, K, T, sigma, isCall ? 'call' : 'put', 0);
  if (!g) continue;
  const d1 = g.d1, d2 = g.d2;
  const xMag = Math.round(Math.abs(d1) * ONE);
  if (!(xMag < ZSPLIT)) { offSplit++; continue; }
  // the engine's own two values, LIFTED: delta is ncdf(d1) (shifted by 1 for a put) and gamma
  // multiplies the density's own division back out, which is gateB7-5's recovery, not a new formula.
  const nEngine = isCall ? g.delta : g.delta + 1;
  const phi = g.gamma * F * sigma * Math.sqrt(T);
  const nHat = Math.round(nEngine * ONE), pHat = Math.round(phi * ONE);
  if (!(nHat >= 0 && nHat <= ONE && pHat >= 0 && pHat < ONE)) { outOfRange++; continue; }
  n++;
  const rec = greeksFrom(nHat / ONE, pHat / ONE, F, T, sigma, isCall, d1, d2);
  const cf = coeffs(F, T, sigma, d1, d2);
  for (const k of GREEKS) {
    // The engine's UNROUNDED aggregate for a one-leg book is exactly qty * black76's own greek, and
    // black76 is called here the way optionsRisk calls it. Nothing is recomputed.
    const engineExact = g[k] * qty;
    const mine = rec[k] * qty;
    // THE TIGHT BOUND: half a 2^-40 step on the one substituted operand, carried through the affine
    // coefficient, plus the float slack of nine identical operations on a perturbed operand.
    const bound = Math.abs(qty) * cf[k].c * (0.5 * ULP) + FP_OPS * Number.EPSILON * Math.abs(engineExact);
    const gap = Math.abs(mine - engineExact);
    const frac = gap / bound;
    if (frac > worstFrac[k]) worstFrac[k] = frac;
    if (gap > worstAbs[k]) worstAbs[k] = gap;
    // and separately: does the reconstruction DISPLAY as the number that was served?
    if (Number(mine.toFixed(DP[k])) !== res.greeks[k]) displayMismatch++;
  }
}
console.log(`\nSWEEP against the REAL optionsRisk engine: ${n} legs proved-shaped of ${N_LEGS} (${offSplit} above the split, ${outOfRange} out of range)`);
console.log(`  TIGHT: |reconstruction - engine's own unrounded greek| against the encoding bound alone`);
for (const k of GREEKS) {
  console.log(`  ${k.padEnd(6)} worst gap ${worstAbs[k].toExponential(3)}, ${(worstFrac[k] * 100).toFixed(4)}% of the derived encoding bound`);
}
console.log(`  display equality: ${displayMismatch} of ${n * GREEKS.length} reconstructed greeks do not round to the served figure`);

// ── 5. IN PRICE TERMS — what a buyer actually cares about ────────────────────────────────────────
// A greek is not a price. The two that ARE quote-unit quantities per contract are the DOLLAR DELTA
// (delta * F, the directional exposure) and vega/theta, which black76 already returns in quote units.
// Reported against the forward, never against the premium: a deep out-of-the-money premium is 1e-70
// and a ratio to it is a number about nothing (gateB7-5 measured the same denominator saying 19.4%
// at one seed and 18,526% at another).
console.log(`\nIN PRICE TERMS, per contract, at sigma = 0.65 and T = 30/365:`);
const Tref = 30 / 365, sgRef = 0.65;
for (const F of [1, 3000, 100000]) {
  const sq = Math.sqrt(Tref);
  const dollarDelta = F * epsN;
  const vegaErr = F * sq / 100 * epsP;
  const thetaErr = (F * sgRef / (2 * sq)) / 365 * epsP;
  console.log(`  F ${String(F).padStart(6)}  dollar-delta +-${dollarDelta.toExponential(3)}  vega +-${vegaErr.toExponential(3)}  theta +-${thetaErr.toExponential(3)} quote units`);
}
// And the thing it exists to refuse, in the SAME unit. A-S 7.1.26 carries up to 7.5e-8 of absolute
// CDF error by construction, so its dollar-delta error at F is 7.5e-8 * F.
const AS_CDF = 7.5e-8;
console.log(`  A-S 7.1.26's dollar-delta error at F=100000: +-${(AS_CDF * 100000).toExponential(3)} quote units — ${(AS_CDF / epsN).toExponential(2)}x this envelope.`);

// ── 6. HOW OFTEN IS A LEG EVEN REACHABLE, AND HOW OFTEN IS THE ENVELOPE UNDER THE DISPLAY DIGIT ──
// The proof is only about the number that was SERVED if the envelope is finer than the last digit it
// was served at. delta is round(.,6) so the half-unit is 5e-7; gamma is round(.,8) -> 5e-9.
let reach = 0, tooCoarse = 0, tot = 0;
seed = 13572468;
for (let i = 0; i < 20000; i++) {
  const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
  const T = 1 / 365 + rand() * 2, sigma = 0.15 + rand() * 2.35;
  const g = black76(F, K, T, sigma, rand() < 0.5 ? 'call' : 'put', 0);
  if (!g) continue;
  tot++;
  if (!(Math.round(Math.abs(g.d1) * ONE) < ZSPLIT)) continue;
  reach++;
  const cf = coeffs(F, T, sigma, g.d1, g.d2);
  const widest = GREEKS.some((k) => cf[k].c * (cf[k].on === 'N' ? epsN : epsP) > 0.5 * 10 ** -DP[k]);
  if (widest) tooCoarse++;
}
console.log(`\nREACHABILITY over ${tot} legs: ${((reach / tot) * 100).toFixed(2)}% below the split; of those, ${((tooCoarse / reach) * 100).toFixed(3)}% have some greek whose envelope exceeds half its display digit.`);

// ── 7. THE SUBSTITUTION ATTACK, ON options-risk's OWN SLICE OF THE x AXIS ────────────────────────
// event-vol only ever asks for x = sigma*sqrtT/2 > 0. options-risk asks anywhere. So the refusal rate
// gateB7-5 measured is not this service's, and is re-measured here rather than carried over.
function asNcdf(x) {                                  // Abramowitz-Stegun 7.1.26, the wrong CDF
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * e);
}
let asTried = 0, asAccepted = 0, asWorstUlp = 0;
seed = 55554444;
for (let i = 0; i < 20000; i++) {
  const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
  const T = 1 / 365 + rand() * 2, sigma = 0.15 + rand() * 2.35;
  const isCall = rand() < 0.5;
  const g = black76(F, K, T, sigma, isCall ? 'call' : 'put', 0);
  if (!g) continue;
  if (!(Math.round(Math.abs(g.d1) * ONE) < ZSPLIT)) continue;
  const nTrue = isCall ? g.delta : g.delta + 1;
  const nWrong = asNcdf(g.d1);
  const offUlp = Math.abs(nWrong - nTrue) / ULP;
  asWorstUlp = Math.max(asWorstUlp, offUlp);
  asTried++;
  if (offUlp <= TOLC / 2) asAccepted++;              // inside the band the circuit actually enforces
}
console.log(`\nA-S SUBSTITUTION on options-risk's slice: ${asTried} legs, ${asAccepted} would land inside the ${TOLC / 2}-ulp band (${((1 - asAccepted / asTried) * 100).toFixed(4)}% refused), worst ${asWorstUlp.toExponential(3)} ulp = ${(asWorstUlp / (TOLC / 2)).toExponential(2)}x the band.`);

// ── 8. MULTI-LEG: what it would cost, so the scope decision is measured and not assumed ──────────
console.log(`\nSCOPE: gateB7-5 measured ${g75.proveMs} ms and ${g75.plonkConstraints} constraints for ONE point.`);
console.log(`  The proof store is keyed by content hash and holds ONE proof per response, so an n-leg`);
console.log(`  book needs n proofs under one key: not a cost question, a shape question.`);
console.log(`  A ONE-leg book's aggregate greeks ARE that leg's greeks, which is why the scope is one leg.`);
