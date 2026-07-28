// The scripted revert for gate E.
//
// Gate E is green. That is a claim about a VERIFIER, which is exactly the class of claim that has to
// be executed rather than argued: a verifier that cannot fail passes every input, and a green result
// from one means nothing at all.
//
// So this script deletes the single line the entire construction rests on, the check that each proof
// node keccak-hashes to the value its parent commits to, reruns the gate, and REQUIRES it to go red.
// Then it puts the line back and requires green again. Both halves matter: a gate that is red in both
// states is broken, not strict.
//
// Removing that line does not break the code. It leaves a program that still walks a trie, still
// decodes leaves, still returns values, and still looks entirely reasonable. It just no longer checks
// that the nodes belong to the root, which is the whole of what a Merkle proof is. If the gate stays
// green against that, then it is measuring "eth_getProof returned some bytes" and nothing more.
//
//   node gates/gateE-revert.mjs        (npm run gate:e-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'adapters', 'ethproof.js');
const BACKUP = join(ROOT, 'src', 'adapters', '.ethproof.js.revert-backup');

const GUARD = "if (h !== expect) return { ok: false, reason: `node ${used - 1} hashes to ${h.slice(0, 14)}… but its parent commits to ${expect.slice(0, 14)}…, the chain to the root is broken` };";
const NEUTERED = 'void h; // SCRIPTED REVERT: node-hash check removed';

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateE-ethproof-anchor.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-3000));
    throw new Error('could not read the runner summary, any numbers printed below would be invented');
  }
  const failed = [...out.matchAll(/^✖ (E\d+[^(]*)/gm)].map((m) => m[1].trim().split(', ')[0]);
  return { pass, fail, failed: [...new Set(failed)] };
}

console.log('GATE E REVERT, proving the eth_getProof anchor gate can fail\n');

const original = readFileSync(TARGET, 'utf8');
if (!original.includes(GUARD)) {
  console.error('The node-hash guard was not found verbatim in src/adapters/ethproof.js.');
  console.error('This script must not silently "succeed" against a file it did not actually change.');
  process.exit(1);
}
copyFileSync(TARGET, BACKUP);

let exitCode = 0;
try {
  console.log('1/3  baseline: the gate as shipped must be GREEN');
  const before = runGate();
  console.log(`     pass=${before.pass} fail=${before.fail}`);
  if (before.fail !== 0) {
    console.error('     The gate is already red before anything was reverted. Nothing below would mean anything.');
    process.exit(1);
  }

  console.log('\n2/3  reverted: node-hash check removed, the gate must go RED');
  writeFileSync(TARGET, original.replace(GUARD, NEUTERED), 'utf8');
  const reverted = readFileSync(TARGET, 'utf8');
  if (reverted === original || !reverted.includes('SCRIPTED REVERT')) throw new Error('the file was not actually modified, the run below would be vacuous');
  const after = runGate();
  console.log(`     pass=${after.pass} fail=${after.fail}`);
  console.log(`     red tests: ${after.failed.join(', ') || '(none)'}`);
  if (after.fail === 0) {
    console.error('\n     FAILED: the gate stayed GREEN with the Merkle node-hash check deleted.');
    console.error('     That means it never verified a proof, it only checked that bytes came back.');
    exitCode = 1;
  } else {
    console.log(`     as required: ${after.fail} test(s) went red once proofs stopped being checked against their root.`);
  }

  console.log('\n3/3  restored: the gate must go GREEN again');
  writeFileSync(TARGET, original, 'utf8');
  const restored = runGate();
  console.log(`     pass=${restored.pass} fail=${restored.fail}`);
  if (restored.fail !== 0) {
    console.error('\n     FAILED: the gate did not recover after the file was restored, it is red in both states, which makes it broken rather than strict.');
    exitCode = 1;
  }
} finally {
  // Restore unconditionally. A revert script that can leave the repository neutered is a worse
  // hazard than the defect it is testing for.
  if (existsSync(BACKUP)) { copyFileSync(BACKUP, TARGET); rmSync(BACKUP); }
}

console.log(`\n=== GATE E REVERT: ${exitCode === 0 ? 'PASS, the gate goes red when the verification is removed and green when it is restored' : 'FAIL'} ===`);
process.exit(exitCode);
