// GATE G — what envelope each service actually serves, measured by CALLING it, offline.
//
// WHY THIS GATE EXISTS. A sweep classified the catalogue by asking whether each answer carried `proof`
// or `observation`, and got 20 of 22. `chart-press` threw and `poly-fill` returned neither, and both
// were read as facts about those services. Neither was:
//
//   chart-press  is the only handler of the twenty-two that dereferences its SECOND argument, and it
//                did so unguarded (`ctx.host`). A sweep that called `s.run(s.validate(body))` — the
//                natural shape, tolerated by the other twenty-one — got
//                `TypeError: Cannot read properties of undefined (reading 'host')`. Its fixture is
//                valid, its validator accepts it, and both of its input forms answer. The throw was
//                the harness. Guarded in src/services.js; CHECK 2 below is what keeps it guarded.
//   poly-fill    returned the `callerMistake` REFUSAL envelope, which carries neither `proof` nor
//                `observation` on purpose, because the fixture names a market that has resolved.
//                A run-based classification with only two buckets cannot express that answer.
//
// A textual probe was tried first and was WORSE than wrong: grepping the stringified handlers for
// `observationEnvelope` reported 22 of 22 emitting observations, because the call sits in a nested
// helper for several of them. So everything below is BEHAVIOURAL — each service is invoked.
//
// WHY IT RUNS WITH THE NETWORK STUBBED OFF. Half the catalogue reads a live venue. A gate whose colour
// depends on Deribit being up is a gate that goes red for reasons that are not defects, and the first
// spurious red is the last time anyone believes it. `globalThis.fetch` is replaced with an immediate
// rejection, so the table below is a function of THIS TREE and nothing else — and it still separates
// the two classes exactly, because a service that needs the tape either attempts a fetch or does not.
// `netTried` is recorded as a BOOLEAN, never a count: counts move with caching and would make the pin
// flap. The live-venue behaviour of these services is measured, with real fetches, by gates D/D3/D4/S
// and by the judge sweep; what is pinned here is which of them are LIVE AT ALL.
//
// WHAT THE PIN IS FOR. The eight deterministic services are the pool a circuit can ever be wired to,
// and four of them are wired (preflight owns that list). A service moving between the two classes —
// a deterministic one growing a venue read, a live one losing it — is a change in what a buyer must
// trust, and it should cost somebody a red gate rather than passing as a diff nobody read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/services.js';
import { GENUINE, invalidFixtures } from './routing-fixtures.mjs';

const CTX = { host: 'http://gate' };
const UNDEF_PROP = /Cannot read propert(?:y|ies) of (?:undefined|null)/;

/** Replace fetch with an immediate rejection and count the attempts. Restores in a finally. */
async function offline(fn) {
  const real = globalThis.fetch;
  const counter = { tried: 0 };
  globalThis.fetch = (...a) => { counter.tried++; return Promise.reject(new Error('gateG: network disabled')); };
  try { return await fn(counter); } finally { globalThis.fetch = real; }
}

const envelopeOf = (r) => (r?.proof ? 'PROOF' : r?.observation ? 'OBSERVATION' : r?.ok === false ? 'REFUSAL' : 'NEITHER');

// ── CHECK 1. the fixtures are the bodies their own validators accept ─────────────────────────────
// First, because every measurement below is a statement about these bodies. A fixture that has drifted
// from its schema makes the table a fiction, and this is the assertion that makes it fail loudly.
test('gateG/1 every fixture body is accepted by the validator of the service it names', () => {
  const bad = invalidFixtures();
  assert.deepEqual(bad, [], `fixtures no longer validate:\n  ${bad.join('\n  ')}`);
});

// ── CHECK 2. no handler REQUIRES a second argument ────────────────────────────────────────────────
// The defect this gate was written for, stated as the general property rather than as "chart-press
// must say `?.`" — a check spelled as the one fix it knows about cannot catch the second handler that
// grows the same habit. Every service is called with `ctx` OMITTED and must not raise a
// property-of-undefined TypeError. Other rejections are IGNORED on purpose: with the network stubbed
// off, a service that needs the tape rejects with the stub's own error and that says nothing about ctx.
//
// The pattern cannot pass by accident: measured against the unguarded code it names both chart-press
// forms and nothing else, and measured with `ctx` SUPPLIED it names nothing at all across all 31
// forms — so the signal comes from the missing argument and not from calling the handlers.
test('gateG/2 every handler survives its ctx being omitted, on every fixture form', async () => {
  const offenders = await offline(async () => {
    const out = [];
    for (const s of SERVICES) {
      for (const [form, body] of GENUINE[s.name].entries()) {
        const v = s.validate(body);
        if (v?.error) continue;
        try { await s.run(v, undefined); } catch (e) {
          if (UNDEF_PROP.test(String(e?.message || ''))) out.push(`${s.name}#${form}: ${e.message}`);
        }
      }
    }
    return out;
  });
  assert.deepEqual(offenders, [], 'a handler cannot be invoked without a ctx, so a checker that omits '
    + 'one measures a TypeError instead of the service:\n  ' + offenders.join('\n  '));
});

// The companion, and the reason CHECK 2 is not vacuous: with ctx SUPPLIED the same sweep must be
// silent. If it were not, CHECK 2 would be detecting the sweep rather than the missing argument.
test('gateG/3 the same sweep WITH a ctx raises no property-of-undefined at all', async () => {
  const offenders = await offline(async () => {
    const out = [];
    for (const s of SERVICES) {
      for (const [form, body] of GENUINE[s.name].entries()) {
        const v = s.validate(body);
        if (v?.error) continue;
        try { await s.run(v, CTX); } catch (e) {
          if (UNDEF_PROP.test(String(e?.message || ''))) out.push(`${s.name}#${form}: ${e.message}`);
        }
      }
    }
    return out;
  });
  assert.deepEqual(offenders, [], `the ctx-supplied baseline is not clean, so check 2 proves nothing:\n  ${offenders.join('\n  ')}`);
});

// ── CHECK 4. the classification, pinned per (service, input form) ─────────────────────────────────
// PER FORM AND NOT PER SERVICE, because two services answer differently depending on which form they
// were called with, and collapsing that is exactly the error this gate documents:
//
//   perp-gate        #0 is an explicit position and serves a PROOF; #1 is `{symbol, notional,
//                    leverage}` and fetches the mark, so it serves an OBSERVATION.
//   portfolio-gate   #0 is a leg with no `markPrice`, so it ATTEMPTS a venue read. Offline that read
//                    fails, nothing is filled, `legsFetchedLive` reports nothing, and the answer is a
//                    deterministic PROOF over the caller's own numbers — correct, and the reason
//                    `netTried` is recorded next to the envelope rather than instead of it. With the
//                    venue REACHABLE the same body serves an OBSERVATION, and check 5 pins that pair.
//                    #1 is `{account}`, which cannot answer without the book at all.
//
// Written out as an equality over strings rather than as counts, so a service changing class cannot
// pass by arithmetic — the same argument preflight's proof-emitting list is written out for.
const EXPECTED = [
  'tape-pulse#0 OBSERVATION net=none',
  'chart-press#0 OBSERVATION net=tried',
  'chart-press#1 OBSERVATION net=none',
  'poly-fill#0 THREW net=tried',
  'poly-desk#0 OBSERVATION net=tried',
  'options-desk#0 THREW net=tried',
  'lp-desk#0 OBSERVATION net=tried',
  'calldata-x#0 OBSERVATION net=none',
  'calldata-x#1 OBSERVATION net=none',
  'protocol-pulse#0 OBSERVATION net=tried',
  'macro-sentry#0 OBSERVATION net=none',
  'macro-sentry#1 OBSERVATION net=none',
  'updown-pulse#0 OBSERVATION net=tried',
  'loop-digest#0 OBSERVATION net=none',
  'token-scan#0 OBSERVATION net=none',
  'wallet-audit#0 OBSERVATION net=none',
  'perp-gate#0 PROOF net=none',
  'perp-gate#1 OBSERVATION net=tried',
  'portfolio-gate#0 PROOF net=tried',
  'portfolio-gate#1 THREW net=tried',
  'size-gate#0 PROOF net=none',
  'size-gate#1 PROOF net=none',
  'exec-verify#0 PROOF net=none',
  'exec-verify#1 PROOF net=none',
  'options-risk#0 PROOF net=none',
  'lp-risk#0 PROOF net=none',
  'lp-risk#1 PROOF net=none',
  'treasury-risk#0 PROOF net=none',
  'risk-attest#0 PROOF net=none',
  'risk-attest#1 PROOF net=none',
  'event-vol#0 PROOF net=none',
];

async function table() {
  return offline(async (counter) => {
    const rows = [];
    for (const s of SERVICES) {
      for (const [form, body] of GENUINE[s.name].entries()) {
        const v = s.validate(body);
        if (v?.error) { rows.push(`${s.name}#${form} VALIDATE-REFUSED net=none`); continue; }
        counter.tried = 0;
        let label;
        try { label = envelopeOf(await s.run(v, CTX)); } catch { label = 'THREW'; }
        rows.push(`${s.name}#${form} ${label} net=${counter.tried > 0 ? 'tried' : 'none'}`);
      }
    }
    return rows;
  });
}

test('gateG/4 the envelope each service serves, per input form, is the table that has been read', async () => {
  const rows = await table();
  assert.equal(rows.length, EXPECTED.length, `the fixture set changed size: ${rows.length} forms, table has ${EXPECTED.length}`);
  assert.deepEqual(rows, EXPECTED, 'a service changed which envelope it serves, or whether it reads a venue at all — '
    + 'either is a change in what a buyer must trust, and it needs deciding rather than inheriting');
});

// The counts, derived from the SAME table rather than typed twice, because two figures for one fact is
// how four reports came to disagree with their own artifacts.
test('gateG/5 exactly eight services can answer with no venue read, and they are the deterministic pool', async () => {
  const rows = await table();
  const det = [...new Set(rows.filter((r) => / PROOF net=none$/.test(r)).map((r) => r.split('#')[0]))].sort();
  assert.deepEqual(det, ['event-vol', 'exec-verify', 'lp-risk', 'options-risk', 'perp-gate', 'risk-attest', 'size-gate', 'treasury-risk'],
    `the deterministic pool moved: [${det.join(', ')}]`);
  const live = [...new Set(rows.filter((r) => / net=tried$/.test(r)).map((r) => r.split('#')[0]))].sort();
  // portfolio-gate and perp-gate appear in BOTH lists, on different forms. That is the finding, not a bug.
  assert.deepEqual(live, ['chart-press', 'lp-desk', 'options-desk', 'perp-gate', 'poly-desk', 'poly-fill', 'portfolio-gate', 'protocol-pulse', 'updown-pulse'],
    `the venue-reading set moved: [${live.join(', ')}]`);
  assert.deepEqual([...new Set(rows.filter((r) => / PROOF /.test(r)).map((r) => r.split('#')[0]))].sort().filter((n) => live.includes(n)),
    ['perp-gate', 'portfolio-gate'],
    'exactly two services serve a proof on one form and read a venue on another — a third would need its own paragraph');
});

// ── CHECK 6. portfolio-gate is a HYBRID, and this is the pair that shows it ───────────────────────
// The fact the classification got wrong, pinned with real network. `portfolio-gate` was filed as an
// observation service "because it reads live venue data", while `zk/circuits/portfolioleg.circom`
// exists for it and publishes the adverse-distance numerator and the mark as public signals 2 and 9.
// Both are true of DIFFERENT BRANCHES: a leg missing `markPrice` has one fetched and the answer is
// routed to the observation envelope by `legsFetchedLive`; a fully supplied leg reaches no venue and
// serves a deterministic proof envelope. Which the caller gets is a property of the BODY.
//
// This is the one check here that touches the network, because "reaches no venue" is only worth
// asserting where a venue was reachable. It asserts the DETERMINISTIC half only — zero fetch attempts,
// proof envelope, no `live` block — so a Hyperliquid outage cannot make it red for the wrong reason.
test('gateG/6 a fully supplied portfolio-gate book reaches no venue and serves a proof envelope', async () => {
  const pg = SERVICES.find((s) => s.name === 'portfolio-gate');
  const body = { positions: [
    { venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 60000, markPrice: 61000, margin: 6000, maintMarginRate: 0.0125 },
    { venue: 'dydx', asset: 'SOL', side: 'long', size: 100, entryPrice: 150, markPrice: 148, margin: 1500, maintMarginRate: 0.03 },
  ] };
  const real = globalThis.fetch;
  let tried = 0;
  globalThis.fetch = (...a) => { tried++; return real(...a); };
  let r;
  try { r = await pg.run(pg.validate(body), CTX); } finally { globalThis.fetch = real; }
  assert.equal(tried, 0, `a fully supplied book attempted ${tried} venue read(s) — the deterministic branch is not deterministic`);
  assert.ok(r.proof, `a fully supplied book served ${envelopeOf(r)} rather than a proof envelope`);
  assert.equal(r.proof.deterministic, true, 'the proof envelope does not claim determinism');
  assert.equal(r.live, undefined, `a book that fetched nothing disclosed a live read: ${JSON.stringify(r.live)}`);
  // The identity a circuit would certify, read off the engine's own output rather than recomputed:
  // the ranking is on `liquidation.moveToLiqPct` per leg, which is portfolioleg.circom's dOut/refHat.
  const ranked = r.positions.map((p) => p.liquidation.moveToLiqPct);
  assert.equal(r.nearestLiquidation.moveToLiquidationPct, Math.min(...ranked),
    'nearestLiquidation is not the minimum of the per-leg distances the circuit publishes');
});

// ── CHECK 7. REFUSAL is a THIRD outcome, and it carries neither envelope ──────────────────────────
// Driven through tape-pulse's chain/address mismatch, which is decided before any fetch, so this is a
// statement about the envelope shape and not about anybody's uptime. poly-fill reaches the same
// `callerMistake` shape through a resolved market — the answer that read as "neither" — and a sweep
// that cannot name this outcome will keep finding it, because markets keep resolving.
test('gateG/7 a callerMistake refusal carries neither proof nor observation, by design', async () => {
  const tp = SERVICES.find((s) => s.name === 'tape-pulse');
  const r = await offline(() => tp.run(tp.validate({ chain: 'solana', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' }), CTX));
  assert.equal(envelopeOf(r), 'REFUSAL', `expected the refusal envelope, got ${envelopeOf(r)}`);
  assert.equal(r.ok, false);
  assert.equal(r.proof, undefined);
  assert.equal(r.observation, undefined);
  assert.ok(Array.isArray(r.errors) && r.errors.length, 'a refusal with no sentence in it teaches nothing');
  assert.ok(r.howToFix, 'a refusal must carry the body that would have worked');
});
