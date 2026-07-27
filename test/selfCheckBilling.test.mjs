// Payment-surface audit finding: `ok:true` was decoupled from `allSelfChecksPass:false`, so a caller
// paid for an answer the engine itself had already flagged as unproven. Each test below FAILS on the
// pre-fix `isChargeable` (which returned true for anything whose `ok` was not literally false).
//
// The fixtures are the LIVE response shapes, captured from the deployed service on build
// q1-3af04b595f397b54 through the free MCP path — not benign synthetics. A lock built from an
// invented shape is how a test comes to pass against the code it was written to reject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isChargeable } from '../src/x402.js';

// lp-risk {"priceRatio": 1e308} — the engine sanitizes to null and its boundedness check correctly
// fires, because the served IL of -100% is EXCLUDED from the promised (-100%, 0] range.
const LP_RISK_OVERFLOW = {
  ok: true,
  concentrationFactor: 1,
  realizedIL: { priceRatio: 1e308, impermanentLossPct: -100, usd: null },
  checks: [
    { name: 'IL identity: closed form 2√r/(1+r)−1 == explicit constant-product token value', residual: 0, pass: true },
    { name: 'E[IL] check: −σ²T/8 == numerical E[IL] at σ²T=0.01', residual: 7.81e-7, tolerance: 0.0001, pass: true },
    { name: 'boundedness: reported realized IL lies in (-100%, 0], amplified or not', residual: -100, pass: false },
  ],
  proof: { engine: 'lp-risk', codeHash: 'q1-3af04b595f397b54', allSelfChecksPass: false },
};

// perp-gate at 1e308 — every headline number is null, yet the response still asserts a positive
// verdict, and the liquidation-invariant check could not evaluate at all (residual and tolerance null).
const PERP_GATE_OVERFLOW = {
  ok: true,
  liquidationPrice: null,
  moveToLiquidationPct: null,
  positionStatus: 'ABOVE_MAINTENANCE',
  effectiveLeverage: null,
  checks: [
    { name: 'liquidation-invariant: account_value(P_liq) == maintenance_margin(P_liq)', residual: null, tolerance: null, pass: false },
  ],
  proof: { engine: 'perp-gate', codeHash: 'q1-3af04b595f397b54', allSelfChecksPass: false },
};

test('a failed self-check is served but NOT billed — lp-risk overflow', () => {
  assert.equal(isChargeable(LP_RISK_OVERFLOW), false,
    'the engine published allSelfChecksPass:false; charging for it takes money for a number we refused to stand behind');
});

test('a failed self-check is served but NOT billed — perp-gate overflow', () => {
  assert.equal(isChargeable(PERP_GATE_OVERFLOW), false,
    'every headline field is null and the invariant could not be evaluated; that is not a delivered result');
});

// The branch next door. This exact pattern — a fix that holds only on the path the reviewer walked —
// has recurred three times in this project, so the observation envelope is locked alongside the proof
// envelope rather than assumed to follow.
test('the rule holds on an OBSERVATION envelope, not only on a proof envelope', () => {
  const liveRead = {
    ok: true,
    verdict: 'ABOVE_MAINTENANCE',
    checks: [{ name: 'liquidation-invariant', residual: null, pass: false }],
    observation: { engine: 'perp-gate', kind: 'OBSERVATION', observedAtUtc: '2026-07-27T08:00:00.000Z', allSelfChecksPass: false },
  };
  assert.equal(isChargeable(liveRead), false);
});

test('the rule holds when the envelope is absent and only raw checks are present', () => {
  assert.equal(isChargeable({ ok: true, checks: [{ name: 'x', pass: false }] }), false,
    'the envelope is a presentation layer; a failed check is a failed check without it');
});

// Guards against the fix over-reaching. A billing rule that refuses everything would also "pass" the
// four tests above, so these are the half that stops this lock from being vacuous.
test('a delivered answer whose checks all pass is still charged', () => {
  assert.equal(isChargeable({
    ok: true,
    liquidationPrice: 58329.11,
    checks: [{ name: 'liquidation-invariant', residual: 2.05e-12, tolerance: 0.064, pass: true }],
    proof: { engine: 'perp-gate', allSelfChecksPass: true },
  }), true);
});

test('an answer carrying no self-checks at all is still charged', () => {
  assert.equal(isChargeable({ verdict: 'CLEAN' }), true, 'no checks = nothing failed');
  assert.equal(isChargeable({ ok: true, hasEdge: false }), true, 'a valid negative verdict is a delivered answer');
  assert.equal(isChargeable({ ok: true, checks: [], proof: { allSelfChecksPass: null } }), true,
    'allSelfChecksPass is null (not false) when an engine publishes no checks — null must not read as failure');
  assert.equal(isChargeable(null), true, 'defensive: never skip settlement on a malformed result');
});

// The pre-existing contract must survive the change.
test('ok:false remains free', () => {
  assert.equal(isChargeable({ ok: false, errors: ['bad input'] }), false);
});
