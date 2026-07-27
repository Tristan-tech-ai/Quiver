// Build the machine-readable edition of the paper.
//
// Why this exists: the paper is a 400 kB styled HTML document, and an AI reader that fetches a URL
// gets a fixed budget of characters. More than half of that budget was being spent on markup —
// `<span class="mono">`, table scaffolding, inline SVG path data — so the fetch truncated partway
// through and the reader silently formed its view of Quiver from the first third of the argument.
// That is a documentation defect with the same shape as a stale hash: the artifact is correct and the
// consumer still ends up misinformed.
//
// So `/paper` serves THIS, and the styled edition moves to `/paper/human`. Nothing is summarised or
// dropped: every section, table, code block and reference survives, in document order. The four
// figures are vector charts whose meaning lives in their captions, so each becomes a labelled
// placeholder pointing at the human edition rather than thousands of characters of path geometry.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'whitepaper.html');
const OUT = join(ROOT, 'assets', 'whitepaper.md');

const ENTITIES = {
  nbsp: ' ', mdash: '—', ndash: '–', minus: '−', times: '×', middot: '·', hellip: '…',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", amp: '&', lt: '<', gt: '>', quot: '"',
  thinsp: ' ', sigma: 'σ', Sigma: 'Σ', lambda: 'λ', alpha: 'α', mu: 'μ', rho: 'ρ', delta: 'δ',
  gamma: 'γ', Delta: 'Δ', Phi: 'Φ', radic: '√', isin: '∈', sim: '~', rarr: '→', asymp: '≈',
  ge: '≥', le: '≤', plusmn: '±', prime: '′', sup2: '²', ouml: 'ö', egrave: 'è', deg: '°',
};
const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));

// Inline markup only — block structure is handled by the walker below.
function inline(html) {
  return decode(
    html
      .replace(/<sup class="cite">([\s\S]*?)<\/sup>/g, (_, c) => ' ' + c.replace(/<[^>]+>/g, '').trim())
      .replace(/<sub>([\s\S]*?)<\/sub>/g, '_$1')
      .replace(/<sup>([\s\S]*?)<\/sup>/g, '^$1')
      .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, t) => {
        const text = t.replace(/<[^>]+>/g, '').trim();
        return href.startsWith('#') ? text : `[${text}](${href})`;
      })
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, '**$2**')
      .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
      .replace(/<span class="mono">([\s\S]*?)<\/span>/g, '`$1`')
      // A tag name must start with a letter. `<[^>]+>` does not know that, so in the x402 sequence
      // diagram it matched from the `<` of `|<-------|` across two newlines to the `>` of `------->`
      // and deleted two whole lines of the diagram. Browsers treat `<` followed by a non-letter as
      // literal text; match that behaviour instead of being stricter than the renderer.
      .replace(/<\/?[a-zA-Z][^>]*>/g, ''),
  ).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

const html = readFileSync(SRC, 'utf8');

// Drop what carries no information for a reader: styling, scripts, and the decorative title page.
let body = html
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<head[\s\S]*?<\/head>/g, '');

// The HTML edition carries a visible note telling automated readers that this machine edition exists.
// Repeating it inside the machine edition is noise: every part already opens with the full part map.
body = body.replace(/<div class="machine-note">[\s\S]*?<\/div>/, '');

// Figures are vector charts. Their argument is in the caption; their bytes are not readable prose.
body = body.replace(/<figure\b[\s\S]*?<\/figure>/g, (fig) => {
  const cap = (fig.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/) || [, ''])[1];
  return `\n<p>[FIGURE — rendered in the human edition at /paper/human] ${cap}</p>\n`;
});
body = body.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/g, '\n<p>[FIGURE — $1 — rendered at /paper/human]</p>\n');
body = body.replace(/<svg[\s\S]*?<\/svg>/g, '');

function renderTable(tbl) {
  const cap = (tbl.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/) || [, ''])[1];
  const rows = [...tbl.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/g)].map((c) => inline(c[2]).replace(/\n/g, ' ').replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => { const x = r.slice(); while (x.length < width) x.push(''); return x; };
  const out = [];
  if (cap) out.push(`**${inline(cap)}**`, '');
  // A header separator is only meaningful when the first row really is a header row.
  const headed = /<th\b/.test(rows.length ? tbl.slice(0, tbl.indexOf('</tr>')) : '');
  out.push('| ' + pad(rows[0]).join(' | ') + ' |');
  out.push('|' + ' --- |'.repeat(width));
  for (const r of rows.slice(1)) out.push('| ' + pad(r).join(' | ') + ' |');
  if (!headed) out.splice(cap ? 2 : 0, 0, '(first row is data, not a header)');
  return out.join('\n');
}

// Walk the document in order so nothing is reordered or lost.
const BLOCK = /<(h[1-6]|p|li|pre|table|caption|div|ol|ul)\b([^>]*)>([\s\S]*?)<\/\1>/g;
const chunks = [];
let m;
let sec = 0, sub = 0, subsub = 0;   // mirrors body{counter-reset:sec} / h2{sec} / h3{sub} / h4{subsub}
// Tables and lists are consumed whole, so track how far we have emitted to avoid double-emitting
// their inner <p>/<li> children.
let consumedTo = 0;
while ((m = BLOCK.exec(body)) !== null) {
  if (m.index < consumedTo) continue;
  const [full, tag, attrs, innerRaw] = m;
  const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];

  if (tag === 'table') {
    chunks.push(renderTable(full));
    consumedTo = m.index + full.length;
    continue;
  }
  if (tag === 'pre') {
    // Same lesson as in inline(): these blocks are ASCII sequence diagrams full of `<--` and `-->`.
    chunks.push('```\n' + decode(innerRaw.replace(/<\/?[a-zA-Z][^>]*>/g, '')).replace(/\s+$/, '') + '\n```');
    consumedTo = m.index + full.length;
    continue;
  }
  if (tag === 'ol' || tag === 'ul') {
    const items = [...innerRaw.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((x) => inline(x[1]));
    const isRefs = cls.includes('refs') || /class="refs"/.test(body.slice(Math.max(0, m.index - 200), m.index));
    chunks.push(items.map((t, i) => (tag === 'ol' ? `${i + 1}. ` : '- ') + t.replace(/\n+/g, ' ')).join('\n'));
    if (isRefs) { /* numbering already matches the citation markers */ }
    consumedTo = m.index + full.length;
    continue;
  }
  if (tag === 'div') {
    // A container carries no text of its own, but `exec` has already advanced past its ENTIRE body —
    // so simply continuing here silently swallows every child. That is how the first run of this
    // script dropped 141 list items and the whole References section while reporting a healthy-looking
    // "46% smaller". Rewind to just after the opening tag so the children are matched normally.
    BLOCK.lastIndex = m.index + full.indexOf('>') + 1;
    continue;
  }
  if (tag === 'caption') continue;       // emitted with its table

  const text = inline(innerRaw);
  if (!text) continue;
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    // The section numbers exist only as CSS counters, so they are absent from the HTML text — and the
    // prose leans on them constantly ("Section 5.19 states plainly", "§11.4 item 6"). Stripped of the
    // numbers, every one of those cross-references becomes unresolvable for exactly the reader this
    // edition is for. So reproduce the stylesheet's own counter rules here.
    const unnumbered = /\bnonum\b/.test(cls) || /counter-increment\s*:\s*none/.test(attrs);
    let prefix = '';
    if (level === 2) { sub = 0; if (!unnumbered) { sec += 1; prefix = `${sec}. `; } }
    else if (level === 3) { subsub = 0; if (!unnumbered) { sub += 1; prefix = `${sec}.${sub} `; } }
    else if (level === 4) { if (!unnumbered) { subsub += 1; prefix = `${sec}.${sub}.${subsub} `; } }
    chunks.push('\n' + '#'.repeat(Math.min(6, level)) + ' ' + prefix + text.replace(/\n+/g, ' '));
  } else if (tag === 'li') {
    chunks.push('- ' + text.replace(/\n+/g, ' '));
  } else {
    chunks.push(text);
  }
}

const HEADER = `# Quiver — Technical Documentation

> **This is the machine-readable edition, served complete and unabridged at \`/paper\`.**
> The typeset edition with figures is at \`/paper/human\`; the PDF is linked from the repository.
> Nothing here is summarised: every section, table, code block and reference of the full document is
> present, in order. The four figures are vector charts and appear as labelled placeholders, because
> their argument is carried by their captions and their geometry is not readable prose.
>
> Live service: https://quiver-production-c3a8.up.railway.app
> Source: https://github.com/Tristan-tech-ai/Quiver
> Build identity and its hashing rule: \`/build\`

---

`;

const md = HEADER + chunks.join('\n\n').replace(/\n{4,}/g, '\n\n\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
writeFileSync(OUT, md, 'utf8');

// ── Split into fetchable parts ──────────────────────────────────────────────────────────────────
// Dropping the markup took 395 kB to 241 kB, and that was still not enough: fetched live, an AI
// reader stopped mid-sentence in 5.19, about 40% in, and reported the References and all three
// appendices as missing. The budget is a property of the reader, not of our formatting, so no amount
// of tightening fixes it — the document has to arrive in pieces that fit.
//
// Nothing is abridged or summarised. The text is cut only at top-level section boundaries, and every
// part opens with the full map of all parts, so a reader whose fetch truncates ANYWHERE has already
// received the URLs for the rest in its first few hundred characters.
const BUDGET = 55_000;   // comfortably inside what a single fetch delivered in testing
// Split the BODY, not the whole file: each part gets its own navigation header, and the
// whole-edition header would otherwise print twice at the top of part 1 while saying something
// untrue there — "served complete and unabridged at /paper" is a claim only /paper/full can make.
const BODY_MD = md.slice(md.indexOf('\n---\n\n') + '\n---\n\n'.length);
const sections = [];
{
  const lines = BODY_MD.split('\n');
  let cur = [];
  for (const line of lines) {
    if (/^## /.test(line) && cur.length) { sections.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) sections.push(cur.join('\n'));
}
const parts = [];
for (const s of sections) {
  const last = parts[parts.length - 1];
  if (last && Buffer.byteLength(last + s, 'utf8') <= BUDGET) parts[parts.length - 1] = last + '\n' + s;
  else parts.push(s);
}
// Name EVERY top-level section a part contains, not just its first. Listing only the first heading
// made part 4 read as "Verification and Testing" when it also carries the Worked Walkthrough,
// Limitations and Related Work — so a reader looking for the limitations had no reason to fetch it.
// The map is the only navigation a truncated reader gets; it has to be honest about what is where.
const titleOf = (p) => {
  const hs = [...p.matchAll(/^## (.+)$/gm)].map((x) => x[1].replace(/\s+/g, ' ').trim());
  // Not '·' — that character is already inside the appendix headings ("Appendix A · API Reference"),
  // so joining with it makes part 6 read as seven entries instead of four.
  return hs.length ? hs.join('  |  ') : 'Front matter';
};
const map = parts.map((p, i) => `- **Part ${i + 1}** — \`/paper/${i + 1}\` — ${titleOf(p)}`).join('\n');

parts.forEach((p, i) => {
  const nav = `# Quiver — Technical Documentation — part ${i + 1} of ${parts.length}

> The complete document, split only because a single fetch truncates. **Nothing is abridged**: the
> parts below concatenate to the whole text, cut at section boundaries. Every part is served as plain
> markdown.
>
${map.split('\n').map((l) => '> ' + l).join('\n')}
>
> Whole document in one response (${Math.round(Buffer.byteLength(md, 'utf8') / 1024)} kB, may truncate in your client): \`/paper/full\`
> Typeset edition with figures: \`/paper/human\`
> Live service: https://quiver-production-c3a8.up.railway.app · Source: https://github.com/Tristan-tech-ai/Quiver

---

`;
  const tail = i + 1 < parts.length
    ? `\n\n---\n\n**Continues in part ${i + 2} of ${parts.length}: \`/paper/${i + 2}\` — ${titleOf(parts[i + 1])}**\n`
    : `\n\n---\n\n**End of the document.** Part ${i + 1} of ${parts.length} was the last.\n`;
  writeFileSync(join(ROOT, 'assets', `whitepaper.part${i + 1}.md`), nav + p.trim() + tail, 'utf8');
});
writeFileSync(join(ROOT, 'assets', 'whitepaper.parts.json'),
  JSON.stringify({ count: parts.length, titles: parts.map(titleOf) }, null, 2), 'utf8');
console.log(`  parts  ${parts.length} (budget ${BUDGET / 1000} kB each): ` +
  parts.map((p, i) => `${i + 1}=${Math.round(Buffer.byteLength(p, 'utf8') / 1024)}kB`).join(' '));

const bytes = Buffer.byteLength(md, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  html  ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(0)} kB`);
console.log(`  text  ${(bytes / 1024).toFixed(0)} kB  (${(100 - (bytes / Buffer.byteLength(html, 'utf8')) * 100).toFixed(0)}% smaller)`);
console.log(`  blocks ${chunks.length}, tables ${(md.match(/^\| --- \|/gm) || []).length}, code blocks ${(md.match(/^```$/gm) || []).length / 2}`);
