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
//   node zk/scripts/gate-clone-portability.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.join(SCRIPTS, '..');

// Artifacts a reader must find in the checkout, not just in the author's build directory.
// padprobe is a measuring stick for zk/scripts/domain-scaling.mjs, not a Quiver statement, but it is
// still an artifact a reader needs in order to reproduce the timing table.
const CIRCUITS = ['kelly', 'concentration', 'divergence', 'constantproduct', 'padprobe', 'greeks', 'greeksfp', 'greekssigned', 'parity'];
const REQUIRED_ARTIFACTS = CIRCUITS.flatMap((c) => [
  `build/${c}.r1cs`,
  `build/${c}_plonk.zkey`,
  `build/${c}_vk.json`,
  `build/${c}_js/${c}.wasm`,
  `build/${c}_js/witness_calculator.cjs`,
  `circuits/${c}.circom`,
]);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};

console.log(`GATE: clone portability — ${new Date().toISOString()}\n`);

// ---- 1. the artifacts are actually in the checkout ------------------------------------------------
// A list that is accidentally empty checks nothing and reports PASS, which is how a verifier stops
// being able to fail. This one built itself with a template literal inside a shell heredoc, came out
// as six commas, and duly reported success against zero artifacts. So the count is asserted first.
record('the artifact list is not empty', REQUIRED_ARTIFACTS.length === CIRCUITS.length * 6,
  `${REQUIRED_ARTIFACTS.length} paths across ${CIRCUITS.length} circuits`);

const missing = REQUIRED_ARTIFACTS.filter((f) => !existsSync(path.join(ZK, f)));
record('every artifact a gate needs is present in this checkout',
  REQUIRED_ARTIFACTS.length > 0 && missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED_ARTIFACTS.length} artifacts found`);

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
