// The scripted revert for gate IF.
//
// A gate that has never failed is a claim, not a check. This script puts the defect back two ways and
// requires gate IF to go RED each time, NAMING the case, and GREEN again once the file is restored.
//
//   1. INSERTION-ORDER EVICTION, BACK   `put()` deletes the oldest entry whatever its status — the line
//                  that shipped. The in-flight `building` record for a hash already in the prover is
//                  taken like any other, a repeat request for the SAME inputs then passes the
//                  `store.has(contentHash) || claimed.has(contentHash)` guard, starts a duplicate build,
//                  hits MAX_QUEUED and writes `unavailable: prover busy` over a proof that is being
//                  proved. Gate IF's in-flight check must go red, and it must still report that the
//                  cache is bounded — the two halves are separate claims and this revert breaks only one.
//
//   2. NOTHING IS EVER EVICTED   `evictOne` returns without deleting. The in-flight half then passes,
//                  because a cache that never drops anything cannot drop an in-flight marker either.
//                  This is the fix a one-sided version of gate IF would have accepted, and it converts a
//                  bounded cache on a public endpoint into a memory-exhaustion primitive. The
//                  eviction-pressure floor must go red and the in-flight check must STAY GREEN, which is
//                  what makes the pair of assertions in gate IF non-redundant.
//
//   node gates/gateIF-revert.mjs        (npm run gate:if-revert)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const FILE = (...p) => join(ROOT, ...p);
const SNARK = FILE('src', 'util', 'snark.js');

function runGateIF() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateIF-inflight-eviction.mjs')],
    { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (label) => Number((out.match(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, 'm')) || [])[1] ?? -1);
  const pass = num('pass'), fail = num('fail');
  if (pass < 0 || fail < 0) { console.error(out); throw new Error('could not read gate IF\'s runner summary — the numbers below would be invented'); }
  const failedNames = [...new Set([
    ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
    ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
  ])];
  if (fail > 0 && !failedNames.length) { console.error(out); throw new Error(`gate IF reported ${fail} failure(s) and this script could not name any of them`); }
  return { pass, fail, failedNames, out };
}

const REVERTS = [
  {
    name: 'INSERTION-ORDER EVICTION, BACK — the line that shipped, which takes the in-flight record too',
    find: '  if (store.size >= MAX && !store.has(contentHash)) evictOne();',
    replace: '  if (store.size >= MAX) store.delete(store.keys().next().value);   // SCRIPTED REVERT',
    expect: [/the in-flight marker survived the flood/i],
    mustName: ['the in-flight record was evicted'],
    alsoAssert: {
      staysGreen: /eviction pressure/i,
      because: 'the cache is still bounded under this revert, so a gate that only counted evictions would call it healthy',
    },
  },
  {
    name: 'NOTHING IS EVER EVICTED — the fix a one-sided gate IF would have accepted',
    find: '  for (const [k, v] of store) if (v.status !== \'building\') { store.delete(k); return; }\n  store.delete(store.keys().next().value);',
    replace: '  if (store.size < 0) store.delete(store.keys().next().value);   // SCRIPTED REVERT: unbounded',
    expect: [/eviction pressure/i],
    mustName: ['the cache is not bounded any more'],
    alsoAssert: {
      staysGreen: /the in-flight marker survived the flood/i,
      because: 'a cache that never drops anything cannot drop an in-flight marker — which is why the floor is a separate assertion',
    },
  },
];

console.log('GATE IF REVERT — proving the in-flight gate can fail\n');

const ORIGINAL = readFileSync(SNARK, 'utf8');
for (const r of REVERTS) {
  if (!ORIGINAL.includes(r.find)) {
    console.error(`The code this revert changes is no longer in ${SNARK}:\n  ${r.name}`);
    console.error(`  missing literal: ${r.find.slice(0, 120).replace(/\n/g, ' ')}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}
const restore = () => writeFileSync(SNARK, ORIGINAL);

const baseline = runGateIF();
console.log(`  baseline gate IF: ${baseline.pass} pass, ${baseline.fail} fail`);
if (baseline.fail !== 0 || baseline.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(SNARK, ORIGINAL.replace(r.find, r.replace));
    const out = runGateIF();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate IF against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);
    const wentRed = r.expect.every((e) => out.failedNames.some((n) => e.test(n)));
    const named = r.mustName.filter((s) => out.out.includes(s));
    console.log(`    names the case it is about    : ${named.length}/${r.mustName.length} [${named.join(' | ')}]`);
    const stillGreen = !out.failedNames.some((n) => r.alsoAssert.staysGreen.test(n));
    console.log(`    companion check stays green    : ${stillGreen ? 'YES' : 'NO'}`);
    console.log(`      because ${r.alsoAssert.because}`);
    results.push({ name: r.name, wentRed, fullyNamed: named.length === r.mustName.length, blindOk: stillGreen });
    restore();
  }
} finally {
  restore();
}

const restored = runGateIF();
console.log(`\n  restored gate IF: ${restored.pass} pass, ${restored.fail} fail`);

console.log('\nRESULT');
let ok = restored.fail === 0 && restored.pass === baseline.pass;
for (const r of results) {
  const good = r.wentRed && r.fullyNamed && r.blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'OK' : '*** BAD ***'}] ${r.name}`);
  if (!r.wentRed) console.log('        the gate did NOT go red on the check that owns this defect');
  if (!r.fullyNamed) console.log('        the gate went red without naming the case — not an actionable failure');
  if (!r.blindOk) console.log('        the companion check that should have stayed green went red too — the failure is not attributable');
}
console.log(`\nGATE IF REVERT: ${ok ? 'PASSED' : 'FAILED'} — ${results.filter((r) => r.wentRed).length} of ${REVERTS.length} reverts turned gate IF red`);
process.exit(ok ? 0 : 1);
