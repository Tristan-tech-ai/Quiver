// GATE Z — the four adversarial refutations are reproducible from this repository.
//
//   npm run gate:z              reproduce them
//   npm run gate:z-revert       prove this gate can go red
//
// On 30 July 2026 four adversaries refuted four "cannot" verdicts with real Groth16 builds, two
// locally generated powers-of-tau, a closed-form LP circuit and a Poseidon-committed exec circuit.
// Every artifact lived in a session-scoped temp directory, so the measurements were real and the
// repository could not reproduce them — the same defect as a number that exists only in a scrollback.
//
// The work of reproducing them is in the zk tree (zk/scripts/adversary/repro.mjs) because that is
// where circuits and ceremony files live. This file exists so the service tree has one command for it,
// and so the zk tree can be found from either layout: the working tree has it at ../../zk, a clone of
// the mirror has it at ./zk. Guessing wrong would be a gate that skips silently, so a miss is fatal.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CANDIDATES = [
  path.join(ROOT, 'zk'),                              // mirror clone
  path.resolve(ROOT, '..', '..', 'zk'),               // working tree
];
const ZK = CANDIDATES.find((c) => existsSync(path.join(c, 'scripts', 'adversary', 'repro.mjs')));
if (!ZK) {
  console.error('GATE Z: no zk tree with scripts/adversary/repro.mjs. Looked in:');
  for (const c of CANDIDATES) console.error(`  ${c}`);
  process.exit(1);
}

const args = [path.join(ZK, 'scripts', 'adversary', 'repro.mjs'), ...process.argv.slice(2)];
console.log(`GATE Z: zk tree at ${ZK}\n`);
const r = spawnSync(process.execPath, args, { cwd: ZK, stdio: 'inherit', timeout: 3_600_000 });
if (r.error) { console.error(`GATE Z: ${r.error.message}`); process.exit(1); }
console.log(`\nGATE Z: ${r.status === 0 ? 'PASSED' : `FAILED (repro.mjs exit ${r.status})`}`);
process.exit(r.status ?? 1);
