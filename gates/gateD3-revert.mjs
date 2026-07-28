// The scripted revert for gate D3.
//
// "This gate can fail" is a claim about a verifier, and claims about verifiers have to be executed
// rather than reasoned about. This project has already been bitten once here: an earlier draft of
// dydx-attest.js contained a signature checker that verified NOTHING, and it looked entirely correct
// while doing it. Nothing caught that, because nothing tried to make it fail.
//
// So this script removes one load-bearing check at a time, reruns the gate, and requires it to go RED
// each time — then restores the file and requires GREEN. Eight separate defects are injected, because
// a gate can easily be sensitive to one thing and blind to the rest:
//
//   1. the proto3 zero-omission in the vote encoder  — the exact historical defect
//   2. the divergence comparison itself              — makes every claim "agree"
//   3. the no-proof-path refusal                     — lets an unprovable quantity through
//   4. the ticker cross-check                        — attests one market against another's proof
//
// and four that break the FUNDING recomputation specifically. Funding is the newest thing this module
// claims and the one with the most arithmetic in it, so "it matched 24 of 24 on mainnet" is exactly
// the kind of evidence that hides a defect in a branch mainnet does not reach:
//
//   5. the sint32 zigzag decode of premium samples   — the wire type that made this look impossible,
//                                                      reinstated as the plain int32 read it was
//   6. the default-funding term                      — silently correct on 114 markets, wrong on 182
//   7. the funding-context height binding            — lets inputs proven at one height be reused
//                                                      against another anchor, which no per-key root
//                                                      check can see because each proof is valid
//   8. the direction of integer truncation           — Math.floor instead of trunc-toward-zero: right
//                                                      on every positive rate, wrong on every negative
//
//   node gates/gateD3-revert.mjs        (npm run gate:d3-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'adapters', 'dydx-attest.js');
const BACKUP = join(ROOT, 'src', 'adapters', '.dydx-attest.js.revert-backup');

// Each mutation is [name, exact source to find, replacement]. `find` must be present or the script
// refuses to run: a revert that silently does not apply would report a meaningless green.
const MUTATIONS = [
  [
    'the proto3 zero-omission in the vote encoder (the historical defect)',
    '  if (BigInt(n) === 0n) return Buffer.alloc(0);',
    '  // SCRIPTED REVERT: always emit, even when zero',
  ],
  [
    'the divergence comparison',
    '  const within = rel <= bound;',
    '  const within = true; // SCRIPTED REVERT: everything agrees',
  ],
  [
    'the no-proof-path refusal',
    "  if (NOT_ATTESTABLE[quantity]) {\n    return { ...base, ok: false, status: 'REFUSED', reason: 'NO_PROOF_PATH', detail: NOT_ATTESTABLE[quantity] };\n  }",
    '  // SCRIPTED REVERT: unprovable quantities no longer refused by name',
  ],
  [
    'the ticker cross-check',
    '  if (normTicker(perp.ticker) !== want) {',
    '  if (false) { // SCRIPTED REVERT: id mapping trusted blindly',
  ],
  [
    'the sint32 zigzag decode of premium samples (the wire type that made funding look impossible)',
    '      if (h.wire === 2) for (const u of uvarints(h.bytes)) premiums.push(Number(zigzag(u)));',
    '      if (h.wire === 2) for (const u of uvarints(h.bytes)) premiums.push(Number(BigInt.asIntN(32, u))); // SCRIPTED REVERT: plain int32, not sint32',
  ],
  [
    'the default-funding term in the funding rule',
    '  const rawPpm = premiumPpm + defaultFundingPpm;',
    '  const rawPpm = premiumPpm; // SCRIPTED REVERT: the term that IS the rate for 182 of 296 markets',
  ],
  [
    'the funding-context height binding',
    '  if (ctx.appHash !== anchor.appHash) {',
    '  if (false) { // SCRIPTED REVERT: funding inputs accepted from any height',
  ],
  [
    'the direction of integer truncation in AvgInt32',
    '  const premiumPpm = Number(sum / BigInt(paddedTo));   // Go integer division: truncates toward zero',
    '  const premiumPpm = Math.floor(Number(sum) / paddedTo); // SCRIPTED REVERT: floor, not trunc-toward-zero',
  ],
];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateD3-dydx-input-attestation.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000,
    // Fewer markets and one tick height: these runs are about whether the gate can FAIL, not about
    // re-deriving the bounds. The tick ticker list is left alone on purpose — it is the mix that
    // covers both the premium term and the default-funding term, and trimming it is exactly how
    // mutation 6 would stop being caught.
    env: { ...process.env, GATE_D3_MARKETS: '10', GATE_D3_TICK_HEIGHTS: '1' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-2000));
    throw new Error('could not read the runner summary — the numbers below would be invented');
  }
  return { pass, fail };
}

console.log('GATE D3 REVERT — proving the dYdX input-attestation gate can fail\n');

const original = readFileSync(TARGET, 'utf8');
for (const [name, find] of MUTATIONS) {
  if (!original.includes(find)) {
    console.error(`Cannot apply "${name}": the code it reverts is no longer in ${TARGET}.`);
    console.error('Refusing to run rather than reporting a revert that did not happen.');
    process.exit(2);
  }
}
copyFileSync(TARGET, BACKUP);

const results = [];
try {
  for (const [name, find, replace] of MUTATIONS) {
    writeFileSync(TARGET, original.replace(find, replace));
    console.log(`  removed: ${name}`);
    const r = runGate();
    console.log(`    gate against reverted code : ${r.pass} pass, ${r.fail} fail`);
    results.push({ name, ...r });
    writeFileSync(TARGET, original);
  }
} finally {
  // Restored in `finally`: leaving a neutered attestation module behind after a crash is far worse
  // than a failed revert, because the next run would look green against code that verifies nothing.
  copyFileSync(BACKUP, TARGET);
  rmSync(BACKUP, { force: true });
  if (readFileSync(TARGET, 'utf8') !== original) {
    console.error('*** RESTORE FAILED — restore src/adapters/dydx-attest.js before doing anything else ***');
    process.exit(3);
  }
  console.log('  all mutations restored');
}

console.log('\n  re-running the gate against restored code...');
const restored = runGate();
console.log(`    gate against restored code : ${restored.pass} pass, ${restored.fail} fail\n`);

let ok = true;
for (const r of results) {
  const red = r.fail > 0;
  ok &&= red;
  console.log(`  [${red ? 'PASS' : '*** FAIL ***'}] gate goes RED without ${r.name}`);
}
// Red-when-reverted alone is not enough: a gate that is red in both states is simply broken and would
// satisfy a one-sided check.
const cameBack = restored.fail === 0 && restored.pass > 0;
ok &&= cameBack;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and GREEN again once every check is restored`);

console.log(`\n${'='.repeat(74)}`);
console.log(`GATE D3 REVERT: ${ok ? 'PASSED — the attestation gate is capable of failing' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
