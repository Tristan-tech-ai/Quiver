// The scripted revert for gate C.
//
// A check written after a defect is a check written by somebody who already knows the answer, and this
// repository has twice shipped one that could not fail. So each half of the fix is put back, one at a
// time, and gate C is required to go RED — and green again once the file is restored, because
// red-in-both-states is a broken gate rather than a working one.
//
//   1. NOENUM     src/services.js declares perp-gate's `side` as prose again, exactly as it shipped:
//                 `{ type:'string', description:'long | short' }`. Gate C must go red naming
//                 `liquidationPrice 91139.24`, which is the LONG's price handed to a short seller —
//                 the row hackathon/JUDGE_SWEEP_LIVE.md measured.
//
//                 THE COMPANION ASSERTION IS THE POINT. preflight must STAY GREEN, and so must
//                 gateBuyer — the gate whose entire subject is what buyers get wrong about input
//                 shapes. Both replay bodies through repairBody and neither ever asks whether the
//                 value that came out means the same thing as the value that went in. That is how an
//                 inverted, self-checked, signed, billable risk number survived every gate in the
//                 repository.
//
//   2. NODESCENT  src/util/repair.js stops descending into array items, with every enum left declared.
//                 Gate C must go red on `positions[].type` and `positions[].side` — the two fields that
//                 carry direction and live inside an array — and its FIRST failure must be the hedged
//                 book reading 200,000 net on a book that is flat. Enums alone were never the whole fix.
//
//   3. MCPONLY    the enum is removed from src/services.js for options-risk's option `type` and LEFT
//                 declared in src/mcp.js. This is not a hypothetical: it is the state perp-gate's
//                 `side` was actually in before this work — advertised to every MCP client by
//                 `tools/list`, and applied to nothing, because handleRpc hands repairBody the SERVICES
//                 entry. Gate C must go red AND must name the asymmetry, or the sweep is trusting the
//                 schema a caller reads instead of the one the server enforces.
//
//   node gates/gateC-revert.mjs        (npm run gate:c-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const F = {
  services: join(ROOT, 'src', 'services.js'),
  repair: join(ROOT, 'src', 'util', 'repair.js'),
};

// ── runners ──────────────────────────────────────────────────────────────────────────────────────
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
const runGateC = runTestFile('gateC-case-sensitivity.mjs');
const runGateBuyer = runTestFile('gateBuyer-mistakes.mjs');

// A BLIND SPOT IS "THIS CHECK STAYED GREEN", NOT "THIS WHOLE GATE STAYED GREEN", and the difference is
// not pedantry — it is the difference between a measurement and an assumption. Written the second way,
// this script reported preflight as NOT blind to the side defect. It was blind; preflight was simply
// already red for an unrelated reason (`every paper part is still byte-identical to live`, 0 of 7 — the
// repository's paper is ahead of the live deploy, and it reads exactly the same way against the
// unmodified mirror). So the claim is measured as: the NAMED check still passes, AND the set of checks
// failing is unchanged from the baseline, so the revert neither fixed nor broke anything else.
const blindSpot = (baseline, after, namePattern) => ({
  stillPassing: after.passedNames.some((n) => namePattern.test(n))
    && JSON.stringify(after.failedNames.sort()) === JSON.stringify(baseline.failedNames.sort()),
  detail: `${after.failedNames.length} pre-existing failure(s), unchanged`,
});

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

// ── the reverts ──────────────────────────────────────────────────────────────────────────────────
// Each `find` is a literal that MUST be present, so a revert that no longer applies refuses to run
// rather than reporting a meaningless green.
const REVERTS = [
  {
    name: 'NOENUM — services.js declares perp-gate `side` as prose again, exactly as it shipped',
    file: 'services',
    // The literal gained `'-1'` when the unknown-enum guard landed: an enum that is now ENFORCED has to
    // list every string the engine honours, or a correct request becomes a refusal. See
    // hackathon/UNKNOWN_ENUM_REFUSAL.md. The revert still puts the field back to the prose it shipped as.
    find: "        side: { type: 'string', enum: ['long', 'short', 'buy', 'sell', '-1'], description: 'long | short (buy | sell are accepted synonyms, as is -1 for short); default long' },",
    replace: "        side: { type: 'string', description: 'long | short' },   // SCRIPTED REVERT",
    run: runGateC,
    expect: /judge sweep measured/i,
    expectRaw: /liquidationPrice 91139\.24, expected 108641\.98 \(the SHORT's\)/,
    alsoAssert: {
      run: runPreflight, baseline: 'preflight',
      staysGreen: /repair leaves every already-valid body byte-identical/i,
      because: 'preflight replays bodies through repairBody and never asks whether the value that came out still MEANS what the caller wrote',
    },
    alsoAssert2: {
      run: runGateBuyer, baseline: 'buyer',
      staysGreen: /miscased|recase|repair/i,
      because: 'gateBuyer owns the buyer-mistake surface — wrapped, stringified, aliased, miscased KEYS — and never once checks a miscased VALUE',
    },
  },
  {
    name: 'NODESCENT — repair.js stops descending into array items, every enum left declared',
    file: 'repair',
    find: "    const itemProps = spec?.type === 'array' && spec.items?.properties;",
    replace: '    const itemProps = null;   // SCRIPTED REVERT: repairBody stops walking into array items',
    run: runGateC,
    expect: /judge sweep measured/i,
    expectRaw: /portfolio-gate leg side:"SHORT" -> net 200000 long 200000 short 0/,
  },
  {
    name: 'MCPONLY — the option-type enum removed from services.js and LEFT in mcp.js (the decorative state)',
    file: 'services',
    find: "              type: { type: 'string', enum: ['call', 'put'], description: 'call | put' }, strike: { type: 'number' },",
    replace: "              type: { type: 'string', description: 'call | put' }, strike: { type: 'number' },   // SCRIPTED REVERT",
    run: runGateC,
    expect: /advertised on the MCP surface|judge sweep measured/i,
    expectRaw: /declares an enum that services\.js does not — advertised, never enforced/,
  },
];

console.log('GATE C REVERT — proving the case-sensitivity gate can fail, and that the old gates could not\n');

const originals = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
for (const r of REVERTS) {
  if (!originals[r.file].includes(r.find)) {
    console.error(`The code this revert removes is no longer in ${F[r.file]}:\n  ${r.name}`);
    console.error(`  missing literal: ${r.find.slice(0, 100)}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const baseC = runGateC();
console.log(`  baseline gate C : ${baseC.pass} pass, ${baseC.fail} fail`);
if (baseC.fail !== 0 || baseC.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}
// The older gates are baselined BEFORE anything is reverted, so "stayed green" below is measured
// against what they actually do on this tree rather than against an assumption that they are all green.
const BASE = { preflight: runPreflight(), buyer: runGateBuyer() };
console.log(`  baseline preflight : ${BASE.preflight.pass} pass, ${BASE.preflight.fail} fail`
  + `${BASE.preflight.fail ? ` (pre-existing, not this change: ${BASE.preflight.failedNames.join('; ')})` : ''}`);
console.log(`  baseline gateBuyer : ${BASE.buyer.pass} pass, ${BASE.buyer.fail} fail`);

const BACKUPS = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, `${p}.revert-backup`]));
for (const [k, p] of Object.entries(F)) copyFileSync(p, BACKUPS[k]);
const restore = () => { for (const [k, p] of Object.entries(F)) writeFileSync(p, originals[k]); };

const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(F[r.file], originals[r.file].replace(r.find, r.replace));
    const out = r.run();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate C against reverted code : ${out.pass} pass, ${out.fail} fail`);
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
    restore();   // measured one at a time, never on a pile
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

const backC = runGateC();
console.log(`  gate C against restored code : ${backC.pass} pass, ${backC.fail} fail\n`);

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
const cameBack = backC.fail === 0 && backC.pass === baseC.pass;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] gate C is green again once the files are restored`);
ok = ok && cameBack;

console.log(`\nGATE C REVERT: ${ok ? 'PASSED — the gate is capable of failing, and the pre-existing gates are shown blind to the defect it owns' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
