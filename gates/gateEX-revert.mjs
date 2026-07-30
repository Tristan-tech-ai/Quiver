// The scripted revert for gate EX.
//
// "The adverse-execution guard refuses a real divergence" is a claim about a verifier, and a verifier
// that cannot fail is the disease this repository names. Gate EX was written after the guard it guards,
// so of course it passes; that says nothing about whether it would catch what it was written for. This
// script puts a defect back — seven of them, one at a time — requires gate EX to go RED for each, then
// restores every file and requires GREEN again. Red in both states would mean broken rather than
// strict, so both halves are required.
//
// The seven are deliberately not variations on one theme.
//
// FOUR ARE GENUINE WITNESS/ENGINE MISMATCHES — the circuit is handed a trade the engine did not price:
//
//   1. THE ENCODER DRIFTS. One grid step is added to the encoded benchmark fill. The certified
//      `honestOut` now describes a fill 1e-9 output tokens from the one the answer was computed from;
//      nothing a reader can see changes, because `round(honestOut, 8)` does not move. This is the shape
//      the liquidation encoder had, and the Kelly one after it.
//   2. THE ALGEBRA IS REARRANGED. `engineHonestOut` is replaced by `(y * dx * (1 - f)) / (x + dx *
//      (1 - f))`, which is the same identity and a different double. This is the `constantproduct`
//      defect verbatim — equal on paper, wrong by 64 grid steps in floating point — and it is the whole
//      reason EX.1 compiles the engine's own source line instead of reading it. It is also the most
//      tempting edit in scale.cjs, because the one-liner looks tidier than the two-line version.
//   3. THE SOLVE ROUNDS THE WRONG WAY. `roundDiv` becomes truncation inside `canonicalHonestOut`.
//      Truncation is off by up to a full grid step instead of half of one, so `2|R| <= x̂+în+ŷ−ô` — the
//      circuit's OWN statement about itself — stops holding by construction.
//   4. THE WITNESS READS THE DISPLAYED BENCHMARK. `outHat` is taken from `round(honestOut, 8)`, the
//      number the response publishes, instead of from the integer solve. This is the mistake a careful
//      person is most likely to make, because using the service's own published number feels more
//      honest than recomputing it, and gate B5-4 measured it at 30 grid steps.
//
// THREE ATTACK THE MEASUREMENT RATHER THAN THE ARITHMETIC, which is the harder half:
//
//   5. THE CEILING IS REMOVED. `EXEC_REL_CEILING` is widened by a factor of a million. Nothing is
//      mis-certified; the guard simply stops refusing the dust fills where a basis-point figure cannot
//      be pinned to the step it is published at. EX.9 is the only thing standing between that and a
//      green board.
//   6. THE BOUND IS WIDENED to the display step. The arithmetic is untouched and the guard stops being
//      able to tell anything. EX.7's "the bound is tight, not generous" is what notices.
//   7. THE BOX BECOMES A DERIVATIVE. `execEncodingShift` returns the linearisation instead of the
//      corner maximum. This is the subtlest of the seven and the one that was actually WRONG in this
//      file's first draft: the benchmark is concave in the effective input, so the linear term is not
//      an upper bound, and the worst honest case sat at 99.08% of a number that did not bound it.
//
// It also reads the engine build id before and after. Nothing here touches src/engine/, and the
// published q1-e1fa99d08887d6cc must be the same string on both sides of a script that rewrites files.
//
//   node gates/gateEX-revert.mjs
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
    what: 'the encoder drifts one grid step on the benchmark fill — a trade 1e-9 tokens from the one that was priced',
    from: '    enc = scale.toExecCircuitInputs({ dx, x, y, f, realized });',
    to: '    enc = scale.toExecCircuitInputs({ dx, x, y, f, realized }); enc.outHat += 1n;   // SCRIPTED REVERT: the encoder drifts',
    // MEASURED, not predicted, and the first draft of this file predicted it wrong. EX.9d does NOT go
    // red here: adding one grid step to the benchmark moves the invariant residual to 8.1e14 against a
    // tolerance of 1.0e15, so the circuit's own window still HOLDS. A drifted benchmark is a perfectly
    // satisfiable witness — which is precisely why the guard needs a bound against the ENGINE and not
    // only the circuit's self-consistency, and why naming the wrong test here would have been a claim
    // about a check that never ran.
    expect: /^EX\.(4|7)/,
    expectDesc: 'EX.4, where the certified headline stops being the served one, and EX.7, the sweep against the real engine',
  },
  {
    id: 2,
    file: SCALE_CJS,
    what: 'the engine expression is rearranged into a mathematically equal, numerically different form',
    from: '  const inEff = dx * (1 - f);\n  return (y * inEff) / (x + inEff);',
    to: '  return (y * dx * (1 - f)) / (x + dx * (1 - f));   // SCRIPTED REVERT: rearranged algebra',
    expect: /^EX\.1/,
    expectDesc: 'EX.1, which compiles the engine\'s own line and requires Object.is agreement',
  },
  {
    id: 3,
    file: SCALE_CJS,
    what: 'the canonical benchmark truncates instead of rounding — off by a whole step, not half of one',
    from: '  return roundDiv(inHat * yHat, denom);',
    to: '  return (inHat * yHat) / denom;   // SCRIPTED REVERT: truncation',
    expect: /^EX\.(7|9)/,
    expectDesc: 'EX.7 and EX.7b, where the sweep diverges from the engine, and EX.9, where the dust refusal stops being reached',
  },
  {
    id: 4,
    file: SCALE_CJS,
    what: 'the witness reads the DISPLAYED benchmark instead of the integer solve',
    from: '  const outHat = canonicalHonestOut({ ...base, inHat });',
    to: '  const outHat = toScaled(Number(engineHonestOut(dx, x, y, f).toFixed(8)), \'displayedBenchmark\');   // SCRIPTED REVERT: certifies round(honestOut, 8)',
    expect: /^EX\.(7|9)/,
    expectDesc: 'EX.7 and EX.7b, where the sweep diverges from the engine\'s own unrounded fill, and EX.9',
  },
  {
    id: 5,
    file: SNARK_JS,
    what: 'the ceiling is removed — the guard stops refusing the fills the grid cannot pin',
    from: 'const EXEC_REL_CEILING = EXEC_DISPLAY_HALF_BPS / EXEC_BPS_FULL;',
    to: 'const EXEC_REL_CEILING = 1e6 * EXEC_DISPLAY_HALF_BPS / EXEC_BPS_FULL;   // SCRIPTED REVERT: the ceiling stops refusing',
    expect: /^EX\.(2|9)/,
    expectDesc: 'EX.2, which requires the ceiling to BE the derived quotient, and EX.9, which requires the dust fill to be refused',
  },
  {
    id: 6,
    file: SNARK_JS,
    what: 'the bound is widened to the width the answer is merely displayed at',
    from: 'const EXEC_HALF_STEP = 0.5 / Number(scale.SCALE);',
    to: 'const EXEC_HALF_STEP = 0.005;   // SCRIPTED REVERT: the bound stops measuring',
    expect: /^EX\.(2|7|9)/,
    expectDesc: 'EX.2, which pins the constant, and EX.7, which requires the worst honest trade to use a real part of the bound',
  },
  {
    id: 7,
    file: SNARK_JS,
    what: 'the encoding box becomes a first-order derivative — the exact defect this file\'s first draft had',
    from: '  const hin = EXEC_HALF_STEP + Math.abs(inEff) * 8 * HALF_ULP;\n  if (!(hx >= 0 && hy >= 0 && hin >= 0)) return Infinity;',
    to: '  const hin = EXEC_HALF_STEP + Math.abs(inEff) * 8 * HALF_ULP;\n  if (!(hx >= 0 && hy >= 0 && hin >= 0)) return Infinity;\n  return ((y * x) / ((x + inEff) * (x + inEff))) * hin;   // SCRIPTED REVERT: linearised, and therefore not an upper bound',
    expect: /^EX\.2b/,
    expectDesc: 'EX.2b, which requires the shipped bound to be the corner evaluation rather than the derivative',
  },
];

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateEX-execverify-snark.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-4000));
    throw new Error('could not read the runner summary. The numbers below would be invented');
  }
  const named = [...new Set([...out.matchAll(/^✖ (EX\.\d[a-z]?[^(]*)/gm)].map((m) => m[1].trim()))];
  return { pass, fail, named };
}

console.log('GATE EX REVERT: proving the adverse-execution guard can still say no\n');

const hashBefore = buildId();
console.log(`  engine build id before : ${hashBefore}`);

const FILES = [...new Set(REVERTS.map((r) => r.file))];
const originals = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
const backupOf = (f) => join(dirname(f), `.${basename(f)}.exrevert-backup`);
const occurrences = (s, a) => { let c = 0, i = 0; while ((i = s.indexOf(a, i)) >= 0) { c++; i++; } return c; };
// A revert whose anchor does not appear, or appears twice, reports a meaningless result — so this is
// checked for EVERY revert before ANY of them runs, rather than discovered halfway through.
for (const rv of REVERTS) {
  const n = occurrences(originals.get(rv.file), rv.from);
  if (n !== 1) {
    console.error(`Revert ${rv.id}: its anchor occurs ${n} times in ${basename(rv.file)}, not 1.`);
    console.error(`  anchor: ${JSON.stringify(rv.from.slice(0, 120))}`);
    console.error('Refusing to run: a revert that does not apply, or applies where it was not meant to, reports nothing.');
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
  // failed gate: the next run would look green against code that certifies a trade nobody asked about.
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
  console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] revert ${rv.id} makes gate EX fail`);
  console.log(`  [${hitTheRightOne ? 'PASS' : '*** FAIL ***'}] and the failure is ${rv.expectDesc}`);
  ok = ok && wentRed && hitTheRightOne;
}
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and the gate PASSES again once every revert is undone (${restored.pass} pass, ${restored.fail} fail)`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
ok = ok && cameBack && hashHeld;

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE EX REVERT: ${ok ? 'PASSED' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
