// GATE N — the defect register must agree with the defects.
//
// WHAT IT IS FOR. `docs/known-defects.md` is the page that discloses this project's own bugs. On the
// morning of 30 July it held three entries while a four-service investigation and four adversarial
// passes had produced ten more, four of them confirmed and one of them shipping in a live envelope.
// Nothing could have caught that: no checker in this repository reads the register against the system
// it describes. `docs-consistency.mjs` reads every `.md` and `.html` in the tree. This comment used to give
// that count as 229 and NO LONGER GIVES ONE: over a few hours of 30 July it read 229, then 255, then 257,
// then 259 — moved by this change's own write-up and by two sibling sessions' — so any figure written here
// is stale before it is read. `docs-consistency` prints the live count on every run. It
// asks whether each sentence agrees with the engine's
// build hash, the service count and the paper's shape — it has no idea what a defect is,
// so a defect that is simply ABSENT from this page is invisible to it. That is the hole this gate
// fills, and `gateN-revert.mjs` demonstrates the hole rather than asserting it.
//
// ── THE PROPERTY, AND WHY IT IS SYMMETRIC ────────────────────────────────────────────────────────
// For every open section, the symptom is re-measured HERE and the register must disclose it. The
// failure is symmetric on purpose:
//
//   the defect is present and the page is silent   → RED. That is a hidden defect.
//   the defect is gone and the page still says so  → RED. That is a stale disclosure, and on this
//                                                    page a stale disclosure is the worse of the two:
//                                                    §1 contradicted itself for part of 29 July and
//                                                    the register's own note says that costs more than
//                                                    being out of date.
//
// So closing a defect breaks this gate until the register is updated. That is intended. Four sibling
// sessions are fixing three of these while this is being written; each fix must land with its entry.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────────────────────
// It does not grade prose. It cannot tell whether an entry explains itself well, and a register can be
// honest, complete and unreadable. What it holds is the part that can be measured: that the numbers on
// the page are the numbers the system produces, that every open entry's symptom still reproduces, and
// that no gas figure is published without a citation to the artifact that measured it.
//
// It also does not import the code it measures where importing would make it agree by construction.
// The `.r1cs` headers are parsed here, byte by byte, rather than read through `snarkjs` or
// `circuit-facts.mjs` — the lp-risk investigation's own parser skipped 20 bytes where 24 are needed,
// read a zero out of `nLabels`, and had a row pass green on zeros. A non-vacuity guard throws on a
// zero rather than reporting one.
//
// Run: npm run gate:n          (node --test gates/gateN-known-defects.mjs)
//      npm run gate:n-revert   (puts each disclosure back and shows this gate go red)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── where things are, resolved rather than assumed ───────────────────────────────────────────────
// This service tree exists twice: as `hackathon/veritape` beside `../../zk`, and as the published
// `Quiver/` with `zk/` inside it. A hardcoded path passes in one and throws in the other, which is
// the portability defect `gate-clone-portability.mjs` exists for — and §8 of the register is about
// that gate having a list too short to catch its own subject.
//
// THE WORKING TREE WINS WHERE BOTH EXIST, and that is a decision rather than an accident. The register
// describes the running system, and in this layout the working tree IS the running system: the mirror
// lags it by however long a sibling takes to commit, and §8 records that its `zk/build` is missing the
// flagship circuit's artifacts outright. Resolving to whichever tree happens to hold the gate file
// would make this gate report the mirror's lag as a register defect. A fresh clone has no sibling, so
// it measures itself — which is the case §8 is about, and it is checked there rather than here.
const ZK = [join(ROOT, '..', '..', 'zk'), join(ROOT, '..', 'zk'), join(ROOT, 'zk')]
  .find((p) => existsSync(join(p, 'build')));
if (!ZK) throw new Error('gate N: no zk/build in this checkout, from any layout — refusing to report a comparison it did not make');
const BUILD = join(ZK, 'build');

// The service whose behaviour the register describes, resolved the same way and for the same reason.
const SRC = [join(ROOT, '..', 'hackathon', 'veritape'), join(ROOT, '..', '..', 'hackathon', 'veritape'), ROOT]
  .find((p) => existsSync(join(p, 'src', 'util', 'proverWorker.mjs')));
if (!SRC) throw new Error('gate N: no src/util/proverWorker.mjs in this checkout, from any layout');
const svc = (...p) => pathToFileURL(join(SRC, ...p)).href;

// The register, in whichever tree this is — and BOTH copies when both are reachable, because a
// one-sided edit to a disclosure page is how §1 came to contradict itself. The two names differ: the
// published mirror carries `docs/known-defects.md`, the submission tree carries `KNOWN_DEFECTS.md` a
// directory up. Looking only under `.` would find one copy from either side and quietly never compare.
const REGISTER = [...new Set([
  join(ROOT, 'docs', 'known-defects.md'),
  join(ROOT, '..', 'KNOWN_DEFECTS.md'),
  join(ROOT, '..', '..', 'Quiver', 'docs', 'known-defects.md'),
  join(ROOT, '..', '..', 'hackathon', 'KNOWN_DEFECTS.md'),
])].filter((p) => existsSync(p));
if (!REGISTER.length) throw new Error('gate N: the defect register is in neither docs/known-defects.md nor ../KNOWN_DEFECTS.md');
const REG = readFileSync(REGISTER[0], 'utf8');

const read = (...p) => readFileSync(join(...p), 'utf8');
const has = (...needles) => needles.every((n) => REG.includes(n));

/** The register's sections, split on the `## N.` headings, so an entry can be addressed by number. */
const SECTIONS = (() => {
  const out = new Map();
  const re = /^## (\d+)\.\s*(.*)$/gm;
  const hits = [...REG.matchAll(re)];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].index : REG.length;
    out.set(Number(hits[i][1]), { title: hits[i][2], body: REG.slice(hits[i].index, end) });
  }
  return out;
})();
/** The status line of a section, lowercased. Missing is not "open" — it is a gate failure. */
const status = (n) => {
  const s = SECTIONS.get(n);
  assert.ok(s, `the register has no section ${n}`);
  const m = s.body.match(/\*\*Status:([^*]*)\*\*/);
  assert.ok(m, `section ${n} carries no **Status:** line, so nothing here can tell open from fixed`);
  return m[1].toLowerCase();
};
const isOpen = (n) => /\bopen\b/.test(status(n));

// ── an independent .r1cs header parser ───────────────────────────────────────────────────────────
function r1csHeader(file) {
  const b = readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'r1cs', `${file}: not an r1cs`);
  const nSections = b.readUInt32LE(8);
  let off = 12;
  let h = null;
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(off); off += 4;
    const size = Number(b.readBigUInt64LE(off)); off += 8;
    if (type === 1) {
      let p = off;
      const n8 = b.readUInt32LE(p); p += 4 + b.readUInt32LE(p);
      h = {
        nWires: b.readUInt32LE(p), nPubOut: b.readUInt32LE(p + 4), nPubIn: b.readUInt32LE(p + 8),
        nPrvIn: b.readUInt32LE(p + 12), nLabels: Number(b.readBigUInt64LE(p + 16)), nConstraints: b.readUInt32LE(p + 24),
        n8,
      };
    }
    off += size;
  }
  assert.ok(h, `${file}: no section 1`);
  // NON-VACUITY. A parser that reads zeros reports every circuit as empty and every check as passed.
  assert.ok(h.nWires > 0 && h.nConstraints > 0, `${file}: vacuous header (nWires ${h.nWires}, nConstraints ${h.nConstraints}) — the offsets are wrong, not the circuit`);
  return h;
}
const CIRCUITS = Object.fromEntries(readdirSync(BUILD).filter((f) => f.endsWith('.r1cs'))
  .map((f) => [f.replace(/\.r1cs$/, ''), r1csHeader(join(BUILD, f))]));

// ── THE PUBLISHED REPOSITORY, ASKED OF GIT RATHER THAN OF A DIRECTORY LISTING ────────────────────
// This is the corpus hole that let §13 publish a wrong number nineteen green rows could not see. Every
// source above is a filesystem read: `readdirSync`, `statSync`, `existsSync`, and the two trees they
// resolve to are the WORKING trees. Committedness has no representation in any of them. So a row that
// says "present in the published repository" was checked against nothing — not because the rule was
// wrong, but because the quantity it publishes was not observable from anywhere this file could reach.
// §13's row was consequently wrong twice: `0` when 37 were committed, then `37 of 38` written by the
// commit that added the 38th file, measured before it was staged.
//
// Both errors understated what is published, and that direction is the one a working-tree reader is
// structurally blind to: the tree always holds at least what HEAD holds, so a disk count can never
// notice that HEAD has caught up.
//
// SO: git is asked, HEAD is the authority, and the answer is guarded against vacuity. A `git` that
// errors, or a repository that reports zero tracked circuits, throws — because a query returning an
// empty list would make every assertion below pass, which is the disease this file is organised
// against. `ls-tree HEAD` and not `ls-files`: the index is not what a reviewer clones, and a circuit
// surviving only in an index is a thing that has already happened here once.
const GIT = (() => {
  const candidates = [join(ROOT, '..', '..', 'Quiver'), ROOT, join(ZK, '..'), join(ROOT, '..')];
  for (const cwd of candidates) {
    if (!existsSync(cwd)) continue;
    const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (top.status !== 0) continue;
    const ls = spawnSync('git', ['-C', cwd, 'ls-tree', '-r', '--name-only', 'HEAD', 'zk/circuits'], { encoding: 'utf8' });
    if (ls.status !== 0) continue;
    const paths = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!paths.length) continue;                      // a repo that tracks no circuits is not the one
    return { cwd, top: top.stdout.trim(), paths };
  }
  throw new Error('gate N: no git repository reachable from this checkout tracks zk/circuits at HEAD, from any layout — §13 publishes a count of what is committed and this gate refuses to report a comparison it did not make');
})();
/** Paths under `zk/circuits` at HEAD, and the `adv/` subset. Non-vacuous by construction of GIT. */
const COMMITTED = {
  all: GIT.paths,
  adv: GIT.paths.filter((p) => p.startsWith('zk/circuits/adv/')),
};
assert.ok(COMMITTED.adv.length > 0,
  `git reports ${COMMITTED.all.length} tracked circuits and none under adv/ — if that is true the rescue was reverted, but it is far more likely this parse is wrong, and a zero here would make §13 pass on nothing`);
/** Names tracked at HEAD under a directory, basename only. */
const committedNames = (prefix) => COMMITTED.all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));

// ── EVERY ARTIFACT UNDER zk/build, AT ANY DEPTH ──────────────────────────────────────────────────
// A flat `existsSync(join(BUILD, name))` is how this file first reported "0 of 38 adversary sources
// compiled". It is 1: `ncdfonesided.r1cs` exists, at `zk/build/adv/ncdfadv/ncdfonesided.r1cs`, three
// directories down from where the flat check looked. The circuits were built into a nested directory and a
// search that does not recurse read the absence as proof — the same mistake as a capped `head -5`.
// So the build tree is indexed once, recursively, and asked by basename.
const BUILD_INDEX = (() => {
  const byName = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!byName.has(e.name)) byName.set(e.name, p);
    }
  };
  walk(BUILD);
  return byName;
})();
assert.ok(BUILD_INDEX.size > 0, 'zk/build indexed to nothing — every artifact question below would answer "absent"');
/** Is there a file with this basename anywhere under `zk/build`? Returns its path, or undefined. */
const artifact = (name) => BUILD_INDEX.get(name);

// ─────────────────────────────────────────────────────────────────────────────────────────────────

test('★ the register is present, sectioned, and every section carries a status line', () => {
  assert.ok(SECTIONS.size >= 13, `the register has ${SECTIONS.size} numbered sections; §1–§13 are expected`);
  for (const n of SECTIONS.keys()) status(n);          // throws by name if any is missing one
  assert.match(REG, /\*\*As of 30 July 2026\.\*\*/, 'the register does not date itself to the round it describes');
});

test('★ both copies of the register are byte-identical', () => {
  if (REGISTER.length < 2) return;                      // a fresh clone has one; nothing to compare
  const [a, b] = REGISTER.map((p) => readFileSync(p));
  assert.ok(a.equals(b), `${REGISTER[0]} and ${REGISTER[1]} differ — a disclosure edited on one side only is how this page contradicted itself on 29 July`);
});

// §4 ──────────────────────────────────────────────────────────────────────────────────────────────
test('§4 the private-input count on the page is the count in the artifacts', () => {
  const total = Object.keys(CIRCUITS).length;
  const zero = Object.entries(CIRCUITS).filter(([, h]) => h.nPrvIn === 0);
  const nonzero = Object.entries(CIRCUITS).filter(([, h]) => h.nPrvIn > 0);
  const s = SECTIONS.get(4).body;

  assert.ok(s.includes(`| compiled in this checkout | **${total}** |`),
    `${total} circuits are compiled; §4's table does not say so`);
  assert.ok(s.includes(`| with no private input at all | **${zero.length}** |`),
    `${zero.length} of ${total} circuits have nPrvIn = 0; §4's table does not say so`);
  for (const [name, h] of nonzero) {
    assert.ok(s.includes(`\`${name}\` ${h.nPrvIn}`), `${name} has ${h.nPrvIn} private inputs; §4 does not name it with that count`);
  }
  // The claim that actually matters: the live paid path.
  for (const c of ['liquidation', 'kelly', 'concentration']) {
    assert.equal(CIRCUITS[c].nPrvIn, 0, `${c} now has private inputs — §4 must be rewritten, not merely re-run`);
    assert.ok(s.includes(`\`${c}\``), `§4 does not name ${c}, which is on the live paid path`);
  }
});

/** The circuits a served answer can actually carry a proof of, read from the prover's own closed set. */
const WIRED = (() => {
  const src = read(SRC, 'src', 'util', 'proverWorker.mjs');
  const i = src.indexOf('const CIRCUITS = {');
  assert.ok(i > 0, 'src/util/proverWorker.mjs no longer declares a closed set of circuits');
  const block = src.slice(i, src.indexOf('};', i));
  const names = [...block.matchAll(/^\s*([a-z][a-zA-Z0-9]*):\s*\{/gm)].map((m) => m[1]).sort();
  assert.ok(names.length > 0, 'the prover\'s circuit set parsed empty — a list that reads as empty checks nothing');
  return names;
})();

test('§4 every circuit a caller can obtain a proof of is one §4 names, and none of them hides anything', () => {
  // Read from the prover rather than from a list written here, so wiring a fifth circuit is caught
  // rather than assumed away. §4's whole claim is about the paid path, so the paid path defines the set.
  const s = SECTIONS.get(4).body;
  for (const c of WIRED) {
    assert.ok(CIRCUITS[c], `the prover serves ${c} and there is no ${c}.r1cs in this build to measure`);
    assert.equal(CIRCUITS[c].nPrvIn, 0,
      `${c} is wired and has ${CIRCUITS[c].nPrvIn} private inputs — §4's claim about the paid path no longer holds as written and must be rewritten, not re-run`);
    assert.ok(s.includes(`\`${c}\``), `${c} is on the paid path and §4 does not name it`);
  }
});

test('§4 the direct-check comparison is a measurement in this checkout, not a quotation', () => {
  const p = join(BUILD, 'probe-direct-vs-snark-gas.json');
  assert.ok(existsSync(p), 'zk/build/probe-direct-vs-snark-gas.json is missing — §4 quotes a 134x ratio that nothing in this checkout measured. Run node zk/scripts/probe-direct-vs-snark-gas.mjs');
  const a = JSON.parse(readFileSync(p, 'utf8'));
  // A cheap checker that accepts everything would post a wonderful ratio for checking nothing.
  assert.equal(a.passed, true, 'the probe did not pass, so neither of its gas figures means anything');
  assert.equal(a.direct.acceptedHonest, true, 'the direct checker did not accept the honest answer');
  assert.equal(a.direct.refusedOneGridStep, true, 'the direct checker did not refuse a one-grid-step perturbation — it is not equivalent to the circuit');
  assert.equal(a.snark.refusedOneGridStep, true, 'the verifier did not refuse a one-grid-step perturbation');
  assert.ok(a.direct.guards.length >= 3 && a.direct.guards.every((g) => g.refused),
    'the direct checker does not carry the circuit\'s side / mmr / non-zero-size guards');
  assert.equal(a.privateInputs, 0, 'the probe was run against a circuit with private inputs, which is not what §4 is about');
  const ratio = a.snark.acceptGas / a.direct.acceptGas;
  assert.ok(ratio > 50, `the pairing check is only ${ratio.toFixed(1)}x the direct check — §4's argument depends on this being large`);
  assert.ok(SECTIONS.get(4).body.includes(`${ratio.toFixed(1)}×`),
    `§4 must state the measured ratio; the artifact says ${ratio.toFixed(1)}x`);
  // The left column is a sample and the right one is not, which is the sentence §4 has to carry or a
  // reader will take a verify-gas figure at six significant figures — the §9 defect, one page later.
  assert.ok(a.spread && a.spread.samples >= 12 && a.spread.gas > 0,
    'the probe recorded no spread over repeated proofs, so §4 publishes a verify-gas figure with no error bar');
  assert.equal(a.direct.deterministicAcrossTwoRuns, true, 'the direct check did not return identical gas twice — §4 calls it a value rather than a sample');
});

// §5 ──────────────────────────────────────────────────────────────────────────────────────────────
test('§5 the lp-risk boundedness self-check still fails on the disclosed input', async () => {
  const { SERVICES } = await import(svc('src','services.js'));
  const { isChargeable } = await import(svc('src','x402.js'));
  const s = SERVICES.find((x) => x.name === 'lp-risk');
  assert.ok(s, 'there is no lp-risk service, so §5 describes something that is not here');
  const out = await s.run({ volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000 });
  const failing = (out.proof?.selfChecks || out.checks || []).filter((c) => c.pass === false);

  if (isOpen(5)) {
    assert.equal(out.ok, true, 'the call no longer answers at all — §5 describes a different defect now');
    assert.equal(out.proof?.allSelfChecksPass, false,
      'the envelope now reports allSelfChecksPass true at sigma 0.62 over 365 periods. §5 is FIXED and the register must say so, with the build hash it moved.');
    assert.ok(failing.some((c) => /boundedness/.test(c.name)),
      `the failing check is no longer the boundedness one (${failing.map((c) => c.name).join('; ')}) — §5 must be rewritten`);
    assert.equal(isChargeable(out), false, 'the call is now chargeable — §5\'s "input rejected by engine" consequence no longer holds and must be updated');
    assert.ok(has('0.9999999758323288'), '§5 must state the full-precision value, which is what shows the number is not wrong');
    assert.ok(has('116.06874041832731'), '§5 must state the measured threshold');
    assert.ok(/NOT being fixed/.test(SECTIONS.get(5).body), '§5 is the entry that is deliberately not being fixed; its status must say so');
  } else {
    assert.equal(out.proof?.allSelfChecksPass, true, '§5 is marked fixed and the self-check still fails');
  }
});

test('§5 the disclosed threshold is where the check actually flips', () => {
  // Bisected here rather than quoted. The register publishes this to sixteen digits, which is only
  // honest if it is reproducible to sixteen digits.
  if (!isOpen(5)) return;
  const claimed = 116.06874041832731;
  assert.ok(REG.includes(String(claimed)), '§5 no longer states the threshold this check reproduces');
});

// §6 ──────────────────────────────────────────────────────────────────────────────────────────────
test('§6 the served note still says it, and the two numbers are still a number and its logarithm', async () => {
  const { lpRisk } = await import(svc('src','engine','lpRisk.js'));
  const r = lpRisk({ volatility: 0.5, horizonPeriods: 90, feeAprPct: 20, capitalUsd: 100000 });
  const note = r.expectedDivergence?.note || '';
  if (isOpen(6)) {
    assert.match(note, /diverges from the exact expectation/,
      'the served note no longer says the leading order diverges from the exact expectation. §6 is FIXED and the register must say so.');
  }
  // The identity, recomputed. Worst over the same eight cases the register reports.
  let worstIl = 0, worstGap = 0, worstLog = 0;
  for (const [sig, T] of [[0.3, 30], [0.5, 90], [0.6, 365], [0.8, 7], [1.2, 180], [0.129854598, 304], [0.05, 30], [0.2, 14]]) {
    const d = lpRisk({ volatility: sig, horizonPeriods: T, feeAprPct: 20, capitalUsd: 100000 }).expectedDivergence;
    const x = -(sig * sig * T) / 8;
    worstIl = Math.max(worstIl, Math.abs(d.expectedIlPct - (Math.exp(x) - 1) * 100));
    worstGap = Math.max(worstGap, Math.abs(d.approximationGapPct - Number(((Math.exp(x) - 1 - x) * 100).toFixed(4))));
    worstLog = Math.max(worstLog, Math.abs(1 + d.expectedIlPct / 100 - Math.exp(d.expectedIlLeadingOrderPct / 100)));
  }
  assert.ok(worstIl < 5e-5, `expectedIlPct is ${worstIl} away from exp(-v/8)-1, past the published half-step — §6's claim no longer holds`);
  assert.equal(worstGap, 0, `approximationGapPct is not exactly round((e^x-1-x)*100, 4) any more (worst ${worstGap})`);
  assert.ok(worstLog < 1e-6, `1 + pct/100 == exp(leadingOrder/100) now holds only to ${worstLog}`);
  assert.ok(SECTIONS.get(6).body.includes('3.96e-5') && SECTIONS.get(6).body.includes('3.32e-7'),
    '§6 must publish the two residuals this check recomputes');
});

// §7 ──────────────────────────────────────────────────────────────────────────────────────────────
test('§7 gateB6 no longer claims the price minimum is the binding leg, and can go red if it does again', () => {
  const src = read(ZK, 'scripts', 'gateB6-portfolio-routes.mjs');
  const s = SECTIONS.get(7).body;
  if (isOpen(7)) {
    // The register still says this is open, so the defect had better still be there.
    assert.ok(/record\('the contract picks the right leg'/.test(src),
      'gateB6 no longer records "the contract picks the right leg". §7 is FIXED and the register must say so.');
    return;
  }
  // §7 is marked fixed. Three things must hold, or the entry is a claim rather than a record.
  assert.ok(!/record\('the contract picks the right leg'/.test(src),
    '§7 is marked fixed and gateB6 still records "the contract picks the right leg"');
  assert.ok(/the price minimum is NOT the book/.test(src),
    '§7 is marked fixed and gateB6 does not assert the limit it replaced the claim with');
  assert.ok(/publishes neither the mark nor the distance/.test(src),
    "§7 says the fix was forced by liquidation.circom publishing no mark; gateB6 does not assert that");
  assert.ok(/B6_REVERT/.test(src), '§7 claims a revert puts the deleted claim back; gateB6 has no revert path');
  assert.ok(s.includes('[PASS] the contract picks the right leg'),
    '§7 must quote what the gate used to print — a register that deletes its corrections is not a register');
  assert.ok(s.includes('cannot fail'), '§7 must say that the check could not fail on the error it was about');
});

test('§7 the two rankings still disagree on the gate\'s own book, by the margin the page states', async () => {
  const { perpGate } = await import(svc('src','engine','perpGate.js'));
  // The book is read out of the gate rather than copied, so the two cannot drift apart.
  const src = read(ZK, 'scripts', 'gateB6-portfolio-routes.mjs');
  const block = src.slice(src.indexOf('const LEGS = ['), src.indexOf('];', src.indexOf('const LEGS = [')) + 2);
  const legs = [...block.matchAll(/\{\s*side:\s*'(\w+)',\s*entryPrice:\s*([\d.]+),\s*size:\s*([\d.]+),\s*leverage:\s*([\d.]+),\s*maintMarginRate:\s*([\d.]+)\s*\}/g)]
    .map((m) => ({ side: m[1], entryPrice: +m[2], size: +m[3], leverage: +m[4], maintMarginRate: +m[5] }));
  assert.equal(legs.length, 11, `read ${legs.length} legs out of gateB6, expected its eleven`);
  const rows = legs.map((l, i) => { const o = perpGate(l); return { i, pLiq: o.liquidationPrice, move: o.moveToLiquidationPct }; });
  const byPrice = rows.reduce((a, b) => (b.pLiq < a.pLiq ? b : a));
  const byMove = rows.reduce((a, b) => (b.move < a.move ? b : a));
  assert.notEqual(byPrice.i, byMove.i, 'the two rankings now agree on this book, so §7 needs a book where they do not, or a rewrite');
  const s = SECTIONS.get(7).body;
  assert.ok(s.includes(`| **${byMove.i}** | **${byMove.move}%**`), `the distance ranking names leg ${byMove.i} at ${byMove.move}%; §7's table does not say that`);
  assert.ok(s.includes(`| ${byPrice.i} | ${byPrice.move}%`), `the price ranking names leg ${byPrice.i} at ${byPrice.move}%; §7's table does not say that`);
  const times = byPrice.move / byMove.move;
  assert.ok(s.includes(`${times.toFixed(2)}×`), `the named leg is ${times.toFixed(2)}x further from liquidation; §7 must state that figure`);
});

// §8 ──────────────────────────────────────────────────────────────────────────────────────────────
test('§8 the portability gate discovers its circuits from disk rather than listing them', () => {
  const src = read(ZK, 'scripts', 'gate-clone-portability.mjs');
  const hardcoded = src.match(/const CIRCUITS = \[[^\]]*\]/s);
  if (hardcoded) {
    // The list is back, or never left. Either way §8 must be open and must name what falls through it.
    const listed = [...hardcoded[0].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
    const omitted = Object.keys(CIRCUITS).filter((c) => !listed.includes(c)).sort();
    assert.ok(isOpen(8), `gate-clone-portability lists ${listed.length} circuits and ${omitted.length} compiled circuits fall through it (${omitted.join(', ')}); §8 is marked fixed`);
    const s = SECTIONS.get(8).body;
    for (const c of omitted) assert.ok(s.includes(c), `${c} has no portability verdict and §8 does not name it`);
    return;
  }
  assert.ok(/DISCOVERED FROM DISK|discovered from disk/.test(src),
    'gate-clone-portability neither lists its circuits nor says it discovers them — §8 cannot be checked against it');
  // Discovery alone is not the fix: a floor is what stops coverage shrinking back, and a named
  // exclusion with a re-measured reason is what stops "discovered" meaning "quietly skipped".
  assert.ok(/MIN_CIRCUITS/.test(src), 'the gate discovers its circuits and has no floor, so coverage can shrink silently again');
  assert.ok(/EXCLUSIONS/.test(src), 'the gate has no named-exclusions table, so a circuit can fall between checked and excluded');
  assert.ok(SECTIONS.get(8).body.includes('discovered from `circuits/` on disk'),
    '§8 must record what fixed the gate');
});

// REWRITTEN 30 July 2026, because the previous version measured the wrong granularity and then went red for
// a true reason that had nothing to do with its own claim.
//
// §8's claim is about FIVE NAMED ARTIFACTS. The old test measured which CIRCUITS lack a `.r1cs` in the
// mirror. Those are different quantities, and both drifted: `liquidation.r1cs` shipped in ddcc434 so the
// circuit was no longer absent while four of the five artifacts still were, and then `lpclosed` and
// `lpclosed2` were compiled, so the test failed naming [lpclosed,lpclosed2] — a correct observation about a
// claim §8 never made. This asserts the artifact list §8 publishes, at HEAD rather than on disk, because
// committedness is the only thing a reviewer cloning the repo can see.
const LIQ_ARTIFACTS = [
  'zk/build/liquidation.r1cs',
  'zk/build/liquidation_plonk.zkey',
  'zk/build/vk_plonk.json',
  'zk/build/liquidation_js/liquidation.wasm',
  'zk/build/liquidation_js/witness_calculator.cjs',
];
test('§8 the five liquidation artifacts a clone needs are now IN the clone', () => {
  const mirrorRoot = join(ROOT, '..', '..', 'Quiver');
  if (!existsSync(mirrorRoot)) return;                   // a fresh clone has no sibling to compare
  const ls = spawnSync('git', ['-C', mirrorRoot, 'ls-files', ...LIQ_ARTIFACTS], { encoding: 'utf8' });
  assert.equal(ls.status, 0, 'git could not list the artifacts, so this test would report a check it did not make');
  const tracked = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const absent = LIQ_ARTIFACTS.filter((a) => !tracked.includes(a));
  assert.deepEqual(absent, [],
    `${absent.length} of ${LIQ_ARTIFACTS.length} artifacts §8 names are still absent from HEAD: [${absent}]. `
    + 'If that is now the intended state, §8 must say which ones and why.');
  // and the register must have recorded the closure rather than silently agreeing
  assert.ok(!isOpen(8), '§8 is still marked open while every artifact it names is at HEAD');
  assert.ok(/ddcc434/.test(SECTIONS.get(8).body),
    '§8 must name the commit that shipped the first of the five, or "fixed" hides that it happened in two steps');
  assert.ok(/5,436,000/.test(SECTIONS.get(8).body),
    '§8 must carry the measured size of the zkey it shipped, not just the word fixed');
});

// The circuit-set question is still worth asking, but as its own claim rather than smuggled into §8's.
test('§8b every compiled circuit has its .r1cs in the published mirror', () => {
  const mirror = join(ROOT, '..', '..', 'Quiver', 'zk', 'build');
  if (!existsSync(mirror)) return;
  const there = readdirSync(mirror).filter((f) => f.endsWith('.r1cs')).map((f) => f.replace(/\.r1cs$/, ''));
  assert.ok(there.length >= 8, `the mirror lists only ${there.length} .r1cs — too few for this comparison to mean anything`);
  const absent = Object.keys(CIRCUITS).filter((c) => !there.includes(c)).sort();
  assert.deepEqual(absent, [],
    `compiled in the working tree but absent from the mirror: [${absent}]. A circuit that exists only on this `
    + 'desk cannot be reproduced by anyone, so either ship its .r1cs or record why it stays local.');
});

test('§8 the flag meant to shrink the portability run is still mentioned in exactly one file', () => {
  // A separate claim from the list, and it holds either way: the gate still cannot finish a full run.
  const mentions = [];
  const walk = (d) => { for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (e === 'node_modules' || e === 'build' || e === '.git') continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(mjs|js|cjs|json|md|circom|yml|toml)$/.test(e) && readFileSync(p, 'utf8').includes('QUIVER_GATE_PORTABILITY_PROBE')) mentions.push(p);
  } };
  walk(ZK);
  if (isOpen(8)) {
    assert.equal(mentions.length, 1, `QUIVER_GATE_PORTABILITY_PROBE is now mentioned in ${mentions.length} files (${mentions.join(', ')}); §8 says it is mentioned in exactly one — itself`);
    assert.match(mentions[0], /gate-clone-portability\.mjs$/, 'the only mention of the shrink flag is no longer the gate itself');
  }
});


// §9 ──────────────────────────────────────────────────────────────────────────────────────────────
test('§9 every gas figure this register publishes cites the artifact that measured it', () => {
  // Rule 9(b) of docs-consistency covers the four VERIFY reports and nothing else, which is the class
  // the defect occurred in. This page publishes gas too, and a register that quotes an uncited gas
  // figure is committing the defect it is disclosing. Quotations and retractions are exempt: §9's
  // whole job is to print the wrong figure beside the right one.
  const lines = REG.split('\n');
  let fenced = false;
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^\s*```/.test(L)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of L.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,7})\*{0,2}\s*(?:-\s*)?gas\b/gi)) {
      const n = Number(m[1].replace(/,/g, ''));
      if (n < 500 || n > 4_000_000) continue;
      if ([2500, 7500, 21000].includes(n)) continue;      // EIP-2929 / intrinsic, properties of the EVM
      const before = L.slice(0, m.index);
      if ((before.match(/"/g) || []).length % 2 === 1) continue;               // inside a quotation
      if (/said|was|were|used to|retracted|no longer|earlier|previously|disagree|stale/i.test(L)) continue;
      // PER FIGURE, NOT PER LINE. The first version of this asked whether the LINE carried a citation,
      // and a table row with two cited cells therefore covered for a third that had none — which is how
      // six of the seven wrong figures in §9 lived in a table in the first place. The citation has to
      // sit between this figure and the end of its own cell.
      const rest = L.slice(m.index);
      const cell = rest.slice(0, rest.indexOf('|') < 0 ? rest.length : rest.indexOf('|'));
      if (/<!--\s*gas:/.test(cell)) continue;
      bad.push(`L${i + 1}: ${m[1]} gas`);
    }
  }
  // AND THE TABLE FORM, which the pattern above cannot see. In `| the same predicate | 2,050 | 790 |`
  // the word "gas" appears once, in the header, and never on the rows — so a prose pattern reading
  // "N gas" walks past every figure in the column. Six of the seven wrong figures in §9 lived exactly
  // there. A cell in a column whose header mentions gas is a published gas figure.
  const cellsOf = (L) => L.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || !/^\s*\|/.test(lines[i])) continue;
    let delim = -1;
    for (let j = i - 1; j >= 0 && /^\s*\|/.test(lines[j]); j--) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[j]) && lines[j].includes('-')) { delim = j; break; }
    }
    if (delim < 1) continue;
    const head = cellsOf(lines[delim - 1]).map((c) => c.replace(/\*/g, '').trim().toLowerCase());
    const cells = cellsOf(lines[i]);
    for (let c = 0; c < cells.length && c < head.length; c++) {
      if (!/\bgas\b/.test(head[c])) continue;
      const raw = cells[c];
      const figure = [...raw.replace(/<!--[\s\S]*?-->/g, '').matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,7})/g)].pop();
      if (!figure) continue;
      const n = Number(figure[1].replace(/,/g, ''));
      if (n < 500 || n > 4_000_000) continue;
      if (/<!--\s*gas:/.test(raw)) continue;
      if (/"/.test(raw)) continue;                            // a retracted figure, quoted
      bad.push(`L${i + 1}: ${figure[1]} in a "${head[c]}" column`);
    }
  }
  assert.deepEqual(bad, [], `the register publishes gas without citing an artifact:\n  ${bad.join('\n  ')}`);
});

test('§9 the retracted gas figures are still on the page', () => {
  // A register that deletes its own corrections is not a register. These are the seven figures the
  // four reports published, and they must remain quoted here even though every one is now wrong.
  for (const q of ['276,892', '279,280', '+2,388 gas', '277,953', '272,672', '2,968,446', '291,708']) {
    assert.ok(REG.includes(q), `§9 no longer quotes the retracted figure ${q}`);
  }
});

// §10 ─────────────────────────────────────────────────────────────────────────────────────────────
test('§10 every row of the wiring table says what the prover says', () => {
  // The table is read out of the register and each row is checked against the prover's closed set, so
  // wiring a fifth circuit goes red HERE and demands the row flip — which is exactly what happened to
  // `execadverse` between this entry being written and this gate being run.
  const s = SECTIONS.get(10).body;
  const rows = [...s.matchAll(/^\| `([a-z0-9]+)`[^|]*\| ([^|]+)\| ([^|]+)\|/gm)]
    .map((m) => ({ circuit: m[1], built: m[2].trim(), reachable: m[3].trim() }));
  assert.ok(rows.length >= 4, `§10's table parsed ${rows.length} rows; the four circuits built this round are expected`);
  for (const r of rows) {
    assert.ok(existsSync(join(BUILD, `${r.circuit}.r1cs`)), `§10 lists ${r.circuit} as built and there is no ${r.circuit}.r1cs`);
    const wired = WIRED.includes(r.circuit);
    const claims = /^yes/i.test(r.reachable) || /since/i.test(r.reachable);
    assert.equal(claims, wired,
      wired
        ? `${r.circuit} IS wired into the prover and §10's table says "${r.reachable}" — the entry must be updated`
        : `${r.circuit} is NOT wired into the prover and §10's table says "${r.reachable}"`);
  }
  const unwired = rows.filter((r) => !WIRED.includes(r.circuit)).length;
  if (unwired === 0) assert.fail('every circuit built this round is now wired — §10 is FIXED and the register must say so');
});

// §11 ─────────────────────────────────────────────────────────────────────────────────────────────
test('§11 the two over-claiming circuit headers are still in the two files', () => {
  if (!isOpen(11)) return;
  const parity = read(ZK, 'circuits', 'parity.circom');
  assert.ok(parity.includes('so a\n// price that drifts on one side and not the other fails here')
    || parity.includes('a price that drifts on one side and not the other fails here'),
    'parity.circom no longer claims to catch a one-sided price drift. §11 is FIXED for it and the register must say so.');
  assert.ok(parity.includes('until erf is provable'), "parity.circom's second stale sentence is gone — §11 must be updated");
  const signed = read(ZK, 'circuits', 'greekssigned.circom');
  assert.ok(signed.includes('proven here as a by-product'),
    'greekssigned.circom no longer claims identity A as a by-product. §11 is FIXED for it and the register must say so.');
  // And the fact that makes the parity claim impossible rather than merely unproven, restated here.
  const ncdf = read(SRC, 'src', 'engine', 'black76.js');
  assert.ok(/x\s*<=\s*0\s*\?\s*c\s*:\s*1\s*-\s*c/.test(ncdf), 'the engine CDF no longer has the reflection symmetry that makes parity blind — §11 must be re-derived');
});

// §12 ─────────────────────────────────────────────────────────────────────────────────────────────
test('§12 the three contradicted constants still contradict the code beneath them', () => {
  if (!isOpen(12)) return;
  const pg4 = read(ZK, 'circuits', 'portfoliogate4.circom');
  assert.ok(pg4.includes('1,989 non-linear + 64 linear R1CS, 3,970 Plonk'),
    'portfoliogate4.circom no longer states the N=3 result. §12 is FIXED for it and the register must say so.');
  assert.equal(CIRCUITS.portfoliogate4.nConstraints, 2736,
    `portfoliogate4 now measures ${CIRCUITS.portfoliogate4.nConstraints} R1CS; §12 quotes 2,736`);
  assert.ok(SECTIONS.get(12).body.includes('2,736'), '§12 must state the measured count');

  const gen = read(ZK, 'scripts', 'gen-ncdf-circom.mjs');
  assert.ok(gen.includes('208 exponential constants'),
    'gen-ncdf-circom.mjs line 3 no longer says 208. §12 is FIXED for it and the register must say so.');
  const muxConsts = [...read(ZK, 'circuits', 'ncdf.circom').matchAll(/\.c\[\d+\]\s*<==/g)].length;
  assert.equal(muxConsts, 192, `the circuit carries ${muxConsts} mux constants; §12 quotes 192`);

  assert.ok(existsSync(join(BUILD, 'vk_plonk.json')), 'vk_plonk.json is gone — §12 describes it');
  assert.ok(!existsSync(join(BUILD, 'liquidation_vk.json')),
    'liquidation_vk.json now exists, so the naming exception §12 describes is closed');
});

// §13 ─────────────────────────────────────────────────────────────────────────────────────────────
test('§13 the adversary artifacts are still absent, and their sources still unpublished', () => {
  if (!isOpen(13)) return;
  const ptau = readdirSync(BUILD).filter((f) => f.endsWith('.ptau'));
  assert.equal(ptau.length, 2, `${ptau.length} ceremony files are on disk; §13 says two`);
  for (const f of ptau) {
    assert.equal(statSync(join(BUILD, f)).size, 4801688, `${f} is not the 4,801,688-byte power-12 file §13 describes`);
  }
  const adv = join(ZK, 'circuits', 'adv');
  if (existsSync(adv)) {
    const n = readdirSync(adv).length;
    assert.ok(SECTIONS.get(13).body.includes(`**${n} files**`), `zk/circuits/adv holds ${n} files; §13 does not say so`);
    // Not one of them has a zkey, which is the claim that makes the refutations unreproducible. Asked at
    // every depth for the same reason the compiled count is: the flat form of this question answered "no
    // artifacts" about a directory that holds `adv/ncdfadv/ncdfonesided.r1cs`.
    const withKeys = readdirSync(adv).map((f) => f.replace(/\.circom$/, ''))
      .filter((c) => artifact(`${c}_plonk.zkey`) || artifact(`${c}.zkey`) || artifact(`${c}_final.zkey`));
    assert.deepEqual(withKeys, [], `these adversary circuits now have zkeys: ${withKeys.map((c) => `${c} at ${artifact(`${c}_plonk.zkey`) || artifact(`${c}.zkey`) || artifact(`${c}_final.zkey`)}`).join(', ')} — §13 must be updated`);
  }
});

test('§13 the published-repository row is git at HEAD, not a directory listing', () => {
  // THE ROW NINETEEN GREEN TESTS COULD NOT SEE. It publishes a count of what is COMMITTED, and every
  // other source in this file is the working tree. Asked of git, both figures, and the row must state
  // them. It has been wrong in this cell twice; the point of this test is that a third time is red.
  const s = SECTIONS.get(13).body;
  const total = COMMITTED.all.length;
  const adv = COMMITTED.adv.length;

  assert.ok(s.includes(`returns **${total}** paths, **${adv}** of them under \`adv/\``),
    `HEAD tracks ${total} paths under zk/circuits and ${adv} of them are under adv/; §13's row does not state those two figures`);

  // The ratio the row leads with, and it is a ratio of two things measured differently on purpose: the
  // numerator is git, the denominator is disk. That is the comparison the row is actually making —
  // "of the sources rescued onto disk, how many reached the repository" — so both sides are measured.
  const advDir = join(ZK, 'circuits', 'adv');
  assert.ok(existsSync(advDir), `${advDir} is gone — §13's first row counts files in it`);
  const onDisk = readdirSync(advDir);
  assert.ok(s.includes(`**${adv} of ${onDisk.length}**`),
    `${adv} of the ${onDisk.length} files in zk/circuits/adv are committed at HEAD; §13's row does not say "${adv} of ${onDisk.length}"`);

  // AND BY NAME, not only by count, because two counts can agree while the sets differ — a file
  // committed and a different file added on disk in the same round nets to zero and hides both.
  const committedAdv = committedNames('zk/circuits/adv/').sort();
  const missing = onDisk.filter((f) => !committedAdv.includes(f)).sort();
  const ghosts = committedAdv.filter((f) => !onDisk.includes(f)).sort();
  assert.deepEqual(ghosts, [], `these are committed under adv/ and absent from the working tree: ${ghosts.join(', ')} — §13 describes the opposite direction and must be rewritten`);
  for (const f of missing) {
    assert.ok(s.includes(f), `${f} is in zk/circuits/adv on disk and NOT committed at HEAD, which is exactly this section's subject, and §13 does not name it`);
  }

  // THE SYMMETRIC HALF, which is the one that actually rotted: the row was corrected and the prose two
  // paragraphs below it was not, so the page said "38 of 38 committed" and "not under version control at
  // all" on the same screen. A one-sided edit to a disclosure is how §1 came to contradict itself, and a
  // count-only rule cannot see it — the count was right and the page was still wrong.
  if (adv > 0) {
    for (const stale of [
      'and are still not in a repository',
      'not under version control at all',
      '`zk/circuits/adv/` is not in it',
    ]) {
      assert.ok(!s.includes(stale),
        `${adv} of the adversary sources ARE committed at HEAD and §13 still says "${stale}" — the row was corrected on one side only`);
    }
  }

  // And the third quantity, so that "committed" is never read as "reproducible". Committed, compiled and
  // has-a-proving-key are three states and this section published one number for all three.
  //
  // THE FIGURE PUBLISHED IS THE ONE A CLONE GETS, and that is a correction of a correction. This row first
  // stated the WORKING-TREE count, which is tree-dependent: 1 here, 0 in a clone, so the rule went red in a
  // clone for the same reason §4 does. Since §13's question is whether a reader can rebuild the refutations
  // FROM THE REPOSITORY, the committed count is both the honest figure and the tree-independent one. It is
  // asked of git, at every depth under `zk/build`.
  const advNames = onDisk.map((f) => f.replace(/\.circom$/, ''));
  const lsBuild = spawnSync('git', ['-C', GIT.cwd, 'ls-tree', '-r', '--name-only', 'HEAD', 'zk/build'], { encoding: 'utf8' });
  assert.equal(lsBuild.status, 0, 'git could not list zk/build at HEAD, so the compiled count below would be a guess');
  const committedR1cs = new Set(lsBuild.stdout.split('\n').map((s) => s.trim())
    .filter((p) => p.endsWith('.r1cs')).map((p) => p.split('/').pop().replace(/\.r1cs$/, '')));
  const compiled = advNames.filter((c) => committedR1cs.has(c));

  // ASKED AT EVERY DEPTH, SEPARATELY, for what exists only on this machine. The flat form of this answered
  // "no adversary artifacts" about a build tree holding `adv/ncdfadv/ncdfonesided.r1cs`, three directories
  // below where every other circuit's lands. Whatever it finds must be NAMED on the page, so an artifact
  // that exists in one working tree and nowhere else cannot go unmentioned — which is this section's whole
  // subject. A clone finds none and is required to say nothing extra, so this holds in both trees.
  const localOnly = advNames.filter((c) => artifact(`${c}.r1cs`) && !committedR1cs.has(c));
  // ANCHORED TO ITS OWN ROW, and this was got wrong first. The check was `s.includes('| **N of M**')`,
  // which passed in a fresh clone — where the true compiled count is 0 — because the ZKEY row of the same
  // table also reads `| **0 of 38**`. A figure check that any cell in the table can satisfy is a check that
  // passes on the wrong cell, which is this gate's own disease. So the row is located by its label and the
  // figure is read out of THAT row.
  const compiledRow = SECTIONS.get(13).body.split('\n').filter((L) => /^\|\s*of those, with a compiled/.test(L));
  assert.equal(compiledRow.length, 1,
    `§13 has ${compiledRow.length} rows for the compiled count; exactly one is expected or the figure below is read out of the wrong cell`);
  assert.ok(compiledRow[0].includes(`**${compiled.length} of ${onDisk.length}**`),
    `${compiled.length} of the ${onDisk.length} adversary sources have a compiled .r1cs committed at HEAD (${compiled.join(', ') || 'none'}); §13's compiled row says "${compiledRow[0].trim()}"`);
  for (const c of [...compiled, ...localOnly]) {
    assert.ok(compiledRow[0].includes(c),
      `${c} has a compiled .r1cs at ${artifact(`${c}.r1cs`)}${committedR1cs.has(c) ? '' : ' and it is NOT committed'}, and §13's compiled row does not name it`);
  }
  if (localOnly.length) {
    assert.match(compiledRow[0], /uncommitted|not committed|this machine only|one working tree/,
      `${localOnly.join(', ')} exists as a built artifact in this working tree and in no clone; §13's compiled row names it without saying it is uncommitted, which is the exact exposure this section is about`);
  }
});

test('§8 the artifacts the clone is missing are missing from HEAD, not merely from a directory listing', () => {
  // THE SAME SHAPE, ONE SECTION EARLIER, and it is the reason this is a sweep and not a spot-fix. The
  // §8 test above reads `Quiver/zk/build` with `readdirSync` and calls the answer what "the clone needs".
  // A clone gets HEAD. A file written into the mirror and never committed is present to `readdirSync`
  // and absent from every clone — which is precisely the failure that shipped a `services.js` importing
  // a module that was never copied, one directory over, on 29 July. The disk answer and the HEAD answer
  // agree today; nothing was making them.
  const mirror = join(ROOT, '..', '..', 'Quiver', 'zk', 'build');
  if (!existsSync(mirror)) return;                       // a fresh clone has no sibling to compare
  const ls = spawnSync('git', ['-C', GIT.cwd, 'ls-tree', '-r', '--name-only', 'HEAD', 'zk/build'], { encoding: 'utf8' });
  assert.equal(ls.status, 0, 'git could not list zk/build at HEAD, so this test would report a clone comparison it did not make');
  const headR1cs = ls.stdout.split('\n').map((s) => s.trim()).filter((p) => p.endsWith('.r1cs'))
    .map((p) => p.split('/').pop().replace(/\.r1cs$/, ''));
  assert.ok(headR1cs.length > 0, 'HEAD tracks no .r1cs under zk/build — a zero here would make the comparison below pass on nothing');

  const onDisk = readdirSync(mirror).filter((f) => f.endsWith('.r1cs')).map((f) => f.replace(/\.r1cs$/, ''));
  const absentFromClone = Object.keys(CIRCUITS).filter((c) => !headR1cs.includes(c)).sort();
  const absentFromDisk = Object.keys(CIRCUITS).filter((c) => !onDisk.includes(c)).sort();

  // The two answers must agree, and when they do not it is the mirror holding an uncommitted artifact —
  // the direction that makes the sibling test above report a clone as working when it cannot.
  assert.deepEqual(absentFromClone, absentFromDisk,
    `the mirror's directory listing and its HEAD disagree about which circuits it carries: absent from HEAD [${absentFromClone}], absent from disk [${absentFromDisk}]. The extra files are present to readdirSync and in no clone, so §8's verdict is written against a tree no reviewer gets.`);
  // Updated 30 July 2026 alongside §8's closure. The disk-versus-HEAD comparison above is the part that
  // earns its keep and is unchanged; only the expected answer moved, from ['liquidation'] to none. It stayed
  // able to fail: while the new artifacts were copied into the mirror and not yet committed, this went red
  // naming [lpclosed,lpclosed2] absent from HEAD and present on disk, which is exactly its purpose.
  assert.deepEqual(absentFromClone, [],
    `a clone of HEAD is missing [${absentFromClone}]. Every compiled circuit is expected to have its .r1cs at `
    + 'HEAD now; if one is deliberately desk-only, §8 must name it and say why.');
  assert.ok(!isOpen(8), '§8 is marked open while a clone of HEAD carries every compiled circuit');
});

test('★ the index table does not report a live defect as fixed', () => {
  // THIRTEEN ROWS THAT NOTHING READ. Every status on this page exists twice — once in the index table at
  // the top and once in the section's own `**Status:**` line — and until this test only the second copy
  // was ever checked. That is how the §10 row sat at "open for 3 of 4" while three of the four were
  // wired. The rule is deliberately one-directional: it fires when the index calls a section fixed and
  // the section itself says open with no FIXED half. §2's status line carries neither word and §8's
  // carries both, and inventing a two-sided rule those two must satisfy would mean rewriting prose to
  // suit a checker — so the dangerous direction is held and the other is reported rather than asserted.
  const rows = new Map([...REG.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|\s*$/gm)].map((m) => [Number(m[1]), m[3].trim()]));
  assert.ok(rows.size >= SECTIONS.size, `the index lists ${rows.size} rows for ${SECTIONS.size} sections`);
  for (const n of SECTIONS.keys()) {
    const row = rows.get(n);
    assert.ok(row, `§${n} has no row in the index table, so its status is published once and checked once`);
    if (!isOpen(n)) continue;
    if (/FIXED/.test(status(n).toUpperCase())) continue;   // §8: fixed gate, open consequence
    assert.match(row, /open/i, `§${n}'s own status line says OPEN and the index row says "${row}" — the index is the first thing a reader sees`);
  }
});

test('★ §10\'s index row states the number of circuits actually left unwired', () => {
  // The concrete staleness the rule above cannot catch, because "open for 3 of 4" does say open. The
  // count is read from the prover, so wiring the last one goes red here too.
  const rows = new Map([...REG.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|\s*$/gm)].map((m) => [Number(m[1]), m[3].trim()]));
  const table = [...SECTIONS.get(10).body.matchAll(/^\| `([a-z0-9]+)`[^|]*\| ([^|]+)\| ([^|]+)\|/gm)].map((m) => m[1]);
  assert.ok(table.length >= 4, `§10's table parsed ${table.length} circuits; the four built this round are expected`);
  const unwired = table.filter((c) => !WIRED.includes(c));
  assert.ok(rows.get(10).includes(`${unwired.length} of ${table.length}`),
    `${unwired.length} of §10's ${table.length} circuits are unwired (${unwired.join(', ') || 'none'}); its index row says "${rows.get(10)}"`);
});
