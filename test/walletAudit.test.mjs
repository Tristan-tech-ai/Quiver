// wallet-audit census lock. FAILS pre-fix: a REJECTED overview fetch returned INSUFFICIENT_DATA
// ("no trading history") — conflating an outage with a blank record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { walletAudit } from '../src/engine/walletAudit.js';

test('wallet-audit: failed overview fetch → DATA_UNAVAILABLE, never INSUFFICIENT_DATA', async () => {
  const out = await walletAudit('ethereum', '0xW', { portfolioOverview: async () => { throw new Error('api down'); } });
  assert.equal(out.verdict, 'DATA_UNAVAILABLE');
  assert.ok(out.note.includes('UNKNOWN'));
});

test('wallet-audit: succeeded-but-empty overview → genuine INSUFFICIENT_DATA', async () => {
  const out = await walletAudit('ethereum', '0xW', { portfolioOverview: async () => ({ buyTxCount: null, winRate: null }) });
  assert.equal(out.verdict, 'INSUFFICIENT_DATA');
  assert.ok(out.note.includes('succeeded'));
});

test('wallet-audit: zero-trade wallet → INSUFFICIENT_DATA, never a graded UNPROVEN', async () => {
  // OKX returns zeros (not null) for an unused wallet — the earlier null-guard misses it.
  const out = await walletAudit('ethereum', '0xW', { portfolioOverview: async () => ({ buyTxCount: 0, sellTxCount: 0, winRate: 0 }) });
  assert.equal(out.verdict, 'INSUFFICIENT_DATA');
  assert.equal(out.txCount, 0);
  assert.equal(out.grade, null);
  assert.ok(out.note.includes('zero DEX trades'));
});

test('wallet-audit: a wallet WITH trades still gets graded (guard does not over-fire)', async () => {
  const out = await walletAudit('ethereum', '0xW', {
    portfolioOverview: async (c, a, period) => ({ buyTxCount: 30, sellTxCount: 25, winRate: 62, realizedPnlUsd: 1200, top3PnlTokenPercent: 40, tokenCountByPnlPercent: { over500Percent: 2, zeroTo500Percent: 10, zeroToMinus50Percent: 6, overMinus50Percent: 2 } }),
  });
  assert.notEqual(out.verdict, 'INSUFFICIENT_DATA', 'a wallet with 55 trades must be graded');
  assert.ok(out.grade != null);
});
