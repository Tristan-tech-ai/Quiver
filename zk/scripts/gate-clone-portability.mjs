// GATE: does every gate actually run for somebody who cloned the repository?
//
// This exists because the answer was NO and nobody noticed. Every script under zk/scripts imported
// the engine as `../../hackathon/veritape/src/...`, a path that exists only in the author's working
// tree, so all five died with ERR_MODULE_NOT_FOUND in a clone. Two of them are cited in the docs as
// re-runnable rehearsals of the on-chain registry, and the README claimed the Kelly gates were
// "runnable from a clone" while none of them was. The build artifacts were missing too: the repo
// carried the verification key and the gate RESULTS, but not the proving key or the witness wasm the
// gates need to produce those results.
//
// "Verifiable from a clone" is the load-bearing claim of this whole project. A claim that nothing
// tests is a claim that drifts, so this is the test.
//
// WHAT IT CHECKS, precisely: that each gate gets far enough to be doing its own work. It does NOT
// require every gate to pass — gate3 talks to a live chain and gate2 to a live service, and a network
// failure is not a portability failure. It requires the absence of the two failure modes that mean
// "this checkout cannot run this script at all": a module that cannot be resolved, and a build
// artifact that is not there. Missing third-party packages are reported separately, since `cd zk &&
// npm install` is a documented step rather than a defect.
//
// AND it checks that the artifact side of that claim covers EVERY circuit in `circuits/`, discovered
// rather than listed, because the first version of this gate listed 14 of 22 and the eight it skipped
// included `liquidation` — the circuit a paying perp-gate caller's proof is built and checked against.
// Where a circuit genuinely cannot carry every artifact, the exclusion is named in EXCLUSIONS with a
// reason that is re-measured on every run, so it goes red the day the reason stops being true.
//
//   node zk/scripts/gate-clone-portability.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.join(SCRIPTS, '..');

// Artifacts a reader must find in the checkout, not just in the author's build directory.
//
// THE CIRCUITS ARE DISCOVERED FROM DISK, NOT LISTED. They used to be a hardcoded array of 14 names
// while `circuits/` held 22 .circom files, so this gate — whose whole purpose is "verifiable from a
// clone" — checked no artifact belonging to `liquidation`, the circuit a paying perp-gate caller's
// proof is actually built and checked against (`src/util/proverWorker.mjs` DEFAULT_CIRCUIT, and the
// key the service publishes at `/proof/vk`). Section 3 below already discovered its gates from disk
// for exactly this reason and said so in its own comment; section 1 kept a list and regressed. A list
// is a promise that somebody will remember to edit it, and nobody does.
//
// padprobe stays IN. It is a measuring stick for zk/scripts/domain-scaling.mjs rather than a Quiver
// statement, but a reader needs its artifacts to reproduce the timing table, so it is checked in full.
// kellybatch1..4 are the WIDENED Kelly circuits: the same statement about 1, 2, 3 and 4 answers at
// once, packed two answers to a public field element. kellybatch1 is not a batch and is not decoration
// either — it is the like-for-like baseline the gas comparison needs, one answer published the batch's
// way, so that "we stopped publishing two derivable numbers" cannot be counted as part of the
// aggregation win.
const CIRCUIT_DIR = path.join(ZK, 'circuits');
const ON_DISK = readdirSync(CIRCUIT_DIR)
  .filter((f) => f.endsWith('.circom'))
  .map((f) => f.slice(0, -'.circom'.length))
  .sort();

// A .circom with no `component main` is a template library: there is nothing to compile, so there can
// be no r1cs, no key and no wasm. Detected rather than assumed, and the count is ratcheted below so a
// regex that stops matching cannot quietly reclassify every circuit as a library.
const hasMain = (c) => /^[ \t]*component\s+main/m.test(readFileSync(path.join(CIRCUIT_DIR, `${c}.circom`), 'utf8'));

// The ceremony file this repo works against: hez_final_12 → a 4,096-gate Plonk domain. Same constant,
// same name, as `zk/scripts/gateLP2-expectation-cost.mjs`. It is not committed (4.8 MB), so it cannot
// be measured from a clone; what IS measured from a clone is each excluded circuit's size against it.
const PTAU_DOMAIN = 4096;

/** nConstraints out of the .r1cs header. Byte layout and the reason for the 24 — not 20 — byte skip
 *  are documented in `zk/scripts/gateLP2-expectation-cost.mjs`, which reads the same header. */
function r1csConstraints(p) {
  const b = readFileSync(p);
  if (b.toString('utf8', 0, 4) !== 'r1cs') throw new Error(`${p}: not an r1cs`);
  const nSections = b.readUInt32LE(8);
  let off = 12, hdr = null;
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    if (type === 1 && hdr === null) hdr = off + 12;
    off += 12 + size;
  }
  let q = hdr;
  const n8 = b.readUInt32LE(q); q += 4 + n8;
  const nConstraints = b.readUInt32LE(q + 24);
  if (!(nConstraints > 0)) throw new Error(`${p}: read ${nConstraints} constraints — the header parse is wrong`);
  return nConstraints;
}

// Some circuits legitimately do not carry every artifact. Each one is NAMED here with a reason a
// reader can read AND a `holds()` a run can falsify: if the reason stops being true — the library
// grows a main, the oversized circuit becomes buildable — the exclusion goes red and the circuit is
// pulled back into full coverage. A silent exclusion is the defect this gate exists to catch, so an
// exclusion that cannot fail would be the same defect wearing a comment.
const EXCLUSIONS = {
  kellybatch: {
    needs: ['circuits/kellybatch.circom'],
    why: 'template library: carries the widening templates and has no `component main`, so it compiles to nothing. '
       + 'It is checked instead by kellybatch1..4, which include it and cannot compile without it.',
    holds: () => !hasMain('kellybatch'),
    shown: () => `component main present: ${hasMain('kellybatch')}`,
  },
  lpexpectation: {
    needs: ['circuits/lpexpectation.circom', 'build/lpexpectation.r1cs'],
    why: 'r1cs-only ON PURPOSE: it exists so gateLP2 can read its size and show that what blocks a closed-form '
       + 'expectation circuit is the ceremony file, not the arithmetic. A zkey for it cannot exist on this ptau.',
    holds: () => r1csConstraints(path.join(ZK, 'build/lpexpectation.r1cs')) > PTAU_DOMAIN,
    shown: () => `${r1csConstraints(path.join(ZK, 'build/lpexpectation.r1cs'))} R1CS constraints vs a ${PTAU_DOMAIN}-gate domain`,
  },
  portfoliogate4: {
    needs: ['circuits/portfoliogate4.circom', 'build/portfoliogate4.r1cs'],
    // Its R1CS count (2,736) is UNDER the ceiling and proves nothing — Plonk gate count is what a
    // domain has to hold, and that is ~1.9x the R1CS count. So this exclusion is asserted against the
    // Plonk figure gateB10 measured off snarkjs's own gate generation, cross-checked against the r1cs
    // on disk so a stale result file cannot justify the exclusion.
    needsMeasurement: 'build/gateB10-portfolio-perleg.json',
    why: 'r1cs-only: compiled for the N=4 leg-ceiling measurement and NOT BUILDABLE on this ceremony file. '
       + 'Its R1CS count is under the ceiling; its Plonk gate count is not.',
    holds: () => {
      const m = JSON.parse(readFileSync(path.join(ZK, 'build/gateB10-portfolio-perleg.json'), 'utf8'))?.ceiling?.wideN4;
      return !!m && m.buildableOnDisk === false && m.plonk > PTAU_DOMAIN && m.domainNeeded > PTAU_DOMAIN
        && m.r1cs === r1csConstraints(path.join(ZK, 'build/portfoliogate4.r1cs'));
    },
    shown: () => {
      const m = JSON.parse(readFileSync(path.join(ZK, 'build/gateB10-portfolio-perleg.json'), 'utf8'))?.ceiling?.wideN4;
      return `gateB10 measured ${m?.plonk} Plonk gates → domain ${m?.domainNeeded} (${m?.ptauNeeded}) > ${PTAU_DOMAIN}; `
           + `its recorded ${m?.r1cs} R1CS matches the r1cs on disk (${r1csConstraints(path.join(ZK, 'build/portfoliogate4.r1cs'))})`;
    },
  },
};

// `liquidation` keeps its verification key under the name the service has always published it as:
// `/proof/vk` is a URL the paper quotes, so the file is `vk_plonk.json`, not `liquidation_vk.json`.
// This is a RENAME, not an exemption — the key is still required to be there — and it is asserted
// against the service's own map below so a rename on either side goes red instead of silent.
const VK_FILE = { liquidation: 'vk_plonk.json' };
const vkOf = (c) => VK_FILE[c] ?? `${c}_vk.json`;

const FULLY_CHECKED = ON_DISK.filter((c) => !EXCLUSIONS[c]);
const EXCLUDED = ON_DISK.filter((c) => EXCLUSIONS[c]);
const fullNeeds = (c) => [
  `build/${c}.r1cs`,
  `build/${c}_plonk.zkey`,
  `build/${vkOf(c)}`,
  `build/${c}_js/${c}.wasm`,
  `build/${c}_js/witness_calculator.cjs`,
  `circuits/${c}.circom`,
];
const REQUIRED_ARTIFACTS = [
  ...FULLY_CHECKED.flatMap(fullNeeds),
  ...EXCLUDED.flatMap((c) => [...EXCLUSIONS[c].needs, ...(EXCLUSIONS[c].needsMeasurement ? [EXCLUSIONS[c].needsMeasurement] : [])]),
];

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};

console.log(`GATE: clone portability — ${new Date().toISOString()}\n`);

// ---- 1. the artifacts are actually in the checkout ------------------------------------------------
// A list that is accidentally empty checks nothing and reports PASS, which is how a verifier stops
// being able to fail. This one built itself with a template literal inside a shell heredoc, came out
// as six commas, and duly reported success against zero artifacts. Discovery has the same failure mode
// one layer up — a readdir that returns nothing, or a filter that matches nothing, checks nothing and
// passes — so the discovered set is asserted before it is used, and against a floor that ratchets:
// raise MIN_CIRCUITS when circuits are added, and it goes red if coverage ever shrinks.
const MIN_CIRCUITS = 22;
const MIN_WITH_MAIN = 21;
record('the circuit set was discovered from disk and did not come back short',
  ON_DISK.length >= MIN_CIRCUITS && ON_DISK.filter(hasMain).length >= MIN_WITH_MAIN,
  `${ON_DISK.length} .circom in circuits/ (floor ${MIN_CIRCUITS}), ${ON_DISK.filter(hasMain).length} with a \`component main\` (floor ${MIN_WITH_MAIN})`);

// Every circuit on disk is either checked in full or NAMED in EXCLUSIONS. Nothing may fall between.
record('every circuit on disk is either fully checked or named as an exclusion',
  FULLY_CHECKED.length + EXCLUDED.length === ON_DISK.length && FULLY_CHECKED.length > 0,
  `${FULLY_CHECKED.length} fully checked, ${EXCLUDED.length} named exclusions, ${ON_DISK.length} on disk`);

// An exclusion naming a circuit that is no longer on disk is a coverage hole that reads as tidy.
const staleExclusions = Object.keys(EXCLUSIONS).filter((c) => !ON_DISK.includes(c));
record('no exclusion names a circuit that is not on disk', staleExclusions.length === 0,
  staleExclusions.length ? `stale: ${staleExclusions.join(', ')}` : `all ${EXCLUDED.length} exclusions resolve to a file in circuits/`);

// The reason for each exclusion, re-measured now rather than trusted.
console.log('\n  Named exclusions, each re-checked against the artifacts:');
const brokenExclusions = [];
for (const c of EXCLUDED) {
  const e = EXCLUSIONS[c];
  let ok = false, shown = '';
  try { ok = e.holds() === true; shown = e.shown(); }
  catch (err) { shown = `could not be re-measured: ${err.message}`; }
  if (!ok) brokenExclusions.push(c);
  console.log(`    [${ok ? 'holds' : '*** BROKEN ***'}] ${c} — ${e.why}\n              ${shown}`);
}
record('every named exclusion still earns its exclusion', brokenExclusions.length === 0,
  brokenExclusions.length ? `these no longer hold and must go back to full coverage: ${brokenExclusions.join(', ')}`
    : `${EXCLUDED.length} of ${EXCLUDED.length} re-measured`);

// The vk rename is the service's, not this gate's opinion of it.
let vkNames = null, vkWhy = '';
try {
  const { serviceRoot } = await import('./service-root.mjs');
  const src = readFileSync(fileURLToPath(new URL('util/snark.js', serviceRoot(import.meta.url).url)), 'utf8');
  const lit = src.match(/const VK_FILES\s*=\s*\{([^}]*)\}/);
  if (!lit) throw new Error('no VK_FILES literal in src/util/snark.js');
  vkNames = Object.fromEntries([...lit[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map(([, k, v]) => [k, v]));
} catch (err) { vkWhy = err.message; }
const vkDisagree = vkNames ? Object.entries(vkNames).filter(([c, f]) => vkOf(c) !== f) : null;
record('the verification-key filename this gate requires is the one the service serves',
  vkDisagree != null && vkDisagree.length === 0,
  vkNames ? (vkDisagree.length ? `service says ${vkDisagree.map(([c, f]) => `${c}→${f}`).join(', ')}, this gate requires ${vkDisagree.map(([c]) => `${c}→${vkOf(c)}`).join(', ')}`
      : `${Object.entries(vkNames).map(([c, f]) => `${c}→${f}`).join(', ')} — matched`)
    : `could not read the service's VK_FILES map: ${vkWhy}`);

record('the artifact list is not empty',
  REQUIRED_ARTIFACTS.length === FULLY_CHECKED.length * 6 + EXCLUDED.reduce((n, c) => n + EXCLUSIONS[c].needs.length + (EXCLUSIONS[c].needsMeasurement ? 1 : 0), 0)
    && REQUIRED_ARTIFACTS.length > 0,
  `${REQUIRED_ARTIFACTS.length} paths: ${FULLY_CHECKED.length} circuits x 6, plus the reduced set for ${EXCLUDED.length} exclusions`);

const missing = REQUIRED_ARTIFACTS.filter((f) => !existsSync(path.join(ZK, f)));
record('every artifact a gate needs is present in this checkout',
  REQUIRED_ARTIFACTS.length > 0 && missing.length === 0,
  missing.length ? `${missing.length} missing:\n           ${missing.join('\n           ')}` : `${REQUIRED_ARTIFACTS.length} artifacts found`);

// ---- 2. no script hardcodes the author's directory layout -----------------------------------------
// The literal check, because the resolver can be added and then quietly bypassed by the next script.
const DEV_PATH = 'hackathon/veritape';
const offenders = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith('.mjs') && f !== 'service-root.mjs' && f !== path.basename(fileURLToPath(import.meta.url)))
  .filter((f) => {
    const s = spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(SCRIPTS, f))},'utf8'))`], { encoding: 'utf8' });
    return (s.stdout || '').includes(DEV_PATH);
  });
record("no gate hardcodes the author's working-tree path",
  offenders.length === 0,
  offenders.length ? `these still reference ${DEV_PATH}/: ${offenders.join(', ')}` : 'checked every script under zk/scripts');

// ---- 3. each gate gets past module and artifact resolution ---------------------------------------
// Run with cwd at the repo root, which is where a reader would be standing.
// DISCOVERED, not listed. A hardcoded array is how coverage stops growing without anyone noticing:
// three new circuits landed with nine new gates and a fixed list would have checked none of them.
const SELF = path.basename(fileURLToPath(import.meta.url));
const GATES = readdirSync(SCRIPTS)
  .filter((f) => /^gate.*.mjs$/.test(f) && f !== SELF)
  .sort();
const REPO_ROOT = path.join(ZK, '..');

console.log('\nRunning each gate from the repository root:');
const verdicts = [];
for (const g of GATES) {
  const r = spawnSync(process.execPath, [path.join('zk', 'scripts', g)], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, QUIVER_GATE_PORTABILITY_PROBE: '1' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  // A package that is not installed is a documented setup step, not a broken path.
  const missingPkg = (out.match(/Cannot find package '([^']+)'/) || [])[1] || null;
  // These two are the real failures: our own file, or our own artifact, not where we said it is.
  const badModule = /ERR_MODULE_NOT_FOUND/.test(out) && !missingPkg;
  const badArtifact = /ENOENT[^\n]*(\.r1cs|\.zkey|\.wasm|\.json|\.circom|\.sol)/.test(out)
    || /Cannot find the Quiver service sources/.test(out);

  const portable = !badModule && !badArtifact;
  verdicts.push({ gate: g, portable, missingPkg, exit: r.status });
  const why = badModule ? 'a local module could not be resolved'
    : badArtifact ? 'a build artifact is not in the checkout'
    : missingPkg ? `needs \`cd zk && npm install\` (missing package: ${missingPkg})`
    : r.status === 0 ? 'ran to completion, passed'
    : 'ran its own logic and reported a failure of its own (not a portability problem)';
  console.log(`  [${portable ? 'PASS' : '*** FAIL ***'}] ${g.padEnd(26)} ${why}`);
}

record('every gate resolves its own modules and artifacts from a clone',
  verdicts.every((v) => v.portable),
  verdicts.filter((v) => !v.portable).map((v) => v.gate).join(', ') || `${verdicts.length} of ${verdicts.length}`);

// The check that keeps this honest: if nothing needed installing and everything passed first try, say
// so, but do NOT let a run where every gate silently no-ops read as success.
const ranSomething = verdicts.some((v) => v.exit === 0);
record('at least one gate ran to a real verdict, so this check is not vacuous', ranSomething,
  verdicts.map((v) => `${v.gate}:${v.exit}`).join(' '));

const needsInstall = verdicts.filter((v) => v.missingPkg);
if (needsInstall.length) {
  console.log(`\n  Note: ${needsInstall.length} gate(s) need \`cd zk && npm install\` first — declared in zk/package.json,`);
  console.log('  kept out of the service manifest because solc and an in-process EVM rehearse a verifier');
  console.log('  and must never be shipped with the thing that answers requests.');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(70)}`);
console.log(`CLONE PORTABILITY: ${failed.length ? `FAILED — ${failed.map((f) => f.name).join('; ')}` : 'PASSED'}`);
process.exit(failed.length ? 1 : 0);
