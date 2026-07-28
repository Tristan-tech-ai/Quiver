// The scripted revert for gate A.
//
// "This test can fail" is a claim, and a claim about a verifier is exactly the kind that has to be
// executed rather than reasoned about. So this script removes the feature — durable writes become a
// no-op, which is precisely what the code did before Phase A — reruns the gate, and requires it to go
// RED. Then it puts the file back and requires it to go GREEN again.
//
// If the gate passes against the reverted code, the gate is measuring something other than durability
// and its green result means nothing. That is the failure this script exists to catch.
//
//   node gates/gateA-revert.mjs        (npm run gate:a-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'util', 'proofStore.js');
const BACKUP = join(ROOT, 'src', 'util', '.proofStore.js.revert-backup');

const GUARD = "if (!durable() || !wellFormed(contentHash) || !rec || rec.status !== 'ready') return false;";
const NEUTERED = 'return false; // SCRIPTED REVERT: durability removed';

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateA-proof-durability.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary — the numbers below would be invented');
  }
  return { pass, fail };
}

console.log('GATE A REVERT — proving the durability gate can fail\n');

const original = readFileSync(TARGET, 'utf8');
if (!original.includes(GUARD)) {
  console.error(`The guard this script reverts is no longer in ${TARGET}.`);
  console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
  process.exit(2);
}
copyFileSync(TARGET, BACKUP);

let reverted, restored;
try {
  writeFileSync(TARGET, original.replace(GUARD, NEUTERED));
  console.log('  feature removed: proofStore.write() is a no-op');
  reverted = runGate();
  console.log(`  gate against reverted code : ${reverted.pass} pass, ${reverted.fail} fail`);
} finally {
  // Restored in `finally` because leaving a neutered store behind after a crash would be a far worse
  // outcome than a failed gate: the next run would look green against broken code.
  copyFileSync(BACKUP, TARGET);
  rmSync(BACKUP, { force: true });
  if (readFileSync(TARGET, 'utf8') !== original) {
    console.error('*** RESTORE FAILED — restore src/util/proofStore.js from git before doing anything else ***');
    process.exit(3);
  }
  console.log('  feature restored');
}

restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail\n`);

// Two conditions, and both have to hold. Red-when-reverted alone is not enough: a gate that is red in
// both states is simply broken, and would satisfy a one-sided check.
const wentRed = reverted.fail > 0;
const cameBack = restored.fail === 0 && restored.pass > 0;

console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] the gate FAILS when durability is removed`);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and PASSES again once it is restored`);
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE A REVERT: ${wentRed && cameBack ? 'PASSED — the durability gate is capable of failing' : 'FAILED'}`);
process.exit(wentRed && cameBack ? 0 : 1);
