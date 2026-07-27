// `/paper` is the URL every document, the agent card and the on-chain listing point at, and it served
// 395 kB of styled HTML. Two separate defects hid behind that, and only the first was obvious.
//
//   1. Most of the payload was markup, so a reader spent its budget on `<span>` wrappers.
//   2. Even after the markup was gone — 241 kB of clean markdown — a real fetch STILL truncated, at
//      about 40%, mid-sentence in 5.19, and reported the References and all three appendices as
//      missing. That was measured against the deployed service, not reasoned about.
//
// The budget belongs to the reader, so the fix is that the document ARRIVES in parts that fit, each
// opening with the map of all parts — served at /paper/1 … /paper/6, beside the typeset edition
// rather than in place of it. These tests fail against the HTML-only service, which offered no
// machine edition at all and let a reader silently receive a fraction of the argument.
import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { perpGate } from '../src/engine/perpGate.js';
import { proofEnvelope } from '../src/engine/proof.js';

// Exactly the inputs Appendix C prints, so the expected hash is derived rather than pasted.
const perpGateExhibit = () => proofEnvelope('perp-gate',
  { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 },
  perpGate({ side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 }), '0');

async function get(path) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text(), h: res.headers };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const PART_COUNT = 6;
// Strip the navigation header and the continues-in footer, leaving only document text.
function core(part) {
  const navEnd = part.indexOf('\n---\n\n');
  const body = part.slice(navEnd + '\n---\n\n'.length);
  const tailAt = body.lastIndexOf('\n\n---\n\n**');
  return (tailAt >= 0 ? body.slice(0, tailAt) : body).trim();
}
const norm = (s) => s.replace(/\r/g, '').replace(/\n{2,}/g, '\n').replace(/[ \t]+/g, ' ').trim();

test('/paper keeps its original meaning: the typeset edition, for a person', async () => {
  // It was briefly the machine edition. That broke every consumer expecting the whole document from
  // the canonical URL — this project's own release gate first among them, which is how the cost
  // showed up. The machine edition lives beside it instead, and /paper announces it two ways so an
  // automated reader that lands here blind can still find it before its budget runs out.
  const r = await get('/paper');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/, '/paper is the human edition');
  assert.match(r.body, /<html/i);
  assert.equal(r.h.get('x-paper-machine-edition'), '/paper/1');
  assert.equal(r.h.get('x-paper-parts'), String(PART_COUNT));

  // Three carriers, asserted separately, because an earlier version of this test checked only that
  // "/paper/6" appeared somewhere in the opening bytes — and it passed on the <meta> alone while the
  // visible note had been deleted by a bad edit. A check that can be satisfied by any one of the
  // things it is meant to guarantee does not guarantee any of them.
  assert.match(r.body.slice(0, 600), /machine-readable-edition/,
    'a <meta> in the head, which survives even a very short read');
  assert.match(r.body, /Reading this with an automated tool/,
    'a VISIBLE note — HTML comments and meta tags are routinely dropped by markdown-converting fetchers');
  assert.match(r.body, /machine-note/, 'and the note must carry its class, which hides it in print');
  for (let i = 1; i <= PART_COUNT; i++) {
    assert.ok(r.body.includes(`/paper/${i}`), `the note must name /paper/${i}`);
  }
  assert.match(r.body, /<body>/, 'the document must actually have a body tag');
});

test('a part fits, and says so in its first characters', async () => {
  const r = await get('/paper/1');
  // A reader whose fetch is cut off still receives the opening. The map must therefore be at the TOP,
  // not the bottom — putting it at the end would tell only the readers who did not need telling.
  const opening = r.body.slice(0, 1400);
  assert.match(opening, /part 1 of 6/, 'the part number and total must be in the opening bytes');
  assert.match(opening, /\/paper\/6/, 'the map of every part must be in the opening bytes');
  assert.match(opening, /Nothing is abridged/i);
  assert.ok(Buffer.byteLength(r.body) < 60_000,
    `a part must fit inside a single fetch (got ${Buffer.byteLength(r.body)} bytes)`);
});

test('every part is reachable, is markdown, and fits', async () => {
  for (let i = 1; i <= PART_COUNT; i++) {
    const r = await get(`/paper/${i}`);
    assert.equal(r.status, 200, `/paper/${i} must exist`);
    assert.match(r.type, /text\/markdown/);
    assert.equal(r.h.get('x-paper-part'), String(i));
    assert.ok(Buffer.byteLength(r.body) < 60_000, `/paper/${i} is too big to be fetched whole`);
    assert.match(r.body.slice(0, 1400), new RegExp(`part ${i} of ${PART_COUNT}`));
  }
});

test('THE PARTS CONCATENATE TO THE WHOLE — nothing is abridged', async () => {
  // This is the claim the header makes to every reader, so it is the one that must be mechanical.
  // Without it, "split for readability" is indistinguishable from "quietly shortened".
  // /paper/full carries the whole-edition header; the parts carry their own navigation instead. Strip
  // both wrappers and compare the document text itself.
  const full = core((await get('/paper/full')).body + '\n\n---\n\n**end**\n');
  const parts = [];
  for (let i = 1; i <= PART_COUNT; i++) parts.push(core((await get(`/paper/${i}`)).body));
  assert.equal(norm(parts.join('\n')), norm(full),
    'the concatenated parts must be equivalent to the whole document');
});

test('the whole document is still complete and still served', async () => {
  const md = (await get('/paper/full')).body;
  assert.match(md, /^73\. /m, 'the last reference must be present');
  assert.match(md, /## References/);
  assert.match(md, /## 12\. Conclusion/);
  assert.match(md, /## Appendix C/);
  // Read the constant off the system, not off a document. An earlier version of this line hardcoded
  // the content hash, so the first time the build moved it failed for the wrong reason — it reported
  // "the machine edition is incomplete" when the edition was fine and the literal was stale.
  const { proof } = perpGateExhibit();
  assert.ok(md.includes(proof.contentHash),
    "Appendix C's content hash must survive into the edition a machine actually reads");
  assert.equal((md.match(/^\| --- \|/gm) || []).length, 11, 'all 11 tables must survive');
});

test('the tail of the document is reachable in one fetch, which is what failed before', async () => {
  // The measured failure was that References and the appendices never arrived. Whatever the split,
  // the END of the document must be fetchable on its own.
  const last = (await get(`/paper/${PART_COUNT}`)).body;
  assert.match(last, /^73\. /m, 'the final part must carry the bibliography');
  assert.match(last, /End of the document/);
});

test('a bad part number teaches instead of merely refusing', async () => {
  const r = await get('/paper/99');
  assert.equal(r.status, 404);
  const j = JSON.parse(r.body);
  assert.match(j.note, /\/paper\/1/, 'the refusal must name the range that does exist');
  assert.equal(j.whole, '/paper/full');
  assert.equal(j.typeset, '/paper');
});

test('the section numbers the prose depends on are reconstructed', async () => {
  const md = (await get('/paper/full')).body;
  assert.match(md, /^## 8\. Limitations/m);
  assert.match(md, /^### 5\.19 /m);
  assert.match(md, /^### 11\.4 /m);
});

test('no HTML entities leak through as literal text', async () => {
  const md = (await get('/paper/full')).body;
  const leaked = [...new Set((md.match(/&[a-zA-Z][a-zA-Z0-9]*;/g) || []))];
  assert.deepEqual(leaked, [], `unconverted entities read as noise: ${leaked.join(' ')}`);
});
