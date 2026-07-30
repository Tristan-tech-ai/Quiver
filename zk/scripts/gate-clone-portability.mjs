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
// AND — section 4, which runs before section 3 because it costs a second where section 3 costs minutes —
// it asks all of that of the REPOSITORY AT HEAD instead of the directory it is running in. Sections 1 to
// 3 ask the filesystem, and on the author's desk the filesystem is the wrong witness: a file that was
// written and never committed answers `existsSync` and is absent from every clone. Section 1 reports
// "120 artifacts found" here and "5 missing" in a clone of the same commit; on 29 July a committed
// `src/services.js` imported a module that was in no commit and the published repository could not start
// for two commits, with nothing in this tree able to go red. Section 4 is the part whose subject is the
// published artifact rather than the desk it was made on.
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

// WHERE AN ARTIFACT IS ALLOWED TO LIVE, and this is not a loosening.
//
// The service does not read `zk/build`. `src/util/proverWorker.mjs` and `src/util/snark.js` both load
// from `assets/zk/`, because that is the directory a deploy carries, and the published repository tracks
// the SERVING copy of the six circuits it proves with there — byte-identical to the build copy, verified
// below at HEAD by blob id. `zk/build` is where circom writes. So an artifact is "in this checkout" if
// either directory has it, and the check that used to look only under `zk/` reported five missing
// liquidation artifacts to every reader who cloned while reporting 120 found on the author's desk.
//
// SAME CHECKOUT ONLY, and that is load-bearing. The fallback is `<zk>/../assets/zk`, which is
// `<repo>/assets/zk` in a clone and nothing at all on the author's desk, where `zk/` is a sibling of the
// mirror rather than inside it. Resolving the fallback through the mirror instead would have let the
// revert harness hide `zk/build/vk_plonk.json` and still find a copy — a mutation that cannot go red.
const ASSETS_ZK = path.join(ZK, '..', 'assets', 'zk');
/** Every copy of a required artifact that exists in THIS checkout. Empty means genuinely missing. */
const artifactCopies = (rel) => {
  const here = [path.join(ZK, rel)];
  if (rel.startsWith('build/')) here.push(path.join(ASSETS_ZK, rel.slice('build/'.length)));
  return here.filter((p) => existsSync(p));
};

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

const missing = REQUIRED_ARTIFACTS.filter((f) => artifactCopies(f).length === 0);
const viaAssets = REQUIRED_ARTIFACTS.filter((f) => !existsSync(path.join(ZK, f)) && artifactCopies(f).length > 0);
record('every artifact a gate needs is present in this checkout',
  REQUIRED_ARTIFACTS.length > 0 && missing.length === 0,
  missing.length ? `${missing.length} missing:\n           ${missing.join('\n           ')}`
    : `${REQUIRED_ARTIFACTS.length} artifacts found${viaAssets.length ? `, ${viaAssets.length} of them in assets/zk rather than zk/build: ${viaAssets.join(', ')}` : ''}`);

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

// ---- 4. the REPOSITORY AT HEAD, not the directory this is running in -----------------------------
//
// Everything above asks the filesystem, and on the author's desk the filesystem is the wrong witness.
// An uncommitted file answers `existsSync` and is absent from a clone, so sections 1 to 3 are green
// exactly where the claim is not made and red where it is. That is not a hypothetical: section 1 reports
// "120 artifacts found" on the desk this was written on and "5 missing" in a clone of the same commit,
// and on 29 July a session committed a `src/services.js` that imports `./util/lpBoundedness.js` without
// committing the module — the published repository could not start at all, for two commits, and nothing
// here could go red, because nothing here looked at HEAD.
//
// Run against the commit that broke it (2778432) this section names both offenders and nothing else:
// `src/services.js:46` and `src/mcp.js:48`, each importing `./util/lpBoundedness.js`.
//
// The three questions are the same question: is the thing we publish the thing we tested?
import {
  repoRoot, headFiles, headBlobIds, unresolvedImports, unresolvedIn, publishedScripts,
} from './head-tree.mjs';

console.log('\n  The repository at HEAD (git), not the working tree:');
let HEAD = null, headWhy = '';
try { HEAD = repoRoot(); } catch (err) { headWhy = err.message; }
record('the git repository this checkout publishes was found', HEAD !== null,
  HEAD ? `${HEAD.repo}\n           HEAD ${HEAD.head} — resolved as ${HEAD.label}` : headWhy);

if (HEAD) {
  const files = headFiles(HEAD.repo);
  const imports = unresolvedImports(HEAD.repo, files);

  // Floors, ratcheted, for the same reason the circuit discovery has one: a `ls-tree` that comes back
  // empty, or a specifier scan whose regex stops matching, checks nothing and reports PASS. The first
  // version of the scanner blanked string BODIES along with comments, turning `from './x.js'` into
  // `from ''`, and found 0 relative imports in 410 files — it was this floor that caught it.
  const MIN_HEAD_FILES = 780, MIN_HEAD_JS = 390, MIN_SPECIFIERS = 580;
  record('HEAD came back whole, so this section is not checking an empty tree',
    files.size >= MIN_HEAD_FILES && imports.scanned >= MIN_HEAD_JS && imports.specifiers >= MIN_SPECIFIERS,
    `${files.size} paths at HEAD (floor ${MIN_HEAD_FILES}), ${imports.scanned} of them .js/.mjs/.cjs (floor ${MIN_HEAD_JS}), `
    + `${imports.specifiers} relative imports read out of them (floor ${MIN_SPECIFIERS})`);

  // POSITIVE CONTROL, on every run, against a file set this gate makes up. The floors above prove the
  // scanner still reads; this proves the resolver still refuses. Both directions, because a resolver
  // that flags everything is as useless as one that flags nothing.
  const FAKE = new Set(['a/b.js', 'a/util/there.js']);
  const control = unresolvedIn('a/b.js', "import x from './util/there.js';\nimport y from './util/gone.js';\n", FAKE);
  const controlOk = control.specifiers === 2 && control.unresolved.length === 1
    && control.unresolved[0].spec === './util/gone.js';
  record('the resolver still refuses a module that is not there (positive control)', controlOk,
    `2 imports offered, 1 present and 1 absent → flagged ${control.unresolved.length}`
    + `${control.unresolved.length ? ` (${control.unresolved.map((u) => u.spec).join(', ')})` : ''}`);

  // THE CHECK THIS SECTION EXISTS FOR.
  record('no file committed at HEAD imports a module that is absent from HEAD',
    imports.unresolved.length === 0,
    imports.unresolved.length
      ? `${imports.unresolved.length} unresolvable:\n           `
        + imports.unresolved.map((u) => `${u.importer}:${u.line} imports ${u.spec} — nothing at HEAD matches ${u.tried[0]}`).join('\n           ')
      : `${imports.specifiers} relative imports across ${imports.scanned} committed JS files, all resolve inside HEAD`);

  // The artifact question, asked of HEAD instead of the disk. This is the half of section 1 that a
  // reader gets: an artifact the author built and never committed is present to `existsSync` and
  // missing from every clone. `assets/zk` counts, because the repository tracks the serving copies there.
  const inHead = (rel) => files.has(`zk/${rel}`)
    || (rel.startsWith('build/') && files.has(`assets/zk/${rel.slice('build/'.length)}`));
  const notCommitted = REQUIRED_ARTIFACTS.filter((f) => !inHead(f));
  record('every artifact a gate needs is committed at HEAD, not just built on this machine',
    REQUIRED_ARTIFACTS.length > 0 && notCommitted.length === 0,
    notCommitted.length ? `${notCommitted.length} on disk but not at HEAD:\n           ${notCommitted.join('\n           ')}`
      : `${REQUIRED_ARTIFACTS.length} artifacts, every one of them in HEAD`);

  // Two copies of a proving key are two chances to be wrong. The service proves against `assets/zk`
  // and every gate verifies against `zk/build`; if those ever diverge, the gates certify a circuit the
  // service does not run and the whole layer is decoration. Compared by blob id, which is an exact
  // byte comparison and costs one `ls-tree`.
  const dual = [...files].filter((f) => f.startsWith('assets/zk/') && files.has(`zk/build/${f.slice('assets/zk/'.length)}`));
  const ids = headBlobIds(HEAD.repo, [...dual, ...dual.map((f) => `zk/build/${f.slice('assets/zk/'.length)}`)]);
  const diverged = dual.filter((f) => ids.get(f) !== ids.get(`zk/build/${f.slice('assets/zk/'.length)}`));
  record('where an artifact is committed twice, the two copies are byte-identical at HEAD',
    diverged.length === 0,
    diverged.length ? `these differ between assets/zk and zk/build: ${diverged.join(', ')}`
      : `${dual.length} artifact(s) tracked in both assets/zk and zk/build, all with identical blob ids`);

  // A command a document tells a reader to run and the manifest does not define is a false claim about
  // a clone, in the same way a missing module is. `npm run gate:lb` was published in four documents and
  // defined in none of the two committed manifests: the alias existed only on the author's desk.
  const { referenced, defined } = publishedScripts(HEAD.repo, files);
  const undefinedScripts = [...referenced].filter(([name]) => !defined.has(name));
  record('every `npm run` a committed document publishes is defined in a committed manifest',
    referenced.size > 0 && defined.size > 0 && undefinedScripts.length === 0,
    undefinedScripts.length
      ? `${undefinedScripts.length} published but undefined:\n           ${undefinedScripts.map(([n, w]) => `npm run ${n} — first published at ${w}`).join('\n           ')}`
      : `${referenced.size} distinct scripts referenced across committed .md/.html, all defined among the ${defined.size} in package.json and zk/package.json`);
}

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
