// The scripted revert for gate D (Hyperliquid).
//
// "This gate can fail" is a claim, and a claim about a verifier is exactly the kind that has to be
// executed rather than reasoned about. A verifier that cannot reject is decoration, and it looks
// identical to a working one for as long as nobody breaks it on purpose.
//
// So this script breaks the mechanism, reruns the gate, requires it to go RED, puts the file back,
// and requires it to go GREEN again. TWO independent reverts, because the gate makes two different
// claims and one revert would only ever prove one of them:
//
//   1. THE BOUND IS ENFORCED. Neuter the comparison so nothing is ever outside the allowance. This
//      is the "verifier that always says yes" — the exact failure mode this project keeps finding,
//      most recently a metric reading 0.0% on all 3,970 samples because its units were wrong.
//
//   2. THE INDEX IS CONFIRMED ON CHAIN. Remove the check that the perpIndex really is the asset we
//      think it is. Without it the gate would happily compare BTC's HTTP price against some other
//      asset's consensus price and report a divergence number computed across two different assets.
//
// Red-when-reverted alone is not sufficient and is not what this script asserts: a gate that is red
// in BOTH states is simply broken and would satisfy a one-sided check. Both halves must hold.
//
//   node gates/gateD-hl-revert.mjs        (npm run gate:d-hl-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'adapters', 'hyperliquid-attest.js');
const BACKUP = join(ROOT, 'src', 'adapters', '.hyperliquid-attest.js.revert-backup');
const GATE = join(ROOT, 'gates', 'gateD-hl-attest.mjs');

const REVERTS = [
  {
    name: 'the bound is enforced',
    breaks: 'compareToBracket() can no longer report DISAGREE — every claim is inside the allowance',
    find: '  const excess = outside > allowance ? outside - allowance : 0;',
    with: '  const excess = 0; // SCRIPTED REVERT: the bound is not enforced',
  },
  {
    name: 'the perpIndex is confirmed on chain',
    breaks: 'readConsensusPerp() no longer checks that the index really is the asset it was asked for',
    find: '  if (info.coin.toUpperCase() !== want) {',
    with: '  if (false) { // SCRIPTED REVERT: index alignment is not confirmed',
  },
];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', GATE], { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-3000));
    throw new Error('could not read the runner summary — the numbers below would be invented');
  }
  // Which tests failed, so a red result is attributable rather than just a count. Deduped: the
  // runner prints each failure once inline and again in its trailing summary.
  const failed = [...new Set([...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]))].filter((n) => n !== 'failing tests');
  return { pass, fail, failed };
}

console.log('GATE D (Hyperliquid) REVERT — proving the input-attestation gate can fail\n');
console.log('This runs the live gate several times; each run sweeps the full 232-perp universe.\n');

const original = readFileSync(TARGET, 'utf8');
for (const r of REVERTS) {
  if (!original.includes(r.find)) {
    console.error(`The code this script reverts is no longer in ${TARGET}:`);
    console.error(`  looking for: ${r.find.trim()}`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

console.log('--- baseline: the gate against unmodified code ---');
const baseline = runGate();
console.log(`  ${baseline.pass} pass, ${baseline.fail} fail\n`);

const results = [];
for (const rev of REVERTS) {
  console.log(`--- REVERT: ${rev.name} ---`);
  console.log(`  ${rev.breaks}`);
  copyFileSync(TARGET, BACKUP);
  let reverted;
  try {
    writeFileSync(TARGET, original.replace(rev.find, rev.with));
    reverted = runGate();
    console.log(`  gate against reverted code : ${reverted.pass} pass, ${reverted.fail} fail`);
    if (reverted.failed.length) console.log(`  went red on: ${reverted.failed.join(' | ')}`);
  } finally {
    // Restored in `finally` because leaving a neutered attestor behind after a crash would be far
    // worse than a failed gate: the next run would look green against a verifier that cannot reject.
    copyFileSync(BACKUP, TARGET);
    rmSync(BACKUP, { force: true });
    if (readFileSync(TARGET, 'utf8') !== original) {
      console.error(`*** RESTORE FAILED — restore ${TARGET} before doing anything else ***`);
      process.exit(3);
    }
    console.log('  restored');
  }
  results.push({ rev, reverted });
  console.log('');
}

console.log('--- restored: the gate against unmodified code again ---');
const restored = runGate();
console.log(`  ${restored.pass} pass, ${restored.fail} fail\n`);

const cameBack = restored.fail === 0 && restored.pass > 0;
const baseOk = baseline.fail === 0 && baseline.pass > 0;

console.log('='.repeat(78));
console.log(`  [${baseOk ? 'PASS' : '*** FAIL ***'}] the gate is GREEN against unmodified code to begin with`);
for (const { rev, reverted } of results) {
  const red = reverted.fail > 0;
  console.log(`  [${red ? 'PASS' : '*** FAIL ***'}] it goes RED when "${rev.name}" is removed (${reverted.fail} failing)`);
}
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and GREEN again once the code is restored`);

const allRed = results.every((r) => r.reverted.fail > 0);
const ok = baseOk && allRed && cameBack;
console.log('='.repeat(78));
console.log(`GATE D REVERT: ${ok ? 'PASSED — the attestation gate is capable of failing, on both claims it makes' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
