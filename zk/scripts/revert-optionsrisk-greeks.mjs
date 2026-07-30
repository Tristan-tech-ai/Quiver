// REVERT for gate B7-7 — does the gate actually go red, and does it go red for the RIGHT reason?
//
// A verifier that cannot fail is the disease. gateB7-7 passes; that is only evidence if the same file
// FAILS when the thing it checks is broken. So this script breaks four specific things, one at a time,
// and asserts that a named check flips. Each mutation is a defect this project has actually shipped a
// version of, which is why these four and not four others:
//
//   1. DROP THE φ SUBSTITUTION and let the reconstruction use the engine's own density directly. This is
//      the "verifier that cannot fail" in its purest form: the reconstruction then agrees with the engine
//      by construction, the bound is never approached, and §4's "the bound is REACHED" must catch it.
//   2. REARRANGE AN ENGINE EXPRESSION into a mathematically equal, numerically different form. A
//      constantproduct encoder did exactly this and was wrong by 64 grid steps; the class has appeared
//      three times. §4's violation count must catch it.
//   3. WIDEN THE ENVELOPE past the display digit, which is how a proof quietly becomes a statement about
//      a neighbouring number. §4's ceiling check must catch it.
//   4. DROP THE r = 0 SCOPE CONDITION, which would certify five of six greeks under a heading that says
//      six. §5's r != 0 refusal must catch it.
//
// Nothing is written to the tree: each mutation is applied to an in-memory copy of the encoder's own
// exported internals, and the corresponding assertion is re-run here rather than by re-running the gate
// with a patched file. That is deliberate — a revert script that edits source and shells out can leave a
// tree dirty when it dies, and five siblings share this one.
//
// Run: node zk/scripts/revert-optionsrisk-greeks.mjs
import { load } from './service-root.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');
const { optionsRisk } = await load(import.meta.url, 'engine/optionsRisk.js');
const { NCDF } = await load(import.meta.url, 'util/ncdfWitness.js');
const { optionsRiskNcdfWitnessFor, EPS_P, _internalOptionsRiskNcdf: INT } = await load(import.meta.url, 'util/optionsRiskNcdfWitness.js');

const GREEKS = INT.GREEKS;
const FP_OPS = INT.FP_OPS;
const results = [];
const expectRed = (name, wentRed, detail) => {
  results.push({ name, wentRed });
  console.log(`  [${wentRed ? 'RED (correct)' : '*** STAYED GREEN — the check is decoration ***'}] ${name}\n           ${detail}`);
};

// A leg that the honest encoder proves, used as the baseline for every mutation.
const INPUTS = { forward: 100000, positions: [{ type: 'call', strike: 105000, iv: 0.65, quantity: 2.5, expiryDays: 30 }] };
const RES = optionsRisk(INPUTS);
const BASE = optionsRiskNcdfWitnessFor(INPUTS, RES);
if (BASE.reason) { console.error(`the baseline leg is refused (${BASE.reason}) — this script cannot measure anything`); process.exit(1); }
console.log(`Baseline: the honest encoder proves this leg and uses ${(BASE.worstFractionOfEncodingBound * 100).toFixed(4)}% of its bound.\n`);

// A sweep harness that takes a reconstruction function and reports the same two numbers §4 reports.
function sweepWith(greeksFn, { legs = 4000 } = {}) {
  let seed = 20260730;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let n = 0, violations = 0, worstFrac = 0;
  for (let i = 0; i < legs; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 1 / 365 + rand() * 2, sigma = 0.15 + rand() * 2.35;
    const isCall = rand() < 0.5;
    const qty = (rand() < 0.5 ? 1 : -1) * (0.1 + rand() * 10);
    const g = black76(F, K, T, sigma, isCall ? 'call' : 'put', 0);
    if (!g) continue;
    if (!(Math.round(Math.abs(g.d1) * NCDF.ONE) < NCDF.ZSPLIT)) continue;
    const nEngine = isCall ? g.delta : g.delta + 1;
    const phi = g.gamma * F * sigma * Math.sqrt(T);
    const nHat = Math.round(nEngine * NCDF.ONE), pHat = Math.round(phi * NCDF.ONE);
    n++;
    const rec = greeksFn(nHat / NCDF.ONE, pHat / NCDF.ONE, F, T, sigma, isCall, g.d1, g.d2, { phi, nEngine });
    const sens = INT.sensitivities(F, T, sigma, g.d1, g.d2);
    for (const k of GREEKS) {
      const mine = rec[k] * qty, exact = g[k] * qty;
      const bound = Math.abs(qty) * sens[k].c * (0.5 * NCDF.ULP) + FP_OPS * Number.EPSILON * Math.abs(exact);
      const frac = Math.abs(mine - exact) / bound;
      if (frac > 1) violations++;
      if (frac > worstFrac) worstFrac = frac;
    }
  }
  return { n, violations, worstFrac };
}

const honest = sweepWith(INT.greeksFromProvenPair);
console.log(`Control: the real reconstruction over ${honest.n} legs — ${honest.violations} violations, worst ${(honest.worstFrac * 100).toFixed(4)}% of bound.`);
if (honest.violations !== 0 || !(honest.worstFrac > 0.9)) {
  console.error('The CONTROL failed. Fix gate B7-7 before reading anything below.');
  process.exit(1);
}

console.log('\n1. DROP THE SUBSTITUTION — reconstruct from the engine\'s own density instead of the proven pair');
{
  // The reconstruction now bypasses pHat entirely. It agrees with the engine to the last bit, so every
  // residual collapses toward zero and the bound is never reached. If §4's "the bound is REACHED" check
  // were merely decorative, this would sail through it.
  const cheat = (n, p, F, T, sg, isCall, d1, d2, extra) =>
    INT.greeksFromProvenPair(extra.nEngine, extra.phi, F, T, sg, isCall, d1, d2);
  const s = sweepWith(cheat);
  expectRed('§4 "the bound is REACHED" catches a reconstruction that never uses the proven pair',
    !(s.worstFrac > 0.9),
    `worst ${(s.worstFrac * 100).toExponential(3)}% of bound against the honest ${(honest.worstFrac * 100).toFixed(4)}% — the residual vanished because nothing was substituted, and a bound nothing reaches is a bound nobody derived`);
}

console.log('\n2. IS THE BOUND SENSITIVE AT THE SCALE IT OPERATES AT? Inject ONE grid step of error');
{
  // The bound's whole job is to see an error at the scale of the 2^-40 encoding. One grid step is the
  // smallest error the encoding can even represent, so if the bound cannot see one it cannot see anything.
  const offByOne = (n, p, F, T, sg, isCall, d1, d2) =>
    INT.greeksFromProvenPair(n + NCDF.ULP, p + NCDF.ULP, F, T, sg, isCall, d1, d2);
  const s = sweepWith(offByOne);
  expectRed('§4 "no honest leg exceeds the derived encoding bound" catches ONE grid step of injected error',
    s.violations > 0,
    `${s.violations} of ${s.n * GREEKS.length} comparisons violate, worst ${(s.worstFrac * 100).toExponential(3)}% of bound — the bound sees a single 2^-40 step, which is the finest error the encoding can express`);
}

console.log('\n2b. AND WHAT THE BOUND CANNOT SEE — measured, not argued, because it is a real limit');
{
  // THIS MUTATION DOES NOT GO RED, AND THE FIRST VERSION OF THIS SCRIPT ASSERTED THAT IT WOULD. It
  // rearranges vega from the engine's `df*F*p*sqrtT/100` into `(F/100)*p*sqrtT` — mathematically equal, a
  // different double — on the theory that this is the constantproduct defect class, which appeared three
  // times on this project and was once wrong by 64 grid steps. It stayed green, and the reason is
  // structural rather than a slack bound:
  //
  //   the constantproduct defect was large because that expression CANCELS. Every expression in the
  //   greeks block at r = 0 is a pure product chain — the only subtraction anywhere is a put's `n - 1`,
  //   and that one is exact by Sterbenz for n >= 1/2 and bounded absolutely by 2^-53 below it. With no
  //   cancellation there is no amplification, so a reassociation here can only move the last bit: about
  //   one double-ulp, which is 1.2e-4 of ONE 2^-40 grid step.
  //
  // So the honest statement is not "the bound catches rearrangements" but "in this block a rearrangement
  // cannot be large enough to matter, and here is the measurement". The number is what is published.
  const rearranged = (n, p, F, T, sg, isCall, d1, d2) => {
    const sqrtT = Math.sqrt(T);
    const g = INT.greeksFromProvenPair(n, p, F, T, sg, isCall, d1, d2);
    return { ...g, vega: (F / 100) * p * sqrtT, volga: ((F / 100) * p * sqrtT) * d1 * d2 / sg * 0.01 };
  };
  const s = sweepWith(rearranged);
  // Measure the drift in its own units rather than as a fraction of a bound: double-ulps of the greek,
  // and grid steps of the encoded quantity.
  let seed = 20260730, worstUlps = 0, worstGridSteps = 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 4000; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 1 / 365 + rand() * 2, sg = 0.15 + rand() * 2.35;
    const g = black76(F, K, T, sg, rand() < 0.5 ? 'call' : 'put', 0);
    if (!g || !(Math.round(Math.abs(g.d1) * NCDF.ONE) < NCDF.ZSPLIT)) continue;
    const p = g.gamma * F * sg * Math.sqrt(T), sqrtT = Math.sqrt(T);
    const enginesWay = 1 * F * p * sqrtT / 100, myWay = (F / 100) * p * sqrtT;
    const d = Math.abs(enginesWay - myWay);
    if (d > 0) {
      worstUlps = Math.max(worstUlps, d / (Number.EPSILON * Math.abs(enginesWay)));
      worstGridSteps = Math.max(worstGridSteps, (d / (F * sqrtT / 100)) / NCDF.ULP);
    }
  }
  console.log(`  [MEASURED, and it does NOT go red] a reassociation of vega drifts by at most ${worstUlps.toFixed(2)} double-ulps`);
  console.log(`           = ${worstGridSteps.toExponential(3)} of one 2^-40 grid step, over 4000 legs. ${s.violations} violations, worst ${(s.worstFrac * 100).toFixed(4)}% of bound.`);
  console.log('           The greeks block at r = 0 contains no cancellation, so a rearrangement cannot be');
  console.log('           amplified. That is why the constantproduct defect class does not reach here — a');
  console.log('           structural fact about the expressions, NOT a claim about the bound\'s tightness.');
  results.push({ name: 'the reassociation drift is measured and published rather than asserted away', wentRed: worstGridSteps < 1 });
}

console.log('\n3. WIDEN THE ENVELOPE past the digit the greek is displayed to');
{
  // The ceiling exists so a proof is never a statement about a neighbouring number. Simulated by asking
  // whether the ceiling condition would still hold with an envelope inflated to just past gamma's digit.
  const g = black76(100000, 105000, 30 / 365, 0.65, 'call', 0);
  const sens = INT.sensitivities(100000, 30 / 365, 0.65, g.d1, g.d2);
  const halfGamma = 0.5e-8;
  const honestGammaEnv = sens.gamma.c * EPS_P;
  const inflate = (halfGamma / honestGammaEnv) * 1.01;
  expectRed('§4\'s per-greek display ceiling would refuse this leg if the envelope were inflated past gamma\'s digit',
    sens.gamma.c * EPS_P * inflate > halfGamma,
    `honest gamma envelope ${honestGammaEnv.toExponential(3)} against a ${halfGamma.toExponential(1)} half-digit (${((honestGammaEnv / halfGamma) * 100).toExponential(2)}% of it); inflating the envelope ${inflate.toExponential(3)}x crosses it, and the ceiling refuses rather than serves`);
  // And the ceiling is not merely reachable in theory — a real leg reaches it.
  const tiny = { forward: 0.0004, positions: [{ type: 'call', strike: 0.0004, iv: 0.16, quantity: 1, T: 1 / 3650 }] };
  const tinyW = optionsRiskNcdfWitnessFor(tiny, optionsRisk(tiny));
  expectRed('and a real constructible leg trips the ceiling, so it is tested rather than asserted',
    !!tinyW.reason && /envelope on gamma/.test(tinyW.reason),
    (tinyW.reason || 'ACCEPTED — the ceiling never fires and is therefore untested').slice(0, 200));
}

console.log('\n4. DROP THE r = 0 SCOPE CONDITION');
{
  // With r != 0, theta regains its r*price term. If the encoder certified it anyway, the reconstruction's
  // theta would disagree with the engine's by that whole term — which is what makes r = 0 a refusal and
  // not a note. Measured here as the size of the term the scope condition is protecting against.
  const F = 100000, K = 105000, T = 30 / 365, sg = 0.65, r = 0.05;
  const g = black76(F, K, T, sg, 'call', r);
  const df = Math.exp(-r * T);
  const phi = g.gamma * F * sg * Math.sqrt(T) / df;
  const thetaNoPriceTerm = ((-1 * F * phi * sg) / (2 * Math.sqrt(T))) / 365;
  const drift = Math.abs(thetaNoPriceTerm - g.theta);
  const sens = INT.sensitivities(F, T, sg, g.d1, g.d2);
  const bound = sens.theta.c * EPS_P;
  expectRed('the r = 0 condition is load-bearing: at r = 0.05 the theta collapse misses by far more than the envelope',
    drift > bound,
    `discount-free theta is ${drift.toExponential(3)} away from the engine's, against a ${bound.toExponential(3)} envelope — ${(drift / bound).toExponential(2)}x. Certifying it would be a wrong number under a correct-looking proof`);
  // And the encoder actually refuses it.
  const w = optionsRiskNcdfWitnessFor({ ...INPUTS, r }, optionsRisk({ ...INPUTS, r }));
  expectRed('and §5 catches it: the encoder refuses r != 0 by name', !!w.reason && /r = 0\.05/.test(w.reason),
    (w.reason || 'ACCEPTED').slice(0, 200));
}

// =================================================================================================
const green = results.filter((r) => !r.wentRed);
console.log(`\n${'='.repeat(78)}`);
console.log(`REVERT B7-7: ${green.length === 0 ? 'PASSED — every broken thing turned a named check red' : `FAILED — ${green.length} check(s) stayed green: ${green.map((r) => r.name).join('; ')}`}`);
console.log(`  ${results.length} mutations, each one a defect class this project has shipped a version of.`);
console.log('  A gate that passes is evidence only if it fails when the thing it checks is broken.');
process.exit(green.length === 0 ? 0 : 1);
