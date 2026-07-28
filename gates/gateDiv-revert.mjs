// The scripted revert for gate DIV.
//
// The requirement being guarded is the least obvious of the four and the easiest to lose in an edit:
// when only one source answers, the disclosure must refuse rather than report. The naive alternative
// is not a crash, it is a zero: a spread over one number is 0.0 bps, which prints as perfect
// agreement between sources that were never compared. That is the shape of defect this project has
// caught by noticing a metric reading exactly 0.0 on every sample.
//
// So the revert installs precisely that defect: one source now returns DISCLOSED with a zero spread
// and a WITHIN_FLOOR verdict. Gate DIV must go RED, and must go GREEN again when it is put back.
//
//   node gates/gateDiv-revert.mjs        (npm run gate:div-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'util', 'divergence.js');
const BACKUP = join(ROOT, 'src', 'util', '.divergence.js.revert-backup');

const GUARD = "  if (readings.length === 1) return { ...base, status: 'REFUSED', reason: REFUSALS.SINGLE_SOURCE, sole: readings[0].source };";
const NEUTERED = "  if (readings.length === 1) return { ...base, status: 'DISCLOSED', spreadBps: 0, independentSpreadBps: 0, verdict: 'WITHIN_FLOOR', sole: readings[0].source }; // SCRIPTED REVERT: one source now reports agreement";

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateDiv-disclosure.mjs')], {
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
  return { pass, fail, named: [...new Set([...out.matchAll(/^✖ (DIV [^(]+)/gm)].map((m) => m[1].trim()))] };
}

console.log('GATE DIV REVERT: proving the divergence gate can fail\n');

const hashBefore = buildId();
console.log(`  engine build id before : ${hashBefore}`);

const original = readFileSync(TARGET, 'utf8');
if (!original.includes(GUARD)) {
  console.error(`The single-source refusal this script reverts is no longer in ${TARGET}.`);
  console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
  process.exit(2);
}
copyFileSync(TARGET, BACKUP);

let reverted;
try {
  writeFileSync(TARGET, original.replace(GUARD, NEUTERED));
  console.log('  feature removed: a single source now reports spreadBps 0 and WITHIN_FLOOR');
  reverted = runGate();
  console.log(`  gate against reverted code : ${reverted.pass} pass, ${reverted.fail} fail`);
  for (const n of reverted.named) console.log(`      red: ${n}`);
} finally {
  copyFileSync(BACKUP, TARGET);
  rmSync(BACKUP, { force: true });
  if (readFileSync(TARGET, 'utf8') !== original) {
    console.error('*** RESTORE FAILED: restore src/util/divergence.js from git before doing anything else ***');
    process.exit(3);
  }
  console.log('  feature restored');
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail`);

const hashAfter = buildId();
console.log(`  engine build id after  : ${hashAfter}\n`);

const wentRed = reverted.fail > 0;
const caughtTheRightThing = reverted.named.some((n) => /one source/i.test(n));
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);

console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] DIV FAILS when the single-source refusal is removed`);
console.log(`  [${caughtTheRightThing ? 'PASS' : '*** FAIL ***'}] and the red test is the single-source one, not an unrelated casualty`);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and PASSES again once it is restored`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
const ok = wentRed && caughtTheRightThing && cameBack && hashHeld;
console.log(`\n${'='.repeat(74)}`);
console.log(`GATE DIV REVERT: ${ok ? 'PASSED, the divergence gate is capable of failing' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
