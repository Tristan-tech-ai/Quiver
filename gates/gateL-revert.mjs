// The scripted revert for gate L.
//
// A gate that has never failed is a claim, not a check — the disease `docs/verifier-discipline.md`
// is about. This script puts the defect back, twice, and requires gate L to go RED both times and
// GREEN again once the file is restored. Red in both states is a broken gate, not a working one.
//
//   1. REMOVE     `timedRun` stops stamping. This is the code as it shipped to the live service:
//                 `elapsedMs` absent from every response on both surfaces, while §2.3 of the paper
//                 tells a caller to hold the service to its own timing with it. Gate L's two
//                 presence checks must go red AND must NAME the services, because "some response
//                 somewhere is missing a field" is not a finding anyone can act on.
//
//                 The companion assertion is the point of the exercise: gate M — which calls every
//                 MCP tool and asserts each answer carries a verifiability envelope — must STAY
//                 GREEN under this revert. That is not a bug in gate M. It is why the claim survived
//                 being false on twenty-one services: every existing check looked at the envelope's
//                 contentHash and none of them looked at what was in it.
//
//   2. TOPLEVEL   the stamp lands at the TOP LEVEL of an enveloped answer instead of inside the
//                 provenance block. A field is still attached to every response — so this is the
//                 revert that a check written only around the word "present" would wave through —
//                 and every published proof silently stops verifying, because the recipe each
//                 response prints tells the caller to recompute over "this response WITHOUT its
//                 `proof` key" and that now includes a key the service never hashed. Appendix C's
//                 exhibit is in that set.
//
//                 MEASURED, and worth stating because the first draft of this comment predicted
//                 otherwise: five of gate L's eight checks go red here, not one. The presence checks
//                 fall too, because `elapsedMsOf` is a single shared definition of WHERE the field
//                 lives rather than a search for the name anywhere in the body — a locator that
//                 accepted either position would have passed this revert and been the blind checker
//                 this gate exists to avoid.
//
//                 The direction that matters is the companion: gate L's own pinned-hash check must
//                 STAY GREEN. The stored content hashes genuinely do not move, so the obvious check
//                 — pin the hashes — cannot see the defect that actually reaches a reader, and only
//                 the check that follows the caller's own published instruction can.
//
//   node gates/gateL-revert.mjs        (npm run gate:l-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'util', 'timing.js');
const BACKUP = `${TARGET}.revert-backup`;

function runner(file) {
  return () => {
    const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', file)], { cwd: ROOT, encoding: 'utf8', timeout: 420_000 });
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
const runGateL = runner('gateL-elapsed-timing.mjs');
const runGateM = runner('gateM-mcp-surface.mjs');

// Each `find` is a literal that MUST be present, so a revert that no longer applies refuses to run
// rather than reporting a meaningless green.
const REVERTS = [
  {
    name: 'REMOVE — timedRun stops stamping, so no response carries elapsedMs (the code as it shipped)',
    find: `  return out && typeof out.then === 'function'
    ? out.then((v) => stampElapsedMs(v, Date.now() - t0))
    : stampElapsedMs(out, Date.now() - t0);`,
    replace: '  return out;   // SCRIPTED REVERT: nothing is stamped — the field is gone from every response',
    expect: [/every response on the paid HTTP surface carries elapsedMs/i, /every response on the free MCP surface carries elapsedMs/i],
    // The failure has to be actionable: it must name the services, not just report a count.
    mustName: ['perp-gate', 'size-gate', 'perp_gate', 'event_vol'],
    alsoAssert: {
      run: runGateM,
      staysGreen: /every tool the server advertises has a realistic fixture here/i,
      because: 'gate M asserts each answer carries an envelope with a contentHash, and never looks at what is inside it',
    },
  },
  {
    name: 'TOPLEVEL — the stamp lands at the top level, so every published proof stops verifying',
    find: `  const env = envelopeOf(response);
  if (env) env.elapsedMs = elapsed;`,
    replace: `  const env = null;   // SCRIPTED REVERT: the envelope is ignored, so the stamp falls through to the top level
  if (env) env.elapsedMs = elapsed;`,
    expect: [/the published recipe still reproduces/i, /the field is in the provenance block/i],
    mustName: ['caused by a top-level elapsedMs'],
    alsoAssert: {
      run: runGateL,
      staysGreen: /not one deterministic content hash moved/i,
      because: 'the stored hash genuinely does not move — only the instruction the caller is told to follow breaks',
    },
  },
];

console.log('GATE L REVERT — proving the elapsed-timing gate can fail\n');

const original = readFileSync(TARGET, 'utf8');
for (const r of REVERTS) {
  if (!original.includes(r.find)) {
    console.error(`The code this revert removes is no longer in ${TARGET}:\n  ${r.name}`);
    console.error(`  missing literal: ${r.find.slice(0, 100).replace(/\n/g, ' ')}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const baseline = runGateL();
console.log(`  baseline gate L: ${baseline.pass} pass, ${baseline.fail} fail`);
if (baseline.fail !== 0 || baseline.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

copyFileSync(TARGET, BACKUP);
const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(TARGET, original.replace(r.find, r.replace));
    const out = runGateL();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate L against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);

    const wentRed = r.expect.every((e) => out.failedNames.some((n) => e.test(n)));
    const named = r.mustName.filter((s) => out.out.includes(s));
    console.log(`    names the services it is about : ${named.length}/${r.mustName.length} [${named.join(', ')}]`);

    let blind = null;
    if (r.alsoAssert) {
      const o2 = r.alsoAssert.run();
      const stillGreen = !o2.failedNames.some((n) => r.alsoAssert.staysGreen.test(n));
      blind = { stillGreen, detail: `${o2.pass} pass, ${o2.fail} fail` };
      console.log(`    companion check stays green    : ${stillGreen ? 'YES' : 'NO'} (${blind.detail})`);
      console.log(`      because ${r.alsoAssert.because}`);
    }

    results.push({ name: r.name, wentRed, fullyNamed: named.length === r.mustName.length, blindOk: !r.alsoAssert || blind.stillGreen });
    writeFileSync(TARGET, original);
  }
} finally {
  writeFileSync(TARGET, original);
  try { rmSync(BACKUP); } catch { /* the restore above is what matters */ }
}

const restored = runGateL();
console.log(`\n  restored gate L: ${restored.pass} pass, ${restored.fail} fail`);

console.log('\nRESULT');
let ok = restored.fail === 0 && restored.pass === baseline.pass;
for (const r of results) {
  const good = r.wentRed && r.fullyNamed && r.blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'OK' : '*** BAD ***'}] ${r.name}`);
  if (!r.wentRed) console.log('        the gate did NOT go red on the check that owns this defect');
  if (!r.fullyNamed) console.log('        the gate went red without naming the services — not an actionable failure');
  if (!r.blindOk) console.log('        the companion check did not stay green, so the blind spot is not what this script claims');
}
console.log(`  [${restored.fail === 0 && restored.pass === baseline.pass ? 'OK' : '*** BAD ***'}] the file is restored and gate L is green again`);
process.exit(ok ? 0 : 1);
