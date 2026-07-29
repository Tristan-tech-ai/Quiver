// The filesystem half of the paper checks, kept apart from the logic half.
//
// `gates/paper-integrity.mjs` reads nothing and fetches nothing on purpose: that is what lets
// `gateY-revert.mjs` reinstate a defect in memory and watch the check refuse, without editing the
// paper — which a gate may not do. This module is the other half, and it is the only place the
// paths live, so the gate and its revert cannot disagree about what they are looking at.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVICE = join(HERE, '..');

// A publication path is resolved against the service, its parent and its grandparent, first hit
// wins. This working tree keeps the published repository and the submission drafts as siblings, and
// the service is `hackathon/veritape` in one checkout and `Quiver` in the other — so any single
// fixed base is right in one and wrong in the other. In a fresh clone only the `assets/` sites
// resolve, which is why the contract carries `minimumSitesChecked` rather than trusting that
// everything was found.
export const resolveSite = (rel) => {
  for (const b of [SERVICE, join(SERVICE, '..'), join(SERVICE, '..', '..')]) {
    const p = join(b, rel);
    if (existsSync(p)) return p;
  }
  return null;
};

export function readMappingInputs() {
  const contract = JSON.parse(readFileSync(join(HERE, 'paper-mapping.json'), 'utf8'));
  const onDisk = [];
  for (let i = 1; i <= 40; i++) {
    const f = join(SERVICE, 'assets', `whitepaper.part${i}.md`);
    if (!existsSync(f)) break;
    onDisk.push({ n: i, text: readFileSync(f, 'utf8') });
  }
  return {
    contract,
    md: readFileSync(join(SERVICE, 'assets', 'whitepaper.md'), 'utf8'),
    html: readFileSync(join(SERVICE, 'assets', 'whitepaper.html'), 'utf8'),
    partsJson: JSON.parse(readFileSync(join(SERVICE, 'assets', 'whitepaper.parts.json'), 'utf8')),
    onDisk,
    publications: (contract.publications || []).map((p) => {
      const path = resolveSite(p.file);
      return { file: p.file, present: !!path, text: path ? readFileSync(path, 'utf8') : '' };
    }),
    generatorSource: readFileSync(join(SERVICE, 'tools', 'paper-to-text.mjs'), 'utf8'),
  };
}

export const readPendingDeploy = () => {
  try { return JSON.parse(readFileSync(join(HERE, 'paper-pending-deploy.json'), 'utf8')); } catch { return null; }
};
export const readChangelog = () => readFileSync(join(SERVICE, 'assets', 'changelog.md'), 'utf8');
export const readParts = () => {
  const out = [];
  for (let i = 1; i <= 40; i++) {
    const f = join(SERVICE, 'assets', `whitepaper.part${i}.md`);
    if (!existsSync(f)) break;
    out.push({ n: i, repo: readFileSync(f, 'utf8') });
  }
  return out;
};
