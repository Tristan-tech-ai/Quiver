// The scripted revert for gate M and for the preflight grid guard.
//
// Every one of the four fixes below was found by an outside reviewer against the LIVE service, and
// three of the four were sitting behind checks that were green. So "the new check would have caught
// it" is exactly the kind of claim this project has learned not to accept on reasoning. This script
// puts each defect back, one at a time, and requires the check that owns it to go RED — and requires
// it to go GREEN again once the file is restored, because red-in-both-states is a broken gate rather
// than a working one.
//
//   1. IMPORT     drop `fetchHlAccount` from src/mcp.js. This is the code as it shipped: the live
//                 ReferenceError on portfolio_gate's advertised account mode must come back, and gate
//                 M's account-mode case must fail. Preflight's own "every MCP tool survives" check
//                 must STAY GREEN under this revert — that is the blind spot being demonstrated, not
//                 a bug in this script.
//   2. POLYFILL   remove the no-match conversion. A caller's typo must go back to being a thrown
//                 error, which app.js and x402.js both render as HTTP 500 `engine_error`.
//   3. TAPEPULSE  remove the chain/address pre-check and the upstream backstop. The mismatch must go
//                 back to reaching OKX and returning its `{"code":"51000"}` string verbatim.
//   4. GRIDSNAP   un-snap the MCP perp_gate handler. Preflight's grid check must go RED — under the
//                 OLD guard it could not, because the guard read only `SERVICES.map(s => s.run)` and
//                 never looked at the MCP handler array. Reverted alongside it, to make that
//                 blindness visible rather than asserted.
//
//   node gates/gateM-revert.mjs        (npm run gate:m-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const F = {
  mcp: join(ROOT, 'src', 'mcp.js'),
  services: join(ROOT, 'src', 'services.js'),
  preflight: join(ROOT, 'gates', 'preflight.mjs'),
};

// ── runners ──────────────────────────────────────────────────────────────────────────────────────
function runGateM() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateM-mcp-surface.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary — the numbers below would be invented');
  }
  const failedNames = [...new Set([
    ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
    ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
  ])];
  if (fail > 0 && !failedNames.length) {
    console.error(out);
    throw new Error(`the runner reported ${fail} failure(s) and this script could not name any of them`);
  }
  return { pass, fail, failedNames };
}

// Preflight is a script with an exit code and a `[PASS] / [*** FAIL ***]` ledger, not a test runner.
function runPreflight() {
  const r = spawnSync(process.execPath, [join(ROOT, 'gates', 'preflight.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = [...out.matchAll(/^ {2}\[PASS\] (.+)$/gm)].map((m) => m[1].trim());
  const failedNames = [...out.matchAll(/^ {2}\[\*\*\* FAIL \*\*\*\] (.+)$/gm)].map((m) => m[1].trim());
  if (!pass.length && !failedNames.length) {
    console.error(out);
    throw new Error('preflight printed no check ledger — the numbers below would be invented');
  }
  return { pass: pass.length, fail: failedNames.length, failedNames, passedNames: pass };
}

// ── the reverts ──────────────────────────────────────────────────────────────────────────────────
// Each `find` is a literal that MUST be present, so a revert that no longer applies refuses to run
// rather than reporting a meaningless green.
const REVERTS = [
  {
    name: 'IMPORT — src/mcp.js stops importing fetchHlAccount (the code as it shipped)',
    file: 'mcp',
    find: "import { enrichPerpInputs, enrichPortfolioLegs, fetchHlAccount } from './adapters/hyperliquid.js';",
    replace: "import { enrichPerpInputs, enrichPortfolioLegs } from './adapters/hyperliquid.js';   // SCRIPTED REVERT",
    run: runGateM,
    expect: /portfolio_gate — account mode/i,
    // The point of the whole exercise: the check that was supposed to cover this surface does not
    // move when the defect is restored. Asserted, not narrated.
    alsoAssert: {
      run: runPreflight,
      staysGreen: /every MCP tool survives a wrapped, empty argument set/i,
      because: 'preflight sends `{ params: {} }` to all nine tools, which never reaches the 0x… branch',
    },
  },
  {
    name: 'POLYFILL — the no-match conversion is removed, so a typo throws again (HTTP 500)',
    file: 'services',
    find: "        if (/no active Polymarket market matched/.test(String(e.message || ''))) {",
    replace: "        if (false) {   // SCRIPTED REVERT: a caller's typo becomes engine_error again",
    run: runGateM,
    expect: /poly-fill/i,
  },
  {
    name: 'TAPEPULSE — the chain/address pre-check and the upstream backstop are removed',
    file: 'services',
    find: "      const mism = chainAddressMismatch(i.chain, i.address);\n      if (mism) return callerMistake('tape-pulse', mism.diagnosis, { chain: mism.chain, address: i.address }, { suggestedChains: mism.suggested });",
    replace: "      const mism = null;   // SCRIPTED REVERT: the mismatch reaches OKX again",
    also: {
      find: "        if (/tokenContractAddress param is error|\"code\":\"51000\"/.test(String(e.message || ''))) {",
      replace: '        if (false) {   // SCRIPTED REVERT: the raw upstream string is thrown again',
    },
    run: runGateM,
    expect: /tape-pulse/i,
  },
  {
    name: 'GRIDSNAP — the MCP perp_gate handler stops snapping onto the circuit grid',
    file: 'mcp',
    find: "      const compute = gridSnapFields(raw, ['entryPrice', 'size', 'notional', 'margin', 'leverage', 'maintMarginRate', 'maxLeverage', 'markPrice']);",
    replace: '      const compute = raw;   // SCRIPTED REVERT: proof certifies a neighbouring position again',
    run: runPreflight,
    expect: /snaps its inputs onto that grid/i,
    // And the same revert against the OLD guard, to show the blindness rather than claim it.
    oldGuard: {
      file: 'preflight',
      find: 'const handlers = [\n  ...SERVICES.map((s) => ({ surface: \'http\', name: s.name, body: String(s.run || \'\') })),\n  ...TOOLS.map((t) => ({ surface: \'mcp\', name: t.name, body: String(t.run || \'\') })),\n];',
      replace: "const handlers = [\n  ...SERVICES.map((s) => ({ surface: 'http', name: s.name, body: String(s.run || '') })),\n];   // SCRIPTED REVERT: the guard as it was — it cannot see the MCP handlers at all",
      staysGreen: /snaps its inputs onto that grid/i,
      because: 'the guard read SERVICES only, so the MCP handler it should judge was never in the set',
    },
  },
];

console.log('GATE M REVERT — proving the MCP-surface gate and the grid guard can fail\n');

const originals = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
for (const r of REVERTS) {
  const src = originals[r.file];
  const missing = [r.find, r.also?.find].filter(Boolean).filter((f) => !src.includes(f));
  if (missing.length) {
    console.error(`The code this revert removes is no longer in ${F[r.file]}:\n  ${r.name}`);
    console.error(`  missing literal: ${missing[0].slice(0, 90)}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
  if (r.oldGuard && !originals[r.oldGuard.file].includes(r.oldGuard.find)) {
    console.error(`The old-guard revert no longer applies in ${F[r.oldGuard.file]} — refusing to run.`);
    process.exit(2);
  }
}

const baselineM = runGateM();
console.log(`  baseline gate M   : ${baselineM.pass} pass, ${baselineM.fail} fail`);
const baselineP = runPreflight();
console.log(`  baseline preflight: ${baselineP.pass} pass, ${baselineP.fail} fail`);
if (baselineM.fail !== 0 || baselineM.pass === 0 || baselineP.fail !== 0 || baselineP.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

const restore = () => {
  for (const [k, p] of Object.entries(F)) writeFileSync(p, originals[k]);
};

const results = [];
const BACKUPS = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, `${p}.revert-backup`]));
for (const [k, p] of Object.entries(F)) copyFileSync(p, BACKUPS[k]);
try {
  for (const r of REVERTS) {
    let src = originals[r.file].replace(r.find, r.replace);
    if (r.also) src = src.replace(r.also.find, r.also.replace);
    writeFileSync(F[r.file], src);

    const out = r.run();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);

    // The companion assertion: a DIFFERENT check that must stay green, demonstrating the blind spot.
    let blind = null;
    if (r.alsoAssert) {
      const o2 = r.alsoAssert.run();
      const stillPassing = (o2.passedNames || []).some((n) => r.alsoAssert.staysGreen.test(n));
      blind = { stillPassing, because: r.alsoAssert.because };
      console.log(`      BLIND SPOT: the old check ${stillPassing ? 'STAYED GREEN' : 'went red'} — ${r.alsoAssert.because}`);
    }
    // The old-guard demonstration: same defect, guard as it was, must stay green.
    let oldGuard = null;
    if (r.oldGuard) {
      writeFileSync(F[r.oldGuard.file], originals[r.oldGuard.file].replace(r.oldGuard.find, r.oldGuard.replace));
      const o3 = runPreflight();
      const stillPassing = (o3.passedNames || []).some((n) => r.oldGuard.staysGreen.test(n));
      oldGuard = { stillPassing, because: r.oldGuard.because };
      console.log(`      OLD GUARD: same defect, guard as it was — ${stillPassing ? 'STAYED GREEN' : 'went red'} — ${r.oldGuard.because}`);
      writeFileSync(F[r.oldGuard.file], originals[r.oldGuard.file]);
    }

    results.push({ ...r, out, named: out.failedNames.filter((n) => r.expect.test(n)), blind, oldGuard });
    restore();   // measured one at a time, never on a pile
  }
} finally {
  // In `finally` because leaving a reverted source file behind after a crash is far worse than a
  // failed gate: the next run would look green against code nobody meant to ship.
  for (const [k, p] of Object.entries(F)) { copyFileSync(BACKUPS[k], p); rmSync(BACKUPS[k], { force: true }); }
  const bad = Object.entries(F).filter(([k, p]) => readFileSync(p, 'utf8') !== originals[k]).map(([k]) => k);
  if (bad.length) {
    console.error(`*** RESTORE FAILED for ${bad.join(', ')} — restore from git before doing anything else ***`);
    process.exit(3);
  }
  console.log('\n  all files restored');
}

const restoredM = runGateM();
const restoredP = runPreflight();
console.log(`  gate M against restored code    : ${restoredM.pass} pass, ${restoredM.fail} fail`);
console.log(`  preflight against restored code : ${restoredP.pass} pass, ${restoredP.fail} fail\n`);

console.log('='.repeat(78));
let ok = true;
for (const r of results) {
  const wentRed = r.out.fail > 0;
  const rightCheck = r.named.length > 0;
  const blindOk = !r.alsoAssert || r.blind.stillPassing;
  const oldOk = !r.oldGuard || r.oldGuard.stillPassing;
  ok = ok && wentRed && rightCheck && blindOk && oldOk;
  console.log(`  [${wentRed && rightCheck && blindOk && oldOk ? 'PASS' : '*** FAIL ***'}] ${r.name}`);
  console.log(`           ${wentRed ? `${r.out.fail} check(s) failed` : 'THE GATE STAYED GREEN'}`
    + `${rightCheck ? `, including: ${r.named[0]}` : ', but not the check that owns this claim'}`);
  if (r.alsoAssert) {
    console.log(`           ${blindOk ? 'and the OLD check stayed green over the same defect — the blind spot is real'
      : 'the old check also went red — this revert does not demonstrate a blind spot'}`);
  }
  if (r.oldGuard) {
    console.log(`           ${oldOk ? 'and the OLD guard stayed green over the same defect — the blind spot is real'
      : 'the old guard also went red — this revert does not demonstrate a blind spot'}`);
  }
}
const cameBack = restoredM.fail === 0 && restoredM.pass === baselineM.pass && restoredP.fail === 0 && restoredP.pass === baselineP.pass;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] both gates are green again once the files are restored`);
ok = ok && cameBack;

console.log(`\nGATE M REVERT: ${ok ? 'PASSED — every new check is capable of failing, and each old one is shown blind' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
