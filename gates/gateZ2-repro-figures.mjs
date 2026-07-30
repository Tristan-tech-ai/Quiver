// GATE Z2 — the figures PUBLISHED about gate Z agree with gate Z.
//
//   npm run gate:z2              check them
//   npm run gate:z2-revert       prove this gate can go red, five ways
//
// Gate Z checks circuits. Nothing checked the document that reports gate Z, and on 30 July 2026 that
// document published "61 assertions, 61 pass" against an artifact holding 62 passing rows, a size
// table low by 145 bytes in three places because the write-up is one of the files it measures, a
// fourth row low by 3,949 bytes that its own total contradicted, and a repository-growth figure that
// was really a share of the binaries left out. Every gate in the tree was green.
//
// This gate is separate from gate Z, and cheap, for one reason: gate Z needs circom, a 4.58 MiB
// ceremony file, two `node_modules` trees and three minutes. Those are the right requirements for
// rebuilding four Groth16/Plonk artifacts and the wrong ones for asking whether a number in a
// markdown table matches `git ls-tree`. Gate Z ALSO carries the row-count assertion, computed from the
// counts it has just produced rather than from a file — see `zk/scripts/adversary/repro.mjs` §5 — so
// the check exists in both the expensive place that can see the live rows and the cheap place that
// runs in seconds.
//
// What it needs: a git checkout (the figures are blob sizes at a named tree) and
// `zk/build/adversary-repro-counts.json`, which repro.mjs writes and which IS committed. A missing
// summary is exit 2 with the command that produces it — not a skip. A gate that goes green because it
// found nothing to compare is the disease this repository is organised against.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CANDIDATES = [path.join(ROOT, 'zk'), path.resolve(ROOT, '..', '..', 'zk')];
const ZK = CANDIDATES.find((c) => existsSync(path.join(c, 'scripts', 'adversary', 'figures.mjs')));
if (!ZK) {
  console.error('GATE Z2: no zk tree with scripts/adversary/figures.mjs. Looked in:');
  for (const c of CANDIDATES) console.error(`  ${c}`);
  process.exit(1);
}

// pathToFileURL, not a hand-built `file://` string: this repository's path contains a space, and a
// raw path in an import specifier resolves against the wrong directory or not at all.
const F = await import(pathToFileURL(path.join(ZK, 'scripts', 'adversary', 'figures.mjs')).href);

const REVERT = process.env.FIG_REVERT || '';
if (REVERT && !F.REVERT_MODES[REVERT]) {
  console.error(`GATE Z2: unknown FIG_REVERT=${REVERT}. modes:`);
  for (const [k, v] of Object.entries(F.REVERT_MODES)) console.error(`  ${k.padEnd(20)}${v}`);
  process.exit(2);
}
if (REVERT) console.log(`  !! REVERT MODE ${REVERT}: ${F.REVERT_MODES[REVERT]}. The gate must FAIL.\n`);

const SUMMARY = path.join(ZK, 'build', 'adversary-repro-counts.json');
if (!existsSync(SUMMARY)) {
  console.error(`GATE Z2: ${path.relative(ZK, SUMMARY)} is missing. It is written by:\n`
    + '    npm run gate:z\n'
    + '  and it is committed, so a clone has it. Its absence means the checkout is partial.');
  process.exit(2);
}
const counts = JSON.parse(readFileSync(SUMMARY, 'utf8'));
// The committed summary must describe a COMPLETE run. A summary from a run where section 4 never
// opened would silently turn the 62-row assertion into a skip, which is the same as deleting it.
if (!counts.section4Open) {
  console.error(`GATE Z2: ${path.relative(ZK, SUMMARY)} records a run in which section 4 did not open,`
    + ' so it cannot check the with-2^13 figure. Regenerate it from a full run:\n'
    + '    node zk/scripts/adversary/ptau.mjs make 13\n'
    + '    npm run gate:z');
  process.exit(2);
}

console.log(`GATE Z2: zk tree at ${ZK}\n  summary: ${path.relative(ZK, SUMMARY)}`
  + ` (${counts.pass} pass, ${counts.fail} fail, ${counts.skipped} skipped, ${counts.bytePins} pins)\n`);

let out;
try {
  out = F.checkFigures({ counts, revert: REVERT });
} catch (e) {
  console.error(`GATE Z2: ${e.message}`);
  process.exit(1);
}

let section = '';
for (const r of out.rows) {
  if (r.kind !== section) { section = r.kind; console.log(`\n${section}\n${'-'.repeat(section.length)}`); }
  const mark = r.ok === null ? 'skipped' : r.ok ? 'ok' : '*** FAIL ***';
  console.log(`  ${r.label}\n      ${r.value}  ${mark}`);
}
// A machine-readable line for gateZ2-revert.mjs, because one of its five modes — `mirror-drop` — is
// inapplicable in a checkout with no second tree, and it must learn that from THIS gate rather than
// guess. The first version of that harness scraped the prose with a regex, which matched the word
// "skipped" in the summary line below and excused the mode in a working tree where the row was live.
// A test whose exemption is decided by a substring is an exemption granted by accident.
const mirrorRow = out.rows.find((r) => r.kind === 'mirror');
console.log(`\n  mirror-check: ${!mirrorRow ? 'absent' : mirrorRow.ok === null ? 'skipped' : 'asserted'}`);

const skipped = out.rows.filter((r) => r.ok === null).length;
console.log(`\n  ${out.rows.length - skipped - out.fails} pass  ${out.fails} fail  ${skipped} skipped`);
console.log(`  ${out.fails === 0 ? 'GATE Z2: PASSED' : `GATE Z2: FAILED (${out.fails})`}`);
process.exit(out.fails === 0 ? 0 : 1);
