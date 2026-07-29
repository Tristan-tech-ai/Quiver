// The scripted revert for gate U.
//
// A check written after a defect is a check written by somebody who already knows the answer, and this
// repository has shipped more than one that could not fail. So each part of the guard is put back to
// how it shipped, one at a time, and gate U is required to go RED on the exact rows this work
// measured — and green again once the file is restored, because red-in-both-states is a broken gate.
//
//   1. NOGUARD-HTTP   the wrapper at the foot of src/services.js stops refusing, so `s.validate` goes
//                     back to being the service's own verdict alone. Gate U must go red naming
//                     `still served 91139.24, the LONG's liquidation price` — the answer a caller
//                     writing `side: "banana"` was given for a position they never described.
//
//   2. NOGUARD-MCP    THE ONE THAT MATTERS. Only the guard in src/mcp.js is removed; services.js keeps
//                     its wrapper, so the PAID surface is still closed and test 2 still passes. This is
//                     precisely the state a fix written in services.js alone would ship in, and this
//                     repository has shipped that shape of miss more than once — `handleRpc` never
//                     calls `svc.validate()`, so the free surface would have gone on answering
//                     `side:"banana"` as a long while every paid check went green. Gate U must go red
//                     on test 3 and on the mcp half of test 4, and on nothing else.
//
//   3. NOMINUSONE     `'-1'` is dropped from perp-gate's `side` enum. Nothing is guessed and nothing
//                     fails open — the guard simply starts REFUSING `side: "-1"`, a value
//                     `perpGate.js:29` honours and answers correctly at 108,641.98. This is the
//                     failure mode a guard introduces rather than fixes, and it is the reason that row
//                     is a hardcoded number in test 4 instead of a value discovered from the enum: had
//                     it been discovered, this revert would have deleted the row and gone QUIET.
//
// The companion assertion on 1 and 2 is `preflight` and `gateBuyer` STAYING GREEN. Both replay bodies
// through repairBody; neither ever asks whether a value that survived repair means anything to the
// service. That is how a confident answer about the opposite position passed every gate here.
//
//   node gates/gateU-revert.mjs        (npm run gate:u-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const F = {
  services: join(ROOT, 'src', 'services.js'),
  mcp: join(ROOT, 'src', 'mcp.js'),
};

function runTestFile(file) {
  return () => {
    const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', file)], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
    const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
    if (pass < 0 || fail < 0) {
      console.error(out);
      throw new Error(`could not read the runner summary for ${file} — the numbers below would be invented`);
    }
    const failedNames = [...new Set([
      ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
      ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
    ])];
    if (fail > 0 && !failedNames.length) {
      console.error(out);
      throw new Error(`${file} reported ${fail} failure(s) and this script could not name any of them`);
    }
    return { pass, fail, failedNames, raw: out, passedNames: [...out.matchAll(/^(?:ok \d+ - |✔ )(.+?)(?: \(\d|$)/gm)].map((m) => m[1].trim()) };
  };
}
const runGateU = runTestFile('gateU-unknown-enum.mjs');
const runGateBuyer = runTestFile('gateBuyer-mistakes.mjs');

function runPreflight() {
  const r = spawnSync(process.execPath, [join(ROOT, 'gates', 'preflight.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passedNames = [...out.matchAll(/^ {2}\[PASS\] (.+)$/gm)].map((m) => m[1].trim());
  const failedNames = [...out.matchAll(/^ {2}\[\*\*\* FAIL \*\*\*\] (.+)$/gm)].map((m) => m[1].trim());
  if (!passedNames.length && !failedNames.length) {
    console.error(out);
    throw new Error('preflight printed no check ledger — the numbers below would be invented');
  }
  return { pass: passedNames.length, fail: failedNames.length, failedNames, passedNames, raw: out };
}

// A BLIND SPOT IS "THIS CHECK STAYED GREEN", NOT "THIS WHOLE GATE STAYED GREEN". preflight is already
// red on this tree for an unrelated, pre-existing reason (the repository's paper is ahead of the live
// deploy), so "preflight stays green" would report no blind spot where there plainly is one. Measured
// instead as: the NAMED check still passes AND the failing set is unchanged from its own baseline.
const blindSpot = (baseline, after, namePattern) => ({
  stillPassing: after.passedNames.some((n) => namePattern.test(n))
    && JSON.stringify(after.failedNames.sort()) === JSON.stringify(baseline.failedNames.sort()),
  detail: `${after.failedNames.length} pre-existing failure(s), unchanged`,
});

const REVERTS = [
  {
    name: 'NOGUARD-HTTP — services.js stops refusing an unrecognised value; validate is the service\'s own verdict again',
    file: 'services',
    find: `    const violations = enumViolations(s, b);
    return violations.length ? { error: enumRefusal(violations) } : v;`,
    replace: '    return v;   // SCRIPTED REVERT: the paid route and both diag testers lose the unknown-enum guard',
    run: runGateU,
    expect: /REFUSED on the paid surface|published rows/i,
    expectRaw: /http perp-gate side:"banana" -> still served 91139\.24, the LONG's liquidation price/,
    alsoAssert: {
      run: runPreflight, baseline: 'preflight',
      staysGreen: /repair leaves every already-valid body byte-identical/i,
      because: 'preflight replays every body through repairBody and never asks whether the value that came out means anything to the service',
    },
    alsoAssert2: {
      run: runGateBuyer, baseline: 'buyer',
      staysGreen: /.+/,
      because: 'gateBuyer owns the buyer-mistake surface — wrapped, stringified, aliased, miscased KEYS — and never once sends a value no service declares',
    },
  },
  {
    name: 'NOGUARD-MCP — ONLY the free surface loses the guard; services.js keeps its wrapper',
    file: 'mcp',
    find: '        const violations = svc ? enumViolations(svc, args) : [];',
    replace: '        const violations = [];   // SCRIPTED REVERT: handleRpc never calls validate(), so this is the whole guard on this surface',
    run: runGateU,
    expect: /FREE MCP surface|published rows/i,
    expectRaw: /mcp perp_gate\.side = "banana": SERVED, not refused/,
    alsoAssert: {
      run: runPreflight, baseline: 'preflight',
      staysGreen: /every MCP tool survives a wrapped, empty argument set/i,
      because: 'preflight DOES call every MCP tool — with an empty argument set, which never carries a value to be wrong about',
    },
    alsoAssert2: {
      run: runGateBuyer, baseline: 'buyer',
      staysGreen: /.+/,
      because: 'and gateBuyer does not reach the MCP surface at all',
    },
  },
  {
    name: 'NOMINUSONE — "-1" dropped from perp-gate\'s side enum, so the guard REFUSES a value that answers correctly',
    file: 'services',
    find: "        side: { type: 'string', enum: ['long', 'short', 'buy', 'sell', '-1'], description: 'long | short (buy | sell are accepted synonyms, as is -1 for short); default long' },",
    replace: "        side: { type: 'string', enum: ['long', 'short', 'buy', 'sell'], description: 'long | short (buy | sell are accepted synonyms); default long' },   // SCRIPTED REVERT",
    run: runGateU,
    expect: /published rows/i,
    expectRaw: /perp-gate side:"-1" -> REFUSED a value the engine honours and answers correctly/,
  },
];

console.log('GATE U REVERT — proving the unknown-enum gate can fail, in BOTH directions, and that the older gates cannot\n');

const originals = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
for (const r of REVERTS) {
  if (!originals[r.file].includes(r.find)) {
    console.error(`The code this revert removes is no longer in ${F[r.file]}:\n  ${r.name}`);
    console.error(`  missing literal: ${r.find.slice(0, 110)}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const baseU = runGateU();
console.log(`  baseline gate U : ${baseU.pass} pass, ${baseU.fail} fail`);
if (baseU.fail !== 0 || baseU.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}
const BASE = { preflight: runPreflight(), buyer: runGateBuyer() };
console.log(`  baseline preflight : ${BASE.preflight.pass} pass, ${BASE.preflight.fail} fail`
  + `${BASE.preflight.fail ? ` (pre-existing, not this change: ${BASE.preflight.failedNames.join('; ')})` : ''}`);
console.log(`  baseline gateBuyer : ${BASE.buyer.pass} pass, ${BASE.buyer.fail} fail`);

const BACKUPS = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, `${p}.revert-backup`]));
for (const [k, p] of Object.entries(F)) copyFileSync(p, BACKUPS[k]);

const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(F[r.file], originals[r.file].replace(r.find, r.replace));
    const out = r.run();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate U against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);
    const hit = (out.raw.match(r.expectRaw) || [])[0];
    console.log(`      NAMED: ${hit || '(the gate did not name the measured row this revert put back)'}`);
    const blinds = [];
    for (const key of ['alsoAssert', 'alsoAssert2']) {
      if (!r[key]) continue;
      const o2 = r[key].run();
      const b = blindSpot(BASE[r[key].baseline], o2, r[key].staysGreen);
      blinds.push({ ...b, because: r[key].because });
      console.log(`      BLIND SPOT: the older check ${b.stillPassing ? 'STAYED GREEN' : 'went red'} (${b.detail}) — ${r[key].because}`);
    }
    results.push({ ...r, out, named: out.failedNames.filter((n) => r.expect.test(n)), rawHit: r.expectRaw.test(out.raw), blinds });
    // Restored one at a time, never measured on a pile.
    for (const [k, p] of Object.entries(F)) writeFileSync(p, originals[k]);
  }
} finally {
  // In `finally` because leaving a reverted source file behind after a crash is far worse than a failed
  // gate: the next run would look green against code nobody meant to ship.
  for (const [k, p] of Object.entries(F)) { copyFileSync(BACKUPS[k], p); rmSync(BACKUPS[k], { force: true }); }
  const bad = Object.entries(F).filter(([k, p]) => readFileSync(p, 'utf8') !== originals[k]).map(([k]) => k);
  if (bad.length) {
    console.error(`*** RESTORE FAILED for ${bad.join(', ')} — restore from the mirror before doing anything else ***`);
    process.exit(3);
  }
  console.log('\n  all files restored');
}

const backU = runGateU();
console.log(`  gate U against restored code : ${backU.pass} pass, ${backU.fail} fail\n`);

console.log('='.repeat(78));
let ok = true;
for (const r of results) {
  const wentRed = r.out.fail > 0;
  const rightCheck = r.named.length > 0;
  const blindOk = r.blinds.every((b) => b.stillPassing);
  const good = wentRed && rightCheck && r.rawHit && blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'PASS' : '*** FAIL ***'}] ${r.name}`);
  console.log(`           ${wentRed ? `${r.out.fail} check(s) failed` : 'THE GATE STAYED GREEN'}`
    + `${rightCheck ? `, including: ${r.named[0]}` : ', but not the check that owns this claim'}`);
  console.log(`           ${r.rawHit ? 'and it named the exact measured row the revert put back' : 'but it did not name the measured row — the sweep may not reach it'}`);
  for (const b of r.blinds) {
    console.log(`           ${b.stillPassing ? 'and the OLDER gate stayed green over the same defect — the blind spot is real'
      : 'the older gate also went red — this revert does not demonstrate a blind spot'}`);
  }
}
const cameBack = backU.fail === 0 && backU.pass === baseU.pass;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] gate U is green again once the files are restored`);
ok = ok && cameBack;

console.log(`\nGATE U REVERT: ${ok ? 'PASSED — the gate fails when the guard is removed from EITHER surface, and when the guard over-fires' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
