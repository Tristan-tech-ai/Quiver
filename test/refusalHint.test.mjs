// Every refusal must teach: a caller that hit the wrong service, or whose params were dropped in
// transit, must be able to self-correct from the rejection alone. These FAIL on the pre-fix code,
// where a refusal was a bare string like "require { protocol }" with no service identity or shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES, inputHint, refusalDetail } from '../src/services.js';

test('every service produces a hint that names itself and says what it does', () => {
  for (const s of SERVICES) {
    const h = inputHint(s);
    assert.ok(h.startsWith(s.name), `${s.name}: hint must lead with the service name`);
    assert.ok(h.length > s.name.length + 20, `${s.name}: hint is too thin to be useful`);
    assert.ok(h.length <= 400, `${s.name}: hint must stay bounded`);
  }
});

test('the hint carries the input shape a caller has to send', () => {
  const hint = (n) => inputHint(SERVICES.find((s) => s.name === n));
  // required-list services name their required keys...
  assert.match(hint('protocol-pulse'), /requires \{ "protocol"/);
  assert.match(hint('protocol-pulse'), /aave/, 'the schema example survives into the refusal');
  // ...OR-constrained services explain the alternatives instead of a bare required list
  assert.match(hint('perp-gate'), /entryPrice OR symbol|price:/i);
  assert.match(hint('portfolio-gate'), /positions OR account|positions/);
});

test('refusalDetail appends the hint, but never duplicates a message that already routes', () => {
  const pp = SERVICES.find((s) => s.name === 'protocol-pulse');
  const od = SERVICES.find((s) => s.name === 'options-desk');

  const terse = refusalDetail(pp, 'require { protocol }');
  assert.match(terse, /require \{ protocol \}/, 'keeps the original verdict');
  assert.match(terse, /protocol-pulse —/, 'adds identity + shape');

  // options-desk already names itself and points at the right service; no redundant tail.
  const rich = refusalDetail(od, od.validate({ currency: 'aave' }).error);
  assert.match(rich, /protocol-pulse/, 'still routes the caller');
  assert.equal(rich.split('options-desk').length - 1, 1, 'service named exactly once, no duplicated hint');
});

test('a dropped-params call on ANY service refuses with a self-teaching message', () => {
  for (const s of SERVICES) {
    if (typeof s.validate !== 'function') continue;
    let v;
    try { v = s.validate({}); } catch { continue; }
    if (!v || !v.error) continue; // empty body is legitimately valid for this service
    const detail = refusalDetail(s, v.error);
    assert.ok(detail.includes(s.name), `${s.name}: refusal must identify the service`);
    assert.ok(detail.length > 40, `${s.name}: refusal must be actionable, got "${detail}"`);
  }
});
