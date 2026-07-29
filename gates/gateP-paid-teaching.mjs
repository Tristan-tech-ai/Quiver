// GATE P — the buyer defence has to reach the caller who PAID for it.
//
// THE DEFECT THIS GATE OWNS. `src/app.js` builds a refusal as an Error carrying two halves: a MESSAGE
// naming what went wrong, and a `detail` OBJECT holding the machine-readable half — `howToFix` (a body
// that would work, with the caller's own values kept), `routingNotice` (the service that fits, with
// endpoint, price and a retry) and `repairsApplied`. `src/x402.js` then serialised `String(e.message)`
// into a field it ALSO called `detail`, and the object was dropped on the floor. So a caller who paid
// and got the input shape wrong received the prose and none of the retry, while a free MCP caller got
// the corrected body. The entire buyer-defence effort — built because a reviewer's agent gave Quiver
// one star after not understanding a refusal — was sitting on the one surface that does not bill, and
// the OKX listing points at the paid endpoints for 13 of the 22 services.
//
// WHY IT SURVIVED. Every existing check of the teaching layer calls `repairBody` + `correctedExample`
// directly (gateBuyer-mistakes) or goes through `/mcp` (gateM-mcp-surface). Not one of them ever put a
// PAYMENT-SIGNATURE header on a request. A gate that only exercises MCP is exactly how this was missed,
// so this one drives the real x402 middleware end to end — 402 challenge, /verify, handler, /settle —
// against a stub facilitator, and asserts on the bytes a paying caller actually receives.
//
// The load-bearing shape is DIFFERENTIAL: for the same bad body, the paid HTTP response and the free
// MCP response must carry the same teaching. A gate that asserted "the paid refusal has a howToFix"
// would be satisfied by a different, worse one; this one requires them to be the same object.
//
//   node --test gates/gateP-paid-teaching.mjs        (npm run gate:p)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── a facilitator that verifies and settles, so the PAID branch actually runs ──────────────────────
// Base with `auth: none` is a real, configured rail in src/config.js (testnet mode), so nothing here
// is a test-only code path inside the service: the middleware routes to it exactly as it routes to
// OKX or CDP. Every /settle is recorded, because "was this call billed?" is the second thing this
// gate measures and it must be measured, not inferred from the response body.
const settles = [];
const facilitator = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/verify')) return res.end(JSON.stringify({ isValid: true, payer: '0xPAYER' }));
    if (req.url.includes('/settle')) {
      settles.push({ url: req.url, at: Date.now() });
      return res.end(JSON.stringify({ success: true, status: 'settled', transaction: '0xfeed', payer: '0xPAYER' }));
    }
    res.end('{}');
  });
});
await new Promise((r) => facilitator.listen(0, '127.0.0.1', r));
process.env.BASE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
process.env.BASE_FACILITATOR_AUTH = 'none';
process.env.BASE_FACILITATOR = `http://127.0.0.1:${facilitator.address().port}`;
delete process.env.DEV_MODE;   // the gate is worthless against the branch that skips payment entirely

const { default: app } = await import(`file://${join(ROOT, 'src', 'app.js').replace(/\\/g, '/')}`);
const { SERVICES } = await import(`file://${join(ROOT, 'src', 'services.js').replace(/\\/g, '/')}`);
const { refusalBody } = await import(`file://${join(ROOT, 'src', 'x402.js').replace(/\\/g, '/')}`);

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); facilitator.close(); });

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const PAYMENT = b64({ x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature: '0x00', authorization: {} } });

/** A real paid call: the same header a payer sends, through the same middleware. */
async function paidCall(path, body) {
  const before = settles.length;
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': PAYMENT },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { unparseable: text }; }
  return { status: r.status, json, billed: settles.length > before, payResponse: r.headers.get('PAYMENT-RESPONSE') };
}

/** The same body over the free surface, for the differential. */
async function freeCall(tool, args) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const j = await r.json();
  try { return JSON.parse(j.result.content[0].text); } catch { return j; }
}

// The three mistake shapes the brief named, each written from the caller's side.
const MISTAKES = [
  { what: 'a missing required field', service: 'perp-gate', tool: 'perp_gate', body: { side: 'long', entryPrice: 64000 } },
  { what: 'a wrong-service body', service: 'options-desk', tool: null, body: { protocol: 'aave' } },
  { what: 'a bad enum value', service: 'updown-pulse', tool: null, body: { coin: 'DOGE' } },
];

// ── 1. the teaching reaches the payer ─────────────────────────────────────────────────────────────

test('a PAYING caller who gets the input shape wrong is handed a corrected body', async () => {
  for (const m of MISTAKES) {
    const svc = SERVICES.find((s) => s.name === m.service);
    const r = await paidCall(svc.path, m.body);
    assert.equal(r.status, 400, `${m.what}: a caller mistake is a 400, never a 500`);
    assert.equal(r.json.error, 'bad_input', `${m.what}: and it is named as one`);
    assert.ok(r.json.detail, `${m.what}: the prose half must survive`);
    // The half that was dropped. Not "some hint exists" — the actual retryable call.
    assert.ok(r.json.howToFix, `${m.what}: NO howToFix reached the paying caller`);
    assert.equal(r.json.howToFix.send.url, svc.path, `${m.what}: and it must address the right endpoint`);
    assert.ok(Object.keys(r.json.howToFix.send.body).length > 0,
      `${m.what}: a corrected body with no fields teaches nothing`);
  }
});

test('the wrong-shop signpost reaches the payer too, machine-readable', async () => {
  // The two half-star reviews were a caller that could not find the right shop. Prose naming
  // protocol-pulse is not the same as a `retry` object an agent can execute.
  const r = await paidCall('/api/options-desk', { protocol: 'aave' });
  assert.ok(r.json.routingNotice, 'no routingNotice reached the paying caller');
  assert.equal(r.json.routingNotice.service, 'protocol-pulse');
  assert.equal(r.json.routingNotice.retry.url, '/api/protocol-pulse');
  assert.ok(r.json.routingNotice.price, 'and the price of the call being suggested');
});

test('THE DIFFERENTIAL: the paid refusal carries the same teaching as the free one', async () => {
  // The property that was actually violated, asserted as an equality rather than as two separate
  // "has a howToFix" checks — which a divergent, worse paid version would have satisfied.
  const body = { side: 'long', entryPrice: 64000 };
  const paid = await paidCall('/api/perp-gate', body);
  const free = await freeCall('perp_gate', body);
  assert.ok(free.howToFix, 'the free surface must still teach, or this comparison measures nothing');
  assert.deepEqual(paid.json.howToFix, free.howToFix,
    'the surface that BILLS must not teach less than the surface that does not');
});

test('every service that can refuse teaches its paying caller', async () => {
  // Swept, because the defect was one line in shared middleware and therefore hit all 22 at once —
  // and because a check written against three named services is a check against three named services.
  const bare = [];
  let refused = 0;
  for (const s of SERVICES) {
    const r = await paidCall(s.path, { definitelyNotAField: 1 });
    if (r.status !== 400) continue;              // a service that accepts anything cannot be measured here
    refused++;
    if (!r.json.howToFix || !Object.keys(r.json.howToFix.send.body || {}).length) bare.push(s.name);
  }
  // Vacuity guard first: if nothing refused, the assertion below would pass over an empty set.
  assert.ok(refused >= 15, `only ${refused} of ${SERVICES.length} services refused a junk body — this sweep proved nothing`);
  assert.deepEqual(bare, [], `these refused a paying caller with no corrected body: ${bare.join(', ')}`);
});

// ── 2. nothing that was working may move ──────────────────────────────────────────────────────────

test('the 402 challenge is untouched — schema bytes, both rails, and the header', async () => {
  // The advertised inputSchema moving is what triggers an OKX re-review of all 22 listings, so it is
  // checked as BYTES against the registry rather than eyeballed.
  let checked = 0;
  for (const s of SERVICES) {
    const r = await fetch(BASE + s.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 402, `${s.name}: an unpaid POST must still get the challenge`);
    assert.ok(r.headers.get('PAYMENT-REQUIRED'), `${s.name}: and the PAYMENT-REQUIRED header`);
    const j = await r.json();
    assert.equal(j.x402Version, 2);
    for (const a of j.accepts) {
      assert.equal(JSON.stringify(a.outputSchema.input.body), JSON.stringify(s.inputSchema),
        `${s.name}: the advertised inputSchema moved on rail ${a.network}`);
    }
    checked++;
  }
  assert.equal(checked, SERVICES.length, 'every service must have been probed');
});

test('a refusal that teaches is still a refusal that is FREE', async () => {
  // The billing rule and the teaching are independent, and this asserts it rather than reasoning it:
  // the refusal path returns before /settle is reached, so nothing the refusal carries can make it
  // billable. Measured at the facilitator, not read off the response body.
  for (const m of MISTAKES) {
    const svc = SERVICES.find((s) => s.name === m.service);
    const r = await paidCall(svc.path, m.body);
    assert.ok(r.json.howToFix, `${m.what}: precondition — this refusal does carry teaching`);
    assert.equal(r.billed, false, `${m.what}: a caller-mistake refusal must never reach /settle`);
    assert.equal(r.payResponse, null, `${m.what}: and must not claim a payment response`);
  }
});

test('an answer that is delivered is still billed, and its contentHash has not moved', async () => {
  // The other direction. If the change had made a delivered answer free, that is a revenue defect
  // dressed as a fix — and if it moved a content hash, a published proof stops reproducing.
  const body = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.005 };
  const paid = await paidCall('/api/perp-gate', body);
  assert.equal(paid.status, 200);
  assert.equal(paid.billed, true, 'a delivered answer must still settle');
  assert.ok(paid.json.proof, 'and still ship its deterministic proof envelope');
  assert.equal(paid.json.proof.deterministic, true);
  // The paper's claim that the free answer IS the paid answer, asserted on the wire in one test.
  const free = await freeCall('perp_gate', body);
  assert.equal(paid.json.proof.contentHash, free.proof.contentHash,
    'the paid and free surfaces must hash the same request identically');
});

test('an engine refusal (ok:false) is still served free, with its not_charged receipt', async () => {
  // isChargeable's contract, on the wire. This path is NOT the throw path above — it returns 200 with
  // ok:false — and the two must not have been conflated by the change.
  //
  // THE FIXTURE CHANGED, AND THE REASON MATTERS. This used to drive `perp-gate {venue:"okx"}`, whose
  // refusal came from the venue registry inside `run`. Since the unknown-enum guard (see
  // hackathon/UNKNOWN_ENUM_REFUSAL.md) `venue:"okx"` is refused at VALIDATION — earlier, and before
  // any venue is resolved — so it exercises the throw path above, not this one. Replaced with a
  // caller mistake that is still only knowable after the engine has looked at it: a Solana chain
  // carrying an EVM address. No network is reached; `chainAddressMismatch` fires first.
  const r = await paidCall('/api/tape-pulse', { chain: 'solana', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.billed, false, 'an input the engine rejected is not a delivery');
  const receipt = JSON.parse(Buffer.from(r.payResponse, 'base64').toString('utf8'));
  assert.equal(receipt.status, 'not_charged');
});

test('and the refusal that moved EARLIER is free too — a 400 is never settled', async () => {
  // The other half of the swap above, so nothing is lost by it: the body that used to prove the
  // ok:false path still has to prove it costs nothing, now on the path it actually takes. A guard
  // that refused before payment could settle would be a silent revenue leak in the caller's favour;
  // one that refused AFTER settling would be theft. It is the second that this asserts against.
  const r = await paidCall('/api/perp-gate', { symbol: 'BTC', venue: 'okx', size: 1, leverage: 10 });
  assert.equal(r.status, 400, 'an unknown enum value is refused before the engine, not after it');
  assert.equal(r.billed, false, 'a refused request must never settle');
  assert.match(JSON.stringify(r.json), /hyperliquid/, 'and the refusal must name what IS accepted');
  // The teaching the adapter's own refusal used to carry has to survive the move, or this is a
  // downgrade wearing a better status code.
  assert.match(JSON.stringify(r.json), /venue-agnostic/,
    'the "pass the numbers yourself" escape hatch must still reach a caller who named an unsupported venue');
});

// ── 3. the helper itself ──────────────────────────────────────────────────────────────────────────

test('refusalBody cannot be talked into renaming the error or the message', () => {
  // The teaching object comes from a handler, so it is worth pinning that a handler cannot use it to
  // overwrite the status name or the message a caller reads.
  const e = Object.assign(new Error('bad_input: real reason'), {
    status: 400,
    detail: { error: 'not_this', detail: 'nor this', howToFix: { send: { url: '/api/x', body: { a: 1 } } }, repairsApplied: undefined },
  });
  const out = refusalBody(e, 400, 'bad_input');
  assert.equal(out.error, 'bad_input');
  assert.equal(out.detail, 'real reason', 'the bad_input: prefix is still stripped');
  assert.ok(out.howToFix, 'and the teaching still comes through');
  assert.equal('repairsApplied' in out, false, 'an undefined member stays absent rather than becoming null');
});

test('a 5xx carries no teaching — it is our fault, and there is nothing for the caller to correct', () => {
  const e = Object.assign(new Error('boom'), { status: 500, detail: { howToFix: { send: {} } } });
  const out = refusalBody(e, 500, 'engine_error');
  assert.equal(out.howToFix, undefined);
  assert.equal(out.error, 'engine_error');
});
