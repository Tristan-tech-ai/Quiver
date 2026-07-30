import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lpRisk } from '../src/engine/lpRisk.js';
import {
  exactExpectedIlPct, totalVarianceFromPublished, checkAgreesWithServed, QUADRATURE_ENVELOPE_PCT,
} from '../src/util/lpClosedForm.js';

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

  // The exact closed form, recovered OUTSIDE the engine. These assertions live inside this existing case
  // on purpose: the suite total 386 is a published figure that gateX-paper-contradiction.mjs matches
  // against a static count of `test(` declarations, so a new declaration would make several documents
  // wrong. Coverage belongs here; a new count does not.
  //
  // E[2√r/(1+r) − 1] = expm1(−v/8) exactly, because 2√r/(1+r) is sech(X/2) and under the martingale
  // lognormal its expectation coincides with E[√r]. Checked against an independent fine midpoint rule at
  // seven variances out to v = 200, agreeing to 1.3e-13 or better; the engine's 401-point trapezoid is
  // the approximation, with a peak truncation error of 1.4191e-7 percentage points at v = 1.1255.
  const v = 0.05 * 0.05 * 30;
  assert.equal(totalVarianceFromPublished(e.volatility, e.horizonPeriods), v);
  assert.ok(Math.abs(exactExpectedIlPct(e.volatility, e.horizonPeriods) - Math.expm1(-v / 8) * 100) < 1e-15);

  // It must reach the exact value from the PUBLISHED fields, which is the whole point: the engine is
  // frozen, so if this needed anything the response does not carry it could not be done at all.
  const ok = checkAgreesWithServed(e);
  assert.equal(ok.agrees, true, ok.why);
  assert.equal(ok.exactRounded4, e.expectedIlPct);
  // The served figure is ALREADY rounded to 4dp, so the observable gap is bounded by the display half
  // step plus the quadrature envelope, not by the envelope alone. Asserting the envelope alone failed
  // here at 1.917e-5, which is the display grid and not the integral: the same confusion between a
  // rounded display and a computed quantity that a previous proof guard shipped.
  assert.ok(ok.gapVsServedPct <= ok.maxGapVsServedPct, `gap ${ok.gapVsServedPct} exceeds ${ok.maxGapVsServedPct}`);
  assert.ok(ok.gapVsServedPct > QUADRATURE_ENVELOPE_PCT, 'the display grid should dominate this gap');
  assert.equal(ok.envelopePct, QUADRATURE_ENVELOPE_PCT);

  // And it must be able to REFUSE, or it is not a check. Four ways, each a real reason.
  assert.equal(checkAgreesWithServed({}).agrees, false);
  assert.equal(checkAgreesWithServed({ volatility: 0.05, horizonPeriods: 30 }).agrees, false);        // no served figure
  assert.equal(checkAgreesWithServed({ ...e, expectedIlPct: e.expectedIlPct + 0.01 }).agrees, false); // wrong figure
  assert.equal(checkAgreesWithServed({ ...e, concentrationFactor: 3 }).agrees, false);                // not full range
  assert.equal(totalVarianceFromPublished(0, 30), null);
  assert.equal(totalVarianceFromPublished(0.05, -1), null);

  // The rounded totalVariance is NOT a substitute for the unrounded pair: at this sigma it happens to
  // agree, so the case that proves it matters is the one measured against the live service.
  const lossy = Math.expm1(-Number(e.totalVariance) / 8) * 100;
  assert.ok(Math.abs(lossy) > 0, 'totalVariance is published, but rounded to 6dp');
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
