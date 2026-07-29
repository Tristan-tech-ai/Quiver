// GATE V — the verification recipe a response publishes must reproduce the hash it publishes.
//
// WHAT IT IS FOR. Every enveloped response carries `proof.verifyContentHash` (or the observation
// equivalent): a sentence telling a caller how to recompute `contentHash` for themselves. That
// sentence is the whole product. Quiver's pitch is that a buyer re-derives the number instead of
// trusting the seller, and the paper prints a worked exhibit in Appendix C precisely so a reader can
// try it. Nothing in this repository checked that the instruction works.
//
// It did not. Measured against the LIVE service on 29 July 2026, `perp_gate` called with its body
// wrapped in `params` — the single most common thing an agent framework does — published the
// Appendix C hash `8575ce5ae5bfae9c…` and, followed verbatim, its own recipe gave
// `1d1fcfdb143b5fb5…`. Locally, swept across both surfaces, 48 of 90 enveloped responses failed
// their own published instruction. The cause is structural: the preimage is
// `{engine, codeHash, [observedAtUtc,] inputs, result}` where `result` is the ENGINE's return value,
// hashed before the envelope is attached, and this host attaches `inputRepairs`, `routingNotice`,
// `howToFix` and `snark` as top-level siblings afterwards. The stored hash is correct; the sentence
// beside it was not — and the next sentence says a mismatch means the response was altered, so the
// instruction at the centre of this service accused honest answers.
//
// ── WHY THIS GATE READS THE RECIPE INSTEAD OF REIMPLEMENTING IT ──────────────────────────────────
// A checker that knows what to strip is a checker that agrees with the code by construction. Gate L
// already has that shape: it holds a list — `['inputRepairs', 'routingNotice', 'howToFix', 'snark']`
// — removes those keys when the verbatim recipe misses, and prints a `note:` saying so. It was green
// on 29 July while the defect was live, and its own log named the siblings responsible. A hardcoded
// list cannot fail on the thing it hardcodes.
//
// So this gate PARSES what each response says to do, in the response's own words:
//
//   the preimage field list   from  `sha256(canonical({…}))`
//   the envelope key to strip from  "WITHOUT its `proof` key"
//   the extra keys to strip   from  "`proof.excludedFromContentHash` = […]"
//
// and then requires the result to equal the published `contentHash`. Nothing about which keys are
// siblings is written down here. A twelfth sibling attached where the seal can see it is named by the
// response and this gate follows; one attached where it cannot is not named, this gate strips it not,
// and the gate goes red pointing at the key. That is the property `gates/gateV-revert.mjs` proves by
// bolting a new sibling on after the seal.
//
// The canonicalisation and the hash are restated below rather than imported, for the reason gate L
// gives: a checker that imports the function under test cannot witness that function changing.
//
// ── THE CORPUS ───────────────────────────────────────────────────────────────────────────────────
// Every service and every input form in `gates/routing-fixtures.mjs`, on both surfaces, in the
// request SHAPES that actually cause a sibling to be attached — because a sweep of well-formed
// bodies alone reproduces verbatim and would have been green throughout the defect:
//
//   plain     the fixture body as written
//   wrapped   the same body under `params` — forces `inputRepairs`, the sibling that broke the live
//             Appendix C exhibit
//   misroute  a body that VALIDATES for the called service and still draws a signpost — forces
//             `routingNotice`; the pairs are derived from the fixtures, not listed
//   snark     `{snark: true}` on perp-gate — forces `snark`, which is attached inside the handler
//             rather than by either surface, and is therefore the one a surface-level fix misses
//
// The HTTP half runs through the REAL express app and the REAL x402 middleware against a stub
// facilitator, exactly as gate P does, because the siblings are attached in the route handler and a
// sweep that calls `SERVICES[].run` directly — which is what gate L does — never sees them. That is
// not a hypothetical blind spot: it is why this shipped.
//
// `X-Forwarded-For` is varied per request only to get past the 60-requests-per-minute limiter in
// front of every route. The limiter is not what is being measured, and pacing the sweep under it
// would add two minutes of sleeping to a gate.
//
//   node --test gates/gateV-recipe-reproduces.mjs   (npm run gate:v)
//   node gates/gateV-revert.mjs                     (npm run gate:v-revert)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (...p) => `file://${join(ROOT, ...p).replace(/\\/g, '/')}`;

// ── the pinned truth ─────────────────────────────────────────────────────────────────────────────
// The 24 deterministic content hashes (12 forms × 2 surfaces) and the Appendix C exhibit, written
// down rather than recomputed. These are the SAME values gate L pins; restated here on purpose, so
// that two files measured independently have to agree, and so this gate can fail on its own.
const APPENDIX_C = '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960';
const PINNED = {
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

// The siblings this host is KNOWN to attach. Used ONLY as a coverage floor — "did the sweep still
// exercise the shapes that produce them" — and never to decide what to strip. It is a containment
// and not an equality on purpose: a new sibling that the seal names and this gate follows is a
// success, not a regression, and must not have to be added here for the suite to stay green.
const EXERCISED = ['inputRepairs', 'routingNotice', 'howToFix', 'snark'];

// ── the harness ──────────────────────────────────────────────────────────────────────────────────
const settles = [];
const facilitator = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/verify')) return res.end(JSON.stringify({ isValid: true, payer: '0xPAYER' }));
    if (req.url.includes('/settle')) { settles.push(1); return res.end(JSON.stringify({ success: true, status: 'settled', transaction: '0xfeed', payer: '0xPAYER' })); }
    res.end('{}');
  });
});
await new Promise((r) => facilitator.listen(0, '127.0.0.1', r));
process.env.BASE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
process.env.BASE_FACILITATOR_AUTH = 'none';
process.env.BASE_FACILITATOR = `http://127.0.0.1:${facilitator.address().port}`;
delete process.env.DEV_MODE;   // the free branch skips payment entirely and is not the paid surface

const { default: app } = await import(url('src', 'app.js'));
const { SERVICES } = await import(url('src', 'services.js'));
const { handleRpc, TOOLS } = await import(url('src', 'mcp.js'));
const { suggestService } = await import(url('src', 'util', 'routing.js'));
const { GENUINE } = await import(url('gates', 'routing-fixtures.mjs'));

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); facilitator.close(); });

const PAYMENT = Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature: '0x00', authorization: {} } }), 'utf8').toString('base64');
let seq = 0;
async function paidCall(path, body) {
  seq += 1;
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': PAYMENT, 'X-Forwarded-For': `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}` },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { unparseable: t.slice(0, 200) }; }
}
async function mcpCall(tool, args) {
  const j = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  const text = j?.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`no text content: ${JSON.stringify(j).slice(0, 120)}`);
  return JSON.parse(text);
}

// ── the arithmetic, restated ─────────────────────────────────────────────────────────────────────
const canonical = (o) => (o === null || typeof o !== 'object'
  ? JSON.stringify(o) ?? 'null'
  : Array.isArray(o)
    ? '[' + o.map(canonical).join(',') + ']'
    : '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const envelopeKeyOf = (r) => ['proof', 'observation'].find((k) => typeof r?.[k]?.contentHash === 'string') || null;

/**
 * Follow a response's published instruction MECHANICALLY: everything below is read out of the
 * sentence the response carries. Nothing here knows the name of a single sibling.
 */
function followTheRecipe(response) {
  const wire = JSON.parse(JSON.stringify(response));           // "the response you received"
  const envKey = envelopeKeyOf(wire);
  const env = wire[envKey];
  const text = String(env.verifyContentHash || '');

  const fieldsM = text.match(/sha256\(canonical\(\{([^}]+)\}\)\)/);
  if (!fieldsM) return { parseError: 'the recipe does not state a preimage as sha256(canonical({…}))' };
  const fields = fieldsM[1].split(',').map((s) => s.trim()).filter(Boolean);

  const stripM = text.match(/WITHOUT its `(\w+)` key/);
  if (!stripM) return { parseError: 'the recipe does not name the envelope key to remove' };
  const stripKey = stripM[1];

  // Absent clause = "remove nothing else". Read literally, never repaired: a recipe that fails to
  // mention a sibling has to be allowed to be wrong here, or this gate cannot detect one.
  const listM = text.match(/`\w+\.excludedFromContentHash` = (\[[^\]]*\])/);
  let excluded = [];
  if (listM) { try { excluded = JSON.parse(listM[1]); } catch { return { parseError: `unparseable exclusion list ${listM[1]}` }; } }
  if (!Array.isArray(excluded) || excluded.some((k) => typeof k !== 'string')) return { parseError: 'the exclusion list is not an array of key names' };

  const drop = new Set([stripKey, ...excluded]);
  const result = {};
  for (const k of Object.keys(wire)) if (!drop.has(k)) result[k] = wire[k];

  const preimage = {};
  for (const f of fields) {
    if (f === 'result') { preimage.result = result; continue; }
    if (!(f in env)) return { parseError: `the recipe names \`${f}\` but the envelope does not echo it` };
    preimage[f] = env[f];
  }
  const recomputed = sha256(canonical(preimage));

  // A failure has to be actionable. Name the key that would fix it, derived the same way the seal
  // derives its list: every top-level key attached after the envelope.
  let culprits = null;
  if (recomputed !== env.contentHash) {
    const top = Object.keys(wire);
    const after = top.slice(top.indexOf(envKey) + 1).filter((k) => !drop.has(k));
    const rehash = (extra) => {
      const r2 = {};
      for (const k of Object.keys(wire)) if (!drop.has(k) && !extra.includes(k)) r2[k] = wire[k];
      return sha256(canonical({ ...preimage, result: r2 }));
    };
    culprits = after.find((k) => rehash([k]) === env.contentHash) ? [after.find((k) => rehash([k]) === env.contentHash)]
      : (after.length && rehash(after) === env.contentHash) ? after
        : null;
  }
  return { ok: recomputed === env.contentHash, recomputed, published: env.contentHash, fields, stripKey, excluded, sawClause: !!listM, culprits, env };
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────
const rows = [];
const push = async (surface, name, form, shape, fn) => {
  const row = { surface, name, form, shape, key: `${surface} ${name}#${form} ${shape}` };
  try { row.response = await fn(); } catch (e) { row.unreached = String(e.message || e).slice(0, 120); }
  if (row.response && (row.response.error === 'rate_limited' || row.response.error === 'internal')) {
    row.unreached = `${row.response.error}: ${String(row.response.note || '').slice(0, 80)}`;
    delete row.response;
  }
  rows.push(row);
};

for (const s of SERVICES) {
  for (const [form, body] of (GENUINE[s.name] || []).entries()) {
    await push('http', s.name, form, 'plain', () => paidCall(s.path, { ...body }));
    await push('http', s.name, form, 'wrapped', () => paidCall(s.path, { params: { ...body } }));
  }
}
for (const t of TOOLS) {
  const svcName = t.name.replace(/_/g, '-');
  for (const [form, body] of (GENUINE[svcName] || []).entries()) {
    await push('mcp', t.name, form, 'plain', () => mcpCall(t.name, { ...body }));
    await push('mcp', t.name, form, 'wrapped', () => mcpCall(t.name, { params: { ...body } }));
  }
}
// snark — attached inside the handler, not by either surface, so it is the sibling a surface-level
// fix leaves behind.
for (const [form] of GENUINE['perp-gate'].entries()) {
  await push('http', 'perp-gate', form, 'snark', () => paidCall('/api/perp-gate', { ...GENUINE['perp-gate'][form], snark: true }));
  await push('mcp', 'perp_gate', form, 'snark', () => mcpCall('perp_gate', { ...GENUINE['perp-gate'][form], snark: true }));
}
// misroute — derived from the fixtures: a body that validates for the called service AND still draws
// a signpost. One per (called service) so the sweep does not spend a minute proving the same thing.
const misrouteSeen = new Set();
for (const called of SERVICES) {
  for (const meant of SERVICES) {
    if (called.name === meant.name || misrouteSeen.has(called.name)) continue;
    for (const body of GENUINE[meant.name]) {
      let v; try { v = called.validate({ ...body }); } catch { continue; }
      if (!v || v.error || !suggestService(called, body, SERVICES)) continue;
      misrouteSeen.add(called.name);
      await push('http', called.name, 0, `misroute<-${meant.name}`, () => paidCall(called.path, { ...body }));
      break;
    }
  }
}

const answered = rows.filter((r) => r.response && typeof r.response === 'object');
const enveloped = answered.filter((r) => envelopeKeyOf(r.response));
const unreached = rows.filter((r) => r.unreached);
for (const r of enveloped) r.check = followTheRecipe(r.response);
const onSurface = (s) => enveloped.filter((r) => r.surface === s);

// ── the checks ───────────────────────────────────────────────────────────────────────────────────

test('★ every service has a fixture here — asserted as an equality, not a containment', () => {
  const covered = Object.keys(GENUINE).sort();
  const listed = SERVICES.map((s) => s.name).sort();
  assert.deepEqual(covered, listed,
    `missing [${listed.filter((n) => !covered.includes(n))}], stale [${covered.filter((n) => !listed.includes(n))}]`);
  console.log(`    ${listed.length} services, ${rows.length} calls, ${enveloped.length} enveloped responses across both surfaces`);
});

test('★ every published recipe parses into an executable instruction', () => {
  const bad = enveloped.filter((r) => r.check.parseError);
  for (const r of bad) console.log(`    UNPARSEABLE ${r.key}: ${r.check.parseError}`);
  assert.equal(bad.length, 0, 'a recipe a caller cannot execute is the same defect as one that does not reproduce');
});

for (const surface of ['http', 'mcp']) {
  test(`★ following the published recipe reproduces the published contentHash — ${surface === 'http' ? 'paid HTTP' : 'free MCP'}`, () => {
    const broken = onSurface(surface).filter((r) => !r.check.ok);
    const withSiblings = onSurface(surface).filter((r) => r.check.excluded?.length);
    console.log(`    ${onSurface(surface).length - broken.length}/${onSurface(surface).length} reproduce; ${withSiblings.length} of them after stripping keys the recipe names`);
    assert.equal(broken.length, 0,
      `the response's own verification instruction does not reproduce the hash printed beside it — a buyer who follows it concludes the proof is fake:\n      ${broken.map((r) => `${r.key}: published ${r.check.published?.slice(0, 12)}… got ${r.check.recomputed?.slice(0, 12)}…`
        + (r.check.culprits ? `  <-- the recipe fails to name [${r.check.culprits.join(', ')}]` : '  <-- no top-level key explains the gap')).join('\n      ')}`);
  });
}

test('★ every enveloped response was sealed — the exclusion list is published even when it is empty', () => {
  // A response that never reached the seal would still reproduce whenever nothing was attached, and
  // would break silently the day something is. The field's PRESENCE is the evidence the seal ran.
  const unsealed = enveloped.filter((r) => !Array.isArray(r.check.env?.excludedFromContentHash) || !r.check.sawClause);
  for (const r of unsealed) console.log(`    UNSEALED ${r.key}`);
  assert.equal(unsealed.length, 0, 'an unsealed response publishes a recipe that is true only by luck');
});

test('★ no response ever ships a recipe the server could not reproduce itself', () => {
  const failed = enveloped.filter((r) => r.check.env?.contentHashRecipeSelfCheck);
  for (const r of failed) console.log(`    SELF-CHECK FAILED ${r.key}: ${r.check.env.contentHashRecipeSelfCheck}`);
  assert.equal(failed.length, 0, 'the seal recomputes before sending; a response carrying this field means it could not');
});

test('★ the sweep still exercises every sibling this host is known to attach', () => {
  // A coverage floor, not a strip-list. Containment, so a NEW sibling — named by the response and
  // followed by the check above — is a pass rather than a maintenance chore.
  const seen = new Set();
  for (const r of enveloped) for (const k of r.check.excluded || []) seen.add(k);
  console.log(`    siblings observed: [${[...seen].sort().join(', ')}]`);
  const missing = EXERCISED.filter((k) => !seen.has(k));
  assert.equal(missing.length, 0,
    `the corpus stopped producing [${missing.join(', ')}] — a sweep of responses with nothing attached would pass this gate while the defect was live`);
});

test('★ not one deterministic content hash moved, and Appendix C still reproduces on both surfaces', async () => {
  const moved = [];
  let checked = 0;
  for (const r of enveloped) {
    if (r.shape !== 'plain') continue;
    const pinned = PINNED[`${r.name.replace(/_/g, '-')}#${r.form}`];
    if (!pinned || !r.response.proof) continue;
    checked += 1;
    if (r.response.proof.contentHash !== pinned) moved.push(`${r.key}: ${pinned} -> ${r.response.proof.contentHash}`);
  }
  console.log(`    ${checked} pinned deterministic content hashes re-measured across both surfaces`);
  assert.equal(checked, Object.keys(PINNED).length * 2,
    `expected ${Object.keys(PINNED).length} pins on each of two surfaces, matched ${checked} — a pin list that matches nothing cannot fail`);
  assert.equal(moved.length, 0, `a published proof stops reproducing:\n      ${moved.join('\n      ')}`);

  // The exhibit the paper invites a reader to re-derive, in all three shapes — including the wrapped
  // one that broke it on the live service.
  const req = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };
  const exhibits = [
    ['HTTP plain', await paidCall('/api/perp-gate', { ...req })],
    ['HTTP wrapped', await paidCall('/api/perp-gate', { params: { ...req } })],
    ['MCP plain', await mcpCall('perp_gate', { ...req })],
    ['MCP wrapped', await mcpCall('perp_gate', { params: { ...req } })],
    ['MCP snark', await mcpCall('perp_gate', { ...req, snark: true })],
  ];
  for (const [label, r] of exhibits) {
    assert.equal(r.proof?.contentHash, APPENDIX_C, `${label}: the Appendix C exhibit no longer publishes 8575ce5a…`);
    const f = followTheRecipe(r);
    assert.equal(f.ok, true, `${label}: Appendix C publishes the right hash and its own recipe does not reach it (excluded ${JSON.stringify(f.excluded)}, got ${f.recomputed?.slice(0, 16)}…)`);
    console.log(`    ${label.padEnd(12)} ${r.proof.contentHash.slice(0, 16)}…  recipe strips [${f.excluded.join(', ')}] -> reproduces`);
  }
});

test('★ the sweep actually reached the corpus it claims to cover', () => {
  for (const r of unreached) console.log(`    UNREACHED  ${r.key}: ${r.unreached}`);
  // Floors measured on 29 July 2026: 45 enveloped HTTP responses and 27 enveloped MCP ones. A gate
  // whose corpus quietly shrinks in an outage is a gate that stops checking.
  assert.ok(onSurface('http').length >= 42, `only ${onSurface('http').length} enveloped HTTP responses`);
  assert.ok(onSurface('mcp').length >= 24, `only ${onSurface('mcp').length} enveloped MCP responses`);
  assert.ok(unreached.length <= 4, `${unreached.length} call(s) produced nothing — an outage must not shrink this corpus quietly`);
  assert.ok(enveloped.filter((r) => r.check.excluded?.length).length >= 30,
    'too few responses carried a sibling at all — the shapes that produce them are what this gate is for');
});
