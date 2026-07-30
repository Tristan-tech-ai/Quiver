// REVERT PROOF for section 1 of gate-clone-portability.mjs.
//
// The gate's own comment says a verifier that cannot fail is the disease, so this is the script that
// makes it fail on demand. It breaks one input at a time, runs the gate, reads section 1, and puts the
// input back. If any of these mutations leaves section 1 green, section 1 is not checking what it says.
//
// It kills the gate at the "Running each gate" line — section 3 spawns 45 gate scripts and takes
// minutes, and the artifact checks are what is under test here. Nothing about the gate is modified to
// make that possible: the harness kills the child, the child has no skip flag. Since 30 July that
// captured region also contains section 4, the HEAD checks, which run before section 3 for the same
// reason; the baseline assertion below therefore requires section 4 green too, which is stricter and
// right. Section 4's own falsifiability harness is `revert-clone-portability-section4.mjs` — a mutation
// of the working tree cannot make a claim about HEAD go red, so it needs a repository to break.
//
//   node zk/scripts/revert-clone-portability-section1.mjs
import { spawn } from 'node:child_process';
import { renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.join(SCRIPTS, '..');
const GATE = path.join(SCRIPTS, 'gate-clone-portability.mjs');
const MARKER = 'Running each gate from the repository root';

/** Run the gate, return section 1 only. */
function section1() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE], { cwd: path.join(ZK, '..'), encoding: 'utf8' });
    let buf = '';
    const done = () => resolve(buf.split(MARKER)[0].trimEnd());
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes(MARKER)) { child.kill(); done(); }
    });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('close', done);
  });
}

// Hide EVERY copy of the artifact in this checkout, not the first one found.
//
// This script crashed in a clone until 30 July: it renamed `zk/build/vk_plonk.json`, and a clone does
// not have one — the published repository tracks the liquidation circuit's serving copies under
// `assets/zk/`, where the service reads them. So `npm run gate:clone-revert`, published in
// `docs/fix-clone-portability.md` as the proof that the portability gate can fail, was itself unrunnable
// from a clone. The fix is not "try the other directory": it is hide ALL of them, because a mutation
// that leaves a second copy standing is a mutation the gate is right not to notice, and the revert would
// then be reporting that the gate cannot fail when in truth the input was never broken.
const COPIES = (rel) => {
  const here = [path.join(ZK, rel)];
  if (rel.startsWith('build/')) here.push(path.join(ZK, '..', 'assets', 'zk', rel.slice('build/'.length)));
  return here.filter((p) => existsSync(p));
};

const hide = (rel) => {
  const found = COPIES(rel);
  if (!found.length) throw new Error(`cannot hide ${rel}: no copy of it in this checkout (looked under zk/ and assets/zk/)`);
  const moved = found.map((from) => { const to = `${from}.__reverted__`; renameSync(from, to); return [to, from]; });
  return () => { for (const [to, from] of moved) renameSync(to, from); };
};

const MUTATIONS = [
  {
    name: 'hide build/vk_plonk.json — the LIQUIDATION verification key, the circuit the old hardcoded list never looked at',
    apply: () => hide('build/vk_plonk.json'),
    expect: /\*\*\* FAIL \*\*\*\] every artifact a gate needs is present/,
  },
  {
    name: 'hide build/liquidation_plonk.zkey — the proving key a paying perp-gate proof is built with',
    apply: () => hide('build/liquidation_plonk.zkey'),
    expect: /\*\*\* FAIL \*\*\*\] every artifact a gate needs is present/,
  },
  {
    name: 'hide build/gateB10-portfolio-perleg.json — the measurement that JUSTIFIES the portfoliogate4 exclusion',
    apply: () => hide('build/gateB10-portfolio-perleg.json'),
    expect: /\*\*\* FAIL \*\*\*\] every named exclusion still earns its exclusion/,
  },
  {
    name: 'hide circuits/ncdf.circom — one circuit fewer than the discovery floor',
    apply: () => hide('circuits/ncdf.circom'),
    expect: /\*\*\* FAIL \*\*\*\] the circuit set was discovered from disk and did not come back short/,
  },
];

console.log('REVERT PROOF — section 1 of gate-clone-portability.mjs\n');
console.log('BASELINE (nothing broken):');
const base = await section1();
console.log(base.split('\n').map((l) => `  ${l}`).join('\n'));
const baselineGreen = !base.includes('*** FAIL ***');
console.log(`\n  baseline is green: ${baselineGreen}\n`);

let allWentRed = true;
for (const m of MUTATIONS) {
  console.log(`${'-'.repeat(100)}\nMUTATION: ${m.name}`);
  const undo = m.apply();
  let out;
  try { out = await section1(); } finally { undo(); }
  const red = m.expect.test(out);
  if (!red) allWentRed = false;
  console.log(out.split('\n').filter((l) => /FAIL|BROKEN|holds\]/.test(l)).map((l) => `  ${l}`).join('\n') || '  (no failure line at all)');
  console.log(`\n  => went red as expected: ${red ? 'YES' : 'NO — THE CHECK CANNOT FAIL'}`);
}

console.log(`\n${'='.repeat(100)}`);
console.log(`REVERT PROOF: ${baselineGreen && allWentRed ? 'PASSED — section 1 is green when the checkout is whole and red for every mutation above'
  : 'FAILED — see above'}`);
process.exit(baselineGreen && allWentRed ? 0 : 1);
