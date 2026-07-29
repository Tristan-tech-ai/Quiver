// The scripted revert for gate W.
//
// "The guard still refuses a real divergence" is a claim about a verifier, and it is the one category
// of claim that has to be executed rather than argued. Gate W was written after the guard it guards,
// so of course it passes; that says nothing about whether it would catch the thing it was written
// for. This script puts a defect back — five of them, one at a time — and requires gate W to go RED
// for each, then restores the file and requires GREEN again. Red in both states would mean broken
// rather than strict, so both halves are required.
//
// The five are deliberately not variations on one theme. Three of them are genuine WITNESS/ENGINE
// mismatches — the circuit is handed a position the engine did not price — and each is a shape this
// codebase has actually shipped somewhere:
//
//   1. THE ENCODER DRIFTS. One grid step is added to the encoded margin. The witness now certifies a
//      position 1e-9 of margin away from the one that was priced; nothing else changes, the answer is
//      untouched, and the resulting price moves 1.01e-9 — about a hundredth of a hundredth of a
//      hundredth of the half-cent the OLD guard allowed, which would have waved it straight through.
//      W.4 and W.5 must die.
//   2. THE ALGEBRA IS REARRANGED. `canonicalLiquidationPrice` is replaced by a form that is
//      mathematically identical and divides before it multiplies. This is the `constantproduct`
//      defect verbatim — equal on paper, different in integers — and it is the reason W.1 compiles
//      the engine's own source line instead of reading it.
//   3. THE SIDE FLIPS IN THE WITNESS ONLY. `s` is negated inside the encoded inputs and nowhere else,
//      so the proof certifies a liquidation price on the wrong side of entry while every other
//      number in the response stays right. The largest of the three, and the one a reader would never
//      see: both proofs verify.
//
// The other two attack the measurement rather than the arithmetic:
//
//   4. THE BOUND IS WIDENED. `HALF_STEP` is set to the half-cent this work removed. Nothing is
//      mis-certified; the guard simply stops being able to tell. W.4/W.5's "the worst honest position
//      uses a real part of the bound" is the only thing standing between that and a green board.
//   5. THE DISPLAY ROUNDING DRIFTS from the engine's. W.2 must die — and W.3, because the recomputed
//      price stops reproducing the served answer.
//
// It also reads the engine build id before and after. Nothing here touches src/engine/, and the
// published q1-e1fa99d08887d6cc must be the same string on both sides of a script that rewrites files.
//
//   node gates/gateW-revert.mjs
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SNARK_JS = join(ROOT, 'src', 'util', 'snark.js');

const REVERTS = [
  {
    id: 1,
    file: SNARK_JS,
    what: 'the encoder drifts one grid step on margin — a position 1e-9 from the one that was priced',
    from: "      mHat: scale.toScaled(margin, 'margin'),",
    to: "      mHat: scale.toScaled(margin, 'margin') + 1n,   // SCRIPTED REVERT: the encoder drifts",
    expect: /^W\.[45]/,
    expectDesc: 'W.4 and W.5, the assertions that the witness agrees with the engine',
  },
  {
    id: 2,
    file: SNARK_JS,
    what: 'the canonical solve is rearranged into a mathematically equal, numerically different form',
    from: '  const pLiqHat = scale.canonicalLiquidationPrice(enc);',
    // (s*q*P0 - M)/(q*(s - mmr)) rewritten as (s*P0 - M/q)/(s - mmr) — the same identity, with the
    // margin-per-unit formed and rounded onto the grid FIRST. Measured: it disagrees with the
    // canonical solve on 23% of positions, always by exactly one grid step, which is 1e-9 of a dollar
    // and two orders of magnitude inside the half-cent the old guard allowed.
    to: '  const pLiqHat = scale.roundDiv(scale.SCALE * (BigInt(enc.s) * enc.p0Hat - scale.roundDiv(enc.mHat * scale.SCALE, enc.qHat)), (BigInt(enc.s) * scale.SCALE - enc.mmrHat));   // SCRIPTED REVERT: rearranged algebra',
    expect: /^W\.[45]/,
    expectDesc: 'W.4 and W.5, the assertions that the integer solve is the engine\'s identity',
  },
  {
    id: 3,
    file: SNARK_JS,
    what: 'the side flips inside the witness only — a certified price on the wrong side of entry',
    from: '      mmrHat: scale.toScaled(maintMarginRate, \'maintMarginRate\'),\n    };',
    to: '      mmrHat: scale.toScaled(maintMarginRate, \'maintMarginRate\'),\n    };\n    enc.s = -enc.s;   // SCRIPTED REVERT: the witness certifies the other side',
    expect: /^W\.[456]/,
    expectDesc: 'W.4/W.5, and W.6 where the boundary proof stops being publishable',
  },
  {
    id: 4,
    file: SNARK_JS,
    what: 'the bound is widened back to the half-cent this work removed',
    from: 'const HALF_STEP = 0.5 / Number(scale.SCALE);',
    to: 'const HALF_STEP = 0.005;   // SCRIPTED REVERT: the bound stops measuring',
    expect: /^W\.[45]/,
    expectDesc: 'W.4 and W.5, which require the worst honest position to use a real part of the bound',
  },
  {
    id: 5,
    file: SNARK_JS,
    what: 'the display rounding drifts from the engine\'s',
    from: 'const displayRound = (x) => Number(Number(x).toFixed(2));',
    to: 'const displayRound = (x) => Number(Number(x).toFixed(3));   // SCRIPTED REVERT: not the engine\'s rounding',
    expect: /^W\.[23]/,
    expectDesc: 'W.2, the drift check, and W.3, which stops reproducing the served answer',
  },
];

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateW-divergence-guard.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
    // The synthetic sweep is the slow half and every revert here shows up in the first few hundred
    // positions. Shrunk so five runs plus the restore stay inside a couple of minutes; the full sweep
    // is what the gate runs on its own.
    env: { ...process.env, QUIVER_GATEW_SYNTHETIC: process.env.QUIVER_GATEW_SYNTHETIC || '20000' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary. The numbers below would be invented');
  }
  const named = [...new Set([...out.matchAll(/^✖ (W\.\d[^(]*)/gm)].map((m) => m[1].trim()))];
  return { pass, fail, named };
}

console.log('GATE W REVERT: proving the divergence guard can still say no\n');

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
  // failed gate: the next run would look green against code that certifies a position nobody asked
  // about.
  let clean = true;
  for (const f of FILES) {
    copyFileSync(backupOf(f), f);
    rmSync(backupOf(f), { force: true });
    if (readFileSync(f, 'utf8') !== originals.get(f)) { clean = false; console.error(`*** RESTORE FAILED for ${f} — restore it before doing anything else ***`); }
  }
  if (!clean) process.exit(3);
  console.log(`\n  ${FILES.length} file restored`);
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail`);

const hashAfter = buildId();
console.log(`  engine build id after  : ${hashAfter}\n`);

let ok = true;
for (const { rv, res } of outcomes) {
  const wentRed = res.fail > 0;
  const hitTheRightOne = res.named.some((n) => rv.expect.test(n));
  console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] revert ${rv.id} makes gate W fail`);
  console.log(`  [${hitTheRightOne ? 'PASS' : '*** FAIL ***'}] and the failure is ${rv.expectDesc}`);
  ok = ok && wentRed && hitTheRightOne;
}
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and the gate PASSES again once every revert is undone (${restored.pass} pass, ${restored.fail} fail)`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
ok = ok && cameBack && hashHeld;

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE W REVERT: ${ok ? 'PASSED, the guard is capable of saying no' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
