import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lpRisk } from '../src/engine/lpRisk.js';

test('lp-risk: IL closed form matches known values + token-level self-check', () => {
  assert.equal(lpRisk({ priceRatio: 1 }).realizedIL.impermanentLossPct, 0);              // no move -> 0 IL
  assert.ok(Math.abs(lpRisk({ priceRatio: 4 }).realizedIL.impermanentLossPct + 20) < 1e-6); // 4x -> -20%
  const id = lpRisk({ priceRatio: 2 }).checks.find((c) => c.name.startsWith('IL identity'));
  assert.ok(id.pass, 'token-level IL identity must hold exactly');
});

// The headline is the EXACT lognormal expectation, not the −σ²T/8 expansion (see
// liveAdversarial.test.mjs C for why). In the small-variance regime the two agree, which is what this
// test pins: the expansion's own value stays reported, and the headline sits within a few bp of it.
test('lp-risk: expected divergence tracks −σ²T/8 in the small-variance regime, exactly', () => {
  const r = lpRisk({ volatility: 0.05, horizonPeriods: 30 });   // σ²T = 0.075
  const e = r.expectedDivergence;
  assert.ok(Math.abs(e.expectedIlLeadingOrderPct + 0.9375) < 1e-3, `expansion ${e.expectedIlLeadingOrderPct}`);
  assert.ok(Math.abs(e.expectedIlPct + 0.9331) < 1e-3, `exact expectation ${e.expectedIlPct}`);
  assert.ok(Math.abs(e.expectedIlPct - e.expectedIlLeadingOrderPct) < 0.01, 'the two must agree here');
  assert.ok(r.checks.find((c) => c.name.startsWith('E[IL]')).pass);
});

test('lp-risk: fee-vs-divergence net is additive and breakeven vol zeroes it', () => {
  const r = lpRisk({ volatility: 0.05, horizonPeriods: 30, feeAprPct: 20 });
  assert.ok(Math.abs(r.feeVsDivergence.expectedNetPct - (r.feeVsDivergence.horizonFeesPct + r.expectedDivergence.expectedIlPct)) < 1e-6);
  const be = r.feeVsDivergence.breakevenVolatility;
  const atBe = lpRisk({ volatility: be, horizonPeriods: 30, feeAprPct: 20 });
  // Tightened from 1e-2: the breakeven is now solved against the exact expectation rather than the
  // expansion, so the only residual left is the rounding of σ to 5dp. At 1e-2 this test passed while
  // the two numbers in feeVsDivergence disagreed by 1.3%.
  assert.ok(Math.abs(atBe.feeVsDivergence.expectedNetPct) < 1e-3, `net at breakeven ~0, got ${atBe.feeVsDivergence.expectedNetPct}`);
  assert.ok(r.checks.find((c) => c.name.startsWith('breakeven')).pass, 'the breakeven must self-check');
});

test('lp-risk: no breakeven exists when horizon fees exceed the −100% divergence bound', () => {
  const r = lpRisk({ volatility: 0.6, horizonPeriods: 30, feeAprPct: 2000 });
  assert.equal(r.feeVsDivergence.breakevenVolatility, null, 'must not invent a σ where none solves');
  assert.match(r.feeVsDivergence.breakevenBasis, /No breakeven exists/);
  assert.equal(r.checks.every((c) => c.pass), true);
});

test('lp-risk: concentration amplifies IL by the supplied factor', () => {
  const full = lpRisk({ priceRatio: 2 }).realizedIL.impermanentLossPct;
  const conc = lpRisk({ priceRatio: 2, concentrationFactor: 5 }).realizedIL.impermanentLossPct;
  assert.ok(Math.abs(conc - 5 * full) < 1e-6);
});

test('lp-risk: requires a priceRatio or a volatility (no fabrication)', () => {
  assert.equal(lpRisk({}).ok, false);
});
