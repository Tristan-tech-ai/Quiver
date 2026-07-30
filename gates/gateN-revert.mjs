// The scripted revert for gate N.
//
// A gate that has never failed is a claim, not a check. Gate N asserts that the defect register agrees
// with the defects, and the only way to show that assertion has teeth is to put each disclosure back the
// way it was — or the way it would drift — and watch the gate go red by name.
//
// Six mutations, each one a real thing that happened or nearly happened to this page on 29–30 July:
//
//   1. SECTION DELETED        §5 is removed entirely. This is the defect gate N exists for: the register
//                             held three entries while ten more were known, and one of them ships in a
//                             live envelope. Gate N must go red. `docs-consistency.mjs` MUST NOT — and
//                             that pair is the whole argument for this gate existing.
//   2. STALE DISCLOSURE       §5's status is flipped to FIXED while the self-check still fails. On this
//                             page that is the worse direction: §1 contradicted itself for part of
//                             29 July, and the register's own note says a page that contradicts itself
//                             is worse than one that is out of date.
//   3. A COUNT EDITED         §4's "18 of 21 have no private input" becomes 17. The kind of edit that
//                             looks like tidying and silently unmoors the page from the artifacts.
//   4. A NAME DROPPED         §8 stops naming `liquidation` among the artifacts the clone is missing —
//                             which is exactly the shape of the original defect, a list short by the one
//                             entry that mattered.
//   5. A GAS CITATION REMOVED the annotation after a gas figure is deleted, leaving the number bare.
//                             Gate N must go red; `docs-consistency` must not, because its rule 9(b)
//                             covers the four VERIFY reports and not this page. Same pair as mutation 1,
//                             one rule apart.
//   6. A GAS CITATION MISDIRECTED the annotation is pointed at a field holding a different number.
//                             This is the one `docs-consistency` DOES catch, by rule 9(a), which applies
//                             to every document. It is here to show the two checkers are complementary
//                             rather than redundant — and that neither alone is enough.
//
// Both copies of the register are mutated together, because gate N also checks that they are
// byte-identical: mutating one would produce a red for the wrong reason, which is a demonstration of
// nothing. Everything is restored from the bytes read at the start, in a `finally`, and the script
// verifies at the end that both files are back exactly as they were.
//
// `docs-consistency.mjs` is judged on the DELTA rather than on being globally green, because sibling
// sessions are editing other documents in this tree at the same time and a pre-existing contradiction
// somewhere else is not this script's business. What is asserted is what the mutation adds.
//
// Run: npm run gate:n-revert
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COPIES = [...new Set([
  join(ROOT, 'docs', 'known-defects.md'),
  join(ROOT, '..', 'KNOWN_DEFECTS.md'),
  join(ROOT, '..', '..', 'Quiver', 'docs', 'known-defects.md'),
  join(ROOT, '..', '..', 'hackathon', 'KNOWN_DEFECTS.md'),
])].filter((p) => existsSync(p));
if (!COPIES.length) { console.error('gate N revert: no register to mutate'); process.exit(1); }
const ORIGINAL = COPIES.map((p) => readFileSync(p));

const short = (p) => relative(join(ROOT, '..', '..'), p).split(/[\\/]/).join('/');
console.log(`GATE N REVERT — ${new Date().toISOString()}`);
console.log(`  register copies under test: ${COPIES.map(short).join(', ')}\n`);

/** Run gate N. Returns { red, out }. */
function gateN() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateN-known-defects.mjs')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { red: r.status !== 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}
/** Run docs-consistency and return only the findings that name the register. */
function docsFindingsAboutRegister() {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'docs-consistency.mjs')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const lines = out.split('\n');
  const found = [];
  let inRegister = false;
  for (const L of lines) {
    if (/^\s{2}\S/.test(L) && /\.(md|html)\s*$/.test(L)) inRegister = /known-defects\.md|KNOWN_DEFECTS\.md/.test(L);
    else if (inRegister && /^\s{5}L\d+:/.test(L)) found.push(L.trim());
  }
  return found;
}

/** Apply a text mutation to every copy. Throws if the target text is not there to mutate. */
function mutate(find, replace) {
  for (let i = 0; i < COPIES.length; i++) {
    const s = ORIGINAL[i].toString('utf8');
    if (!s.includes(find)) throw new Error(`revert: ${short(COPIES[i])} does not contain ${JSON.stringify(find.slice(0, 60))} — the register has moved and this script is testing nothing`);
    writeFileSync(COPIES[i], s.replace(find, replace), 'utf8');
  }
}
function restore() {
  for (let i = 0; i < COPIES.length; i++) writeFileSync(COPIES[i], ORIGINAL[i]);
}

const results = [];
function step(name, { find, replace, expect, docsShould, gateShould = 'red' }) {
  let red = false, out = '', docs = [];
  try {
    mutate(find, replace);
    ({ red, out } = gateN());
    if (docsShould !== undefined) docs = docsFindingsAboutRegister();
  } finally {
    restore();
  }
  const named = expect.every((e) => out.includes(e));
  const docsOk = docsShould === undefined ? true
    : docsShould === 'silent' ? docs.length === 0
      : docs.length > 0;
  // The gate is required to go red on five of the six and to stay GREEN on the sixth, which is the
  // one that belongs to docs-consistency. A gate that fires on everything is as uninformative as one
  // that fires on nothing, so "stayed green where another checker owns it" is asserted, not tolerated.
  const gateOk = gateShould === 'red' ? red : !red;
  const pass = gateOk && named && docsOk;
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}`);
  console.log(`           gate N ${red ? 'went RED' : 'stayed green'} (expected ${gateShould})${expect.length ? (named ? ' and named it' : ' but did not name it') : ''}`);
  if (docsShould !== undefined) {
    console.log(`           docs-consistency about the register: ${docs.length ? docs.join(' | ') : 'nothing'} (expected ${docsShould})`);
  }
  if (!pass && !named) {
    const lines = out.split('\n').filter((l) => /✖|AssertionError/.test(l)).slice(0, 6);
    console.log(`           what it said instead:\n             ${lines.join('\n             ') || '(nothing)'}`);
  }
}

// A baseline first. If gate N is already red, every "went red" below proves nothing.
const base = gateN();
console.log(`  baseline: gate N is ${base.red ? '*** ALREADY RED ***' : 'green'}`);
if (base.red) {
  console.log('\n  Every mutation below would appear to work while measuring nothing. Fix the gate first.');
  const lines = base.out.split('\n').filter((l) => /✖|AssertionError/.test(l)).slice(0, 8);
  console.log(`  ${lines.join('\n  ')}`);
  process.exit(1);
}
const baseDocs = docsFindingsAboutRegister();
console.log(`  baseline: docs-consistency says ${baseDocs.length ? baseDocs.join(' | ') : 'nothing'} about the register\n`);
if (baseDocs.length) {
  console.log('  The register already has a docs-consistency finding, so the "stays silent" halves below cannot be read. Fix that first.');
  process.exit(1);
}

// 1. the defect gate N exists for: an entry that is simply not there.
step('a deleted section makes gate N red, and docs-consistency does not notice', {
  find: "## 5. `lp-risk`'s own boundedness self-check",
  replace: "## 99. (deleted) `lp-risk`'s own boundedness self-check",
  expect: ['the register has no section 5'],
  docsShould: 'silent',
});

// 2. the stale-disclosure direction.
step('marking a live defect FIXED makes gate N red', {
  find: '**Status: OPEN, and this one is NOT being fixed here.**',
  replace: '**Status: FIXED, 30 July 2026.**',
  expect: ['§5 is marked fixed and the self-check still fails'],
});

// 3. a count quietly edited away from the artifacts.
step('editing the private-input count makes gate N red', {
  find: '| with no private input at all | **18** |',
  replace: '| with no private input at all | **17** |',
  expect: ['circuits have nPrvIn = 0', "§4's table does not say so"],
});

// 4. a list short by the one entry that mattered — the original defect's own shape.
step('dropping the missing artifact from §8 makes gate N red', {
  find: '         build/liquidation.r1cs\n',
  replace: '',
  expect: ['§8 must name the missing artifacts'],
});

// 5. a gas figure left bare. Gate N catches it; docs-consistency's rule 9(b) does not reach this page.
step('removing a gas citation makes gate N red, and docs-consistency does not notice', {
  find: '2,050 <!--gas:probe-direct-vs-snark-gas#direct.acceptGas-->',
  replace: '2,050',
  expect: ['publishes gas without citing an artifact'],
  docsShould: 'silent',
});

// 6. and the one the other checker owns: a citation pointing at the wrong number.
step('misdirecting a gas citation is caught by docs-consistency, which gate N leaves to it', {
  find: '<!--gas:probe-direct-vs-snark-gas#direct.acceptGas-->',
  replace: '<!--gas:probe-direct-vs-snark-gas#snark.acceptGas-->',
  expect: [],                       // gate N is not the checker for this one
  docsShould: 'loud',
  gateShould: 'green',
});

// Everything must be back, byte for byte. A revert that leaves the tree edited is worse than no revert.
const restoredClean = COPIES.every((p, i) => readFileSync(p).equals(ORIGINAL[i]));
console.log(`\n  [${restoredClean ? 'PASS' : '*** FAIL ***'}] every copy of the register is byte-identical to how it started`);
results.push({ name: 'the register is restored', pass: restoredClean });

// Mutation 6 deliberately does not require gate N to be red, so its row is scored on the docs half only.
const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? `GATE N REVERT: FAILED — ${failed.map((r) => r.name).join('; ')}` : `GATE N REVERT: PASSED — ${results.length} mutations, each one red where it should be`}`);
process.exit(failed.length ? 1 : 0);
