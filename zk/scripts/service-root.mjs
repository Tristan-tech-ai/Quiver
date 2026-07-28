// Find the service source, whichever of the two layouts this checkout is in.
//
// WHY THIS EXISTS, and it is not a tidiness fix. Every gate script under zk/scripts imported the
// engine as `../../hackathon/veritape/src/...`, which is the path in the AUTHOR'S working tree and
// does not exist in a clone of the public repository, where the service lives at `src/`. So all five
// gates — including gate2 and gate3, the ones cited as re-runnable rehearsals of the on-chain
// registry — died with ERR_MODULE_NOT_FOUND for anybody who cloned the repo and ran them. The README
// said "runnable from a clone" while none of them was.
//
// The claim was the defect, not the arithmetic, which is the same shape as the codeHash bug where the
// envelope promised "one hash over ALL engine sources" while the chart subdirectory went unhashed.
//
// Resolution order is deliberate: the CLONE layout is tried first, so the common case for a reader is
// the fast path and the author's private layout is the fallback rather than the assumption.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = [
  ['../../src/', 'clone: <repo>/src'],
  ['../../hackathon/veritape/src/', 'dev tree: research startup/hackathon/veritape/src'],
];

/**
 * @param {string} importMetaUrl  pass `import.meta.url` from the calling script
 * @returns {{ url: URL, label: string }} base URL for the service `src/`, ready for `new URL(rel, base)`
 */
export function serviceRoot(importMetaUrl) {
  const tried = [];
  for (const [rel, label] of CANDIDATES) {
    const url = new URL(rel, importMetaUrl);
    // A directory is not enough: check for a file every layout must have, so a stray empty `src/`
    // cannot resolve and then fail confusingly three imports later.
    const probe = new URL('engine/proof.js', url);
    if (existsSync(fileURLToPath(probe))) return { url, label };
    tried.push(fileURLToPath(probe));
  }
  throw new Error(
    `Cannot find the Quiver service sources. Looked for engine/proof.js at:\n  ${tried.join('\n  ')}\n` +
    'Run this from a checkout that contains the service (the public repo puts it at src/).'
  );
}

/** Convenience: `await load(import.meta.url, 'engine/sizeGate.js')`. */
export async function load(importMetaUrl, relative) {
  const { url } = serviceRoot(importMetaUrl);
  return import(new URL(relative, url));
}
