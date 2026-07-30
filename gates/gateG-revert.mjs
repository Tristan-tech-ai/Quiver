// The scripted revert for gate G.
//
// Gate G was written after a measurement failed, by somebody who already knew the answer, which is the
// exact circumstance under which this repository has twice shipped a check that could not fail. So each
// correction is put back one at a time and gate G is required to go RED — and to go GREEN again once the
// file is restored, because red in both states is a broken gate rather than a working one.
//
//   1. CTXGUARD     src/services.js goes back to `host: ctx.host`, both occurrences, exactly as it
//                   stood when a classification sweep read a TypeError as a fact about chart-press.
//                   Gate G must go red on check 2, the ctx-omitted sweep, which names both chart-press
//                   forms. MEASURED, and the measurement corrected this line: check 4 stays GREEN,
//                   because check 4 builds its table with a ctx supplied — as the HTTP surface does.
//                   So check 2 is the ONLY thing in the tree standing between it and a handler no
//                   checker can invoke, which is a reason to keep check 2 rather than a reason to
//                   widen check 4 into a second copy of it.
//                   THE COMPANION IS THE POINT: preflight must STAY GREEN. It calls every MCP tool with
//                   a real fixture body, and chart-press is not on the MCP surface — TOOLS carries the
//                   nine risk tools — so the most thorough existing invocation sweep in the tree never
//                   calls this handler at all. That is how an uninvokable handler stayed uninvokable.
//   2. TWOBUCKETS   the ORIGINAL sweep's classifier, restored inside gate G itself: `envelopeOf` loses
//                   its REFUSAL arm and knows only PROOF and OBSERVATION. Check 7 must go red. This is
//                   the second half of the original 20-of-22 — poly-fill's `callerMistake` answer was
//                   not unclassifiable, it was a third bucket the sweep had no name for.
//   3. FIXTUREDRIFT one fixture body in gates/routing-fixtures.mjs is edited off its own schema.
//                   Check 1 must go red, because every row of the table is a claim about these bodies
//                   and a drifted fixture makes the whole table a fiction rather than a measurement.
//
//   node gates/gateG-revert.mjs        (npm run gate:g-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SR = join(ROOT, '..', '..');   // "research startup"
const F = {
  services: join(ROOT, 'src', 'services.js'),
  gate: join(ROOT, 'gates', 'gateG-envelope-classification.mjs'),
  fixtures: join(ROOT, 'gates', 'routing-fixtures.mjs'),
  // The REPORT, both copies. Check 8 asserts they are byte-identical as well as correct, so the
  // DOCFIGURE revert edits BOTH — reverting one would go red on the divergence assertion instead of on
  // the claim, and would demonstrate a different property from the one it is here to demonstrate.
  docHack: join(SR, 'hackathon', 'WIRE_CLASSIFY_TWO.md'),
  docQuiver: join(SR, 'Quiver', 'docs', 'wire-classify-two.md'),
};

// ── runners ──────────────────────────────────────────────────────────────────────────────────────
function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateG-envelope-classification.mjs')],
    { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary for gate G — the numbers below would be invented');
  }
  const failedNames = [...new Set([
    ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
    ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
  ])];
  if (fail > 0 && !failedNames.length) {
    console.error(out);
    throw new Error(`gate G reported ${fail} failure(s) and this script could not name any of them`);
  }
  return { pass, fail, failedNames, raw: out };
}

// Preflight is a script with an exit code and a `[PASS] / [*** FAIL ***]` ledger, not a test runner.
function runPreflight() {
  const r = spawnSync(process.execPath, [join(ROOT, 'gates', 'preflight.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
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
// Each `find` is a literal that MUST be present, and `occurrences` is asserted rather than assumed, so
// a revert that half-applies refuses to run instead of reporting a meaningless colour.
const REVERTS = [
  {
    name: 'CTXGUARD — src/services.js dereferences ctx unguarded again, both occurrences',
    file: 'services',
    find: "host: ctx?.host })",
    replace: "host: ctx.host })   /* SCRIPTED REVERT */",
    occurrences: 2,
    expect: /survives its ctx being omitted/i,
    expectRaw: /chart-press#0: Cannot read propert/,
    alsoAssert: {
      run: runPreflight,
      staysGreen: /every MCP tool survives both an empty argument set and a body it actually accepts/i,
      because: 'preflight invokes the nine MCP tools with real fixture bodies and chart-press is not one of them, so the tree\'s most thorough invocation sweep never called this handler',
    },
  },
  {
    name: 'TWOBUCKETS — the original sweep\'s classifier: PROOF or OBSERVATION, no third bucket',
    file: 'gate',
    find: "const envelopeOf = (r) => (r?.proof ? 'PROOF' : r?.observation ? 'OBSERVATION' : r?.ok === false ? 'REFUSAL' : 'NEITHER');",
    replace: "const envelopeOf = (r) => (r?.proof ? 'PROOF' : r?.observation ? 'OBSERVATION' : 'NEITHER');   /* SCRIPTED REVERT */",
    occurrences: 1,
    expect: /carries neither proof nor observation/i,
    expectRaw: /expected the refusal envelope, got NEITHER/,
  },
  {
    name: 'FIXTUREDRIFT — one fixture body edited off the schema its own service declares',
    file: 'fixtures',
    find: "  'event-vol':      [{ spot: 60000, atmIvPct: 55, daysToEvent: 7 }],",
    replace: "  'event-vol':      [{ spot: 60000, atmIvPct: 55 }],   /* SCRIPTED REVERT */",
    occurrences: 1,
    expect: /accepted by the validator of the service it names/i,
    expectRaw: /require spot>0, atmIv\/atmIvPct, and daysToEvent\/T/,
  },
  {
    // NOT A HYPOTHETICAL. This is the sentence as it actually stood when the report was re-read on
    // 30 July, and it was already wrong: `event-vol` and `lp-risk` were wired by sibling sessions after
    // it was written. Putting it back is putting back a defect that shipped, not inventing one.
    name: 'DOCFIGURE — the report\'s pinned proof-emitting set back to the four services it shipped claiming',
    file: ['docHack', 'docQuiver'],
    find: '`perp-gate`, `size-gate`, `treasury-risk`, `exec-verify`, `event-vol` and `lp-risk` on both surfaces —\n'
      + 'twelve entries of 31 handlers (22 HTTP + 9 MCP), and the other 19 build no proof.',
    replace: '`perp-gate`, `size-gate`, `treasury-risk`, `exec-verify` on both surfaces —\n'
      + 'eight entries of 31 handlers (22 HTTP + 9 MCP), and the other 23 build no proof.',
    occurrences: 1,
    expect: /quotes the proof-emitting set preflight actually pins/i,
    expectRaw: /the report names \[exec-verify, perp-gate, size-gate, treasury-risk\] as the proof-emitting set/,
  },
];

console.log('GATE G REVERT — proving the envelope-classification gate can fail\n');

const originals = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
// A revert may name one file or several. `occurrences` is asserted in EVERY file it names, so a
// multi-file revert that half-applies — the exact way a mirrored doc drifts — refuses to run.
const filesOf = (r) => (Array.isArray(r.file) ? r.file : [r.file]);
for (const r of REVERTS) {
  for (const key of filesOf(r)) {
    const n = originals[key].split(r.find).length - 1;
    if (n !== r.occurrences) {
      console.error(`The code this revert removes is not in ${F[key]} the expected number of times:\n  ${r.name}`);
      console.error(`  literal: ${r.find.slice(0, 100)}`);
      console.error(`  found ${n} occurrence(s), expected ${r.occurrences}`);
      console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
      process.exit(2);
    }
  }
}

const base = runGate();
console.log(`  baseline gate G : ${base.pass} pass, ${base.fail} fail`);
if (base.fail !== 0 || base.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

const BACKUPS = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, `${p}.revert-backup`]));
for (const [k, p] of Object.entries(F)) copyFileSync(p, BACKUPS[k]);
const restore = () => { for (const [k, p] of Object.entries(F)) writeFileSync(p, originals[k]); };

const results = [];
try {
  for (const r of REVERTS) {
    for (const key of filesOf(r)) writeFileSync(F[key], originals[key].split(r.find).join(r.replace));
    const out = runGate();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate G against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);
    const hit = (out.raw.match(r.expectRaw) || [])[0];
    console.log(`      NAMED: ${hit || '(the gate did not name the thing this revert broke)'}`);
    let blind = null;
    if (r.alsoAssert) {
      const o2 = r.alsoAssert.run();
      const stillPassing = o2.fail === 0 && o2.passedNames.some((n) => r.alsoAssert.staysGreen.test(n));
      blind = { stillPassing, because: r.alsoAssert.because };
      console.log(`      BLIND SPOT: the older check ${stillPassing ? 'STAYED GREEN' : 'went red'} — ${r.alsoAssert.because}`);
    }
    results.push({ ...r, out, named: out.failedNames.filter((n) => r.expect.test(n)), rawHit: r.expectRaw.test(out.raw), blind });
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

const back = runGate();
console.log(`  gate G against restored code : ${back.pass} pass, ${back.fail} fail\n`);

console.log('='.repeat(78));
let ok = back.fail === 0 && back.pass === base.pass;
if (!ok) console.log(`  [*** FAIL ***] gate G did not return to its baseline (${base.pass} pass, 0 fail) after restore`);
for (const r of results) {
  const wentRed = r.out.fail > 0;
  const rightCheck = r.named.length > 0;
  const blindOk = !r.alsoAssert || r.blind.stillPassing;
  const good = wentRed && rightCheck && r.rawHit && blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'PASS' : '*** FAIL ***'}] ${r.name}`);
  console.log(`           ${wentRed ? `${r.out.fail} check(s) failed` : 'THE GATE STAYED GREEN'}`
    + `${rightCheck ? `, including: ${r.named[0]}` : ', but not the check that owns this claim'}`);
  console.log(`           ${r.rawHit ? 'and it named the exact thing the revert broke' : 'but it did not name what broke — the check may be firing for another reason'}`);
  if (r.alsoAssert) {
    console.log(`           ${blindOk ? 'and the OLDER sweep stayed green over the same defect — the blind spot is real'
      : 'the older sweep also went red — this revert does not demonstrate a blind spot'}`);
  }
}
console.log('='.repeat(78));
console.log(ok ? '\nGATE G REVERT PASSED — every correction is load-bearing and the gate can fail.\n'
  : '\n*** GATE G REVERT FAILED — a correction above is not being checked by anything. ***\n');
process.exit(ok ? 0 : 1);
