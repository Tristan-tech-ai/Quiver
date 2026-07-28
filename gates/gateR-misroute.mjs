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
import { suggestService, redirectLine, fitScore, REQUIRED_ALTERNATIVES, requiredAlternatives } from '../src/util/routing.js';
import { GENUINE, UNREACHABLE_BY_SHAPE, invalidFixtures, coverageSummary, noisyOnCorrectCalls } from './routing-fixtures.mjs';

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

// ── COVERAGE: which services the signpost can NAME ────────────────────────────────────────────────
//
// The tests above ask whether the signpost is right when it fires. This block asks the question
// nobody had asked: how much of the catalogue it is CAPABLE of naming. Measured by sweeping every
// ordered pair of distinct services — B's genuine body sent to A — rather than by spot-checking the
// service whose bug prompted the work.
//
// Before the `anyOfRequired` declarations: 12 of 22. Eight services declared `required: []` because
// they accept alternative input forms, and `shape` read only that list, so their score was 0 forever
// and they could never win. token-scan and wallet-audit were unreachable for a different reason
// found by the same sweep — they share one schema object with tape-pulse.

test('every fixture is a call the service itself would accept', () => {
  // FIRST, because everything below is measured with these bodies. A sweep run on bodies that no
  // service would serve produces a coverage number that means nothing and looks like a result.
  assert.deepEqual(invalidFixtures(), [], 'a fixture no longer validates — fix the fixture, not the assertion');
  assert.equal(Object.keys(GENUINE).length, SERVICES.length, 'a service without a fixture is a service nobody measured');
});

test('each of the eight services that declare no flat required list is reachable, one by one', () => {
  // Asserted PER SERVICE rather than as a total, because a count of 19 can hide the fact that a
  // particular service is still invisible — a partial fix reading as a whole one.
  const reachable = coverageSummary().reachable;
  const declaredAlternatives = ['chart-press', 'calldata-x', 'perp-gate', 'portfolio-gate', 'size-gate', 'lp-risk', 'risk-attest'];
  for (const name of declaredAlternatives) {
    assert.ok(reachable.has(name), `${name} can never be named by the signpost — it declares required:[] and nothing widened it`);
  }
});

test('the services that were already reachable still are', () => {
  const reachable = coverageSummary().reachable;
  // Measured on the pre-change code, not assumed: these twelve could already be named.
  for (const name of ['tape-pulse', 'poly-fill', 'poly-desk', 'options-desk', 'lp-desk', 'protocol-pulse',
    'updown-pulse', 'loop-digest', 'exec-verify', 'options-risk', 'treasury-risk', 'event-vol']) {
    assert.ok(reachable.has(name), `${name} used to be reachable and is not any more`);
  }
});

test('the services a body genuinely cannot single out are named, and are exactly these', () => {
  // An EQUALITY, so this list cannot quietly rot. If one of them becomes reachable the gate fails and
  // somebody has to decide on purpose whether that was earned or is a false positive.
  const reachable = coverageSummary().reachable;
  const unreachable = SERVICES.map((s) => s.name).filter((n) => !reachable.has(n));
  assert.deepEqual(unreachable, UNREACHABLE_BY_SHAPE,
    'the set of services no body can single out has moved; see UNREACHABLE_BY_SHAPE for why each is on the list');
});

test('a correct call to ANY of the twenty-two stays silent, including the eight', () => {
  // THE NEGATIVE THAT MATTERS MOST, and the one the older sweeps could not run. They synthesise a
  // body from `required` and skip a service whose list is empty, so the eight were never tested —
  // and three of them (chart-press, macro-sentry, portfolio-gate) were flagging their own correct
  // calls in production. A signpost on a correct answer makes a right answer look wrong.
  assert.deepEqual(noisyOnCorrectCalls(), [], 'a correct, servable call came back with a redirect notice');
});

// ── the declaration table cannot drift away from the schemas ─────────────────────────────────────
// The alternatives live in routing.js keyed by service name, so that no field is added to a service
// object and nothing can leak into the advertised inputSchema and trigger an OKX re-review. The
// price of that choice is drift, and this is where it is paid.

test('every declared key is a real property of that service', () => {
  const bogus = [];
  for (const [name, forms] of Object.entries(REQUIRED_ALTERNATIVES)) {
    const s = byName(name);
    assert.ok(s, `${name} is declared in the table and is not a service`);
    const props = new Set(Object.keys(s.inputSchema?.properties || {}));
    for (const form of forms) for (const k of form) if (!props.has(k)) bogus.push(`${name}.${k}`);
  }
  assert.deepEqual(bogus, [], 'a declared requirement names a key the service does not accept');
});

test('the table agrees with the schemas that already publish their own alternatives', () => {
  // perp-gate publishes allOf[anyOf…] and portfolio-gate publishes anyOf in the inputSchema a buyer
  // reads. Where the schema already states the fact, the table must state the same fact, or the
  // signpost and the published listing would disagree about what the service needs.
  for (const s of SERVICES) {
    const sc = s.inputSchema || {};
    const groups = [
      ...(Array.isArray(sc.allOf) ? sc.allOf : []),
      ...(Array.isArray(sc.anyOf) ? [{ anyOf: sc.anyOf }] : []),
    ].map((g) => (g.anyOf || []).map((o) => (o.required || []).join('+')).filter(Boolean)).filter((g) => g.length);
    if (!groups.length) continue;

    const forms = requiredAlternatives(s);
    assert.ok(forms.length, `${s.name} publishes alternatives in its schema but the table gives it none`);
    // Every published option must appear in at least one declared form, and every declared form must
    // satisfy every published group.
    for (const group of groups) {
      const options = group.map((g) => g.split('+'));
      for (const form of forms) {
        assert.ok(options.some((opt) => opt.every((k) => form.includes(k))),
          `${s.name}: declared form [${form}] satisfies none of the published options [${group.join(' | ')}]`);
      }
      for (const opt of options) {
        assert.ok(forms.some((form) => opt.every((k) => form.includes(k))),
          `${s.name}: published option ${opt.join('+')} appears in no declared form`);
      }
    }
  }
});

test('a service that declares no flat required list is never left out of the table', () => {
  // The check that survives somebody adding a twenty-third service. Silence is the default for a
  // service with an empty required list, and silence is exactly what nobody notices.
  const missing = SERVICES
    .filter((s) => !(s.inputSchema?.required || []).length)
    .filter((s) => !(s.name in REQUIRED_ALTERNATIVES))
    .map((s) => s.name);
  assert.deepEqual(missing, [], 'declares required:[] and has no entry in REQUIRED_ALTERNATIVES — it can never be suggested');
});

test('a count of matched requirements outranks a vocabulary coincidence', () => {
  // The ranking rule, stated as the case that motivated it. {symbol, notional, leverage} satisfies
  // three of perp-gate's required keys and exactly one of chart-press's; ranking on the blended
  // score alone gave it to chart-press, 3.18 to 3.10, on word overlap.
  const body = { symbol: 'BTC', notional: 60000, leverage: 10 };
  const perp = fitScore(byName('perp-gate'), body);
  const chart = fitScore(byName('chart-press'), body);
  assert.equal(perp.shape, 1, 'perp-gate should see a complete call');
  assert.equal(chart.shape, 1, 'and so should chart-press — both are complete, which is the point');
  assert.ok(perp.satisfied > chart.satisfied, 'perp-gate matched more required keys');
  assert.ok(chart.score > perp.score, 'and still scores lower on the blend — so the blend cannot be the tie-break');
  assert.equal(suggestService(byName('options-desk'), body, SERVICES).service, 'perp-gate',
    'the service with more matched requirements must win');
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
