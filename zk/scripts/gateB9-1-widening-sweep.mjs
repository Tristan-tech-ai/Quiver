// GATE B9-1 — does the WIDENED circuit's statement agree with the ENGINE, measured over a sweep?
//
// This is the gate that can actually fail. The Kelly fraction comes from the REAL `sizeGate` engine,
// never from a recomputation of the same formula: a recomputation agrees with itself and proves
// nothing. On the liquidation circuit the equivalent sweep caught an encoder certifying a position
// 1.9e-4 away from the one that had been priced. Reasoning did not find that. Measuring did.
//
// A batch adds a second thing to measure that a single answer does not have: the PACKING. Two answers
// share a 254-bit word, so a field that overflows its lane corrupts its neighbour and produces a
// perfectly well-formed word describing a different bet. So this sweeps two bounds, not one:
//
//   1. the residual bound   2|R_i| <= b_i   for every member, the same statement kelly.circom proves
//   2. the lane widths      p < 2^30, b < 2^45, f < 2^45, which the packing DEPENDS on
//
// and reports how much of each the worst case uses, because a bound nothing comes near is a bound that
// was never tested. Then it proves the tightest batch the sweep found, because a bound that holds in
// arithmetic and fails in the circuit is not a bound.
//
// Run: node zk/scripts/gateB9-1-widening-sweep.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCALE, NB_P, NB_B, NB_F, pack, unpack, witnessFor, memberCheck, residualOf,
  encodeFromEngine, engine, rng, drawBet,
} from './lib/kelly-batch-witness.mjs';

const require = createRequire(import.meta.url);
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZES = [2, 3, 4];
const BATCHES = 1200;          // per size; 1200 * (2+3+4) = 10,800 engine-sized bets

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`\n  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
  return !!pass;
};

const sizeGate = await engine(import.meta.url);
console.log(`GATE B9-1 — widened Kelly circuit against the live engine — ${new Date().toISOString()}\n`);

// ---- the sweep -----------------------------------------------------------------------------------
const rand = rng(20260729);
const per = {};
let worstOverall = null;
let widest = { p: 0n, b: 0n, f: 0n };
let divergedTotal = 0;

for (const N of SIZES) {
  let kept = 0, violations = 0, packFailures = 0, diverged = 0;
  let worst = null;

  for (let k = 0; k < BATCHES; k++) {
    const members = [];
    let bad = false;
    while (members.length < N) {
      const { p, b } = drawBet(rand);
      const e = encodeFromEngine(sizeGate, p, b);
      if (!e) continue;
      if (e.diverged) { diverged++; bad = true; break; }
      members.push(e);
    }
    if (bad) continue;
    kept++;

    // Bound 1: the residual, per member. The batch is only as good as its worst member.
    const usages = members.map((m) => m.usage);
    const batchWorst = Math.max(...usages);
    if (members.some((m) => !m.ok)) violations++;

    // Bound 2 and the batch-specific failure: pack, unpack, and require the answer to survive the
    // round trip AND the residual recomputed from the UNPACKED value to be bit-identical. A lane that
    // overflowed would still round-trip its own bits; what it corrupts is its neighbour.
    const words = pack(members.map(({ pHat, bHat, fHat }) => ({ pHat, bHat, fHat })));
    const back = unpack(words, N);
    const intact = back.every((m, i) =>
      m.pHat === members[i].pHat && m.bHat === members[i].bHat && m.fHat === members[i].fHat &&
      residualOf(m) === members[i].R);
    if (!intact) packFailures++;

    for (const m of members) {
      if (m.pHat > widest.p) widest.p = m.pHat;
      if (m.bHat > widest.b) widest.b = m.bHat;
      if (m.fHat > widest.f) widest.f = m.fHat;
    }

    if (!worst || batchWorst > worst.usage) {
      const j = usages.indexOf(batchWorst);
      worst = { usage: batchWorst, N, memberIndex: j, members: members.map((m) => ({ p: m.p, b: m.b, f: m.f, served: m.served, pHat: m.pHat, bHat: m.bHat, fHat: m.fHat, R: m.R, usage: m.usage })) };
    }
  }

  divergedTotal += diverged;
  per[N] = { kept, violations, packFailures, diverged, worst };
  if (!worstOverall || worst.usage > worstOverall.usage) worstOverall = worst;

  console.log(`  N = ${N}`);
  console.log(`    batches sampled      : ${kept}   (${kept * N} bets, each sized by sizeGate)`);
  console.log(`    bound violations     : ${violations}`);
  console.log(`    packing corruptions  : ${packFailures}`);
  console.log(`    refused as divergent : ${diverged}   (engine's 6dp answer drifted past 5e-7)`);
  console.log(`    tightest batch       : 2|R|/b = ${worst.usage.toFixed(6)} at member ${worst.memberIndex} of ${N}`);
  const w = worst.members[worst.memberIndex];
  console.log(`    at                   : p=${w.p.toPrecision(9)} b=${w.b.toPrecision(9)} f=${w.f.toPrecision(10)}`);
  console.log(`    worst residual       : ${w.R}\n`);
}

const totalBatches = SIZES.reduce((a, n) => a + per[n].kept, 0);
const totalBets = SIZES.reduce((a, n) => a + per[n].kept * n, 0);

record('the residual bound is never violated, at any batch size',
  SIZES.every((n) => per[n].violations === 0),
  `${totalBatches} batches / ${totalBets} engine-sized bets · 0 violations of 2|R| <= b`);

record('the sweep is discriminating, not vacuous',
  worstOverall.usage > 0.5,
  `if every residual were near zero the bound would be untested; the tightest case uses ` +
  `${(worstOverall.usage * 100).toFixed(2)}% of it, so the bound is doing work`);

record('the packing never corrupts a member',
  SIZES.every((n) => per[n].packFailures === 0),
  `${totalBets} answers packed, unpacked and re-residualled with no difference`);

// ---- bound 2: how close do real answers get to the lane widths? ----------------------------------
console.log(`\n  Lane widths, and how much of each the widest observed answer uses:\n`);
console.log(`  ${'field'.padEnd(8)}${'bits'.padStart(6)}${'ceiling'.padStart(18)}${'widest seen'.padStart(16)}${'used'.padStart(10)}`);
const lanes = [
  ['pHat', NB_P, (1n << BigInt(NB_P)) - 1n, widest.p],
  ['bHat', NB_B, (1n << BigInt(NB_B)) - 1n, widest.b],
  ['fHat', NB_F, (1n << BigInt(NB_F)) - 1n, widest.f],
];
for (const [name, bits, ceil, seen] of lanes) {
  console.log(`  ${name.padEnd(8)}${String(bits).padStart(6)}${String(ceil).padStart(18)}${String(seen).padStart(16)}${((Number(seen) / Number(ceil) * 100).toFixed(2) + '%').padStart(10)}`);
}
// Read this row honestly. pHat uses 92.5% of its lane and always will: 30 bits is the SMALLEST width
// that holds 1e9, and a probability is scaled by 1e9, so the lane is sized to the quantity rather than
// oversized against it. The binding constraint on p is not the lane at all — it is `pHat < SCALE`,
// which the circuit enforces separately and which no lane width could express. The two lanes that
// really are headroom are bHat and fHat, and they are three orders of magnitude clear.
record('no real answer overflows its lane, and p stays a proper fraction',
  lanes.every(([, , ceil, seen]) => seen < ceil) && widest.p < SCALE,
  `pHat ${(Number(widest.p) / Number(SCALE) * 100).toFixed(2)}% of SCALE (the constraint that binds it, not the 30-bit lane) · ` +
  `bHat and fHat under ${Math.max(Number(widest.b) / Number((1n << BigInt(NB_B)) - 1n), Number(widest.f) / Number((1n << BigInt(NB_F)) - 1n)) * 100 < 1 ? '1' : '?'}% of a lane whose ceiling is odds of ` +
  `${(Number((1n << BigInt(NB_B)) - 1n) / Number(SCALE)).toFixed(0)}:1, far past any real book`);

// ---- the guard must be able to fire ---------------------------------------------------------------
// A range check that has never rejected anything is indistinguishable from no range check.
let guardFired = null;
try {
  pack([{ pHat: 1n, bHat: 1n, fHat: 1n }, { pHat: 1n, bHat: 1n << BigInt(NB_B), fHat: 1n }]);
} catch (e) { guardFired = e.message; }
record('the packer REFUSES a field that would overflow its lane, and names the member',
  guardFired !== null && /member 1/.test(guardFired) && /bHat/.test(guardFired),
  guardFired ? `threw: ${guardFired}` : 'a bHat of exactly 2^45 was packed without complaint');

// ---- the tightest batch the sweep found must actually prove --------------------------------------
// The bound holding in BigInt arithmetic and the circuit accepting are two different claims.
const N = worstOverall.N;
const circuit = `kellybatch${N}`;
const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
const answers = worstOverall.members.map(({ pHat, bHat, fHat }) => ({ pHat, bHat, fHat }));
const builder = await require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.cjs'))(
  readFileSync(path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`)));

let proved = false, provedErr = null;
try {
  const wtns = await builder.calculateWTNSBin(witnessFor(answers), 0);
  const { proof, publicSignals } = await snarkjs.plonk.prove(path.join(BUILD, `${circuit}_plonk.zkey`), wtns);
  const vk = JSON.parse(readFileSync(path.join(BUILD, `${circuit}_vk.json`), 'utf8'));
  proved = await snarkjs.plonk.verify(vk, publicSignals, proof);
} catch (e) { provedErr = e.message.split('\n')[0]; }

record('the TIGHTEST batch the sweep found still proves and verifies',
  proved === true,
  proved ? `N=${N}, worst member at ${(worstOverall.usage * 100).toFixed(3)}% of the bound, proved and verified`
         : `refused: ${provedErr}`);

// ---- and a batch just past the bound must not ----------------------------------------------------
// Same batch, worst member's f moved one grid step. The circuit must refuse it.
const nudged = answers.map((a, i) => (i === worstOverall.memberIndex ? { ...a, fHat: a.fHat + 1n } : a));
const nudgedUsage = memberCheck(nudged[worstOverall.memberIndex]).usage;
let nudgeProved = false;
try {
  const wtns = await builder.calculateWTNSBin(witnessFor(nudged), 0);
  await snarkjs.plonk.prove(path.join(BUILD, `${circuit}_plonk.zkey`), wtns);
  nudgeProved = true;
} catch { /* refused, as required */ }
record('the same batch one grid step past the bound is refused',
  nudgeProved === false,
  `member ${worstOverall.memberIndex} moved from ${(worstOverall.usage * 100).toFixed(3)}% to ${(nudgedUsage * 100).toFixed(3)}% of the bound`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(72)}`);
console.log(`GATE B9-1: ${failed.length ? `FAILED — ${failed.map((f) => f.name).join('; ')}` : 'PASSED'}`);

writeFileSync(path.join(BUILD, 'gateB9-1-widening-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, batchesPerSize: BATCHES,
  totals: { batches: totalBatches, bets: totalBets, diverged: divergedTotal },
  perSize: Object.fromEntries(SIZES.map((n) => [n, {
    kept: per[n].kept, violations: per[n].violations, packFailures: per[n].packFailures, diverged: per[n].diverged,
    tightestUsage: per[n].worst.usage,
    tightest: (() => { const w = per[n].worst.members[per[n].worst.memberIndex]; return { p: w.p, b: w.b, f: w.f, served: w.served, residual: String(w.R) }; })(),
  }])),
  laneUse: Object.fromEntries(lanes.map(([n, bits, ceil, seen]) => [n, { bits, ceiling: String(ceil), widest: String(seen), used: Number(seen) / Number(ceil) }])),
  tightestOverall: { N, usage: worstOverall.usage, memberIndex: worstOverall.memberIndex, proved },
  checks: results,
}, null, 2) + '\n', 'utf8');

await globalThis.curve_bn128?.terminate();
process.exit(failed.length ? 1 : 0);
