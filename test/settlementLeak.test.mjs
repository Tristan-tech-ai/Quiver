// Day-2/3 buyer-desk findings (BUG_REPORT.md Q-11 / Q-12): the ~7% settlement leak and the
// silently-empty loop-digest read. Each test FAILS on the pre-fix code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleDecision } from '../src/x402.js';
import { loopDigest } from '../src/engine/loopDigest.js';

// Q-12 — success:true without a transaction hash is the empirically-never-lands cohort
// (68/68 desk calls, 0.68 USDT never arrived). It must NEVER be accepted as settled outright.
test('Q-12 settleDecision: success without a transaction is retry, never settled', () => {
  assert.equal(settleDecision({ success: true, status: 'timeout' }), 'retry');
  assert.equal(settleDecision({ success: 'true', status: 'unknown' }), 'retry');
});

test('Q-12 settleDecision: a transaction hash or a confirmed status settles', () => {
  assert.equal(settleDecision({ success: true, status: 'timeout', transaction: '0xabc' }), 'settled');
  assert.equal(settleDecision({ success: true, status: 'settled' }), 'settled');
  assert.equal(settleDecision({ status: 'confirmed', txHash: '0xdef' }), 'settled');
  assert.equal(settleDecision({ status: 'confirmed' }), 'settled', 'an explicit confirmed status is the facilitator asserting finality');
});

test('Q-12 settleDecision: an outright failure is failed (existing 402 path)', () => {
  assert.equal(settleDecision({ success: false, status: 'failed', errorReason: 'insufficient balance' }), 'failed');
  assert.equal(settleDecision({}), 'failed');
});

// Q-11 — a zero-row history read is zero information: it must say so and be free (ok:false),
// not a paid "empty diff" that reads like a real answer.
test('Q-11 loop-digest: empty read => ok:false NO_DATA with an explicit coverage note', async () => {
  const deps = { portfolioDexHistory: async () => ({ data: { transactionList: [] } }) };
  const r = await loopDigest({ chain: 'eip155:196', wallet: '0xba3a00000000000000000000000000000000ba3a' }, deps);
  assert.equal(r.ok, false, 'zero-information read must be free under the billing contract');
  assert.equal(r.verdict, 'NO_DATA');
  assert.match(r.coverageNote, /not\s+DEX fills|does not cover|no DEX activity/i);
  assert.equal(r.historyWindow.txsFetched, 0);
  assert.ok(r.cursor, 'cursor continuity still preserved');
});

test('Q-11 loop-digest: a non-empty read stays a delivered (chargeable) answer', async () => {
  const deps = { portfolioDexHistory: async () => ({ data: { transactionList: [
    { tokenContractAddress: '0x1', tokenSymbol: 'WOKB', pnlUsd: '1.5', valueUsd: '10', time: '1750000000000', type: '1' },
  ] } }) };
  const r = await loopDigest({ chain: 'eip155:196', wallet: '0xba3a00000000000000000000000000000000ba3a' }, deps);
  assert.notEqual(r.ok, false);
  assert.equal(r.historyWindow.txsFetched, 1);
});
