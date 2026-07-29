// Gate Y revert — put each defect back and require the checks to go red on it BY NAME.
//
// A check nobody has watched fail is a decoration. Both checks repaired here guard artifacts that
// may not be edited to demonstrate anything — `assets/whitepaper.html` and the generated
// `whitepaper.part*.md` are the paper — so every defect below is reinstated IN MEMORY against the
// real inputs, which is why `gates/paper-integrity.mjs` takes its inputs as arguments and reads
// nothing itself.
//
// Two directions matter for the parity check and only one of them is obvious. It must BLOCK an
// undocumented difference — and it must PASS a documented one, because the defect being repaired was
// a check that could not go green while a legitimate correction was pending. A revert that only
// proved the first would have re-certified the deadlock.
//
//   node gates/gateY-revert.mjs        (npm run gate:y-revert)
import {
  assessPaperParity, assessPaperMapping, packSections, titleOf, rebuildPartFile, sha256,
} from './paper-integrity.mjs';
import { readMappingInputs, readPendingDeploy, readChangelog, readParts } from './paper-inputs.mjs';

const LIVE = process.env.QUIVER_LIVE || 'https://quiver-production-c3a8.up.railway.app';

const results = [];
const clone = (o) => JSON.parse(JSON.stringify(o));
function scenario(name, expect, run) {
  let outcome;
  try { outcome = run(); } catch (e) { outcome = { ok: false, note: `threw: ${e.message}` }; }
  const ok = outcome.ok;
  results.push({ name, expect, ok, note: outcome.note });
  console.log(`  ${ok ? ' OK   ' : 'FAILED'}  ${name.padEnd(22)} expected to ${expect.padEnd(5)} — ${outcome.note}`);
  return ok;
}

// ══ live inputs for the parity scenarios ════════════════════════════════════════════════════════
console.log(`gate Y revert — ${new Date().toISOString()}\n  live ${LIVE}\n`);
const realParts = readParts();
for (const p of realParts) {
  try { p.live = await (await fetch(`${LIVE}/paper/${p.n}`)).text(); } catch { p.live = null; }
}
const changelogRepo = readChangelog();
const changelogLive = await (async () => { try { return await (await fetch(`${LIVE}/changelog`)).text(); } catch { return null; } })();
if (!realParts.length || realParts.some((p) => p.live == null) || changelogLive == null) {
  console.error('\nFAILED — could not read the live paper or changelog. This revert proves nothing without it.');
  process.exit(1);
}
const manifest = readPendingDeploy();
const base = () => ({ parts: clone(realParts), manifest: clone(manifest), changelogRepo, changelogLive });
const parity = (o) => assessPaperParity(o);
const blocked = (r, needle) => !r.pass && r.blocking.some((b) => b.includes(needle));

// Edit a part's paper text without touching its navigation header.
const editBody = (text, replacement) => {
  const i = text.indexOf('\n---\n\n') + '\n---\n\n'.length;
  return text.slice(0, i) + replacement + text.slice(i);
};

console.log('DEFECT 1 — preflight check 5: repo-vs-live parity\n');

scenario('DELIBERATE', 'pass', () => {
  const r = parity(base());
  return { ok: r.pass, note: r.pass ? 'the real pending paper change is declared and documented, and the check is GREEN — the deadlock is gone' : `still blocked: ${r.blocking.join('; ')}` };
});

scenario('POST-DEPLOY', 'pass', () => {
  // The state a deploy restores. A check that is red in both states is broken in a different way.
  const o = base();
  for (const p of o.parts) p.live = p.repo;
  const r = parity(o);
  return { ok: r.pass, note: r.pass ? 'repo == live for every part and nothing is demanded of the manifest' : `red after a hypothetical deploy: ${r.blocking.join('; ')}` };
});

scenario('UNDECLARED', 'block', () => {
  // The defect the old check existed to catch: a part's text moved and nothing accounts for it.
  const o = base();
  const p = o.parts.find((x) => x.n === 2);
  p.repo = editBody(p.repo, 'An unaccounted sentence nobody wrote down.\n\n');
  const r = parity(o);
  return { ok: blocked(r, 'part 2 differs from live in the paper text') && blocked(r, 'NOT declared'), note: r.pass ? 'PASSED an undocumented change — the guard is gone' : r.blocking.find((b) => b.includes('part 2')) || r.blocking[0] };
});

scenario('HASH-DRIFT', 'block', () => {
  // The accident a prose-only rule cannot see: a SECOND edit to a part that was already approved.
  const o = base();
  const p = o.parts.find((x) => x.n === 4);
  p.repo = editBody(p.repo, 'A second edit, after the first was approved.\n\n');
  const r = parity(o);
  return { ok: blocked(r, 'the manifest declares part 4'), note: r.pass ? 'PASSED a second edit riding on the first approval' : r.blocking.find((b) => b.includes('part 4')) || r.blocking[0] };
});

scenario('ALREADY-SHIPPED', 'block', () => {
  // The paperwork exists but is not NEW: the entry is already on live, so it documents nothing about
  // an unshipped change. This is the half of the rule that keeps it from degenerating into "some
  // changelog exists".
  const o = base();
  o.changelogLive = changelogRepo;
  const r = parity(o);
  return { ok: blocked(r, 'ALREADY live'), note: r.pass ? 'accepted an entry that had already shipped' : r.blocking[0] };
});

scenario('ECHO-ONLY', 'block', () => {
  // Every part's size line moved and no part's text did. The served bytes changed for a reason
  // nothing in the tree explains — and this is exactly the shape the naive "ignore the header" fix
  // would have waved through.
  const o = base();
  for (const p of o.parts) {
    p.live = p.repo.replace(/> Whole document in one response \((\d+) kB/, (m, n) => m.replace(n, String(Number(n) - 1)));
    if (p.live === p.repo) return { ok: false, note: 'could not synthesise the size-line echo' };
  }
  const r = parity(o);
  return { ok: blocked(r, 'the served bytes moved and nothing in this tree explains it'), note: r.pass ? 'accepted a size change with no source' : r.blocking[0] };
});

scenario('NAV-MAP-MOVED', 'block', () => {
  // The navigation header carries the part MAP as well as the size. Only the size line is an echo;
  // a changed map line is a section moving between parts and must never be exempted.
  const o = base();
  const p = o.parts.find((x) => x.n === 3);
  p.live = p.repo.replace('- **Part 4** —', '- **Part 4 (moved)** —');
  if (p.live === p.repo) return { ok: false, note: 'could not synthesise a map-line change' };
  const r = parity(o);
  return { ok: blocked(r, 'navigation header differs beyond the document-size echo'), note: r.pass ? 'treated a moved part map as a harmless header echo' : r.blocking[0] };
});

scenario('UNREACHABLE', 'block', () => {
  const o = base();
  o.parts.find((x) => x.n === 5).live = null;
  const r = parity(o);
  return { ok: blocked(r, 'live did not answer'), note: r.pass ? 'a part that could not be fetched was counted as matching' : r.blocking[0] };
});

// ══ mapping scenarios ═══════════════════════════════════════════════════════════════════════════
console.log('\nDEFECT 2 — gate Y: the published section-to-part mapping\n');

const IN = readMappingInputs();
const mapping = (o) => assessPaperMapping(o);
const rule = (r, name, needle) => r.findings.some((f) => f.rule === name && (!needle || f.msg.includes(needle)));
const mbase = () => ({ ...IN, contract: clone(IN.contract), partsJson: clone(IN.partsJson), onDisk: IN.onDisk.map((x) => ({ ...x })), publications: IN.publications.map((x) => ({ ...x })) });

scenario('RESTORED', 'pass', () => {
  const r = mapping(mbase());
  return { ok: r.findings.length === 0, note: r.findings.length ? r.findings.map((f) => `${f.rule}: ${f.msg}`).join(' | ') : `all four records agree across ${r.checkedSites} publication sites` };
});

scenario('BOUNDARY-MOVE', 'block', () => {
  // THE defect. 465 bytes into §6, regenerated exactly as an author would — so parts.json, the part
  // files and the part COUNT are all consistent with the new packing and every count-based check in
  // the repository stays green. Only the committed mapping notices.
  const o = mbase();
  const filler = `\n${'Measured filler that is not in the paper. '.repeat(11)}\n`;
  if (Buffer.byteLength(filler, 'utf8') < 400) return { ok: false, note: 'filler too small to move the boundary' };
  const at = o.md.indexOf('\n## 6. Verification and Testing');
  if (at < 0) return { ok: false, note: 'could not find §6 in assets/whitepaper.md' };
  const cut = o.md.indexOf('\n', at + 1);
  o.md = o.md.slice(0, cut) + filler + o.md.slice(cut);
  const parts = packSections(o.md);
  o.onDisk = parts.map((p, i) => ({ n: i + 1, text: rebuildPartFile(o.md, parts, i) }));
  o.partsJson = { count: parts.length, titles: parts.map(titleOf) };
  const r = mapping(o);
  // What every PRE-EXISTING check in this repository sees after that regeneration. Each compares one
  // generated artifact to another, and a boundary move rewrites both sides at once, so all of them
  // stay green. This is the gap, stated as a measurement rather than as a claim.
  const blind = {
    'part count is still 7': parts.length === IN.contract.parts.length,
    'whitepaper.parts.json still matches the packing': parts.map(titleOf).every((t, i) => o.partsJson.titles[i] === t),
    'gate Y: the part files are still what the splitter would write': !rule(r, 'ON-DISK'),
    'gate Y: the source and the markdown edition still agree': !rule(r, 'SOURCE'),
  };
  const allBlind = Object.values(blind).every(Boolean);
  const caught = rule(r, 'MAPPING', '8. Limitations and Honest Disclosures');
  const anchored = [...new Set(r.findings.map((f) => f.rule))].sort().join(', ');
  return {
    ok: caught && allBlind,
    note: caught && allBlind
      ? `+${Buffer.byteLength(filler, 'utf8')} B into §6 moved §8 Limitations from part 4 to part 5. `
        + `Every count-based / generated-vs-generated check stays GREEN (${Object.keys(blind).join('; ')}). `
        + `Only the rules anchored to the committed mapping fire [${anchored}]: `
        + r.findings.filter((f) => f.rule === 'MAPPING').map((f) => f.msg).join(' ; ')
      : `count ${parts.length}, blind=${JSON.stringify(blind)}, findings ${anchored || 'none'} — the move was NOT caught as expected`,
  };
});

scenario('SIX-PART-INDEX', 'block', () => {
  // The real defect, reproduced: assets/landing.html enumerated six parts while seven were served,
  // and told a judge to read part 6 for the checkable artifacts, which are in part 7.
  const o = mbase();
  const pub = o.publications.find((p) => p.file === 'assets/landing.html');
  if (!pub?.present) return { ok: false, note: 'assets/landing.html not readable' };
  pub.text = pub.text.replace(/\n *<li><span><a href="\/paper\/7">[\s\S]*?<\/li>/, '').replace(/href="\/paper\/7">part 7<\/a>/, 'href="/paper/6">part 6</a>');
  if (pub.text.includes('/paper/7')) return { ok: false, note: 'could not remove the part 7 entry' };
  const r = mapping(o);
  return { ok: rule(r, 'PUBLISHED', 'never references part 7'), note: r.findings.filter((f) => f.rule === 'PUBLISHED').map((f) => f.msg).join(' ; ') || 'not caught' };
});

scenario('SUBMISSION-PROSE', 'block', () => {
  // The published description drifting away from the packing, rather than the other way round.
  const o = mbase();
  const pub = o.publications.find((p) => p.file === 'hackathon/QUIVER_SUBMISSION.md');
  if (!pub?.present) return { ok: false, note: 'hackathon/QUIVER_SUBMISSION.md not readable' };
  pub.text = pub.text.replace('/paper/4 — verification, walkthrough, limitations', '/paper/4 — verification and the walkthrough');
  const r = mapping(o);
  return { ok: rule(r, 'PUBLISHED', 'committed description of part 4'), note: r.findings.filter((f) => f.rule === 'PUBLISHED').map((f) => f.msg).join(' ; ') || 'not caught' };
});

scenario('HAND-EDIT', 'block', () => {
  // The parts are generated. A hand edit disagrees with the source until the next regeneration
  // silently discards it — the UNREGEN trap in its other direction.
  const o = mbase();
  const p = o.onDisk.find((x) => x.n === 4);
  p.text = p.text.replace('## 7. Worked Walkthrough', '## 7. Worked Walkthrough (edited by hand)');
  const r = mapping(o);
  return { ok: rule(r, 'ON-DISK', 'whitepaper.part4.md'), note: r.findings.filter((f) => f.rule === 'ON-DISK').map((f) => f.msg).join(' ; ') || 'not caught' };
});

scenario('PARTS-JSON-STALE', 'block', () => {
  const o = mbase();
  o.partsJson.titles[4] = '8. Limitations and Honest Disclosures  |  9. Related Work and Positioning';
  const r = mapping(o);
  return { ok: rule(r, 'PARTS-JSON', 'part 5'), note: r.findings.filter((f) => f.rule === 'PARTS-JSON').map((f) => f.msg).join(' ; ') || 'not caught' };
});

scenario('SOURCE-DRIFT', 'block', () => {
  // A section added to the HTML without regenerating the markdown edition — the change most likely
  // to move a boundary, and invisible to everything that reads only the generated files.
  const o = mbase();
  o.html = o.html.replace('</body>', '<h2>13. A Section Added Without Regenerating</h2></body>');
  if (o.html === IN.html) return { ok: false, note: 'could not inject a heading' };
  const r = mapping(o);
  return { ok: rule(r, 'SOURCE'), note: r.findings.filter((f) => f.rule === 'SOURCE').map((f) => f.msg).join(' ; ') || 'not caught' };
});

scenario('BUDGET-DRIFT', 'block', () => {
  const o = mbase();
  o.generatorSource = o.generatorSource.replace('BUDGET = 55_000', 'BUDGET = 60_000');
  const r = mapping(o);
  return { ok: rule(r, 'BUDGET'), note: r.findings.filter((f) => f.rule === 'BUDGET').map((f) => f.msg).join(' ; ') || 'not caught' };
});

scenario('RESTORED-AGAIN', 'pass', () => {
  // Red in both states is a broken gate. Re-run the untouched inputs after every mutation above.
  const r = mapping(mbase());
  const p = parity(base());
  return { ok: r.findings.length === 0 && p.pass, note: r.findings.length === 0 && p.pass ? 'both checks green again on the untouched tree' : 'still red after restoring' };
});

// ══ verdict ═════════════════════════════════════════════════════════════════════════════════════
const failed = results.filter((r) => !r.ok);
const blocks = results.filter((r) => r.expect === 'block');
const passes = results.filter((r) => r.expect === 'pass');
console.log(`\n${'='.repeat(76)}`);
console.log(`  ${blocks.filter((r) => r.ok).length}/${blocks.length} defects were BLOCKED by name`);
console.log(`  ${passes.filter((r) => r.ok).length}/${passes.length} legitimate states were ALLOWED through`);
if (failed.length) {
  console.log('\nFAILED — a check that cannot fail, or cannot pass, proves nothing:');
  for (const f of failed) console.log(`  · ${f.name} (expected to ${f.expect}) — ${f.note}`);
  process.exit(1);
}
console.log('\nPASSED — every defect was caught by name, every legitimate state was allowed, and both');
console.log('        checks are green once restored.');
console.log(`        sha256 of the declared parts still matches the tree: ${Object.keys(manifest.parts).map((k) => `${k}=${sha256(realParts.find((p) => String(p.n) === k).repo).slice(0, 8)}`).join(' ')}`);
