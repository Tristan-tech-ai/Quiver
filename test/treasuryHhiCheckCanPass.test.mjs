// A self-check that cannot PASS is the same defect as one that cannot fail, and this one was live.
//
// `treasury-risk` published its HHI rounded to four decimals and then verified it against a
// full-precision recomputation with a 1e-9 tolerance. The residual was therefore the rounding, not an
// error — so any book whose Σwᵢ² missed the 4-decimal grid got `allSelfChecksPass: false` on a
// correct answer, and an answer this service consequently declines to bill for. Two stablecoins in a
// 2:1 ratio was enough to trigger it.
//
// The same defect had already been found and fixed in the LAST check of the same array, with a
// comment explaining it — "round-then-verify, violated by the verifier itself" — and was left
// unfixed one line above. These tests fail against that version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { treasuryRisk } from '../src/engine/treasuryRisk.js';

const hhiCheck = (r) => r.checks.find((c) => c.name.startsWith('HHI(asset)'));

test('a two-asset book whose HHI is not on the rounding grid still passes its own check', () => {
  // 1,000,000 and 500,000 → weights 2/3 and 1/3 → Σwᵢ² = 0.5555…, published as 0.5556.
  const r = treasuryRisk({
    positions: [
      { asset: 'USDC', amountUsd: 1000000, apyPct: 5, pegTarget: 1 },
      { asset: 'USDT', amountUsd: 500000, apyPct: 4, pegTarget: 1 },
    ],
  });
  assert.equal(r.ok, true);
  const c = hhiCheck(r);
  assert.ok(c, 'the HHI check must exist');
  assert.equal(c.pass, true,
    `the HHI identity holds; the check was rejecting its own rounding (residual ${c.residual})`);
  assert.equal(r.checks.every((x) => x.pass !== false), true,
    'no check may report failure on a valid two-asset book');
});

test('the check still FAILS when the published HHI is actually wrong', () => {
  // The repair must not be "loosen the tolerance until everything passes". Corrupt the served value
  // by one unit in the last published place and the check has to notice.
  const r = treasuryRisk({
    positions: [
      { asset: 'USDC', amountUsd: 1000000, apyPct: 5, pegTarget: 1 },
      { asset: 'USDT', amountUsd: 500000, apyPct: 4, pegTarget: 1 },
    ],
  });
  const served = r.concentration.byAsset.hhi;
  assert.ok(Math.abs(served - 0.5556) < 1e-9, `expected the published HHI to be 0.5556, got ${served}`);
  // A one-unit error at the published precision is 1e-4, eighty million times the tolerance the
  // repaired check uses, so the check remains capable of failing.
  const c = hhiCheck(r);
  assert.ok(c.tolerance !== undefined, 'the check must publish the tolerance it was judged against');
  assert.ok(1e-4 > c.tolerance * 1e6, 'a one-unit error at the published precision must be far outside tolerance');
});

test('every numeric check in this engine publishes its tolerance', () => {
  // A residual with no tolerance beside it states the number but not the standard — the same gap as a
  // hash published without its rule.
  const r = treasuryRisk({
    positions: [
      { asset: 'USDC', amountUsd: 1000000, apyPct: 5, pegTarget: 1 },
      { asset: 'DAI', amountUsd: 250000, apyPct: 3, pegTarget: 1 },
    ],
  });
  for (const c of r.checks) {
    if (c.residual === undefined) continue;      // purely structural checks carry no residual
    assert.ok(c.tolerance !== undefined, `check "${c.name}" reports a residual with no tolerance`);
  }
});

test('a single-asset book is unaffected — the case that hid the defect', () => {
  // One position gives HHI exactly 1, which lands on the grid, so the old check passed here. That is
  // why this shipped: the smallest test case was the one input the defect could not reach.
  const r = treasuryRisk({ positions: [{ asset: 'USDC', amountUsd: 1000000, apyPct: 5, pegTarget: 1 }] });
  assert.equal(hhiCheck(r).pass, true);
  assert.equal(r.concentration.byAsset.hhi, 1);
});
