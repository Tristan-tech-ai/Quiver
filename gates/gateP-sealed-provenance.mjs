// GATE P2 — nothing that was FETCHED may be sealed inside an envelope that claims to be re-runnable.
//
// THE DEFECT THIS GATE OWNS. `portfolio-gate` in explicit-positions mode fetches a live Hyperliquid
// mark for any leg that names an asset without one, and shipped that number inside `proof.inputs`
// under `deterministic: true`, with no `observedAtUtc`, no source and no `live` block. A caller
// comparing their request against the echoed inputs found a value they never sent, from nowhere,
// sealed as reproducible. §11.5 and §11.6 of the paper record finding and fixing exactly this on
// `perp-gate` symbol mode; portfolio-gate was the branch next door, which is where this codebase's
// defects keep turning out to live.
//
// WHY IT IS SWEPT OVER ALL 22 AND BOTH SURFACES. The same defect has now been found four times at
// four call sites — three handlers and the free MCP path — and each fix was a fix at the site where
// it had been demonstrated. `proofEnvelope` already refuses to seal a result carrying `live`, so the
// rule is enforced centrally; what no check covered is whether a handler DISCLOSES the read in the
// first place. That is a property of every handler, so it is measured on every handler.
//
// THE LOAD-BEARING CHECK IS THE PATH DIFF, NOT THE FETCH COUNT, and the reason is measured rather
// than assumed. Instrumenting `globalThis.fetch` looks like the direct way to ask "was this value
// fetched?" — but the Hyperliquid adapter caches, so in the pre-fix sweep `portfolio-gate#0` issued
// ZERO fetches (perp-gate's symbol fixture had already warmed the cache two services earlier) while
// still carrying a fetched `markPrice: 63815` under `deterministic: true`. A fetch counter would have
// reported that call clean. So the fetch instrumentation below is kept as a second, weaker signal and
// is named as such; the assertion that can actually fail is the structural one: every leaf path
// echoed in a deterministic envelope's `inputs` must be a path the caller supplied a real value for.
//
//   node --test gates/gateP-sealed-provenance.mjs        (npm run gate:p2)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/services.js';
import { TOOLS } from '../src/mcp.js';
import { GENUINE } from './routing-fixtures.mjs';

// ── the sweep ─────────────────────────────────────────────────────────────────────────────────────

/** Every leaf path of a value, `a.b[0].c` style. */
function leafPaths(v, prefix = '', out = []) {
  if (v == null || typeof v !== 'object') { out.push({ path: prefix, value: v }); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => leafPaths(x, `${prefix}[${i}]`, out)); return out; }
  for (const k of Object.keys(v)) leafPaths(v[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/**
 * Paths the CALLER actually supplied a value for. A path whose value is null or undefined is not a
 * supplied value — the enrichers fill exactly those — so counting it as sent would leave a fetched
 * number free to ride inside a key the caller technically typed, which is the one way this check
 * could be evaded.
 */
const suppliedPaths = (body) => new Set(leafPaths(body).filter((p) => p.value != null).map((p) => p.path));

const realFetch = globalThis.fetch;
const rows = [];
for (const s of SERVICES) {
  for (const [i, body] of (GENUINE[s.name] || []).entries()) {
    let fetches = 0;
    globalThis.fetch = (...a) => { fetches++; return realFetch(...a); };
    let out = null, err = null;
    try { out = await s.run(s.validate(body), { host: 'http://gate' }); } catch (e) { err = String(e.message || e).slice(0, 90); }
    globalThis.fetch = realFetch;
    rows.push({ surface: 'http', name: s.name, form: i, body, out, err, fetches });
  }
}
for (const t of TOOLS) {
  const svcName = t.name.replace(/_/g, '-');
  for (const [i, body] of (GENUINE[svcName] || []).entries()) {
    let fetches = 0;
    globalThis.fetch = (...a) => { fetches++; return realFetch(...a); };
    let out = null, err = null;
    try { out = await t.run(body); } catch (e) { err = String(e.message || e).slice(0, 90); }
    globalThis.fetch = realFetch;
    rows.push({ surface: 'mcp', name: t.name, form: i, body, out, err, fetches });
  }
}
const id = (r) => `${r.surface}:${r.name}#${r.form}`;
const envelope = (r) => r.out?.proof || r.out?.observation || null;
const sealed = rows.filter((r) => envelope(r)?.deterministic === true);

// ── 1. the check that would have caught it ────────────────────────────────────────────────────────

test('no envelope claiming deterministic:true echoes a value the caller did not supply', () => {
  const offenders = [];
  for (const r of sealed) {
    const sent = suppliedPaths(r.body);
    const extra = leafPaths(envelope(r).inputs).map((p) => p.path).filter((p) => !sent.has(p));
    if (extra.length) offenders.push(`${id(r)} sealed ${extra.slice(0, 4).join(', ')} — not sent by the caller`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

test('this sweep actually reached the surfaces it claims to cover', () => {
  // Asserted BEFORE the numbers above are believed. The failure mode this codebase keeps finding is a
  // check that swept an empty set and reported success over nothing.
  for (const surface of ['http', 'mcp']) {
    const n = rows.filter((r) => r.surface === surface).length;
    assert.ok(n > 0, `${surface}: no handler was called at all`);
  }
  assert.equal(new Set(rows.filter((r) => r.surface === 'http').map((r) => r.name)).size, SERVICES.length,
    'every one of the twenty-two must have been run, not a subset with a fixture');
  assert.equal(new Set(rows.filter((r) => r.surface === 'mcp').map((r) => r.name)).size, TOOLS.length,
    'and every MCP tool');
  assert.ok(sealed.length >= 20, `only ${sealed.length} deterministic envelopes were produced — the check above swept almost nothing`);
});

test('the set of envelopes claiming determinism is the set that has been decided on purpose', () => {
  // An equality, not a floor. A handler that starts or stops claiming determinism is a caller-visible
  // change to what a buyer is being promised, and it should require someone to edit this list.
  const claim = sealed.map(id).sort();
  assert.deepEqual(claim, [
    'http:event-vol#0', 'http:exec-verify#0', 'http:exec-verify#1', 'http:lp-risk#0', 'http:lp-risk#1',
    'http:options-risk#0', 'http:perp-gate#0', 'http:risk-attest#0', 'http:risk-attest#1',
    'http:size-gate#0', 'http:size-gate#1', 'http:treasury-risk#0',
    'mcp:event_vol#0', 'mcp:exec_verify#0', 'mcp:exec_verify#1', 'mcp:lp_risk#0', 'mcp:lp_risk#1',
    'mcp:options_risk#0', 'mcp:perp_gate#0', 'mcp:risk_attest#0', 'mcp:risk_attest#1',
    'mcp:size_gate#0', 'mcp:size_gate#1', 'mcp:treasury_risk#0',
  ].sort(),
  'portfolio-gate form 0 is the fixture whose legs are enriched from the venue; it must NOT be in this list');
});

// ── 2. the specific call the defect was reported on ───────────────────────────────────────────────

test('a portfolio-gate leg whose mark came from the venue ships an observation, on BOTH surfaces', () => {
  const enriched = rows.filter((r) => /portfolio.gate/.test(r.name) && r.form === 0);
  assert.equal(enriched.length, 2, 'the fixture must have been run on the paid surface AND the free one');
  for (const r of enriched) {
    // If the venue was unreachable nothing was filled, and this gate would be certifying a network
    // outage rather than a fix. Said out loud rather than skipped.
    assert.ok(r.out?.live?.filled?.length,
      `${id(r)}: the venue read did not happen, so this gate proved nothing — check network reachability`);
    assert.ok(r.out.observation, `${id(r)}: a fetched mark must ship an observation envelope`);
    assert.equal(r.out.proof, undefined, `${id(r)}: and never a proof envelope`);
    assert.equal(r.out.observation.deterministic, false);
    assert.ok(r.out.observation.observedAtUtc, `${id(r)}: with the instant the venue was read`);
    assert.equal(r.out.observation.kind, 'OBSERVATION');
    // The disclosure has to name the value, not merely admit that something happened.
    assert.ok(r.out.live.filled[0].fetched.markPrice > 0, `${id(r)}: the fetched mark must be named`);
    assert.ok(r.out.live.filled[0].venue, `${id(r)}: with the venue it came from`);
    assert.match(r.out.mathReproducibility, /not re-runnable is the venue read/i);
  }
});

test('a portfolio-gate call that supplies every leg value stays a deterministic proof', () => {
  // The other direction, and the one that would break every published proof if it went wrong.
  // Run inline rather than from the fixture table because the point is the CONTRAST with the row above.
  const svc = SERVICES.find((s) => s.name === 'portfolio-gate');
  const body = { positions: [{ venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 100000, markPrice: 100000, leverage: 10, maxLeverage: 40 }] };
  return Promise.all([svc.run(svc.validate(body), {}), svc.run(svc.validate(body), {})]).then(([a, b]) => {
    assert.ok(a.proof, 'nothing was fetched, so this really is re-runnable');
    assert.equal(a.proof.deterministic, true);
    assert.equal(a.live, undefined, 'and it must not grow a live block it did not earn');
    assert.equal(a.proof.contentHash, b.proof.contentHash, 'and its content hash must be stable across calls');
  });
});

test('the enricher cannot fill a field the disclosure does not know how to name', async () => {
  // legsFetchedLive names an explicit field list. A field added to the enricher and not to that list
  // would be filled and never disclosed, which is this defect again with a different key. Asserted
  // against the enricher's own behaviour: hand it a leg with nothing and see what comes back.
  const { enrichPortfolioLegs } = await import('../src/adapters/hyperliquid.js');
  const [leg] = await enrichPortfolioLegs([{ venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1 }]);
  const KNOWN = new Set(['venue', 'asset', 'side', 'size', 'markPrice', 'entryPrice', 'maintMarginRate', 'maxLeverage', 'marginTiers']);
  const undisclosed = Object.keys(leg).filter((k) => !KNOWN.has(k));
  assert.deepEqual(undisclosed, [], `the enricher now fills ${undisclosed.join(', ')}, which legsFetchedLive will not report`);
});

// ── 3. the weaker signal, kept and named ──────────────────────────────────────────────────────────

test('the fetch instrumentation is live, and is reported for what it is worth', () => {
  // Kept because it is a genuinely independent signal, and reported honestly because a warm adapter
  // cache makes it silent: measured pre-fix, portfolio-gate#0 issued 0 fetches while carrying a
  // fetched mark. It can catch a NEW handler that fetches and seals on a cold cache; it cannot be
  // trusted to catch one on a warm one, which is why the path diff above is the assertion.
  const anyFetched = rows.some((r) => r.fetches > 0);
  assert.ok(anyFetched, 'no row issued a single upstream fetch — the instrumentation is not wired to anything');
  const sealedWithFetch = sealed.filter((r) => r.fetches > 0).map(id);
  assert.deepEqual(sealedWithFetch, [],
    `these claimed determinism on a run that went to the network: ${sealedWithFetch.join(', ')}`);
});
