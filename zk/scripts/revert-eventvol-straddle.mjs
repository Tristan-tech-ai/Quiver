// REVERT PROOF for gateB7-6 — the script that makes the gate fail on demand.
//
// A verifier that cannot fail is the disease this repository is organised against, so every claim
// gateB7-6 makes gets one mutation that should turn it red. Each mutation is applied to the SERVICE,
// not to the gate, and undone in a finally block; if any of them leaves the gate green, that check is
// decoration.
//
// It kills the gate at the "5. A REAL PROOF" line. Sections 5 to 7 spend four minutes proving and
// running an EVM, and every check under test here is in sections 1 to 4. Nothing about the gate is
// modified to make that possible — the harness kills the child, and the child has no skip flag.
//
//   node zk/scripts/revert-eventvol-straddle.mjs
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceRoot } from './service-root.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.join(SCRIPTS, '..');
const GATE = path.join(SCRIPTS, 'gateB7-6-eventvol-straddle.mjs');
const MARKER = '5. A REAL PROOF';
const SRC = fileURLToPath(serviceRoot(import.meta.url).url);
const ASSETS = path.join(SRC, '..', 'assets', 'zk');

/** Run the gate, return everything before section 5. */
function head() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE], { cwd: ZK });
    let buf = '';
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(buf.split(MARKER)[0]); };
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes(MARKER)) { child.kill(); done(); }
    });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('close', done);
    child.on('error', done);
  });
}

/** Replace an exact string in a file and hand back the undo. Throws if the anchor is not there, so a
 *  mutation that has silently stopped applying fails loudly instead of testing nothing. */
function patch(file, from, to) {
  const p = path.isAbsolute(file) ? file : path.join(SRC, file);
  const before = readFileSync(p, 'utf8');
  if (!before.includes(from)) throw new Error(`anchor not found in ${p}: ${from.slice(0, 60)}`);
  writeFileSync(p, before.replace(from, to), 'utf8');
  return () => writeFileSync(p, before, 'utf8');
}

const MUTATIONS = [
  {
    name: 'move the service\'s copy of TOLC off the circuit\'s value (12 -> 11)',
    why: 'the service carries a copy of the circuit parameters because the deploy does not ship the circom source. Nothing but this gate compares them.',
    apply: () => patch('util/ncdfWitness.js', '  TOLC: 12,', '  TOLC: 11,'),
    expect: /\*\*\* FAIL \*\*\*\] the service's TOLC is the circuit's TOLC/,
  },
  {
    name: 'put a DIFFERENT circuit\'s verification key at assets/zk/ncdf_vk.json',
    why: 'the service proves against assets/zk and this gate proves against zk/build. If they drift, the gate is gating a circuit nobody serves.',
    apply: () => {
      const target = path.join(ASSETS, 'ncdf_vk.json');
      const donor = path.join(ZK, 'build', 'kelly_vk.json');
      if (!existsSync(donor)) throw new Error('kelly_vk.json is not in build/ to borrow');
      const bak = `${target}.__reverted__`;
      copyFileSync(target, bak);
      copyFileSync(donor, target);
      return () => { copyFileSync(bak, target); };
    },
    expect: /\*\*\* FAIL \*\*\*\] every artifact the service proves against is the one this gate gates/,
  },
  {
    name: 'delete the display ceiling, so a spot of 5e8 gets a proof of a neighbouring number',
    why: 'above a spot of about 1.13e8 the circuit\'s 12-ulp envelope is wider than the two decimals the straddle is displayed to. Serving a proof there is serving a proof of a different answer.',
    apply: () => patch('util/ncdfWitness.js',
      '  if (!(envelopeUsd <= DISPLAY_HALF_UNIT)) {',
      '  if (false && !(envelopeUsd <= DISPLAY_HALF_UNIT)) {'),
    expect: /\*\*\* FAIL \*\*\*\] (the display ceiling fires|a spot above the ceiling is refused)/,
  },
  {
    name: 'reconstruct from the engine\'s unrounded N instead of the gridded nHat',
    why: 'THE GRID-SNAPPING FAILURE, in its own shape. A reconstruction that skips the 2^-40 grid agrees with the engine to 1e-16 and certifies an identity about a number the circuit was never handed — and the encoding bound stops being reached, which is the only way to see it.',
    apply: () => patch('util/ncdfWitness.js',
      '  const nGrid = nHat / NCDF.ONE;',
      '  const nGrid = nEngine;'),
    expect: /\*\*\* FAIL \*\*\*\] the encoding bound is REACHED, not merely respected/,
  },
];

console.log(`REVERT PROOF for gateB7-6 — ${new Date().toISOString()}`);
console.log(`  service sources: ${SRC}`);
console.log(`  reading the gate up to "${MARKER}"\n`);

// Green first. A revert script that never saw the gate pass proves nothing about the mutations.
const base = await head();
const baseRed = /\*\*\* FAIL \*\*\*/.test(base);
console.log(`  [${baseRed ? '*** FAIL ***' : 'PASS'}] the gate is green before anything is broken${baseRed ? `\n           ${base.split('\n').filter((l) => l.includes('FAIL')).join('\n           ')}` : ''}`);

let reds = 0;
for (const m of MUTATIONS) {
  let undo = null;
  let out = '';
  try {
    undo = m.apply();
    out = await head();
  } finally {
    if (undo) undo();
  }
  const red = m.expect.test(out);
  if (red) reds++;
  console.log(`\n  [${red ? 'PASS' : '*** FAIL ***'}] ${m.name}`);
  console.log(`           why it matters: ${m.why}`);
  const line = out.split('\n').find((l) => l.includes('*** FAIL ***'));
  console.log(`           gate said: ${line ? line.trim() : '(no failure line — the check did not notice)'}`);
}

// And green again, so a mutation that failed to undo cannot be mistaken for a clean run.
const after = await head();
const afterRed = /\*\*\* FAIL \*\*\*/.test(after);
console.log(`\n  [${afterRed ? '*** FAIL ***' : 'PASS'}] the gate is green again after every mutation is undone`);

const ok = !baseRed && !afterRed && reds === MUTATIONS.length;
console.log(`\n${'='.repeat(78)}`);
console.log(`REVERT PROOF: ${ok ? 'PASSED' : 'FAILED'} — ${reds} of ${MUTATIONS.length} mutations turned gateB7-6 red`);
process.exit(ok ? 0 : 1);
