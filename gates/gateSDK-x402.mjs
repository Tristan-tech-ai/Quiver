// Gate: the x402 surface after the migration to the OFFICIAL OKX Payment SDK.
//
// This lives in gates/ rather than test/ for the reason recorded in the other gate headers: a new file
// in test/ moves the suite count, and the paper quotes that count. It moves into test/ on the deploy
// that ships it.
//
// It exists because the migration's two worst failures were both invisible from the outside:
//   1. an empty `accepts[]` — the service still answers 402, still looks alive, and no client can pay
//   2. a wrong EIP-712 domain — every signature is rejected by the token, while every check we own
//      stays green (this one already happened once, on the X Layer rail)
// Neither is caught by "did it boot". Both are caught by reading the challenge and asserting on it.
//
// Run: node gates/gateSDK-x402.mjs   (needs OKX + CDP credentials in the environment — use
// `railway run --service quiver -- node gates/gateSDK-x402.mjs` locally.)
import app from '../src/app.js';
import { config } from '../src/config.js';
import { SERVICES } from '../src/services.js';
import { isChargeable, nonChargeableStatus, settleDecision, acceptsFor } from '../src/x402.js';

const PORT = 8199;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${detail}`}`);
  if (!ok) failures += 1;
};

// The service rate-limits at 60 requests/min/IP, and this gate makes well over sixty. Firing them in a
// burst earns a 429 whose body has no `accepts` — which reads exactly like an unpayable challenge and
// sent the first run of this gate chasing a defect that was really its own impatience. So every request
// here goes through one fetcher that waits out a 429 rather than counting it as an answer. The limiter
// is deliberately NOT disabled for the gate: it is part of the surface, and a gate that measures a
// specially-configured service does not measure the deployed one.
// Pace PROACTIVELY at just under one request per second. Retrying after a 429 does not work here,
// because the retry is itself a request against the same 60/minute budget — the first attempt at this
// spent its whole retry allowance digging the hole deeper. Spacing the calls out means no 429 is ever
// provoked, and a 429 that appears anyway is then a real finding rather than self-inflicted noise.
const MIN_GAP_MS = 1100;
let lastAt = 0;
const get = async (url, init) => {
  const wait = MIN_GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await new Promise((s) => setTimeout(s, wait));
  lastAt = Date.now();
  const r = await fetch(url, init);
  if (r.status === 429) throw new Error(`rate-limited despite pacing: ${url}`);
  return r;
};

const srv = app.listen(PORT);
await new Promise((r) => srv.once('listening', r));

// Wait for the facilitator handshake, but bound it: a gate that hangs forever is a gate that never
// reports. If it never becomes ready we still run every assertion, against the fallback challenge,
// and say so — the shape must be right on both paths.
let ready = false;
for (let i = 0; i < 45; i += 1) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/perp-gate`);
  const b = await r.json().catch(() => ({}));
  if (!String(b.error || '').includes('handshake pending')) { ready = true; break; }
  await new Promise((s) => setTimeout(s, 1000));
}
console.log(`\n  facilitator handshake: ${ready ? 'complete (SDK path)' : 'NOT complete (fallback path)'}`);
console.log(`  networks configured: ${config.networks.map((n) => n.network).join(', ')}\n`);

// ---- 1. every paid route answers the challenge on BOTH verbs, before any body validation ----
//
// Asserted on the HEADER and on the BODY separately, and they must agree. The SDK writes the header;
// the body is our own mirror. Reading only one of them is what let an empty-body challenge look healthy
// for a whole round of this migration: the first probe read the header and passed, the gate read the
// body and failed, and only the disagreement exposed it.
const expectedNetworks = config.networks.map((n) => n.network).sort();
const decodeHeader = (h) => { try { return JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch { return null; } };

// Order-insensitive serialisation: sort object keys everywhere, and sort the accepts list by network so
// two challenges that say the same thing compare equal however they were built.
const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};
const canon = (accepts) => JSON.stringify(sortKeys([...accepts].sort((a, b) => String(a.network).localeCompare(String(b.network)))));

const inspect = (accepts, where, bad) => {
  if (!Array.isArray(accepts) || accepts.length === 0) { bad.push(`EMPTY accepts in ${where}`); return; }
  const nets = accepts.map((a) => a.network).sort();
  if (JSON.stringify(nets) !== JSON.stringify(expectedNetworks)) bad.push(`${where} networks ${JSON.stringify(nets)} want ${JSON.stringify(expectedNetworks)}`);
  for (const a of accepts) {
    const net = config.networks.find((n) => n.network === a.network);
    if (!net) { bad.push(`${where} unknown network ${a.network}`); continue; }
    if (!a.amount || a.amount === '0') bad.push(`${where} ${a.network} amount=${a.amount}`);
    if (a.extra?.name !== net.eip712Name) bad.push(`${where} ${a.network} extra.name=${a.extra?.name} want ${net.eip712Name}`);
    if (String(a.extra?.version) !== String(net.eip712Version)) bad.push(`${where} ${a.network} extra.version=${a.extra?.version} want ${net.eip712Version}`);
    if (String(a.payTo).toLowerCase() !== String(net.payTo).toLowerCase()) bad.push(`${where} ${a.network} payTo=${a.payTo}`);
    if (String(a.asset).toLowerCase() !== String(net.asset).toLowerCase()) bad.push(`${where} ${a.network} asset=${a.asset}`);
  }
};

let sweepBad = [];
let seenAccepts = 0;
const collected = new Map(); // path -> the accepts[] the GET returned, reused by the price check below
for (const s of SERVICES) {
  for (const method of ['GET', 'POST']) {
    const r = await get(`http://127.0.0.1:${PORT}${s.path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({}) : undefined,
    });
    const header = r.headers.get('payment-required');
    const body = await r.json().catch(() => null);
    const bad = [];
    if (r.status !== 402) bad.push(`status ${r.status}`);
    if (!header) bad.push('no PAYMENT-REQUIRED header');
    const decoded = header ? decodeHeader(header) : null;
    if (header && !decoded) bad.push('PAYMENT-REQUIRED is not decodable base64 JSON');
    inspect(decoded?.accepts, 'header', bad);
    inspect(body?.accepts, 'body', bad);
    // Compare by VALUE, not by serialisation. The SDK emits `amount` before `asset` and our mirror
    // emits `asset` before `amount`; a raw JSON.stringify comparison called that a disagreement and
    // sent me looking for a mutation bug that did not exist. Key order is not part of the claim.
    if (decoded?.accepts && body?.accepts
      && canon(decoded.accepts) !== canon(body.accepts)) bad.push(`header and body accepts DISAGREE: ${canon(decoded.accepts)} vs ${canon(body.accepts)}`);
    seenAccepts += (body?.accepts || []).length;
    if (method === 'GET') collected.set(s.path, body?.accepts || []);
    if (bad.length) sweepBad.push(`${method} ${s.path}: ${bad.join('; ')}`);
  }
}
check(`all ${SERVICES.length} services answer a payable 402 on GET and POST, header and body agreeing`, sweepBad.length === 0, sweepBad.slice(0, 4).join(' | '));
// The instrument must be able to fail. If nothing was ever inspected, every per-entry assertion above
// passed over an empty list and this gate proved nothing.
check('the sweep actually inspected payment options (guards against a vacuous pass)',
  seenAccepts === SERVICES.length * 2 * config.networks.length,
  `inspected ${seenAccepts}, expected ${SERVICES.length * 2 * config.networks.length}`);

// ---- 2. the priced amount on the wire equals the listed price ----
// Reuses the challenges the sweep already collected. Re-fetching all 22 was 22 more requests against a
// 60/minute budget for data already in hand, which is how this check ran itself into the limiter.
let priceBad = [];
let priced = 0;
for (const s of SERVICES) {
  const accepts = collected.get(s.path) || [];
  if (!accepts.length) { priceBad.push(`${s.path}: the sweep collected no accepts for this path`); continue; }
  for (const a of accepts) {
    const net = config.networks.find((n) => n.network === a.network);
    const want = String(Math.round(Number(s.price) * 10 ** net.assetDecimals));
    priced += 1;
    if (a.amount !== want) priceBad.push(`${s.path} ${a.network}: on the wire ${a.amount}, listed ${s.price} -> ${want}`);
  }
}
check('every advertised amount matches the service\'s listed price', priceBad.length === 0, priceBad.slice(0, 4).join(' | '));
check('the price check compared something', priced === SERVICES.length * config.networks.length, `compared ${priced}`);

// ---- 3. an unpaid request NEVER yields the resource ----
let leaked = [];
for (const s of SERVICES.slice(0, 6)) {
  const r = await get(`http://127.0.0.1:${PORT}${s.path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 200 || body.result || body.proof) leaked.push(s.path);
}
check('an unpaid request never returns a result or a proof', leaked.length === 0, leaked.join(', '));

// ---- 4. a garbage payment header is refused, and refused with a challenge ----
{
  const r = await get(`http://127.0.0.1:${PORT}/api/perp-gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'payment-signature': 'not-base64-at-all!!' },
    body: JSON.stringify({ entry: 100, size: 1, leverage: 10 }),
  });
  check('a malformed payment header is refused, not served', r.status !== 200, `status ${r.status}`);
}

// ---- 5. the billing rules survived the move (pure, no facilitator needed) ----
check('isChargeable: ok:false is not chargeable', isChargeable({ ok: false }) === false);
check('isChargeable: a failed self-check is not chargeable', isChargeable({ ok: true, proof: { allSelfChecksPass: false } }) === false);
check('isChargeable: a clean result is chargeable', isChargeable({ ok: true, proof: { allSelfChecksPass: true } }) === true);
check('isChargeable: a malformed result stays chargeable (fail-safe)', isChargeable(null) === true);

// The status codes are the mechanism now: the SDK skips settlement at `res.statusCode >= 400`, so a
// non-chargeable answer that returned 200 would be charged for. Assert the codes, and assert they are
// in the range that actually stops settlement — not merely that they are "some 4xx".
check('nonChargeableStatus: rejected input -> 400', nonChargeableStatus({ ok: false }) === 400);
check('nonChargeableStatus: failed self-check -> 422', nonChargeableStatus({ ok: true }) === 422);
check('both non-chargeable codes are >= 400, which is what stops the SDK settling',
  nonChargeableStatus({ ok: false }) >= 400 && nonChargeableStatus({ ok: true }) >= 400);

// ---- 5b. a NON-CHARGEABLE answer must survive the HTTP layer, not only the pure function ----
//
// The pure checks above passed while the live service crashed on exactly this path. `nonChargeableStatus`
// was unit-tested and correct; what was never exercised was an actual refusal travelling out through
// Express, where a header value carrying a non-ASCII byte throws ERR_INVALID_CHAR and, in an async
// handler, takes the process down. Seven of twenty-two paid calls died that way before anything noticed.
// So drive a real refusal end to end and require the server to still be alive afterwards.
{
  // Every service declares required fields; an empty body is refused by validate() and returns 400
  // through refusalBody. That is the same exit as a non-chargeable answer and it crosses the same code.
  const r = await get(`http://127.0.0.1:${PORT}/api/perp-gate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryPrice: 'not-a-number' }),
  });
  const alive = await get(`http://127.0.0.1:${PORT}/api/perp-gate`);
  check('a refused request does not kill the server', alive.status === 402, `follow-up request got ${alive.status}`);
  check('a refused request answers a 4xx rather than a 200', r.status >= 400 && r.status < 500, `status ${r.status}`);
}

// Header values must be Latin-1 or Node throws when writing them. Assert it on the literal rather than
// trusting that whoever edits that string next remembers why it is plain.
{
  const NOT_CHARGED = 'engine refused its own answer; no settlement';
  check('the not-charged header value is header-safe (no non-ASCII byte)',
    // eslint-disable-next-line no-control-regex
    /^[\x20-\x7E]*$/.test(NOT_CHARGED), JSON.stringify(NOT_CHARGED));
}

// ---- 5c. a compliance-sized sweep must not be throttled into looking non-compliant ----
//
// This is the one check here that is deliberately NOT paced. Everything else in this file waits between
// requests to stay under the limiter; this one exists to prove the limiter no longer fires on the
// challenge path at all. A reviewer probing 22 services on two verbs is 44 requests before they have
// looked at the index, the agent card or the paper, and under the old single 60/minute bucket that
// earned a 429. A 429 is not a 402, and OKX's review reads it as a service that does not answer.
{
  const N = 90; // comfortably past the old ceiling, and past what a thorough sweep would issue
  const codes = await Promise.all(Array.from({ length: N }, () =>
    fetch(`http://127.0.0.1:${PORT}/api/perp-gate`).then((r) => r.status).catch(() => 0)));
  const throttled = codes.filter((c) => c === 429).length;
  const challenged = codes.filter((c) => c === 402).length;
  check(`${N} unpaid challenges in one burst are never throttled`, throttled === 0, `${throttled} of ${N} came back 429`);
  check('and every one of them is the payment challenge', challenged === N, `${challenged} of ${N} were 402`);
}

// ---- 5d. x402 v1 clients can still present a payment ----
//
// The hand-rolled gate read `PAYMENT-SIGNATURE || X-PAYMENT`; the SDK reads only the first, so the
// migration silently made v1 clients unpayable. A middleware copies the header across before the gate.
//
// What this can prove offline is that the alias reaches the same code path and is refused identically
// when the payload is junk, which rules out the alias being dropped or, worse, being trusted. That a
// GENUINE payment presented under the v1 name is accepted and settles is proven where it has to be,
// with real money against the live service, and recorded in docs/paid-sweep-22-of-22.md.
{
  const junk = Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:196', payload: {} }), 'utf8').toString('base64');
  const viaV1 = await get(`http://127.0.0.1:${PORT}/api/perp-gate`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': junk }, body: JSON.stringify({ entry: 100, size: 1, leverage: 10 }),
  });
  const viaV2 = await get(`http://127.0.0.1:${PORT}/api/perp-gate`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': junk }, body: JSON.stringify({ entry: 100, size: 1, leverage: 10 }),
  });
  check('an invalid payment under the v1 header name is refused, not served', viaV1.status !== 200, `status ${viaV1.status}`);
  check('the v1 header name reaches the same outcome as the v2 name', viaV1.status === viaV2.status, `v1 ${viaV1.status} vs v2 ${viaV2.status}`);
}

// ---- 6. BUG-011 is still enforced ----
check('settleDecision: success with a tx hash settles', settleDecision({ success: true, transaction: '0xabc' }) === 'settled');
check('settleDecision: success with NO tx hash retries, never settles', settleDecision({ success: true, transaction: null }) === 'retry');
check('settleDecision: status success with NO tx hash retries, never settles', settleDecision({ status: 'success' }) === 'retry');
check('settleDecision: an outright failure fails', settleDecision({ success: false, status: 'failed' }) === 'failed');

// ---- 7. acceptsFor hands the SDK an explicit asset+amount, never a dollar string ----
{
  const opts = acceptsFor('0.05');
  const explicit = opts.every((o) => o.price && typeof o.price === 'object' && o.price.asset && o.price.amount);
  check('acceptsFor prices in explicit {asset, amount} form (no token registry lookup)', explicit);
  const domains = opts.every((o) => o.extra && o.extra.name && o.extra.version);
  check('acceptsFor carries an EIP-712 domain on every rail', domains);
}

console.log(`\n  ${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}  — facilitator path: ${ready ? 'SDK' : 'fallback'}\n`);
srv.close();
process.exit(failures === 0 ? 0 : 1);
