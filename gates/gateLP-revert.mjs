// The scripted revert for gate LP.
//
// "The bracket guard refuses a real divergence" is a claim about a verifier, and gate LP was written
// after the guard it guards, so of course it passes. That says nothing about whether it would catch
// what it was written for. This script puts a defect back — EIGHT of them, one at a time — requires gate
// LP to go RED for each, then restores every file and requires GREEN again. Red in both states would
// mean broken rather than strict, so both halves are required.
//
// The count in this header read "six" while the list below held seven, and then eight; it is now
// counted from `REVERTS.length` at the bottom of the run rather than written down here, because a
// hand-maintained count in a comment is the smallest possible version of the drift this whole script
// exists to catch.
//
// The eight are deliberately not variations on one theme, and three of them are defects this project has
// actually shipped — reverts 1 and 6 elsewhere, and revert 8 in this very gate.
//
// TWO ARE WITNESS/ENGINE MISMATCHES — the circuit is handed a bracket around the root of a function
// the engine did not bisect:
//
//   1. THE QUADRATURE IS REARRANGED. The running normalisation `sum / w` becomes an accumulation of
//      already-weighted terms. Mathematically identical, numerically different, and it is the
//      `constantproduct` defect verbatim — the one that was equal on paper and wrong by 64 grid steps.
//      It is also the tempting edit, because dividing once at the end looks like the tidier version of
//      dividing at all. LP.1 compiles the engine's own source and demands bit equality, which is the
//      only check that can see this.
//   2. THE CLOSED FORM IS ENCODED. `encodeBracket` takes its endpoint values from exp(-v/8) - 1 instead
//      of from the engine's quadrature. This is the most seductive of the six, because the closed form
//      is EXACT and the quadrature is the approximation — so the substitution feels like an
//      improvement. It is not: the two differ by up to 1.419e-9, which is more than one grid step, and
//      the certificate would then locate the root of a function the engine never evaluated.
//
// FOUR ATTACK THE BOUND OR THE COMPARISON, which is the harder half:
//
//   3. THE CEILING IS WIDENED to the liquidation guard's half-cent. Nothing is mis-certified; the guard
//      simply stops refusing the small breakevens where sqrt(v/T)'s unbounded slope at zero means the
//      grid cannot pin the answer to the digit it is published at. This is the half-cent that "stopped
//      being a guard below a dollar", reused on a quantity a thousand times finer.
//   4. THE BOUND BECOMES A DERIVATIVE. The corner maximum becomes a first-order term. sigma(v) is
//      concave, so the linearisation is not an upper bound — the same substitution that left
//      exec-verify's worst honest case at 99.08% of a number that did not bound it.
//   5. THE FACTOR OF TWO COMES BACK. The bound measures the FULL bracket width instead of the
//      excursion between a point near the midpoint and a point anywhere in the bracket. This was the
//      shipped version for one measurement pass: it left the worst honest case at 49.8% of the bound,
//      which looked like headroom and was arithmetic. A bound nothing can approach cannot detect
//      anything, and LP.6 is the only thing that notices.
//   6. THE COMPARISON GOES BACK ON THE ROUNDED FIGURE. The guard compares the certified volatility to
//      the SERVED five-decimal figure instead of to the engine's unrounded bisection. This refused 28
//      of 770 honest answers on the first measurement pass of this work, all of them sitting on a
//      5th-decimal boundary — the same defect that refused RUNE a liquidation proof for landing a hair
//      the wrong side of a half-cent.
//
// ONE IS A COURTESY RATHER THAN A GUARD:
//
//   7. THE SEARCH STOPS TARGETING THE SERVED DIGIT. Nothing becomes untrue — a certified 0.18731409
//      against a served 0.18732 is a correct certificate either way — but 14 of 378 proved answers then
//      publish a public signal that reads as a different number from the response beside it.
//
// AND ONE IS IN THE GATE'S OWN ARITHMETIC, which is the case this script did not cover until 30 July:
//
//   8. THE DROPPED GAUSSIAN WEIGHT GOES BACK TO A DIVERGENT SERIES. LP.3 computed 2*Q(6) from the
//      4-term ASYMPTOTIC Mills expansion and got 1.9730731536709662e-9 against a true
//      1.9731752900753966e-9 — off by 5.176e-5 relative, wrong in the 5th digit. The header of
//      src/util/lpBracket.js had ALREADY recorded that correction; the gate that makes the header
//      reproducible never received it. It survived because the only published consequence, the 71.92%
//      ratio in the doesNotProve string, is identical either way (71.924377% vs 71.920654%). A
//      verifier's own constants need a revert as much as the code it verifies, and this is the first
//      one here that targets the gate file itself.
//
// It also reads the engine build id before and after. Nothing here touches src/engine/, and the
// published q1-e1fa99d08887d6cc must be the same string on both sides of a script that rewrites files.
//
//   node gates/gateLP-revert.mjs
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const LPB = join(ROOT, 'src', 'util', 'lpBracket.js');
const SNARK = join(ROOT, 'src', 'util', 'snark.js');
// The gate itself is a revert target for revert 8, because the defect that revert puts back was a
// defect IN THE GATE — a constant the gate computed one way while the code it guards documented
// another. A verifier's own arithmetic needs a revert as much as the thing it verifies.
const GATE = join(ROOT, 'gates', 'gateLP-bracket-snark.mjs');

const REVERTS = [
  {
    id: 1,
    file: LPB,
    what: 'the quadrature is rearranged into a mathematically equal, numerically different form',
    from: '    sum += pdf * ilOfRatio(r);\n    w += pdf;\n  }\n  return sum / w;',
    to: '    w += pdf;\n    sum += (pdf * ilOfRatio(r));\n  }\n  return sum * (1 / w);   // SCRIPTED REVERT: rearranged normalisation',
    expect: /^LP\.1/,
    expectDesc: 'LP.1, which compiles the engine\'s own source line and demands bit equality',
  },
  {
    id: 2,
    file: LPB,
    what: 'the ENDPOINT VALUES are taken from the exact closed form instead of the engine\'s quadrature',
    from: '  const eLo = engineExpectedIl(lo) + 1;\n  const eHi = engineExpectedIl(hi) + 1;',
    to: '  const eLo = closedFormExpectedIl(lo) + 1;\n  const eHi = closedFormExpectedIl(hi) + 1;   // SCRIPTED REVERT: certifies a bracket around the closed form\'s root',
    // MEASURED, and the first draft of this file predicted it wrong: the gate stayed GREEN through all
    // twelve tests. The substitution moves only the two values the circuit does not prove, by about one
    // grid step, while the straddle has 104 and 1,772 grid steps of margin — so nothing about the
    // certified volatility changes and no bound notices. That is a real fact about the coverage of this
    // certificate, and it is why LP.4b now exists: it recomputes the endpoint integers from the engine's
    // own compiled source and counts how many of them the closed form would encode differently (172 of
    // 446 on the swept brackets), so the substitution has somewhere to be caught.
    expect: /^LP\.4b/,
    expectDesc: 'LP.4b, which requires the encoded endpoints to be the engine\'s quadrature on the grid',
  },
  {
    id: 3,
    file: LPB,
    what: 'the ceiling is widened to the liquidation guard\'s half-cent — a thousand times too coarse',
    from: 'export const LP_DISPLAY_HALF_UNIT = 0.5e-5;',
    to: 'export const LP_DISPLAY_HALF_UNIT = 0.005;   // SCRIPTED REVERT: the half-cent, on a quantity published to five decimals',
    expect: /^LP\.(2|6|7)/,
    expectDesc: 'LP.2, which pins the constant to the engine\'s own rounding, and LP.6/LP.7, where the ceiling stops being reached',
  },
  {
    id: 4,
    file: LPB,
    what: 'the encoding bound becomes a first-order derivative instead of the corner maximum',
    from: '  let bracketTerm = 0;\n  for (const x of [m - 1 / S, m + 1 / S]) for (const y of [lo, hi]) {\n    const d = Math.abs(sigOf(x) - sigOf(y));\n    if (d > bracketTerm) bracketTerm = d;\n  }',
    to: '  const bracketTerm = ((hi - lo) / 2 + 1 / S) / (2 * Math.sqrt(m * T));   // SCRIPTED REVERT: linearised, and therefore not an upper bound',
    expect: /^LP\.2b/,
    expectDesc: 'LP.2b, which recomputes the corner maximum independently and demands bit equality',
  },
  {
    id: 5,
    file: LPB,
    what: 'the bound measures the FULL bracket width — the factor of two that looked like headroom',
    from: '  for (const x of [m - 1 / S, m + 1 / S]) for (const y of [lo, hi]) {',
    to: '  for (const x of [lo - 1 / S, hi + 1 / S]) for (const y of [lo, hi]) {   // SCRIPTED REVERT: the whole width, double-counting',
    expect: /^LP\.6/,
    expectDesc: 'LP.6, which requires the worst honest case to use a real part of the bound',
  },
  {
    id: 6,
    file: SNARK,
    what: 'the guard compares against the SERVED rounded figure instead of the engine\'s unrounded bisection',
    from: '  if (!(w.gapToEngine <= w.sigmaBound)) {',
    to: '  if (!(lpDisplayRound(w.certifiedSigma) === w.servedSigma)) {   // SCRIPTED REVERT: an equality on an already-rounded number',
    // ALSO MEASURED WRONG THE FIRST TIME, and for the opposite reason to revert 2: the check was there
    // and the SWEEP was the wrong sweep. The bracket search targets the served digit and reaches it on
    // every row of LP.6's horizon grid, so an equality on the rounded figure never fired. The cases that
    // cannot reach the digit are found by sweeping fee levels finely instead — 7 of 784, each of them
    // well inside the bound — and LP.6B is that arm.
    expect: /^LP\.6/,
    expectDesc: 'LP.6, whose arm B finds the honest answers a rounded equality would refuse',
  },
  {
    id: 7,
    file: LPB,
    what: 'the search stops caring whether the certified volatility DISPLAYS as the served figure',
    from: '  const done = (c) => c.sigmaBound <= ceiling / safety\n    && (targetSigma == null || lpDisplayRound(c.certifiedSigma) === targetSigma);',
    to: '  const done = (c) => c.sigmaBound <= ceiling / safety;   // SCRIPTED REVERT: the second stopping condition is dropped',
    // This one is a courtesy rather than a guard — a certified 0.18731409 against a served 0.18732 is a
    // correct certificate either way — so nothing becomes untrue. What becomes true is that 14 of 378
    // proved answers publish a public signal that looks like a different number from the response beside
    // it, and a reader should not have to reconcile that when one more halving removes it.
    expect: /^LP\.6/,
    expectDesc: 'LP.6, which requires every proved answer to certify a volatility that displays as the served one',
  },
  {
    id: 8,
    file: GATE,
    what: 'the dropped Gaussian weight goes back to the 4-term ASYMPTOTIC Mills series, wrong in the 5th digit',
    from: '  const droppedWeight = 2 * millsCF(6);',
    to: '  const droppedWeight = 2 * phi(6) * (1 / 6 - 1 / 6 ** 3 + 3 / 6 ** 5 - 15 / 6 ** 7);   // SCRIPTED REVERT: a divergent series truncated at four terms',
    // THIS ONE IS A DEFECT THIS GATE ACTUALLY SHIPPED, found on 30 July. The header of lpBracket.js said
    // the constant had been "recomputed two independent ways" to 1.9731752900753966e-9; this gate — the
    // only thing that makes that sentence reproducible — went on computing 1.9730731536709662e-9 from a
    // divergent asymptotic expansion, off by 5.176e-5 relative. It survived because the ratio the
    // doesNotProve string publishes is 71.92% either way (71.924377% vs 71.920654%), so no other number
    // in the repository moved. That is the whole hazard: prose and code drifting apart on a constant
    // whose published consequence is insensitive to the drift. LP.3 now pins the value itself and
    // cross-checks it against an independent Simpson tail, so this revert has somewhere to be caught.
    expect: /^LP\.3/,
    expectDesc: 'LP.3, which pins the weight to the figure the lpBracket.js header states and cross-checks it a second way',
  },
];

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateLP-bracket-snark.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-4000));
    throw new Error('could not read the runner summary. The numbers below would be invented');
  }
  const named = [...new Set([...out.matchAll(/^✖ (LP\.\d[a-z]?[^(]*)/gm)].map((m) => m[1].trim()))];
  return { pass, fail, named };
}

console.log(`GATE LP REVERT: proving the bracket guard can still say no — ${REVERTS.length} reverts, ${new Set(REVERTS.map((r) => r.file)).size} files\n`);

const hashBefore = buildId();
console.log(`  engine build id before : ${hashBefore}`);

const FILES = [...new Set(REVERTS.map((r) => r.file))];
const originals = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
const backupOf = (f) => join(dirname(f), `.${basename(f)}.lprevert-backup`);
const occurrences = (s, a) => { let c = 0, i = 0; while ((i = s.indexOf(a, i)) >= 0) { c++; i++; } return c; };
// A revert whose anchor does not appear, or appears twice, reports a meaningless result — so this is
// checked for EVERY revert before ANY of them runs, rather than discovered halfway through.
for (const rv of REVERTS) {
  const n = occurrences(originals.get(rv.file), rv.from);
  if (n !== 1) {
    console.error(`Revert ${rv.id}: its anchor occurs ${n} times in ${basename(rv.file)}, not 1.`);
    console.error(`  anchor: ${JSON.stringify(rv.from.slice(0, 160))}`);
    console.error('Refusing to run: a revert that does not apply, or applies where it was not meant to, reports nothing.');
    process.exit(2);
  }
}

const outcomes = [];
for (const f of FILES) copyFileSync(f, backupOf(f));
try {
  for (const rv of REVERTS) {
    console.log(`\n  --- revert ${rv.id} (${basename(rv.file)}): ${rv.what}`);
    writeFileSync(rv.file, originals.get(rv.file).split(rv.from).join(rv.to));
    const res = runGate();
    console.log(`      gate against reverted code : ${res.pass} pass, ${res.fail} fail`);
    for (const n of res.named) console.log(`      red: ${n}`);
    outcomes.push({ rv, res });
    copyFileSync(backupOf(rv.file), rv.file);
  }
} finally {
  // Restored in `finally` because leaving a revert applied after a crash would be far worse than a
  // failed gate: the next run would look green against code that certifies a breakeven nobody asked
  // about.
  let clean = true;
  for (const f of FILES) {
    copyFileSync(backupOf(f), f);
    rmSync(backupOf(f), { force: true });
    if (readFileSync(f, 'utf8') !== originals.get(f)) { clean = false; console.error(`*** RESTORE FAILED for ${f} — restore it before doing anything else ***`); }
  }
  if (!clean) process.exit(3);
  console.log(`\n  ${FILES.length} files restored`);
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail`);

const hashAfter = buildId();
console.log(`  engine build id after  : ${hashAfter}\n`);

let ok = true;
for (const { rv, res } of outcomes) {
  const wentRed = res.fail > 0;
  const hitTheRightOne = res.named.some((n) => rv.expect.test(n));
  console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] revert ${rv.id} makes gate LP fail`);
  console.log(`  [${hitTheRightOne ? 'PASS' : '*** FAIL ***'}] and the failure is ${rv.expectDesc}`);
  ok = ok && wentRed && hitTheRightOne;
}
// Every declared revert must have actually RUN. A loop that broke early would otherwise report
// "PASSED" over a subset, which is the "never cap a search and read absence as proof" failure.
const allRan = outcomes.length === REVERTS.length;
console.log(`  [${allRan ? 'PASS' : '*** FAIL ***'}] all ${REVERTS.length} declared reverts ran (${outcomes.length} outcomes recorded)`);
ok = ok && allRan;

const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and the gate PASSES again once every revert is undone (${restored.pass} pass, ${restored.fail} fail)`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
ok = ok && cameBack && hashHeld;

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE LP REVERT: ${ok ? 'PASSED' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
