// The scripted revert for gate K.
//
// "The Kelly guard refuses a real divergence" is a claim about a verifier, and it is the one category
// of claim that has to be executed rather than argued. Gate K was written after the guard it guards,
// so of course it passes; that says nothing about whether it would catch the thing it was written for.
// This script puts a defect back — six of them, one at a time — and requires gate K to go RED for each,
// then restores the file and requires GREEN again. Red in both states would mean broken rather than
// strict, so both halves are required.
//
// The six are deliberately not variations on one theme.
//
// FOUR ARE GENUINE WITNESS/ENGINE MISMATCHES — the circuit is handed a bet the engine did not size —
// and each is a shape this repository has actually shipped somewhere:
//
//   1. THE ENCODER DRIFTS. One grid step is added to the encoded odds. The witness now certifies a bet
//      1e-9 of odds away from the one that was sized; the answer is untouched and the served fraction
//      does not move at 6dp, so nothing a reader can see changes. This is the shape the liquidation
//      encoder had, at a different scale.
//   2. THE ALGEBRA IS REARRANGED. `engineKellyFraction` is replaced by `(pw*b + pw - 1)/b`, which is
//      the same identity and a different double. This is the `constantproduct` defect verbatim — equal
//      on paper, different in floating point — and it is the reason K.1 compiles the engine's own
//      source line instead of reading it. It is also the single most tempting edit in this file,
//      because the rearranged form looks tidier.
//   3. THE SOLVE ROUNDS THE WRONG WAY. `roundDiv` is replaced by truncation inside the canonical Kelly
//      solve. Truncation is off by up to a full grid step instead of half of one, so `2|R| <= b̂` — the
//      circuit's own statement — stops holding by construction. K.3's `circuitHolds` is the assertion
//      that notices, before any proof is attempted.
//   4. THE WITNESS READS THE DISPLAYED FRACTION. `fHat` is taken from `round(f*, 6)` — the number the
//      response publishes — instead of from the integer solve. This is the exact mistake the
//      liquidation witness makes if it reads the echoed `round(M, 2)` margin, and it is the one a
//      careful person is most likely to make, because using the service's own published number feels
//      more honest than recomputing.
//
// TWO ATTACK THE MEASUREMENT RATHER THAN THE ARITHMETIC:
//
//   5. THE BOUND IS WIDENED to the display half-unit. Nothing is mis-certified; the guard simply stops
//      being able to tell. K.3's "the worst honest bet uses a real part of the bound" is the only thing
//      standing between that and a green board.
//   6. THE DISPLAY ROUNDING DRIFTS from the engine's — 6dp becomes 5dp. K.2 must die, and K.3 with it,
//      because the recomputed fraction stops reproducing the served answer.
//
// It also reads the engine build id before and after. Nothing here touches src/engine/, and the
// published q1-e1fa99d08887d6cc must be the same string on both sides of a script that rewrites files.
//
//   node gates/gateK-revert.mjs
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SNARK_JS = join(ROOT, 'src', 'util', 'snark.js');
const SCALE_CJS = join(ROOT, 'src', 'util', 'scale.cjs');

const REVERTS = [
  {
    id: 1,
    file: SNARK_JS,
    what: 'the encoder drifts one grid step on the odds — a bet 1e-9 from the one that was sized',
    from: '    enc = scale.toKellyCircuitInputs({ p, b });',
    to: '    enc = scale.toKellyCircuitInputs({ p, b }); enc.bHat += 1n;   // SCRIPTED REVERT: the encoder drifts',
    expect: /^K\.3/,
    expectDesc: 'K.3, the assertion that the witness agrees with the engine',
  },
  {
    id: 2,
    file: SCALE_CJS,
    what: 'the engine expression is rearranged into a mathematically equal, numerically different form',
    from: '  return (pw * (b + 1) - 1) / b;',
    to: '  return (pw * b + pw - 1) / b;   // SCRIPTED REVERT: rearranged algebra',
    expect: /^K\.[13]/,
    expectDesc: 'K.1, which compiles the engine\'s own line and requires Object.is agreement',
  },
  {
    id: 3,
    file: SCALE_CJS,
    what: 'the canonical solve truncates instead of rounding — off by a whole step, not half of one',
    from: '  return roundDiv(pHat * bHat + SCALE * pHat - SCALE * SCALE, bHat);',
    to: '  return (pHat * bHat + SCALE * pHat - SCALE * SCALE) / bHat;   // SCRIPTED REVERT: truncation',
    expect: /^K\.[34]/,
    expectDesc: 'K.3, where 2|R| <= b̂ stops holding, and K.4, where the exact case stops being exact',
  },
  {
    id: 4,
    file: SNARK_JS,
    what: 'the witness reads the DISPLAYED fraction instead of the integer solve',
    from: '    enc = scale.toKellyCircuitInputs({ p, b });',
    to: '    enc = scale.toKellyCircuitInputs({ p, b }, scale.toScaled(Number(servedFullKelly), \'served\'));   // SCRIPTED REVERT: certifies round(f,6)',
    expect: /^K\.[34]/,
    expectDesc: 'K.3, where the certified fraction leaves the bound the encoding admits',
  },
  {
    id: 5,
    file: SNARK_JS,
    what: 'the bound is widened to the width the answer is merely displayed at',
    from: 'const KELLY_HALF_STEP = 0.5 / Number(scale.SCALE);',
    to: 'const KELLY_HALF_STEP = 0.5e-6;   // SCRIPTED REVERT: the bound stops measuring',
    expect: /^K\.3/,
    expectDesc: 'K.3, which requires the worst honest bet to use a real part of the bound',
  },
  {
    id: 6,
    file: SNARK_JS,
    what: 'the display rounding drifts from the engine\'s',
    from: 'const kellyDisplayRound = (x) => Number(Number(x).toFixed(6));',
    to: 'const kellyDisplayRound = (x) => Number(Number(x).toFixed(5));   // SCRIPTED REVERT: not the engine\'s rounding',
    expect: /^K\.[23]/,
    expectDesc: 'K.2, the drift check, and K.3, which stops reproducing the served answer',
  },
];

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateK-kelly-snark.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
    // The synthetic sweep is the slow half and every revert here shows up in the first few hundred
    // bets. Shrunk so six runs plus the restore stay quick; the full sweep is what the gate runs on
    // its own.
    env: { ...process.env, QUIVER_GATEK_SYNTHETIC: process.env.QUIVER_GATEK_SYNTHETIC || '20000' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary. The numbers below would be invented');
  }
  const named = [...new Set([...out.matchAll(/^✖ (K\.\d[^(]*)/gm)].map((m) => m[1].trim()))];
  return { pass, fail, named };
}

console.log('GATE K REVERT: proving the Kelly guard can still say no\n');

const hashBefore = buildId();
console.log(`  engine build id before : ${hashBefore}`);

const FILES = [...new Set(REVERTS.map((r) => r.file))];
const originals = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
const backupOf = (f) => join(dirname(f), `.${basename(f)}.revert-backup`);
const occurrences = (s, a) => { let c = 0, i = 0; while ((i = s.indexOf(a, i)) >= 0) { c++; i++; } return c; };
for (const rv of REVERTS) {
  const n = occurrences(originals.get(rv.file), rv.from);
  const want = rv.count ?? 1;
  if (n !== want) {
    console.error(`Revert ${rv.id}: its anchor occurs ${n} times in ${rv.file}, not ${want}.`);
    console.error('Refusing to run: a revert that does not apply, or applies where it was not meant to, reports a meaningless result.');
    process.exit(2);
  }
}

const outcomes = [];
for (const f of FILES) copyFileSync(f, backupOf(f));
try {
  for (const rv of REVERTS) {
    console.log(`\n  --- revert ${rv.id} (${basename(rv.file)}): ${rv.what}`);
    writeFileSync(rv.file, originals.get(rv.file).split(rv.from).join(rv.to));
    const res = runGate();
    console.log(`      gate against reverted code : ${res.pass} pass, ${res.fail} fail`);
    for (const n of res.named) console.log(`      red: ${n}`);
    outcomes.push({ rv, res });
    copyFileSync(backupOf(rv.file), rv.file);
  }
} finally {
  // Restored in `finally` because leaving a revert applied after a crash would be far worse than a
  // failed gate: the next run would look green against code that certifies a bet nobody asked about.
  let clean = true;
  for (const f of FILES) {
    copyFileSync(backupOf(f), f);
    rmSync(backupOf(f), { force: true });
    if (readFileSync(f, 'utf8') !== originals.get(f)) { clean = false; console.error(`*** RESTORE FAILED for ${f} — restore it before doing anything else ***`); }
  }
  if (!clean) process.exit(3);
  console.log(`\n  ${FILES.length} files restored`);
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail`);

const hashAfter = buildId();
console.log(`  engine build id after  : ${hashAfter}\n`);

let ok = true;
for (const { rv, res } of outcomes) {
  const wentRed = res.fail > 0;
  const hitTheRightOne = res.named.some((n) => rv.expect.test(n));
  console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] revert ${rv.id} makes gate K fail`);
  console.log(`  [${hitTheRightOne ? 'PASS' : '*** FAIL ***'}] and the failure is ${rv.expectDesc}`);
  ok = ok && wentRed && hitTheRightOne;
}
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and the gate PASSES again once every revert is undone (${restored.pass} pass, ${restored.fail} fail)`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
ok = ok && cameBack && hashHeld;

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE K REVERT: ${ok ? 'PASSED, the Kelly guard is capable of saying no' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
