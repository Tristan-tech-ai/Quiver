// The scripted revert for gate X.
//
// A gate that has never been seen to fail is a claim, not a check. This script puts each defect back
// into the real documents, one at a time, regenerates the machine edition exactly as a human would,
// and requires gate X to go RED on that defect BY NAME — then restores the file and requires it to go
// GREEN again, because red-in-both-states is a broken gate rather than a working one.
//
// Defects 1–4 are the four the judge sweep found, restored verbatim from the pre-fix text. For each
// of those it ALSO runs `tools/docs-consistency.mjs` and requires it to stay GREEN. That is not a
// criticism of that tool; it is the blind spot being DEMONSTRATED rather than asserted, which is the
// only way anyone should believe a claim about what a check cannot see.
//
//   1. FURTHER-1   §1 contributions: "386 automated tests … a further five" — asserts 391.
//   2. FURTHER-2   §3.6: same additive error, plus "None of the 333 fails" — a passing count two
//                  review rounds stale, and the only one of the four that quotes a wrong integer.
//   3. FURTHER-3   §6.1: "alongside a further five".
//   4. ALL-PASS    Table 2 caption: "All currently pass." while five never run.
//   5. README-152  the working tree's own README, stale by 234 tests. Not in the sweep — gate X
//                  found it, because docs-consistency walks only the TOP level of hackathon/.
//   6. UNREGEN     edit whitepaper.html and do not regenerate. The parts are GENERATED; a correction
//                  made only in the source silently fails to reach what /paper/N serves, and the
//                  reverse (editing a part directly) is overwritten on the next build. Either way the
//                  source and the served copy disagree, and that must be visible.
//   7. LOSTPART    a whitepaper.part*.md goes missing, so what is on disk no longer matches what the
//                  text packs into.
//
//   node gates/gateX-revert.mjs        (npm run gate:x-revert)
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..', '..');
const ASSETS = join(ROOT, 'assets');
const MIRROR = join(REPO, 'Quiver', 'assets');
const HTML = join(ASSETS, 'whitepaper.html');
const README = join(ROOT, 'README.md');

// ── runners ──────────────────────────────────────────────────────────────────────────────────────
function runGateX() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_TEST_/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateX-paper-contradiction.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 900_000, env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const n = (label) => Number((out.match(new RegExp(`^(?:ℹ|#)\\s*${label}\\s+(\\d+)$`, 'm')) || [])[1] ?? -1);
  const pass = n('pass'), fail = n('fail');
  if (pass < 0 || fail < 0) {
    console.error(out.slice(-3000));
    throw new Error("could not read gate X's runner summary — the verdicts below would be invented");
  }
  const failed = [...new Set([
    ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
    ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
  ])].filter((x) => !/^gates[\\/]/.test(x));
  if (fail > 0 && !failed.length) {
    console.error(out.slice(-3000));
    throw new Error(`gate X reported ${fail} failure(s) and this script could not name any of them`);
  }
  const notes = [...out.matchAll(/^\s{4}(\S+?):(\d+) — (.+)$/gm)].map((m) => ({ file: m[1], line: Number(m[2]), msg: m[3] }));
  return { pass, fail, failed, notes, out };
}

function runDocsConsistency() {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'docs-consistency.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { green: /^CONSISTENT/m.test(out), out: out.trim().split('\n')[0] };
}

function regenerate() {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'paper-to-text.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  if (r.status !== 0) throw new Error(`paper-to-text failed:\n${r.stdout}${r.stderr}`);
  const parts = Number((r.stdout.match(/parts\s+(\d+)/) || [])[1] ?? -1);
  // Mirror, exactly as the real workflow does — the two trees are byte-identical by contract, and a
  // revert that updated only one of them would be caught by the cross-tree rule instead of the rule
  // under test, attributing the catch to the wrong check.
  if (existsSync(MIRROR)) {
    for (const f of readdirSync(ASSETS)) {
      if (/^whitepaper\.(html|md|parts\.json|part\d+\.md)$/.test(f)) copyFileSync(join(ASSETS, f), join(MIRROR, f));
    }
  }
  return parts;
}

// ── the defects ──────────────────────────────────────────────────────────────────────────────────
// `fixed` is today's text; `stale` is what shipped. Applying a revert is a single exact replacement,
// so a wording drift makes this script fail loudly rather than silently test nothing.
const DEFECTS = [
  {
    id: 'FURTHER-1', file: HTML, regen: true, site: 'whitepaper.part1.md:195 (§1 contributions)',
    expect: ['no arithmetic claim that does not add up'],
    fixed: '386 automated tests of model-free invariants, of which 381 run on every build and five are live-archive integration tests skipped unless an archive RPC is configured, a ground-truthing protocol',
    stale: '386 automated tests of model-free invariants that run on every build, a further five live-archive integration tests behind an RPC flag, a ground-truthing protocol',
  },
  {
    id: 'FURTHER-2', file: HTML, regen: true, site: 'whitepaper.part1.md:303 (§3.6 Proven by test)',
    expect: ['no arithmetic claim that does not add up',
             'every published suite figure matches what npm test actually reports',
             'no two published documents state the same quantity differently'],
    fixed: 'it currently holds 386 tests, of which 381 run on every build and five are live-archive integration tests that are SKIPPED unless an archive RPC is configured. None of the 381 fails;',
    stale: 'it currently holds 386 tests that run on every build, with a further five live-archive integration tests that are SKIPPED unless an archive RPC is configured. None of the 333 fails;',
  },
  {
    id: 'FURTHER-3', file: HTML, regen: true, site: 'whitepaper.part4.md:28 (§6.1 invariant suite)',
    expect: ['no arithmetic claim that does not add up'],
    fixed: 'with no external dependency &mdash; 381 of them run on every build, and five are live-archive integration tests exercised behind an RPC flag.',
    stale: 'with no external dependency, alongside a further five live-archive integration tests exercised behind an RPC flag.',
  },
  {
    id: 'ALL-PASS', file: HTML, regen: true, site: 'whitepaper.part4.md Table 2 caption',
    expect: ['nothing claims "all pass" while tests are skipped'],
    fixed: 'Table 2 &mdash; representative invariants from the 386-test suite. The 381 that run in the default environment all pass; five need an archive node.',
    stale: 'Table 2 &mdash; representative invariants from the 386-test suite. All currently pass.',
  },
  {
    id: 'README-152', file: README, regen: false, site: 'hackathon/veritape/README.md:63',
    expect: ['every published suite figure matches what npm test actually reports',
             'no two published documents state the same quantity differently'],
    fixed: 'npm test                # 386 model-free tests (put-call parity, no-lookahead, martingale, greek finite-difference, liquidation invariant, …); 381 run here, 5 live-archive tests are skipped unless an archive RPC is configured',
    stale: 'npm test                # 152 model-free tests (put-call parity, no-lookahead, martingale, greek finite-difference, liquidation invariant, …) + 5 live-archive tests behind an RPC flag',
  },
  {
    // The trap the whole "edit the HTML, not the parts" rule exists to prevent, in its other
    // direction: a correction made in the source that never reaches what is served.
    id: 'UNREGEN', file: HTML, regen: false, site: 'whitepaper.html vs the generated parts',
    expect: ['no two published documents state the same quantity differently'],
    fixed: 'None of the 381 fails;',
    stale: 'None of the 333 fails;',
  },
];

// ── harness ──────────────────────────────────────────────────────────────────────────────────────
const BACKUP = join(tmpdir(), `gateX-revert-${process.pid}`);
mkdirSync(BACKUP, { recursive: true });
const saved = [];
const save = (p) => { const b = join(BACKUP, `${saved.length}-${basename(p)}`); copyFileSync(p, b); saved.push([p, b]); };
save(HTML); save(README);
for (const f of readdirSync(ASSETS)) if (/^whitepaper\.(md|parts\.json|part\d+\.md)$/.test(f)) save(join(ASSETS, f));
if (existsSync(MIRROR)) for (const f of readdirSync(MIRROR)) if (/^whitepaper\.(html|md|parts\.json|part\d+\.md)$/.test(f)) save(join(MIRROR, f));
const ORIGINAL_PARTS = readdirSync(ASSETS).filter((f) => /^whitepaper\.part\d+\.md$/.test(f)).length;
const restoreAll = () => {
  for (const [p, b] of saved) copyFileSync(b, p);
  // A revert that GROWS the paper creates part files that no backup can restore over. Sweep any
  // part beyond the original count out of both trees, or the next run starts from a dirty tree and
  // every verdict after it is about a document nobody wrote.
  for (const dir of [ASSETS, MIRROR]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^whitepaper\.part(\d+)\.md$/);
      if (m && Number(m[1]) > ORIGINAL_PARTS) rmSync(join(dir, f));
    }
  }
};

const results = [];
let ok = true;
const say = (s = '') => console.log(s);

try {
  say('gate X — scripted revert');
  say('='.repeat(78));
  say('\n[0] BASELINE — the gate must be green before any of this means anything.');
  const base = runGateX();
  say(`    gate X: ${base.fail === 0 ? 'GREEN' : 'RED'} (${base.pass} passed, ${base.fail} failed)`);
  if (base.fail !== 0) {
    base.failed.forEach((f) => say(`      ✖ ${f}`));
    throw new Error('baseline red — a revert proves nothing from here');
  }

  for (const d of DEFECTS) {
    say(`\n[${d.id}] restoring the pre-fix text at ${d.site}`);
    const src = readFileSync(d.file, 'utf8');
    if (!src.includes(d.fixed)) throw new Error(`${d.id}: the corrected text is not present — this script is out of date with the document`);
    writeFileSync(d.file, src.replace(d.fixed, d.stale), 'utf8');
    if (d.regen) say(`    regenerated: ${regenerate()} parts`);

    const g = runGateX();
    const missed = d.expect.filter((e) => !g.failed.some((f) => f.includes(e)));
    const hit = d.expect.filter((e) => g.failed.some((f) => f.includes(e)));
    say(`    gate X: ${g.fail > 0 ? 'RED' : 'GREEN'} — ${g.fail} check(s) failed`);
    for (const f of g.failed) say(`      ✖ ${f}`);
    for (const nte of g.notes.slice(0, 3)) say(`         ${nte.file}:${nte.line} — ${nte.msg.slice(0, 150)}`);
    if (missed.length) { say(`    EXPECTED but did not fire: ${missed.join('; ')}`); ok = false; }

    let docs = null;
    if (/^FURTHER|^ALL-PASS/.test(d.id)) {
      docs = runDocsConsistency();
      say(`    tools/docs-consistency.mjs: ${docs.green ? 'GREEN — blind to this defect' : 'RED'}  «${docs.out}»`);
    }
    results.push({ id: d.id, red: g.fail > 0 && !missed.length, hit, docsGreen: docs?.green ?? null });

    restoreAll();
    if (d.regen) regenerate();
  }

  // 7. The hard constraint itself. The splitter packs greedily against a 55 kB budget AT section
  //    boundaries — it does NOT simply cut at every boundary — so part 4, which sits 173 bytes under
  //    the budget. This is NOT a pass/fail case — it is a MEASUREMENT of a residual gap, run here so
  //    the number is on the record rather than reasoned about. What it shows: 465 bytes added to §6
  //    leaves the part COUNT at seven while moving §8 Limitations out of part 4 and into part 5. So
  //    "the count is still 7" does not mean the served document is unchanged, and no check in this
  //    repository can currently assert the section-to-part MAPPING, because whitepaper.parts.json is
  //    regenerated alongside the parts and therefore cannot witness its own drift.
  say('\n[BOUNDARY] measuring how little prose moves a section between parts (informational)');
  {
    const src = readFileSync(HTML, 'utf8');
    const anchor = 'The load-bearing tests are the following.</p>';
    if (!src.includes(anchor)) throw new Error('BOUNDARY: the §6.1 anchor has moved');
    const filler = `\n\n<p>${'This sentence exists only to occupy bytes inside section six so that the greedy packer in tools/paper-to-text.mjs is pushed past its budget. '.repeat(4)}</p>`;
    const before = JSON.parse(readFileSync(join(ASSETS, 'whitepaper.parts.json'), 'utf8'));
    writeFileSync(HTML, src.replace(anchor, anchor + filler), 'utf8');
    const n = regenerate();
    const after = JSON.parse(readFileSync(join(ASSETS, 'whitepaper.parts.json'), 'utf8'));
    const moved = after.titles.map((t, i) => (before.titles[i] === t ? null : i + 1)).filter(Boolean);
    say(`    +465 B into §6 → part count ${before.count} → ${n}; parts whose contents changed: ${moved.length ? moved.join(', ') : 'none'}`);
    for (const i of moved) {
      say(`      /paper/${i} was «${before.titles[i - 1].slice(0, 62)}»`);
      say(`               now «${after.titles[i - 1].slice(0, 62)}»`);
    }
    say('    → the COUNT is not the contract; the MAPPING is. Nothing asserts the mapping today.');
  }
  restoreAll();
  regenerate();

  // 8. A generated part goes missing — what is on disk no longer matches what the text packs into.
  //    NOTE: the main suite also goes red here, because tests read the part files. That is defence in
  //    depth rather than noise, and gate X's first check reports it honestly ("the suite is failing;
  //    every documentation figure below is moot") instead of grading prose against a broken build.
  say('\n[LOSTPART] removing assets/whitepaper.part7.md (a partial write, a bad merge, a lost file)');
  rmSync(join(ASSETS, 'whitepaper.part7.md'));
  if (existsSync(join(MIRROR, 'whitepaper.part7.md'))) rmSync(join(MIRROR, 'whitepaper.part7.md'));
  {
    const g = runGateX();
    const expect = 'the served part count still matches what the text packs into';
    const fired = g.failed.some((f) => f.includes(expect));
    say(`    gate X: ${g.fail > 0 ? 'RED' : 'GREEN'} — ${g.fail} check(s) failed`);
    for (const f of g.failed) say(`      ✖ ${f}`);
    for (const nte of g.notes.slice(0, 2)) say(`         ${nte.file}:${nte.line} — ${nte.msg.slice(0, 150)}`);
    if (!fired) { say(`    EXPECTED but did not fire: ${expect}`); ok = false; }
    results.push({ id: 'LOSTPART', red: fired, hit: [expect], docsGreen: null });
  }
  restoreAll();
  regenerate();

  say('\n[RESTORED] every file back as it was — the gate must be green again.');
  const fin = runGateX();
  say(`    gate X: ${fin.fail === 0 ? 'GREEN' : 'RED'} (${fin.pass} passed, ${fin.fail} failed)`);
  if (fin.fail !== 0) { fin.failed.forEach((f) => say(`      ✖ ${f}`)); ok = false; }
  const finDocs = runDocsConsistency();
  say(`    tools/docs-consistency.mjs: ${finDocs.green ? 'GREEN' : 'RED'}  «${finDocs.out}»`);
  if (!finDocs.green) ok = false;

  say('\n' + '='.repeat(78));
  say('summary');
  for (const r of results) {
    const d = r.docsGreen === null ? '' : `   docs-consistency ${r.docsGreen ? 'GREEN (blind)' : 'RED'}`;
    say(`  ${r.red ? 'CAUGHT ' : 'MISSED '} ${r.id.padEnd(11)} by: ${r.hit.join(', ') || '—'}${d}`);
  }
  const ORIGINAL_FOUR = ['FURTHER-1', 'FURTHER-2', 'FURTHER-3', 'ALL-PASS'];
  const blind = results.filter((r) => ORIGINAL_FOUR.includes(r.id) && r.docsGreen === true).length;
  const caughtFour = results.filter((r) => ORIGINAL_FOUR.includes(r.id) && r.red).length;
  say(`\n  gate X caught ${results.filter((r) => r.red).length}/${results.length} reverted defects,`);
  say(`  including ${caughtFour}/4 of the judge sweep's original findings,`);
  say(`  while tools/docs-consistency.mjs stayed green on ${blind}/4 of them — the gap this gate closes.`);
  say(ok ? '\nPASSED — every defect was caught by name, and the gate is green once restored.'
        : '\n*** FAILED *** — see the lines above.');
} finally {
  restoreAll();
  try { regenerate(); } catch { /* restoring the files is what matters */ }
  rmSync(BACKUP, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
