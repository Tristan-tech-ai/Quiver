// The scripted revert for gate S.
//
// "This gate can fail" is a claim about a verifier, and it is the one category of claim that has to
// be executed rather than argued. A gate written after the code it guards will pass; that says
// nothing about whether it would have caught the thing it was written for. So this script puts the
// defect back — three different defects, one at a time — and requires gate S to go RED for each, then
// restores the file and requires it to go GREEN again. Red in both states would mean broken rather
// than strict, so both halves are required.
//
// The three are deliberately not variations on one theme:
//
//   1. THE FEATURE. The `if` that decides whether a symbol-mode answer builds a proof is forced
//      false, which is exactly what the code did before this work: the SNARK and the attestable
//      input on opposite branches, the join on chain 999 correct and unreachable. The POSITIVE half
//      of the gate must die.
//   2. THE DISCRIMINATOR. `inputsWereFetchedLive` is flipped to false — the single machine-readable
//      field that tells a caller the proven numbers were fetched rather than supplied. Everything
//      still works; only the honesty is gone. The NEGATIVE half must die.
//   3. THE OVER-CLAIM. One clause is added to `proves` saying the SNARK also proves the entry price
//      is HyperCore's mark. It does not, and it cannot — the circuit has no mark term. This is the
//      failure the negative half exists for, and it must be caught by the scan rather than by a
//      reviewer noticing a sentence.
//   4. THE DETACHED PROOF. The one line in the /proof/<hash> route that surfaces provenance is
//      removed, so a proof fetched without its answer goes back to being indistinguishable from one
//      whose inputs the caller typed. Nothing about the answer changes; only the third party loses.
//
// It also reads the engine build id before and after. Nothing here touches src/engine/, and the
// published q1-e1fa99d08887d6cc must be the same string on both sides of a script that rewrites files.
//
//   node gates/gateS-revert.mjs        (npm run gate:s-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVICES_JS = join(ROOT, 'src', 'services.js');
const APP_JS = join(ROOT, 'src', 'app.js');

// Each anchor is verified unique before anything is written. The eight-space indent on REVERTS[0] is
// load-bearing: the identical condition appears on the caller-supplied branch at six spaces, and
// reverting THAT one would be reverting the path this work was required not to touch.
const REVERTS = [
  {
    id: 1,
    file: SERVICES_JS,
    what: 'the symbol-mode branch no longer builds a proof at all (the state this work found)',
    from: "        if (wantSnark === true || wantSnark === 'true') {",
    to: '        if (false) {   // SCRIPTED REVERT: symbol mode builds no proof',
    expect: /^S\.[1235679]/,
    expectDesc: 'the positive half (S.1-S.3) and every negative that needs a snark to inspect',
  },
  {
    id: 2,
    file: SERVICES_JS,
    // Both occurrences, deliberately: the flag is published twice — once in the answer and once on
    // the stored proof — and a revert that flipped only one would leave the other telling the truth,
    // which is a weaker defect than the one being modelled.
    what: 'the machine-readable "these inputs were fetched" flag lies, in the answer AND on the proof',
    from: '            inputsWereFetchedLive: true,',
    to: '            inputsWereFetchedLive: false, // SCRIPTED REVERT: the discriminator lies',
    count: 2,
    expect: /^S\.[59]/,
    expectDesc: 'S.5 and S.9, the assertions that the inputs were disclosed as live',
  },
  {
    id: 3,
    file: SERVICES_JS,
    what: 'the snark block claims it also proves the entry price is the venue mark',
    from: 'and it is the whole of what the SNARK says.',
    to: 'and it also proves that the entry price is the live mark HyperCore holds.',
    expect: /^S\.5/,
    expectDesc: 'S.5, the scan that forbids claiming the fetched input is proven',
  },
  {
    id: 4,
    file: APP_JS,
    what: 'a proof fetched without its answer loses the fact that its input was a live read',
    from: '    ...(rec.provenance ? { provenance: rec.provenance } : {}),',
    to: '    // SCRIPTED REVERT: the detached proof carries no provenance',
    expect: /^S\.9/,
    expectDesc: 'S.9, the assertion that /proof/<hash> discloses a live-read input',
  },
];

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateS-live-input-snark.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary. The numbers below would be invented');
  }
  // Deduped: the node runner prints each failure twice, inline and again in its summary block.
  const named = [...new Set([...out.matchAll(/^✖ (S\.\d[^(]*)/gm)].map((m) => m[1].trim()))];
  return { pass, fail, named };
}

console.log('GATE S REVERT: proving the gate is capable of failing\n');

const hashBefore = buildId();
console.log(`  engine build id before : ${hashBefore}`);

const FILES = [...new Set(REVERTS.map((r) => r.file))];
const originals = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
const backupOf = (f) => join(dirname(f), `.${basename(f)}.revert-backup`);
const occurrences = (s, a) => { let c = 0, i = 0; while ((i = s.indexOf(a, i)) >= 0) { c++; i++; } return c; };
for (const rv of REVERTS) {
  const n = occurrences(originals.get(rv.file), rv.from);
  const want = rv.count ?? 1;
  if (n !== want) {
    console.error(`Revert ${rv.id}: its anchor occurs ${n} times in ${rv.file}, not ${want}.`);
    console.error('Refusing to run: a revert that does not apply, or applies where it was not meant to, reports a meaningless result.');
    process.exit(2);
  }
}

const outcomes = [];
for (const f of FILES) copyFileSync(f, backupOf(f));
try {
  for (const rv of REVERTS) {
    console.log(`\n  --- revert ${rv.id} (${basename(rv.file)}): ${rv.what}`);
    // split/join rather than replace(), so a revert declaring two occurrences actually gets both.
    writeFileSync(rv.file, originals.get(rv.file).split(rv.from).join(rv.to));
    const res = runGate();
    console.log(`      gate against reverted code : ${res.pass} pass, ${res.fail} fail`);
    for (const n of res.named) console.log(`      red: ${n}`);
    outcomes.push({ rv, res });
    // Restored between reverts as well as at the end, so revert 2 is measured against otherwise
    // correct code rather than against the wreckage revert 1 left behind.
    copyFileSync(backupOf(rv.file), rv.file);
  }
} finally {
  // Restored in `finally` because leaving a revert applied after a crash would be far worse than a
  // failed gate: the next run would look green against code that permits exactly what S forbids.
  let clean = true;
  for (const f of FILES) {
    copyFileSync(backupOf(f), f);
    rmSync(backupOf(f), { force: true });
    if (readFileSync(f, 'utf8') !== originals.get(f)) { clean = false; console.error(`*** RESTORE FAILED for ${f} — restore it from git before doing anything else ***`); }
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
  console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] revert ${rv.id} makes gate S fail`);
  console.log(`  [${hitTheRightOne ? 'PASS' : '*** FAIL ***'}] and the failure is ${rv.expectDesc}`);
  ok = ok && wentRed && hitTheRightOne;
}
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and the gate PASSES again once every revert is undone (${restored.pass} pass, ${restored.fail} fail)`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
ok = ok && cameBack && hashHeld;

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE S REVERT: ${ok ? 'PASSED, the gate is capable of failing' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
