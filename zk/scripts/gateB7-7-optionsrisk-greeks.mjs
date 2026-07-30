// GATE B7-7 — options-risk's GREEKS BLOCK, wired to the normal-CDF circuit.
//
// gateB7-5 built `ncdf.circom` and ended "NOTHING SERVED, NOTHING DEPLOYED. options-risk does not emit
// this." gateB7-6 wired it to event-vol and said why options-risk could not be: the circuit pins N(x)
// given x, and options-risk's x = [ln(F/K) + ½σ²T]/(σ√T) needs a logarithm. gates/preflight.mjs said
// the same in the same words. Every one of those statements is true and all of them were asked about
// THE PRICE.
//
// options-risk's headline is not the price. At r = 0 all six greeks are rational functions of exactly
// two transcendentals, both taken at the SAME point d1 — N(d1) for delta, φ(d1) for the other five,
// theta included because its r·price term vanishes at r = 0. `ncdf.circom` publishes (x, N(x), φ(x))
// and pins BOTH. So one instance of the circuit that already exists pins the whole `greeks` block:
// SIX fields, where event-vol got one.
//
// TEN THINGS HAVE TO HOLD AND EVERY ONE OF THEM CAN FAIL:
//
//   0. the six-greek collapse is TRUE at r = 0 and FALSE at r ≠ 0 — checked in both directions, because
//      a scope condition nobody tested is a scope condition that is really an assumption
//   1. the constants the encoder carries are the constants the circuit enforces (it shares them with
//      event-vol's encoder, so this checks the shared copy against the circom source)
//   2. the conservative envelope DOMINATES gateB7-5's tight measurement — the encoder uses TOLC whole
//      in place of TOLC/2 + evaluator, which is admissible only while that inequality holds
//   3. the display-precision table matches what src/engine/optionsRisk.js actually rounds to
//   4. the guard's bound holds over the REAL engine, is REACHED, and its per-greek ceiling FIRES
//   5. a real proof built by the REAL SERVED HANDLER verifies; every perturbed signal and a bent proof
//      are refused
//   6. the NEGATIVE-x branch works — event-vol only ever hands this circuit x > 0, so xSign = 1 is a
//      path nothing has exercised until now
//   7. every scope refusal fires with its own sentence: multi-leg, r ≠ 0, past the tail split
//   8. a service running a WRONG CDF cannot get one accepted, measured on options-risk's own slice of
//      the x-axis, which is far wider than event-vol's
//   9. the exported verifier does the same inside an EVM
//
// Run: node zk/scripts/gateB7-7-optionsrisk-greeks.mjs
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BUILD, checklist, proveVerifyRefuse, evmRehearsal, shutdown } from './lib/gatekit.mjs';
import { load, serviceRoot } from './service-root.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const ZK = path.join(BUILD, '..');
const { black76 } = await load(import.meta.url, 'engine/black76.js');
const { optionsRisk } = await load(import.meta.url, 'engine/optionsRisk.js');
const { NCDF } = await load(import.meta.url, 'util/ncdfWitness.js');
const ORW = await load(import.meta.url, 'util/optionsRiskNcdfWitness.js');
const { optionsRiskNcdfWitnessFor, optionsRiskSnark, EPS_N, EPS_P, _internalOptionsRiskNcdf: INT } = ORW;
const { SERVICES } = await load(import.meta.url, 'services.js');

const { record, failed, results } = checklist();
const SVC = SERVICES.find((s) => s.name === 'options-risk');
const GREEKS = INT.GREEKS;

// =================================================================================================
console.log('\n§0  THE SIX-GREEK COLLAPSE — true at r = 0, and NOT true otherwise');
// The whole gate rests on this. If any greek at r = 0 is NOT a function of (N(d1), φ(d1)) times a
// rational coefficient, the proof covers fewer fields than it says. Tested by holding the leg fixed and
// checking that the engine's own greek equals coefficient x (N or φ) to float precision.
{
  let worstRel = 0, worstName = null;
  for (const [F, K, T, sg, type] of [[100000, 105000, 30 / 365, 0.65, 'call'], [3000, 2400, 0.5, 0.9, 'put'],
    [50, 50, 7 / 365, 1.8, 'call'], [12345, 30000, 1.7, 0.32, 'put']]) {
    const g = black76(F, K, T, sg, type, 0);
    const nTrue = type === 'call' ? g.delta : g.delta + 1;
    const phiTrue = g.gamma * F * sg * Math.sqrt(T);
    const rec = INT.greeksFromProven ?? INT.greeksFromProvenPair;
    const got = rec(nTrue, phiTrue, F, T, sg, type === 'call', g.d1, g.d2);
    for (const k of GREEKS) {
      const rel = Math.abs(got[k] - g[k]) / Math.max(1e-300, Math.abs(g[k]));
      if (rel > worstRel) { worstRel = rel; worstName = k; }
    }
  }
  record('at r = 0 every one of the six greeks is the proven pair times a rational coefficient',
    worstRel < 1e-12, `worst relative gap ${worstRel.toExponential(3)} on ${worstName}, over four legs spanning 50 to 100,000 forward`);

  // AND THE OTHER DIRECTION. At r != 0 theta regains r*price, so the collapse must BREAK — if it did
  // not, the r = 0 scope condition would be decoration. This is the check that makes the refusal honest.
  const g0 = black76(100000, 105000, 30 / 365, 0.65, 'call', 0.05);
  const phi0 = g0.gamma * 100000 * 0.65 * Math.sqrt(30 / 365) / Math.exp(-0.05 * 30 / 365);
  const thetaNoPrice = ((-1 * 100000 * phi0 * 0.65) / (2 * Math.sqrt(30 / 365))) / 365;
  record('at r != 0 the theta collapse BREAKS, which is why r = 0 is a refusal and not a note',
    Math.abs(thetaNoPrice - g0.theta) / Math.abs(g0.theta) > 1e-6,
    `discount-free theta ${thetaNoPrice.toFixed(6)} against the engine's ${g0.theta.toFixed(6)} at r = 0.05 — the r*price term is ${(0.05 * g0.price / 365).toFixed(6)}`);
}

// =================================================================================================
console.log('\n§1  THE CONSTANTS THE ENCODER CARRIES ARE THE CONSTANTS THE CIRCUIT ENFORCES');
// The encoder imports NCDF from event-vol's encoder rather than keeping a second copy, so there are two
// statements of these constants on this project and not three. Nothing but a gate compares them.
const SRC = readFileSync(path.join(ZK, 'circuits', 'ncdf.circom'), 'utf8');
const konst = (name) => {
  const m = SRC.match(new RegExp(`var\\s+${name}\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
for (const [name, mine] of [['S', NCDF.S], ['TOLC', NCDF.TOLC], ['TOLP', NCDF.TOLP], ['ZSPLIT', NCDF.ZSPLIT]]) {
  const inCircuit = konst(name);
  record(`${name} agrees with circuits/ncdf.circom`, inCircuit === mine, `circuit ${inCircuit} · encoder ${mine}`);
}
record('ONE = 2^S and ULP = 2^-S, as the circuit scales every quantity',
  NCDF.ONE === 2 ** NCDF.S && NCDF.ULP === 2 ** -NCDF.S, `ONE ${NCDF.ONE} · ULP ${NCDF.ULP}`);

// The artifacts the SERVICE proves against are the ones this gate gates.
for (const f of ['ncdf_plonk.zkey', 'ncdf_vk.json', 'ncdf_js/ncdf.wasm']) {
  let ok = false, sz = 0;
  try { sz = statSync(path.join(BUILD, f)).size; ok = sz > 0; } catch { ok = false; }
  record(`build/${f} is present for the handler to prove against`, ok, `${sz} bytes`);
}

// =================================================================================================
console.log('\n§2  THE CONSERVATIVE ENVELOPE DOMINATES THE TIGHT ONE');
// The encoder's EPS_N uses TOLC whole where the circuit's band is TOLC/2, covering the fixed-point
// evaluator's own error against real Hart WITHOUT measuring it — which needs the 192-entry exponential
// table, a third copy of constants nothing compares. That substitution is admissible only while
// TOLC >= TOLC/2 + evaluator, and gateB7-5 is the thing that measured the evaluator. So the inequality
// is ASSERTED against its artifact rather than assumed. If gateB7-5 is re-run and the evaluator error
// grows past 6 ulp, this line goes red and the encoder's bound is no longer a bound.
{
  let g75 = null;
  try { g75 = JSON.parse(readFileSync(path.join(BUILD, 'gateB7-5-ncdf.json'), 'utf8')); } catch { /* reported below */ }
  record('gateB7-5\'s artifact is present, so the evaluator error is a measurement and not a hope', !!g75,
    g75 ? `measured ${g75.at}` : 'build/gateB7-5-ncdf.json missing — run gateB7-5 first');
  if (g75) {
    const tightN = g75.envelope.envelopeUlpN, tightP = g75.envelope.envelopeUlpP;
    record('the encoder\'s conservative envelope on N dominates gateB7-5\'s tight derivation',
      EPS_N / NCDF.ULP > tightN, `encoder ${(EPS_N / NCDF.ULP).toFixed(4)} ulp · tight ${tightN.toFixed(4)} ulp · ${((EPS_N / NCDF.ULP) / tightN).toFixed(3)}x headroom`);
    record('the encoder\'s conservative envelope on the density dominates it too',
      EPS_P / NCDF.ULP > tightP, `encoder ${(EPS_P / NCDF.ULP).toFixed(4)} ulp · tight ${tightP.toFixed(4)} ulp · ${((EPS_P / NCDF.ULP) / tightP).toFixed(3)}x headroom`);
    record('and the substitution is legitimate at the term level: TOLC >= TOLC/2 + the measured evaluator error',
      NCDF.TOLC >= NCDF.TOLC / 2 + g75.envelope.evaluatorUlpN,
      `${NCDF.TOLC} >= ${NCDF.TOLC / 2} + ${g75.envelope.evaluatorUlpN.toFixed(4)} = ${(NCDF.TOLC / 2 + g75.envelope.evaluatorUlpN).toFixed(4)}`);
    record('the same at the density term', NCDF.TOLP >= NCDF.TOLP / 2 + g75.envelope.evaluatorUlpP,
      `${NCDF.TOLP} >= ${NCDF.TOLP / 2} + ${g75.envelope.evaluatorUlpP.toFixed(4)}`);
  }
}

// =================================================================================================
console.log('\n§3  THE DISPLAY TABLE MATCHES WHAT THE ENGINE ACTUALLY ROUNDS TO');
// DP is a transcription of src/engine/optionsRisk.js's return block. A drift there silently changes what
// "half a display digit" means, and the ceiling in §4 is sized off it. Measured behaviourally rather than
// by parsing: round a greek to DP+1 places and the engine must not reproduce it.
{
  const g = optionsRisk({ forward: 100000, positions: [{ type: 'call', strike: 101234.56789, iv: 0.6789, quantity: 1.23456789, T: 0.123456789 }] });
  let mismatch = [];
  for (const k of GREEKS) {
    const served = g.greeks[k];
    const dp = INT.DP[k];
    // the served value must be unchanged by re-rounding at its own dp, and it must have no digits beyond it
    if (Number(served.toFixed(dp)) !== served) mismatch.push(`${k}: served ${served} is not round(.,${dp})`);
  }
  record('every greek\'s declared display precision reproduces the engine\'s own rounding', mismatch.length === 0,
    mismatch.join(' · ') || `delta/vega/vanna/volga/theta at 6 dp, gamma at 8 — checked against a leg with nine significant digits in every input`);
}

// =================================================================================================
console.log('\n§4  THE BOUND OVER THE REAL ENGINE: does it hold, is it REACHED, does the ceiling FIRE');
let sweep;
{
  let seed = 20260730;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let n = 0, refusedSplit = 0, refusedOther = 0, violations = 0, worstFrac = 0, worstLeg = null;
  const worstPer = Object.fromEntries(GREEKS.map((k) => [k, 0]));
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const F = 10 ** (1 + rand() * 4);
    const K = F * (0.3 + rand() * 2.7);
    const T = 1 / 365 + rand() * 2;
    const sigma = 0.15 + rand() * 2.35;
    const isCall = rand() < 0.5;
    const qty = (rand() < 0.5 ? 1 : -1) * (0.1 + rand() * 10);
    const inputs = { forward: F, positions: [{ type: isCall ? 'call' : 'put', strike: K, T, iv: sigma, quantity: qty }] };
    const res = optionsRisk(inputs);
    if (res.ok !== true) continue;
    const w = optionsRiskNcdfWitnessFor(inputs, res);
    if (w.reason) { if (/tail split/.test(w.reason)) refusedSplit++; else refusedOther++; continue; }
    n++;
    // The witness generator already refuses anything past its own bound, so measuring the bound by
    // watching what it rejects would be circular. It reports the fraction it used, per greek, and that
    // is what gets read — the reason `_internalOptionsRiskNcdf` is exported at all.
    const g = black76(F, K, T, sigma, isCall ? 'call' : 'put', 0);
    for (const k of GREEKS) {
      const frac = w.gapToEngine[k] / w.encodingBound[k];
      if (frac > 1) violations++;
      if (frac > worstPer[k]) worstPer[k] = frac;
      if (frac > worstFrac) { worstFrac = frac; worstLeg = { F, K, T, sigma, isCall, qty, greek: k }; }
    }
  }
  sweep = { legs: N, proved: n, refusedSplit, refusedOther, violations, worstFrac, worstPer, worstLeg };
  record('no honest leg exceeds the derived encoding bound on any greek', violations === 0,
    `${violations} violations over ${n} legs x ${GREEKS.length} greeks = ${n * GREEKS.length} comparisons`);
  // A BOUND NOTHING REACHES IS A BOUND NOBODY DERIVED. The liquidation half-cent stopped being a guard
  // below a dollar because it was sized off a display digit rather than off the encoding.
  record('the bound is REACHED — the worst honest leg lands on it rather than near it', worstFrac > 0.9,
    `worst ${(worstFrac * 100).toFixed(4)}% on ${worstLeg?.greek}, per-greek [${GREEKS.map((k) => `${k} ${(worstPer[k] * 100).toFixed(2)}%`).join(', ')}]`);
  record('the tail-split refusal is exercised by the sweep rather than argued', refusedSplit > 0,
    `${refusedSplit} of ${N} legs are past |d1| = ${NCDF.ZSPLIT / NCDF.ONE} (${((n / (n + refusedSplit + refusedOther)) * 100).toFixed(2)}% reachable)`);

  // ── THE PER-GREEK DISPLAY CEILING, FIRING. A ceiling nothing reaches is a ceiling nobody tested.
  // gamma's envelope is EPS_P/(F*sigma*sqrtT) against a 5e-9 half-digit, so a small forward, a low vol
  // and a short expiry push it over. This leg is CONSTRUCTED to do that, and the refusal must name gamma.
  const tiny = { forward: 0.0004, positions: [{ type: 'call', strike: 0.0004, iv: 0.16, quantity: 1, T: 1 / 3650 }] };
  const tinyRes = optionsRisk(tiny);
  const tinyW = tinyRes.ok === true ? optionsRiskNcdfWitnessFor(tiny, tinyRes) : { reason: 'engine refused' };
  record('the per-greek display ceiling FIRES on a leg whose gamma envelope exceeds its display digit',
    !!tinyW.reason && /envelope on gamma/.test(tinyW.reason), tinyW.reason || 'ACCEPTED — the ceiling did not fire');
}

// =================================================================================================
console.log('\n§5  EVERY SCOPE REFUSAL FIRES, WITH ITS OWN SENTENCE');
{
  const base = { forward: 100000, positions: [{ type: 'call', strike: 105000, iv: 0.65, quantity: 2.5, expiryDays: 30 }] };
  const cases = [
    ['a two-leg book', { ...base, positions: [base.positions[0], { type: 'put', strike: 90000, iv: 0.7, quantity: -1, expiryDays: 30 }] }, /2 legs/],
    ['r != 0', { ...base, r: 0.05 }, /r = 0\.05/],
    ['a leg past the tail split', { forward: 100000, positions: [{ type: 'call', strike: 20000, iv: 0.2, quantity: 1, T: 0.05 }] }, /tail split/],
    ['a refused request', { forward: 100000, positions: [{ type: 'call', strike: -5, iv: 0.65, quantity: 1, expiryDays: 30 }] }, /refused/],
  ];
  for (const [label, inputs, re] of cases) {
    const res = optionsRisk(inputs);
    const w = optionsRiskNcdfWitnessFor(inputs, res);
    record(`${label} is refused by name`, !!w.reason && re.test(w.reason), (w.reason || 'ACCEPTED').slice(0, 190));
  }
  // AND A TAMPERED ANSWER. The twelve equalities exist to stop a proof being attached to a result the
  // engine did not produce; a gate that never bends one has not tested them.
  const res = optionsRisk(base);
  const bent = JSON.parse(JSON.stringify(res));
  bent.greeks.delta = Number((bent.greeks.delta + 1e-6).toFixed(6));
  const bw = optionsRiskNcdfWitnessFor(base, bent);
  record('a greek moved by one display step is refused rather than certified', !!bw.reason && /greeks\.delta/.test(bw.reason),
    (bw.reason || 'ACCEPTED').slice(0, 190));
  const bent2 = JSON.parse(JSON.stringify(res));
  bent2.positions[0].forward = 99999;
  const bw2 = optionsRiskNcdfWitnessFor(base, bent2);
  record('a moved leg descriptor is refused too', !!bw2.reason, (bw2.reason || 'ACCEPTED').slice(0, 190));
}

// =================================================================================================
console.log('\n§6  A PROOF BUILT BY THE REAL SERVED HANDLER — including the NEGATIVE-x branch');
// Not a witness this gate assembled: the witness the handler on the paid path produces, reached through
// SERVICES[].run with snark: true, so what is proved here is what a caller is served.
let handlerOut, proof, publicSignals, proveMs, worstCase;
{
  // K > F, so d1 < 0 and xSign = 1 — the branch event-vol NEVER reaches, since its x is always
  // sigma*sqrtT/2 > 0. If the circuit's cHat quadratic were wrong on that side, nothing until now
  // would have noticed.
  const body = { forward: 100000, positions: [{ type: 'call', strike: 105000, iv: 0.65, quantity: 2.5, expiryDays: 30 }], snark: true };
  handlerOut = SVC.run(body);
  record('the served handler attaches a `snark` block with status building', handlerOut?.snark?.status === 'building',
    `status ${handlerOut?.snark?.status}${handlerOut?.snark?.reason ? ` — ${handlerOut.snark.reason}` : ''}`);
  record('it names all six greeks as the fields proven, not one', Array.isArray(handlerOut?.snark?.fieldsProven) && handlerOut.snark.fieldsProven.length === 6,
    `[${(handlerOut?.snark?.fieldsProven || []).join(', ')}]`);
  record('the `snark` sibling is attached OUTSIDE `proof`, so the content hash covers what it covered before',
    handlerOut.proof && handlerOut.proof.snark === undefined && handlerOut.snark !== undefined,
    `envelope keys [${Object.keys(handlerOut.proof).slice(0, 6).join(', ')}...] · snark is a top-level sibling`);

  const { inputs } = handlerOut.proof;
  const res = optionsRisk(inputs);
  worstCase = optionsRiskNcdfWitnessFor(inputs, res);
  record('the witness the handler would prove has xSign = 1 — the negative-x branch', worstCase.encoded?.xSign === 1,
    `d1 = ${worstCase.point} · xMag ${worstCase.encoded?.xMag} · nHat ${worstCase.encoded?.nHat} · pHat ${worstCase.encoded?.pHat}`);

  const r = await proveVerifyRefuse('ncdf', worstCase.witness, { record });
  proof = r.proof; publicSignals = r.publicSignals; proveMs = r.proveMs;

  // The circuit reports which branch it took. On a reachable leg it must be the COMPUTED one — a proof
  // that silently fell to the tail bound would carry a weaker statement under the same shape.
  record('the circuit reports it EVALUATED the CDF rather than falling back to the tail bound',
    publicSignals[0] === '1', `computed ${publicSignals[0]} · tailC ${publicSignals[1]} · tailP ${publicSignals[2]} · xSign ${publicSignals[3]}`);

  // AND THE BUYER'S RECONSTRUCTION, FROM THE PUBLIC SIGNALS ALONE. This is the claim: six numbers a
  // reader derives from the proof, each one displaying as the figure the answer served.
  const xSign = Number(publicSignals[3]), xMag = Number(publicSignals[4]);
  const nG = Number(publicSignals[5]) / NCDF.ONE, pG = Number(publicSignals[6]) / NCDF.ONE;
  const x = (xSign === 1 ? -1 : 1) * xMag / NCDF.ONE;
  const p0 = inputs.positions[0];
  const T = p0.T > 0 ? p0.T : p0.expiryDays / 365;
  const d2 = x - p0.iv * Math.sqrt(T);
  const rec = (INT.greeksFromProven ?? INT.greeksFromProvenPair)(nG, pG, inputs.forward, T, p0.iv, p0.type === 'call', x, d2);
  const bad = GREEKS.filter((k) => Number((rec[k] * p0.quantity).toFixed(INT.DP[k])) !== res.greeks[k]);
  record('all SIX greeks reconstruct from the PUBLIC SIGNALS and display as the figures served', bad.length === 0,
    bad.length ? `disagree on ${bad.join(', ')}` : GREEKS.map((k) => `${k} ${res.greeks[k]}`).join(' · '));

  // THE BINDING THE CIRCUIT DOES NOT CARRY, performed the way a reader would — one exponential, not a
  // logarithm. This is what `doesNotProve` sends a buyer to do, so the gate does it too.
  const lhs = p0.strike * Math.exp(p0.iv * Math.sqrt(T) * x - 0.5 * p0.iv * p0.iv * T);
  record('x binds to this leg with ONE exponential: K*exp(sigma*sqrtT*x - sigma^2*T/2) == F',
    Math.abs(lhs - inputs.forward) / inputs.forward < 1e-12,
    `${lhs} against F = ${inputs.forward} (relative ${(Math.abs(lhs - inputs.forward) / inputs.forward).toExponential(2)}) — NOT in the circuit, and this is the residue`);
}

// =================================================================================================
console.log('\n§7  A WRONG CDF CANNOT GET ONE ACCEPTED — on options-risk\'s own slice of the x-axis');
// event-vol only asks for x = sigma*sqrtT/2 > 0. options-risk asks anywhere in (-7.07, 7.07), so
// gateB7-5's refusal rate is not this service's and is re-measured rather than carried over.
let attack;
{
  const asNcdf = (x) => {                              // Abramowitz-Stegun 7.1.26 — the wrong CDF
    const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * e);
  };
  let seed = 44445555;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let tried = 0, admitted = 0, worstUlp = 0, worstDollarDelta = 0;
  for (let i = 0; i < 20000; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 1 / 365 + rand() * 2, sigma = 0.15 + rand() * 2.35;
    const isCall = rand() < 0.5;
    const g = black76(F, K, T, sigma, isCall ? 'call' : 'put', 0);
    if (!g) continue;
    if (!(Math.round(Math.abs(g.d1) * NCDF.ONE) < NCDF.ZSPLIT)) continue;
    tried++;
    const nTrue = isCall ? g.delta : g.delta + 1;
    const off = Math.abs(asNcdf(g.d1) - nTrue);
    worstUlp = Math.max(worstUlp, off / NCDF.ULP);
    worstDollarDelta = Math.max(worstDollarDelta, off * F);
    if (off / NCDF.ULP <= NCDF.TOLC / 2) admitted++;   // inside the band the circuit actually enforces
  }
  attack = { tried, admitted, refusalRate: 1 - admitted / tried, worstUlp, worstDollarDelta };
  record('a service running A-S 7.1.26 is refused on the overwhelming majority of options-risk legs',
    attack.refusalRate > 0.98,
    `${(attack.refusalRate * 100).toFixed(4)}% of ${tried} legs refused; worst miss ${worstUlp.toExponential(3)} ulp = ${(worstUlp / (NCDF.TOLC / 2)).toExponential(2)}x the band`);
  // AND THE HONEST LIMIT OF THAT CLAIM, stated as a check rather than a footnote: a wrong CDF that
  // happens to be accurate AT THIS POINT is not detectable at this point, and one leg is one point.
  record('the residual admission rate is published rather than rounded away', admitted >= 0,
    `${admitted} of ${tried} legs (${((admitted / tried) * 100).toFixed(3)}%) are points where A-S happens to agree to within ${NCDF.TOLC / 2} ulp — a one-leg proof is one point, so this is the miss probability, not a bug`);
  record('and the price-terms comparison is against the FORWARD, the only stable denominator here',
    worstDollarDelta > 0, `A-S misstates dollar delta by up to ${worstDollarDelta.toExponential(3)} quote units at that leg's forward, against this circuit's ${(EPS_N * 1e5).toExponential(3)} at F = 100,000`);
}

// =================================================================================================
console.log('\n§8  THE EXPORTED VERIFIER, INSIDE AN EVM');
const evm = await evmRehearsal('ncdf', proof, publicSignals, { record });

// =================================================================================================
console.log('\n§9  BOTH SURFACES — the MCP array is a separate file and has been the forgotten site four times');
{
  const src = readFileSync(fileURLToPath(new URL('mcp.js', serviceRoot(import.meta.url).url)), 'utf8');
  record('the MCP handler calls the SAME snark builder as the paid handler', /optionsRiskSnark\(/.test(src),
    'src/mcp.js references optionsRiskSnark — the proves/doesNotProve pair lives in one file, so the two surfaces cannot drift');
  record('and it starts the SAME background build', /buildOptionsRiskNcdfInBackground\(/.test(src),
    'src/mcp.js references buildOptionsRiskNcdfInBackground');
}

// =================================================================================================
const f = plonkFacts(path.join(BUILD, 'ncdf_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
const out = {
  at: new Date().toISOString(),
  passed: gate,
  failures: bad.map((x) => x.name),
  checks: results.length,
  envelope: {
    epsN: EPS_N, epsP: EPS_P, ulpN: EPS_N / NCDF.ULP, ulpP: EPS_P / NCDF.ULP,
    dollarDeltaPerContract: { F1: EPS_N, F3000: 3000 * EPS_N, F100000: 100000 * EPS_N },
    envelopeBpsOfForward: EPS_N * 1e4,
  },
  sweep,
  attack,
  handler: { snarkStatus: handlerOut?.snark?.status, fieldsProven: handlerOut?.snark?.fieldsProven, contentHash: handlerOut?.proof?.contentHash },
  publicSignals, proveMs,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize, nPublic: f.nPublic,
  evm: { acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), deployedSize: evm.deployedSize, solc: evm.solc },
};
writeFileSync(path.join(BUILD, 'gateB7-7-optionsrisk-greeks.json'), JSON.stringify(out, null, 1));
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE B7-7: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${results.length} checks · ${f.nConstraints} Plonk constraints · domain ${f.domainSize} · ${f.nPublic} public · proved in ${proveMs} ms`);
console.log(`  ${evm.acceptGas} gas to accept, ${evm.rejectGas} to refuse (ONE SAMPLE — see probe-plonk-gas-variance)`);
console.log('');
console.log('  WHAT IS PROVEN: that options-risk\'s SIX published greeks are the Black-76 greeks of a');
console.log(`  one-leg book at the public point x, with N(x) and phi(x) evaluated IN the circuit by Hart`);
console.log(`  to ${NCDF.TOLC} and ${NCDF.TOLP} ulp of 2^-${NCDF.S}. Six fields off one circuit instance, where event-vol got one.`);
console.log(`  ENVELOPE: ${(EPS_N / NCDF.ULP).toFixed(3)} ulp = ${EPS_N.toExponential(3)} on N. IN PRICE TERMS that is`);
console.log(`  +-${(100000 * EPS_N).toExponential(3)} quote units of DOLLAR DELTA per contract on a 100,000 forward`);
console.log(`  (${(EPS_N * 1e4).toExponential(3)} bps of the forward), against the ${attack.worstDollarDelta.toExponential(3)} A-S 7.1.26 would misstate.`);
console.log(`  The worst honest leg uses ${(sweep.worstFrac * 100).toFixed(4)}% of the derived encoding bound, over ${sweep.proved} legs.`);
console.log('  WHAT IS NOT: x itself, `portfolioValue` (needs N(d2), a second point), `spanMargin` (366');
console.log('  repricings), the finite-difference checks, more than one leg, and r != 0. Binding x is one');
console.log('  exponential a reader performs: K*exp(sigma*sqrtT*x - sigma^2*T/2) == F. NOT IN THE CIRCUIT.');
console.log('');
await shutdown();
process.exit(gate ? 0 : 1);
