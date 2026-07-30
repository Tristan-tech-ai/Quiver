// REVERT PROOF for section 1 of gate-clone-portability.mjs.
//
// The gate's own comment says a verifier that cannot fail is the disease, so this is the script that
// makes it fail on demand. It breaks one input at a time, runs the gate, reads section 1, and puts the
// input back. If any of these mutations leaves section 1 green, section 1 is not checking what it says.
//
// It reads ONLY section 1 and kills the gate at the "Running each gate" line — section 3 spawns 45 gate
// scripts and takes minutes, and section 1 is what is under test here. Nothing about the gate is
// modified to make that possible: the harness kills the child, the child has no skip flag.
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

const hide = (rel) => {
  const from = path.join(ZK, rel);
  if (!existsSync(from)) throw new Error(`cannot hide ${rel}: it is not there to begin with`);
  const to = `${from}.__reverted__`;
  renameSync(from, to);
  return () => renameSync(to, from);
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
