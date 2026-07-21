// loop-digest continuity locks. All FAIL on the pre-fix engine: it silently rebaselined unknown cursors,
// saved poisoned empty snapshots on fetch failure, and never disclosed history-window completeness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loopDigest } from '../src/engine/loopDigest.js';

const mkTx = (time, symbol, pnl) => ({ time, type: '1', tokenSymbol: symbol, tokenContractAddress: '0x' + symbol, valueUsd: 100, pnlUsd: pnl });
const depsWith = (txs, { fail = false } = {}) => ({
  portfolioDexHistory: async () => { if (fail) throw new Error('api down'); return { transactionList: txs }; },
});

test('loop-digest: failed fetch returns dataUnavailable and preserves the caller cursor (no poisoned snapshot)', async () => {
  const base = await loopDigest({ chain: 'ethereum', wallet: '0xW1' }, depsWith([mkTx(1000, 'AAA', 5)]));
  const out = await loopDigest({ chain: 'ethereum', wallet: '0xW1', cursor: base.cursor }, depsWith([], { fail: true }));
  assert.equal(out.dataUnavailable, true);
  assert.equal(out.cursor, base.cursor, 'the caller cursor must be returned untouched');
  assert.ok(out.note.includes('unknown state'));
  // continuity proof: the ORIGINAL cursor still diffs correctly afterwards
  const after = await loopDigest({ chain: 'ethereum', wallet: '0xW1', cursor: base.cursor }, depsWith([mkTx(2000, 'AAA', 9), mkTx(1000, 'AAA', 5)]));
  assert.equal(after.cursorStatus, 'diffed');
  assert.equal(after.diff.newFillCount, 1, 'the fill after the failure must appear — continuity preserved');
});

test('loop-digest: unknown cursor is disclosed as unknown-rebaselined, never a silent first call', async () => {
  const out = await loopDigest({ chain: 'ethereum', wallet: '0xW2', cursor: 'zzz-not-real' }, depsWith([mkTx(1000, 'BBB', 1)]));
  assert.equal(out.cursorStatus, 'unknown-rebaselined');
  assert.ok(out.diff.note.includes('LOST'), 'the lost-continuity note must be explicit');
});

test('loop-digest: diffComplete=false when the history window does not reach the cursor', async () => {
  const base = await loopDigest({ chain: 'ethereum', wallet: '0xW3' }, depsWith([mkTx(1000, 'CCC', 2)]));
  // next fetch window only spans [5000..9000] — it does NOT reach back to lastTxTime 1000
  const txs = [mkTx(9000, 'CCC', 8), mkTx(5000, 'CCC', 6)];
  const out = await loopDigest({ chain: 'ethereum', wallet: '0xW3', cursor: base.cursor }, depsWith(txs));
  assert.equal(out.diff.diffComplete, false);
  assert.ok(out.diff.note.includes('NOT in newFills'));
  assert.deepEqual(out.historyWindow, { txsFetched: 2, newestTxTime: 9000, oldestTxTime: 5000 });
});

test('loop-digest: normal diff path — diffComplete true, cursorStatus diffed', async () => {
  const base = await loopDigest({ chain: 'ethereum', wallet: '0xW4' }, depsWith([mkTx(1000, 'DDD', 2)]));
  const out = await loopDigest({ chain: 'ethereum', wallet: '0xW4', cursor: base.cursor }, depsWith([mkTx(3000, 'DDD', 4), mkTx(1000, 'DDD', 2)]));
  assert.equal(out.cursorStatus, 'diffed');
  assert.equal(out.diff.diffComplete, true);
  assert.equal(out.diff.newFillCount, 1);
});
