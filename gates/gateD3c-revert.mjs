// The scripted revert for gate D3c.
//
// "This gate can fail" is a claim about a verifier, and claims about verifiers have to be EXECUTED
// rather than reasoned about. This project has been bitten here before: an earlier draft of
// dydx-attest.js shipped a signature checker that verified NOTHING and looked entirely correct while
// doing it. Nothing caught it, because nothing tried to make it fail.
//
// The exposure here is worse than a wrong number. `TRUST.CHECKPOINTED` is the strongest claim the
// module makes — "another chain's validators independently committed to this app_hash" — so a
// checkpoint check that cannot say no does not produce a bad measurement, it produces a false
// security claim. This script removes one load-bearing clause at a time, reruns the gate, and requires
// it to go RED each time, then restores every file and requires GREEN.
//
// Seven defects are injected across TWO files, because a gate can easily be sensitive to one clause
// and blind to the rest:
//
//   1. the app_hash equality check        — any app_hash matches any checkpoint
//   2. the checkpoint height equality     — a checkpoint for another height is accepted
//   3. the counterparty operator floor    — one provider is enough again
//   4. the expiry refusal at the BIND step
//   5. the expiry refusal at the READ step
//   6. the byte-identity re-assertion     — a disputed value gets labelled
//   7. the verification call in openAnchor — the LABEL is issued with no evidence at all
//
//   node gates/gateD3c-revert.mjs        (npm run gate:d3c-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CHECKPOINT = join(ROOT, 'src', 'adapters', 'ibc-checkpoint.js');
const ATTEST = join(ROOT, 'src', 'adapters', 'dydx-attest.js');
const BACKUP = (f) => `${f}.d3c-revert-backup`;

// [name, file, exact source to find, replacement]. `find` must be present or the script refuses to
// run at all: a revert that silently does not apply reports a meaningless green.
const MUTATIONS = [
  [
    'the app_hash equality check', CHECKPOINT,
    '  if (checkpoint.appHash !== anchorApp) {',
    '  if (false) { // SCRIPTED REVERT: any app_hash matches any checkpoint',
  ],
  [
    'the checkpoint height equality check', CHECKPOINT,
    '  if (checkpoint.dydxHeight !== anchor.headerHeight) {',
    '  if (false) { // SCRIPTED REVERT: a checkpoint for another height is close enough',
  ],
  [
    'the counterparty operator floor', CHECKPOINT,
    '  if (operators.length < minOperators) {',
    '  if (false) { // SCRIPTED REVERT: one provider is a quorum again',
  ],
  [
    'the expiry refusal at the BIND step', CHECKPOINT,
    '  if (checkpoint.expired) {',
    '  if (false) { // SCRIPTED REVERT: expired checkpoints label fine',
  ],
  [
    'the expiry refusal at the READ step', CHECKPOINT,
    '  if (expired && !allowExpired) {',
    '  if (false) { // SCRIPTED REVERT: hand out expired checkpoints unasked',
  ],
  [
    'the byte-identity re-assertion at the bind step', CHECKPOINT,
    '  if (!checkpoint.byteIdentical) {',
    '  if (false) { // SCRIPTED REVERT: label a disputed value',
  ],
  [
    'the checkpoint verification call in openAnchor (label with no evidence)', ATTEST,
    '    anchor.checkpoint = ibc.verifyAnchorCheckpoint(anchor, checkpointRead);',
    '    // SCRIPTED REVERT: issue the label without verifying anything',
  ],
];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateD3c-dydx-checkpoint.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-2500));
    throw new Error('could not read the runner summary — the numbers below would be invented');
  }
  return { pass, fail };
}

console.log('GATE D3c REVERT — proving the dYdX CHECKPOINT gate can fail\n');

const FILES = [...new Set(MUTATIONS.map(([, f]) => f))];
const original = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, 'utf8')]));

for (const [name, file, find] of MUTATIONS) {
  if (!original[file].includes(find)) {
    console.error(`Cannot apply "${name}": the code it reverts is no longer in ${file}.`);
    console.error('Refusing to run rather than reporting a revert that did not happen.');
    process.exit(2);
  }
}
for (const f of FILES) copyFileSync(f, BACKUP(f));

const results = [];
try {
  for (const [name, file, find, replace] of MUTATIONS) {
    writeFileSync(file, original[file].replace(find, replace));
    console.log(`  removed: ${name}`);
    const r = runGate();
    console.log(`    gate against reverted code : ${r.pass} pass, ${r.fail} fail`);
    results.push({ name, ...r });
    writeFileSync(file, original[file]);
  }
} finally {
  // Restored in `finally`: leaving a neutered checkpoint verifier behind after a crash is far worse
  // than a failed revert, because the next run would look green against code that issues the strongest
  // label in the module without checking anything.
  let restoreOk = true;
  for (const f of FILES) {
    if (existsSync(BACKUP(f))) copyFileSync(BACKUP(f), f);
    rmSync(BACKUP(f), { force: true });
    if (readFileSync(f, 'utf8') !== original[f]) { restoreOk = false; console.error(`*** RESTORE FAILED for ${f} ***`); }
  }
  if (!restoreOk) {
    console.error('*** restore src/adapters/ibc-checkpoint.js and src/adapters/dydx-attest.js before doing anything else ***');
    process.exit(3);
  }
  console.log('  all mutations restored');
}

console.log('\n  re-running the gate against restored code...');
const restored = runGate();
console.log(`    gate against restored code : ${restored.pass} pass, ${restored.fail} fail\n`);

let ok = true;
for (const r of results) {
  const red = r.fail > 0;
  ok &&= red;
  console.log(`  [${red ? 'PASS' : '*** FAIL ***'}] gate goes RED without ${r.name}`);
}
// Red-when-reverted alone is not enough: a gate that is red in both states is simply broken and would
// satisfy a one-sided check.
const cameBack = restored.fail === 0 && restored.pass > 0;
ok &&= cameBack;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and GREEN again once every clause is restored`);

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE D3c REVERT: ${ok ? 'PASSED — the checkpoint gate is capable of failing' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
