// The scripted reverts for gate A.
//
// "This test can fail" is a claim, and a claim about a verifier is exactly the kind that has to be
// executed rather than reasoned about. So this script removes the feature — one way at a time — reruns
// the gate, and requires it to go RED. Then it puts the file back and requires it to go GREEN again.
//
// If the gate passes against reverted code, the gate is measuring something other than durability and
// its green result means nothing. That is the failure this script exists to catch.
//
// FIVE REVERTS, NOT ONE. The gate now covers two backends and four separate claims, and a single
// revert that broke all of them would leave most of the assertions unproven — a suite where only one
// test can ever fail is a suite with one test. Each revert below removes exactly one thing and names
// which assertion is supposed to notice:
//
//   1. writes are a no-op                 → nothing is ever persisted, on either backend
//   2. the durable read is gone           → a second process cannot see the first one's proof
//   3. durability is claimed, not checked → a bucket that is not there reports itself healthy
//   4. the endpoint forgets to await      → /proof/<hash> serialises a Promise as {} — a 200 that
//                                            looks exactly like a cache miss. This is the specific
//                                            trap the async rewrite created, so it gets its own revert
//   5. a write failure is swallowed       → the store falls back to memory and keeps saying `durable`
//
//   node gates/gateA-revert.mjs        (npm run gate:a-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const STORE = join(ROOT, 'src', 'util', 'proofStore.js');
const SNARK = join(ROOT, 'src', 'util', 'snark.js');
const APP = join(ROOT, 'src', 'app.js');

const REVERTS = [
  {
    name: 'writes are a no-op',
    expect: 'nothing is ever persisted, so every cross-process case must fail on both backends',
    file: STORE,
    from: "  if (!wellFormed(contentHash) || !rec || rec.status !== 'ready') return false;\n  if (!(await durable())) return false;\n  return BACKEND === 's3' ? writeS3(contentHash, rec) : writeFs(contentHash, rec);",
    to: '  return false; // SCRIPTED REVERT: durability removed',
  },
  {
    name: 'the durable read is gone from getProof',
    expect: 'the proof is written but never read back, so a second process must not find it',
    file: SNARK,
    from: '  const cold = await proofStore.read(contentHash);\n  if (cold) store.set(contentHash, cold);   // hydrate, so the next poll costs nothing',
    to: '  const cold = null; // SCRIPTED REVERT: the cross-process read is removed',
  },
  {
    name: 'durability is claimed rather than checked',
    expect: 'a bucket that does not exist must stop being reported as a named refusal',
    file: STORE,
    from: '  if (ready) return true;',
    to: '  if (BACKEND !== \'off\') return true; // SCRIPTED REVERT: claim durability without probing for it',
  },
  {
    name: 'the /proof endpoint forgets to await the store',
    expect: 'the route serialises a Promise, so /proof/<hash> answers 200 with an empty body',
    file: APP,
    from: '  const rec = await getProof(h);',
    to: '  const rec = getProof(h); // SCRIPTED REVERT: the await is dropped',
  },
  {
    name: 'a failed S3 write is swallowed',
    expect: 'the store must stop reporting durable after a write S3 refused; here it keeps claiming it',
    file: STORE,
    from: '    ready = false;\n    lastProbeAt = Date.now();\n    disabledReason = `${location()} write failed: ${describe(e)}`;\n    return false;',
    to: '    return false; // SCRIPTED REVERT: the failure is swallowed and durability is still claimed',
  },
];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateA-proof-durability.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) {
    console.error(out);
    throw new Error('could not read the runner summary — the numbers below would be invented');
  }
  // The NAMES of the failing cases, not just how many. A revert that turns the gate red by breaking
  // something unrelated to what it removed is a revert that proved nothing, and only the names show it.
  const failed = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((n) => !/^failing tests/.test(n));
  return { pass, fail, failed: [...new Set(failed)] };
}

console.log('GATE A REVERT — proving the durability gate can fail, five separate ways\n');

// Every file is snapshotted up front and restored in one place, so a crash halfway through cannot
// leave a partially reverted tree behind. Leaving a neutered store on disk after a failure would be a
// far worse outcome than a failed gate: the next run would look green against broken code.
const FILES = [...new Set(REVERTS.map((r) => r.file))];
const ORIGINAL = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
for (const f of FILES) copyFileSync(f, `${f}.revert-backup`);

const restoreAll = () => {
  let ok = true;
  for (const f of FILES) {
    copyFileSync(`${f}.revert-backup`, f);
    rmSync(`${f}.revert-backup`, { force: true });
    if (readFileSync(f, 'utf8') !== ORIGINAL[f]) {
      console.error(`*** RESTORE FAILED — restore ${f} from git before doing anything else ***`);
      ok = false;
    }
  }
  return ok;
};

for (const r of REVERTS) {
  if (!ORIGINAL[r.file].includes(r.from)) {
    restoreAll();
    console.error(`\nThe code this script reverts is no longer in ${r.file}:\n${r.from}`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(r.file, ORIGINAL[r.file].replace(r.from, r.to));
    console.log(`  REVERT: ${r.name}`);
    console.log(`          expect — ${r.expect}`);
    const got = runGate();
    console.log(`          gate against reverted code : ${got.pass} pass, ${got.fail} fail`);
    for (const n of got.failed) console.log(`            ✖ ${n}`);
    results.push({ ...r, got });
    writeFileSync(r.file, ORIGINAL[r.file]);
    console.log('');
  }
} finally {
  if (!restoreAll()) process.exit(3);
  console.log('  all files restored\n');
}

const restored = runGate();
console.log(`  gate against restored code : ${restored.pass} pass, ${restored.fail} fail\n`);

// Two conditions, and both have to hold. Red-when-reverted alone is not enough: a gate that is red in
// both states is simply broken, and would satisfy a one-sided check.
let allRed = true;
for (const r of results) {
  const red = r.got.fail > 0;
  allRed = allRed && red;
  console.log(`  [${red ? 'PASS' : '*** FAIL ***'}] the gate FAILS when: ${r.name}`);
}
const cameBack = restored.fail === 0 && restored.pass > 0;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] and PASSES again once every revert is undone`);

console.log(`\n${'='.repeat(70)}`);
console.log(`GATE A REVERT: ${allRed && cameBack ? 'PASSED — the durability gate is capable of failing, five ways' : 'FAILED'}`);
process.exit(allRed && cameBack ? 0 : 1);
