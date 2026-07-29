// GATE L — every response on both surfaces carries its own timing, and no content hash moved to get it.
//
// WHAT IT IS FOR. §2.3 of the paper says: "Every response carries an `elapsedMs` field so a caller can
// hold the service to its own timing." Measured on the live endpoint on 29 July 2026 that was false in
// the worst way an invitation can be false — the sentence names a field and tells a reader to hold the
// service to account with it, and a `perp_gate` response carried no such key. Swept across every
// service and every input form the catalogue accepts, the field was present on 8 of 31 HTTP response
// forms and on 0 of 15 MCP ones; all nine deterministic engines, the ones a caller most wants to time,
// carried none. This gate is the half that was missing: the claim, enumerated.
//
// WHY A SWEEP AND NOT A SAMPLE. "Every response" is a universal quantifier over a set nothing
// enumerated, which is the exact shape `hackathon/UNMEASURED_CLAIMS.md` catalogues as unfalsifiable.
// A sample of one service is how the claim survived being false on twenty-one of them. So the fixture
// set is asserted as an EQUALITY against `SERVICES`, the way gate M asserts its own against
// `tools/list`: a service added tomorrow with no fixture is a silent hole reading as a pass.
//
// WHY THE SECOND HALF IS THE HARDER ONE. `elapsedMs` is a NEW FIELD IN EVERY RESPONSE, and the content
// hash is taken over `{engine, codeHash, [observedAtUtc,] inputs, result}` where `result` is the
// engine's return value. The published recipe in `proof.verifyContentHash` then tells a caller to
// recompute over "this response WITHOUT its `proof` key". A field added at the TOP LEVEL therefore sits
// inside what the caller hashes and outside what the service hashed: the stored hash does not move, and
// every published proof silently stops reproducing — including the worked exhibit of Appendix C, which
// the paper invites a reader to re-derive offline. That is a worse outcome than the missing field.
//
// So this gate asserts the reverse property too, pinned to values measured BEFORE the field existed:
//
//   1. every service has a fixture, asserted as an equality against SERVICES
//   2. every response on the HTTP surface carries elapsedMs
//   3. every response on the free MCP surface carries elapsedMs
//   4. the field is in the provenance block, not bolted onto the top level of an enveloped answer
//   5. all 24 deterministic content hashes are byte-identical to their pre-change values
//   6. the Appendix C exhibit still reproduces 8575ce5a… on BOTH surfaces
//   7. the published recipe — recompute over the response minus its envelope — still reproduces, and
//      `elapsedMs` is never one of the keys that has to be removed to make it do so
//   8. the sweep actually reached the corpus it claims to cover
//
// NETWORK. Thirteen of the twenty-two services read live venues; that is what they are. A form whose
// run throws is reported by name as UNREACHED rather than passed over, and the count of them is
// asserted against a ceiling — an outage must not be able to shrink this gate's corpus quietly.
//
//   node --test gates/gateL-elapsed-timing.mjs      (npm run gate:l)
//   node gates/gateL-revert.mjs                     (npm run gate:l-revert)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SERVICES, byName } from '../src/services.js';
import { handleRpc, TOOLS } from '../src/mcp.js';
import { GENUINE } from './routing-fixtures.mjs';
import { elapsedMsOf } from '../src/util/timing.js';

// ── the pinned truth ─────────────────────────────────────────────────────────────────────────────
// Measured on 29 July 2026 by running every GENUINE fixture form through both surfaces BEFORE
// src/util/timing.js existed. These are the hashes the field must not have moved. They are written
// down rather than recomputed, because a hash compared against itself proves nothing.
const APPENDIX_C = '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960';
const PINNED_BEFORE = {
  'perp-gate#0':      '33bbc8c26aab051cca65f17958b5dbdec6264571e0164288924a8bdec9901205',
  'size-gate#0':      'e7442ce6867cec43d89402211a9f3df6153d3efd4c43021ddf7dfadb2b60e902',
  'size-gate#1':      'ba489cc51f9f918fc9e3e1a9e02ea79c1334b4b1c455f0f249acb9ab2748012d',
  'exec-verify#0':    '7be44a5186acc92502fcd975421c2a77e94d974c526da294cb5fd819fa497e25',
  'exec-verify#1':    '9091b9533045e6498f00f6649d6f4df9653da7affa11df63ed91a585ae5ba5be',
  'options-risk#0':   'dce40b64b4476d2e9c44cfaa905b8432ac9b45296cfdd156c4471fecfe0aab2f',
  'lp-risk#0':        'e65cd458168072c2874335a9a3c177714f228a535e75ff947ccc12c3bd6277ba',
  'lp-risk#1':        'c3997db9b86ea5beaedf1d3af41e73d3013020221c73fb2d270c122625e2f332',
  'treasury-risk#0':  '3d40bbc180e0d33f1d8bed2f60f968530c69bc9fd85da57c14bd0ffb0224ed08',
  'risk-attest#0':    '3797719ae2e2ce0bb3caca169df267a8eb1b6cf2e345e4a939c0065b8ed554e0',
  'risk-attest#1':    'f349595f1e4a4c39e92a687b03a94375bf96f8e4dee5b82a8b64dc9dd993e82c',
  'event-vol#0':      '8d653115a9c4e8752725a63288b283c5c10c25be2ee63b92b0e48f82ba09fd8a',
};

// Keys this host attaches AFTER the envelope is sealed, each with a call site that says so. They are
// outside the preimage by construction and are listed here so check 7 can tell them apart from a new
// one. `elapsedMs` is deliberately NOT on this list: if the stamp ever lands at the top level of an
// enveloped answer, check 7 must go red rather than wave it through as a known sibling.
const POST_ENVELOPE_SIBLINGS = ['inputRepairs', 'routingNotice', 'howToFix', 'snark'];

// The same canonicalisation src/engine/proof.js uses, restated here on purpose: a gate that imports
// the function under test cannot witness that function changing.
const canonical = (o) => (o === null || typeof o !== 'object'
  ? JSON.stringify(o) ?? 'null'
  : Array.isArray(o)
    ? '[' + o.map(canonical).join(',') + ']'
    : '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const envelopeKeyOf = (r) => (r?.proof?.contentHash ? 'proof' : r?.observation?.contentHash ? 'observation' : null);

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────
const rows = [];
for (const s of SERVICES) {
  for (const [form, body] of (GENUINE[s.name] || []).entries()) {
    const row = { surface: 'http', name: s.name, form, key: `${s.name}#${form}` };
    try {
      const v = s.validate({ ...body });
      if (v.error) row.unreached = `fixture refused by validate(): ${v.error}`;
      else row.response = await s.run(v, { host: 'http://gate' });
    } catch (e) { row.unreached = `threw: ${String(e.message || e).slice(0, 120)}`; }
    rows.push(row);
  }
}
for (const t of TOOLS) {
  const svcName = t.name.replace(/_/g, '-');
  for (const [form, body] of (GENUINE[svcName] || []).entries()) {
    const row = { surface: 'mcp', name: t.name, form, key: `${t.name}#${form}` };
    try {
      const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: { ...body } } });
      const text = r?.result?.content?.[0]?.text ?? '';
      try { row.response = JSON.parse(text); } catch { row.unreached = `unparseable body: ${text.slice(0, 100)}`; }
    } catch (e) { row.unreached = `threw: ${String(e.message || e).slice(0, 120)}`; }
    rows.push(row);
  }
}

const answered = rows.filter((r) => r.response && typeof r.response === 'object');
const unreached = rows.filter((r) => r.unreached);
const onSurface = (s) => answered.filter((r) => r.surface === s);

test('★ every service has a fixture here — asserted as an equality, not a containment', () => {
  const covered = Object.keys(GENUINE).sort();
  const listed = SERVICES.map((s) => s.name).sort();
  assert.deepEqual(covered, listed,
    `missing [${listed.filter((n) => !covered.includes(n))}], stale [${covered.filter((n) => !listed.includes(n))}]`);
  console.log(`    ${listed.length} services, ${rows.length} response forms across both surfaces`);
});

for (const surface of ['http', 'mcp']) {
  test(`★ every response on the ${surface === 'http' ? 'paid HTTP' : 'free MCP'} surface carries elapsedMs`, () => {
    const missing = onSurface(surface).filter((r) => {
      // Two independent reads: the shared locator the server writes through, and a raw structural
      // check that does not trust it. A revert that neuters the locator must still go red.
      const viaHelper = elapsedMsOf(r.response);
      const env = envelopeKeyOf(r.response);
      const raw = env ? r.response[env].elapsedMs : r.response.elapsedMs;
      return typeof viaHelper !== 'number' || typeof raw !== 'number';
    });
    console.log(`    ${onSurface(surface).length - missing.length}/${onSurface(surface).length} ${surface} responses carry elapsedMs`);
    assert.equal(missing.length, 0,
      `${missing.length} ${surface} response(s) carry no elapsedMs — the paper tells a caller to hold the service to its own timing with this field:\n      ${missing.map((r) => r.key).join('\n      ')}`);
  });
}

test('★ the field is in the provenance block, never bolted onto the top level of an enveloped answer', () => {
  const bad = [];
  for (const r of answered) {
    const env = envelopeKeyOf(r.response);
    if (!env) continue;                       // a refusal computes nothing and has no preimage to disturb
    if (typeof r.response[env].elapsedMs !== 'number') bad.push(`${r.key}: no ${env}.elapsedMs`);
  }
  console.log(`    ${answered.filter((r) => envelopeKeyOf(r.response)).length} enveloped answers checked`);
  assert.equal(bad.length, 0, `a timing is provenance of the call, not part of the computation:\n      ${bad.join('\n      ')}`);
});

test('★ not one deterministic content hash moved — pinned to the values measured before the field existed', () => {
  const moved = [];
  let checked = 0;
  for (const r of answered) {
    const pinned = PINNED_BEFORE[`${r.name.replace(/_/g, '-')}#${r.form}`];
    if (!pinned || !r.response.proof) continue;
    checked += 1;
    if (r.response.proof.contentHash !== pinned) moved.push(`${r.surface} ${r.key}: ${pinned} -> ${r.response.proof.contentHash}`);
  }
  console.log(`    ${checked} pinned deterministic content hashes re-measured on both surfaces`);
  // A pin list that stopped matching any response would make this check unfailable.
  assert.equal(checked, Object.keys(PINNED_BEFORE).length * 2,
    `expected ${Object.keys(PINNED_BEFORE).length} pins on each of two surfaces, matched ${checked}`);
  assert.equal(moved.length, 0, `a published proof stops reproducing:\n      ${moved.join('\n      ')}`);
});

test('★ the Appendix C exhibit still reproduces on both surfaces', async () => {
  const req = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };
  const http = await byName['perp-gate'].run({ ...req });
  const rpc = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'perp_gate', arguments: { ...req } } });
  const mcp = JSON.parse(rpc.result.content[0].text);
  for (const [label, r] of [['HTTP', http], ['MCP', mcp]]) {
    assert.equal(r.proof.contentHash, APPENDIX_C, `${label}: the worked proof the paper invites a reader to re-derive no longer reproduces`);
    assert.equal(typeof r.proof.elapsedMs, 'number', `${label}: the appendix exhibit must carry the field too`);
    console.log(`    ${label}  contentHash ${r.proof.contentHash.slice(0, 16)}…  proof.elapsedMs ${r.proof.elapsedMs}`);
  }
});

test('★ the published recipe still reproduces, and elapsedMs is never a key that has to be removed', () => {
  // The recipe a caller is told to follow: sha256(canonical({engine, codeHash, [observedAtUtc,]
  // inputs, result})) where result = this response WITHOUT its envelope key. Run verbatim first; only
  // when it misses are the documented post-envelope siblings removed, and `elapsedMs` is not one of
  // them — so a stamp that ever lands at the top level fails here and cannot hide behind a known name.
  const broken = [];
  const needStripping = new Map();
  let verbatim = 0;
  for (const r of answered) {
    const envKey = envelopeKeyOf(r.response);
    if (!envKey) continue;
    // "The response you received", not the object memory holds. src/engine/proof.js hashes
    // `jsonClean(result)` for exactly this reason — `res.json` drops undefined-valued keys and turns
    // NaN into null — so a gate that recomputes over the in-memory object is checking a form no
    // caller ever sees. Measured: size-gate reproduces after the round trip and not before it.
    const wire = JSON.parse(JSON.stringify(r.response));
    const env = wire[envKey];
    const recompute = (result) => sha256(canonical({
      engine: env.engine, codeHash: env.codeHash,
      ...(env.observedAtUtc ? { observedAtUtc: env.observedAtUtc } : {}),
      inputs: env.inputs, result,
    }));
    const { [envKey]: _drop, ...asPublished } = wire;
    if (recompute(asPublished) === env.contentHash) { verbatim += 1; continue; }

    const removed = [];
    const stripped = { ...asPublished };
    for (const k of POST_ENVELOPE_SIBLINGS) if (k in stripped) { delete stripped[k]; removed.push(k); }
    if (recompute(stripped) === env.contentHash) { needStripping.set(r.key, removed); continue; }

    // Still wrong. If dropping elapsedMs alone fixes it, this field is the culprit and says so.
    const noElapsed = { ...stripped }; delete noElapsed.elapsedMs;
    broken.push(`${r.surface} ${r.key}${recompute(noElapsed) === env.contentHash ? '  <-- caused by a top-level elapsedMs' : ''}`);
  }
  console.log(`    ${verbatim} envelope(s) reproduce the recipe verbatim`);
  for (const [k, v] of needStripping) console.log(`    note: ${k} needs [${v}] removed too — a pre-existing sibling, not this field`);
  assert.equal(broken.length, 0, `the response's own verification instruction no longer reproduces:\n      ${broken.join('\n      ')}`);
});

test('★ the sweep actually reached the corpus it claims to cover', () => {
  for (const r of unreached) console.log(`    UNREACHED  ${r.surface} ${r.key}: ${r.unreached}`);
  // A checker that reads nothing passes every time. Floors measured on 29 July 2026: 31 HTTP forms
  // and 15 MCP forms, all reached.
  assert.ok(onSurface('http').length >= 29, `only ${onSurface('http').length} HTTP forms answered`);
  assert.ok(onSurface('mcp').length >= 15, `only ${onSurface('mcp').length} MCP forms answered`);
  assert.ok(unreached.length <= 2, `${unreached.length} form(s) never produced a response — an outage must not shrink this corpus quietly`);
  assert.equal(new Set(answered.map((r) => r.name.replace(/_/g, '-'))).size >= SERVICES.length, true,
    'not every service produced at least one response');
});
