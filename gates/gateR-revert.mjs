// The scripted revert for gate R's coverage half.
//
// "These checks can fail" is a claim about a verifier, and this codebase has been bitten repeatedly by
// verifiers that could not. A gate that is green against the code it is supposed to reject is not
// evidence of anything, and reasoning about it is not enough — so this script executes the argument.
//
// Four independent reverts, because the gate makes four independent claims and one revert would only
// prove one of them. Each removes exactly one thing, requires the gate to go RED, restores the file,
// and requires it to go GREEN again. Red-in-both-states is a broken gate, not a working one, so both
// conditions are checked.
//
//   1. COVERAGE     drop the alternative-form declarations. This is the code as it stood before, and
//                   the eight services with no flat required list must become unnameable again.
//   2. RANKING      rank on the blended score alone. A vocabulary coincidence must be able to outvote
//                   a count of matched requirements again.
//   3. SILENCE      let a redirect fire even when the called service can serve the body. Correct
//                   calls must start growing wrong notices again.
//   4. DRIFT        declare a key no service has. The table must be caught disagreeing with the schema.
//
//   node gates/gateR-revert.mjs        (npm run gate:r-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'util', 'routing.js');
const BACKUP = join(ROOT, 'src', 'util', '.routing.js.revert-backup');

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateR-misroute.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary — the numbers below would be invented');
  }
  // Both runner styles, because which one Node prints depends on whether stdout is a TTY, and a
  // revert script that silently reads no names would report "the wrong check failed" for every
  // revert — a verifier failing in the direction that looks like diligence.
  const failedNames = [...new Set([
    ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
    ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
  ])];
  if (fail > 0 && !failedNames.length) {
    console.error(out);
    throw new Error(`the runner reported ${fail} failure(s) and this script could not name any of them`);
  }
  return { pass, fail, failedNames };
}

// Each revert is a literal string that must be present, so a revert that no longer applies refuses to
// run rather than reporting a meaningless green.
const REVERTS = [
  {
    name: 'COVERAGE — the alternative-form declarations are removed',
    find: 'export function requiredAlternatives(service) {\n  const declared = REQUIRED_ALTERNATIVES[service?.name];\n  if (declared) return declared;',
    replace: 'export function requiredAlternatives(service) {\n  const declared = undefined;   // SCRIPTED REVERT: alternatives ignored, as before the fix\n  if (declared) return declared;',
    expect: /reachable|required:\[\]|unreachable|single out/i,
  },
  {
    name: 'RANKING — candidates are ranked on the blended score alone',
    find: 'function stronger(a, b) {\n  const ca = a.shape === 1, cb = b.shape === 1;\n  if (ca !== cb) return ca;\n  if (ca && a.satisfied !== b.satisfied) return a.satisfied > b.satisfied;\n  return a.score > b.score;\n}',
    replace: 'function stronger(a, b) {\n  return a.score > b.score;   // SCRIPTED REVERT: vocabulary may outvote matched requirements again\n}',
    expect: /outranks|vocabulary/i,
  },
  {
    name: 'SILENCE — a redirect may fire even when this service can serve the body',
    find: 'const shapeWins = best.f.required > 0 && best.f.shape === 1 && here.shape < 1;',
    replace: 'const shapeWins = best.f.required > 0 && best.f.shape === 1;   // SCRIPTED REVERT: fires on correct calls too',
    expect: /silent|correct/i,
  },
  {
    name: 'DRIFT — a declared requirement names a key no service accepts',
    find: "  'risk-attest': anyOf(['items'], ['contentHashes']),",
    replace: "  'risk-attest': anyOf(['items'], ['contentHashes'], ['thisKeyDoesNotExist']),   // SCRIPTED REVERT",
    expect: /real property|drift/i,
  },
];

console.log('GATE R REVERT — proving the routing-coverage gate can fail\n');

const original = readFileSync(TARGET, 'utf8');
for (const r of REVERTS) {
  if (!original.includes(r.find)) {
    console.error(`The code this revert removes is no longer in ${TARGET}:\n  ${r.name}`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const baseline = runGate();
console.log(`  baseline (unmodified)      : ${baseline.pass} pass, ${baseline.fail} fail`);
if (baseline.fail !== 0 || baseline.pass === 0) {
  console.error('  The gate is not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

const results = [];
copyFileSync(TARGET, BACKUP);
try {
  for (const r of REVERTS) {
    writeFileSync(TARGET, original.replace(r.find, r.replace));
    const out = runGate();
    const named = out.failedNames.filter((n) => r.expect.test(n));
    results.push({ ...r, out, named });
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);
    // Restored between reverts so each one is measured on its own rather than on a pile of them.
    writeFileSync(TARGET, original);
  }
} finally {
  // In `finally` because leaving a reverted routing table behind after a crash is far worse than a
  // failed gate: the next run would look green against code nobody meant to ship.
  copyFileSync(BACKUP, TARGET);
  rmSync(BACKUP, { force: true });
  if (readFileSync(TARGET, 'utf8') !== original) {
    console.error('*** RESTORE FAILED — restore src/util/routing.js from git before doing anything else ***');
    process.exit(3);
  }
  console.log('\n  file restored');
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail\n`);

console.log('='.repeat(78));
let ok = true;
for (const r of results) {
  const wentRed = r.out.fail > 0;
  // Not just "something went red": the check that OWNS this claim has to be the one that failed, or
  // the revert proved only that the gate is fragile, not that it measures what it says it measures.
  const rightCheck = r.named.length > 0;
  ok = ok && wentRed && rightCheck;
  console.log(`  [${wentRed && rightCheck ? 'PASS' : '*** FAIL ***'}] ${r.name}`);
  console.log(`           ${wentRed ? `${r.out.fail} check(s) failed` : 'THE GATE STAYED GREEN'}`
    + `${rightCheck ? `, including: ${r.named[0]}` : ', but not the check that owns this claim'}`);
}
const cameBack = restored.fail === 0 && restored.pass === baseline.pass;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and the gate is green again once the file is restored (${restored.pass} pass, ${restored.fail} fail)`);
ok = ok && cameBack;

console.log(`\nGATE R REVERT: ${ok ? 'PASSED — every routing-coverage check is capable of failing' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
