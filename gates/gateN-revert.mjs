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
//   7. THE PUBLISHED COUNT     §13's "of those, committed to the published repository" row is put back to
//      PUT BACK TO ZERO        the `**0** — git ls-files zk/circuits returns 22 paths and none is under
//                             adv/` it carried while 37 were committed. This is the row nineteen green
//                             tests could not see, because every source gate N read was the WORKING tree
//                             and committedness is not visible from there. `docs-consistency` MUST stay
//                             silent: it has no idea what git tracks either.
//   8. THE PROSE LEFT BEHIND   the row is left correct and the paragraph below it is reverted to "not
//                             under version control at all". A count-only rule passes this — the count IS
//                             right — and the page still contradicts itself on one screen, which is how §1
//                             broke. Reverting only one side of a two-sided edit is the actual defect.
//   9. THE INDEX ROW           §10's index row goes back to "open for 3 of 4" while three of the four are
//                             wired. Thirteen index rows were checked by nothing at all until this pair.
//  10. AN UNCOMMITTED ARTIFACT a `liquidation.r1cs` is written into `Quiver/zk/build` and NOT committed.
//                             §8's original test reads that directory with `readdirSync` and would now
//                             report the clone as complete; the added test asks HEAD and goes red. This is
//                             the 29 July failure exactly — a file present to a directory listing and
//                             present in no clone — and it is a file mutation rather than a text one, so
//                             it is removed in the same `finally` and its absence is asserted at the end.
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
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
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
/** As `mutate`, but addressed by the START of a line and replacing the whole line.
 *
 *  WHY THIS EXISTS. The rows worth reverting are the ones carrying MEASURED figures, and quoting a
 *  measured figure inside this script would mean editing this file every time a circuit is added — and
 *  then `mutate` would throw "the register has moved" on a page that had not moved at all. The line is
 *  addressed by its stable left-hand cell and replaced entire, so the numbers stay out of here. */
function mutateLine(prefix, replacement) {
  for (let i = 0; i < COPIES.length; i++) {
    const s = ORIGINAL[i].toString('utf8');
    const lines = s.split('\n');
    const hits = lines.map((L, n) => (L.startsWith(prefix) ? n : -1)).filter((n) => n >= 0);
    if (hits.length !== 1) throw new Error(`revert: ${short(COPIES[i])} has ${hits.length} lines starting ${JSON.stringify(prefix.slice(0, 50))} — expected exactly one; the register has moved and this script is testing nothing`);
    lines[hits[0]] = replacement;
    writeFileSync(COPIES[i], lines.join('\n'), 'utf8');
  }
}

// A file mutation rather than a text one: an artifact present to a directory listing and present in no
// clone. Left over from a crashed run it would make the next baseline red for the wrong reason, so it is
// cleared at startup as well as in the `finally`.
const GHOST = join(ROOT, '..', '..', 'Quiver', 'zk', 'build', 'liquidation.r1cs');
const GHOST_MARK = 'gateN-revert ghost artifact — not a circuit, safe to delete\n';
function clearGhost() {
  if (existsSync(GHOST) && readFileSync(GHOST, 'utf8') === GHOST_MARK) unlinkSync(GHOST);
}
clearGhost();
if (existsSync(GHOST)) { console.error(`gate N revert: ${short(GHOST)} already exists and is not this script's — refusing to touch it`); process.exit(1); }

function restore() {
  for (let i = 0; i < COPIES.length; i++) writeFileSync(COPIES[i], ORIGINAL[i]);
  clearGhost();
}

const results = [];
function step(name, { find, replace, line, ghost, expect, docsShould, gateShould = 'red' }) {
  let red = false, out = '', docs = [];
  try {
    if (line) mutateLine(line.prefix, line.replacement);
    else if (ghost) writeFileSync(GHOST, GHOST_MARK, 'utf8');
    else mutate(find, replace);
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

// 2. the stale-disclosure direction. §5 was CLOSED on 30 July — outside `src/engine/`, which the entry
// itself had said was impossible — so the reachable staleness reversed with it: the page can no longer
// claim a fixed defect is live by being out of date, it can only claim a live defect is fixed by being
// out of date. This step therefore reverts the status line to what it said that morning and requires
// gate N to notice that the system now disagrees with it. Same property, opposite sign; the literal is
// updated rather than the step deleted, because deleting it would remove the only check on the
// direction the register itself calls "the worse of the two".
step('a status line left OPEN over a defect that is now fixed makes gate N red', {
  find: '**Status: FIXED in this checkout, 30 July 2026 — and fixed OUTSIDE `src/engine/`, so the build hash',
  replace: '**Status: OPEN, and this one is NOT being fixed here.** The build hash',
  expect: ['the envelope now reports allSelfChecksPass true at sigma 0.62 over 365 periods'],
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

// 7. THE ROW THIS GATE COULD NOT SEE. Put back verbatim: this is the cell as it stood while 37 of the 38
// adversary sources were committed, and nineteen green rows had nothing to say about it. Gate N must now
// name it, and `docs-consistency` must not — it does not ask git anything either, so the pair is the same
// argument as mutations 1 and 5, one corpus wider.
step('putting the published-circuit count back to zero makes gate N red, and docs-consistency does not notice', {
  line: {
    prefix: '| of those, **committed** to the published repository |',
    replacement: '| of those, present in the published repository | **0** — `git ls-files zk/circuits` returns 22 paths and none is under `adv/` |',
  },
  expect: ["§13's row does not state those two figures", 'HEAD tracks'],
  docsShould: 'silent',
});

// 8. THE HALF A COUNT CANNOT SEE. The row is left correct and the paragraph beneath it is reverted, which
// is what actually happened: the cell was fixed and the prose two paragraphs down still said the sources
// were in no repository at all. A rule that only compares numbers passes this.
step('reverting the prose under a corrected row makes gate N red', {
  find: 'So the sources survived the session that produced them **and are now under version control**.',
  replace: 'So the sources survived the session that produced them and are still not in a repository. They sit in a working tree that is **not under version control at all**.',
  expect: ['the row was corrected on one side only'],
});

// 9. THIRTEEN ROWS NOTHING READ. §10's index row goes back to the count it carried while three of its four
// circuits were wired. The section's own table was right; the index was the copy no rule reached.
step("putting §10's index row back to its stale count makes gate N red", {
  line: {
    prefix: '| 10 | of the four circuits built, proved, gated and swept this round',
    replacement: '| 10 | of the four circuits built, proved, gated and swept this round, three are still unreachable from a served answer | **open for 3 of 4** — `execadverse` wired 30 Jul |',
  },
  expect: ['its index row says'],
});

// 10. AND THE SWEEP'S OTHER HALF, which no edit to the page can demonstrate. An artifact appears in the
// mirror and is never committed. §8's original test reads that directory and reports the clone complete;
// the added test asks HEAD. Both go red here — the original for the wrong reason, which is the point: it
// says "the mirror now carries every compiled circuit" about a tree no reviewer will ever receive.
step('an uncommitted artifact in the mirror makes gate N red rather than green', {
  ghost: true,
  expect: ['in no clone'],
});

// Everything must be back, byte for byte. A revert that leaves the tree edited is worse than no revert.
const restoredClean = COPIES.every((p, i) => readFileSync(p).equals(ORIGINAL[i]));
console.log(`\n  [${restoredClean ? 'PASS' : '*** FAIL ***'}] every copy of the register is byte-identical to how it started`);
results.push({ name: 'the register is restored', pass: restoredClean });
const ghostGone = !existsSync(GHOST);
console.log(`  [${ghostGone ? 'PASS' : '*** FAIL ***'}] the ghost artifact is gone from ${short(GHOST)}`);
results.push({ name: 'the ghost artifact is removed', pass: ghostGone });

// Mutation 6 deliberately does not require gate N to be red, so its row is scored on the docs half only.
const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? `GATE N REVERT: FAILED — ${failed.map((r) => r.name).join('; ')}` : `GATE N REVERT: PASSED — ${results.length} mutations, each one red where it should be`}`);
process.exit(failed.length ? 1 : 0);
