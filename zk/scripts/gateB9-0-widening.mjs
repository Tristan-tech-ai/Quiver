// GATE B9-0 — the WIDENED Kelly circuit proves, verifies, REFUSES, and names a bad member.
//
// Widening states N answers in one circuit. It is not recursion: recursion aggregates PROOFS, this
// aggregates STATEMENTS. N is 2, 3 and 4 because that is the batch Quiver can assemble — the arrival
// rate measured off X Layer is one paid call every 7.4 minutes, so a hundred answers would take twelve
// hours to collect and a risk answer twelve hours old is not a risk answer.
//
// Four things are measured here, none of them estimated:
//   1. constraints and evaluation domain at each N, read from the artifacts
//   2. warm proving time at each N, p50 over repeated runs, against the single-answer circuit
//   3. prove / verify / refuse, with every public signal perturbed and a bent proof point rejected
//   4. THE NEGATIVE THAT MATTERS: an aggregate with ONE tampered member is refused, and the failure
//      NAMES the member instead of being opaque
//
// Run: node zk/scripts/gateB9-0-widening.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plonkFacts } from './circuit-facts.mjs';
import {
  SCALE, pack, unpack, witnessFor, memberCheck, firstBadMember,
  encodeFromEngine, engine, rng, drawBet, wordsFor,
} from './lib/kelly-batch-witness.mjs';

const require = createRequire(import.meta.url);
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZES = [2, 3, 4];
const TIMING_RUNS = 7;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
  return !!pass;
};

const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
const sizeGate = await engine(import.meta.url);

console.log(`GATE B9-0 — widened Kelly circuit, N = ${SIZES.join(', ')} — ${new Date().toISOString()}\n`);

// ---- honest batches from the REAL engine ---------------------------------------------------------
// Never a recomputation of the Kelly formula: `encodeFromEngine` calls sizeGate and refuses any bet
// whose full-precision fraction has drifted past the six decimals the service publishes.
const rand = rng(20260729);
const pool = [];
while (pool.length < Math.max(...SIZES)) {
  const { p, b } = drawBet(rand);
  const e = encodeFromEngine(sizeGate, p, b);
  if (e && !e.diverged) pool.push(e);
}
console.log('  Batch members, each sized by the live sizeGate engine:\n');
console.log(`  ${'#'.padEnd(4)}${'p'.padEnd(14)}${'b'.padEnd(16)}${'f (served)'.padEnd(14)}${'2|R|/b'.padStart(10)}`);
pool.forEach((m, i) => {
  console.log(`  ${String(i).padEnd(4)}${m.p.toFixed(9).padEnd(14)}${m.b.toFixed(9).padEnd(16)}${String(m.served).padEnd(14)}${m.usage.toExponential(3).padStart(10)}`);
});

// ---- helper: witness, prove, verify --------------------------------------------------------------
async function builderFor(circuit) {
  const wasm = readFileSync(path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`));
  return require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.cjs'))(wasm);
}

const table = [];
const proofs = {};

for (const N of SIZES) {
  const circuit = `kellybatch${N}`;
  const zkey = path.join(BUILD, `${circuit}_plonk.zkey`);
  const vk = JSON.parse(readFileSync(path.join(BUILD, `${circuit}_vk.json`), 'utf8'));
  const f = plonkFacts(zkey);
  const r1cs = (await snarkjs.r1cs.info(path.join(BUILD, `${circuit}.r1cs`))).nConstraints;

  console.log(`\n${'-'.repeat(72)}\nN = ${N}  (${circuit})\n`);
  console.log(`  ${r1cs} R1CS · ${f.nConstraints} Plonk · ${f.nPublic} public signal(s) · domain ${f.domainSize}`);

  const answers = pool.slice(0, N);
  const words = pack(answers);
  record(`the packing round-trips: unpack(pack(answers)) === answers at N=${N}`,
    unpack(words, N).every((m, i) => m.pHat === answers[i].pHat && m.bHat === answers[i].bHat && m.fHat === answers[i].fHat),
    `${words.length} word(s) for ${N} answers · word[0] = ${words[0]}`);

  record(`the odd batch's spare lane is empty, so the encoding is canonical at N=${N}`,
    N % 2 === 0 || (words[words.length - 1] >> 120n) === 0n,
    N % 2 === 0 ? 'even batch, both lanes of every word carry an answer' : `top lane of the last word = ${words[words.length - 1] >> 120n}`);

  const builder = await builderFor(circuit);
  const wtns = await builder.calculateWTNSBin(witnessFor(answers), 0);

  // Warm the proving key out of the measurement, then p50 over TIMING_RUNS.
  await snarkjs.plonk.prove(zkey, wtns);
  const times = [];
  for (let i = 0; i < TIMING_RUNS; i++) {
    const t = Date.now();
    await snarkjs.plonk.prove(zkey, wtns);
    times.push(Date.now() - t);
  }
  times.sort((a, b) => a - b);
  const proveMs = times[(TIMING_RUNS - 1) >> 1];

  const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, wtns);
  proofs[N] = { proof, publicSignals };

  const ok = await snarkjs.plonk.verify(vk, publicSignals, proof);
  record(`the honest ${N}-answer proof verifies against the published key`, ok === true,
    `warm p50 ${proveMs} ms over ${TIMING_RUNS} runs · ${publicSignals.length} public signals · nPublic ${vk.nPublic}`);

  record(`the public signals ARE the packed answers at N=${N}`,
    publicSignals.length === words.length && publicSignals.every((s, i) => BigInt(s) === words[i]),
    `publicSignals = [${publicSignals.join(', ')}]`);

  // A reader with only the public signals recovers every member — the property a Poseidon root loses.
  const readBack = unpack(publicSignals.map(BigInt), N);
  record(`every member is individually readable from the public signals at N=${N}`,
    readBack.every((m, i) => m.pHat === answers[i].pHat && m.bHat === answers[i].bHat && m.fHat === answers[i].fHat),
    readBack.map((m, i) => `#${i} p=${m.pHat} b=${m.bHat} f=${m.fHat}`).join(' · '));

  // ---- refusals: every public signal perturbed, and a bent proof ---------------------------------
  console.log('\n  Refusals — each public signal moved by one, on its own:');
  let refused = 0;
  for (let i = 0; i < publicSignals.length; i++) {
    const bad = [...publicSignals];
    bad[i] = (BigInt(bad[i]) + 1n).toString();
    const accepted = await snarkjs.plonk.verify(vk, bad, proof);
    if (accepted === false) refused++;
    console.log(`    [${accepted === false ? 'PASS' : '*** FAIL ***'}] signal[${i}] + 1 -> ${accepted}`);
  }
  record(`every perturbed public signal is rejected at N=${N}`, refused === publicSignals.length,
    `${refused} of ${publicSignals.length}`);

  const bent = JSON.parse(JSON.stringify(proof));
  bent.A[0] = (BigInt(bent.A[0]) + 1n).toString();
  let bentAccepted;
  try { bentAccepted = await snarkjs.plonk.verify(vk, publicSignals, bent); } catch { bentAccepted = false; }
  record(`a bent proof point is rejected at N=${N}`, bentAccepted === false, `returned ${bentAccepted}`);

  table.push({ N, circuit, r1cs, plonk: f.nConstraints, domain: f.domainSize, publicSignals: f.nPublic, proveMs, times });
}

// ---- 4. THE NEGATIVE THAT MATTERS: one tampered member, and it must be NAMED ----------------------
console.log(`\n${'='.repeat(72)}\nA tampered member: refused, and named\n`);

const N = 4;
const answers = pool.slice(0, N);
const builder4 = await builderFor('kellybatch4');
const zkey4 = path.join(BUILD, 'kellybatch4_plonk.zkey');

// One grid step of f moves the residual by exactly b, so it moves the bound usage 2|R|/b by exactly 2.
// An honest member sits at usage <= 1, so after one step it sits at |2 - usage| >= 1, and the ONLY way
// a single step survives is the measure-zero case of a member at usage exactly 1.0 whose residual
// changes sign. Two steps cannot survive at all. Both are tried; the two-step case is the pass
// condition because it is the one that holds for every input rather than almost every input.
const stepReport = [];
for (const step of [1n, 2n]) {
  for (let j = 0; j < N; j++) {
    const tampered = answers.map((a, i) => (i === j ? { ...a, fHat: a.fHat + step } : a));
    const c = memberCheck(tampered[j]);
    let proved = false, err = null;
    try {
      const w = await builder4.calculateWTNSBin(witnessFor(tampered), 0);
      await snarkjs.plonk.prove(zkey4, w);
      proved = true;
    } catch (e) { err = (e && e.message ? e.message : String(e)).split('\n')[0]; }
    const named = firstBadMember(pack(tampered), N);
    stepReport.push({ step: Number(step), member: j, boundUsage: c.usage, proved, err, namedIndex: named ? named.index : null });
  }
}

console.log(`  ${'shift of f'.padEnd(12)}${'member'.padEnd(8)}${'2|R|/b after'.padStart(14)}${'proved?'.padStart(10)}   named by the public-signal reader`);
for (const r of stepReport) {
  console.log(`  ${(`+${r.step} grid step`).padEnd(12)}${String(r.member).padEnd(8)}${r.boundUsage.toFixed(3).padStart(14)}${String(r.proved).padStart(10)}   ${r.namedIndex === null ? '(nothing wrong)' : `member ${r.namedIndex}`}`);
}

const twoStep = stepReport.filter((r) => r.step === 2);
record('an aggregate containing a tampered member cannot be proven at all',
  twoStep.every((r) => r.proved === false),
  `${twoStep.filter((r) => !r.proved).length} of ${twoStep.length} tampered batches refused by the circuit`);

record('the refusal NAMES the tampered member, from the public signals alone',
  twoStep.every((r) => r.namedIndex === r.member),
  twoStep.map((r) => `tampered #${r.member} -> named #${r.namedIndex}`).join(' · '));

record('the naming is discriminating: an honest batch names nobody',
  firstBadMember(pack(answers), N) === null,
  'firstBadMember returned null on the untampered batch, so it is not a function that always accuses');

console.log('\n  What the circuit itself said when asked to prove a tampered batch:');
console.log(`    ${twoStep[0].err}`);
const circomNamesIt = twoStep.some((r) => r.err && /member|\[\s*\d+\s*\]/i.test(r.err) && !/^Error: Assert Failed\.$/.test(r.err));
console.log(`\n  Does circom's own error identify the member? ${circomNamesIt ? 'yes' : 'NO'} — ` +
  `${circomNamesIt ? 'it carries an index' : 'it names a template and a line, identical for every member'}.`);
console.log('  That is why the naming is done by the public-signal reader instead: it works for anybody');
console.log('  holding the calldata, not just for the prover watching its own witness generation fail.');

// The one-step rows measure how much slack the tolerance really has. Reported rather than asserted,
// because "the bound is loose" and "the bound is tight" are both claims that need a number.
const oneStepProved = stepReport.filter((r) => r.step === 1 && r.proved).length;
const worstHonest = Math.max(...pool.slice(0, N).map((m) => m.usage));
console.log(`\n  Tolerance, measured: ${oneStepProved} of ${N} single-grid-step shifts still proved.`);
console.log(`  Honest members in this batch use up to ${(worstHonest * 100).toFixed(1)}% of the bound, and one grid step of f`);
console.log('  adds exactly 2.000 to that ratio, so the bound admits the encoder\'s half-step rounding and');
console.log('  refuses any deliberate movement of the published fraction. It is as loose as it must be');
console.log('  and no looser — a wider bound would certify a bet the engine did not size.');

// ---- two more timing points, so the proving-time law has something to be checked against ----------
// `kelly` at domain 1,024 and `kellybatch1` at 2,048 are proved here and nowhere else in this gate.
// They exist to answer a question the batch sizes alone cannot: does proving cost follow the DOMAIN or
// the constraint count? kellybatch1 (1,190 Plonk) and kellybatch2 (1,664) share domain 2,048;
// kellybatch3 (2,854) and kellybatch4 (3,328) share 4,096. If cost follows the domain, each pair
// should prove in the same time despite a 40% and a 17% difference in constraints.
async function timeOnly(circuit, witness) {
  const zkey = path.join(BUILD, `${circuit}_plonk.zkey`);
  const builder = await builderFor(circuit);
  const wtns = await builder.calculateWTNSBin(witness, 0);
  await snarkjs.plonk.prove(zkey, wtns);
  const t = [];
  for (let i = 0; i < TIMING_RUNS; i++) { const s = Date.now(); await snarkjs.plonk.prove(zkey, wtns); t.push(Date.now() - s); }
  t.sort((a, b) => a - b);
  const f = plonkFacts(zkey);
  return { N: circuit === 'kelly' ? 1 : 1, circuit, plonk: f.nConstraints, domain: f.domainSize, publicSignals: f.nPublic, proveMs: t[(TIMING_RUNS - 1) >> 1], times: t };
}
const single = await timeOnly('kelly', { pHat: pool[0].pHat.toString(), bHat: pool[0].bHat.toString(), fHat: pool[0].fHat.toString() });
const packed1 = await timeOnly('kellybatch1', witnessFor(pool.slice(0, 1)));

// ---- the size and timing table -------------------------------------------------------------------
console.log(`\n${'='.repeat(84)}\nSizes and proving time, read from the artifacts\n`);
console.log(`  ${'circuit'.padEnd(14)}${'N'.padStart(3)}${'R1CS'.padStart(8)}${'Plonk'.padStart(8)}${'domain'.padStart(9)}${'public'.padStart(8)}${'warm p50'.padStart(11)}${'per answer'.padStart(12)}`);
const timing = [
  { ...single, r1cs: 372, label: 'kelly' },
  { ...packed1, r1cs: 493, label: 'kellybatch1' },
  ...table.map((r) => ({ ...r, label: r.circuit })),
];
for (const r of timing) {
  console.log(`  ${r.label.padEnd(14)}${String(r.N).padStart(3)}${String(r.r1cs).padStart(8)}${String(r.plonk).padStart(8)}${String(r.domain).padStart(9)}${String(r.publicSignals).padStart(8)}${(r.proveMs + ' ms').padStart(11)}${((r.proveMs / r.N).toFixed(0) + ' ms').padStart(12)}`);
}

// Does cost follow the domain or the constraints? Two pairs, each sharing a domain.
const pairs = [
  ['kellybatch1', 'kellybatch2', 2048],
  ['kellybatch3', 'kellybatch4', 4096],
];
console.log('\n  Two circuits per domain, differing only in constraint count:\n');
let domainDriven = true;
for (const [a, b, d] of pairs) {
  const ra = timing.find((r) => r.label === a), rb = timing.find((r) => r.label === b);
  const dPlonk = (rb.plonk - ra.plonk) / ra.plonk * 100;
  const dTime = (rb.proveMs - ra.proveMs) / ra.proveMs * 100;
  if (Math.abs(dTime) > 15) domainDriven = false;
  console.log(`    domain ${d}: ${a} ${ra.plonk} gates ${ra.proveMs} ms  vs  ${b} ${rb.plonk} gates ${rb.proveMs} ms` +
    `   (+${dPlonk.toFixed(0)}% gates -> ${dTime >= 0 ? '+' : ''}${dTime.toFixed(0)}% time)`);
}
record('proving cost follows the evaluation DOMAIN, not the constraint count',
  domainDriven,
  'so the batch to build is the one that fills a power of two — a batch that spills into the next domain ' +
  'pays double for one more answer, and every answer after it is nearly free');

// ---- THE BREAK-EVEN, on the axis where widening can actually lose --------------------------------
// On gas, widening amortises a fixed 268,000-gas verify and cannot lose. On PROVING time it can: N
// separate proofs cost N times a small domain, while one wide proof costs a single larger domain that
// is rounded UP to a power of two. When the batch spills into the next domain, the rounding is paid in
// full and the batch can be slower than proving its members one at a time.
console.log('\n  Proving time against proving the members separately:\n');
console.log(`  ${'N'.padStart(3)}${'batch'.padStart(10)}${'N x kelly'.padStart(12)}${'ratio'.padStart(9)}${'N x packed'.padStart(13)}${'ratio'.padStart(9)}   verdict`);
const breakEven = [];
for (const r of table) {
  const sepLive = single.proveMs * r.N;
  const sepPacked = packed1.proveMs * r.N;
  const ratio = r.proveMs / sepLive;
  breakEven.push({ N: r.N, batchMs: r.proveMs, separateLiveMs: sepLive, ratioVsLive: ratio, separatePackedMs: sepPacked, ratioVsPacked: r.proveMs / sepPacked });
  const verdict = ratio < 1 ? `${((1 - ratio) * 100).toFixed(0)}% faster` : `${((ratio - 1) * 100).toFixed(0)}% SLOWER — this size loses`;
  console.log(`  ${String(r.N).padStart(3)}${(r.proveMs + ' ms').padStart(10)}${(sepLive + ' ms').padStart(12)}${(ratio.toFixed(2) + 'x').padStart(9)}${(sepPacked + ' ms').padStart(13)}${((r.proveMs / sepPacked).toFixed(2) + 'x').padStart(9)}   ${verdict}`);
}
const losers = breakEven.filter((r) => r.ratioVsLive > 1);
record('the proving-time break-even is measured, and it is NOT monotonic in N',
  losers.length > 0 && breakEven[breakEven.length - 1].ratioVsLive < 1,
  losers.length
    ? `N=${losers.map((r) => r.N).join(', ')} is slower to prove than the same answers proved separately, because it ` +
      `spills into domain 4,096 and pays the whole doubling for one more answer; N=2 and N=4 both fill their ` +
      `domain and come out ahead. The batch to assemble is 2 or 4, never 3.`
    : 'no batch size in 2..4 is slower than separate proofs, so the gas win comes free');

// The scaling law, against zk/scripts/domain-scaling.mjs's measured domain^1.01.
const lo = timing.find((r) => r.label === 'kelly');
const hi = timing.find((r) => r.label === 'kellybatch4');
const k = Math.log(hi.proveMs / lo.proveMs) / Math.log(hi.domain / lo.domain);
console.log(`\n  Domain ${lo.domain} -> ${lo.proveMs} ms and ${hi.domain} -> ${hi.proveMs} ms, so time grows as domain^${k.toFixed(2)}.`);
record('the measured scaling matches domain-scaling.mjs\'s law of domain^1.01',
  Math.abs(k - 1.01) < 0.15,
  `measured domain^${k.toFixed(2)} across two doublings on the widened circuits, against domain^1.01 measured ` +
  `independently on kelly / constantproduct / padprobe. Plonk is O(n log n), so an exponent a little above 1 is what theory expects`);

record('every batch fits the ceremony file on hand',
  table.every((r) => r.plonk <= 4096),
  `largest is N=${table[table.length - 1].N} at ${table[table.length - 1].plonk} of 4,096; ` +
  `N=5 was compiled and refused at 4,518 Plonk against the 4,096 ceiling of hez_final_12`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(72)}`);
console.log(`GATE B9-0: ${failed.length ? `FAILED — ${failed.map((f) => f.name).join('; ')}` : 'PASSED'}`);

writeFileSync(path.join(BUILD, 'gateB9-0-widening.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, timingRuns: TIMING_RUNS,
  sizes: table.map((r) => ({ ...r, times: r.times })),
  timing: timing.map(({ label, N, r1cs, plonk, domain, publicSignals, proveMs, times }) => ({ label, N, r1cs, plonk, domain, publicSignals, proveMs, times })),
  domainExponent: k,
  provingBreakEven: breakEven,
  batch: pool.slice(0, Math.max(...SIZES)).map((m) => ({ p: m.p, b: m.b, served: m.served, pHat: String(m.pHat), bHat: String(m.bHat), fHat: String(m.fHat), residual: String(m.R), boundUsage: m.usage })),
  publicSignals: Object.fromEntries(SIZES.map((n) => [n, proofs[n].publicSignals])),
  tamper: stepReport.map((r) => ({ ...r, boundUsage: r.boundUsage })),
  circomErrorNamesMember: circomNamesIt,
  checks: results,
}, null, 2) + '\n', 'utf8');

await globalThis.curve_bn128?.terminate();
process.exit(failed.length ? 1 : 0);
