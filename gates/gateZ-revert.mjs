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
//
// If any of the four exits 0, the corresponding assertion in gate Z is decoration.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZK = [path.join(ROOT, 'zk'), path.resolve(ROOT, '..', '..', 'zk')]
  .find((c) => existsSync(path.join(c, 'scripts', 'adversary', 'repro.mjs')));
if (!ZK) { console.error('GATE Z REVERT: no zk tree found'); process.exit(1); }

const MODES = ['source-hash', 'plonk-bytes', 'counts', 'ptau-power'];
let bad = 0;
for (const mode of MODES) {
  const r = spawnSync(process.execPath, [path.join(ZK, 'scripts', 'adversary', 'repro.mjs')], {
    cwd: ZK,
    env: { ...process.env, ADV_REPRO_REVERT: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3_600_000,
  });
  const out = `${(r.stdout || '').toString()}${(r.stderr || '').toString()}`;
  const failedRows = (out.match(/\*\*\* FAIL \*\*\*/g) || []).length;
  const wentRed = r.status !== 0 && failedRows > 0;
  if (!wentRed) bad++;
  console.log(`  ${mode.padEnd(14)}exit ${String(r.status).padStart(3)} · ${String(failedRows).padStart(2)} red rows · ${wentRed ? 'the gate FAILED as required' : '*** THE GATE STAYED GREEN — assertion is decoration ***'}`);
}
console.log(`\nGATE Z REVERT: ${bad === 0 ? 'PASSED — all four assertions are load-bearing' : `FAILED (${bad} of ${MODES.length} could not be broken)`}`);
process.exit(bad === 0 ? 0 : 1);
