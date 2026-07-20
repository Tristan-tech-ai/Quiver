import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeGate } from '../src/engine/sizeGate.js';

test('size-gate: discrete Kelly matches closed form and FOC self-check passes', () => {
  // p=0.55, b=1 -> f* = (0.55*2 - 1)/1 = 0.10
  const r = sizeGate({ winProb: 0.55, winLossRatio: 1, bankroll: 10000, kellyFraction: 0.25 });
  assert.equal(r.hasEdge, true);
  assert.ok(Math.abs(r.fullKellyFraction - 0.10) < 1e-6, `f*=${r.fullKellyFraction}`);
  assert.ok(Math.abs(r.recommendedBetFraction - 0.025) < 1e-6);      // 0.25 * 0.10
  assert.equal(r.recommendedSize, 250);                              // 0.025 * 10000
  const foc = r.checks.find((c) => c.name.startsWith('kelly-FOC'));
  assert.ok(foc.pass, 'FOC self-check must pass');
});

test('size-gate: continuous Kelly = mu/sigma^2 and half-Kelly identity holds', () => {
  // mu=0.08, sigma=0.4 -> f* = 0.08/0.16 = 0.5
  const r = sizeGate({ expectedReturn: 0.08, volatility: 0.4, bankroll: 100000, kellyFraction: 0.5 });
  assert.ok(Math.abs(r.fullKellyFraction - 0.5) < 1e-9, `f*=${r.fullKellyFraction}`);
  const half = r.checks.find((c) => c.name.startsWith('half-Kelly'));
  assert.ok(half.pass, 'half-Kelly growth identity must hold');
  // at half Kelly, growth is 75% of max
  assert.ok(Math.abs(r.expectedLogGrowth.fractionOfMax - 0.75) < 1e-6, `ratio=${r.expectedLogGrowth.fractionOfMax}`);
});

test('size-gate: risk-of-ruin anchor RoR(alpha, lambda=1)=alpha, and fractional Kelly is far safer', () => {
  const full = sizeGate({ expectedReturn: 0.08, volatility: 0.4, kellyFraction: 1 });
  const half = sizeGate({ expectedReturn: 0.08, volatility: 0.4, kellyFraction: 0.5 });
  const quarter = sizeGate({ expectedReturn: 0.08, volatility: 0.4, kellyFraction: 0.25 });
  const p50 = (r) => r.riskOfRuin.find((x) => x.drawdownToFraction === 0.5).probEver;
  // full Kelly: P(ever halving) = 0.5 exactly (the anchor)
  assert.ok(Math.abs(p50(full) - 0.5) < 1e-4, `full RoR(0.5)=${p50(full)}`);
  // half Kelly: 0.5^3 = 0.125 ; quarter: 0.5^7 ~ 0.0078
  assert.ok(Math.abs(p50(half) - 0.125) < 1e-3, `half=${p50(half)}`);
  assert.ok(p50(quarter) < 0.01, `quarter=${p50(quarter)}`);
  const anchor = quarter.checks.find((c) => c.name.startsWith('risk-of-ruin anchor'));
  assert.ok(anchor.pass);
});

test('size-gate: no edge -> recommends not betting (does not fabricate a size)', () => {
  // p=0.45, b=1 -> negative Kelly
  const r = sizeGate({ winProb: 0.45, winLossRatio: 1, bankroll: 10000 });
  assert.equal(r.hasEdge, false);
  assert.ok(/do not bet|not bet|size 0/i.test(r.recommendation));
});

test('size-gate: recommended fraction never exceeds full Kelly', () => {
  for (const kf of [0.1, 0.25, 0.5, 1]) {
    const r = sizeGate({ winProb: 0.6, winLossRatio: 1.5, kellyFraction: kf });
    assert.ok(r.recommendedBetFraction <= r.fullKellyFraction + 1e-12);
  }
});

test('size-gate: implied portfolio vol reflects vol-targeting view (continuous)', () => {
  // betFraction * sigma
  const r = sizeGate({ expectedReturn: 0.08, volatility: 0.4, kellyFraction: 0.25 });
  // f*=0.5, bet=0.125, vol = 0.125*0.4 = 0.05 = 5%
  assert.ok(Math.abs(r.impliedPortfolioVolPct - 5) < 1e-6, `vol=${r.impliedPortfolioVolPct}`);
});

test('size-gate: flags leverage when the recommended bet exceeds 100% of bankroll', () => {
  // mu=0.30, sigma=0.40 -> f*=1.875; at full Kelly betFraction=1.875 (>1 => leverage)
  const lev = sizeGate({ expectedReturn: 0.30, volatility: 0.40, kellyFraction: 1 });
  assert.equal(lev.leverage.required, true, 'betFraction>1 must flag leverage');
  assert.ok(/margin|leverage/i.test(lev.leverage.warning));
  assert.ok(/full Kelly here is/i.test(lev.note), 'note should caution on f*>1');
  // quarter-Kelly of the same edge: betFraction 0.469 (<1 => no leverage)
  const noLev = sizeGate({ expectedReturn: 0.30, volatility: 0.40, kellyFraction: 0.25 });
  assert.equal(noLev.leverage.required, false);
});
