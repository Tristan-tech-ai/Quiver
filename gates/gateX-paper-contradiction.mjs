// Gate X — the paper anti-contradiction gate (X for cross-document).
//
// WHY THIS EXISTS. `tools/docs-consistency.mjs` checks 128 documents and was green while the
// whitepaper carried four stale suite figures at once. Every one of the four sat inside a document
// that tool already read — the whitepaper parts are byte-identical between `Quiver/assets/` and
// `hackathon/veritape/assets/`, and the Quiver copies are walked. So the miss was never about which
// files were opened. It was about what the rule could express:
//
//   1. Its only suite fact is a STATIC COUNT of `test(`/`it(` declarations — the total, 386. There
//      was no pass count and no skipped count anywhere in the tool, so a sentence claiming "None of
//      the 333 fails" had nothing to be compared against. A checker cannot catch a wrong answer to a
//      question it never asks.
//   2. Its pattern is `(\d{3})\s+(?:model-free|automated)\s+tests?`. "386 tests that run on every
//      build" has no qualifier and never matched; "386-test suite" is hyphenated and singular and
//      never matched. Two of the four defects were syntactically invisible.
//   3. The other two DID match — and passed, because the number they quote (386) is right. The lie
//      was the word "further": "386 automated tests ... a further five" asserts 391. The rule read
//      the integer and never read the arithmetic around it.
//   4. Every rule compares one document to the system. Nothing compares document to document, so
//      part 6 saying "386 and 381" and part 1 saying "386 ... a further five" both passed
//      individually. That is the shape a single-source check cannot see by construction.
//
// So this gate asks the questions that one could not:
//
//   A. TRUTH      — the figures come from actually RUNNING the suite and reading the runner's own
//                   summary (`tests` / `pass` / `fail` / `skipped`), not from counting declarations.
//                   The total, the pass count AND the skipped count are all facts here.
//   B. CURRENCY   — every suite figure in every published document must match the runner.
//   C. AGREEMENT  — two published documents may not state the same quantity differently, even when
//                   neither is compared to the system.
//   D. ARITHMETIC — a stated total must be the sum of its stated parts, and "a further N" may not
//                   assert a total the runner contradicts.
//   E. SHAPE      — the served part count is a hard published contract (`/paper/1..7`). The splitter
//                   packs greedily against a 55 kB budget, so prose growth CAN move a boundary. That
//                   is asserted here rather than assumed.
//
// False positives are the way a gate gets ignored on the day it is right, so three classes of number
// are deliberately excluded and each is a real string from this repository: `79,386 accounts`,
// `333,155 gas`, and the content hash `8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538…`
// all contain a suite figure as a substring. The number matcher refuses any digit run that is glued
// to another digit, comma or period. Regression-tested below.
//
//   node --test gates/gateX-paper-contradiction.mjs      (npm run gate:x)
//   node gates/gateX-revert.mjs                          (npm run gate:x-revert)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '..');
const ROOT = join(SERVICE, '..', '..');            // "research startup"

// ── A. the truth, from the runner itself ─────────────────────────────────────────────────────────
// Not a declaration count. `docs-consistency` counts `test(` occurrences statically, which yields the
// total and can never yield the pass or skipped counts — and the skipped count is precisely what the
// four defects got wrong. So run the suite and read its summary.
let SUITE_CACHE = null;
export function suiteTruth() {
  if (SUITE_CACHE) return SUITE_CACHE;
  // Two traps, both of which produced a confidently wrong answer before being fixed:
  //   - the glob in `npm test` is expanded by the shell, so it must be expanded here instead of
  //     handed to node as a literal path;
  //   - NODE_TEST_CONTEXT is inherited, and a `node --test` child that sees it decides it is nested
  //     and SKIPS running any files — yielding an empty summary that this function would otherwise
  //     have had to interpret. Scrub it.
  const files = readdirSync(join(SERVICE, 'test')).filter((f) => f.endsWith('.test.mjs')).sort()
    .map((f) => join('test', f));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_TEST_/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: SERVICE, encoding: 'utf8', timeout: 600_000, shell: false, env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (label) => {
    const m = out.match(new RegExp(`^(?:ℹ|#)\\s*${label}\\s+(\\d+)$`, 'm'));
    return m ? Number(m[1]) : -1;
  };
  const t = { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped') };
  if (Object.values(t).some((v) => v < 0)) {
    console.error(out.slice(-2000));
    throw new Error('could not read the test runner summary — every figure below would be invented');
  }
  // The runner's own numbers must be internally coherent before they are used as ground truth.
  // If they are not, the fault is here, not in the paper, and saying so is the honest failure.
  if (t.pass + t.fail + t.skipped !== t.tests) {
    throw new Error(`runner summary does not add up: pass ${t.pass} + fail ${t.fail} + skipped ${t.skipped} != tests ${t.tests}`);
  }
  SUITE_CACHE = t;
  return t;
}

// ── the documents ────────────────────────────────────────────────────────────────────────────────
const SKIP_DIR = new Set(['node_modules', '.git', 'field-test', 'reservoir-data', 'build']);
const walk = (d, out = []) => {
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.md') || e.endsWith('.html')) out.push(p);
  }
  return out;
};
export function documents() {
  const out = [];
  const q = join(ROOT, 'Quiver');
  const h = join(ROOT, 'hackathon');
  if (existsSync(q)) out.push(...walk(q));
  // `docs-consistency` reads only the TOP level of hackathon/, which is why the working tree's own
  // README — stale by 234 tests — was invisible to it. The service directory is walked here.
  if (existsSync(h)) {
    for (const f of readdirSync(h)) {
      if (f.endsWith('.md')) out.push(join(h, f));
    }
  }
  out.push(...walk(SERVICE));
  return [...new Set(out)];
}

// A dated log may say what was true when it was written. A PUBLISHED artifact may not: a reader
// arrives at it today with no way to know it is a snapshot. Same distinction, and same path-based
// drawing of it, as tools/docs-consistency.mjs — widened only by the two names this gate adds.
// DOCS[-_]COVERAGE joins on 29 July on exactly the precedent PAPER[-_]CONSISTENCY set, and for the
// same reason: it is the dated report of the three blind spots closed in tools/docs-consistency.mjs,
// and it cannot say what was wrong without printing "152 model-free tests" beside 386 twelve times.
// This gate accused it, which is the gate working; classifying it is the only alternative to deleting
// the record. Added additively, one token, and disclosed in the report it exempts.
const LOG = /(research[\\/](BUYER_|zk[\\/])|MISSION_CONTROL|CHECKPOINT|DEEP_UNDERCLAIM|D_PROGRESS|SNARK_PLAN|OUTREACH|DIRECTORY_PRS|COMMUNITY_KIT|CRASH_STUDY|RESEARCH_ANCHOR|ROADMAP_V2|X_POST|WRONG_ENDPOINT_AUDIT|QUIVER_ROADMAP\.md|changelog\.md|PAPER[-_]CONSISTENCY\.md|DOCS[-_]COVERAGE|verification[-_]log|JUDGE_SWEEP|judge-sweep)/i;

// Two further ways a document earns the right to quote an old number, both discovered by running
// this gate and reading what it accused rather than by reasoning about it in advance.
//
//   DATED — a block that states its own as-of date. QUIVER_SUBMISSION.md carries a correction table
//   introduced by "the right is what was true when the correction was made on 26 July 2026", and
//   rewriting its right column to today's figures would destroy the record of what was corrected.
//   A document that dates its claim has kept the contract this gate exists to enforce.
const DATED = /what was true when|columns are dated|both columns|as of \d|at the time|date of sweep|dated:/i;
//
//   NARRATIVE — §§11.5–11.7 of the paper are a chronological account of successive review rounds
//   ("Defects a live adversarial test found after the freeze", "A second review", "A third round"),
//   and their sentences ("The suite is 294 tests, 289 passing and five skipped") state what was true
//   at a past round rather than today. That is a build log which happens to live inside a published
//   document. Scoped by the NEAREST HEADING AT ANY LEVEL — the first version read only `##`, decided
//   these paragraphs belonged to "11. Roadmap", and went on accusing correct prose. Keying on the
//   subsection keeps the exemption where the narrative actually is instead of over a whole chapter.
const NARRATIVE_HEADING = /\bthe build\b|story, process|\breview\b|\bround\b|defects a live|after the freeze/i;
const sectionOf = (s, i) => {
  const before = s.slice(0, i);
  const md = [...before.matchAll(/^#{2,4}\s+(.+)$/gm)].pop();
  const html = [...before.matchAll(/<h[234]\b[^>]*>([\s\S]*?)<\/h[234]>/gi)].pop();
  const pick = (md?.index ?? -1) > (html?.index ?? -1) ? md?.[1] : html?.[1];
  return (pick || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
};

// ── the number matcher ───────────────────────────────────────────────────────────────────────────
// Glued digits are the whole game. `79,386` / `333,155` / `…33560386586…` each contain a live suite
// figure, and a matcher that reads them as one cries wolf forever after.
const N = String.raw`(?<![\d,.])(\d{1,4})(?![\d,.])`;
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const W = `(?:${Object.keys(WORDS).join('|')})`;
const val = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

// Claim shapes, each tagged with the quantity it asserts. Written out explicitly rather than inferred,
// so that a reader can audit which sentences this gate believes it understands.
const CLAIMS = [
  { kind: 'total', re: new RegExp(String.raw`${N}\*{0,2}\s*\*{0,2}\s*(?:model-free|automated|invariant)\s+tests?\b`, 'gi') },
  { kind: 'total', re: new RegExp(String.raw`${N}-test\s+suite\b`, 'gi') },
  { kind: 'total', re: new RegExp(String.raw`(?:holds|suite of|stood at|taken it to)\s+${N}\s+tests?\b`, 'gi') },
  { kind: 'total', re: new RegExp(String.raw`\b${N}\s+tests?\s+(?:that\s+)?run\b`, 'gi') },
  { kind: 'total', re: new RegExp(String.raw`\bit currently holds\s+${N}\b`, 'gi') },
  { kind: 'pass',  re: new RegExp(String.raw`${N}\s+passing\b`, 'gi') },
  { kind: 'pass',  re: new RegExp(String.raw`\bnone of the\s+${N}\s+fails?\b`, 'gi') },
  { kind: 'pass',  re: new RegExp(String.raw`\bthe\s+${N}\s+that run\b`, 'gi') },
  { kind: 'skip',  re: new RegExp(String.raw`(?:${W}|${N})\s+skipped\b`, 'gi') },
  { kind: 'skip',  re: new RegExp(String.raw`\bskipped\s+for\s+want\b`, 'gi'), fixed: null },
  { kind: 'skip',  re: new RegExp(String.raw`(?:a\s+further\s+|another\s+|alongside\s+a\s+further\s+|with\s+a\s+further\s+)?(?:${W}|${N})\s+(?:are\s+)?live-archive\b`, 'gi') },
];

// History and quotation. Both are lifted from the rules docs-consistency already proved it needs:
// a correction table must be able to print the wrong sentence beside the right one, and a narrative
// of past review rounds is a log even when it lives inside a published document.
const HISTORY = /close of that round|suite stood at|stood at|later rounds have taken|test suite \d+\s*(?:→|->)|\d{2,4}\s*(?:→|->)\s*$/i;
const isQuoted = (s, i) => /["“]\**\s*$/.test(s.slice(Math.max(0, i - 8), i));

// The source of truth is HTML, so these prose rules have to read HTML — and raw markup lies to them
// in two ways that the scripted revert caught immediately. §3.6 narrates its own former error as
// `calling that &ldquo;all pass&rdquo;`: the quotation marks are ENTITIES, so the quoted-text
// exemption did not see them, and the semicolon that ENDS each entity looks like a clause break, so
// the sentence splitter cut "all pass" away from the "default environment" qualifier that makes it
// honest. Both together turned a correct sentence into a finding.
//
// Tags and entities are therefore blanked to runs of spaces OF EXACTLY THE SAME LENGTH, so that every
// byte offset — and so every reported line number — is still the offset in the real file, while the
// prose reads the way a person reads it. Quote entities become a real quote character rather than a
// space, because the exemption they carry is the whole point.
const QUOTE_ENT = /^(?:ldquo|rdquo|quot|#8220|#8221|#34)$/i;
const normaliseHtml = (s) => s
  .replace(/<[^>]*>/g, (m) => ' '.repeat(m.length))
  .replace(/&(#?\w+);/g, (m, name) => (QUOTE_ENT.test(name) ? '"' : ' ') + ' '.repeat(m.length - 1));
const readDoc = (f) => {
  const raw = readFileSync(f, 'utf8');
  return { raw, text: f.endsWith('.html') ? normaliseHtml(raw) : raw };
};
const lineOf = (s, i) => s.slice(0, i).split('\n').length;
const sentenceAround = (s, i) => {
  const a = Math.max(s.lastIndexOf('.', i), s.lastIndexOf('\n', i), s.lastIndexOf(';', i));
  let b = s.length;
  for (const ch of ['.', '\n', ';']) { const j = s.indexOf(ch, i); if (j >= 0 && j < b) b = j; }
  return s.slice(a + 1, b + 1).trim();
};

export function collect() {
  const claims = [];
  for (const f of documents()) {
    const { raw, text: s } = readDoc(f);
    const isLog = LOG.test(f);
    for (const { kind, re } of CLAIMS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        // NOT `raw` — that name holds the document text this loop needs for section lookup, and
        // shadowing it here handed sectionOf() the matched digits instead of the file, which silently
        // disabled the narrative exemption for every markdown document at once.
        const numRaw = m[1] ?? m[0].match(new RegExp(`${W}|\\d+`, 'i'))?.[0];
        const n = numRaw ? val(numRaw) : null;
        if (n == null || Number.isNaN(n)) continue;
        const before = s.slice(Math.max(0, m.index - 220), m.index);
        if (isQuoted(s, m.index)) continue;
        const sentence = sentenceAround(s, m.index);
        // A bare "N passing" is not necessarily about the test suite. `verification-log.md` reports
        // "Preflight now 14 checks, 13 passing" — a different population entirely, and reading it as
        // a suite figure is exactly the crying-wolf that gets a gate switched off.
        //
        // The first version of this guard required the word "test" or "suite" IN THE SENTENCE, and
        // the scripted revert immediately caught what that cost: "None of the 333 fails" — the one
        // defect of the four that quotes a wrong integer — is its own sentence and contains neither
        // word, so the guard written to prevent false positives silently created a false negative on
        // the most important claim in the set. Discriminate on the population NOUN attached to the
        // number instead, and read the topic from a window wide enough to contain the subject.
        if (kind === 'pass') {
          const attached = s.slice(Math.max(0, m.index - 80), m.index);
          if (/\b(checks?|gates?|services?|endpoints?|tools?|accounts?|documents?|calls?|references?|figures?)\b[^.;]{0,24}$/i.test(attached)) continue;
          if (!/\btests?\b|\bsuite\b/i.test(s.slice(Math.max(0, m.index - 320), m.index + 160))) continue;
        }
        const history = isLog
          || HISTORY.test(before) || HISTORY.test(m[0])
          || DATED.test(s.slice(Math.max(0, m.index - 700), m.index))
          || NARRATIVE_HEADING.test(sectionOf(raw, m.index));
        claims.push({
          file: f, rel: relative(ROOT, f), line: lineOf(s, m.index), kind, n,
          text: m[0].replace(/\s+/g, ' ').trim(), sentence, history,
        });
      }
    }
  }
  return claims;
}

// ── E. the served shape ──────────────────────────────────────────────────────────────────────────
// Mirrors tools/paper-to-text.mjs exactly. The parts are NOT cut purely at section boundaries: they
// are packed greedily against a byte budget AT section boundaries, so a sentence that grows can push
// a section into a new part and change what /paper/N serves. Part 4 has run as low as 173 bytes of
// headroom, which is roughly two sentences.
const BUDGET = 55_000;
export function packing() {
  const md = readFileSync(join(SERVICE, 'assets', 'whitepaper.md'), 'utf8');
  const body = md.slice(md.indexOf('\n---\n\n') + '\n---\n\n'.length);
  const sections = [];
  let cur = [];
  for (const line of body.split('\n')) {
    if (/^## /.test(line) && cur.length) { sections.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) sections.push(cur.join('\n'));
  const parts = [];
  for (const sec of sections) {
    const last = parts[parts.length - 1];
    if (last && Buffer.byteLength(last + sec, 'utf8') <= BUDGET) parts[parts.length - 1] = last + '\n' + sec;
    else parts.push(sec);
  }
  const sizes = parts.map((p) => Buffer.byteLength(p, 'utf8'));
  const onDisk = (() => { let i = 0; while (existsSync(join(SERVICE, 'assets', `whitepaper.part${i + 1}.md`))) i++; return i; })();
  // The COUNT is not the contract; the MAPPING is. Adding 465 bytes to §6 was measured to leave the
  // count at seven while moving §8 Limitations out of part 4 and into part 5 — so every citation of
  // "/paper/4" for the limitations silently became wrong while every count-based check stayed green.
  // parts.json records which sections landed in which part, so compare against that too.
  const titleOf = (p) => {
    const hs = [...p.matchAll(/^## (.+)$/gm)].map((x) => x[1].replace(/\s+/g, ' ').trim());
    return hs.length ? hs.join('  |  ') : 'Front matter';
  };
  const titles = parts.map(titleOf);
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(join(SERVICE, 'assets', 'whitepaper.parts.json'), 'utf8')); } catch { /* reported as a finding */ }
  const drifted = recorded?.titles
    ? titles.map((t, i) => (recorded.titles[i] === t ? null : `part ${i + 1}: serves "${t}" but whitepaper.parts.json records "${recorded.titles[i] ?? '(nothing)'}"`)).filter(Boolean)
    : ['whitepaper.parts.json is missing or unreadable'];
  return { computed: parts.length, onDisk, sizes, titles, drifted, recorded: recorded?.count ?? null, headroom: sizes.map((b) => BUDGET - b) };
}

// ── the checks ───────────────────────────────────────────────────────────────────────────────────
const KIND_LABEL = { total: 'suite total', pass: 'passing count', skip: 'skipped count' };

export function findings() {
  const truth = suiteTruth();
  const claims = collect();
  const live = claims.filter((c) => !c.history);
  const out = [];
  const want = { total: truth.tests, pass: truth.pass, skip: truth.skipped };

  // B. CURRENCY — every published suite figure against what the runner reported.
  for (const c of live) {
    if (c.n !== want[c.kind]) {
      out.push({ rule: 'CURRENCY', file: c.rel, line: c.line,
        msg: `states ${KIND_LABEL[c.kind]} ${c.n} ("${c.text}"); the runner reports ${want[c.kind]}` });
    }
  }

  // C. AGREEMENT — two published documents stating the same quantity differently. This fires even
  //    when neither value matches the system, and even when the disagreeing pair are both wrong,
  //    which is the case a document-to-system check cannot reach.
  for (const kind of ['total', 'pass', 'skip']) {
    const byVal = new Map();
    for (const c of live.filter((x) => x.kind === kind)) {
      if (!byVal.has(c.n)) byVal.set(c.n, []);
      byVal.get(c.n).push(c);
    }
    if (byVal.size > 1) {
      const summary = [...byVal.entries()].sort((a, b) => b[1].length - a[1].length)
        .map(([n, cs]) => `${n} (${cs.length}× e.g. ${cs[0].rel}:${cs[0].line})`).join('  vs  ');
      const first = [...byVal.values()][0][0];
      out.push({ rule: 'AGREEMENT', file: first.rel, line: first.line,
        msg: `published documents disagree on the ${KIND_LABEL[kind]}: ${summary}` });
    }
  }

  // D. ARITHMETIC — "a further N" asserts that N sits OUTSIDE the total. When the runner says those
  //    N are inside it, the sentence claims a suite that does not exist. This is the defect that
  //    survived a correct-looking 386 in four documents.
  const FURTHER = /\b(?:a\s+further|another|alongside\s+a\s+further|with\s+a\s+further|plus)\s+((?:\d{1,4})|one|two|three|four|five|six|seven|eight|nine|ten)\s+((?:live-archive|integration|skipped|model-free|automated)[^.;]{0,60}tests?)/gi;
  for (const f of documents()) {
    if (LOG.test(f)) continue;
    const { raw, text: s } = readDoc(f);
    let m;
    FURTHER.lastIndex = 0;
    while ((m = FURTHER.exec(s))) {
      const add = val(m[1]);
      const near = s.slice(Math.max(0, m.index - 400), m.index);
      if (isQuoted(s, m.index) || HISTORY.test(near) || DATED.test(s.slice(Math.max(0, m.index - 700), m.index))
          || NARRATIVE_HEADING.test(sectionOf(raw, m.index))) continue;
      const tm = [...near.matchAll(new RegExp(String.raw`${N}\s*\*{0,2}\s*(?:model-free|automated|invariant)?\s*tests?\b`, 'gi'))].pop();
      if (!tm) continue;
      const total = Number(tm[1]);
      if (total !== truth.tests) continue;                  // the CURRENCY rule already owns that
      if (add === truth.skipped) {
        out.push({ rule: 'ARITHMETIC', file: relative(ROOT, f), line: lineOf(s, m.index),
          msg: `"a further ${m[1]} ${m[2].split(/\s+/).slice(0, 3).join(' ')}…" adds to the stated ${total}, asserting ${total + add} tests; ` +
               `the runner reports ${truth.tests} total with those ${truth.skipped} INSIDE it` });
      }
    }
  }

  // D2. ARITHMETIC — a stated total that is not the sum of its stated parts, within one sentence.
  const seen = new Set();
  for (const c of live.filter((x) => x.kind === 'total')) {
    const key = `${c.rel}:${c.line}:${c.sentence.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sib = live.filter((x) => x.rel === c.rel && x.sentence === c.sentence);
    const p = sib.find((x) => x.kind === 'pass');
    const k = sib.find((x) => x.kind === 'skip');
    if (p && k && p.n + k.n !== c.n) {
      out.push({ rule: 'ARITHMETIC', file: c.rel, line: c.line,
        msg: `sentence states ${c.n} total, ${p.n} passing and ${k.n} skipped; ${p.n} + ${k.n} = ${p.n + k.n}, not ${c.n}` });
    }
  }

  // D3. OVER-CLAIM — "all pass" while the runner skips some, unqualified. The corrected caption
  //     ("The 381 that run in the default environment all pass") carries its qualifier and is fine.
  if (truth.skipped > 0) {
    for (const f of documents()) {
      if (LOG.test(f)) continue;
      const { raw, text: s } = readDoc(f);
      for (const m of s.matchAll(/\ball\s+(?:currently\s+)?pass(?:es)?\b/gi)) {
        if (isQuoted(s, m.index)) continue;
        const sent = sentenceAround(s, m.index);
        // Topic from a WIDE window, qualifier from the sentence. Table 2's caption is the reason:
        // the defect reads "…from the 386-test suite. All currently pass." — so the clause that
        // over-claims does not itself mention the suite, and testing the topic on the sentence made
        // this rule blind to the very caption it was written for. The qualifier stays sentence-local,
        // because "The 381 that run in the default environment all pass" is honest and must not fire.
        if (!/test|suite|invariant/i.test(s.slice(Math.max(0, m.index - 250), m.index + 120))) continue;
        if (/that run|default environment|of the \d+|excluding|when .* configured|are run/i.test(sent)) continue;
        if (DATED.test(s.slice(Math.max(0, m.index - 700), m.index)) || NARRATIVE_HEADING.test(sectionOf(raw, m.index))) continue;
        out.push({ rule: 'OVER-CLAIM', file: relative(ROOT, f), line: lineOf(s, m.index),
          msg: `claims "${m[0]}" of the suite, but ${truth.skipped} of ${truth.tests} do not run in the default environment` });
      }
    }
  }

  // E. SHAPE — the served part count is a published contract.
  const pk = packing();
  if (pk.computed !== pk.onDisk) {
    out.push({ rule: 'SHAPE', file: 'assets/whitepaper.md', line: 1,
      msg: `the text packs into ${pk.computed} parts but ${pk.onDisk} whitepaper.part*.md exist — regenerate with tools/paper-to-text.mjs` });
  }
  for (const d of pk.drifted) {
    out.push({ rule: 'SHAPE', file: 'assets/whitepaper.parts.json', line: 1,
      msg: `the section-to-part mapping moved — ${d}` });
  }
  return { truth, claims, live, findings: out, packing: pk };
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────
const R = findings();

test('★ the runner summary is internally coherent and is the only source of suite truth', () => {
  const t = R.truth;
  console.log(`    runner: tests ${t.tests} = pass ${t.pass} + fail ${t.fail} + skipped ${t.skipped}`);
  assert.equal(t.pass + t.fail + t.skipped, t.tests);
  assert.equal(t.fail, 0, 'the suite is failing; every documentation figure below is moot');
});

test('★ the number matcher refuses digits glued to other digits (79,386 / 333,155 gas / a sha256)', () => {
  // Each of these is a real string from this repository that contains a live suite figure.
  const traps = [
    'replaying it over every open perp position on the venue (79,386 accounts, $14.6 billion notional)',
    'X Layer (eip155:196), block 66,412,794, 333,155 gas, event ProofRejected',
    'proof.contentHash 8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960',
  ];
  for (const t of traps) {
    for (const { re } of CLAIMS) {
      re.lastIndex = 0;
      assert.equal(re.test(t), false, `matched a non-claim: ${t.slice(0, 60)}…`);
    }
  }
  // …and still reads the real thing.
  const realRe = CLAIMS[0].re; realRe.lastIndex = 0;
  assert.ok(realRe.test('an automated suite of 386 model-free tests'));
});

test('★ every published suite figure matches what npm test actually reports', () => {
  const bad = R.findings.filter((f) => f.rule === 'CURRENCY');
  for (const f of bad) console.error(`    ${f.file}:${f.line} — ${f.msg}`);
  assert.equal(bad.length, 0, `${bad.length} stale suite figure(s)`);
});

test('★ no two published documents state the same quantity differently', () => {
  const bad = R.findings.filter((f) => f.rule === 'AGREEMENT');
  for (const f of bad) console.error(`    ${f.file}:${f.line} — ${f.msg}`);
  assert.equal(bad.length, 0, `${bad.length} cross-document disagreement(s)`);
});

test('★ no arithmetic claim that does not add up', () => {
  const bad = R.findings.filter((f) => f.rule === 'ARITHMETIC');
  for (const f of bad) console.error(`    ${f.file}:${f.line} — ${f.msg}`);
  assert.equal(bad.length, 0, `${bad.length} arithmetic contradiction(s)`);
});

test('★ nothing claims "all pass" while tests are skipped', () => {
  const bad = R.findings.filter((f) => f.rule === 'OVER-CLAIM');
  for (const f of bad) console.error(`    ${f.file}:${f.line} — ${f.msg}`);
  assert.equal(bad.length, 0, `${bad.length} over-claim(s)`);
});

test('★ the served part count still matches what the text packs into', () => {
  const pk = R.packing;
  const tight = Math.min(...pk.headroom);
  const at = pk.headroom.indexOf(tight) + 1;
  console.log(`    parts ${pk.computed} (on disk ${pk.onDisk}); tightest part ${at} with ${tight} B of ${BUDGET} B headroom`);
  // Printed EVERY run, so that a boundary move shows up in the log even where no rule can assert it.
  // Measured: adding 465 bytes to §6 leaves the count at seven and moves §8 Limitations from part 4
  // to part 5. parts.json is regenerated alongside the parts, so it cannot witness its own drift —
  // this log line and the reviewer reading the diff are what catch that case.
  pk.titles.forEach((t, i) => console.log(`      /paper/${i + 1}  ${String(pk.sizes[i]).padStart(5)} B  ${t}`));
  if (tight < 600) console.log(`    NOTE part ${at} is within ${tight} B of splitting — roughly two sentences. Prose growth in it changes what /paper/N serves even if the COUNT does not move.`);
  const bad = R.findings.filter((f) => f.rule === 'SHAPE');
  for (const f of bad) console.error(`    ${f.file}:${f.line} — ${f.msg}`);
  assert.equal(bad.length, 0, 'the machine edition on disk is stale');
  assert.ok(tight >= 0, 'a part exceeds the fetch budget');
});

test('★ the gate examined a non-trivial corpus (a checker that reads nothing passes every time)', () => {
  const docs = documents();
  console.log(`    ${docs.length} documents, ${R.claims.length} suite-figure claims (${R.live.length} held to currency)`);
  assert.ok(docs.length >= 100, `only ${docs.length} documents found — the paths this gate walks have moved`);
  assert.ok(R.live.length >= 5, `only ${R.live.length} live claims found — the matcher has stopped matching`);
});
