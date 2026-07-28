// The scripted revert for gate F.
//
// Gate F is green. Green is a claim about a COMPARISON, and a comparison that cannot disagree passes
// every input, so a green result from one means nothing until it has been made to fail on purpose.
//
// This script performs two separate reverts, because gate F guards against two separate defects and a
// script that only exercised one would leave the other unproven.
//
//   REVERT 1  degrade the per-reserve comparison to a total-only comparison, which is the defect
//             PHASE_D_OFFCHAIN_VENUES.md §3.6 warns about. Nothing else changes: the reconstruction
//             still runs, the reserves are still read, the numbers are still right. Only the place
//             the comparison LOOKS changes, from 57 reserves to one sum.
//
//   REVERT 2  keep the comparison per-reserve, but iterate the intersection of the two token sets
//             instead of DefiLlama's own key set. This is the subtler defect and the more dangerous
//             one: it still reads per reserve, it still looks careful, and it silently stops
//             comparing any reserve the reconstruction failed to produce.
//
// Both must turn the gate red, and the gate must come back green when they are undone. A gate that is
// red in both states is broken rather than strict, so 4/4 checks that too.
//
//   node gates/gateF-revert.mjs
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'gates', 'gateF-tvl-reconstruct.mjs');
const BACKUP = join(ROOT, 'gates', '.gateF-tvl-reconstruct.mjs.revert-backup');

const REVERTS = [
  {
    name: 'REVERT 1, per-reserve degraded to total-only (the §3.6 defect)',
    from: "const COMPARISON_MODE = 'per-reserve';",
    to: "const COMPARISON_MODE = 'total-only'; // SCRIPTED REVERT",
    expect: 'the gate must notice that zeroed and deleted reserves stop being caught',
  },
  {
    name: 'REVERT 2, coverage assertion removed, per-reserve becomes intersection-only (the F8 defect)',
    from: `    if (!buckets.has(key)) {
      findings.push({ kind: 'coverage-missing', key, llamaUsd: llamaUsd[key],
        why: 'DefiLlama publishes this reserve and the reconstruction produced nothing for it' });
    }`,
    to: '    if (!buckets.has(key)) { /* SCRIPTED REVERT: coverage assertion removed */ }',
    expect: 'the gate must notice that a deleted reserve worth a fifth of the book stops being caught',
  },
];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', TARGET], { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-3000));
    throw new Error('could not read the runner summary; any numbers printed below would be invented');
  }
  const failed = [...out.matchAll(/^✖ (F\d+[^(,]*)/gm)].map((m) => m[1].trim());
  return { pass, fail, failed: [...new Set(failed)], out };
}

console.log('GATE F REVERT, proving the per-reserve TVL reconstruction gate can fail\n');

const original = readFileSync(TARGET, 'utf8');
for (const r of REVERTS) {
  if (!original.includes(r.from)) {
    console.error(`Could not find the revert target verbatim in gateF-tvl-reconstruct.mjs:\n  ${r.name}`);
    console.error('This script must not silently "succeed" against a file it did not actually change.');
    process.exit(1);
  }
}
copyFileSync(TARGET, BACKUP);

let exitCode = 0;
try {
  console.log(`1/${REVERTS.length + 2}  baseline: the gate as shipped must be GREEN`);
  const before = runGate();
  console.log(`     pass=${before.pass} fail=${before.fail}`);
  if (before.fail !== 0) {
    console.error('     The gate is already red before anything was reverted. Nothing below would mean anything.');
    console.error(`     red: ${before.failed.join(', ')}`);
    process.exit(1);
  }

  let step = 2;
  for (const rev of REVERTS) {
    console.log(`\n${step}/${REVERTS.length + 2}  ${rev.name}`);
    console.log(`     ${rev.expect}`);
    const mutated = original.replace(rev.from, rev.to);
    if (mutated === original || !mutated.includes('SCRIPTED REVERT')) throw new Error('the file was not actually modified; the run below would be vacuous');
    writeFileSync(TARGET, mutated, 'utf8');
    const after = runGate();
    console.log(`     pass=${after.pass} fail=${after.fail}`);
    console.log(`     red tests: ${after.failed.join(' | ') || '(none)'}`);
    if (after.fail === 0) {
      console.error(`\n     FAILED: the gate stayed GREEN with this comparison in place.`);
      console.error('     That means it was never comparing what it claims to compare.');
      exitCode = 1;
    } else {
      console.log(`     as required: ${after.fail} test(s) went red.`);
    }
    writeFileSync(TARGET, original, 'utf8');
    step++;
  }

  console.log(`\n${REVERTS.length + 2}/${REVERTS.length + 2}  restored: the gate must go GREEN again`);
  const restored = runGate();
  console.log(`     pass=${restored.pass} fail=${restored.fail}`);
  if (restored.fail !== 0) {
    console.error('\n     FAILED: the gate did not recover after the file was restored. Red in both states is broken, not strict.');
    console.error(`     red: ${restored.failed.join(', ')}`);
    exitCode = 1;
  }
} finally {
  // Restore unconditionally. A revert script that can leave the repository degraded is a worse hazard
  // than the defect it tests for.
  if (existsSync(BACKUP)) { copyFileSync(BACKUP, TARGET); rmSync(BACKUP); }
}

console.log(`\n=== GATE F REVERT: ${exitCode === 0 ? 'PASS, the gate goes red when the per-reserve comparison is removed and when its coverage assertion is removed, and green when both are restored' : 'FAIL'} ===`);
process.exit(exitCode);
