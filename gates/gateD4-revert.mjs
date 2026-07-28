// The scripted revert for gate D4.
//
// "This gate can fail" is a claim about a verifier, and the one category of claim that has to be
// executed rather than argued. So this script removes the feature D4 guards: the claim scan inside
// `attachSibling` becomes a no-op, which is exactly what the code did before this work, and every
// attestation field then sails through onto a Deribit answer. D4 must go RED. Then the file is put
// back and D4 must go GREEN.
//
// Red-when-reverted alone would not be enough. A gate that is red in both states is broken rather
// than strict, and would satisfy a one-sided check, so both halves are required.
//
// It also reads the engine build id before and after. Nothing here touches src/engine/, and the
// published q1-e1fa99d08887d6cc must be the same string on both sides of a script that rewrites files.
//
//   node gates/gateD4-revert.mjs        (npm run gate:d4-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'util', 'inputClaims.js');
const BACKUP = join(ROOT, 'src', 'util', '.inputClaims.js.revert-backup');

const GUARD = 'const hits = scanClaims({ [key]: value });';
const NEUTERED = 'const hits = []; // SCRIPTED REVERT: the claim scan is disabled';

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateD4-no-false-attestation.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary. The numbers below would be invented');
  }
  // Deduped: the node runner prints each failure twice, inline and again in its summary block.
  const named = [...new Set([...out.matchAll(/^✖ (D4\.\d[^(]+)/gm)].map((m) => m[1].trim()))];
  return { pass, fail, named };
}

console.log('GATE D4 REVERT: proving the negative gate can fail\n');

const hashBefore = buildId();
console.log(`  engine build id before : ${hashBefore}`);

const original = readFileSync(TARGET, 'utf8');
if (!original.includes(GUARD)) {
  console.error(`The guard this script reverts is no longer in ${TARGET}.`);
  console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
  process.exit(2);
}
copyFileSync(TARGET, BACKUP);

let reverted;
try {
  writeFileSync(TARGET, original.replace(GUARD, NEUTERED));
  console.log('  feature removed: attachSibling no longer scans for input-attestation claims');
  reverted = runGate();
  console.log(`  gate against reverted code : ${reverted.pass} pass, ${reverted.fail} fail`);
  for (const n of reverted.named) console.log(`      red: ${n}`);
} finally {
  // Restored in `finally` because leaving the scan disabled after a crash would be far worse than a
  // failed gate: the next run would look green against code that permits exactly what D4 forbids.
  copyFileSync(BACKUP, TARGET);
  rmSync(BACKUP, { force: true });
  if (readFileSync(TARGET, 'utf8') !== original) {
    console.error('*** RESTORE FAILED: restore src/util/inputClaims.js from git before doing anything else ***');
    process.exit(3);
  }
  console.log('  feature restored');
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail`);

const hashAfter = buildId();
console.log(`  engine build id after  : ${hashAfter}\n`);

const wentRed = reverted.fail > 0;
const caughtTheNamedEdit = reverted.named.some((n) => /Deribit/.test(n));
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);

console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] D4 FAILS when the claim scan is removed`);
console.log(`  [${caughtTheNamedEdit ? 'PASS' : '*** FAIL ***'}] and the specific failure is the one §6 names: an attestation field on a Deribit answer`);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and PASSES again once it is restored`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
const ok = wentRed && caughtTheNamedEdit && cameBack && hashHeld;
console.log(`\n${'='.repeat(74)}`);
console.log(`GATE D4 REVERT: ${ok ? 'PASSED, the negative gate is capable of failing' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
