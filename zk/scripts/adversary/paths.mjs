// Path resolution for the rescued adversary probes.
//
// Every one of these scripts was written in a session-scoped temp directory and carried three
// hardcoded absolute paths: the zk tree, the service tree, and its own scratchpad. Those three
// constants are the entire reason four real refutations were non-reproducible from a clone. They are
// resolved here instead, from the location of this file, so the same script runs in the working tree
// and in a fresh clone of the mirror.
//
// Two layouts exist and both must work:
//   working tree   <root>/zk/scripts/adversary/paths.mjs   with the service at <root>/hackathon/veritape
//   mirror clone   <repo>/zk/scripts/adversary/paths.mjs   with the service at <repo>
// so VT is PROBED rather than assumed, and a wrong guess is a loud failure rather than a silent
// module-not-found deeper in.
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ZK = path.resolve(here, '..', '..');
export const BUILD = path.join(ZK, 'build');
export const CIRCUITS = path.join(ZK, 'circuits');
export const ADV_CIRCUITS = path.join(CIRCUITS, 'adv');
export const CLI = path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
export const CIRCOM = path.join(ZK, 'circom.exe');
export const PTAU12 = path.join(BUILD, 'hez_final_12.ptau');

// The service tree. `src/engine/lpRisk.js` is the probe file because three of the four refutations
// call the live engine and would otherwise fail at the import rather than at a check.
const VT_CANDIDATES = [
  path.resolve(ZK, '..'),                                 // mirror clone: <repo>/zk -> <repo>
  path.resolve(ZK, '..', 'hackathon', 'veritape'),        // working tree
];
const found = VT_CANDIDATES.find((c) => existsSync(path.join(c, 'src', 'engine', 'lpRisk.js')));
if (!found) {
  throw new Error(
    `adversary/paths.mjs: no service tree found. Looked for src/engine/lpRisk.js under:\n  ${VT_CANDIDATES.join('\n  ')}`,
  );
}
export const VT = found;

// Where rebuilt artifacts go. Never the repo: these are regenerated, some are 28 MB, and one is
// 242 MB. Overridable so a reader can reproduce into an empty directory and diff.
export const WORK = process.env.ADV_WORK ? path.resolve(process.env.ADV_WORK) : path.join(BUILD, 'adv');
mkdirSync(WORK, { recursive: true });

export const zkUrl = (rel) => pathToFileURL(path.join(ZK, rel)).href;
export const vtUrl = (rel) => pathToFileURL(path.join(VT, rel)).href;
export const workUrl = (rel) => pathToFileURL(path.join(WORK, rel)).href;

export default { ZK, BUILD, CIRCUITS, ADV_CIRCUITS, CLI, CIRCOM, PTAU12, VT, WORK, zkUrl, vtUrl, workUrl };
