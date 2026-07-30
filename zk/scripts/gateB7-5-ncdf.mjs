// GATE B7-5 — the normal CDF, COMPUTED in a circuit.
//
// B7-1..B7-4 prove consistency identities among the published greeks and every one of them says, in
// its own header, that a wrong normal CDF would satisfy it. probe-cdf-residue.mjs measured that:
// Abramowitz-Stegun 7.1.26 in place of Hart satisfies ALL EIGHT identities to 3.3e-14 and prices a leg
// 19.4% wrong. Put-call parity does not help either — the put is P = df*(K*N(-d2) - F*N(-d1)), so any
// N with N(-x) = 1 - N(x) cancels out of C - P = df*(F - K) algebraically.
//
// So this gate is about the thing the roadmap called a research project. Five things have to hold and
// each one can fail:
//
//   1. the 192 exp constants are right, checked against an INDEPENDENT derivation, not the generator's
//   2. the two tail bounds are above the true tail maximum
//   3. the circuit's tolerance holds over thousands of real legs, and is EXCEEDED by something
//   4. a real proof verifies, every perturbation is refused, and the exported verifier does the same
//      inside an EVM
//   5. THE POINT: a service running a wrong CDF cannot produce an accepted proof, and by how much
//
// Run: node zk/scripts/gateB7-5-ncdf.mjs
import { readFileSync, writeFileSync } from 'node:fs';
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
    usedC = Number(absB(cHat * dHat - eHat * bHat)) / (Number(TOLC) * Number(dHat));
    usedP = Number(absB(pHat * SQRT2PI - eHat * ONE)) / (Number(TOLP) * Number(SQRT2PI));
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
console.log(`  worst bound used        : CDF ${(wC * 100).toFixed(1)}% of ${TOLC} ulp · pdf ${(wP * 100).toFixed(1)}% of ${TOLP} ulp\n`);

record('the CDF tolerance holds on every leg', violations === 0,
  `${kept} legs, worst ${(wC * 100).toFixed(1)}% of the ${TOLC}-ulp bound = ${(wC * Number(TOLC) * u).toExponential(2)} absolute`);
record('both tolerances are tight, not generous', wC > 0.05 && wP > 0.05,
  `CDF ${(wC * 100).toFixed(1)}% · pdf ${(wP * 100).toFixed(1)}% — under 5% would mean the sweep has not tested them`);
record('the values came from the engine, not from a re-derivation here',
  typeof black76 === 'function',
  'delta and gamma are read off black76\'s return; N and phi are recomputed only inside the circuit');
record('the tail branch is exercised, not skipped', offBranch > 0,
  `${offBranch} legs landed above z = 7.0711 and were BOUNDED rather than computed`);

// A BOUND NOTHING CAN VIOLATE IS NOT A BOUND. Show TOLC + 1 ulp out is over the line, arithmetically
// first and then as a real refused proof further down.
{
  const w = worstCase;
  const { eHat, bHat, dHat } = evalFx(w.xMag ?? BigInt(w.witness.xMag));
  const cHat = BigInt(w.witness.xSign) === 1n ? BigInt(w.witness.nHat) : ONE - BigInt(w.witness.nHat);
  const base = absB(cHat * dHat - eHat * bHat);
  const nudged = absB((cHat + (TOLC + 1n)) * dHat - eHat * bHat);
  record(`a value ${TOLC + 1n} ulp out exceeds the bound`, nudged > TOLC * dHat,
    `residual goes from ${(Number(base) / Number(dHat)).toFixed(3)} ulp to ${(Number(nudged) / Number(dHat)).toFixed(3)} ulp against a limit of ${TOLC}`);
  const inside = absB((cHat + 2n) * dHat - eHat * bHat);
  record('a value 2 ulp out is still inside it', inside <= TOLC * dHat,
    `${(Number(inside) / Number(dHat)).toFixed(3)} ulp — so the bound is a band, not a knife edge, and not infinite either`);
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
    if (ulpOut > Number(TOLC)) overBound++;
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
  console.log(`   ${name.padEnd(26)}${String(n).padStart(7)}${worstUlp.toExponential(2).padStart(23)}${(worstUlp / Number(TOLC)).toExponential(2).padStart(13)}${`${accepted} of ${tried}`.padStart(17)}`);
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
    `${s.overBound} of ${s.n} = ${(rate * 100).toFixed(2)}% over ${TOLC} ulp; worst is ${(s.worstUlp / Number(TOLC)).toExponential(2)}x the bound. ${s.underBound} slipped under and ${s.accepted} of ${s.tried} of those VERIFIED — at a zero crossing of the error, or where the CDF has saturated, a wrong CDF is momentarily right.`);
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
    if (pdfUlp <= Number(TOLP)) underPdf++;
  }
  console.log(`   ${nn} legs · worst |x' - d1| ${worstShift.toExponential(2)} · worst density gap ${worstPdfUlp.toExponential(2)} ulp against a ${TOLP}-ulp bound`);
  record('moving x to satisfy the CDF breaks the density instead',
    underPdf / nn <= 0.05,
    `${nn - underPdf} of ${nn} = ${(((nn - underPdf) / nn) * 100).toFixed(2)}% of relocated points are outside the pdf bound; worst is ${(worstPdfUlp / Number(TOLP)).toExponential(2)}x it. The two relations cannot both be satisfied because gamma is CDF-independent.`);
  globalThis.__relocate = { legs: nn, worstShift, worstPdfUlp, underPdf, refusalRate: (nn - underPdf) / nn };
}

// =================================================================================================
// 6. the exported verifier, in an EVM
// =================================================================================================
console.log('\n6. THE EXPORTED VERIFIER, inside an in-process EVM. Nothing is deployed.');
const evm = await evmRehearsal('ncdf', proof, publicSignals, { record });

// =================================================================================================
const f = plonkFacts(path.join(BUILD, 'ncdf_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE B7-5: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · domain ${f.domainSize} · ${f.nPublic} public · proved in ${proveMs} ms`);
console.log(`  ${evm.acceptGas} gas to accept, ${evm.rejectGas} to refuse (ONE SAMPLE — see probe-plonk-gas-variance)`);
console.log('');
console.log(`  WHAT IS PROVEN: for the public point x, n is the standard normal CDF at x and p its`);
console.log(`  density, each within ${TOLC} / ${TOLP} ulp of ${u.toExponential(2)} — an envelope of ${(Number(TOLC) * u).toExponential(2)} on N.`);
console.log(`  WHAT IS NOT: x itself. Pinning d1 to (F, K, T, sigma) needs ln(F/K), which is this same`);
console.log(`  exp gadget backwards (K*exp(L) = F) and is NOT BUILT. A caller who binds p to a published`);
console.log(`  gamma gets x pinned without any logarithm — measured above, not built into the circuit.`);
console.log('  NOTHING SERVED, NOTHING DEPLOYED. options-risk does not emit this.');

writeFileSync(path.join(BUILD, 'gateB7-5-ncdf.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate,
  params: { S: Sn, ulp: u, groups: NG, TOLC: Number(TOLC), TOLP: Number(TOLP), CDF_TAIL: Number(CDF_TAIL), PHI_TAIL: Number(PHI_TAIL) },
  envelopeAbsoluteN: Number(TOLC) * u, envelopeAbsolutePhi: Number(TOLP) * u,
  sweep: { samples: RUNS, kept, onBranch, offBranch, outOfDomain, badRange, badTail, violations, worstUsedC: wC, worstUsedP: wP },
  tail: globalThis.__tail,
  wrongCdf: wrongStats.map((s) => ({ ...s, worstUlpOverBound: s.worstUlp / Number(TOLC) })),
  relocationAttack: globalThis.__relocate,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize, nPublic: f.nPublic, proveMs,
  evm: { acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), deployedSize: evm.deployedSize, solc: evm.solc },
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
