// The scripted revert for gate LB.
//
// A gate that has never failed is a claim, not a check. This script puts the defect back four ways and
// requires gate LB to go RED each time, NAMING the case, and GREEN again once the files are restored.
//
//   1. THE ROUNDED FIELD, BACK   the range test compares the SERVED PERCENTAGE against (-100, 0]
//                  instead of the exact fraction — the engine's own expression, moved outside the
//                  engine. This is not an invented fault: it is `src/engine/lpRisk.js` line 206 as it
//                  stands. The override can then never fire, and gate LB must go red on the corrected
//                  half and on the hash-movement count.
//
//   2. THE SUBTRACTION, BACK   the range test becomes `exact > -1` on the fraction rather than `L > 0`
//                  on `1 + E[IL]`. Mathematically identical, numerically not: `exp(-v/8) - 1` is
//                  exactly -1 in doubles once `exp(-v/8) < 2^-53`, so the same defect reappears at
//                  v ~ 293.6 instead of at 116.07. This is the revert that proves L-form is
//                  load-bearing rather than decorative, and the one closest to a plausible rewrite.
//
//   3. THE DIGIT GUARD, GONE   the override stops requiring that the recomputation reproduce the
//                  4-dp figure the response published. Nothing about the corrected sweep changes —
//                  which is the point — and the fault-injection test must go red, because -135% and
//                  -200% then get certified as inside (-100%, 0].
//
//   4. ONE SURFACE ONLY   the free MCP handler goes back to the raw envelope while the paid HTTP one
//                  keeps the fix. The two surfaces then answer the same question differently, which is
//                  the miss this repository has made repeatedly, and gate LB's parity check must catch
//                  it. A companion assertion requires the register's-own-input check to STAY GREEN, so
//                  the failure is attributable to the surface split rather than to the fix breaking.
//
//   node gates/gateLB-revert.mjs        (npm run gate:lb-revert)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const FILE = (...p) => join(ROOT, ...p);

function runner(file) {
  return () => {
    const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', file)], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const num = (label) => Number((out.match(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, 'm')) || [])[1] ?? -1);
    const pass = num('pass'), fail = num('fail');
    if (pass < 0 || fail < 0) { console.error(out); throw new Error(`could not read ${file}'s runner summary — the numbers below would be invented`); }
    const failedNames = [...new Set([
      ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
      ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
    ])];
    if (fail > 0 && !failedNames.length) { console.error(out); throw new Error(`${file} reported ${fail} failure(s) and this script could not name any of them`); }
    return { pass, fail, failedNames, out };
  };
}
const runGateLB = runner('gateLB-lp-boundedness.mjs');

const MODULE = FILE('src', 'util', 'lpBoundedness.js');
const MCP = FILE('src', 'mcp.js');

// Each edit's `find` is a literal that MUST be present, so a revert that no longer applies refuses to
// run rather than reporting a meaningless green.
const REVERTS = [
  {
    name: 'THE ROUNDED FIELD, BACK — the range test reads the served percentage, exactly as the engine does',
    edits: [{
      target: MODULE,
      find: `    const inRange = Number.isFinite(ex.L) && ex.L > 0 && ex.L <= 1;`,
      replace: `    const inRange = servedPct <= 0 && servedPct > -100;   // SCRIPTED REVERT: the engine's own expression`,
    }],
    expect: [/across the flip point the verdict is correct on BOTH sides/i, /exactly the corrected calls move their contentHash/i, /the register's own input/i],
    // The failing rows print the case: a total variance past the flip point whose exact fraction IS
    // inside the interval and whose digit the recomputation DOES reproduce, refused anyway.
    mustName: ['116.06874041832731', 'inRange=true'],
  },
  {
    name: 'THE SUBTRACTION, BACK — `exact > -1` instead of `L > 0`, mathematically equal and numerically not',
    edits: [{
      target: MODULE,
      find: `    const inRange = Number.isFinite(ex.L) && ex.L > 0 && ex.L <= 1;`,
      replace: `    const inRange = Number.isFinite(ex.L) && ex.L - 1 > -1 && ex.L - 1 <= 0;   // SCRIPTED REVERT: L-form dropped`,
    }],
    // The hash-movement count does NOT go red here, and that is the interesting part: the override
    // still fires for every v below ~293.6, so 300+ hashes still move and a gate that only counted
    // them would call this fixed. What breaks is the far side of the sweep.
    expect: [/across the flip point the verdict is correct on BOTH sides/i, /past the underflow edge the failure is REAL/i],
    mustName: ['digitAgrees'],
    alsoAssert: {
      staysGreen: /exactly the corrected calls move their contentHash/i,
      because: 'the defect reappears at v ~ 293.6 rather than at 116.07, so most of the corrected set is unaffected and a count of moved hashes stays healthy',
    },
  },
  {
    name: 'THE DIGIT GUARD, GONE — override without reproducing the published figure',
    edits: [{
      target: MODULE,
      find: `    if (!inRange || !reproducesDigit) return c;`,
      replace: `    if (!inRange) return c;   // SCRIPTED REVERT: the fail-closed half removed`,
    }],
    expect: [/the guard has teeth/i],
    mustName: ['overrode a verdict it cannot justify'],
    alsoAssert: {
      staysGreen: /the register's own input/i,
      because: 'dropping the guard changes nothing about an honest call — it only stops refusing the dishonest ones, which is why a sweep of real inputs cannot catch it',
    },
  },
  {
    name: 'ONE SURFACE ONLY — the free MCP handler goes back to the raw envelope',
    edits: [
      {
        target: MCP,
        find: `import { lpRiskEnvelope } from './util/lpBoundedness.js';`,
        replace: `import { lpRiskEnvelope } from './util/lpBoundedness.js';
import { lpRisk as lpRiskRawRevert } from './engine/lpRisk.js';   // SCRIPTED REVERT`,
      },
      {
        target: MCP,
        // The one line in the free handler that reaches the corrector. It is deliberately the CALL and
        // not the whole handler: a sibling session wired the `lpbracket` circuit around this seam hours
        // after it landed, and a revert anchored on the handler's shape would have stopped applying —
        // which the harness reports as a refusal rather than as a green, and is how this was caught.
        find: `      const env = lpRiskEnvelope(raw, config.version);`,
        replace: `      const env = proofEnvelope('lp-risk', raw, lpRiskRawRevert(raw), config.version);   // SCRIPTED REVERT: the free surface never got the fix`,
      },
    ],
    expect: [/the paid HTTP and free MCP surfaces publish the same verdict/i],
    mustName: ['the two surfaces disagree about the same call'],
    alsoAssert: {
      staysGreen: /the register's own input/i,
      because: 'the paid path is untouched, so a gate that only measured one surface would report this as fully fixed',
    },
  },
];

console.log('GATE LB REVERT — proving the boundedness gate can fail\n');

const ORIGINAL = new Map();
for (const r of REVERTS) {
  for (const e of r.edits) {
    if (!ORIGINAL.has(e.target)) ORIGINAL.set(e.target, readFileSync(e.target, 'utf8'));
    if (!ORIGINAL.get(e.target).includes(e.find)) {
      console.error(`The code this revert changes is no longer in ${e.target}:\n  ${r.name}`);
      console.error(`  missing literal: ${e.find.slice(0, 110).replace(/\n/g, ' ')}…`);
      console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
      process.exit(2);
    }
  }
}
const restoreAll = () => { for (const [f, s] of ORIGINAL) writeFileSync(f, s); };

const baseline = runGateLB();
console.log(`  baseline gate LB: ${baseline.pass} pass, ${baseline.fail} fail`);
if (baseline.fail !== 0 || baseline.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

const results = [];
try {
  for (const r of REVERTS) {
    // Applied per target, so a revert with two edits in one file lands both.
    const pending = new Map();
    for (const e of r.edits) {
      const base = pending.get(e.target) ?? ORIGINAL.get(e.target);
      pending.set(e.target, base.replace(e.find, e.replace));
    }
    for (const [f, s] of pending) writeFileSync(f, s);

    const out = runGateLB();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate LB against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);

    const wentRed = r.expect.every((e) => out.failedNames.some((n) => e.test(n)));
    const named = r.mustName.filter((s) => out.out.includes(s));
    console.log(`    names the case it is about    : ${named.length}/${r.mustName.length} [${named.join(' | ')}]`);

    let blind = null;
    if (r.alsoAssert) {
      const stillGreen = !out.failedNames.some((n) => r.alsoAssert.staysGreen.test(n));
      blind = { stillGreen };
      console.log(`    companion check stays green    : ${stillGreen ? 'YES' : 'NO'}`);
      console.log(`      because ${r.alsoAssert.because}`);
    }

    results.push({ name: r.name, wentRed, fullyNamed: named.length === r.mustName.length, blindOk: !r.alsoAssert || blind.stillGreen });
    restoreAll();
  }
} finally {
  restoreAll();
}

const restored = runGateLB();
console.log(`\n  restored gate LB: ${restored.pass} pass, ${restored.fail} fail`);

console.log('\nRESULT');
let ok = restored.fail === 0 && restored.pass === baseline.pass;
for (const r of results) {
  const good = r.wentRed && r.fullyNamed && r.blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'OK' : '*** BAD ***'}] ${r.name}`);
  if (!r.wentRed) console.log('        the gate did NOT go red on the check that owns this defect');
  if (!r.fullyNamed) console.log('        the gate went red without naming the case — not an actionable failure');
  if (!r.blindOk) console.log('        the companion check did not stay green, so the blind spot is not what this script claims');
}
console.log(`  [${restored.fail === 0 && restored.pass === baseline.pass ? 'OK' : '*** BAD ***'}] the files are restored and gate LB is green again`);
process.exit(ok ? 0 : 1);
