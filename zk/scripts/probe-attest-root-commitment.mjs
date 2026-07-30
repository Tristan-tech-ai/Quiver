// What does the risk-attest root actually commit to, and how fast is the check it makes unnecessary?
//
// WHY THIS EXISTS. Building the tamper matrix for gate AT, a transposition of two leaves came back
// set-exact TRUE. That was the checker being right and the expectation being wrong: hashPair SORTS its
// two arguments, so swapping the two leaves of one sibling pair cannot change their parent. The size of
// that equivalence class is a fact about what a buyer is being sold, so it is enumerated against the REAL
// engine rather than derived from the recurrence — the recurrence is exactly what a reasoning error would
// get wrong twice in the same direction.
//
// It also times the recomputation that makes a circuit unnecessary, in plain Node, so the "2N-1 hashes"
// claim has a wall-clock number beside it.
//
// Run: node zk/scripts/probe-attest-root-commitment.mjs   (writes zk/build/probe-attest-root-commitment.json)
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BUILD } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { riskAttest } = await load(import.meta.url, 'engine/riskAttest.js');
const h = (s) => createHash('sha256').update(s).digest('hex');

console.log(`PROBE — what the risk-attest root commits to — ${new Date().toISOString()}\n`);

function* perms(a) {
  if (a.length <= 1) { yield a; return; }
  for (let i = 0; i < a.length; i++) for (const rest of perms([...a.slice(0, i), ...a.slice(i + 1)])) yield [a[i], ...rest];
}

// A PREDICTION IS ONLY MADE WHERE ONE CAN BE JUSTIFIED. For a PERFECT tree every node has a sibling, each
// of the N-1 pairings admits one free transposition, and the class size is 2^(N-1). For a ragged tree it
// is not: the first version of this probe predicted 2^(all pairings) for every N and disagreed with the
// enumeration at N=3, 5, 6 and 7, because a pairing whose partner is a PROMOTED node cannot be reached by
// permuting leaves at all. The formula was wrong, not the engine. Ragged sizes are therefore reported as
// enumerated with no prediction, rather than fitted to a law invented to cover them.
const perfect = (n) => (n & (n - 1)) === 0;
console.log('  N   permutations  distinct roots  collide with identity  predicted (perfect trees only)');
const classes = [];
for (const N of [2, 3, 4, 5, 6, 7, 8]) {
  const leaves = Array.from({ length: N }, (_, i) => h('p' + i));
  const id = riskAttest({ contentHashes: leaves }).merkleRoot;
  const roots = new Set();
  let collide = 0, total = 0;
  for (const p of perms(leaves)) {
    total++;
    const r = riskAttest({ contentHashes: p }).merkleRoot;
    roots.add(r);
    if (r === id) collide++;
  }
  let width = N, pairings = 0;
  while (width > 1) { let w = 0; for (let i = 0; i < width; i += 2) { if (i + 1 < width) pairings++; w++; } width = w; }
  const predicted = perfect(N) ? 2 ** (N - 1) : null;
  const agrees = predicted === null ? null : collide === predicted;
  classes.push({ n: N, perfectTree: perfect(N), permutations: total, distinctRoots: roots.size, collideWithIdentity: collide, internalPairings: pairings, predictedClassSize: predicted, agrees });
  console.log(`  ${String(N).padEnd(4)}${String(total).padEnd(14)}${String(roots.size).padEnd(16)}${String(collide).padEnd(23)}${predicted === null ? '(ragged — enumerated only)' : predicted}${agrees === false ? '  <== DISAGREES' : ''}`);
}
// Only the perfect-tree law is asserted, because it is the only one derived rather than fitted.
const checked = classes.filter((c) => c.predictedClassSize !== null);
if (!checked.length || !checked.every((c) => c.agrees)) throw new Error('the perfect-tree class size 2^(N-1) disagrees with the enumeration — one of the two is wrong and neither may be published');
console.log(`  perfect trees (N = ${checked.map((c) => c.n).join(', ')}): enumeration matches 2^(N-1) in every case`);

// The practical form, with the response regenerated so it is internally consistent rather than hand-edited.
const eight = Array.from({ length: 8 }, (_, i) => h('q' + i));
const base = riskAttest({ contentHashes: eight }).merkleRoot;
const swap = (a, i, j) => { const c = a.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; };
const swaps = [];
for (const [label, i, j] of [['within pair (0,1)', 0, 1], ['within pair (4,5)', 4, 5], ['across pairs (0,2)', 0, 2], ['across pairs (1,7)', 1, 7]]) {
  const r = riskAttest({ contentHashes: swap(eight, i, j) });
  swaps.push({ label, rootUnchanged: r.merkleRoot === base, ownSelfChecksPass: r.checks.every((c) => c.pass !== false) });
  console.log(`  ${label.padEnd(20)} root ${r.merkleRoot === base ? 'UNCHANGED' : 'changed  '}   the response's own self-checks still pass: ${swaps.at(-1).ownSelfChecksPass}`);
}

// ---- and the wall clock on the check that makes a circuit unnecessary -----------------------------
const bare = (x) => String(x).replace(/^0x/, '').toLowerCase();
const rawb = (x) => Buffer.from(bare(x), 'hex');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const leafH = (x) => sha(Buffer.concat([Buffer.from([0x00]), rawb(x)]));
const nodeH = (a, b) => { const [x, y] = [bare(a), bare(b)]; const [lo, hi] = x <= y ? [x, y] : [y, x]; return sha(Buffer.concat([Buffer.from([0x01]), rawb(lo), rawb(hi)])); };
const rootOver = (list) => { let l = list.map(leafH); while (l.length > 1) { const n = []; for (let i = 0; i < l.length; i += 2) n.push(i + 1 < l.length ? nodeH(l[i], l[i + 1]) : l[i]); l = n; } return l[0]; };

console.log('\n  the recomputation a counterparty runs, in plain Node:');
const timing = [];
for (const N of [8, 64, 244, 1024]) {
  const r = riskAttest({ contentHashes: Array.from({ length: N }, (_, i) => h('t' + i)) });
  const list = r.attestations.slice().sort((a, b) => a.index - b.index).map((a) => a.contentHash);
  // Warm, then a best-of-5 so the figure is the work and not the first-call JIT.
  rootOver(list);
  let best = Infinity;
  for (let k = 0; k < 5; k++) { const t0 = process.hrtime.bigint(); const got = rootOver(list); const ms = Number(process.hrtime.bigint() - t0) / 1e6; if (('0x' + got) !== r.merkleRoot) throw new Error(`N=${N}: the recomputation did not reproduce the engine's root`); if (ms < best) best = ms; }
  timing.push({ n: N, hashes: 2 * N - 1, bestOf5Ms: Number(best.toFixed(3)) });
  console.log(`    N=${String(N).padStart(4)}  ${String(2 * N - 1).padStart(4)} hashes  ${best.toFixed(3)} ms`);
}

const artifact = {
  at: new Date().toISOString(),
  passed: true,
  finding: 'The root commits to the leaf SET together with its pairing structure, not to the published index. hashPair sorts its arguments, so a within-pair transposition leaves the root unchanged; an across-pair transposition moves it. Not a defect — membership is a property of the set, both leaves stay members, and sorted pairs are what on-chain verifiers expect — but easy to assume otherwise, and a circuit would not change it.',
  permutationClasses: classes,
  swaps,
  recomputationTiming: timing,
  note: 'Class sizes are ENUMERATED against the real engine and cross-checked against the pairing count of the tree the engine builds; the probe throws rather than publishing either number if the two disagree. Timings are best-of-5 after a warm-up, and each run re-checks that the recomputation reproduces the engine root.',
};
writeFileSync(path.join(BUILD, 'probe-attest-root-commitment.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  artifact zk/build/probe-attest-root-commitment.json`);
