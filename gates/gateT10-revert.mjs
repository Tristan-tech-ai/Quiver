// The scripted revert for gate T10.
//
// "This gate can fail" is a claim about a verifier, and the one category of claim that has to be
// executed rather than argued. T10 guards three separate things, so this script removes them ONE AT
// A TIME and requires the gate to go red on the specific tests each guard protects. A single revert
// that reddens everything would not distinguish a strict gate from a broken one.
//
//   guard 1  the band check in pinFundingRate     -> without it every hour is "attestable"
//   guard 2  the bound check in checkClaimedPremium -> without it a fabricated premium passes
//   guard 3  the coverage assertion               -> without it 40 hand-picked quiet samples pin an hour
//
// Red-when-reverted alone would not be enough: a gate red in both states is broken rather than
// strict. So each guard is restored and the gate must come back green.
//
// Nothing here touches src/engine/, and the published q1-e1fa99d08887d6cc must be the same string on
// both sides of a script that rewrites files.
//
//   node gates/gateT10-revert.mjs
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'adapters', 'hyperliquid-funding-bound.js');
const BACKUP = join(ROOT, 'src', 'adapters', '.hyperliquid-funding-bound.js.revert-backup');

const GUARDS = [
  {
    name: 'band check (pinFundingRate)',
    find: '  const okLo = lo >= BAND_LO, okHi = hi <= BAND_HI;',
    replace: '  const okLo = true, okHi = true; // SCRIPTED REVERT: the no-clamp band check is disabled',
    mustRedden: ['T10.3', 'T10.7'],
  },
  {
    name: 'premium bound check (checkClaimedPremium)',
    find: "  if (P < lo) return { ok: false, reason: 'CLAIM_BELOW_BOUND', by: lo - P, claimed: P, lo, hi };\n  if (P > hi) return { ok: false, reason: 'CLAIM_ABOVE_BOUND', by: P - hi, claimed: P, lo, hi };",
    replace: '  // SCRIPTED REVERT: a claimed premium is no longer compared against the bound',
    mustRedden: ['T10.5'],
  },
  {
    name: 'coverage assertion (pinFundingRate)',
    find: '  if (coverage < minCoverage) {',
    replace: '  if (false) { // SCRIPTED REVERT: the coverage assertion is disabled',
    mustRedden: ['T10.8'],
  },
];

function buildId() {
  const r = spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim();
}

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateT10-hl-premium-bound.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) { console.error(out); throw new Error('could not read the runner summary. The numbers below would be invented'); }
  const named = [...new Set([...out.matchAll(/^✖ (T10\.\d+)/gm)].map((m) => m[1]))];
  return { pass, fail, named, out };
}

console.log('GATE T10 REVERT: proving each guard can fail\n');
const hashBefore = buildId();
console.log(`  engine build id before : ${hashBefore}`);

const original = readFileSync(TARGET, 'utf8');
for (const g of GUARDS) {
  if (!original.includes(g.find)) {
    console.error(`\nThe guard "${g.name}" is no longer in ${TARGET}.`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const baseline = runGate();
console.log(`  gate as shipped        : ${baseline.pass} pass, ${baseline.fail} fail\n`);

const results = [];
for (const g of GUARDS) {
  copyFileSync(TARGET, BACKUP);
  let reverted;
  try {
    writeFileSync(TARGET, original.replace(g.find, g.replace));
    console.log(`  removed guard: ${g.name}`);
    reverted = runGate();
    console.log(`    gate against reverted code : ${reverted.pass} pass, ${reverted.fail} fail   red: ${reverted.named.join(', ') || '(none)'}`);
  } finally {
    // Restored in `finally` because leaving a guard disabled after a crash would be far worse than a
    // failed gate: the next run would look green against code that permits exactly what T10 forbids.
    copyFileSync(BACKUP, TARGET);
    rmSync(BACKUP, { force: true });
    if (readFileSync(TARGET, 'utf8') !== original) {
      console.error('*** RESTORE FAILED: restore src/adapters/hyperliquid-funding-bound.js from git before doing anything else ***');
      process.exit(3);
    }
  }
  const wentRed = reverted.fail > 0;
  const caughtNamed = g.mustRedden.every((t) => reverted.named.some((n) => n.startsWith(t)));
  results.push({ g, wentRed, caughtNamed, named: reverted.named });
  console.log(`    guard restored\n`);
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail`);
const hashAfter = buildId();
console.log(`  engine build id after  : ${hashAfter}\n`);

for (const r of results) {
  console.log(`  [${r.wentRed ? 'PASS' : '*** FAIL ***'}] T10 fails when "${r.g.name}" is removed`);
  console.log(`  [${r.caughtNamed ? 'PASS' : '*** FAIL ***'}]   and the red tests include ${r.g.mustRedden.join(', ')} (got ${r.named.join(', ') || 'none'})`);
}
const cameBack = restored.fail === 0 && restored.pass > 0;
const hashHeld = hashBefore === hashAfter && /^q1-[0-9a-f]{16}$/.test(hashBefore);
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and PASSES again once every guard is restored`);
console.log(`  [${hashHeld ? 'PASS' : '*** FAIL ***'}] engine build id unmoved (${hashBefore} -> ${hashAfter})`);

const ok = results.every((r) => r.wentRed && r.caughtNamed) && cameBack && hashHeld;
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE T10 REVERT: ${ok ? 'PASSED, all three guards are capable of failing' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
