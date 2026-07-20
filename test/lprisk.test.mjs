import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lpRisk } from '../src/engine/lpRisk.js';

test('lp-risk: IL closed form matches known values + token-level self-check', () => {
  assert.equal(lpRisk({ priceRatio: 1 }).realizedIL.impermanentLossPct, 0);              // no move -> 0 IL
  assert.ok(Math.abs(lpRisk({ priceRatio: 4 }).realizedIL.impermanentLossPct + 20) < 1e-6); // 4x -> -20%
  const id = lpRisk({ priceRatio: 2 }).checks.find((c) => c.name.startsWith('IL identity'));
  assert.ok(id.pass, 'token-level IL identity must hold exactly');
});

test('lp-risk: expected divergence = −σ²T/8 with passing E[IL] self-check', () => {
  const r = lpRisk({ volatility: 0.05, horizonPeriods: 30 });
  assert.ok(Math.abs(r.expectedDivergence.expectedIlPct + 0.9375) < 1e-3, `got ${r.expectedDivergence.expectedIlPct}`);
  assert.ok(r.checks.find((c) => c.name.startsWith('E[IL]')).pass);
});

test('lp-risk: fee-vs-divergence net is additive and breakeven vol zeroes it', () => {
  const r = lpRisk({ volatility: 0.05, horizonPeriods: 30, feeAprPct: 20 });
  assert.ok(Math.abs(r.feeVsDivergence.expectedNetPct - (r.feeVsDivergence.horizonFeesPct + r.expectedDivergence.expectedIlPct)) < 1e-6);
  const be = r.feeVsDivergence.breakevenVolatility;
  const atBe = lpRisk({ volatility: be, horizonPeriods: 30, feeAprPct: 20 });
  assert.ok(Math.abs(atBe.feeVsDivergence.expectedNetPct) < 1e-2, `net at breakeven ~0, got ${atBe.feeVsDivergence.expectedNetPct}`);
});

test('lp-risk: concentration amplifies IL by the supplied factor', () => {
  const full = lpRisk({ priceRatio: 2 }).realizedIL.impermanentLossPct;
  const conc = lpRisk({ priceRatio: 2, concentrationFactor: 5 }).realizedIL.impermanentLossPct;
  assert.ok(Math.abs(conc - 5 * full) < 1e-6);
});

test('lp-risk: requires a priceRatio or a volatility (no fabrication)', () => {
  assert.equal(lpRisk({}).ok, false);
});
