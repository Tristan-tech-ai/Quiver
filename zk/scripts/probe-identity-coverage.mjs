// PROBE — of the numbers options-risk actually publishes, which are PINNED by an identity and which
// float free? And is the coverage the circuit headers claim the coverage they have?
//
// The four B7 gates each pass, so it is tempting to read the family as "the greeks are proven". This
// enumerates what is published, walks each identity, and then ATTACKS the two coverage claims that
// looked weakest on reading:
//
//   greekssigned's header: "d1 - d2 = sigma*sqrt(T) ... is also identity A from the same family —
//   proven here as a by-product rather than as a separate statement."
//
//   parity's header: "it ties a call to a put at the same strike, so a price that drifts on one side
//   and not the other fails here."
//
// Both are tested by building a FORGED witness and asking the real circuit. A claim about coverage
// that has never been attacked is a claim about intent.
//
//   node zk/scripts/probe-identity-coverage.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, checklist, snarkjs, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const require = createRequire(import.meta.url);
const { black76 } = await load(import.meta.url, 'engine/black76.js');
const { optionsRisk } = await load(import.meta.url, 'engine/optionsRisk.js');

console.log(`IDENTITY COVERAGE PROBE — ${new Date().toISOString()}\n`);

// =================================================================================================
// 1. WHAT IS PUBLISHED
// =================================================================================================
const out = optionsRisk({
  forward: 65000, r: 0,
  positions: [
    { strike: 70000, expiryDays: 30, iv: 0.62, quantity: 2, type: 'call' },
    { strike: 60000, expiryDays: 30, iv: 0.68, quantity: -1, type: 'put' },
  ],
});
if (!out.ok) { console.error('optionsRisk refused:', out.errors); process.exit(1); }

console.log('1. WHAT options-risk PUBLISHES, from a real call to the engine.\n');
const published = [
  ['portfolioValue', out.portfolioValue, 'sum of leg prices'],
  ['greeks.delta', out.greeks.delta, 'position-weighted sum'],
  ['greeks.gamma', out.greeks.gamma, ''],
  ['greeks.vega', out.greeks.vega, ''],
  ['greeks.theta', out.greeks.theta, ''],
  ['greeks.vanna', out.greeks.vanna, ''],
  ['greeks.volga', out.greeks.volga, ''],
  ['pnlPerUnderlyingPctMove', out.pnlPerUnderlyingPctMove, 'first-order'],
  ['spanMargin.requirement', out.spanMargin.requirement, 'worst repriced P&L over a box'],
  ['positions[].value', out.positions[0].value, 'per leg'],
  ['positions[].positionGreeks.*', out.positions[0].positionGreeks.delta, 'per leg, x quantity'],
];
for (const [k, v, note] of published) console.log(`   ${k.padEnd(34)}${String(v).padStart(16)}   ${note}`);

// The publication GRID matters as much as the identity coverage: nothing can be pinned tighter than
// the number is printed. Read off the engine's own round() calls by probing the returned decimals.
const decimals = (v) => { const s = String(v); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
console.log(`\n   PUBLICATION GRID — no proof can pin a number tighter than it is printed.`);
console.log(`     greeks.delta/vega/theta/vanna/volga  round(x, 6)  -> +/- 5e-7`);
console.log(`     greeks.gamma                         round(x, 8)  -> +/- 5e-9`);
console.log(`     portfolioValue, positions[].value    round(x, 6)  -> +/- 5e-7`);
console.log(`     spanMargin.requirement               round(x, 2)  -> +/- 5e-3`);
console.log(`   d1 and d2 are NOT published at all, and both greekssigned and parity take them as`);
console.log(`   public inputs — so those circuits WIDEN what the service commits to rather than`);
console.log(`   proving something about what it already said.`);

// =================================================================================================
// 2. WHICH IDENTITY PINS WHAT
// =================================================================================================
console.log(`\n2. COVERAGE. For each published per-leg quantity: which identity constrains it, and what`);
console.log(`   does that identity leave free?\n`);
const COVER = [
  ['gamma', 'B: vega*100 = gamma*F^2*sigma*T', 'pinned RELATIVE to vega only. Both carry df*phi(d1), which cancels.'],
  ['vega', 'B, and E: theta*730*T = -vega*100*sigma', 'same shared factor. B and E are two equations in gamma, vega, theta — rank 2 of 3.'],
  ['theta', 'E', 'relative to vega. Sign pinned by thetaS === 1, which is r = 0 only.'],
  ['volga', 'C: volga*sigma = vega*d1*d2*0.01', 'relative to vega AND to d1, d2 — which are unpinned witnesses.'],
  ['vanna', 'D: vanna*F*(d1-d2) = -vega*d2', 'relative to vega, d2 AND dDiff. dDiff is a free witness — attacked below.'],
  ['delta', 'G: dCall - dPut = df  (parity only)', 'NOT PINNED. G is satisfied by construction for any reflection-symmetric N.'],
  ['price', 'F: C - P = df*(F - K)  (parity only)', 'NOT PINNED. F is satisfied algebraically for any reflection-symmetric N.'],
  ['d1, d2', 'A: d1 - d2 = sigma*sqrt(T)  — claimed by greekssigned', 'NOT ENFORCED anywhere. Attacked below.'],
];
console.log(`   ${'quantity'.padEnd(10)}${'identity'.padEnd(42)}what is left free`);
for (const [q, i, f] of COVER) console.log(`   ${q.padEnd(10)}${i.padEnd(42)}${f}`);

const { record, failed } = checklist();

// =================================================================================================
// 3. ATTACK — is identity A enforced in greekssigned?
// =================================================================================================
console.log(`\n3. ATTACK ON greekssigned. Its header says identity A (d1 - d2 = sigma*sqrt(T)) is "proven`);
console.log(`   here as a by-product". Reading the constraints, dDiff appears in exactly one place —`);
console.log(`   identity D — and nothing ties it to sigma or T. If that is right, then scaling vanna up`);
console.log(`   by ten and dDiff down by ten leaves every constraint satisfied, because D contains the`);
console.log(`   PRODUCT vanna*dDiff and the alignment exponent dD contains their SUM.\n`);

function mant(x) {
  const neg = x < 0; x = Math.abs(x);
  if (!(x > 0) || !Number.isFinite(x)) return null;
  let e = 0, v = x;
  while (v < 1e8) { v *= 10; e++; if (e > 200) return null; }
  while (v >= 1e9) { v /= 10; e--; if (e < -200) return null; }
  let m = BigInt(Math.round(v));
  if (m >= 1000000000n) { m /= 10n; e -= 1; }
  return { m, e, s: neg ? 1 : 0 };
}

function signedWitness(F, K, T, sg, type) {
  const g = black76(F, K, T, sg, type, 0);
  if (!g) return null;
  const V = mant(g.vega), S = mant(sg), Tm = mant(T), Fm = mant(F);
  const D1 = mant(g.d1), D2 = mant(g.d2), DD = mant(g.d1 - g.d2);
  const VO = mant(g.volga), VA = mant(g.vanna), TH = mant(g.theta);
  const all = [V, S, Tm, Fm, D1, D2, DD, VO, VA, TH];
  if (all.some((x) => !x) || all.some((x) => x.e < 0 || x.e > 511)) return null;
  const dC = (V.e + D1.e + D2.e + 2) - (VO.e + S.e);
  const dD = (V.e + D2.e) - (VA.e + Fm.e + DD.e);
  const dE = (V.e + S.e) - (TH.e + Tm.e);
  if ([dC, dD, dE].some((d) => d < -12 || d > 12)) return null;
  return {
    w: {
      vegaM: String(V.m), sigM: String(S.m), tM: String(Tm.m), fM: String(Fm.m),
      d1M: String(D1.m), d2M: String(D2.m), dDiffM: String(DD.m),
      volgaM: String(VO.m), vannaM: String(VA.m), thetaM: String(TH.m),
      vegaE: String(V.e), sigE: String(S.e), tE: String(Tm.e), fE: String(Fm.e),
      d1E: String(D1.e), d2E: String(D2.e), dDiffE: String(DD.e),
      volgaE: String(VO.e), vannaE: String(VA.e), thetaE: String(TH.e),
      d1S: String(D1.s), d2S: String(D2.s), volgaS: String(VO.s), vannaS: String(VA.s), thetaS: String(TH.s),
    },
    truth: { vanna: g.vanna, dDiff: g.d1 - g.d2, sigSqrtT: sg * Math.sqrt(T), d1: g.d1, d2: g.d2 },
  };
}

const sj = await snarkjs();
async function proveIt(circuit, w) {
  const builder = await require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.cjs'))(
    readFileSync(path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`)));
  try {
    const wtns = await builder.calculateWTNSBin(w, 0);
    const r = await sj.plonk.prove(path.join(BUILD, `${circuit}_plonk.zkey`), wtns);
    const vk = JSON.parse(readFileSync(path.join(BUILD, `${circuit}_vk.json`), 'utf8'));
    return await sj.plonk.verify(vk, r.publicSignals, r.proof);
  } catch (e) {
    return `refused at witness generation: ${String(e.message || e).split('\n')[0].slice(0, 90)}`;
  }
}

// A leg with room in the exponent windows both ways.
let base = null;
for (const [F, K, T, sg] of [[65000, 70000, 30 / 365, 0.62], [3000, 3300, 60 / 365, 0.8], [100, 90, 0.5, 1.2], [2500, 2000, 0.25, 0.55]]) {
  const c = signedWitness(F, K, T, sg, 'call');
  if (c) { base = { ...c, F, K, T, sg }; break; }
}
if (!base) { console.error('could not build a greekssigned witness'); process.exit(1); }

console.log(`   honest leg: F ${base.F} K ${base.K} T ${base.T.toFixed(5)} sigma ${base.sg}`);
console.log(`     vanna ${base.truth.vanna.toExponential(6)} · d1-d2 ${base.truth.dDiff.toExponential(6)} · sigma*sqrt(T) ${base.truth.sigSqrtT.toExponential(6)}`);
const honest = await proveIt('greekssigned', base.w);
record('the honest greekssigned witness verifies', honest === true, `returned ${honest}`);

// THE FORGERY. Identical mantissas; two exponents moved in opposite directions.
const forged = { ...base.w, vannaE: String(Number(base.w.vannaE) - 1), dDiffE: String(Number(base.w.dDiffE) + 1) };
const forgedVanna = base.truth.vanna * 10;
const forgedDDiff = base.truth.dDiff / 10;
console.log(`\n   forged: vannaE ${base.w.vannaE} -> ${forged.vannaE}   dDiffE ${base.w.dDiffE} -> ${forged.dDiffE}`);
console.log(`     claims vanna ${forgedVanna.toExponential(6)}  (10x the truth)`);
console.log(`     claims d1-d2 ${forgedDDiff.toExponential(6)}  against sigma*sqrt(T) = ${base.truth.sigSqrtT.toExponential(6)}`);
const forgedOk = await proveIt('greekssigned', forged);
console.log(`\n   greekssigned says: ${forgedOk}`);
record('greekssigned REFUSES a vanna that is 10x wrong', forgedOk !== true,
  forgedOk === true
    ? 'IT DOES NOT. The circuit accepted a proof claiming a vanna ten times the engine\'s and a d1-d2 that is not sigma*sqrt(T). Identity A is NOT proven as a by-product; dDiff is an unconstrained witness and vanna is pinned only jointly with it.'
    : `refused: ${forgedOk}`);

// =================================================================================================
// 4. ATTACK — does parity detect a price level that is wrong?
// =================================================================================================
console.log(`\n4. ATTACK ON parity. Its header says a price that drifts "on one side and not the other"`);
console.log(`   fails. The engine's put is not an independent quote: P = df*(K*N(-d2) - F*N(-d1)). So`);
console.log(`   whether the CDF can drift one-sidedly at all is the question, not whether parity would`);
console.log(`   catch it if it did.\n`);
{
  const absteg = (x) => {
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    const c = 0.5 * (1 - y);
    return x <= 0 ? c : 1 - c;
  };
  const SCALE = 1000000000n;
  const toScaled = (x) => { const [w, f = ''] = Number(x).toFixed(9).split('.'); return BigInt(w) * SCALE + BigInt(f.padEnd(9, '0')); };
  const F = 65000, K = 70000, T = 30 / 365, sg = 0.62;
  const g = black76(F, K, T, sg, 'call', 0), p = black76(F, K, T, sg, 'put', 0);
  // the same book, priced with the WRONG CDF
  const cW = F * absteg(g.d1) - K * absteg(g.d2);
  const pW = K * absteg(-g.d2) - F * absteg(-g.d1);
  const dcW = absteg(g.d1), dpW = absteg(g.d1) - 1;
  console.log(`   correct: C ${g.price.toFixed(6)}  P ${p.price.toFixed(6)}  C-P ${(g.price - p.price).toFixed(6)}  F-K ${(F - K).toFixed(6)}`);
  console.log(`   A-S:     C ${cW.toFixed(6)}  P ${pW.toFixed(6)}  C-P ${(cW - pW).toFixed(6)}  F-K ${(F - K).toFixed(6)}`);
  console.log(`   the call is off by ${(cW - g.price).toFixed(6)} and C-P is off by ${((cW - pW) - (g.price - p.price)).toExponential(3)}.\n`);

  const cpDiff = toScaled(Math.abs(cW - pW)), fkDiff = toScaled(Math.abs(F - K));
  const w = {
    callHat: String(toScaled(cW)), putHat: String(toScaled(pW)),
    fHat: String(toScaled(F)), kHat: String(toScaled(K)), dfHat: String(SCALE),
    cpDiffHat: String(cpDiff), fkDiffHat: String(fkDiff),
    diffSign: String((cW - pW) < 0 ? 1 : 0),
    dCallHat: String(toScaled(dcW)), dPutHat: String(toScaled(-dpW)),
  };
  const parityOk = await proveIt('parity', w);
  console.log(`   parity says: ${parityOk}`);
  record('parity REFUSES a book priced with the wrong CDF', parityOk !== true,
    parityOk === true
      ? `IT DOES NOT. A whole book priced with Abramowitz-Stegun instead of Hart — the call ${(cW - g.price).toFixed(4)} off on a $${g.price.toFixed(2)} option — produces a parity proof that verifies. Any N with N(-x) = 1 - N(x) cancels out of C - P = df*(F - K), and every tail-plus-branch implementation has that symmetry, the engine's included.`
      : `refused: ${parityOk}`);
}

const bad = failed();
console.log(`\n${'='.repeat(78)}`);
console.log(`COVERAGE VERDICT: ${bad.length === 0 ? 'both headers hold' : `${bad.length} coverage claim(s) do not survive an attack`}`);
for (const b of bad) console.log(`  - ${b.name}`);
await shutdown();
