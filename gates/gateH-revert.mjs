// The scripted revert for gate H.
//
// Gate H was written after the guard it guards, so of course it passes. This script puts a defect
// back — five of them, one at a time — and requires gate H to go RED for each, then restores the
// files and requires GREEN again. Red in both states would mean broken rather than strict.
//
// THE FIRST ONE IS THE DEFECT THIS CIRCUIT INVITES AND THE OTHER TWO WIRED CIRCUITS DO NOT.
// `concentration.circom` takes the SHARES, and the shares are the engine's grouping of the book by
// asset. An encoder that forms one share per POSITION is the natural thing to write, produces a
// perfectly well-formed witness, proves against it, verifies, and describes a book with a different
// concentration than the one that was priced — a five-position book across four assets becomes five
// shares and a lower index. It agrees with itself completely while doing it. No gate under `zk/`
// would catch it: `gateB3-1-concentration-sweep.mjs` re-derives weights per position too, and is
// sound only because its own generator gives each asset exactly one position. Gate H's sweep is built
// the other way round, so revert 1 dies on the first repeated asset.
//
// The other four are the shapes the sibling gates already know:
//
//   2. THE FOLD IS RE-ASSOCIATED. `reduce` becomes `reduceRight`. A sum of eight doubles is not
//      associative, and re-associating one is the same class of defect as re-arranging an expression.
//   3. THE SOLVE TRUNCATES instead of rounding — off by a whole grid step rather than half of one, so
//      2|R| <= S stops holding by construction.
//   4. THE BOUND IS WIDENED to the width the answer is merely displayed at, five orders of magnitude
//      out. Nothing is mis-certified; the guard simply stops being able to tell.
//   5. THE DISPLAY ROUNDING DRIFTS from the engine's, 4dp to 3dp.
//
// It also reads the engine build id before and after. Nothing here touches src/engine/.
//
//   node gates/gateH-revert.mjs
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
    what: 'the encoder forms one share per POSITION instead of per asset — a different book, proven perfectly',
    from: '    groups[p.asset] = (groups[p.asset] || 0) + amt;',
    to: '    groups[`${p.asset}#${Object.keys(groups).length}`] = amt;   // SCRIPTED REVERT: one share per position',
    expect: /^H\.[34]/,
    expectDesc: 'H.3, whose sweep repeats assets on purpose, and H.4, whose worked book has two USDC rows',
  },
  {
    id: 2,
    file: SCALE_CJS,
    what: 'the sum-of-squares fold is re-associated',
    from: '  return values.reduce((acc, v) => acc + (v / total) ** 2, 0);',
    to: '  return values.reduceRight((acc, v) => acc + (v / total) ** 2, 0);   // SCRIPTED REVERT: re-associated fold',
    expect: /^H\.1/,
    expectDesc: 'H.1, which compiles the engine\'s own hhi and requires Object.is agreement',
  },
  {
    id: 3,
    file: SCALE_CJS,
    what: 'the canonical index truncates instead of rounding — off by a whole step, not half of one',
    from: '  return roundDiv(sumSq, SCALE);',
    to: '  return sumSq / SCALE;   // SCRIPTED REVERT: truncation',
    expect: /^H\.[34]/,
    expectDesc: 'H.3, where the bound is exceeded and 2|R| <= S stops holding, and H.4, where the exact book stops being exact',
  },
  {
    id: 4,
    file: SNARK_JS,
    what: 'the bound is widened to the width the answer is merely displayed at',
    from: 'const HHI_HALF_STEP = 0.5 / Number(scale.SCALE);',
    to: 'const HHI_HALF_STEP = 0.5e-4;   // SCRIPTED REVERT: the bound stops measuring',
    expect: /^H\.3/,
    expectDesc: 'H.3, which requires the worst honest book to use a real part of the bound',
  },
  {
    id: 5,
    file: SNARK_JS,
    what: 'the display rounding drifts from the engine\'s',
    from: 'const hhiDisplayRound = (x) => Number(Number(x).toFixed(4));',
    to: 'const hhiDisplayRound = (x) => Number(Number(x).toFixed(3));   // SCRIPTED REVERT: not the engine\'s rounding',
    expect: /^H\.[23]/,
    expectDesc: 'H.2, the drift check, and H.3, which stops reproducing the served answer',
  },
];

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateH-concentration-snark.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
    env: { ...process.env, QUIVER_GATEH_SYNTHETIC: process.env.QUIVER_GATEH_SYNTHETIC || '8000' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary. The numbers below would be invented');
  }
  const named = [...new Set([...out.matchAll(/^✖ (H\.\d[^(]*)/gm)].map((m) => m[1].trim()))];
  return { pass, fail, named };
}

console.log('GATE H REVERT: proving the Herfindahl guard can still say no\n');

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
  console.log(`  [${wentRed ? 'PASS' : '*** FAIL ***'}] revert ${rv.id} makes gate H fail`);
  console.log(`  [${hitTheRightOne ? 'PASS' : '*** FAIL ***'}] and the failure is ${rv.expectDesc}`);
  ok = ok && wentRed && hitTheRightOne;
}
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and the gate PASSES again once every revert is undone (${restored.pass} pass, ${restored.fail} fail)`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);
ok = ok && cameBack && hashHeld;

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE H REVERT: ${ok ? 'PASSED, the Herfindahl guard is capable of saying no' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
