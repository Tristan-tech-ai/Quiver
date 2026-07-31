// Do the documents agree with each other, and with the running system?
//
// This exists because they repeatedly did not. The pattern is always the same: a fact changes, the
// obvious place gets updated, and three less obvious places keep the old value — a README that still
// says six parts when there are seven, a roadmap that calls a deployed contract "planned", a test
// count quoted in five documents and corrected in three. Each miss is individually trivial and
// collectively fatal, because a reader who finds one contradiction is right to stop believing the
// rest, and this project's entire argument is that its claims are checkable.
//
// So the facts are read from the SYSTEM — the engine, the assets on disk, the deployment record —
// and every document is checked against them. Nothing here is a hardcoded expectation; if the
// service changes, this script's idea of the truth changes with it.
//
//   node tools/docs-consistency.mjs            # check                    (npm run docs:check)
//   node tools/docs-consistency.mjs --verbose  # also print every fact
//   node tools/docs-consistency.mjs --list     # print the corpus and stop
//   node gates/docs-coverage-revert.mjs        # prove it can fail        (npm run docs:revert)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '..');
const ROOT = join(SERVICE, '..', '..');          // "research startup"
const VERBOSE = process.argv.includes('--verbose');

// ── the facts, read from the system ──────────────────────────────────────────────────────────────
const { _internal } = await import(new URL('../src/engine/proof.js', import.meta.url));
const { SERVICES } = await import(new URL('../src/services.js', import.meta.url));

const partFiles = [];
for (let i = 1; ; i++) {
  const p = join(SERVICE, 'assets', `whitepaper.part${i}.md`);
  if (!existsSync(p)) break;
  partFiles.push(p);
}

const deployment = (() => {
  const p = join(ROOT, 'zk', 'build', 'xlayer-deployment.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
})();

// The paper's SHAPE — how many numbered tables it carries, and how many works it cites. Both are
// advertised on the front page ("methods, ten tables and 44 references, every one of them cited")
// and neither was read from anywhere until 29 July, when the widened walk opened `landing.html` for
// the first time and the table count turned out to have been wrong since the 28th. Counted here, so
// the next section that arrives with a table cannot leave the claim behind.
const paperShape = (() => {
  const p = join(SERVICE, 'assets', 'whitepaper.html');
  if (!existsSync(p)) return { tables: 0, refs: 0 };
  const h = readFileSync(p, 'utf8');
  const i = h.indexOf('id="refs"');
  return {
    tables: (h.match(/<caption>\s*Table\s+\d+/gi) || []).length,
    refs: i < 0 ? 0 : (h.slice(i).match(/<li\b/gi) || []).length,
  };
})();

// The suite size, counted from the declarations rather than written down. The escape clause in the
// string pattern is load-bearing: one test title contains an escaped apostrophe, and a naive
// `(.*?)` stopped at it — giving 385 against the runner's 386 and an off-by-one that would have been
// papered over with a tolerance, which is how a checker stops being able to fail precisely.
const SUITE_SIZE = (() => {
  let n = 0;
  for (const f of readdirSync(join(SERVICE, 'test'))) {
    if (!f.endsWith('.mjs')) continue;
    const s = readFileSync(join(SERVICE, 'test', f), 'utf8');
    n += (s.match(/^[ \t]*(?:await[ \t]+)?(?:test|it)[ \t]*\(/gm) || []).length;
  }
  return n;
})();

// The measured gas figures, read from the artifacts that measured them. Loaded lazily and cached,
// because most documents cite none and the directory holds 169 files.
//
// WHY THIS IS HERE AT ALL. On 30 July every gas figure in the four `VERIFY_*.md` reports disagreed
// with the JSON that produced it — seven for seven on the first pass, twenty-one once the table
// columns were counted too — and this tool passed over all of them across 225 documents, because
// nothing here had ever looked at a gas number. Same shape as the README that claimed every gate
// passed: a checker is blind to whatever it was never told to compare.
//
// The mechanism was worse than staleness. `gateB5-5` wrote at 00:34:48 and `gateB5-2` at 00:34:52,
// four seconds apart, and the published marginal took its two terms from the two different runs. So
// the figures do not merely go stale — they are SAMPLES of a noisy quantity, and re-running a gate
// changes them. `gateB6-portfolio-routes.json` was re-run mid-session by a sibling and its eleven-leg
// figure moved from 2,941,749 to 2,939,559 while this rule was being written.
//
// That is why the rule is deliberately BRITTLE against a re-run: if a gate is measured again and a
// document still quotes the old sample, the document is stale and must say so. Going red on that is
// the alarm that was missing, not a false positive.
// WHERE `zk/build` IS depends on which tree this runs in, and hardcoding one answer made the mirror
// permanently red. Beside the service it is `<root>/zk/build`; in the published repository the
// artifacts ship INSIDE it at `Quiver/zk/build`, and `ROOT` there resolves one level too high for the
// same reason `hasSiblings` exists below. Candidates are tried in order and the first that exists wins.
//
// If NONE exists — a checkout that ships documents without artifacts — the citation half of rule 9
// cannot run, and it says so on stderr rather than passing quietly. A checker that examines nothing
// and reports success is the failure this whole file is a monument to.
const GAS_BUILD = [
  join(ROOT, 'zk', 'build'),
  join(SERVICE, 'zk', 'build'),
  join(SERVICE, '..', 'zk', 'build'),
].find((p) => existsSync(p)) || null;
if (!GAS_BUILD) console.error('!! no zk/build in this checkout — gas CITATIONS cannot be checked against artifacts (the requirement to carry one still is).');
const gasCache = new Map();
const gasArtifact = (name) => {
  if (!GAS_BUILD) return undefined;          // undefined = cannot check; null = checked and absent
  if (gasCache.has(name)) return gasCache.get(name);
  const p = join(GAS_BUILD, `${name}.json`);
  let v = null;
  if (existsSync(p)) { try { v = JSON.parse(readFileSync(p, 'utf8')); } catch { v = null; } }
  gasCache.set(name, v);
  return v;
};
const gasField = (json, field) => field.split('.').reduce((o, k) => (o == null ? o : o[k]), json);

const FACTS = {
  partCount: partFiles.length,
  paperTables: paperShape.tables,
  paperRefs: paperShape.refs,
  suiteSize: SUITE_SIZE,
  serviceCount: SERVICES.filter((s) => s.register !== false).length,
  buildId: _internal.buildId(),
  registry: deployment?.registry || null,
  verifier: deployment?.verifier || null,
  acceptTx: deployment?.acceptTx || null,
  rejectTx: deployment?.rejectTx || null,
  contentHash: deployment?.contentHash || null,
};

// ── the documents ────────────────────────────────────────────────────────────────────────────────
// `.html` is read as well as `.md`, and the cost of not doing so was not theoretical: `assets/
// landing.html` — the service's own front page — published a six-entry index of the machine-readable
// paper while seven parts were served, sent a judge to part 6 for artifacts that are in part 7, and
// was live and wrong for days. The rule that catches it is thirty lines below and had been correct
// the whole time; the walk simply never opened the file.
const SKIP_DIR = new Set(['node_modules', '.git', 'field-test', 'reservoir-data', 'build']);
// A snapshot is not a document. Four paths are excluded by name, and each is excluded because it is
// a COPY of something rather than a source — holding a copy to currency means editing an artifact
// whose whole value is that it records what was true when it was taken:
//
//   hackathon/.agents, hackathon/.claude   installed third-party skill packages. `skills-lock.json`
//                                          records their upstream (`okx/onchainos-skills`) and a
//                                          content hash — they are node_modules for skills, 244
//                                          files we neither wrote nor publish.
//   hackathon/judging/Quiver               the judge's clone. FINDINGS_LIVE.md names it as such:
//   hackathon/judging/_scratch             "Clone: …\hackathon\judging\Quiver".
//   hackathon/judging/quiver-whitepaper.html  the paper as it was RENDERED for that judging round —
//                                          it still quotes 298 tests and build q1-3af04b595f397b54.
//                                          The live copy of the same file is hackathon/paper/, which
//                                          IS checked and IS current.
//   hackathon/sentinel/vendor              the adversarial tester's vendored clone of the service.
//   hackathon/sentinel/recon               captured HTTP responses (`body_build`, `hdr_paper.txt`,
//                                          `github_readme.md`) — what the live service returned on
//                                          the day, down to the headers.
//
// Measured, these hold 47 of the 47 findings a naive full walk produces, every one of them of the
// form "this snapshot is older than today" — which is what a snapshot is. The reports ABOUT those
// runs stay in the corpus and are handled as logs by the rule below, so nothing is hidden by being
// dropped: it is classified instead.
const VENDORED = new Set([
  'hackathon/.agents', 'hackathon/.claude',
  'hackathon/judging/Quiver', 'hackathon/judging/_scratch', 'hackathon/judging/quiver-whitepaper.html',
  'hackathon/sentinel/vendor', 'hackathon/sentinel/recon',
]);
const rel = (p) => relative(ROOT, p).split(/[\\/]/).join('/');
const walk = (d, out = []) => {
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(d, e);
    if (VENDORED.has(rel(p))) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.md') || e.endsWith('.html')) out.push(p);
  }
  return out;
};
// The repository is what the world reads; the hackathon folder is what gets pasted into forms. Both
// have to agree, and historically the second is where the stale copy survives.
// In this working tree the published repository and the submission drafts sit beside each other. In a
// fresh clone neither sibling exists, and the service IS the repository — so scan itself instead of
// reporting nothing. A checker that silently examines zero documents passes every time.
const hasSiblings = existsSync(join(ROOT, 'Quiver')) && existsSync(join(ROOT, 'hackathon'));

// A DELIBERATE BLIND MODE. It exists for one caller — `npm run docs:revert` — and for one purpose:
// a claim that this tool used to be blind to a defect has to be DEMONSTRATED, not asserted, and the
// only way to demonstrate it is to put the defect back and run the old walk over it. Reimplementing
// the old walk inside the revert script would prove that the reimplementation is blind, which is a
// different and worthless statement. So the old walk stays here, reachable only by name.
//
//   - `.md` only, so `assets/landing.html` is never opened;
//   - `hackathon/` at its top level only, so nothing under `hackathon/veritape/` is opened;
//   - rule 7 off, because it did not exist.
//
// Setting this in ordinary use turns a 199-document check into a 138-document one that cannot see
// the front page. It therefore announces itself on stderr on every run, and `docs:revert` asserts
// that each defect PASSES here and FAILS by name in the default mode — so weakening the default
// breaks the revert rather than quietly widening this hole again.
const PRE_WIDENING = process.env.DOCS_CONSISTENCY_PRE_WIDENING === '1';
if (PRE_WIDENING) console.error('!! DOCS_CONSISTENCY_PRE_WIDENING=1 — running the pre-29-July walk: .md only, hackathon top level only, no content-loss rule.');
const oldWalk = (d, out = []) => {
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) oldWalk(p, out);
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
};
const docs = !hasSiblings
  // The fallback narrows too. Running the revert from the mirror, where neither sibling exists, the
  // blind mode was still walking `.html` and going red on the defect it was supposed to be blind to —
  // which reported a broken revert rather than a broken checker, and was only visible because the
  // revert is run from BOTH trees.
  ? (PRE_WIDENING ? oldWalk(SERVICE) : walk(SERVICE))
  : PRE_WIDENING
    ? [
        ...oldWalk(join(ROOT, 'Quiver')),
        ...readdirSync(join(ROOT, 'hackathon')).filter((f) => f.endsWith('.md')).map((f) => join(ROOT, 'hackathon', f)),
      ]
    : [...new Set([...walk(join(ROOT, 'Quiver')), ...walk(join(ROOT, 'hackathon'))])];
if (!docs.length) {
  console.error('FAILED: found no documents to check — the paths this tool walks have moved.');
  process.exit(1);
}
// `--list` prints the corpus and stops. It exists so that gates/docs-coverage-revert.mjs can ask THIS
// tool which files it reads, instead of reimplementing the walk and then proving things about the
// reimplementation. Combined with DOCS_CONSISTENCY_PRE_WIDENING it answers the only question that
// matters about a blind spot: was the file read at all?
if (process.argv.includes('--list')) {
  for (const d of docs) console.log(d);
  process.exit(0);
}

// A dated log is allowed to say what was true when it was written — that is what a log is for. A
// PUBLISHED artifact is not: a reader arrives at it today and has no way to know it is a snapshot.
// Only the second class is held to currency, and the distinction is drawn by path rather than by
// guessing from content, so adding a new log does not silently widen the exemption.
// PAPER_CONSISTENCY.md is a dated report of four stale figures that were corrected on 29 July 2026.
// Its whole job is to print the wrong sentence beside the right one — "quotes 152 model-free tests",
// "/paper/4 was … now …" — so holding it to currency would demand deleting the record of what was
// fixed, which is the opposite of what this project claims to do. It is a log by this rule's own
// definition, and it is named here rather than being allowed in by a content guess.
// hackathon/judging/ and hackathon/sentinel/ join the list for the same reason, and only once the
// corpus was widened far enough to read them. They are the write-ups of two adversarial sessions —
// a live-access judging round and a five-day third-party buyer QA — each of which states the build
// it was run against in its own header ("Build server saat verifikasi: q1-bce7e7bccb16ea1b", and a
// captured `curl /build` response). Eleven findings, every one of them "you quote the hash you
// tested". Holding those to today's hash would demand falsifying which build was measured, which is
// worse than the staleness it would remove. The clones and captures those sessions worked over are
// not in the corpus at all — see VENDORED above.
// DOCS_COVERAGE.md joins on exactly the precedent PAPER_CONSISTENCY.md set, and it was added because
// this rule accused it: it is the dated report of the three blind spots closed on 29 July, and it
// cannot describe them without printing "152 model-free tests", "q1-3af04b595f397b54" and the old
// table count beside the true ones. Named here rather than admitted by a content guess.
const LOG = /(research[\\/](BUYER_|zk[\\/])|MISSION_CONTROL|CHECKPOINT|DEEP_UNDERCLAIM|D_PROGRESS|SNARK_PLAN|OUTREACH|DIRECTORY_PRS|COMMUNITY_KIT|CRASH_STUDY|RESEARCH_ANCHOR|ROADMAP_V2|X_POST|WRONG_ENDPOINT_AUDIT|QUIVER_ROADMAP.md|PAPER_CONSISTENCY.md|paper-consistency.md|DOCS_COVERAGE.md|docs-coverage.md|hackathon[\\/](judging|sentinel)[\\/])/;

const problems = [];
const note = (file, line, msg) => problems.push({ file: relative(ROOT, file), line, msg });
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;
// Is this text a QUOTATION of an older claim? Correction tables have to print the wrong sentence
// beside the right one — `| "**External recurrence is zero**" | six payers, 44 payments | …` — or the
// record of what we got wrong cannot be published at all, which would be a strange thing for a
// project whose argument is that it publishes what it got wrong. Markdown emphasis is allowed
// between the quote mark and the text, which is where the first version of this let one through.
// …and it has to see the number wherever it sits INSIDE the quotation, not only as its first word.
// The six-character lookback catches `"386 tests"` and walks straight past
// `| the page said | "methods, ten tables and 44 references" |`, which is the same row doing the same
// job with the number four words in. So: a match is quoted if an odd number of quote marks precede it
// on its own line. Quotes inside markup are already blanked by asProse(), so an HTML attribute cannot
// open a quotation that swallows the rest of the line.
const isQuoted = (s, i) => {
  if (/["“]\**\s*$/.test(s.slice(Math.max(0, i - 6), i))) return true;
  const before = s.slice(s.lastIndexOf('\n', i - 1) + 1, i);
  return ((before.match(/"/g) || []).length % 2 === 1)
    || ((before.match(/“/g) || []).length > (before.match(/”/g) || []).length);
};

// Now that `.html` is in the corpus, the prose rules below have to read markup the way a person
// reads the rendered page — and raw markup lies to them in two specific ways gate X measured first.
// §3.6 of the paper narrates its own former error as `calling that &ldquo;all pass&rdquo;`: the
// quotation marks are ENTITIES, so the quoted-text exemption cannot see them, and a bold number
// written `<strong>386</strong> model-free tests` puts a closing tag where the rule expects a space.
//
// Tags and entities are therefore blanked to runs of spaces OF EXACTLY THE SAME LENGTH, so every
// byte offset — and therefore every line number this tool reports — is still the offset in the real
// file, while the prose reads contiguously. Quote entities become a real quote character, because
// the exemption they carry is the entire point of normalising them.
const QUOTE_ENT = /^(?:ldquo|rdquo|quot|#8220|#8221|#34)$/i;
const asProse = (s) => s
  .replace(/<[^>]*>/g, (m) => ' '.repeat(m.length))
  .replace(/&(#?\w+);/g, (m, name) => (QUOTE_ENT.test(name) ? '"' : ' ') + ' '.repeat(m.length - 1));

for (const f of docs) {
  const raw = readFileSync(f, 'utf8');
  // For every `.md` file these are the same string, so no existing behaviour moves.
  const s = f.endsWith('.html') ? asProse(raw) : raw;
  const isLog = LOG.test(f);

  // 1. Part URLs and part counts. The single most repeated miss: the count is fixed in one sentence
  //    while a LIST of part URLs two paragraphs down still stops at the old number.
  //    Read from `raw`, not from the prose view: on the front page half the references live in
  //    `href="/paper/7"` and blanking the tag would delete exactly the reference whose absence is
  //    the defect. A URL is structure, not prose.
  const partRefs = [...raw.matchAll(/\/paper\/(\d+)/g)].map((m) => Number(m[1]));
  const maxRef = partRefs.length ? Math.max(...partRefs) : 0;
  if (maxRef && maxRef !== FACTS.partCount) {
    note(f, lineOf(raw, raw.indexOf(`/paper/${maxRef}`)),
      `references /paper/${maxRef} but the machine edition has ${FACTS.partCount} parts`);
  }
  // A document that ENUMERATES parts must enumerate all of them — but `/paper/1` … `/paper/7` is a
  // RANGE, not a gappy list, and flagging it would be the checker accusing correct prose. Ranges are
  // recognised by the ellipsis between two references and expanded before the gap test.
  const rangeCovered = new Set();
  for (const m of raw.matchAll(/\/paper\/(\d+)`?\s*(?:…|\.\.\.|–|—|-)\s*`?\/paper\/(\d+)/g)) {
    for (let i = Number(m[1]); i <= Number(m[2]); i++) rangeCovered.add(i);
  }
  const seen = new Set([...partRefs, ...rangeCovered]);
  if (seen.size >= 3) {
    const missing = [];
    for (let i = 1; i <= FACTS.partCount; i++) if (!seen.has(i)) missing.push(i);
    if (missing.length) note(f, lineOf(raw, raw.indexOf('/paper/')),
      `enumerates parts but omits /paper/${missing.join(', /paper/')}`);
  }
  // Any qualifier is allowed between the number and "parts" — "six AI-readable parts", "six
  // machine-readable parts". The first version whitelisted `AI-readable` alone and walked straight
  // past "six machine-readable parts" in the HackQuest fields, which is the same class of hole as
  // requiring a bare space around a bold number: a check that only sees the phrasing it was written
  // against is a check for one document, not for the property.
  for (const [w, n] of isLog ? [] : [['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9]]) {
    const re = new RegExp(`\\b${w}\\s+(?:[a-z-]+\\s+){0,2}parts\\b`, 'gi');
    let m;
    while ((m = re.exec(s))) {
      if (n === FACTS.partCount) continue;
      // Quoted, exactly as with test counts: a correction table has to be able to print the wrong
      // phrasing beside the right one, or the record of what we got wrong cannot be published.
      if (/["“]\s*$/.test(s.slice(Math.max(0, m.index - 3), m.index))) continue;

      // "parts" is an ordinary English word and this rule only ever meant the MACHINE-READABLE PAPER.
      // It fired on "32 tests in five parts", a sentence about a gate that has nothing to do with the
      // paper, and a checker that cries wolf on correct prose gets ignored on the day it is right.
      // So the phrase now has to sit near something that identifies the paper. The rule exists because
      // the submission once said "six machine-readable parts" while seven were served, and that
      // sentence still trips it: `/paper` is thirty characters away.
      const near = s.slice(Math.max(0, m.index - 120), m.index + 120);
      if (!/paper|machine[- ]readable|whitepaper|\/paper\/|AI[- ]readable/i.test(near)) continue;

      note(f, lineOf(s, m.index), `says "${m[0]}" but there are ${FACTS.partCount}`);
    }
  }

  // 2. Test counts, in the HEADLINE form only — "N model-free tests", "N automated tests". The paper
  //    also narrates what the suite stood at during each review round, and those sentences are
  //    history rather than claims; flagging them produced eight findings that taught nothing, which
  //    is how a checker trains its reader to skip it.
  if (!isLog) {
    // `\*{0,2}` on both sides because the README writes **385** model-free tests, and the first
    // version of this pattern required a bare space — so a bold number sailed straight through the
    // check that existed to catch it. Verified by injecting 999 and watching nothing happen.
    for (const m of s.matchAll(/(\d{3})\*{0,2}\s+\*{0,2}(?:model-free|automated)\s+tests?\b/gi)) {
      const n = Number(m[1]);
      const ctx = s.slice(Math.max(0, m.index - 200), m.index);
      // The arrow must sit BETWEEN two counts — "367 → 385" — and not merely appear somewhere in the
      // preceding two hundred characters. A bare `→` matched the "see also" arrows the README uses in
      // every table row, which silently exempted the headline test count from the check written to
      // guard it: injecting 999 changed nothing. An exemption that broad is indistinguishable from
      // having no check at all.
      if (/\d{3}\s*(?:→|->)\s*$/.test(ctx)) continue;
      if (/close of that round|suite stood at|stood at|later rounds have taken/i.test(ctx)) continue;
      // A number inside quotation marks is a QUOTATION of an older claim, which comparison tables
      // exist to display beside the correction. Flagging it would demand we delete the record of
      // what we got wrong — the opposite of what this project claims to do.
      if (/["“]\s*$/.test(ctx)) continue;
      if (n !== SUITE_SIZE) note(f, lineOf(s, m.index), `quotes ${n} model-free tests; the suite has ${SUITE_SIZE}`);
    }
  }

  // 3. Service count.
  for (const m of isLog ? [] : s.matchAll(/(twenty-two|twenty-one|\b2[0-9]\b)\s+(priced\s+)?(quantitative\s+)?(computations|services|paid)/gi)) {
    const word = m[1].toLowerCase();
    const n = word === 'twenty-two' ? 22 : word === 'twenty-one' ? 21 : Number(word);
    if (n !== FACTS.serviceCount) note(f, lineOf(s, m.index), `says ${m[1]} services; there are ${FACTS.serviceCount}`);
  }

  // 4. Build hash — any q1-… string must be the current one, unless the sentence marks it superseded.
  for (const m of isLog ? [] : s.matchAll(/\bq1-[0-9a-f]{16}\b/g)) {
    if (m[0] === FACTS.buildId) continue;
    // The window spans BOTH sides, because a correction usually names the old hash first and the new
    // one after — "the pinned thread quotes X. It is now Y" is the correction working as intended,
    // and reading only backwards flagged it as the very error it was announcing.
    const ctx = s.slice(Math.max(0, m.index - 220), m.index + 260);
    if (/replaced|superseded|earlier|previous|older|history|was\b|before|it is now|quotes|no longer|stale/i.test(ctx)) continue;
    note(f, lineOf(s, m.index), `quotes build ${m[0]}; the engine is ${FACTS.buildId}`);
  }

  // 5. The on-chain deployment. A document that mentions the registry must get the address right,
  //    and one that discusses on-chain verification without it is the more dangerous omission.
  if (FACTS.registry) {
    for (const m of s.matchAll(/0x[0-9a-fA-F]{40}/g)) {
      const a = m[0].toLowerCase();
      const ctx = s.slice(Math.max(0, m.index - 120), m.index).toLowerCase();
      if (/registry/.test(ctx) && !/schemaregistry|eas /.test(ctx) && a !== FACTS.registry.toLowerCase() && a !== FACTS.verifier.toLowerCase()) {
        note(f, lineOf(s, m.index), `calls ${m[0]} a registry; the deployed one is ${FACTS.registry}`);
      }
    }
  }

  // 6. Claims the deployment contradicts outright.
  if (!isLog) {
    for (const re of [
      /no endpoint (?:of this service )?(?:serves|returns) a (?:SNARK|proof)/i,
      /gets the envelope, not the proof/i,
      /None of these is shipping/i,
      /Groth16 is the published artifact/i,
      // Retracted by on-chain measurement: six external payer addresses sent 44 payments over eight
      // days and four of the six returned. This sentence was corrected in the description and left
      // standing in a field on the same page, which is the exact failure that page warns about.
      /external recurrence is (currently )?zero/i,
      /none has returned for a third/i,
    ]) {
      let mm;
      const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((mm = rx.exec(s))) {
        if (isQuoted(s, mm.index)) continue;
        note(f, lineOf(s, mm.index), `states "${mm[0].slice(0, 60)}" — contradicted by ${FACTS.registry}`);
      }
    }
  }

  // 8. The paper's advertised shape. `assets/landing.html` sells the document as "methods, ten
  //    tables and 44 references, every one of them cited". Measured on 29 July: eleven tables and
  //    44 references. The sentence was CORRECT when it was written on 27 July — the paper had ten —
  //    and went stale on the 28th when the roadmap section arrived carrying Table 11. Nothing read
  //    it, because nothing opened `.html`, and it sits three lines above the six-versus-seven parts
  //    defect that WAS found: the same paragraph, the same file, the same day, one line noticed and
  //    the other not. A count that only a human compares is a count that drifts.
  //
  //    Held near paper context for the same reason rule 1's part-count is: "tables" and "references"
  //    are ordinary English. Measured across the maximal 471-document corpus this shape occurs three
  //    times — twice in the two copies of the front page, and once in QUIVER_SUBMISSION.md's
  //    correction table as `| "66 references" | **73** | Stale. |`, which the quotation exemption
  //    already covers and must, because that row exists to record what was wrong.
  const WORD_N = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
  for (const m of isLog ? [] : s.matchAll(/\b(five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|\d{1,3})[ -](tables|references)\b/gi)) {
    // `TEN-TABLES` is the name of a scenario in gates/docs-coverage-revert.mjs, not a claim about the
    // paper, and this rule accused it within a minute of being written. An identifier is not prose:
    // if the noun is not lower case, the phrase is a label. Narrow deliberately — "Ten tables" at the
    // start of a sentence is still read, because only the NOUN's case is tested.
    if (m[2] !== m[2].toLowerCase()) continue;
    const word = m[1].toLowerCase();
    const n = WORD_N[word] ?? Number(word);
    const truth = m[2] === 'tables' ? FACTS.paperTables : FACTS.paperRefs;
    if (!truth || n === truth) continue;
    if (isQuoted(s, m.index)) continue;
    const near = s.slice(Math.max(0, m.index - 160), m.index + 160);
    if (!/paper|whitepaper|\/paper\/|documentation|machine[- ]readable/i.test(near)) continue;
    // A CORRECTION is allowed to name the wrong count — "the front page said the paper had ten
    // tables" is the record of this very fix, and a rule that forbade writing it down would forbid
    // publishing the correction at all. Same shape and same window as the build-hash rule above,
    // and it is a window rather than a whitelist because the correction usually names the old count
    // first and the true one after. The defect itself survives it: the front page's own sentence —
    // "methods, ten tables and 44 references, every one of them cited: /paper (typeset)" — carries
    // none of these words, which is exactly what makes it a claim rather than a record.
    if (/\bsaid\b|\bwas\b|\bwere\b|corrected|stale|no longer|used to|until|since|earlier|previously/i.test(near)) continue;
    note(f, lineOf(s, m.index), `says "${m[0]}" of the paper; it has ${truth}`);
  }

  // 7. The document still says something. Every rule above asks whether a claim is TRUE; none asks
  //    whether the sentence carrying it survived being written down. On 29 July a changelog entry
  //    shipped to GitHub — and the changelog is served — with two empty table rows where the two
  //    contract addresses belonged and sentences ending `unchanged at .` and `Full record in .`
  //    where an inline code span had been. Cause: backticks inside a double-quoted `node -e`
  //    argument are command substitution, so every code span in the markdown was executed as a
  //    shell command and replaced by its empty output. This tool reported CONSISTENT over it,
  //    across 138 documents, because a hole is not a wrong number and nothing here looked for one.
  //
  //    It is a rule of its own rather than a note on another because the failure is SILENT and the
  //    document looks fine at a glance — the rows are still rows, the sentences still end in full
  //    stops. It is not held off logs: a log with its evidence eaten out is not a record of
  //    anything, and currency is not what is being asked about.
  //
  //    Four shapes, each drawn from that file and each measured against the whole 471-document
  //    maximal corpus before being admitted, at zero false positives. Two further candidates were
  //    measured and REJECTED for crying wolf: a row with SOME cells empty (136 hits, every one a
  //    legitimate trailing gap in a wide table) and a backtick pair around whitespace (108 hits,
  //    every one two adjacent code spans, `src/x402.js` `isChargeable()`).
  const lines = PRE_WIDENING ? [] : raw.split('\n');
  const fenced = new Array(lines.length).fill(false);
  for (let i = 0, inFence = false; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; fenced[i] = true; continue; }
    fenced[i] = inFence;
  }
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const L = lines[i];
    // (a) A table BODY row whose every cell is empty. The header row of a two-column table is
    //     legitimately written `| | |` in this repository, so the delimiter row `|---|---|` above is
    //     what distinguishes body from header — the damaged rows sat directly beneath one.
    if (/^\s*\|/.test(L)) {
      let delim = -1;
      for (let j = i - 1; j >= 0 && /^\s*\|/.test(lines[j]); j--) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[j]) && lines[j].includes('-')) { delim = j; break; }
      }
      const cells = L.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      if (delim >= 0 && cells.length >= 2 && cells.every((c) => !c.trim())) {
        note(f, i + 1, `table row has no content in any of its ${cells.length} cells — the row survived and what it said did not`);
      }
    }
    // (b) An inline code span with no matching partner on its line — `` with nothing between it.
    //     A run of exactly two backticks is legitimate markdown for a span that CONTAINS a backtick,
    //     `` `${rel}:${utf8}` ``, and those come in pairs; an odd count is one that lost its content.
    if ((L.match(/(?<!`)``(?!`)/g) || []).length % 2 === 1) {
      note(f, i + 1, 'unmatched empty inline code span — a code span lost its contents');
    }
    // (c) A line that begins with a comma. `a wrong asset reverts `MarkMismatch`, a bent proof …`
    //     lost its span and left the clause starting at the comma.
    if (/^,[ \t]/.test(L)) note(f, i + 1, 'line begins with a comma — the clause before it is missing');
  }
  // (d) A sentence that ends on a word which cannot end one: `unchanged at .`, `Full record in .`.
  //     Read from the prose view so `at <code>x</code>.` is not mistaken for a gap, and skipped
  //     inside fenced blocks, where `git add .` and `cp x .` are ordinary and correct.
  //     The SPACE between the word and the stop is the whole signal — "…that is what a log is for."
  //     is ordinary English and `for` is in this list; `for .` is a hole. The stop must also open a
  //     new sentence, because the damaged line was `unchanged at . Full record in .` and anchoring
  //     to end-of-line would have caught only the second of the two.
  for (const m of PRE_WIDENING ? [] : s.matchAll(/\b(?:at|in|on|to|of|by|for|from|with|into|via|under|over|and|or|the|an?|is|are|was|were|be|been|as|than|that|which|about|against|between|through|per)[ \t]+\.(?=\s*(?:$|[A-Z0-9"“(\[]))/gm)) {
    const ln = lineOf(s, m.index);
    if (fenced[ln - 1]) continue;
    note(f, ln, `sentence ends "${m[0].trim()}" — the word after it is missing`);
  }

  // 9. A PUBLISHED GAS FIGURE MUST CITE THE ARTIFACT THAT MEASURED IT.
  //
  //    Two halves, and the second is what stops the first being opt-in:
  //
  //    (a) every citation is CHECKED. `<!--gas:gateB5-2-constantproduct-evm#acceptGas-->` after a
  //        number means "this figure is that field", and the field is read and compared. A citation
  //        to a missing artifact, a missing field, or a different value is red. Applies to logs too:
  //        a log may say what was true when it was written, but it may not cite an artifact for a
  //        figure the artifact does not contain — that is a false attribution, not a dated record.
  //
  //    (b) inside a gate REPORT — `VERIFY_*.md` and its mirrored `verify-*.md` — every verify-scale
  //        gas figure must carry a citation. Without this, (a) is a rule you comply with by deleting
  //        the annotation, which is the "verifier that cannot fail" disease with an extra step.
  //
  //    Read from `raw`, never the prose view: `asProse()` blanks anything between angle brackets, so
  //    on an `.html` file it would erase exactly the annotation being checked. A citation is
  //    structure, like the `/paper/N` URLs in rule 1.
  //
  //    SCOPE, stated rather than implied. (b) covers the report class this defect occurred in and
  //    nothing else. Measured across this corpus, 39 documents name a gate artifact AND publish a
  //    verify-scale gas figure, 111 figures in total — including `assets/whitepaper.*`, which is
  //    frozen. Widening (b) to all 39 is the right end state and is NOT done here; what is done is
  //    the class of document whose entire purpose is to report a measurement.
  //
  //    The `\*{0,2}` on both sides of the number is not decoration. `the wide 3-leg verifier's
  //    **291,708** gas` is the exact form of one of the wrong figures, and a pattern requiring a bare
  //    space between the number and the word walked straight past it — the same hole rule 2 already
  //    records having had, in this same file, for the same reason.
  const GAS_SCALE = (n) => n >= 200_000 && n <= 4_000_000;
  // Below verify scale a gate report still publishes measured gas — a `rejectGas` of 573, and the
  // MARGINAL, which is the figure that took four different values and started all of this. So the
  // floor for a gate report is 500, not 200,000.
  //
  // The exemptions are ARITHMETIC ABOUT THE EVM, not measurements of this system: a cold account
  // access is 2,600 and a warm one 100 by EIP-2929, three precompiles make the 7,500 cold/warm gap,
  // and 21,000 is the intrinsic cost of a transaction. Those are properties of Ethereum that no
  // artifact in `zk/build` measures or could, and demanding a citation for them would be the checker
  // asking a document to source the yellow paper. Every one is a round number fixed by protocol; a
  // MEASURED figure of this system has never landed on one.
  const EVM_CONSTANT = new Set([100, 500, 2500, 2600, 5000, 7500, 21000]);
  const REPORT_SCALE = (n) => n >= 500 && n <= 4_000_000 && !EVM_CONSTANT.has(n);
  // The figure a citation refers to is the LAST number before it on the line. Two digits is the floor,
  // not four: `573 gas <!--gas:…#rejectGas-->` and `from 198 <!--gas:…#oneShotSmallest-->` are both
  // real citations in these reports, and a four-digit floor silently skipped past both to report "no
  // figure precedes the citation" — a checker complaining about the wrong thing, which is how a real
  // finding gets lost in noise the reader learns to ignore.
  const numAt = (t) => {
    const m = [...t.matchAll(/(\d{1,3}(?:,\d{3})+|\d{2,9})/g)].pop();
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  // The whole rule is off in PRE_WIDENING, because the walk that shipped these seven wrong figures had
  // no gas rule of any kind. Modelling it as "the old walk but with rule 9" would demonstrate a blind
  // spot that never existed and hide the one that did.
  if (PRE_WIDENING) continue;

  // (a) every citation is checked, in every document.
  //
  //     TWO FORMS, because two different kinds of quantity live in these artifacts and holding them
  //     to the same standard is what produced the mess.
  //
  //       `<!--gas:F#field-->`      EXACT. For anything deterministic: `rejectGas`, deployed byte
  //                                counts, a probe's own recorded statistics. These reproduce to the
  //                                digit and a difference is a real defect.
  //       `<!--gas:F#field~2%-->`   WITHIN 2%. For a single verify-gas sample, which is NOT
  //                                deterministic. Measured 30 July: 1.24%, 1.59% and 1.73% spread
  //                                across proofs of an IDENTICAL statement, so re-running a gate moves
  //                                the figure by thousands with nothing having changed. Three gates
  //                                were re-run by siblings DURING this rule's development and every
  //                                figure in them moved.
  //
  //     Why the tolerance form has to exist, and why it is not a weakening. The stale figure that
  //     started this — 276,892 against the artifact's 273,564 — differs by 1.2%, which is INSIDE the
  //     noise. So it was never a wrong measurement; it was a legitimate sample, published to six
  //     significant figures it does not have and then SUBTRACTED from another such sample. An exact
  //     rule would go red on that for the wrong reason and, worse, would go red on every honest
  //     re-run — which trains the next reader to delete the citation. A 2% rule says the thing that is
  //     actually true: this figure must be a sample of THIS artifact's quantity, not of some other
  //     circuit's, and it may not be quoted as if the digits mattered.
  //
  //     What the tolerance still catches, measured: every cross-artifact confusion in these four
  //     documents. 291,708 against a wide-verifier 292,124 passes at 2% and SHOULD — same quantity,
  //     different proof. 279,280 attributed to the benchmark verifier when the benchmark measures
  //     273,564 is 2.1% out and goes red. A marginal is held EXACTLY, because a marginal is a derived
  //     statistic and the whole defect was that its two terms came from different runs.
  for (const m of raw.matchAll(/<!--\s*gas:([A-Za-z0-9_-]+)#([A-Za-z0-9_.]+)(?:~([\d.]+)%)?\s*-->/g)) {
    const [, file, field, tolPct] = m;
    const ln = lineOf(raw, m.index);
    // `<!--gas:ARTIFACT#FIELD-->` is the SYNTAX, quoted verbatim by this rule's own error message and
    // therefore by every document that records the rule. It is not a citation, and accusing it is the
    // checker accusing its own documentation — the same mistake rule 8 records making when it fired on
    // the string `TEN-TABLES`, which is the name of a revert scenario rather than a claim about the
    // paper. Narrowed to the exact literal so a real artifact called anything else is still checked.
    if (file === 'ARTIFACT' && field === 'FIELD') continue;
    const json = gasArtifact(file);
    if (json === undefined) continue;        // no build directory at all — already announced on stderr
    if (!json) {
      note(f, ln, `cites zk/build/${file}.json for a gas figure; that artifact is not in this checkout`);
      continue;
    }
    const v = gasField(json, field);
    if (v === undefined || v === null) {
      note(f, ln, `cites ${file}#${field}; that artifact has no such field (top level: ${Object.keys(json).join(', ')})`);
      continue;
    }
    // The figure being cited is the last number before the annotation on its own line.
    const lineStart = raw.lastIndexOf('\n', m.index - 1) + 1;
    const claimed = numAt(raw.slice(lineStart, m.index));
    if (claimed === null) {
      note(f, ln, `cites ${file}#${field} but no figure precedes the citation on this line`);
      continue;
    }
    // Gas is integral, but a probe that reports a MEAN over 25 proofs stores 3815.2. A document
    // publishing that as "3,815 gas" is correct, so the comparison rounds — it does not widen.
    const truth = Math.round(Number(v));
    const when = json.at ? ` as measured at ${json.at}` : '';
    if (tolPct === undefined) {
      if (claimed !== truth) {
        note(f, ln, `publishes ${claimed.toLocaleString('en-US')} citing ${file}#${field}, which is ${truth.toLocaleString('en-US')}${when}`);
      }
    } else {
      const tol = Number(tolPct);
      // A tolerance of zero is the exact form written the long way, and a tolerance wide enough to
      // admit anything is a citation that cannot fail — which is the disease, not the cure. 5% of a
      // verify-gas figure is 14,000 gas, three times the measured spread; past that the citation is
      // decoration.
      if (!(tol > 0) || tol > 5) {
        note(f, ln, `cites ${file}#${field} with a ~${tolPct}% tolerance; a gas citation must be exact or within 5%, or it cannot fail`);
        continue;
      }
      const off = Math.abs(claimed - truth) / truth * 100;
      if (off > tol) {
        note(f, ln, `publishes ${claimed.toLocaleString('en-US')} citing ${file}#${field} within ~${tolPct}%, but that field is ${truth.toLocaleString('en-US')}${when} — ${off.toFixed(2)}% away`);
      }
    }
  }

  // (b) in a gate report, an uncited verify-scale gas figure is itself the finding.
  const isGateReport = /(?:^|[\\/])(?:VERIFY_[A-Z0-9_]+\.md|verify-[a-z0-9-]+\.md)$/.test(f);
  if (isGateReport && !PRE_WIDENING) {
    // prose form: "281,984 gas", "**291,708** gas", "7,500-gas"
    const cited = (idx) => {
      const lineEnd = raw.indexOf('\n', idx);
      return /<!--\s*gas:/.test(raw.slice(idx, lineEnd < 0 ? raw.length : lineEnd));
    };
    for (const m of raw.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,7})\*{0,2}\s*(?:-\s*)?gas\b/gi)) {
      const n = Number(m[1].replace(/,/g, ''));
      if (!REPORT_SCALE(n)) continue;
      const ln = lineOf(raw, m.index);
      if (fenced[ln - 1]) continue;
      if (isQuoted(raw, m.index)) continue;
      const near = raw.slice(Math.max(0, m.index - 240), m.index + 160);
      if (/\bsaid\b|\bwas\b|\bwere\b|corrected|stale|no longer|used to|earlier|previously|recalled|superseded|disagree/i.test(near)) continue;
      if (cited(m.index)) continue;
      note(f, ln, `publishes ${m[1]} gas without citing the artifact that measured it — add <!--gas:ARTIFACT#FIELD-->`);
    }
    // table form: a body cell in a column whose header is exactly "gas". Six of the wrong figures
    // lived here, in a column where the word "gas" appears once in the header and never on the rows,
    // so the prose pattern above could not see any of them.
    for (let i = 0; i < lines.length; i++) {
      if (fenced[i] || !/^\s*\|/.test(lines[i])) continue;
      let delim = -1;
      for (let j = i - 1; j >= 0 && /^\s*\|/.test(lines[j]); j--) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[j]) && lines[j].includes('-')) { delim = j; break; }
      }
      if (delim < 1) continue;
      const cellsOf = (L) => L.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      const head = cellsOf(lines[delim - 1]).map((c) => c.replace(/\*/g, '').trim().toLowerCase());
      const cells = cellsOf(lines[i]);
      for (let c = 0; c < cells.length && c < head.length; c++) {
        if (!/^(?:accept |reject |verify )?gas$/.test(head[c])) continue;
        const n = numAt(cells[c].replace(/<!--[\s\S]*?-->/g, ''));
        if (n === null || !GAS_SCALE(n)) continue;
        if (/<!--\s*gas:/.test(cells[c])) continue;
        note(f, i + 1, `table column "${head[c]}" publishes ${n.toLocaleString('en-US')} without citing the artifact that measured it — add <!--gas:ARTIFACT#FIELD-->`);
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
if (VERBOSE) {
  console.log('Facts read from the system:');
  for (const [k, v] of Object.entries(FACTS)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log(`  documents      ${docs.length}\n`);
}
if (!problems.length) {
  console.log(`CONSISTENT — ${docs.length} documents agree with each other and with the running system.`);
  process.exit(0);
}
console.log(`${problems.length} CONTRADICTION${problems.length > 1 ? 'S' : ''} across ${docs.length} documents:\n`);
const byFile = {};
for (const p of problems) (byFile[p.file] ||= []).push(p);
for (const [file, ps] of Object.entries(byFile)) {
  console.log(`  ${file}`);
  for (const p of ps) console.log(`     L${p.line}: ${p.msg}`);
}
process.exit(1);
