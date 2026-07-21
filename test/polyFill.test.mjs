// poly-fill locks. All three FAIL on the pre-fix engine: (1) the 25-level consumption cap mislabeled deep
// granular books INSUFFICIENT_DEPTH (verdict bug); (2) a crossed book produced a fictional mid instead of
// refusing; (3) book freshness fields did not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { polyFill } from '../src/engine/polyFill.js';

function fakeDeps({ asks, bids, timestamp } = {}) {
  return {
    resolveMarket: async () => ({ slug: 'test-market', question: 'Test?', endDate: '2026-12-31' }),
    clobTokenIds: () => ({ yes: 'y1', no: 'n1' }),
    book: async () => ({ timestamp, bids: bids || [], asks: asks || [] }),
  };
}

test('poly-fill: deep granular book fills fully (no artificial 25-level cap on the verdict)', async () => {
  // 30 ask levels, $10 each ⇒ $300 depth. A $280 order MUST fill (needs 28 levels).
  const asks = Array.from({ length: 30 }, (_, i) => ({ price: String(0.50 + i * 0.001), size: String(10 / (0.50 + i * 0.001)) }));
  const bids = [{ price: '0.49', size: '100' }];
  const out = await polyFill({ market: 'x', usd: 280 }, fakeDeps({ asks, bids, timestamp: Date.now() }));
  assert.equal(out.verdict, 'FILLS_CLEAN', `got ${out.verdict} — the consumption cap is back`);
  assert.ok(out.fill.levelsConsumed >= 28, `levelsConsumed ${out.fill.levelsConsumed} must reflect the real walk`);
  assert.ok(out.fill.usdUnfilled < 0.01);
  assert.equal(out.bookWalk.length <= 12, true, 'display rows stay capped');
});

test('poly-fill: crossed book refuses the mid instead of averaging a lie', async () => {
  const out = await polyFill({ market: 'x', usd: 50 }, fakeDeps({
    asks: [{ price: '0.55', size: '200' }],
    bids: [{ price: '0.60', size: '200' }], // bid > ask — inconsistent snapshot
    timestamp: Date.now(),
  }));
  assert.equal(out.verdict, 'BOOK_CROSSED');
  assert.equal(out.fill.midCents, null, 'mid must be refused on a crossed book');
  assert.ok(out.bookCrossedNote.includes('re-fetch'));
});

test('poly-fill: book freshness is disclosed (timestamp present and absent)', async () => {
  const asks = [{ price: '0.5', size: '1000' }];
  const withTs = await polyFill({ market: 'x', usd: 10 }, fakeDeps({ asks, bids: [{ price: '0.48', size: '10' }], timestamp: Date.now() - 5000 }));
  assert.ok(withTs.bookFreshness.ageMs >= 5000, `ageMs ${withTs.bookFreshness.ageMs} must reflect the 5s-old snapshot`);
  assert.ok(withTs.bookFreshness.serverTimestampUtc);
  const noTs = await polyFill({ market: 'x', usd: 10 }, fakeDeps({ asks, bids: [{ price: '0.48', size: '10' }] }));
  assert.equal(noTs.bookFreshness.serverTimestampUtc, null);
  assert.ok(noTs.bookFreshness.note.includes('unverifiable'));
});
