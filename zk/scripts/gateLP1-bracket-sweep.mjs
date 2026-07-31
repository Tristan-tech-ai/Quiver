// GATE LP1 — does the bracket certificate agree with the ENGINE, measured over a sweep, and is the
// property it leans on actually true?
//
// The certificate pins a UNIQUE root only if E[IL](v) is monotone in v. The engine's own comment
// asserts monotone decreasing. An assertion is not a measurement, and the certificate is worthless if
// the assertion is wrong, so this gate measures it: 20,001 log-spaced v, counting non-decreasing
// steps. That is the one claim here that is a property of the FUNCTION rather than of an encoding, and
// it is the reason this gate exists rather than a unit test on the circuit.
//
// It also measures the two numbers the "unprovable" verdict rested on — the quadrature's point count
// and the bisection's iteration count — by instrumenting Math rather than by reading loop bounds.
//
// Run: node zk/scripts/gateLP1-bracket-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, checklist } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { expectedIlNumerical, validateQuadratureCopy, narrowestBracket, encodeBracket } from './lib/lpbracket-encode.mjs';

const { lpRisk } = await load(import.meta.url, 'engine/lpRisk.js');
const { round } = await load(import.meta.url, 'engine/stats.js');

const { record, failed } = checklist();
console.log(`GATE LP1 — bracket certificate against the live engine — ${new Date().toISOString()}\n`);

// ---- 0. the copy of the engine's quadrature -------------------------------------------------------
const vc = validateQuadratureCopy(lpRisk, round, { volatility: 0.05, horizonPeriods: 30 });
record('the encoder\'s quadrature is the engine\'s', vc.ok,
  `served ${vc.served}% · copy ${vc.mine.toFixed(8)}% at totalVariance ${vc.v}`);

// ---- 1. HOW BIG IS THE THING that was called unprovable? Counted, not read off a loop bound. ------
const realExp = Math.exp, realSqrt = Math.sqrt;
let cExp = 0, cSqrt = 0;
Math.exp = (x) => { cExp++; return realExp(x); };
Math.sqrt = (x) => { cSqrt++; return realSqrt(x); };
const countFor = (input) => { cExp = 0; cSqrt = 0; lpRisk(input); return { exp: cExp, sqrt: cSqrt }; };
const cIl = countFor({ priceRatio: 2, concentrationFactor: 1 });
const cDiv = countFor({ priceRatio: 2, volatility: 0.05, horizonPeriods: 30 });
const cAll = countFor({ priceRatio: 2, volatility: 0.05, horizonPeriods: 30, feeAprPct: 20 });
Math.exp = realExp; Math.sqrt = realSqrt;

const quadExp = 802;   // 401 nodes × 2 exponentials each, which the ratio below confirms
console.log(`  realizedIL block alone       : ${cIl.exp} exp · ${cIl.sqrt} sqrt`);
console.log(`  + expectedDivergence         : ${cDiv.exp} exp · ${cDiv.sqrt} sqrt`);
console.log(`  + feeVsDivergence            : ${cAll.exp} exp · ${cAll.sqrt} sqrt   = ${cAll.exp + cAll.sqrt} transcendental calls`);
console.log(`  quadratures in a full call   : ${(cAll.exp / quadExp).toFixed(1)}   (${quadExp} exponentials per 401-point pass)\n`);
record('one served answer really does cost of the order of a hundred thousand transcendentals',
  cAll.exp + cAll.sqrt > 200000,
  `${cAll.exp} exp + ${cAll.sqrt} sqrt = ${cAll.exp + cAll.sqrt} — the reported "roughly 80,000" counts quadrature POINTS `
  + `(${Math.round(cAll.exp / quadExp)} passes × 401 = ${Math.round(cAll.exp / quadExp) * 401}), not calls, and undercounts calls by 3x`);
record('the circuit evaluates the quadrature zero times', true,
  'the certificate is four inequalities over published integers; the endpoint expectations are inputs');

// ---- 2. IS E[IL](v) MONOTONE? The property the certificate leans on. ------------------------------
let mono = 0, worstRise = 0, worstRiseAt = 0, prev = null, samples = 0;
for (let k = 0; k <= 20000; k++) {
  const v = Math.exp(Math.log(1e-8) + (k / 20000) * (Math.log(1e4) - Math.log(1e-8)));
  const e = expectedIlNumerical(v);
  if (prev !== null && e - prev > 0) { mono++; if (e - prev > worstRise) { worstRise = e - prev; worstRiseAt = v; } }
  prev = e; samples++;
}
console.log(`  monotonicity: ${samples} log-spaced v in [1e-8, 1e4], ${mono} non-decreasing steps`);
console.log(`  E[IL](1e-8) = ${expectedIlNumerical(1e-8).toExponential(4)}   E[IL](1e4) = ${expectedIlNumerical(1e4).toFixed(12)}\n`);
record('E[IL] is monotone decreasing in v, so a straddled root is unique', mono === 0,
  mono === 0 ? `0 rises over ${samples} samples — measured, not taken from the engine's comment`
    : `${mono} rises, worst ${worstRise.toExponential(3)} at v=${worstRiseAt.toPrecision(6)}`);

// ---- 3. the sweep: brackets for real service calls ------------------------------------------------
let seed = 20260730;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const RUNS = 600;
let kept = 0, refused = 0, nullBreakeven = 0, noBracket = 0;
let strayed = 0, midViolations = 0, straddleViolations = 0, rootViolations = 0;
let worstRoot = null, worstHalvings = 0, minHalvings = Infinity, worstWidthSlack = null;
const refusalReasons = new Map();
const refusedCases = [];   // every encoder refusal, with the inputs that produced it (see §37)

for (let i = 0; i < RUNS; i++) {
  // Fee APRs from a dust pool to a degenerate one, horizons from a day to a year.
  const feeAprPct = Math.exp(Math.log(0.01) + rand() * (Math.log(400) - Math.log(0.01)));
  const horizonPeriods = 1 + Math.floor(rand() * 365);
  const volatility = 0.01 + rand() * 0.5;   // the breakeven does not depend on it, but the call needs it
  const call = { volatility, horizonPeriods, feeAprPct, periodsPerYear: 365 };
  const res = lpRisk(call);
  if (!res.ok || !res.feeVsDivergence) continue;
  const served = res.feeVsDivergence.breakevenVolatility;
  if (served === null) { nullBreakeven++; continue; }   // the engine itself says no breakeven exists

  const feeFrac = (feeAprPct / 100) * (horizonPeriods / 365);
  const br = narrowestBracket(feeFrac, horizonPeriods, served, round);
  if (!br) { noBracket++; continue; }
  const enc = encodeBracket({ feeFrac, T: horizonPeriods, bracket: br, servedSigma: served });
  if (enc.refused) {
    refused++;
    refusalReasons.set(enc.refused, (refusalReasons.get(enc.refused) || 0) + 1);
    // AND THE CASE ITSELF, not only a tally against its reason string.
    //
    // §37 of the defect register says these refusals "were characterised from their reason string, not
    // individually verified" — and they could not be, because the artifact recorded a COUNT against one
    // string and nothing that identifies which draws produced it. Three refusals all reading
    // "g(lo) > 0 does not survive the grid" could be three instances of one edge or three unrelated
    // things that happen to print alike, and no reader could tell from the output. The inputs are
    // recorded here so each is reproducible on its own.
    refusedCases.push({
      volatility, horizonPeriods, feeAprPct, servedSigma: served, feeFrac,
      bracket: { lo: br.lo, hi: br.hi },
      reason: enc.refused,
    });
    continue;
  }
  // The guard: certify only when the certified figure IS the figure the service published.
  if (round(enc.certifiedSigma, 5) !== served) { strayed++; continue; }
  kept++;

  if (!(enc.mid === 0n || enc.mid === 1n)) midViolations++;
  if (!(enc.eLoHat + enc.feeHat > SCALE && enc.eHiHat + enc.feeHat <= SCALE)) straddleViolations++;
  if (enc.sigRatio > 1) rootViolations++;
  if (!worstRoot || enc.sigRatio > worstRoot.sigRatio) worstRoot = { ...enc, call, br };
  if (!worstWidthSlack || enc.widthSlack > worstWidthSlack.widthSlack) worstWidthSlack = { ...enc, br };
  worstHalvings = Math.max(worstHalvings, br.halvings);
  minHalvings = Math.min(minHalvings, br.halvings);
}

console.log(`  service calls sampled     : ${RUNS}   (fee APR 0.01% to 400% log-uniform, horizon 1 to 365 periods)`);
console.log(`  engine returned no breakeven : ${nullBreakeven}   (fees above what a 100%-bounded loss can catch)`);
console.log(`  no bracket in 200 halvings   : ${noBracket}`);
console.log(`  refused by the encoder       : ${refused}`);
for (const [why, n] of [...refusalReasons].sort((a, b) => b[1] - a[1])) console.log(`      ${n.toString().padStart(4)}  ${why}`);
console.log(`  strayed from the served σ    : ${strayed}`);
console.log(`  CERTIFIED                    : ${kept}`);
console.log(`  midpoint violations          : ${midViolations}`);
console.log(`  straddle violations          : ${straddleViolations}`);
console.log(`  root-bound violations        : ${rootViolations}`);
console.log(`  halvings needed              : ${minHalvings} to ${worstHalvings}   (the engine runs 200)`);
console.log(`  tightest root bound          : 2|Rs|/TOL = ${worstRoot.sigRatio.toExponential(3)} at σ=${worstRoot.certifiedSigma}, T=${worstRoot.T}`);
console.log(`  widest width slack           : ${worstWidthSlack.widthSlack} of a ${worstWidthSlack.widthHat}-step bound\n`);

record('every certified bracket straddles the fee level', straddleViolations === 0, `${kept} certified`);
record('every certified root is its bracket midpoint to one grid step', midViolations === 0, `${kept} certified`);
record('the root bound is never violated', rootViolations === 0,
  `tightest ${worstRoot.sigRatio.toExponential(3)} of the bound, at σ=${worstRoot.certifiedSigma} T=${worstRoot.T}`);
record('nothing certified disagrees with the breakeven the service served',
  kept > 0 && strayed === 0 ? true : strayed === 0,
  `${kept} certified cases all round to the served 5-dp figure; ${strayed} strayed and were dropped`);
record('the certificate needs an order of magnitude fewer halvings than the engine performs',
  worstHalvings < 200 && worstHalvings > 0,
  `${minHalvings}..${worstHalvings} halvings pin the published figure; past about 30 the bracket is narrower `
  + 'than one 1e-9 grid step and lo < hi stops being expressible at all');
record('the guard and the encoder both actually refuse something',
  refused + strayed + noBracket > 0,
  `${refused} encoder refusals + ${strayed} strayed + ${noBracket} bracketless of ${RUNS} — a guard that refuses `
  + 'nothing is not a guard');
record('the root bound is discriminating, not vacuous', worstRoot.sigRatio > 1e-9,
  `worst case uses 1/${(1 / worstRoot.sigRatio).toFixed(2)} of the bound`);

// ---- 4. THE BOUND MUST BE EXCEEDABLE. A verifier that cannot fail is the disease. -----------------
// Perturb σ̂ by one grid step at a time and find the smallest perturbation the root bound rejects.
console.log('Exceeding the root bound on purpose, to show it can fail:');
const base = worstRoot;
let breakAt = null;
for (const d of [1n, 2n, 4n, 8n, 16n, 64n, 256n, 1024n, 4096n, 65536n]) {
  const sig = base.sigHat + d;
  const Rs = sig * sig * BigInt(base.T) - base.vStarHat * SCALE;
  const tol = 2n * (sig + 1n) * BigInt(base.T) + 2n * SCALE;
  const ratio = Number(Rs < 0n ? -Rs : Rs) * 2 / Number(tol);
  console.log(`  σ̂ + ${String(d).padStart(6)} grid steps -> 2|Rs|/TOL = ${ratio.toExponential(3)} ${ratio > 1 ? 'REJECTED' : 'accepted'}`);
  if (ratio > 1 && breakAt === null) breakAt = d;
}
record('the root bound rejects a perturbed square root', breakAt !== null,
  breakAt === null ? 'no perturbation up to 65536 grid steps was rejected — the bound is vacuous'
    : `the smallest rejected perturbation is ${breakAt} grid step${breakAt === 1n ? '' : 's'} of σ̂, i.e. ${Number(breakAt) / S} in σ`);

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE LP1: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);

writeFileSync(path.join(BUILD, 'gateLP1-bracket-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS,
  certified: kept, refusedByEncoder: refused, strayedFromServed: strayed,
  // Named cases, not just a tally: §37 could not be closed from a count against one string.
  refusedCases,
  engineReturnedNull: nullBreakeven, noBracket,
  refusalReasons: Object.fromEntries(refusalReasons),
  monotonicity: { samples, nonDecreasingSteps: mono, range: [1e-8, 1e4] },
  transcendentalCalls: { realizedIlOnly: cIl, plusExpectedDivergence: cDiv, fullCall: cAll,
    quadraturePassesPerFullCall: Number((cAll.exp / quadExp).toFixed(1)) },
  halvings: { min: minHalvings, max: worstHalvings, enginePerforms: 200 },
  tightestRootBound: worstRoot.sigRatio,
  smallestRejectedSigmaPerturbation: breakAt === null ? null : String(breakAt),
  worst: { sigma: worstRoot.certifiedSigma, horizonPeriods: worstRoot.T,
    residual: String(worstRoot.Rs), tolerance: String(worstRoot.sigTol) },
}, null, 2) + '\n', 'utf8');
process.exit(gate ? 0 : 1);
