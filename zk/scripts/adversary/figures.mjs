// Do the figures PUBLISHED about the reproduction agree with the reproduction?
//
// Every assertion in repro.mjs checks a circuit. Nothing checked the write-up, and on 30 July 2026
// the write-up was wrong in six separate places while every gate in the tree was green:
//
//   1. it published "61 assertions, 61 pass" against an artifact holding 62 passing rows;
//   2. its size table published the write-up's own size as 35,251 when the file was 35,396 — because
//      the number was measured, then written down, and writing it down grew the file by 145 bytes;
//   3. that same 145 bytes therefore propagated into the text subtotal and the grand total;
//   4. its `zk/scripts/adversary/` row said 286,480 bytes, a working-tree reading from before the
//      last edits of the commit that published it — and the table's OWN total used 290,429, so the
//      table did not add up to itself;
//   5. it called `ctl.circom` "21,376 bytes"; that file has been 21,385 in every commit it appears in;
//   6. its §9 clone-test row repeated the 61 in a second place.
//
// None of the six is a hard defect and all six are the same defect: a number that lives only in
// prose, with nothing in the repository able to contradict it. This file is what contradicts it.
//
// THE FIXED POINT, AND WHY THE WRITE-UP IS NOT IN THE MEASURED SET
//
// Defect 2 is not a typo. A document that records its own size is a fixed-point problem: the act of
// writing the figure changes the figure. It is *solvable* — replacing a six-digit number with another
// six-digit number is byte-neutral, so 35,396 would have been stable the moment it was written — and
// that is exactly why it is the wrong answer. The fixed point has to be re-solved on EVERY later edit
// to the document, forever, and no gate can help, because the gate would have to know the file's size
// after the edit that publishes it. So the write-up is excluded from the measured set, by name, and
// the exclusion is asserted here: the size table's total must equal the sum of the rows the table
// shows, and a row this file does not recognise is a hard failure rather than an unchecked row.
//
// WHY THE SET IS DEFINED BY MANIFEST.json AND NOT BY A DIRECTORY GLOB
//
// `zk/circuits/adv/` is shared. While this file was being written another session committed
// `ncdfonesided.circom` into it, +21,759 bytes, and five commits from other sessions landed on HEAD. A
// figure globbed over that directory would drift for reasons that have nothing to do with the four
// refutations. MANIFEST.json enumerates precisely the circuits and probes the reproduction pins, so the
// set is defined by the work rather than by where the work happens to live. Measured across 5ca5137 and
// every later HEAD checked, the manifest-defined set of circuits is byte-identical at all of them:
// 245,992 bytes in 37 files.
//
// WHY `git ls-tree` AND NOT THE WORKING TREE
//
// Defects 4 and 5 are both working-tree readings. `git ls-tree -l` reports the blob size — what a
// reader who clones actually receives — and it reports it for a named tree, so the number refers to
// something that exists. The working tree is a draft; it is also, on this machine, subject to
// `core.autocrlf=true`, so a text file's on-disk length is not necessarily its blob length.
//
// Consequence, stated because it is a real constraint and not a bug: the published figures describe
// HEAD. If a file in the measured set is dirty, the figure being checked is not the figure the
// reader would get, so that is a failure and not a warning.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import P from './paths.mjs';

// The commit before the first commit of this work. The repository-growth denominator has to be the
// repository as it was BEFORE, which is a past event and therefore a named immutable object — the one
// place in this file where naming a commit is the correct answer rather than the tempting one.
export const BASELINE = '41f0b93120512a63722fce6f5d68a53983cf3b98';   // 620c041^, 199,061,444 bytes
// The derived binaries the four adversaries produced and this repository deliberately does not carry.
// §2 of the write-up enumerates them by class; this is that table's total.
export const DERIVED_BYTES = 762139277;

export const REVERT_MODES = {
  'row-count': 'claim one fewer passing row than the artifact holds — the 61-against-62 defect',
  'self-include': 'put the write-up back into the measured set — the 145-byte fixed point',
  'stale-row': 'read the size table off 5ca5137, the tree as it was when the broken table was published',
  'derived-denominator': 'divide the repository growth by the derived binaries instead of the repository',
  'mirror-drop': 'pretend one file of the set never reached the dev tree — the discipline-3 failure',
};

// ── where things are ─────────────────────────────────────────────────────────────────────────────
// The dev tree is not a git repository; the mirror is. Two layouts, PROBED rather than assumed,
// exactly as paths.mjs does it, and a miss is fatal — a size check that silently finds no repository
// is a check that passes on an empty tree.
const GIT_CANDIDATES = [
  path.resolve(P.ZK, '..'),                       // mirror clone: <repo>/zk -> <repo>
  path.resolve(P.ZK, '..', 'Quiver'),             // working tree: "research startup"/Quiver
];
export const GIT_ROOT = GIT_CANDIDATES.find((c) => existsSync(path.join(c, '.git')));

// The write-up, under both names it is published as. The mirror is what the world clones; the
// `hackathon/` copy is what gets pasted into forms, and historically that is where the stale copy
// survives — so both are read and both are held to the same figures.
export const WRITEUP_IN_REPO = 'docs/fix-reproducible-artifacts.md';
const WRITEUP_COPIES = () => {
  const out = [];
  if (GIT_ROOT) {
    const m = path.join(GIT_ROOT, ...WRITEUP_IN_REPO.split('/'));
    if (existsSync(m)) out.push(m);
  }
  const h = path.resolve(P.ZK, '..', 'hackathon', 'FIX_REPRODUCIBLE_ARTIFACTS.md');
  if (existsSync(h)) out.push(h);
  return out;
};

const git = (args, cwd = GIT_ROOT) =>
  execFileSync('git', args, { cwd, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// `git ls-tree -r -l <rev> -- <paths>` parsed to {path, size}. The size is the BLOB size.
const lsTree = (rev, paths) => {
  const out = git(['ls-tree', '-r', '-l', rev, '--', ...paths]).trim();
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t(.*)$/);
    if (!m) throw new Error(`figures.mjs: cannot parse ls-tree line: ${l}`);
    return { size: Number(m[1]), path: m[2] };
  });
};

// ── the measured set ─────────────────────────────────────────────────────────────────────────────
// Five groups, in the order the table publishes them. `key` is what a table row is matched on.
export function measureSet(rev, { selfInclude = false } = {}) {
  const man = JSON.parse(readFileSync(path.join(P.ZK, 'scripts', 'adversary', 'MANIFEST.json'), 'utf8'));
  const pinnedCircom = new Set(
    Object.keys(man.files).filter((k) => k.startsWith('circuits/adv/')).map((k) => `zk/${k}`),
  );
  const circom = lsTree(rev, ['zk/circuits/adv/']).filter((f) => pinnedCircom.has(f.path));
  if (circom.length !== pinnedCircom.size) {
    throw new Error(`figures.mjs: MANIFEST.json pins ${pinnedCircom.size} circuits but ${circom.length}`
      + ` are in ${rev}. The measured set is not the set the manifest describes.`);
  }
  const scripts = lsTree(rev, ['zk/scripts/adversary/']);
  const gates = lsTree(rev, ['gates/']).filter((f) => /^gates\/gateZ.*\.mjs$/.test(f.path));
  const ptau = lsTree(rev, ['zk/build/hez_final_12.ptau']);
  const writeup = lsTree(rev, [WRITEUP_IN_REPO]);
  if (!ptau.length) throw new Error(`figures.mjs: zk/build/hez_final_12.ptau is not in ${rev}`);
  if (!writeup.length) throw new Error(`figures.mjs: ${WRITEUP_IN_REPO} is not in ${rev}`);

  const groups = [
    { key: 'circuits/adv', files: circom },
    { key: 'scripts/adversary', files: selfInclude ? [...scripts, ...writeup] : scripts },
    { key: 'gateZ', files: gates },
    { key: 'ptau', files: ptau },
  ];
  const sum = (a) => a.reduce((x, y) => x + y.size, 0);
  for (const g of groups) { g.bytes = sum(g.files); g.count = g.files.length; }
  const text = groups.filter((g) => g.key !== 'ptau');
  return {
    rev,
    groups,
    all: groups.flatMap((g) => g.files),
    textBytes: sum(text.flatMap((g) => g.files)),
    textFiles: text.reduce((n, g) => n + g.count, 0),
    totalBytes: sum(groups.flatMap((g) => g.files)),
    totalFiles: groups.reduce((n, g) => n + g.count, 0),
    writeupBytes: writeup[0].size,
  };
}

// ── parsing the write-up ─────────────────────────────────────────────────────────────────────────
// Every extractor demands an EXACT match count. A parser that finds nothing and reports nothing is
// the same animal as a gate with no assertions in it: this one throws, and the caller treats a throw
// as a failure rather than as an absence.
const one = (re, s, what, file) => {
  const m = [...s.matchAll(re)];
  if (m.length !== 1) {
    throw new Error(`figures.mjs: ${path.basename(file)} has ${m.length} matches for ${what}, expected 1.`
      + ` The document's shape moved and this check would otherwise pass by not looking.`);
  }
  return m[0];
};
const anchored = (s, anchor, file) => {
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error(`figures.mjs: ${path.basename(file)} has no ${anchor} anchor`);
  if (s.indexOf(anchor, i + 1) >= 0) throw new Error(`figures.mjs: ${path.basename(file)} has two ${anchor} anchors`);
  return i;
};
// From an anchor to the end of its PARAGRAPH, not the end of its line. Prose in these documents is
// hard-wrapped at 100 columns, so a sentence that begins beside the anchor routinely ends two lines
// later — reading one line found zero percentages and reported a malformed document instead of
// checking one.
const paraAt = (s, i) => {
  const b = s.indexOf('\n\n', i);
  return s.slice(i, b < 0 ? s.length : b);
};
const num = (t) => Number(String(t).replace(/,/g, ''));

// The row-to-group mapping. A table row that matches none of these is fatal: an unrecognised row is
// an unchecked row, and an unchecked row in a table whose whole subject is "we got this wrong once"
// would be the defect walking back in. This is also what stops the write-up being re-added: a
// `docs/fix-reproducible-artifacts.md` row matches nothing here and goes red.
const ROW_KEYS = [
  ['circuits/adv', /zk\/circuits\/adv\//],
  ['scripts/adversary', /zk\/scripts\/adversary\//],
  ['gateZ', /gates\/gateZ/],
  ['ptau', /hez_final_12\.ptau/],
  ['total', /^\s*\|\s*\*\*total\b/i],
];

// Three parsers rather than one, so that `only: 'counts'` — the cheap path repro.mjs takes — is not
// blocked by the shape of a table it is not going to look at. A malformed section still throws; it just
// throws for the caller that reads it.
export function parseCounts(file) {
  const s = readFileSync(file, 'utf8');
  const cBlock = paraAt(s, anchored(s, '<!--figures:assertions-->', file));
  const runs = [...cBlock.matchAll(/\*\*(\d+) assertions, (\d+) pass, (\d+) fail\*\*/g)];
  if (runs.length !== 2) {
    throw new Error(`figures.mjs: expected exactly 2 "N assertions, N pass, N fail" claims after the`
      + ` assertions anchor in ${path.basename(file)}; found ${runs.length}`);
  }
  const pins = num(one(/(\d+) byte-identity pins/g, cBlock, 'the byte-identity pin count', file)[1]);
  return { runs: runs.map((r) => [num(r[1]), num(r[2]), num(r[3])]), pins };
}

export function parseTable(file) {
  const s = readFileSync(file, 'utf8');
  const tI = anchored(s, '<!--figures:size-table-->', file);
  const rows = [];
  const seen = new Set();
  for (const raw of s.slice(tI).split('\n').slice(1)) {
    if (!/^\s*\|/.test(raw)) { if (rows.length || seen.size) break; else continue; }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(raw) && raw.includes('-')) continue;   // delimiter
    const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (/^where$/i.test(cells[0].replace(/[`*]/g, ''))) continue;          // header
    const hit = ROW_KEYS.find(([, re]) => re.test(raw));
    if (!hit) {
      throw new Error(`figures.mjs: the size table in ${path.basename(file)} has a row this check does`
        + ` not recognise — "${cells[0].slice(0, 70)}". An unrecognised row is an UNCHECKED row.`);
    }
    if (seen.has(hit[0])) throw new Error(`figures.mjs: two "${hit[0]}" rows in the size table`);
    seen.add(hit[0]);
    rows.push({ key: hit[0], bytes: num(cells[1].replace(/[`*]/g, '')), files: num(cells[2].replace(/[`*]/g, '')) });
  }
  for (const [k] of ROW_KEYS) {
    if (!seen.has(k)) throw new Error(`figures.mjs: the size table in ${path.basename(file)} has no "${k}" row`);
  }
  return rows;
}

// The two growth statements. Each names its own denominator in its own sentence, because the shipped
// version named neither and was read as the one it was not.
export function parseGrowth(file) {
  const s = readFileSync(file, 'utf8');
  const pcts = (anchor) => {
    const m = [...paraAt(s, anchored(s, anchor, file)).matchAll(/\*\*([\d.]+)%\*\*/g)];
    if (m.length !== 2) {
      throw new Error(`figures.mjs: the ${anchor} paragraph in ${path.basename(file)} carries ${m.length}`
        + ` bold percentages, expected 2 (total, then text-only)`);
    }
    return m.map((x) => x[1]);
  };
  return { growthRepo: pcts('<!--figures:growth-repo-->'), growthDerived: pcts('<!--figures:growth-derived-->') };
}

// A published percentage is compared at the precision it was published to. Not a tolerance: 2.68 and
// 2.684 are the same claim written to different precision, and 2.70 is a different claim.
const samePct = (published, value) => {
  const dp = (published.split('.')[1] || '').length;
  return value.toFixed(dp) === published;
};

// ── the checks ───────────────────────────────────────────────────────────────────────────────────
// `counts` is {pass, fail, skipped, withoutLocalPtau, bytePins, section4Open}. repro.mjs passes the
// numbers it just computed; the standalone gate reads them from the committed summary.
export function checkFigures({ counts, revert = '', rev = process.env.FIG_REV || 'HEAD', only = null }) {
  const rows = [];
  const add = (kind, label, value, ok) => rows.push({ kind, label, value: String(value), ok });
  const skip = (kind, label, why) => rows.push({ kind, label, value: why, ok: null });

  if (!GIT_ROOT) {
    throw new Error('figures.mjs: no git repository found. Looked for .git in:\n  '
      + GIT_CANDIDATES.join('\n  ') + '\nThe size figures are read from git, so this cannot be checked'
      + ' against a tree that is not a checkout.');
  }
  const copies = WRITEUP_COPIES();
  if (!copies.length) {
    throw new Error(`figures.mjs: the write-up was not found. Looked for ${WRITEUP_IN_REPO} under`
      + ` ${GIT_ROOT} and hackathon/FIX_REPRODUCIBLE_ARTIFACTS.md beside the zk tree.`);
  }

  // The counts path never touches git, so a checkout-shaped failure must not stop it. This is the
  // check gate Z carries, and gate Z runs in trees where the size figures are not the question.
  if (only === 'counts') {
    const rows2 = [];
    for (const file of copies) {
      const tag = path.relative(path.resolve(P.ZK, '..'), file).split(/[\\/]/).join('/');
      const pub = parseCounts(file);
      const [narrow, full] = pub.runs;
      const want = revert === 'row-count' ? counts.withoutLocalPtau - 1 : counts.withoutLocalPtau;
      rows2.push({ kind: 'counts', label: `${tag}: assertions without a local 2^13`,
        value: `${narrow[0]} published / ${want} in this run`,
        ok: narrow[0] === want && narrow[1] === want && narrow[2] === counts.fail });
      if (counts.section4Open) {
        const wantFull = revert === 'row-count' ? counts.pass - 1 : counts.pass;
        rows2.push({ kind: 'counts', label: `${tag}: assertions with a local 2^13`,
          value: `${full[0]} published / ${wantFull} in this run`,
          ok: full[0] === wantFull && full[1] === wantFull && full[2] === counts.fail });
      } else {
        rows2.push({ kind: 'counts', label: `${tag}: assertions with a local 2^13`,
          value: 'section 4 did not open this run — run `ptau.mjs make 13` to exercise it', ok: null });
      }
      rows2.push({ kind: 'counts', label: `${tag}: byte-identity pins`,
        value: `${pub.pins} published / ${counts.bytePins} in this run`, ok: pub.pins === counts.bytePins });
    }
    return { rows: rows2, fails: rows2.filter((r) => r.ok === false).length };
  }

  // 5ca5137 and not 620c041: the ceremony file was not committed until ac18088, so measuring the set at
  // the first commit throws "hez_final_12.ptau is not in 620c041" instead of producing a red row — and a
  // revert that breaks the measurement rather than an assertion proves nothing about the gate. 5ca5137 is
  // also the better choice on the merits: it is the tree as it was when the broken table was published.
  const setRev = revert === 'stale-row' ? '5ca5137b912d6f062284e5c8da29a953d3dd825c' : rev;
  const set = measureSet(setRev, { selfInclude: revert === 'self-include' });
  const baseTree = lsTree(BASELINE, ['.']);
  const baseBytes = baseTree.reduce((a, b) => a + b.size, 0);
  if (!baseBytes) throw new Error(`figures.mjs: commit ${BASELINE.slice(0, 7)} (the growth baseline) is empty or unreachable`);

  const measured = {
    circuits: set.groups.find((g) => g.key === 'circuits/adv'),
    scripts: set.groups.find((g) => g.key === 'scripts/adversary'),
    gates: set.groups.find((g) => g.key === 'gateZ'),
    ptau: set.groups.find((g) => g.key === 'ptau'),
  };
  const growthRepo = [100 * set.totalBytes / baseBytes, 100 * set.textBytes / baseBytes];
  // The revert that reproduces the published 0.706%: keep the numerator and swap the denominator, so
  // the "share of what was left out" line is silently answered with the repository instead.
  const derivedDen = revert === 'derived-denominator' ? baseBytes : DERIVED_BYTES;
  const growthDerived = [100 * set.totalBytes / derivedDen, 100 * set.textBytes / derivedDen];

  for (const file of copies) {
    const tag = path.relative(path.resolve(P.ZK, '..'), file).split(/[\\/]/).join('/');
    const pubCounts = parseCounts(file);
    const pubRows = parseTable(file);
    const pubGrowth = parseGrowth(file);

    const [narrow, full] = pubCounts.runs;
    const want = revert === 'row-count' ? counts.withoutLocalPtau - 1 : counts.withoutLocalPtau;
    add('counts', `${tag}: assertions without a local 2^13`, `${narrow[0]} published / ${want} in the artifact`,
      narrow[0] === want && narrow[1] === want && narrow[2] === counts.fail);
    const wantFull = revert === 'row-count' ? counts.pass - 1 : counts.pass;
    add('counts', `${tag}: assertions with a local 2^13`, `${full[0]} published / ${wantFull} in the artifact`,
      full[0] === wantFull && full[1] === wantFull && full[2] === counts.fail);
    add('counts', `${tag}: byte-identity pins`, `${pubCounts.pins} published / ${counts.bytePins} in the artifact`,
      pubCounts.pins === counts.bytePins);

    // the size table, row by row, against the tree.
    const R = (k) => pubRows.find((r) => r.key === k);
    const cmp = (k, m) => {
      add('size', `${tag}: ${k}`, `${R(k).bytes.toLocaleString('en-US')} B / ${R(k).files} files published;`
        + ` ${m.bytes.toLocaleString('en-US')} B / ${m.count} in ${setRev.slice(0, 7)}`,
        R(k).bytes === m.bytes && R(k).files === m.count);
    };
    cmp('circuits/adv', measured.circuits);
    cmp('scripts/adversary', measured.scripts);
    cmp('gateZ', measured.gates);
    cmp('ptau', measured.ptau);
    const tot = R('total');
    add('size', `${tag}: the total is the sum of the rows above it`,
      `${tot.bytes.toLocaleString('en-US')} B / ${tot.files} files published; rows sum to`
      + ` ${set.totalBytes.toLocaleString('en-US')} B / ${set.totalFiles}`,
      tot.bytes === set.totalBytes && tot.files === set.totalFiles);
    add('size', `${tag}: the write-up is NOT one of the measured files`,
      `${set.totalFiles} measured, write-up is ${set.writeupBytes.toLocaleString('en-US')} B`,
      !set.all.some((f) => f.path === WRITEUP_IN_REPO));

    add('growth', `${tag}: growth against the repository at ${BASELINE.slice(0, 7)}`,
      `${pubGrowth.growthRepo.join('% / ')}% published; ${growthRepo.map((g) => g.toFixed(3)).join('% / ')}% measured`,
      samePct(pubGrowth.growthRepo[0], growthRepo[0]) && samePct(pubGrowth.growthRepo[1], growthRepo[1]));
    add('growth', `${tag}: share of the ${DERIVED_BYTES.toLocaleString('en-US')} B left out`,
      `${pubGrowth.growthDerived.join('% / ')}% published; ${growthDerived.map((g) => g.toFixed(3)).join('% / ')}% measured`,
      samePct(pubGrowth.growthDerived[0], growthDerived[0]) && samePct(pubGrowth.growthDerived[1], growthDerived[1]));
  }

  // ── the set is clean, and it reached the dev tree ──────────────────────────────────────────────
  // A figure read from HEAD describes HEAD. If a measured file is dirty the published number is not
  // the number a reader would receive, so this is red rather than amber.
  // `git diff --name-only <rev>` and not `git status`: status compares against HEAD, and the rev being
  // measured is not always HEAD — FIG_REV exists so a figure can be checked against the tree it is
  // about to be committed as. Comparing to the wrong reference would report every staged file dirty,
  // which is a check failing for a reason that has nothing to do with the property.
  const dirty = git(['diff', '--name-only', setRev, '--', ...set.all.map((f) => f.path), WRITEUP_IN_REPO]).trim();
  for (const d of dirty ? dirty.split('\n').slice(0, 5) : []) console.log(`      differs from ${setRev.slice(0, 7)}: ${d}`);
  add('tree', `every measured file matches ${setRev.slice(0, 7)} in the mirror working tree`,
    dirty ? dirty.split('\n').length + ' differ' : 'clean', !dirty);

  // And the failure this project has actually shipped twice: a file written into the dev tree, its
  // importer committed, and the file itself never copied across. Compared byte-for-byte against the
  // blob, not by grepping for the import.
  const devRoot = path.resolve(P.ZK, '..');
  const inClone = path.resolve(GIT_ROOT) === path.resolve(P.VT);
  if (inClone) {
    skip('mirror', 'every measured file also exists in the dev tree', 'running inside a clone — the mirror IS the tree');
  } else {
    const devPath = (p) => {
      if (p.startsWith('zk/')) return path.join(devRoot, ...p.split('/'));
      if (p.startsWith('gates/')) return path.join(P.VT, ...p.split('/'));
      return null;
    };
    const drop = revert === 'mirror-drop' ? set.all.find((f) => f.path.startsWith('zk/scripts/adversary/'))?.path : null;
    const missing = [];
    const differs = [];
    for (const f of set.all) {
      const d = devPath(f.path);
      if (!d) continue;
      if (f.path === drop || !existsSync(d)) { missing.push(f.path); continue; }
      if (statSync(d).size !== f.size) differs.push(`${f.path} (${statSync(d).size} vs blob ${f.size})`);
    }
    for (const m of missing.slice(0, 5)) console.log(`      dev tree is missing ${m}`);
    for (const d of differs.slice(0, 5)) console.log(`      dev tree differs: ${d}`);
    add('mirror', 'every measured file also exists in the dev tree, byte-identical to its blob',
      `${set.all.length - missing.length - differs.length} / ${set.all.length}`,
      missing.length === 0 && differs.length === 0);
  }

  return { rows, fails: rows.filter((r) => r.ok === false).length };
}

export default { checkFigures, measureSet, parseCounts, parseTable, parseGrowth, REVERT_MODES,
  BASELINE, DERIVED_BYTES, GIT_ROOT };
