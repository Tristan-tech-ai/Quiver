// Paper integrity — the two questions the paper checks could not previously ask.
//
// This file holds LOGIC ONLY. It reads nothing and fetches nothing: every input is handed in. That
// is deliberate and it is the whole reason a revert can prove these checks are able to fail. The
// paper itself is off limits to a gate — `assets/whitepaper.html` and the generated
// `whitepaper.part*.md` may not be edited to demonstrate anything — so the only honest way to show a
// check goes red is to feed it a mutated copy IN MEMORY and watch it refuse. A checker that can only
// be exercised by damaging the artifact it guards will never be exercised.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// QUESTION 1 — PARITY.  "Does the repository's paper still match what the live service serves?"
//
// preflight's check 5 used to answer this with byte equality across all seven parts, and that answer
// is false BY CONSTRUCTION the moment the paper is legitimately corrected: the repository moves
// first, live moves at the deploy, and preflight is the gate that authorises the deploy. Check 6 in
// the same script demands the changelog be AHEAD of live. So one check demanded repo == live and the
// other demanded repo > live, and the only state satisfying both was one in which the paper had not
// been touched. It blocked precisely the deploy that would have made it green.
//
// Deleting it was not an option. It exists to catch drift in what a judge reads, and a gate weakened
// to erase a red is worse than no gate, because it retires a real guard while looking like one. The
// distinction that has to be encoded is:
//
//     the paper differs from live because we changed it deliberately, and that is written down
//         → proceed
//     the paper differs from live and nothing accounts for it
//         → block
//
// The signal has to bind to the BYTES, because everything weaker is satisfied by accident. "The
// changelog mentions the paper" is satisfied by an unrelated entry. "The changelog names the parts
// that changed" is satisfied twice over by a second, unnoticed edit to a part that was already named
// — which is the likeliest accident of all, since the parts are regenerated wholesale by a script.
// So a part that differs in substance must be declared by CONTENT HASH in
// `gates/paper-pending-deploy.json`, and that declaration must be covered by a changelog entry this
// deploy has not yet published. Any further byte moves the hash and the declaration stops matching.
//
// The property that makes this a repair rather than a loophole: the new condition is always
// satisfiable by an action IN THE REPOSITORY — write down what you changed. The old one was
// satisfiable only by the deploy it was gating.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// QUESTION 2 — MAPPING.  "Does /paper/N still serve the sections we told readers it serves?"
//
// `tools/paper-to-text.mjs` packs sections greedily against a 55,000-byte budget AT section
// boundaries. It does not cut at every boundary, so the part a section lands in is a function of
// every byte before it. Measured on 29 July 2026: part 4 sat 173 bytes under budget, and adding 465
// bytes to §6 moved §8 *Limitations and Honest Disclosures* out of part 4 and into part 5 while the
// COUNT stayed at seven. Every existing check watches the count. All of them stay green through that
// move, and a reader sent to part 4 for the limitations finds the walkthrough instead.
//
// `assets/whitepaper.parts.json` records the mapping, but it is regenerated alongside the parts, so
// it cannot witness its own drift: the move rewrites the record and the record agrees with the move.
// The fix is a mapping committed by hand in `gates/paper-mapping.json` that NOTHING regenerates,
// checked against the computed packing, against parts.json, and against every place the mapping is
// published in prose. When any one of those moves, the three stop agreeing and a human has to decide
// which is right — which is the only decision a machine cannot make here.
//
// One approach was considered and rejected: keyword-matching the published prose against the
// generated headings. Part 2's published description is "the twenty-two services" and its generated
// title is "4. Service Catalogue"; no keyword rule relates those without either false-positiving or
// being loosened until it matches anything. The committed file sidesteps it by storing BOTH sides
// verbatim and asserting that neither moves without the other. The machine cannot verify that
// "limitations" means §8. It can verify that the pairing a human approved is still the pairing being
// served and the pairing being published, which is the part that actually rots.
import { createHash } from 'node:crypto';

// Must equal `const BUDGET = 55_000` in tools/paper-to-text.mjs. Asserted, not assumed — see
// `budgetMatchesGenerator` below.
export const BUDGET = 55_000;
export const HEADROOM_WARN = 1_200;   // ~a paragraph. See `headroomVerdict`.

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PARITY
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const NAV_END = '\n---\n\n';
const TAIL_START = '\n\n---\n\n';

// Every part file is three pieces: a generated navigation header, the packed section text, and a
// generated tail. Only the middle one is the paper. Telling them apart is what turns "0 of 7" into
// something a reader can act on.
export function splitPart(text) {
  const a = text.indexOf(NAV_END);
  const b = text.lastIndexOf(TAIL_START);
  if (a < 0 || b <= a) return { ok: false, nav: text, body: '', tail: '' };
  return { ok: true, nav: text.slice(0, a + NAV_END.length), body: text.slice(a + NAV_END.length, b), tail: text.slice(b) };
}

// The ONE navigation line that is a pure echo of the whole document's size. It is regenerated in
// every part from `Math.round(bytes/1024)`, so a 116-byte edit anywhere tipped 247 kB to 248 kB and
// rewrote one line in all seven parts — which is why the old check reported `0 of 7` when two parts
// had changed in substance.
//
// NOTHING ELSE in the navigation header is treated as an echo, and that restraint is load-bearing:
// the header also carries the full part MAP, so a section moving between parts rewrites the map in
// every part too. Folding that into "just the header" would hide exactly the drift the mapping
// contract exists to catch.
const SIZE_LINE = /^> Whole document in one response \(\d+ kB, may truncate in your client\): `\/paper\/full`$/;

export function classifyPart(repo, live) {
  if (live == null) return { state: 'unreachable', why: ['live did not answer — this part could not be compared, and an unevaluated check is not a pass'] };
  if (repo === live) return { state: 'same', why: [] };
  const R = splitPart(repo), L = splitPart(live);
  if (!R.ok || !L.ok) return { state: 'substantive', why: ['the part does not have the expected header/body/tail shape'] };
  const why = [];
  if (R.body !== L.body) {
    const r = R.body.split('\n'), l = L.body.split('\n');
    let n = 0;
    for (let i = 0; i < Math.max(r.length, l.length); i++) if (r[i] !== l[i]) n++;
    why.push(`${n} line${n === 1 ? '' : 's'} of the paper text differ`);
  }
  if (R.tail !== L.tail) why.push('the continues/end-of-document tail differs');
  if (R.nav !== L.nav) {
    const r = R.nav.split('\n'), l = L.nav.split('\n');
    const beyondSize = [];
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      if (r[i] === l[i]) continue;
      if (SIZE_LINE.test(r[i] || '') && SIZE_LINE.test(l[i] || '')) continue;
      beyondSize.push(`nav line ${i + 1}`);
    }
    if (beyondSize.length) why.push(`the navigation header differs beyond the document-size echo (${beyondSize.join(', ')}) — the header carries the part map, so this can be a section moving between parts`);
  }
  if (why.length) return { state: 'substantive', why };
  return { state: 'nav-echo', why: ['only the generated whole-document-size line differs'] };
}

/**
 * @param parts           [{ n, repo, live }]  live === null means the fetch failed
 * @param manifest        parsed gates/paper-pending-deploy.json, or null if absent/unparseable
 * @param changelogRepo   assets/changelog.md as it is in this tree
 * @param changelogLive   what the live service serves at /changelog, or null
 */
export function assessPaperParity({ parts, manifest, changelogRepo, changelogLive }) {
  const lines = [];
  const blocking = [];
  const seen = parts.map((p) => ({ ...p, ...classifyPart(p.repo, p.live) }));

  if (!parts.length) {
    return { pass: false, detail: 'no whitepaper.part*.md found — a check that compares nothing passes every time', states: [] };
  }

  const substantive = seen.filter((p) => p.state === 'substantive');
  const echo = seen.filter((p) => p.state === 'nav-echo');
  const same = seen.filter((p) => p.state === 'same');
  const dead = seen.filter((p) => p.state === 'unreachable');

  lines.push(`${parts.length} parts: ${substantive.length} differ in the paper text (${substantive.map((p) => p.n).join(', ') || 'none'}), `
    + `${echo.length} differ only in the generated document-size line (${echo.map((p) => p.n).join(', ') || 'none'}), `
    + `${same.length} byte-identical to live${dead.length ? `, ${dead.length} UNREACHABLE` : ''}`);

  for (const p of dead) blocking.push(`part ${p.n}: ${p.why[0]}`);

  // Steady state: nothing to account for, so nothing is demanded. This is the case a deploy restores,
  // and it is why the repaired check is not merely red in a different place.
  if (!substantive.length && !echo.length && !dead.length) {
    return { pass: true, detail: lines.join('\n           ') + '\n           nothing to account for — the repository and live agree byte for byte', states: seen };
  }

  // A size echo is a MECHANICAL consequence of the paper text changing somewhere. If no part changed
  // in substance, the served bytes moved for a reason nothing in this tree explains, and that is the
  // undocumented-drift case in its purest form.
  if (echo.length && !substantive.length) {
    blocking.push(`${echo.length} part(s) carry a changed document-size line while no part's text changed — the served bytes moved and nothing in this tree explains it`);
  }

  if (!manifest || typeof manifest !== 'object') {
    blocking.push('gates/paper-pending-deploy.json is missing or unreadable, so no difference can be accounted for');
  } else {
    const declared = manifest.parts && typeof manifest.parts === 'object' ? manifest.parts : {};
    const entryOf = (k) => (typeof declared[k] === 'string' ? { sha256: declared[k] } : (declared[k] || {}));

    // EVERY declaration must be true of the tree as it stands, whether or not that part currently
    // differs from live. A declaration that has drifted from the bytes is not evidence of anything,
    // and letting a stale one sit means the next accidental edit inherits an approval nobody gave.
    //
    // Each declaration also names the changelog entry that explains it, rather than one anchor for
    // the whole file. That is not decoration: on the day this was written the paper had been changed
    // by TWO separate corrections landing in different parts, and a single anchor would have let the
    // second one ride on the first one's paperwork.
    for (const k of Object.keys(declared)) {
      const p = seen.find((x) => String(x.n) === String(k));
      if (!p) { blocking.push(`the manifest declares part ${k}, which does not exist`); continue; }
      const e = entryOf(k);
      const got = sha256(p.repo);
      if (e.sha256 !== got) {
        blocking.push(`the manifest declares part ${k} as ${String(e.sha256 || '(nothing)').slice(0, 16)}… but assets/whitepaper.part${k}.md hashes to ${got.slice(0, 16)}… — the file has moved since it was approved`);
      }
      const anchor = typeof e.changelog === 'string' && e.changelog ? e.changelog
        : (typeof manifest.changelogAnchor === 'string' ? manifest.changelogAnchor : '');
      if (!anchor) blocking.push(`part ${k} is declared but names no changelog entry, so nothing ties the change to a published record`);
      else if (!changelogRepo.includes(anchor)) blocking.push(`part ${k} names the changelog entry ${JSON.stringify(anchor.slice(0, 60))}, which is not in assets/changelog.md`);
      else if (changelogLive == null) blocking.push(`part ${k}: could not read the live changelog, so it is unknown whether its entry has already shipped`);
      else if (changelogLive.includes(anchor)) blocking.push(`part ${k} names the changelog entry ${JSON.stringify(anchor.slice(0, 60))}, which is ALREADY live — it does not document an unshipped change`);
      else if (p.state !== 'same') lines.push(`part ${k} — declared, hash matches, documented by the unpublished entry ${JSON.stringify(anchor.slice(0, 64))}`);
    }

    // Every substantive difference must be declared.
    for (const p of substantive) {
      if (!(String(p.n) in declared)) {
        blocking.push(`part ${p.n} differs from live in the paper text (${p.why.join('; ')}) and is NOT declared in gates/paper-pending-deploy.json`);
      }
    }

    const stale = Object.keys(declared).filter((k) => seen.find((x) => String(x.n) === String(k))?.state === 'same');
    if (stale.length) lines.push(`part(s) ${stale.join(', ')} are declared and already match live — shipped, and harmless because the declaration is pinned to their current bytes`);
  }

  if (blocking.length) {
    lines.push('UNACCOUNTED:');
    for (const b of blocking) lines.push(`  · ${b}`);
    const need = substantive.filter((p) => !(manifest?.parts && String(p.n) in manifest.parts));
    if (need.length) {
      lines.push('  to accept these deliberately, read the diff for each and then declare them:');
      for (const p of need) lines.push(`    "${p.n}": { "sha256": "${sha256(p.repo)}", "changelog": "<the entry that explains it>" },`);
    }
  } else {
    lines.push(`every difference is declared by content hash and covered by an unpublished changelog entry`);
  }
  return { pass: blocking.length === 0, detail: lines.join('\n           '), states: seen, blocking };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// MAPPING
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// Mirrors tools/paper-to-text.mjs. Greedy, at section boundaries, against the byte budget.
export function packSections(md, budget = BUDGET) {
  const body = md.slice(md.indexOf('\n---\n\n') + '\n---\n\n'.length);
  const sections = [];
  let cur = [];
  for (const line of body.split('\n')) {
    if (/^## /.test(line) && cur.length) { sections.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) sections.push(cur.join('\n'));
  const parts = [];
  for (const s of sections) {
    const last = parts[parts.length - 1];
    if (last && Buffer.byteLength(last + s, 'utf8') <= budget) parts[parts.length - 1] = last + '\n' + s;
    else parts.push(s);
  }
  return parts;
}
export const sectionsOf = (p) => [...p.matchAll(/^## (.+)$/gm)].map((x) => x[1].replace(/\s+/g, ' ').trim());
export const titleOf = (p) => (sectionsOf(p).join('  |  ') || 'Front matter');

// Rebuild the file the splitter would have written, byte for byte. This is what catches a part that
// was hand-edited (the parts are generated, so any hand edit is lost at the next regeneration and
// silently disagrees with the source in the meantime) and a part that was never regenerated after
// the source moved. It also keeps this module honest: if the generator's template changes and the
// parts are regenerated, the rebuild stops matching and the failure is loud rather than silent.
export function rebuildPartFile(md, parts, i) {
  const map = parts.map((p, k) => `- **Part ${k + 1}** — \`/paper/${k + 1}\` — ${titleOf(p)}`).join('\n');
  const nav = `# Quiver — Technical Documentation — part ${i + 1} of ${parts.length}

> The complete document, split only because a single fetch truncates. **Nothing is abridged**: the
> parts below concatenate to the whole text, cut at section boundaries. Every part is served as plain
> markdown.
>
${map.split('\n').map((l) => '> ' + l).join('\n')}
>
> Whole document in one response (${Math.round(Buffer.byteLength(md, 'utf8') / 1024)} kB, may truncate in your client): \`/paper/full\`
> Typeset edition with figures: \`/paper\`
> Live service: https://quiver-production-c3a8.up.railway.app · Source: https://github.com/Tristan-tech-ai/Quiver

---

`;
  const tail = i + 1 < parts.length
    ? `\n\n---\n\n**Continues in part ${i + 2} of ${parts.length}: \`/paper/${i + 2}\` — ${titleOf(parts[i + 1])}**\n`
    : `\n\n---\n\n**End of the document.** Part ${i + 1} of ${parts.length} was the last.\n`;
  return nav + parts[i].trim() + tail;
}

// The HTML is the source and the markdown edition is generated from it, so a section added, removed,
// renamed or reordered in the HTML without a regeneration leaves the two disagreeing — and that is
// the change most likely to move a boundary. Comparing the SEQUENCE of top-level headings catches it
// without re-implementing the whole HTML-to-markdown transform, which would be a second copy of 150
// lines of rules and would drift from the first.
const ENT = { nbsp: ' ', mdash: '—', ndash: '–', middot: '·', amp: '&', hellip: '…', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', quot: '"', lt: '<', gt: '>' };
const decodeEnt = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => (n in ENT ? ENT[n] : m));
export const htmlSections = (html) => [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
  .map((m) => decodeEnt(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
export const stripNumber = (t) => t.replace(/^\d+(?:\.\d+)*\.?\s+/, '');

/**
 * @param contract    parsed gates/paper-mapping.json — hand-written, never regenerated
 * @param md          assets/whitepaper.md
 * @param html        assets/whitepaper.html
 * @param partsJson   parsed assets/whitepaper.parts.json (generated)
 * @param onDisk      [{ n, text }] the whitepaper.part*.md files present
 * @param publications [{ file, present, text }] every place the mapping is published in prose
 * @param generatorSource  tools/paper-to-text.mjs, for the budget-drift check
 */
export function assessPaperMapping({ contract, md, html, partsJson, onDisk, publications, generatorSource }) {
  const findings = [];
  const notes = [];
  const parts = packSections(md);
  const computed = parts.map(titleOf);
  const sizes = parts.map((p) => Buffer.byteLength(p, 'utf8'));
  const headroom = sizes.map((b) => BUDGET - b);

  // 0. the budget this module packs against is still the generator's budget
  if (generatorSource && !/BUDGET\s*=\s*55_000\b/.test(generatorSource)) {
    findings.push({ rule: 'BUDGET', msg: 'tools/paper-to-text.mjs no longer declares BUDGET = 55_000 — every packing figure below is computed against the wrong number' });
  }

  const declared = Array.isArray(contract?.parts) ? contract.parts : null;
  if (!declared) {
    findings.push({ rule: 'CONTRACT', msg: 'gates/paper-mapping.json is missing, unreadable, or has no parts[] — there is no committed mapping to check against' });
    return { findings, notes, computed, sizes, headroom, parts };
  }

  // 1. THE ASSERTION. What the text packs into must be the mapping a human committed.
  if (declared.length !== computed.length) {
    findings.push({ rule: 'MAPPING', msg: `the text packs into ${computed.length} parts; the committed mapping has ${declared.length}` });
  }
  for (let i = 0; i < Math.max(declared.length, computed.length); i++) {
    const want = declared[i] ? declared[i].sections.join('  |  ') : '(no committed entry)';
    const got = computed[i] ?? '(nothing packs here)';
    if (want !== got) findings.push({ rule: 'MAPPING', msg: `part ${i + 1} now packs «${got}» but the committed mapping says «${want}»` });
  }

  // 2. the generated record agrees with the committed one. parts.json is rewritten by the same run
  //    that moves a boundary, so it can never witness its own drift — but it CAN witness a part set
  //    that was never regenerated, which is the other half of the same failure.
  if (!partsJson || !Array.isArray(partsJson.titles)) {
    findings.push({ rule: 'PARTS-JSON', msg: 'assets/whitepaper.parts.json is missing or has no titles[]' });
  } else {
    if (partsJson.count !== declared.length) findings.push({ rule: 'PARTS-JSON', msg: `whitepaper.parts.json records ${partsJson.count} parts; the committed mapping has ${declared.length}` });
    for (let i = 0; i < declared.length; i++) {
      const want = declared[i].sections.join('  |  ');
      if (partsJson.titles[i] !== want) findings.push({ rule: 'PARTS-JSON', msg: `whitepaper.parts.json part ${i + 1} records «${partsJson.titles[i] ?? '(nothing)'}» against the committed «${want}»` });
    }
  }

  // 3. the files on disk are exactly what the splitter would write from this source
  if (onDisk.length !== parts.length) {
    findings.push({ rule: 'ON-DISK', msg: `${onDisk.length} whitepaper.part*.md exist but the text packs into ${parts.length} — regenerate with tools/paper-to-text.mjs` });
  }
  for (const { n, text } of onDisk) {
    if (n > parts.length) continue;
    const want = rebuildPartFile(md, parts, n - 1);
    if (text !== want) {
      const a = want.split('\n'), b = text.split('\n');
      let at = -1;
      for (let k = 0; k < Math.max(a.length, b.length); k++) if (a[k] !== b[k]) { at = k + 1; break; }
      findings.push({ rule: 'ON-DISK', msg: `whitepaper.part${n}.md is not what the splitter would write from assets/whitepaper.md (first difference at line ${at}) — it was hand-edited, or the source moved without a regeneration` });
    }
  }

  // 4. the HTML source and the markdown edition list the same sections in the same order
  const hs = htmlSections(html);
  const ms = computed.join('  |  ').split('  |  ').filter((x) => x !== 'Front matter');
  const msPlain = ms.map(stripNumber);
  if (hs.length !== msPlain.length || hs.some((h, i) => h !== msPlain[i])) {
    const at = hs.findIndex((h, i) => h !== msPlain[i]);
    findings.push({ rule: 'SOURCE', msg: `assets/whitepaper.html lists ${hs.length} top-level sections and assets/whitepaper.md lists ${msPlain.length}` + (at >= 0 ? `; first divergence at ${at + 1}: html «${hs[at] ?? '(none)'}» vs md «${msPlain[at] ?? '(none)'}»` : '') + ' — the markdown edition was not regenerated from the source' });
  }

  // 5. every place the mapping is PUBLISHED in prose still says what the contract says.
  //    Two rules, because they fail differently.
  //      (a) the exact published phrase for each part is still present, byte for byte. This is what
  //          keeps prose and packing pinned together WITHOUT keyword-matching one against the other:
  //          the human-approved pairing is stored verbatim on both sides, and neither may move alone.
  //      (b) the set of part numbers a site references is exactly the served set. This is the rule
  //          that catches a site left behind by a change in the part COUNT, which is what happened to
  //          assets/landing.html: it enumerated six parts, and the seventh had existed for days.
  let checkedSites = 0;
  for (const pub of publications || []) {
    const decl = (contract.publications || []).find((x) => x.file === pub.file);
    if (!decl) { findings.push({ rule: 'PUBLISHED', msg: `${pub.file} was read as a publication site but the committed mapping declares no expectations for it` }); continue; }
    if (!pub.present) { notes.push(`${pub.file} — not present in this tree, skipped`); continue; }
    checkedSites++;
    for (let i = 0; i < decl.mustContain.length; i++) {
      if (!pub.text.includes(decl.mustContain[i])) {
        findings.push({ rule: 'PUBLISHED', msg: `${pub.file} no longer contains its committed description of part ${i + 1}: ${JSON.stringify(decl.mustContain[i])}` });
      }
    }
    if (decl.enumeratesParts !== false) {
      const refs = new Set([...pub.text.matchAll(/\/paper\/(\d+)/g)].map((m) => Number(m[1])));
      const missing = [];
      for (let i = 1; i <= declared.length; i++) if (!refs.has(i)) missing.push(i);
      const extra = [...refs].filter((r) => r > declared.length);
      if (missing.length) findings.push({ rule: 'PUBLISHED', msg: `${pub.file} enumerates the machine-readable parts but never references part ${missing.join(', ')} — a reader is told the paper is smaller than it is` });
      if (extra.length) findings.push({ rule: 'PUBLISHED', msg: `${pub.file} references part ${extra.join(', ')}, which is not served` });
    }
  }
  // A publication check that reached no files passes every time.
  const minSites = contract.minimumSitesChecked ?? 2;
  if (checkedSites < minSites) findings.push({ rule: 'PUBLISHED', msg: `only ${checkedSites} publication site(s) were readable; the contract requires at least ${minSites}, or this rule is measuring nothing` });

  return { findings, notes, computed, sizes, headroom, parts, checkedSites };
}

// Is 173 bytes of headroom worth a WARNING as well as the hard assertion above? Yes, and the two do
// different jobs. The assertion fires AFTER the boundary has moved — the paper is already re-cut and
// the published mapping is already wrong, and the remedy is to rewrite prose or re-approve the
// mapping. The warning fires BEFORE, while the cheap remedy (shorten the sentence, or move it into
// an adjacent section) still exists. 1,200 bytes is roughly one paragraph of this paper's prose, so
// the warning says "the next paragraph you add here re-cuts the document". A part at 173 bytes is
// already deep inside that band: a single sentence moves it.
export function headroomVerdict(headroom) {
  const tight = Math.min(...headroom);
  const at = headroom.indexOf(tight) + 1;
  return {
    tight, at,
    over: tight < 0,
    warn: tight >= 0 && tight < HEADROOM_WARN,
    message: tight < 0
      ? `part ${at} is ${-tight} B OVER the ${BUDGET} B budget`
      : tight < HEADROOM_WARN
        ? `part ${at} has ${tight} B of headroom — under ${HEADROOM_WARN} B, roughly a paragraph. Prose added to its sections re-cuts the document and moves what /paper/N serves.`
        : `tightest part ${at} with ${tight} B of headroom`,
  };
}
