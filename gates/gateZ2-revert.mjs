// GATE Z2 REVERT — prove gate Z2 can go red, once for each defect it was written for.
//
//   npm run gate:z2-revert
//
// Five modes, and none of them is synthetic. Each one puts back a mistake this document actually
// shipped on 30 July 2026:
//
//   row-count            publish one fewer passing row than the artifact holds. The document said
//                        "61 assertions, 61 pass" while adversary-repro.json held 62 — 55 without a
//                        local 2^13 plus SEVEN section-4 rows, counted as six because the seventh was
//                        tallied under "9 byte-identity pins" and nowhere else.
//   self-include         put the write-up back into the set it measures. This is the 145-byte defect
//                        exactly: the size table's own row, its text subtotal and its grand total were
//                        each low by 145 bytes, which is the length of the edit that published them.
//   stale-row            read the table off 5ca5137 — the tree as it was when the broken table was
//                        published — instead of HEAD. The shipped `zk/scripts/adversary/` row said
//                        286,480 bytes, a number from before the last edits of the commit that
//                        published it, and one the table's own total (which used 290,429) contradicted.
//   derived-denominator  divide the growth by the repository instead of by the binaries left out. The
//                        shipped sentence read "the repository grows by 0.706%"; 0.706% is the
//                        committed bytes over 726.8 MiB of DISCARDED artifacts. Against the
//                        repository the same numerator is 2.70%, near four times larger.
//   mirror-drop          drop one measured file from the dev tree. Twice in this project a module was
//                        written into the dev tree, its importer committed, and the module never
//                        copied — once leaving a HEAD that could not start.
//
// If any of the five exits 0, the corresponding assertion in gate Z2 is decoration.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'gateZ2-repro-figures.mjs');
const MODES = ['row-count', 'self-include', 'stale-row', 'derived-denominator', 'mirror-drop'];

const run = (mode) => {
  const env = { ...process.env };
  if (mode) env.FIG_REVERT = mode; else delete env.FIG_REVERT;
  const r = spawnSync(process.execPath, [GATE], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  const out = `${(r.stdout || '').toString()}${(r.stderr || '').toString()}`;
  return { status: r.status, out, red: (out.match(/\*\*\* FAIL \*\*\*/g) || []).length };
};

// THE BASELINE, FIRST. Every mode below reports "the gate went red", and that sentence is worthless if
// the gate was already red — a revert harness run against a broken gate reports five successes and has
// demonstrated nothing. So the unmodified gate must be GREEN before anything is broken, and if it is
// not, this exits without claiming anything.
const base = run('');
console.log(`  ${'(unmodified)'.padEnd(20)}exit ${String(base.status).padStart(3)} · ${String(base.red).padStart(2)} red rows · `
  + (base.status === 0 && base.red === 0 ? 'green, so the reverts below mean something' : '*** NOT GREEN — nothing below can be concluded ***'));
if (base.status !== 0 || base.red !== 0) {
  console.log(base.out.split('\n').slice(-12).map((l) => `      ${l}`).join('\n'));
  console.log('\nGATE Z2 REVERT: FAILED — the gate is not green unmodified, so no revert proves anything');
  process.exit(1);
}

let bad = 0;
for (const mode of MODES) {
  const r = run(mode);
  const { out, red } = r;
  // Exit 1 with no red row is NOT a pass: figures.mjs throws on an unparseable document and that also
  // exits 1. A revert has to break an ASSERTION, not the parser, or it proves nothing about the gate.
  const wentRed = r.status === 1 && red > 0;
  if (!wentRed) bad++;
  console.log(`  ${mode.padEnd(20)}exit ${String(r.status).padStart(3)} · ${String(red).padStart(2)} red rows · `
    + (wentRed ? 'the gate FAILED as required' : '*** THE GATE STAYED GREEN — assertion is decoration ***'));
  if (!wentRed) console.log(out.split('\n').slice(-6).map((l) => `      ${l}`).join('\n'));
}
console.log(`\nGATE Z2 REVERT: ${bad === 0
  ? `PASSED — all ${MODES.length} assertions are load-bearing`
  : `FAILED (${bad} of ${MODES.length} could not be broken)`}`);
process.exit(bad === 0 ? 0 : 1);
