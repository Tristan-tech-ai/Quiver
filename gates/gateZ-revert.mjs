// GATE Z REVERT — prove gate Z can go red, in four independent ways.
//
//   npm run gate:z-revert
//
// A verifier that cannot fail is the disease. Gate Z asserts three different kinds of claim, so this
// breaks one of each and requires a non-zero exit every time:
//
//   source-hash   a committed circuit no longer matches its pinned digest        (integrity)
//   plonk-bytes   a rebuilt zkey does not match the artifact it should reproduce (byte identity)
//   counts        the constraint count is the one the INVESTIGATORS believed     (figures)
//   ptau-power    the Groth16 power test is read with ceil instead of floor      (the actual bug that
//                 put 2^14 in a report where 2^13 was needed, one clean power out)
//   row-count     the run reports one fewer passing row than it produced           (the published figure)
//
// `row-count` is the fifth, and the defect it puts back is the cheapest one in this set to have
// shipped: the write-up said "61 assertions, 61 pass" while gate Z's own artifact held 62 passing
// rows, and nothing in the repository could contradict it. Section 5 of repro.mjs can now, from the
// counts of the run in progress rather than from a file — so this mode pays the full rebuild, because
// proving that assertion is load-bearing means reaching it the way a real run reaches it.
//
// If any of the five exits 0, the corresponding assertion in gate Z is decoration.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZK = [path.join(ROOT, 'zk'), path.resolve(ROOT, '..', '..', 'zk')]
  .find((c) => existsSync(path.join(c, 'scripts', 'adversary', 'repro.mjs')));
if (!ZK) { console.error('GATE Z REVERT: no zk tree found'); process.exit(1); }

const MODES = ['source-hash', 'plonk-bytes', 'counts', 'ptau-power', 'row-count'];

const run = (mode) => {
  const env = { ...process.env };
  if (mode) env.ADV_REPRO_REVERT = mode; else delete env.ADV_REPRO_REVERT;
  const r = spawnSync(process.execPath, [path.join(ZK, 'scripts', 'adversary', 'repro.mjs')], {
    cwd: ZK, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000,
  });
  const out = `${(r.stdout || '').toString()}${(r.stderr || '').toString()}`;
  return { status: r.status, out, red: (out.match(/\*\*\* FAIL \*\*\*/g) || []).length };
};

// THE BASELINE, FIRST — a sixth full run, and worth its three minutes. Each line below reports "the
// gate went red", which proves nothing at all if the gate was already red: a revert harness run against
// a broken gate reports five successes and has demonstrated only that something is broken. Nothing is
// concluded here until the unmodified gate is green.
const base = run('');
console.log(`  ${'(unmodified)'.padEnd(14)}exit ${String(base.status).padStart(3)} · ${String(base.red).padStart(2)} red rows · `
  + (base.status === 0 && base.red === 0 ? 'green, so the reverts below mean something' : '*** NOT GREEN — nothing below can be concluded ***'));
if (base.status !== 0 || base.red !== 0) {
  console.log(base.out.split('\n').slice(-14).map((l) => `      ${l}`).join('\n'));
  console.log('\nGATE Z REVERT: FAILED — the gate is not green unmodified, so no revert proves anything');
  process.exit(1);
}

let bad = 0;
for (const mode of MODES) {
  const r = run(mode);
  const { out } = r;
  const failedRows = r.red;
  const wentRed = r.status !== 0 && failedRows > 0;
  if (!wentRed) bad++;
  console.log(`  ${mode.padEnd(14)}exit ${String(r.status).padStart(3)} · ${String(failedRows).padStart(2)} red rows · ${wentRed ? 'the gate FAILED as required' : '*** THE GATE STAYED GREEN — assertion is decoration ***'}`);
}
console.log(`\nGATE Z REVERT: ${bad === 0 ? `PASSED — all ${MODES.length} assertions are load-bearing` : `FAILED (${bad} of ${MODES.length} could not be broken)`}`);
process.exit(bad === 0 ? 0 : 1);
