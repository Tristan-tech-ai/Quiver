// Locks the LP reality-check. These assert INVARIANTS that must hold on any real pool/window — they are
// not "expected values", because the curve shape is genuinely window-dependent (measured: a 30-day window
// gave narrow=-41.7%/wide=+2.8%, a 2-day window gave narrow=-1.53%/best@1%). What does NOT vary is the
// physics: concentration earns more fees; wider ranges rebalance less; a range that never exits pays no gas.
//
// Every one of these would have caught the three unit bugs found on 2026-07-17 (feePpm x100, and two
// inverted numeraire conversions) which together produced a plausible-looking "-99.9% at every width"
// instead of an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolMeta } from '../src/adapters/univ3.js';

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';   // ETH/USDC 0.05% mainnet
const live = process.env.LIVE_RPC === '1';

test('poolMeta reads fee() ON-CHAIN and reports it in the right units (never trusts a constant)', { skip: !live }, async () => {
  const m = await poolMeta('ethereum', POOL);
  assert.ok(m, 'metadata read');
  assert.equal(m.feeTierPct, 0.05, 'ETH/USDC 0.05% pool reports 0.05%');
  // feePpm must be in 1e-6 units: 500 => 0.05%. A x100 error here makes every fee 100x too large.
  assert.equal(m.feePpm, 500, `feePpm is hundredths-of-a-bip (got ${m.feePpm}); 500/1e6 = 0.05%`);
  assert.ok(Math.abs(m.feePpm / 1e6 * 100 - m.feeTierPct) < 1e-12, 'feePpm and feeTierPct agree');
  assert.deepEqual([m.d0, m.d1], [6, 18], 'decimals READ from the tokens, not assumed');
});

test('the address a doc called "WBTC/WETH 0.3%" is actually 0.05% — constants are not trustworthy', { skip: !live }, async () => {
  const m = await poolMeta('ethereum', '0x4585fe77225b41b697c938b018e2ac67ac5a20c0');
  assert.equal(m.feeTierPct, 0.05, 'fee() says 0.05%, contradicting the label; this is why we read on-chain');
});

test('★ fee charged equals the pool tier exactly (catches the feePpm x100 bug)', { skip: !live }, async () => {
  const { fetchSwaps } = await import('../src/adapters/univ3.js');
  const m = await poolMeta('ethereum', POOL);
  const rows = await fetchSwaps('ethereum', POOL, m, 0.25);
  assert.ok(rows.length > 50, `got ${rows.length} swaps`);
  for (const r of rows.slice(0, 40)) {
    const input = Math.abs(r.feeInToken0 ? r.amount0 : r.amount1);
    if (input <= 0) continue;
    const pct = 100 * r.feeAmt / input;
    assert.ok(Math.abs(pct - m.feeTierPct) < 1e-9, `fee must be exactly ${m.feeTierPct}% of input, got ${pct}%`);
  }
});

test('★ LP sweep invariants: fees fall with width, rebalances fall with width', { skip: !live }, async () => {
  const { lpDesk } = await import('../src/engine/lpDesk.js');
  const r = await lpDesk({ pool: POOL, days: 0.5, widthPct: 5 });
  assert.ok(r.ok, `sweep ran (${r.reason || ''})`);
  const s = r.sweep;
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].feesUsd <= s[i - 1].feesUsd + 1e-9, `fees must not RISE with width: ${s[i - 1].widthPct}%->${s[i].widthPct}%`);
    assert.ok(s[i].rebalances <= s[i - 1].rebalances, `rebalances must not RISE with width: ${s[i - 1].widthPct}%->${s[i].widthPct}%`);
  }
  // sanity band: a $10k LP over half a day cannot plausibly gain or lose ~all its capital
  for (const x of s) assert.ok(Math.abs(x.lpVsHodlPct) < 50, `LP-vs-HODL of ${x.lpVsHodlPct}% at ${x.widthPct}% is not physical over 0.5d — unit bug`);
  // a range that never exits pays no gas
  for (const x of s) if (x.rebalances === 0) assert.equal(x.gasUsd, 0, 'zero rebalances => zero gas');
});

test('lpDesk REFUSES rather than reporting noise when there are too few swaps', { skip: !live }, async () => {
  const { lpDesk } = await import('../src/engine/lpDesk.js');
  const r = await lpDesk({ pool: '0x0000000000000000000000000000000000000001', days: 1 });
  assert.equal(r.ok, false, 'must not return a sweep for a non-pool');
  assert.ok(/metadata|swaps|refus/i.test(r.reason), 'says why');
});
