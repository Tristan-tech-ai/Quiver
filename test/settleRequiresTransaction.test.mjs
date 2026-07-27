// The second settlement leak, and the more expensive one, because it fails OPEN.
//
// BUG-011 established the rule: "the transaction field — not the success flag — is the discriminator",
// after 68/68 settle responses carrying `success:true, status:"timeout"` and no transaction hash were
// shown to have never landed on chain. The fix was applied to that status string and not to the branch
// underneath it, where `status:"success"` with no transaction hash was still accepted as settled.
//
// Measured on 27 July 2026: an external address made seven calls across five services in one session.
// All seven logged `decision="settled" success=true tx=null`. An exhaustive scan of the X Layer USD₮0
// transfer log across the exact block window — 66,399,800 to 66,401,300, full coverage, no gaps —
// found zero transfers arriving at the payTo address. Seven answers were delivered for nothing, and
// the recurrence instrumentation recorded them as paid calls, so the leak was on its way into the
// roadmap as evidence of traction.
//
// These tests fail against the previous rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleDecision } from '../src/x402.js';

test('a confident status with no transaction hash is NOT settled', () => {
  // This exact shape was served seven times and paid nothing.
  assert.equal(settleDecision({ status: 'success', success: true }), 'retry');
  assert.equal(settleDecision({ status: 'settled', success: true }), 'retry');
  assert.equal(settleDecision({ status: 'confirmed' }), 'retry');
  assert.equal(settleDecision({ status: 'success' }), 'retry');
});

test('the original leak stays closed', () => {
  assert.equal(settleDecision({ status: 'timeout', success: true }), 'retry');
});

test('a transaction hash is what makes it settled, under either field name', () => {
  assert.equal(settleDecision({ status: 'success', success: true, transaction: '0xabc' }), 'settled');
  assert.equal(settleDecision({ status: 'settled', txHash: '0xabc' }), 'settled');
  assert.equal(settleDecision({ success: true, transaction: '0xabc' }), 'settled');
});

test('outright failure is still distinguished from an unconfirmed settle', () => {
  // The two answer differently to the caller: `failed` reports the facilitator's reason, `retry`
  // says the payment was NOT captured and they were not charged. Collapsing them would tell someone
  // whose card was declined that they should try again, and vice versa.
  assert.equal(settleDecision({ status: 'error', success: false }), 'failed');
  assert.equal(settleDecision({}), 'failed');
});

test('the decision never returns settled without a transaction, for any status string', () => {
  // Property, not enumeration: the rule is about the transaction field, so no status string may
  // override it. An enumerated test would pass while a new status string quietly reopened the hole.
  for (const status of ['settled', 'success', 'confirmed', 'timeout', 'pending', 'ok', 'SETTLED', undefined]) {
    for (const success of [true, 'true', false, undefined]) {
      const d = settleDecision({ status, success });
      assert.notEqual(d, 'settled',
        `settled with no transaction hash on status=${status} success=${success}`);
    }
  }
});
