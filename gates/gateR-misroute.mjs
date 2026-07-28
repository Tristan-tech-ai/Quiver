// GATE R — would this have caught the two half-star reviews?
//
// Not a hypothetical. Agent #5152's on-chain review record is 10 five-star and 2 half-star, and both
// half-stars are from MantaRay, which asked for an Aave lending-protocol health check and called
// `options-desk`. Its own comments are the evidence:
//
//     "Wrong endpoint: options-desk can't do Aave health checks. No deliverable."
//     "Delivered crypto options/vol data, not the Aave health check that was requested"
//
// Two other agents ran the same Aave task through `protocol-pulse` and gave 5.0 and 4.8. So this is a
// service-selection failure by the caller that Quiver had no way to name, and the fix is a signpost.
//
// This gate replays both of MantaRay's calls and requires the signpost to appear. It also requires it
// to STAY SILENT on ordinary correct calls, which is the half that can fail: a detector that fires on
// everything is not a detector, and a false signpost inside a paid response is worse than none.
//
//   node --test gates/gateR-misroute.mjs        (npm run gate:r)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/services.js';
import { suggestService, redirectLine, fitScore } from '../src/util/routing.js';

const byName = (n) => SERVICES.find((s) => s.name === n);

test('MantaRay call 1: an Aave request that options-desk cannot satisfy', () => {
  const optionsDesk = byName('options-desk');
  // A lending-protocol health request. It does not carry `currency`, so options-desk refuses it, and
  // the refusal used to say only what options-desk needs.
  const body = { protocol: 'aave' };

  const hit = suggestService(optionsDesk, body, SERVICES);
  assert.ok(hit, 'a request naming a protocol must be recognised as protocol-pulse territory');
  assert.equal(hit.service, 'protocol-pulse');
  assert.equal(hit.endpoint, '/api/protocol-pulse');
  assert.deepEqual(hit.retry.body, body, 'the retry must be sendable as-is, not a description of one');

  const line = redirectLine(optionsDesk, body, SERVICES);
  assert.match(line, /protocol-pulse/);
  assert.match(line, /POST \/api\/protocol-pulse/, 'an agent needs the exact call, not the name of a service');
});

test('MantaRay call 2: an Aave request that options-desk CAN satisfy, and answers wrongly', () => {
  const optionsDesk = byName('options-desk');
  // This is the dangerous one. The body satisfies options-desk (`currency` is present), so the call
  // SUCCEEDS and returns a correct options surface to somebody who asked about a lending protocol.
  // Nothing was refused, so no refusal message could have helped.
  const body = { currency: 'BTC', protocol: 'aave', question: 'aave health check' };

  const hit = suggestService(optionsDesk, body, SERVICES);
  assert.ok(hit, 'a successful call can still be at the wrong shop, and that must be sayable');
  assert.equal(hit.service, 'protocol-pulse');
});

test('an ordinary options request is NOT flagged', () => {
  // The negative control, and the reason this gate can fail. If the detector fires here it would be
  // stapling a wrong signpost onto correct paid answers, which is a worse defect than the one it fixes.
  const optionsDesk = byName('options-desk');
  for (const body of [{ currency: 'BTC' }, { currency: 'ETH', expiry: '2026-09-25' }, { currency: 'SOL', strike: 180 }]) {
    const hit = suggestService(optionsDesk, body, SERVICES);
    assert.equal(hit, null, `a plain options request must pass unflagged, got ${hit && hit.service} for ${JSON.stringify(body)}`);
  }
});

test('every service leaves its own correct requests alone', () => {
  // Swept across all twenty-two rather than spot-checked, because a detector tuned on one service and
  // never tried on the rest is a detector nobody has measured.
  const flagged = [];
  for (const s of SERVICES) {
    const req = s.inputSchema?.required || [];
    if (!req.length) continue;
    const props = s.inputSchema.properties || {};
    const body = {};
    for (const k of req) {
      const p = props[k] || {};
      body[k] = p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'array' ? [] : 'x';
    }
    const hit = suggestService(s, body, SERVICES);
    if (hit) flagged.push(`${s.name} -> ${hit.service}`);
  }
  assert.deepEqual(flagged, [], `no service should redirect its own minimal valid request; got: ${flagged.join(', ')}`);
});

test('an empty body is left to the validator, not the signpost', () => {
  // The marketplace funnel has been observed dropping params and replaying an empty body. That is the
  // validator's problem and its message already names the service; guessing a destination from nothing
  // would be inventing intent.
  for (const s of SERVICES.slice(0, 5)) {
    assert.equal(suggestService(s, {}, SERVICES), null);
    assert.equal(suggestService(s, null, SERVICES), null);
  }
});

test('the score separates hard evidence from weak evidence', () => {
  // shape comes from required keys, which are a fact about the service. words come from prose, which
  // is a guess. Keeping them apart is what stops a keyword coincidence from outvoting a schema.
  const pp = byName('protocol-pulse');
  const exact = fitScore(pp, { protocol: 'aave' });
  assert.equal(exact.shape, 1, 'a body carrying every required key scores a full shape match');

  const proseOnly = fitScore(pp, { note: 'protocol health dossier please' });
  assert.equal(proseOnly.shape, 0, 'prose alone must never satisfy shape');
  assert.ok(proseOnly.words > 0, 'but it should still register as weak evidence');
  assert.ok(exact.score > proseOnly.score, 'and hard evidence must outrank weak evidence');
});
