// GATE B7-5 — the normal CDF, COMPUTED in a circuit.
//
// B7-1..B7-4 prove consistency identities among the published greeks and every one of them says, in
// its own header, that a wrong normal CDF would satisfy it. probe-cdf-residue.mjs measured that:
// Abramowitz-Stegun 7.1.26 in place of Hart satisfies ALL EIGHT identities to 3.3e-14 and prices a leg
// 19.4% wrong. Put-call parity does not help either — the put is P = df*(K*N(-d2) - F*N(-d1)), so any
// N with N(-x) = 1 - N(x) cancels out of C - P = df*(F - K) algebraically.
//
// So this gate is about the thing the roadmap called a research project. Seven things have to hold and
// each one can fail:
//
//   0. THE BAND IS CLOSED AT BOTH ENDS. Sections 1-6 all passed against a circuit whose CDF bound held
//      on one side only, so this section exists first: the pre-fix circuit is preserved and shown
//      SATISFIED by a claimed at-the-money call delta of 1.0. Perturbing a proof's public signals —
//      which is what section 4 does — cannot find that, because it tests the SNARK's soundness and not
//      the constraint system's. Only re-proving from a wrong witness can.
//   1. the 192 exp constants are right, checked against an INDEPENDENT derivation, not the generator's
//   2. the two tail bounds are above the true tail maximum
//   3. the circuit's tolerance holds over thousands of real legs, and is EXCEEDED by something
//   4. a real proof verifies, every perturbation is refused, and the exported verifier does the same
//      inside an EVM
//   5. THE POINT: a service running a wrong CDF cannot produce an accepted proof, and by how much
//   7. the envelope a BUYER gets, which is not TOLC — the band plus the evaluator's own distance from
//      the true CDF plus the grid under x — reported in PRICE terms, which is the unit that decides
//      whether any of this is worth buying.
//
// Run: node zk/scripts/gateB7-5-ncdf.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BUILD, checklist, proveVerifyRefuse, evmRehearsal, shutdown, snarkjs } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const ZK = path.join(BUILD, '..');
const { black76 } = await load(import.meta.url, 'engine/black76.js');

// ---- the constants, read out of the CIRCUIT SOURCE ----------------------------------------------
// Not out of build/ncdf-consts.json. That file and the circuit come from the same generator run, so
// comparing them to each other proves the generator is self-consistent and nothing else. The circuit
// is what gets proved against, so the circuit is what gets checked.
const SRC = readFileSync(path.join(ZK, 'circuits', 'ncdf.circom'), 'utf8');
const grabVar = (name) => {
  const m = SRC.match(new RegExp(`var ${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`ncdf.circom: no var ${name}`);
  return BigInt(m[1]);
};
const S = grabVar('S'), ONE = grabVar('ONE'), ZSPLIT = grabVar('ZSPLIT'), SQRT2PI = grabVar('SQRT2PI');
const CDF_TAIL = grabVar('CDF_TAIL'), PHI_TAIL = grabVar('PHI_TAIL');
const TOLC = grabVar('TOLC'), TOLP = grabVar('TOLP');
const Sn = Number(S), u = 1 / 2 ** Sn;

// exp table, parsed group by group.
const EXP = [];
for (let g = 0; ; g++) {
  const row = [];
  for (let j = 0; j < 16; j++) {
    const m = SRC.match(new RegExp(`mx\\[${g}\\]\\.c\\[${j}\\] <== (\\d+);`));
    if (!m) break;
    row.push(BigInt(m[1]));
  }
  if (row.length !== 16) break;
  EXP.push(row);
}
// Horner coefficients, in the order the circuit applies them.
const parseHorner = (prefix, sigArr) => {
  const out = [BigInt(SRC.match(new RegExp(`${sigArr}\\[0\\] <== (\\d+);`))[1])];
  for (let i = 1; ; i++) {
    const m = SRC.match(new RegExp(`${sigArr}\\[${i}\\] <== ${prefix}\\[${i - 1}\\]\\.out \\+ (\\d+);`));
    if (!m) break;
    out.push(BigInt(m[1]));
  }
  return out;
};
const BC = parseHorner('bm', 'bh'), DC = parseHorner('dm', 'dh');
const NG = EXP.length;
const G = 4n;

const mulS = (a, b) => (a * b) >> S;
const absB = (v) => (v < 0n ? -v : v);

/** The circuit's integer path, mirrored exactly, using the constants parsed out of the circuit. */
function evalFx(zHat) {
  const W = (zHat * zHat) >> (S + 1n);
  let e = ONE;
  for (let g = 0; g < NG; g++) e = mulS(e, EXP[g][Number((W >> (BigInt(g) * G)) & ((1n << G) - 1n))]);
  let b = BC[0]; for (let i = 1; i < BC.length; i++) b = mulS(b, zHat) + BC[i];
  let d = DC[0]; for (let i = 1; i < DC.length; i++) d = mulS(d, zHat) + DC[i];
  return { eHat: e, bHat: b, dHat: d, W };
}

const { record, failed } = checklist();
console.log(`GATE B7-5 — the normal CDF, computed in a circuit — ${new Date().toISOString()}\n`);
console.log(`  parsed from circuits/ncdf.circom: S=${S} · ${NG} exp groups × 16 = ${NG * 16} constants`);
console.log(`  ZSPLIT ${ZSPLIT} · SQRT2PI ${SQRT2PI} · TOLC ${TOLC} ulp · TOLP ${TOLP} ulp`);
console.log(`  1 ulp = ${u.toExponential(3)}\n`);

// THE BAND IN FORCE IS HALF THE TOLERANCE CONSTANT, and every headroom number in this file used to be
// computed against the wrong one. The constraint is `2*resid + tol <= 2*tol`, so |resid| <= tol/2.
const HALFC = Number(TOLC) / 2, HALFP = Number(TOLP) / 2;

// =================================================================================================
// 0. THE DEFECT THIS CIRCUIT WAS REGENERATED TO CLOSE
// =================================================================================================
// Every section below this one passed against a circuit whose CDF bound held on ONE SIDE ONLY, and
// none of them noticed. That is the failure this section exists to make impossible to repeat.
//
// The removed line was a Num2Bits on the shifted residual. Its absence was argued for in the circuit's
// own header: LessEqThan(n) decomposes `in[0] + 2^n - in[1]`, so a field-wrapped negative in[0] should
// make the decomposition unsatisfiable. It does not. For in[0] = p - v the two wraps CANCEL mod p and
// the comparator sees the ordinary number 2^n - v - in[1], whose bit n is clear, so out = 1 and the
// comparison PASSES. The bound therefore held only for resid > 0 — the prover could drive the upper
// tail arbitrarily far BELOW the truth, which for x > 0 is a call delta of 1.0 on an at-the-money leg.
//
// So it is demonstrated rather than described: the pre-fix circuit is preserved verbatim at
// circuits/adv/ncdfonesided.circom, and the lie is shown SATISFYING its constraint system. Witness
// satisfaction is the statement, not a proof that verifies: a Plonk proof over a satisfied witness
// verifies by soundness of the scheme, which section 4 already exercises on the honest case.
console.log('0. THE DEFECT. The pre-fix circuit is kept at circuits/adv/ncdfonesided.circom; this shows');
console.log('   its constraint system SATISFIED by a claimed at-the-money call delta of 1.0.\n');
{
  const ADV = path.join(BUILD, 'adv', 'ncdfadv');
  const oldR1cs = path.join(ADV, 'ncdfonesided.r1cs');
  const oldWasm = path.join(ADV, 'ncdfonesided_js', 'ncdfonesided.wasm');
  if (!existsSync(oldWasm) || !existsSync(oldR1cs)) {
    execFileSync(process.execPath, [path.join(ZK, 'scripts', 'adversary', 'build-adv.mjs'), '--into', 'ncdfadv', 'ncdfonesided'],
      { cwd: ZK, stdio: 'inherit', timeout: 600_000 });
  }
  const sj0 = await snarkjs();
  const { createRequire: cr0 } = await import('node:module');
  const req0 = cr0(import.meta.url);
  const oldBuilder = await req0(path.join(ADV, 'ncdfonesided_js', 'witness_calculator.cjs'))(readFileSync(oldWasm));
  const newBuilder = await req0(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));

  // An at-the-money leg, from the real engine. Its true call delta is a little over a half.
  const L = black76(100000, 100000, 0.25, 0.6, 'call', 0);
  const xMag = BigInt(Math.round(Math.abs(L.d1) * Number(ONE)));
  const xSign = L.d1 < 0 ? 1 : 0;
  const nHonest = BigInt(Math.round(L.delta * Number(ONE)));
  const pHonest = BigInt(Math.round(L.gamma * 100000 * 0.6 * Math.sqrt(0.25) * Number(ONE)));
  const honest = { xSign: String(xSign), xMag: String(xMag), nHat: String(nHonest), pHat: String(pHonest) };
  const lie = { ...honest, nHat: String(ONE) };            // delta = 1.0 exactly

  const tmp = path.join(BUILD, 'adv', 'ncdfadv', 'onesided.wtns');
  let oldAccepts = false;
  try {
    const w = await oldBuilder.calculateWTNSBin(lie, 0);
    writeFileSync(tmp, w);
    oldAccepts = await sj0.wtns.check(oldR1cs, tmp) === true;
  } catch { oldAccepts = false; }
  record('the PRE-FIX constraint system is satisfied by a claimed delta of 1.0', oldAccepts,
    `delta claimed 1.0 against a true ${L.delta.toPrecision(10)} at d1 = ${L.d1.toPrecision(6)} — every constraint of circuits/adv/ncdfonesided.circom holds`);

  let newRefuses = false, why = '';
  try { await newBuilder.calculateWTNSBin(lie, 0); } catch (e) { newRefuses = true; why = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 70); }
  record('the REBUILT circuit refuses the same witness', newRefuses, why || 'accepted — the fix did not take');

  // And the honest witness must still pass, or the fix has bought refusal by refusing everything.
  let newAcceptsHonest = true;
  try { await newBuilder.calculateWTNSBin(honest, 0); } catch { newAcceptsHonest = false; }
  record('the rebuilt circuit still accepts the honest witness', newAcceptsHonest,
    'a range check that refuses the truth as well as the lie is not a fix');

  // WHAT IT WAS WORTH, in the only unit that matters. At r = 0 the engine's own price identity is
  // price = F*N(d1) - K*N(d2) and its delta IS N(d1), so N(d2) comes back out of the two published
  // numbers exactly and nothing is re-derived here. Leave N(d2) honest, replace N(d1) with the 1.0 the
  // old circuit would have certified, and read the price a buyer would have been handed.
  const F0 = 100000, K0 = 100000;
  const N2 = (F0 * L.delta - L.price) / K0;
  const liedPrice = F0 * 1.0 - K0 * N2;
  record('the one-sided bound was worth a real amount of money', liedPrice > L.price * 1.5,
    `a proof under the old key certified ${liedPrice.toFixed(2)} for a leg the engine priced at ${L.price.toFixed(2)} — ${(((liedPrice - L.price) / L.price) * 100).toFixed(1)}% high, on one at-the-money call`);
  globalThis.__defect = { trueDelta: L.delta, claimedDelta: 1, enginePrice: L.price, liedPrice, oldAccepts, newRefuses };
}

// =================================================================================================
// 1. the constants — the trust root
// =================================================================================================
console.log('1. THE CONSTANT TABLE, against two independent checks.\n');
{
  // (a) against V8's libm. Math.exp is correct to ~1e-16 relative; the table needs 2^-40 absolute,
  //     which for the smallest entry e^{-16} = 1.1e-7 is 8e-6 relative. So a double is a genuinely
  //     independent and more-than-adequate reference here, and it is a different implementation from
  //     the generator's integer Taylor series.
  let worstUlp = 0, worstAt = null, entries = 0;
  for (let g = 0; g < NG; g++) {
    for (let j = 1; j < 16; j++) {
      const x = (j * 2 ** (g * 4)) / 2 ** Sn;
      const want = Math.exp(-x) * Number(ONE);
      const dev = Math.abs(Number(EXP[g][j]) - want);
      entries++;
      if (dev > worstUlp) { worstUlp = dev; worstAt = { g, j, x }; }
    }
  }
  record('every exp constant is within 1 ulp of Math.exp', worstUlp <= 1,
    `${entries} entries, worst ${worstUlp.toFixed(4)} ulp at group ${worstAt.g} entry ${worstAt.j} (x=${worstAt.x.toExponential(3)})`);

  // (b) the functional equation, with no float involved at all: e^{-a}*e^{-b} = e^{-(a+b)}. Entry j of
  //     group g and entry k of the same group must multiply to entry j+k when j+k < 16. A table built
  //     with a wrong exponent or a shifted index fails this and cannot fail it "by luck".
  let worstFn = 0, checks = 0;
  for (let g = 0; g < NG; g++) {
    for (let j = 1; j < 16; j++) {
      for (let k = 1; j + k < 16; k++) {
        const got = mulS(EXP[g][j], EXP[g][k]);
        const dev = Number(absB(got - EXP[g][j + k]));
        checks++;
        if (dev > worstFn) worstFn = dev;
      }
    }
  }
  record('the table satisfies e^-a * e^-b = e^-(a+b)', worstFn <= 2,
    `${checks} triples, worst ${worstFn} ulp — one truncation each side, so <= 2 is exact`);

  // (c) across groups: entry 1 of group g+1 is entry 1 of group g raised to the 16th. Checked by four
  //     squarings, which is the cross-group structure the generator could get wrong by an off-by-one.
  //
  //     THE THRESHOLD HERE WAS WRONG FIRST TIME and the gate failed on it. Squaring AMPLIFIES: an
  //     error d in v becomes 2*v*d in v^2, so a 1-ulp truncation in the first squaring is worth 8 ulp
  //     by the fourth. Four squarings give 1 + 2 + 4 + 8 = 15 ulp, plus up to 1 for the two constants'
  //     own roundings. 16 is the DERIVED bound; 8 was a guess and the table it accused was fine.
  //     Measured worst is 15, which is the derivation landing exactly on its bound rather than near it.
  const SQ_BOUND = 16;
  let worstX = 0, worstXAt = -1;
  for (let g = 0; g + 1 < NG; g++) {
    let v = EXP[g][1];
    for (let s = 0; s < 4; s++) v = mulS(v, v);
    const dev = Number(absB(v - EXP[g + 1][1]));
    if (dev > worstX) { worstX = dev; worstXAt = g; }
  }
  record('group g+1 is group g to the sixteenth power', worstX <= SQ_BOUND,
    `worst ${worstX} ulp at the group ${worstXAt}/${worstXAt + 1} boundary, against a derived ${SQ_BOUND} (1+2+4+8 squaring amplification, +1 for the two roundings)`);
  record('the squaring check can fail', (() => {
    // A check that passes on a deliberately corrupted table is not a check. One entry, one unit out.
    const bad = EXP.map((r) => [...r]);
    bad[NG - 1][1] += BigInt(SQ_BOUND + 1);
    let v = EXP[NG - 2][1];
    for (let s = 0; s < 4; s++) v = mulS(v, v);
    return Number(absB(v - bad[NG - 1][1])) > SQ_BOUND;
  })(), `moving one table entry by ${SQ_BOUND + 1} units puts it over the line`);

  // (d) sqrt(2*pi), from a completely different route: 2*pi via Math.PI.
  const spWant = Math.sqrt(2 * Math.PI) * Number(ONE);
  record('SQRT2PI matches Math.sqrt(2*Math.PI)', Math.abs(Number(SQRT2PI) - spWant) <= 1,
    `${SQRT2PI} vs ${spWant.toFixed(1)} — the circuit's was computed by Machin + integer sqrt`);
}

// =================================================================================================
// 2. the tail bounds
// =================================================================================================
console.log('\n2. THE TAIL BOUNDS. Above z = 7.0711 the circuit asserts instead of computing, so the');
console.log('   asserted constants must sit above the true maximum — and not absurdly above it.\n');
{
  const zSplitReal = Number(ZSPLIT) / Number(ONE);
  // Both functions are decreasing on the tail, so the maximum is at the split. Swept anyway, because
  // "decreasing" is a claim and a sweep costs nothing.
  let maxC = 0, maxP = 0;
  for (let i = 0; i <= 400000; i++) {
    const z = zSplitReal + (i / 400000) * 5;
    const phi = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    // the true upper tail via Hart's OWN other branch, the continued fraction the circuit omits
    let f = z + 0.65; f = z + 4 / f; f = z + 3 / f; f = z + 2 / f; f = z + 1 / f;
    const c = Math.exp(-z * z / 2) / (2.506628274631 * f);
    maxC = Math.max(maxC, c); maxP = Math.max(maxP, phi);
  }
  const cUlp = maxC / u, pUlp = maxP / u;
  record('CDF_TAIL is above the true tail maximum', Number(CDF_TAIL) >= cUlp,
    `bound ${CDF_TAIL} ulp (${(Number(CDF_TAIL) * u).toExponential(2)}) vs true max ${cUlp.toFixed(3)} ulp (${maxC.toExponential(2)}) — uses ${((cUlp / Number(CDF_TAIL)) * 100).toFixed(1)}%`);
  record('PHI_TAIL is above the true tail maximum', Number(PHI_TAIL) >= pUlp,
    `bound ${PHI_TAIL} ulp (${(Number(PHI_TAIL) * u).toExponential(2)}) vs true max ${pUlp.toFixed(3)} ulp (${maxP.toExponential(2)}) — uses ${((pUlp / Number(PHI_TAIL)) * 100).toFixed(1)}%`);
  record('neither tail bound is more than 3x the maximum it bounds', Number(CDF_TAIL) <= cUlp * 3 + 1 && Number(PHI_TAIL) <= pUlp * 3 + 1,
    'a bound far above what it bounds is a bound nothing can violate');
  globalThis.__tail = { maxC, maxP, cUlp, pUlp };
}

// =================================================================================================
// 3. the sweep, against the real engine
// =================================================================================================
console.log('\n3. THE SWEEP. At r = 0 the engine\'s own call delta IS N(d1), and its gamma is');
console.log('   phi(d1)/(F*sigma*sqrt(T)) — so both public values come out of the engine\'s published');
console.log('   fields and nothing is re-derived here to agree with itself.\n');

let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function encode(F, K, T, sg) {
  const g = black76(F, K, T, sg, 'call', 0);
  if (!g) return null;
  const d1 = g.d1;
  const xMag = BigInt(Math.round(Math.abs(d1) * Number(ONE)));
  if (xMag >= (1n << 52n)) return { outOfDomain: true };
  const nHat = BigInt(Math.round(g.delta * Number(ONE)));
  const phi = g.gamma * F * sg * Math.sqrt(T);
  const pHat = BigInt(Math.round(phi * Number(ONE)));
  if (nHat < 0n || nHat > ONE || pHat < 0n || pHat >= ONE) return { badRange: true };
  const xSign = d1 < 0 ? 1 : 0;
  const cHat = xSign ? nHat : ONE - nHat;
  if (cHat > ONE / 2n) return { badTail: true, d1 };

  const onBranch = xMag < ZSPLIT;
  const zc = onBranch ? xMag : ZSPLIT - 1n;
  const { eHat, bHat, dHat } = evalFx(zc);
  let usedC, usedP;
  if (onBranch) {
    // AGAINST THE BAND IN FORCE, which is TOL/2 and not TOL. Dividing by TOLC is what reported 18.3%
    // headroom used where the real figure is twice that, and a headroom number that is wrong by 2x in
    // the reassuring direction is the shape of every defect this project has found in its own work.
    usedC = Number(absB(cHat * dHat - eHat * bHat)) / (HALFC * Number(dHat));
    usedP = Number(absB(pHat * SQRT2PI - eHat * ONE)) / (HALFP * Number(SQRT2PI));
  } else {
    usedC = Number(cHat) / Number(CDF_TAIL);
    usedP = Number(pHat) / Number(PHI_TAIL);
  }
  return {
    witness: { xSign: String(xSign), xMag: String(xMag), nHat: String(nHat), pHat: String(pHat) },
    onBranch, usedC, usedP, d1, delta: g.delta, gamma: g.gamma, phi, F, K, T, sg,
  };
}

const RUNS = 6000;
let kept = 0, onBranch = 0, offBranch = 0, outOfDomain = 0, badRange = 0, badTail = 0, violations = 0;
let wC = 0, wP = 0, worstCase = null, worstTailCase = null;
for (let i = 0; i < RUNS; i++) {
  const F = 10 ** (1 + rand() * 4);
  const e = encode(F, F * (0.3 + rand() * 2.7), 7 / 365 + rand() * 2, 0.2 + rand() * 2.3);
  if (!e) continue;
  if (e.outOfDomain) { outOfDomain++; continue; }
  if (e.badRange) { badRange++; continue; }
  if (e.badTail) { badTail++; continue; }
  kept++;
  if (e.onBranch) onBranch++; else { offBranch++; if (!worstTailCase || e.usedC > worstTailCase.usedC) worstTailCase = e; }
  if (e.usedC > 1 || e.usedP > 1) violations++;
  if (e.onBranch && e.usedC > wC) { wC = e.usedC; worstCase = e; }
  if (e.onBranch) wP = Math.max(wP, e.usedP);
}

console.log(`  legs sampled            : ${kept} of ${RUNS}`);
console.log(`  on the computed branch  : ${onBranch}   (${((onBranch / kept) * 100).toFixed(2)}%)`);
console.log(`  on the bounded tail     : ${offBranch}   (${((offBranch / kept) * 100).toFixed(2)}%)`);
console.log(`  refused before encoding : ${outOfDomain} out of domain, ${badRange} out of range, ${badTail} c > 1/2`);
console.log(`  bound violations        : ${violations}`);
console.log(`  worst bound used        : CDF ${(wC * 100).toFixed(1)}% of ${HALFC} ulp · pdf ${(wP * 100).toFixed(1)}% of ${HALFP} ulp\n`);

record('the CDF tolerance holds on every leg', violations === 0,
  `${kept} legs, worst ${(wC * 100).toFixed(1)}% of the ${HALFC}-ulp band = ${(wC * HALFC * u).toExponential(2)} absolute`);
record('both tolerances are tight, not generous', wC > 0.05 && wP > 0.05,
  `CDF ${(wC * 100).toFixed(1)}% · pdf ${(wP * 100).toFixed(1)}% — under 5% would mean the sweep has not tested them`);
record('the values came from the engine, not from a re-derivation here',
  typeof black76 === 'function',
  'delta and gamma are read off black76\'s return; N and phi are recomputed only inside the circuit');
record('the tail branch is exercised, not skipped', offBranch > 0,
  `${offBranch} legs landed above z = 7.0711 and were BOUNDED rather than computed`);

// A BOUND NOTHING CAN VIOLATE IS NOT A BOUND, AND A BAND OPEN AT ONE END IS NOT A BAND. So this walks
// the witness generator out in BOTH directions and reports the two edges it finds — the check that
// would have caught the one-sided bound the first time, because a one-sided band has no far edge.
{
  const w = worstCase;
  const wit = w.witness;
  const { createRequire: cr } = await import('node:module');
  const req = cr(import.meta.url);
  const b1 = await req(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));
  const tryK = async (dn, dp) => {
    try {
      await b1.calculateWTNSBin({ ...wit, nHat: String(BigInt(wit.nHat) + BigInt(dn)), pHat: String(BigInt(wit.pHat) + BigInt(dp)) }, 0);
      return true;
    } catch { return false; }
  };
  // Walk out to four times the band. If either side is still accepting there, it is not bounded.
  const SPAN = Number(TOLC) * 4;
  let nLo = null, nHi = null;
  for (let k = -SPAN; k <= SPAN; k++) if (await tryK(k, 0)) { if (nLo === null) nLo = k; nHi = k; }
  let pLo = null, pHi = null;
  for (let k = -SPAN; k <= SPAN; k++) if (await tryK(0, k)) { if (pLo === null) pLo = k; pHi = k; }
  const nWidth = nHi - nLo + 1, pWidth = pHi - pLo + 1;
  record('the accepted nHat band is CLOSED AT BOTH ENDS', nLo > -SPAN && nHi < SPAN,
    `accepted offsets [${nLo}, ${nHi}] inside a search of [${-SPAN}, ${SPAN}] — the pre-fix circuit accepted every offset to one side of this, which is what a missing range check looks like from outside`);
  record('the accepted pHat band is CLOSED AT BOTH ENDS', pLo > -SPAN && pHi < SPAN,
    `accepted offsets [${pLo}, ${pHi}] inside a search of [${-SPAN}, ${SPAN}]`);
  record(`the nHat band is ${Number(TOLC)} ulp wide, which is 2 x the ${HALFC}-ulp half-width`, nWidth <= Number(TOLC) + 1,
    `${nWidth} integer offsets accepted against a derived width of ${Number(TOLC)} + 1 for the endpoints`);
  record(`the pHat band is ${Number(TOLP)} ulp wide`, pWidth <= Number(TOLP) + 1,
    `${pWidth} integer offsets accepted against a derived width of ${Number(TOLP)} + 1`);
  globalThis.__band = { nLo, nHi, nWidth, pLo, pHi, pWidth, searched: SPAN };
}

// =================================================================================================
// 4. a real proof
// =================================================================================================
console.log('\n4. A REAL PROOF, from the worst leg the sweep found.');
console.log(`   F ${worstCase.F.toPrecision(6)} K ${worstCase.K.toPrecision(6)} T ${worstCase.T.toPrecision(4)} sigma ${worstCase.sg.toPrecision(4)}`);
console.log(`   d1 ${worstCase.d1.toPrecision(8)} · delta ${worstCase.delta.toPrecision(10)} · phi(d1) ${worstCase.phi.toExponential(6)}\n`);
const { proof, publicSignals, proveMs } = await proveVerifyRefuse('ncdf', worstCase.witness, { record });

// The tail branch has to prove too, and it is a DIFFERENT statement, so it gets its own proof rather
// than a note saying it would work.
if (worstTailCase) {
  console.log('\n   And the tail branch, which proves a bound rather than a value:');
  console.log(`   d1 ${worstTailCase.d1.toPrecision(8)} · delta ${worstTailCase.delta.toPrecision(10)}`);
  const sj = await snarkjs();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const builder = await require(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));
  const wtns = await builder.calculateWTNSBin(worstTailCase.witness, 0);
  const r = await sj.plonk.prove(path.join(BUILD, 'ncdf_plonk.zkey'), wtns);
  const vk = JSON.parse(readFileSync(path.join(BUILD, 'ncdf_vk.json'), 'utf8'));
  const ok = await sj.plonk.verify(vk, r.publicSignals, r.proof);
  // `computed` is the first output signal, so publicSignals[0] tells a reader WHICH statement they got.
  record('the tail-branch proof verifies and publishes computed = 0', ok === true && r.publicSignals[0] === '0',
    `computed = ${r.publicSignals[0]} — a reader can tell a bounded statement from an evaluated one without asking`);
  record('the computed-branch proof publishes computed = 1', publicSignals[0] === '1',
    `computed = ${publicSignals[0]}`);
}

// =================================================================================================
// 5. THE POINT — can a service with a wrong CDF get a proof accepted?
// =================================================================================================
console.log('\n5. THE WHOLE POINT. A service running a wrong normal CDF satisfies all eight consistency');
console.log('   identities. Does it satisfy THIS?\n');
console.log('   The binding that makes this bite: gamma does not depend on the CDF at all (it is');
console.log('   phi(d1)/(F*sigma*sqrt(T)), pure density), so pHat pins x = d1 whatever CDF the service');
console.log('   used. With x pinned, nHat must be N(d1) — and a wrong CDF\'s delta is not.\n');

function absteg(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const c = 0.5 * (1 - y);
  return x <= 0 ? c : 1 - c;
}
const logistic = (x) => 1 / (1 + Math.exp(-1.702 * x));
const WRONG = [['Abramowitz-Stegun 7.1.26', absteg], ['logistic 1.702x', logistic]];

const sj = await snarkjs();
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const builder = await require(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));

console.log(`   ${'wrong CDF'.padEnd(26)}${'legs'.padStart(7)}${'worst |ddelta| in ulp'.padStart(23)}${'x the bound'.padStart(13)}${'proofs accepted'.padStart(17)}`);
const wrongStats = [];
for (const [name, Nf] of WRONG) {
  let n = 0, worstUlp = 0, overBound = 0, accepted = 0, tried = 0;
  const cases = [];
  seed = 987654321;
  for (let i = 0; i < 1200; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sg, 'call', 0);
    if (!g) continue;
    const xMag = BigInt(Math.round(Math.abs(g.d1) * Number(ONE)));
    if (xMag >= ZSPLIT) continue;
    // the wrong service's delta, at r = 0
    const deltaWrong = Nf(g.d1);
    const nHat = BigInt(Math.round(deltaWrong * Number(ONE)));
    if (nHat < 0n || nHat > ONE) continue;
    const xSign = g.d1 < 0 ? 1 : 0;
    const cHat = xSign ? nHat : ONE - nHat;
    if (cHat > ONE / 2n || cHat < 0n) { overBound++; n++; continue; }   // refused before the circuit
    const { eHat, bHat, dHat } = evalFx(xMag);
    const ulpOut = Number(absB(cHat * dHat - eHat * bHat)) / Number(dHat);
    n++;
    if (ulpOut > worstUlp) worstUlp = ulpOut;
    if (ulpOut > HALFC) overBound++;
    else cases.push({ nHat, xMag, xSign, ulpOut, F, K, T, sg, d1: g.d1 });
  }
  // Prove the WORST offender for real, and prove one that squeaked under the bound if any did, so the
  // acceptance rate is measured by a verifier and not by this file's own arithmetic.
  const toTry = cases.sort((a, b) => b.ulpOut - a.ulpOut).slice(0, 3);
  for (const c of toTry) {
    tried++;
    const phi = Math.exp(-c.d1 * c.d1 / 2) / Math.sqrt(2 * Math.PI);
    const w = { xSign: String(c.xSign), xMag: String(c.xMag), nHat: String(c.nHat), pHat: String(BigInt(Math.round(phi * Number(ONE)))) };
    try {
      const wt = await builder.calculateWTNSBin(w, 0);
      const r = await sj.plonk.prove(path.join(BUILD, 'ncdf_plonk.zkey'), wt);
      const vk = JSON.parse(readFileSync(path.join(BUILD, 'ncdf_vk.json'), 'utf8'));
      if (await sj.plonk.verify(vk, r.publicSignals, r.proof)) accepted++;
    } catch { /* witness generation refused, which is a refusal */ }
  }
  wrongStats.push({ name, n, worstUlp, overBound, accepted, tried, underBound: cases.length });
  console.log(`   ${name.padEnd(26)}${String(n).padStart(7)}${worstUlp.toExponential(2).padStart(23)}${(worstUlp / HALFC).toExponential(2).padStart(13)}${`${accepted} of ${tried}`.padStart(17)}`);
}

// DETECTION IS PER LEG, AND IT IS NOT UNIVERSAL. The first version of this check asserted "every leg
// is outside the bound" and A-S failed it: 4 of 1194 legs slipped under, and all 3 of those that were
// put to the prover VERIFIED. That is not a defect in the circuit, it is the truth about A-S — its
// error function has 11 sign changes on [-7.07, 7.07], and at a crossing it agrees with Hart exactly.
// It also agrees wherever the CDF has saturated, which is 18.1% of the d1 axis by measure but a much
// smaller share of a real book because real d1 concentrates near zero.
//
// So the honest claim is a RATE, plus the fact that a service must prove EVERY leg it publishes.
for (const s of wrongStats) {
  const rate = s.overBound / s.n;
  record(`${s.name}: refused on at least 95% of legs`, rate >= 0.95,
    `${s.overBound} of ${s.n} = ${(rate * 100).toFixed(2)}% over the ${HALFC}-ulp band; worst is ${(s.worstUlp / HALFC).toExponential(2)}x it. ${s.underBound} slipped under and ${s.accepted} of ${s.tried} of those VERIFIED — at a zero crossing of the error, or where the CDF has saturated, a wrong CDF is momentarily right.`);
  s.perLegRefusalRate = rate;
  // A book has to prove every leg, so the miss probability compounds. Reported for the leg counts a
  // real options book actually has.
  s.bookMiss = [1, 2, 4, 8].map((k) => ({ legs: k, missProb: (1 - rate) ** k }));
}
console.log(`\n   A book must prove EVERY leg, so the misses compound:`);
console.log(`   ${'wrong CDF'.padEnd(26)}${'1 leg'.padStart(12)}${'2 legs'.padStart(12)}${'4 legs'.padStart(12)}${'8 legs'.padStart(12)}`);
for (const s of wrongStats) {
  console.log(`   ${s.name.padEnd(26)}${s.bookMiss.map((b) => b.missProb.toExponential(2).padStart(12)).join('')}`);
}
record('a wrong CDF cannot hide behind a multi-leg book',
  wrongStats.every((s) => (1 - s.perLegRefusalRate) ** 2 < 1e-4),
  `worst two-leg miss probability ${Math.max(...wrongStats.map((s) => (1 - s.perLegRefusalRate) ** 2)).toExponential(2)}`);

// And the honest inverse: what a wrong CDF does to the price, so the reader sees what was at stake.
{
  let worstRel = 0, meanRel = 0, n = 0;
  seed = 24681357;
  for (let i = 0; i < 4000; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sg, 'call', 0);
    if (!g) continue;
    const wrongPrice = F * absteg(g.d1) - K * absteg(g.d2);
    const r = Math.abs(wrongPrice - g.price) / Math.max(Math.abs(g.price), 1e-12);
    worstRel = Math.max(worstRel, r); meanRel += r; n++;
  }
  console.log(`\n   For scale: A-S 7.1.26 prices a leg wrong by ${(worstRel * 100).toFixed(1)}% worst, ${((meanRel / n) * 100).toFixed(4)}% mean, over ${n} legs,`);
  console.log(`   and satisfies all eight consistency identities to 3.3e-14 while doing it.`);
}

// THE ADVERSARY'S BETTER MOVE, which the check above does not test. Nothing forces the prover to
// submit the true d1. A wrong-CDF service could instead solve N_hart(x') = delta_wrong for x' and
// submit THAT — the CDF relation then holds exactly. What it cannot also do is match the density,
// because gamma does not depend on the CDF, so phi(x') has to equal the phi the published gamma
// implies. This measures the gap that closes on, in ulp of the pdf bound.
{
  console.log(`\n   The adversary's better move: submit x' with N(x') = delta_wrong instead of the true d1.`);
  console.log(`   The CDF relation then holds exactly. The DENSITY is what refuses.\n`);
  const hartJs = (x) => {
    const z = Math.abs(x); let c = 0;
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
      } else { let f = z + 0.65; f = z + 4 / f; f = z + 3 / f; f = z + 2 / f; f = z + 1 / f; c = e / (2.506628274631 * f); }
    }
    return x <= 0 ? c : 1 - c;
  };
  const npdfJs = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  // invert N by bisection; monotone, so this is exact to double precision
  const invN = (y) => { let lo = -8, hi = 8; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (hartJs(m) < y) lo = m; else hi = m; } return (lo + hi) / 2; };

  let worstShift = 0, worstPdfUlp = 0, underPdf = 0, nn = 0;
  seed = 13572468;
  for (let i = 0; i < 1500; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sg, 'call', 0);
    if (!g || Math.abs(g.d1) >= 7.07106781186547) continue;
    const dw = absteg(g.d1);
    if (!(dw > 1e-14) || !(dw < 1 - 1e-14)) continue;
    const xp = invN(dw);
    if (Math.abs(xp) >= 7.07106781186547) continue;
    nn++;
    // the density the published gamma implies is phi(d1); the density at x' is phi(x')
    const pdfUlp = Math.abs(npdfJs(xp) - npdfJs(g.d1)) / u;
    worstShift = Math.max(worstShift, Math.abs(xp - g.d1));
    if (pdfUlp > worstPdfUlp) worstPdfUlp = pdfUlp;
    if (pdfUlp <= HALFP) underPdf++;
  }
  console.log(`   ${nn} legs · worst |x' - d1| ${worstShift.toExponential(2)} · worst density gap ${worstPdfUlp.toExponential(2)} ulp against a ${TOLP}-ulp bound`);
  record('moving x to satisfy the CDF breaks the density instead',
    underPdf / nn <= 0.05,
    `${nn - underPdf} of ${nn} = ${(((nn - underPdf) / nn) * 100).toFixed(2)}% of relocated points are outside the pdf bound; worst is ${(worstPdfUlp / HALFP).toExponential(2)}x it. The two relations cannot both be satisfied because gamma is CDF-independent.`);
  globalThis.__relocate = { legs: nn, worstShift, worstPdfUlp, underPdf, refusalRate: (nn - underPdf) / nn };
}

// =================================================================================================
// 6. the exported verifier, in an EVM
// =================================================================================================
console.log('\n6. THE EXPORTED VERIFIER, inside an in-process EVM. Nothing is deployed.');
const evm = await evmRehearsal('ncdf', proof, publicSignals, { record });

// =================================================================================================
// 7. THE ENVELOPE, IN PRICE TERMS
// =================================================================================================
// TOLC is a bound on the RESIDUAL: how far the submitted nHat may sit from the circuit's own integer
// evaluation. It is not the distance to the true normal CDF, and a buyer's envelope is the distance to
// the truth. Three terms, each measured here rather than quoted:
//
//   (a) the band in force              TOLC/2 = 6 ulp, walked out by the witness generator above
//   (b) the evaluator's own error      eHat*bHat/dHat vs the true CDF at the same grid point
//   (c) the grid under x               xHat is a rounding of d1, and N moves by phi(x) per unit
//
// (b) needs a normal CDF that is neither Hart nor Abramowitz-Stegun, or it would be checking the
// circuit against the thing the circuit approximates. Maclaurin erf below 2, the classical erfc
// continued fraction above it, cross-checked where they overlap.
console.log('\n7. THE ENVELOPE A BUYER GETS, which is not TOLC.\n');
{
  const erfSeries = (z) => { let t = z, s = z; for (let n = 1; n < 400; n++) { t *= -z * z / n; const term = t / (2 * n + 1); s += term; if (Math.abs(term) < 1e-19 * Math.abs(s)) break; } return 2 / Math.sqrt(Math.PI) * s; };
  const erfcCF = (z) => { let f2 = z, C = z, D = 0; for (let i = 1; i < 400; i++) { const a = i / 2; D = z + a * D; if (D === 0) D = 1e-300; D = 1 / D; C = z + a / C; if (C === 0) C = 1e-300; const dl = C * D; f2 *= dl; if (Math.abs(dl - 1) < 1e-17) break; } return Math.exp(-z * z) / Math.sqrt(Math.PI) / f2; };
  const refUpperTail = (z) => 0.5 * (z / Math.SQRT2 < 2 ? 1 - erfSeries(z / Math.SQRT2) : erfcCF(z / Math.SQRT2));   // = N(-z)
  let overlap = 0;
  for (let z = 1.5; z < 2.5; z += 0.002) overlap = Math.max(overlap, Math.abs((1 - erfSeries(z)) - erfcCF(z)) / erfcCF(z));
  record('the independent reference agrees with itself across its own branch change', overlap < 1e-10,
    `series vs continued fraction ${overlap.toExponential(2)} relative on [1.5, 2.5] — this is the ruler, so it is checked before it is used`);

  // (b), swept over the whole computed branch.
  let evalC = 0, atC = 0, evalP = 0, atP = 0;
  // and the HONEST residual over the same sweep, which is the fraction of (a) that the truth uses.
  // Sampled legs do not reach z -> 0, where the residual is worst, so this sweeps the domain instead.
  let honestC = 0, honestP = 0, honestAtC = 0;
  const NS = 400000;
  for (let i = 0; i <= NS; i++) {
    const zHat = BigInt(Math.round((i / NS) * (Number(ZSPLIT) - 1)));
    const z = Number(zHat) / Number(ONE);
    const { eHat, bHat, dHat } = evalFx(zHat);
    const ev = Number(eHat) * Number(bHat) / Number(dHat) / Number(ONE);
    const tv = refUpperTail(z);
    const dc = Math.abs(ev - tv) / u;
    if (dc > evalC) { evalC = dc; atC = z; }
    const evP = Number(eHat) / Number(SQRT2PI);
    const tvP = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    const dp = Math.abs(evP - tvP) / u;
    if (dp > evalP) { evalP = dp; atP = z; }
    const cH = BigInt(Math.round(tv * Number(ONE)));
    const rc = Number(absB(cH * dHat - eHat * bHat)) / Number(dHat);
    if (rc > honestC) { honestC = rc; honestAtC = z; }
    const pH = BigInt(Math.round(tvP * Number(ONE)));
    const rp = Number(absB(pH * SQRT2PI - eHat * ONE)) / Number(SQRT2PI);
    if (rp > honestP) honestP = rp;
  }
  console.log(`   (b) evaluator vs the independent reference : ${evalC.toFixed(4)} ulp on N at z=${atC.toFixed(4)} · ${evalP.toFixed(4)} ulp on phi at z=${atP.toFixed(4)}`);
  console.log(`   honest residual over the DOMAIN (not legs) : ${honestC.toFixed(4)} ulp at z=${honestAtC.toFixed(5)} · ${honestP.toFixed(4)} ulp on phi\n`);
  record('the worst honest residual anywhere on the domain is inside the band', honestC <= HALFC && honestP <= HALFP,
    `CDF ${honestC.toFixed(4)} of ${HALFC} = ${((honestC / HALFC) * 100).toFixed(1)}% · pdf ${honestP.toFixed(4)} of ${HALFP} = ${((honestP / HALFP) * 100).toFixed(1)}%. The engine-leg sweep in section 3 reached ${(wC * 100).toFixed(1)}%, so the domain sweep is the binding measurement and the leg sweep is not`);

  // (c) N is Lipschitz with constant max phi = 1/sqrt(2 pi); phi is Lipschitz with max |x|phi(x) at x=1.
  const xGridN = 0.5 / Math.sqrt(2 * Math.PI);
  const xGridP = 0.5 * Math.exp(-0.5) / Math.sqrt(2 * Math.PI);
  const ulpN = HALFC + evalC + xGridN;
  const ulpP = HALFP + evalP + xGridP;
  const epsN = ulpN * u, epsP = ulpP * u;
  console.log(`   ENVELOPE ON N   : ${HALFC} (band) + ${evalC.toFixed(4)} (evaluator) + ${xGridN.toFixed(4)} (x grid) = ${ulpN.toFixed(4)} ulp = ${epsN.toExponential(4)}`);
  console.log(`   ENVELOPE ON PHI : ${HALFP} + ${evalP.toFixed(4)} + ${xGridP.toFixed(4)} = ${ulpP.toFixed(4)} ulp = ${epsP.toExponential(4)}`);
  // The tail branch is TIGHTER, not looser, and this is worth saying because the circuit's own header
  // calls it "a real weakening". For the CDF it is not: cHat <= CDF_TAIL and the true tail is under
  // 0.8453 ulp, so the two together bound the gap by their sum, which is under a third of the band
  // above. It IS a weakening for the density, where the bound is 8 ulp against a true 6.09.
  const tailN = (Number(CDF_TAIL) + globalThis.__tail.cUlp) * u;
  console.log(`   ON THE TAIL     : N within ${Number(CDF_TAIL)} + ${globalThis.__tail.cUlp.toFixed(4)} = ${(tailN / u).toFixed(4)} ulp = ${tailN.toExponential(4)} — TIGHTER than the computed branch`);
  record('the tail branch is not the weakening the header calls it, for the CDF', tailN < epsN,
    `${tailN.toExponential(3)} against ${epsN.toExponential(3)} on the computed branch. It IS a weakening for the density: ${Number(PHI_TAIL)} ulp asserted against a true maximum of ${globalThis.__tail.pUlp.toFixed(3)}`);

  // ---- AND NOW IN PRICE TERMS ------------------------------------------------------------------
  // price = df*(F*N(d1) - K*N(d2)), the engine's own form, so an envelope epsN on each N is an
  // envelope df*(F+K)*epsN on the leg premium, per unit of quantity. Reported against the forward
  // rather than against the premium: a deep out-of-the-money leg has a premium of 1e-70 and a ratio
  // to it is a number about nothing.
  console.log('\n   IN PRICE TERMS — df*(F+K)*epsN per contract, the whole envelope on one leg:');
  const rows = [[1, 1], [3000, 3000], [100000, 100000], [100000, 70000], [100000, 200000]];
  for (const [F, K] of rows) {
    console.log(`     F ${String(F).padStart(6)}  K ${String(K).padStart(6)}  ->  ${((F + K) * epsN).toExponential(3)} quote units  (${(((F + K) * epsN / F) * 1e4).toExponential(3)} bps of the forward)`);
  }
  // What it refuses, in the same unit, so the two are comparable. A-S 7.1.26's mispricing measured
  // against the FORWARD, which is stable, instead of against the premium, which is not.
  let worstAsFwd = 0, meanAsFwd = 0, nAs = 0;
  seed = 24681357;
  for (let i = 0; i < 6000; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const gg = black76(F, K, T, sg, 'call', 0);
    if (!gg) continue;
    const wrong = F * absteg(gg.d1) - K * absteg(gg.d2);
    const rel = Math.abs(wrong - gg.price) / F;
    worstAsFwd = Math.max(worstAsFwd, rel); meanAsFwd += rel; nAs++;
  }
  const envFwd = 2 * epsN;    // (F+K)/F <= 2 at K <= F; the widest row above is 3x, reported there
  console.log(`\n     A-S 7.1.26 misprices by ${(worstAsFwd * 1e4).toExponential(3)} bps of the forward worst, ${((meanAsFwd / nAs) * 1e4).toExponential(3)} bps mean, over ${nAs} legs.`);
  console.log(`     This circuit admits ${(envFwd * 1e4).toExponential(3)} bps of the forward. Ratio ${(worstAsFwd / envFwd).toExponential(2)}.`);
  // THE THRESHOLD HERE WAS A GUESS AND THE GATE FAILED ON IT: 1e6 was written down before anything was
  // measured, and the measurement is 1.8e4. Both numbers are large, but only one of them was measured,
  // and a threshold nobody derived is the thing this file exists to not contain. The DERIVED statement
  // is about the two CDF errors, which is where the ratio actually comes from and where it is stable:
  // A-S 7.1.26 carries up to 7.5e-8 of absolute CDF error by construction, and this circuit admits
  // epsN. The price ratio inherits it, because both scale by the same (F+K).
  const AS_CDF_ERROR = 7.5e-8;
  record('the CDF error this circuit admits is four orders below the one it exists to refuse',
    AS_CDF_ERROR / epsN > 1e3,
    `A-S carries ${AS_CDF_ERROR.toExponential(1)} of CDF error against an admitted ${epsN.toExponential(3)} — ${(AS_CDF_ERROR / epsN).toExponential(2)}x. Measured on the price, over ${nAs} legs and in bps of the forward so the units match, the ratio is ${(worstAsFwd / envFwd).toExponential(2)}x`);
  // AND THE HONEST DEFLATION OF THE HEADLINE THIS CIRCUIT WAS BUILT ON. "A-S prices a leg 19.4% wrong"
  // is relative to the PREMIUM, and a deep out-of-the-money premium is 1e-70, so that denominator can
  // be made to say anything: the same sweep at a different seed reports 18,526%. Against the forward —
  // the only stable denominator here — A-S is wrong by 1.5 cents on a 100,000 contract. That is still
  // 1.8e4 times what this circuit admits, which is the claim worth making, and it is a smaller and
  // truer claim than the percentage.
  console.log(`     For scale on a 100,000 forward: A-S up to ${(worstAsFwd * 100000).toFixed(4)} quote units, this circuit ${(envFwd * 100000).toExponential(3)}.`);
  globalThis.__envelope = {
    bandUlpN: HALFC, bandUlpP: HALFP, evaluatorUlpN: evalC, evaluatorUlpP: evalP,
    xGridUlpN: xGridN, xGridUlpP: xGridP, envelopeUlpN: ulpN, envelopeUlpP: ulpP,
    envelopeAbsoluteN: epsN, envelopeAbsolutePhi: epsP, envelopeTailAbsoluteN: tailN,
    honestWorstUlpC: honestC, honestWorstUlpP: honestP,
    honestFractionOfBandC: honestC / HALFC, honestFractionOfBandP: honestP / HALFP,
    priceEnvelopePerContract: Object.fromEntries(rows.map(([F, K]) => [`F${F}_K${K}`, (F + K) * epsN])),
    asMispriceBpsOfForwardWorst: worstAsFwd * 1e4, asMispriceBpsOfForwardMean: (meanAsFwd / nAs) * 1e4,
    admittedBpsOfForward: envFwd * 1e4,
  };
}

// =================================================================================================
const f = plonkFacts(path.join(BUILD, 'ncdf_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE B7-5: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · domain ${f.domainSize} · ${f.nPublic} public · proved in ${proveMs} ms`);
console.log(`  ${evm.acceptGas} gas to accept, ${evm.rejectGas} to refuse (ONE SAMPLE — see probe-plonk-gas-variance)`);
console.log('');
const E = globalThis.__envelope;
console.log(`  WHAT IS PROVEN: for the public point x, n is the standard normal CDF at x and p its`);
console.log(`  density. The band in force is TOLC/2 = ${HALFC} ulp and TOLP/2 = ${HALFP}, walked out in both`);
console.log(`  directions by the witness generator; the ENVELOPE to the truth adds the evaluator's own`);
console.log(`  ${E.evaluatorUlpN.toFixed(2)} ulp and the x grid's ${E.xGridUlpN.toFixed(2)}, giving ${E.envelopeUlpN.toFixed(3)} ulp = ${E.envelopeAbsoluteN.toExponential(3)} on N.`);
console.log(`  IN PRICE TERMS: ${E.priceEnvelopePerContract.F100000_K100000.toExponential(3)} quote units on a 100,000 forward at the money, per contract,`);
console.log(`  against the ${E.asMispriceBpsOfForwardWorst.toExponential(3)} bps of forward that A-S 7.1.26 misprices by. The worst honest`);
console.log(`  residual anywhere on the domain uses ${(E.honestFractionOfBandC * 100).toFixed(1)}% of the CDF band and ${(E.honestFractionOfBandP * 100).toFixed(1)}% of the density's.`);
console.log(`  WHAT IS NOT: x itself. Pinning d1 to (F, K, T, sigma) needs ln(F/K), which is this same`);
console.log(`  exp gadget backwards (K*exp(L) = F) and is NOT BUILT. A caller who binds p to a published`);
console.log(`  gamma gets x pinned without any logarithm — measured above, not built into the circuit.`);
console.log('  AND UNTIL THIS RUN THE CDF BOUND WAS ONE-SIDED. Section 0 shows the pre-fix constraint');
console.log(`  system satisfied by a claimed delta of 1.0, worth ${(((globalThis.__defect.liedPrice - globalThis.__defect.enginePrice) / globalThis.__defect.enginePrice) * 100).toFixed(0)}% on one at-the-money leg.`);
console.log('  NOTHING SERVED, NOTHING DEPLOYED. options-risk does not emit this.');

writeFileSync(path.join(BUILD, 'gateB7-5-ncdf.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate,
  params: { S: Sn, ulp: u, groups: NG, TOLC: Number(TOLC), TOLP: Number(TOLP), bandUlpC: HALFC, bandUlpP: HALFP, CDF_TAIL: Number(CDF_TAIL), PHI_TAIL: Number(PHI_TAIL) },
  // NOT TOLC*u. That was a bound on the residual reported as if it were the distance to the truth, and
  // it happened to be conservative overall while understating the headroom used by exactly 2x. Every
  // term of the replacement is measured in section 7.
  envelope: E,
  envelopeAbsoluteN: E.envelopeAbsoluteN, envelopeAbsolutePhi: E.envelopeAbsolutePhi,
  oneSidedDefect: globalThis.__defect,
  acceptedBand: globalThis.__band,
  sweep: { samples: RUNS, kept, onBranch, offBranch, outOfDomain, badRange, badTail, violations, worstUsedC: wC, worstUsedP: wP },
  tail: globalThis.__tail,
  wrongCdf: wrongStats.map((s) => ({ ...s, worstUlpOverBound: s.worstUlp / HALFC })),
  relocationAttack: globalThis.__relocate,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize, nPublic: f.nPublic, proveMs,
  evm: { acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), deployedSize: evm.deployedSize, solc: evm.solc },
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
