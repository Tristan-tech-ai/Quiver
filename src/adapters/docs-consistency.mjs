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
//   node tools/docs-consistency.mjs            # check
//   node tools/docs-consistency.mjs --verbose  # also print every fact and where it was found
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

const FACTS = {
  partCount: partFiles.length,
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
const walk = (d, out = []) => {
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e === '.git' || e === 'field-test' || e === 'reservoir-data') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
};
// The repository is what the world reads; the hackathon folder is what gets pasted into forms. Both
// have to agree, and historically the second is where the stale copy survives.
// In this working tree the published repository and the submission drafts sit beside each other. In a
// fresh clone neither sibling exists, and the service IS the repository — so scan itself instead of
// reporting nothing. A checker that silently examines zero documents passes every time.
const hasSiblings = existsSync(join(ROOT, 'Quiver')) && existsSync(join(ROOT, 'hackathon'));
const docs = hasSiblings
  ? [
      ...walk(join(ROOT, 'Quiver')),
      ...readdirSync(join(ROOT, 'hackathon')).filter((f) => f.endsWith('.md')).map((f) => join(ROOT, 'hackathon', f)),
    ]
  : walk(SERVICE);
if (!docs.length) {
  console.error('FAILED: found no documents to check — the paths this tool walks have moved.');
  process.exit(1);
}

// A dated log is allowed to say what was true when it was written — that is what a log is for. A
// PUBLISHED artifact is not: a reader arrives at it today and has no way to know it is a snapshot.
// Only the second class is held to currency, and the distinction is drawn by path rather than by
// guessing from content, so adding a new log does not silently widen the exemption.
const LOG = /(research[\\/](BUYER_|zk[\\/])|MISSION_CONTROL|CHECKPOINT|DEEP_UNDERCLAIM|D_PROGRESS|SNARK_PLAN|OUTREACH|DIRECTORY_PRS|COMMUNITY_KIT|CRASH_STUDY|RESEARCH_ANCHOR|ROADMAP_V2|X_POST|WRONG_ENDPOINT_AUDIT|QUIVER_ROADMAP.md)/;

const problems = [];
const note = (file, line, msg) => problems.push({ file: relative(ROOT, file), line, msg });
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;
// Is this text a QUOTATION of an older claim? Correction tables have to print the wrong sentence
// beside the right one — `| "**External recurrence is zero**" | six payers, 44 payments | …` — or the
// record of what we got wrong cannot be published at all, which would be a strange thing for a
// project whose argument is that it publishes what it got wrong. Markdown emphasis is allowed
// between the quote mark and the text, which is where the first version of this let one through.
const isQuoted = (s, i) => /["“]\**\s*$/.test(s.slice(Math.max(0, i - 6), i));

for (const f of docs) {
  const s = readFileSync(f, 'utf8');
  const isLog = LOG.test(f);

  // 1. Part URLs and part counts. The single most repeated miss: the count is fixed in one sentence
  //    while a LIST of part URLs two paragraphs down still stops at the old number.
  const partRefs = [...s.matchAll(/\/paper\/(\d+)/g)].map((m) => Number(m[1]));
  const maxRef = partRefs.length ? Math.max(...partRefs) : 0;
  if (maxRef && maxRef !== FACTS.partCount) {
    note(f, lineOf(s, s.indexOf(`/paper/${maxRef}`)),
      `references /paper/${maxRef} but the machine edition has ${FACTS.partCount} parts`);
  }
  // A document that ENUMERATES parts must enumerate all of them — but `/paper/1` … `/paper/7` is a
  // RANGE, not a gappy list, and flagging it would be the checker accusing correct prose. Ranges are
  // recognised by the ellipsis between two references and expanded before the gap test.
  const rangeCovered = new Set();
  for (const m of s.matchAll(/\/paper\/(\d+)`?\s*(?:…|\.\.\.|–|—|-)\s*`?\/paper\/(\d+)/g)) {
    for (let i = Number(m[1]); i <= Number(m[2]); i++) rangeCovered.add(i);
  }
  const seen = new Set([...partRefs, ...rangeCovered]);
  if (seen.size >= 3) {
    const missing = [];
    for (let i = 1; i <= FACTS.partCount; i++) if (!seen.has(i)) missing.push(i);
    if (missing.length) note(f, lineOf(s, s.indexOf('/paper/')),
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
