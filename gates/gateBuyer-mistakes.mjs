// GATE: the buyer-mistake scenarios, end to end.
//
// Only agents review in a loop, and an agent's mistakes are a small repeatable set rather than an
// endless variety. So each one gets a scenario here and a decided answer: repair it and say so, or
// refuse it and hand back the exact call that would have worked. Nothing in between, and nothing
// silent.
//
// Every scenario is written from the caller's side — the literal body an agent would send — because a
// test that constructs the already-repaired body proves nothing about the repair.
//
//   node --test gates/gateBuyer-mistakes.mjs        (npm run gate:buyer)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/services.js';
import { repairBody, correctedExample } from '../src/util/repair.js';
import { suggestService } from '../src/util/routing.js';

const svc = (n) => SERVICES.find((s) => s.name === n);

/** What the service boundary does with a body: repair it, then validate it, then explain. */
function handle(service, raw) {
  const { body, repairs, missing } = repairBody(service, raw);
  const v = service.validate(body);
  if (v.error) {
    return {
      served: false, repairs,
      redirect: suggestService(service, body, SERVICES),
      teach: correctedExample(service, body, missing),
      error: v.error,
    };
  }
  return { served: true, repairs, input: v, redirect: suggestService(service, body, SERVICES) };
}

// ── Repairable: the caller plainly meant something, and the shape is unambiguous ──────────────────

test('params nested under a framework wrapper are unwrapped', () => {
  const r = handle(svc('protocol-pulse'), { params: { protocol: 'aave' } });
  assert.equal(r.served, true, 'a wrapped body is a shape problem, not a missing-value problem');
  assert.ok(r.repairs.some((x) => x.kind === 'unwrapped'), 'and the caller must be told it was unwrapped');
});

test('a wrapper key that is NOT alone is left alone', () => {
  // `{protocol, data}` is a real body with a field called data, not a wrapper. Unwrapping it would
  // throw away the caller's actual parameters.
  const r = handle(svc('protocol-pulse'), { protocol: 'aave', data: { something: 1 } });
  assert.equal(r.repairs.some((x) => x.kind === 'unwrapped'), false);
  assert.equal(r.served, true);
});

test('numbers sent as strings are read as numbers', () => {
  const r = handle(svc('perp-gate'), {
    side: 'long', entryPrice: '64000', size: '1.5', leverage: '10', maintMarginRate: '0.005',
  });
  assert.equal(r.served, true);
  const parsed = r.repairs.filter((x) => x.kind === 'parsed');
  assert.ok(parsed.length >= 4, `every numeric string should be reported, got ${parsed.length}`);
  assert.equal(typeof r.input.entryPrice, 'number');
});

test('a number that is NOT plainly a number is refused, not guessed', () => {
  // "64,000" and "64k" each have more than one reading. Parsing them would be deciding on the
  // caller's behalf what their position size is, which is exactly the kind of guess that produces a
  // confident wrong answer.
  for (const bad of ['64,000', '64k', '$64000', '6.4e4x']) {
    const { body, repairs } = repairBody(svc('perp-gate'), { entryPrice: bad });
    assert.equal(typeof body.entryPrice, 'string', `${bad} must not be parsed`);
    assert.equal(repairs.some((x) => x.kind === 'parsed'), false);
  }
});

test('a mis-cased key is matched to the one the service declares', () => {
  const r = handle(svc('protocol-pulse'), { Protocol: 'aave' });
  assert.equal(r.served, true);
  assert.ok(r.repairs.some((x) => x.kind === 'recased' && x.note.includes('Protocol')));
});

test('a common synonym is accepted where it is unambiguous', () => {
  const r = handle(svc('token-scan'), { chain: 'ethereum', token: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984' });
  assert.equal(r.served, true, '"token" for "address" is a synonym a human would accept without thinking');
  assert.ok(r.repairs.some((x) => x.kind === 'aliased'));
});

test('an alias never overwrites a value the caller actually supplied', () => {
  const { body, repairs } = repairBody(svc('token-scan'), { chain: 'base', address: '0xAAA', token: '0xBBB' });
  assert.equal(body.address, '0xAAA', 'the canonical key wins; the alias is not applied over it');
  assert.equal(repairs.some((x) => x.kind === 'aliased'), false);
});

// ── Not repairable: refuse, and teach ─────────────────────────────────────────────────────────────

test('a missing required field is never filled in', () => {
  const r = handle(svc('perp-gate'), { side: 'long', entryPrice: 64000 });
  assert.equal(r.served, false, 'inventing a position size would be worse than refusing');
  assert.equal(r.teach.send.body.entryPrice, 64000, 'the values the caller DID give are kept');
  assert.match(JSON.stringify(r.teach.send.body), /</, 'and the gaps are visible placeholders, not defaults');

  // NOT `missing.length > 0`, which is what this line said first and which is an assumption about
  // schema shape rather than a requirement. perp-gate declares no `required` at all: its rule is
  // "margin OR leverage, and mmr OR maxLeverage OR symbol", which lives in the validator function and
  // in prose. So nothing is formally missing even though the call is refused, and the real
  // requirement is that the reply be ACTIONABLE either way.
  const actionable = r.teach.missing.length > 0 || Object.keys(r.teach.send.body).length >= 3;
  assert.ok(actionable, 'a refusal must name what is missing or show a complete call, and this one shows one');
  assert.ok(r.error, 'and the validator\'s own words are still passed through, since they hold the real rule');
});

test('a refusal is actionable for every one of the twenty-two', () => {
  // Swept, because the failure above was specific to how one service declares itself and there was no
  // reason to think it was the only one. A refusal that shows an empty body teaches nothing.
  const useless = [];
  for (const s of SERVICES) {
    const { body, missing } = repairBody(s, {});
    const teach = correctedExample(s, body, missing);
    const fields = Object.keys(teach.send.body).length;
    if (fields === 0) useless.push(s.name);
  }
  assert.deepEqual(useless, [], `these refuse without showing what to send: ${useless.join(', ')}`);
});

test('an empty body gets the corrected call, not a guess', () => {
  // The marketplace funnel has been seen replaying an empty body. There is no intent to recover here,
  // so the only useful answer is a complete example of what to send.
  const r = handle(svc('protocol-pulse'), {});
  assert.equal(r.served, false);
  assert.equal(r.redirect, null, 'an empty body must not be routed anywhere, since it says nothing');
  assert.equal(r.teach.send.url, '/api/protocol-pulse');
  assert.ok(String(r.teach.send.body.protocol).startsWith('<'), 'a placeholder, not a plausible default');
});

test('prose with no parameters is refused with the shape it should have had', () => {
  const r = handle(svc('perp-gate'), { question: 'what is my liquidation price if BTC drops' });
  assert.equal(r.served, false, 'parsing prose into a position would be inventing the position');
  assert.ok(r.teach.send.body.side, 'the reply still shows exactly what a valid call looks like');
});

// ── Mis-routed: the request is fine, the shop is wrong ────────────────────────────────────────────

test('the two half-star calls both get a signpost', () => {
  const refused = handle(svc('options-desk'), { protocol: 'aave' });
  assert.equal(refused.served, false);
  assert.equal(refused.redirect.service, 'protocol-pulse');

  const succeeded = handle(svc('options-desk'), { currency: 'BTC', protocol: 'aave' });
  assert.equal(succeeded.served, true, 'this one really does succeed, which is what made it dangerous');
  assert.equal(succeeded.redirect.service, 'protocol-pulse');
});

test('a repaired body is routed on what it MEANT, not on what arrived', () => {
  // The wrapper hid the mis-route: before unwrapping, the body's only key is `params`, which matches
  // nothing anywhere. Repair has to happen before routing or the signpost never fires.
  const r = handle(svc('options-desk'), { params: { protocol: 'aave' } });
  assert.ok(r.redirect, 'a wrapped mis-route is still a mis-route');
  assert.equal(r.redirect.service, 'protocol-pulse');
});

// ── The half that can fail ────────────────────────────────────────────────────────────────────────

test('every service still serves its own correct call, unrepaired and unflagged', () => {
  const problems = [];
  for (const s of SERVICES) {
    const req = s.inputSchema?.required || [];
    if (!req.length) continue;
    const props = s.inputSchema.properties || {};
    const body = {};
    for (const k of req) {
      const p = props[k] || {};
      body[k] = Array.isArray(p.enum) ? p.enum[0]
        : p.type === 'number' || p.type === 'integer' ? 1
        : p.type === 'boolean' ? true
        : p.type === 'array' ? []
        : p.type === 'object' ? {}
        : 'x';
    }
    const { repairs } = repairBody(s, body);
    if (repairs.length) problems.push(`${s.name} repaired a correct body: ${repairs.map((x) => x.note).join('; ')}`);
    if (suggestService(s, body, SERVICES)) problems.push(`${s.name} redirected its own correct body`);
  }
  assert.deepEqual(problems, [], problems.join(' | '));
});

test('repairs are never silent', () => {
  // The whole safety of this layer rests on the caller being able to see what was changed. A repair
  // that happens without a report is a coercion, and a coercion is how a caller gets billed for an
  // answer about something they did not describe.
  const cases = [
    [svc('protocol-pulse'), { params: { protocol: 'aave' } }],
    [svc('protocol-pulse'), { Protocol: 'aave' }],
    [svc('perp-gate'), { side: 'long', entryPrice: '64000', size: '1.5', leverage: '10', maintMarginRate: '0.005' }],
    [svc('token-scan'), { chain: 'base', token: '0xAAA' }],
  ];
  for (const [s, raw] of cases) {
    const { body, repairs } = repairBody(s, raw);
    assert.ok(repairs.length > 0, `a body that changed must report it: ${JSON.stringify(raw)}`);
    assert.notDeepEqual(body, raw, 'and a report must correspond to a real change');
  }
});

test('repair never invents a key the caller did not send', () => {
  for (const s of SERVICES) {
    const { body } = repairBody(s, { somethingUnrelated: 1 });
    const invented = Object.keys(body).filter((k) => k !== 'somethingUnrelated');
    assert.deepEqual(invented, [], `${s.name} invented ${invented.join(', ')}`);
  }
});
