// The scripted revert for gates P and P2.
//
// A check written after a defect is a check written by somebody who already knows the answer, and
// this repository has twice shipped one that could not fail. So each fix is put back, one at a time,
// and the gate that owns it is required to go RED — and to go GREEN again once the file is restored,
// because red-in-both-states is a broken gate rather than a working one.
//
//   1. X402DETAIL   src/x402.js stops carrying `err.detail`, exactly as it shipped. Gate P must go
//                   red. The COMPANION assertion is the point of the whole exercise: gateBuyer, the
//                   gate whose entire subject is the buyer-defence teaching layer, must STAY GREEN —
//                   it calls repairBody/correctedExample directly and never once puts a payment
//                   header on a request. That is how this survived on the surface that bills.
//   2. PORTFOLIO    src/services.js stops disclosing the venue read on portfolio-gate's explicit
//                   positions. Gate P2 must go red; preflight must stay green, because nothing in it
//                   ever asked whether an echoed input was supplied or fetched.
//   3. MCPONLY      the SAME disclosure removed from src/mcp.js alone, with services.js left fixed.
//                   Gate P2 must still go red and must name the mcp surface — the demonstration that
//                   the sweep covers both surfaces rather than the one that was fixed first, which is
//                   the failure mode §11.6 of the paper records four times over.
//
//   node gates/gateP-revert.mjs        (npm run gate:p-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const F = {
  x402: join(ROOT, 'src', 'x402.js'),
  services: join(ROOT, 'src', 'services.js'),
  mcp: join(ROOT, 'src', 'mcp.js'),
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
const runGateP = runTestFile('gateP-paid-teaching.mjs');
const runGateP2 = runTestFile('gateP-sealed-provenance.mjs');
const runGateBuyer = runTestFile('gateBuyer-mistakes.mjs');

// Preflight is a script with an exit code and a `[PASS] / [*** FAIL ***]` ledger, not a test runner.
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
const DISCLOSE = '        const fetchedLegs = legsFetchedLive(base.positions, positions);';
const UNDISCLOSE = '        const fetchedLegs = [];   // SCRIPTED REVERT: the venue read goes back undisclosed';

const REVERTS = [
  {
    name: 'X402DETAIL — the paid path drops err.detail again (the code as it shipped)',
    file: 'x402',
    find: '      return res.status(status).json(refusalBody(e, status, code));',
    replace: "      return res.status(status).json({ error: code, detail: String(e.message || e).replace(/^bad_input:\\s*/, '') });   // SCRIPTED REVERT",
    run: runGateP,
    expect: /handed a corrected body|DIFFERENTIAL/i,
    alsoAssert: {
      run: runGateBuyer,
      staysGreen: /refusal is actionable for every one of the twenty-two/i,
      because: 'gateBuyer calls repairBody/correctedExample directly and never sends a payment header — the teaching it certifies is the teaching on the surface that does not bill',
    },
  },
  {
    name: 'PORTFOLIO — src/services.js stops disclosing the venue read on explicit positions',
    file: 'services',
    find: DISCLOSE,
    replace: UNDISCLOSE,
    run: runGateP2,
    expect: /did not supply|decided on purpose/i,
    expectRaw: /http:portfolio-gate#0 sealed/,
    alsoAssert: {
      run: runPreflight,
      staysGreen: /repair leaves every already-valid body byte-identical/i,
      because: 'preflight replays bodies through repairBody and never asks whether an echoed input was supplied or fetched',
    },
  },
  {
    name: 'MCPONLY — the same disclosure removed from src/mcp.js alone, services.js left fixed',
    file: 'mcp',
    find: DISCLOSE,
    replace: UNDISCLOSE,
    run: runGateP2,
    expect: /did not supply|decided on purpose/i,
    // The whole reason this gate sweeps both handler arrays. A one-surface fix must not read green.
    expectRaw: /mcp:portfolio_gate#0 sealed/,
  },
];

console.log('GATE P REVERT — proving the paid-teaching gate and the sealed-provenance gate can fail\n');

const originals = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
for (const r of REVERTS) {
  if (!originals[r.file].includes(r.find)) {
    console.error(`The code this revert removes is no longer in ${F[r.file]}:\n  ${r.name}`);
    console.error(`  missing literal: ${r.find.slice(0, 90)}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const baseP = runGateP();
const baseP2 = runGateP2();
console.log(`  baseline gate P  (paid teaching)      : ${baseP.pass} pass, ${baseP.fail} fail`);
console.log(`  baseline gate P2 (sealed provenance)  : ${baseP2.pass} pass, ${baseP2.fail} fail`);
if (baseP.fail !== 0 || baseP.pass === 0 || baseP2.fail !== 0 || baseP2.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

const restore = () => { for (const [k, p] of Object.entries(F)) writeFileSync(p, originals[k]); };
const BACKUPS = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, `${p}.revert-backup`]));
for (const [k, p] of Object.entries(F)) copyFileSync(p, BACKUPS[k]);

const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(F[r.file], originals[r.file].replace(r.find, r.replace));
    const out = r.run();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);
    if (r.expectRaw) {
      const hit = (out.raw.match(r.expectRaw) || [])[0];
      console.log(`      NAMED: ${hit || '(the gate did not name the surface this revert broke)'}`);
    }
    let blind = null;
    if (r.alsoAssert) {
      const o2 = r.alsoAssert.run();
      const stillPassing = o2.fail === 0 && o2.passedNames.some((n) => r.alsoAssert.staysGreen.test(n));
      blind = { stillPassing, because: r.alsoAssert.because };
      console.log(`      BLIND SPOT: the older check ${stillPassing ? 'STAYED GREEN' : 'went red'} — ${r.alsoAssert.because}`);
    }
    results.push({ ...r, out, named: out.failedNames.filter((n) => r.expect.test(n)), rawHit: !r.expectRaw || r.expectRaw.test(out.raw), blind });
    restore();   // measured one at a time, never on a pile
  }
} finally {
  // In `finally` because leaving a reverted source file behind after a crash is far worse than a
  // failed gate: the next run would look green against code nobody meant to ship.
  for (const [k, p] of Object.entries(F)) { copyFileSync(BACKUPS[k], p); rmSync(BACKUPS[k], { force: true }); }
  const bad = Object.entries(F).filter(([k, p]) => readFileSync(p, 'utf8') !== originals[k]).map(([k]) => k);
  if (bad.length) {
    console.error(`*** RESTORE FAILED for ${bad.join(', ')} — restore from the mirror before doing anything else ***`);
    process.exit(3);
  }
  console.log('\n  all files restored');
}

const backP = runGateP();
const backP2 = runGateP2();
console.log(`  gate P  against restored code : ${backP.pass} pass, ${backP.fail} fail`);
console.log(`  gate P2 against restored code : ${backP2.pass} pass, ${backP2.fail} fail\n`);

console.log('='.repeat(78));
let ok = true;
for (const r of results) {
  const wentRed = r.out.fail > 0;
  const rightCheck = r.named.length > 0;
  const namedSurface = r.rawHit;
  const blindOk = !r.alsoAssert || r.blind.stillPassing;
  const good = wentRed && rightCheck && namedSurface && blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'PASS' : '*** FAIL ***'}] ${r.name}`);
  console.log(`           ${wentRed ? `${r.out.fail} check(s) failed` : 'THE GATE STAYED GREEN'}`
    + `${rightCheck ? `, including: ${r.named[0]}` : ', but not the check that owns this claim'}`);
  if (r.expectRaw) console.log(`           ${namedSurface ? 'and it named the exact surface the revert broke' : 'but it did not name the surface — the sweep may not reach it'}`);
  if (r.alsoAssert) {
    console.log(`           ${blindOk ? 'and the OLDER gate stayed green over the same defect — the blind spot is real'
      : 'the older gate also went red — this revert does not demonstrate a blind spot'}`);
  }
}
const cameBack = backP.fail === 0 && backP.pass === baseP.pass && backP2.fail === 0 && backP2.pass === baseP2.pass;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] both gates are green again once the files are restored`);
ok = ok && cameBack;

console.log(`\nGATE P REVERT: ${ok ? 'PASSED — each new check is capable of failing, and the old ones are shown blind' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
