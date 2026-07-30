// REVERT PROOF for gateB7-5 section 0 — the script that makes the two-sided check fail on demand.
//
// Section 0 asserts three things about the range check that was added back to `ncdf.circom`: the
// pre-fix constraint system ACCEPTS a claimed at-the-money call delta of 1.0, the rebuilt one REFUSES
// it, and the rebuilt one still accepts the truth. A check that cannot go red is decoration, so this
// runs the middle assertion against the PRE-FIX witness calculator instead of the rebuilt one and
// requires it to fail.
//
// It mutates nothing. The one-sided circuit is a committed artifact at circuits/adv/ncdfonesided.circom
// and this script simply asks it the question the gate asks the shipped one — which is the whole reason
// that file is kept rather than described. A revert that has to edit the tree is a revert that can
// leave the tree edited.
//
//   node zk/scripts/revert-ncdf-twosided.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BUILD } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const ZK = path.join(BUILD, '..');
const ADV = path.join(BUILD, 'adv', 'ncdfadv');
const { black76 } = await load(import.meta.url, 'engine/black76.js');

const SRC = readFileSync(path.join(ZK, 'circuits', 'ncdf.circom'), 'utf8');
const ONE = BigInt(SRC.match(/var ONE\s*=\s*(\d+)/)[1]);

if (!existsSync(path.join(ADV, 'ncdfonesided_js', 'ncdfonesided.wasm'))) {
  execFileSync(process.execPath, [path.join(ZK, 'scripts', 'adversary', 'build-adv.mjs'), '--into', 'ncdfadv', 'ncdfonesided'],
    { cwd: ZK, stdio: 'inherit', timeout: 600_000 });
}
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const oneSided = await require(path.join(ADV, 'ncdfonesided_js', 'witness_calculator.cjs'))(readFileSync(path.join(ADV, 'ncdfonesided_js', 'ncdfonesided.wasm')));
const twoSided = await require(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));

const L = black76(100000, 100000, 0.25, 0.6, 'call', 0);
const w = {
  xSign: '0',
  xMag: String(BigInt(Math.round(Math.abs(L.d1) * Number(ONE)))),
  nHat: String(ONE),                                                  // delta = 1.0, the lie
  pHat: String(BigInt(Math.round(L.gamma * 100000 * 0.6 * Math.sqrt(0.25) * Number(ONE)))),
};
const refuses = async (b) => { try { await b.calculateWTNSBin(w, 0); return false; } catch { return true; } };

console.log(`REVERT PROOF for gateB7-5 §0 — ${new Date().toISOString()}\n`);
console.log(`  the lie under test: nHat = 2^40, i.e. a call delta of 1.0, against a true ${L.delta.toPrecision(10)}\n`);

const results = [];
const shipped = await refuses(twoSided);
results.push(['the SHIPPED circuit refuses it (the gate\'s assertion, unmutated)', shipped, true]);
const reverted = await refuses(oneSided);
results.push(['the same assertion against the PRE-FIX circuit', reverted, false]);

let ok = true;
for (const [name, got, want] of results) {
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}\n           refuses = ${got}, expected ${want}`);
}
console.log('');
if (ok) {
  console.log('REVERT PROOF PASSED — gateB7-5 §0\'s middle assertion is red against the one-sided circuit and');
  console.log('green against the shipped one, so it is a check and not a sentence. The one-sided circuit is');
  console.log('kept in the repository precisely so this stays runnable without editing anything.');
} else {
  console.log('REVERT PROOF FAILED — the assertion did not change its answer when the circuit did, which means');
  console.log('gateB7-5 §0 is not testing what it claims to test.');
}
process.exit(ok ? 0 : 1);
