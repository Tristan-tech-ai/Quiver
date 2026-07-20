import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyPortfolioRisk } from '../src/engine/polyDesk.js';

test('poly-desk risk: diversified book => HHI 1/n, n effective bets, no over-concentration', () => {
  const r = polyPortfolioRisk([
    { market: 'A', outcome: 'Yes', valueUsd: 25 }, { market: 'B', outcome: 'No', valueUsd: 25 },
    { market: 'C', outcome: 'Yes', valueUsd: 25 }, { market: 'D', outcome: 'Yes', valueUsd: 25 },
  ]);
  assert.equal(r.concentrationHhi, 0.25);
  assert.equal(r.effectiveBets, 4);
  assert.equal(r.largestPositionPct, 25);
  assert.ok(/Diversified/.test(r.verdict));
});

test('poly-desk risk: concentrated book flags over-concentration and HHI = Σw²', () => {
  const r = polyPortfolioRisk([{ market: 'BigBet', outcome: 'Yes', valueUsd: 80 }, { market: 'Small', outcome: 'No', valueUsd: 20 }]);
  assert.ok(Math.abs(r.concentrationHhi - 0.68) < 1e-9);
  assert.equal(r.largestPositionPct, 80);
  assert.ok(/Over-concentrated/.test(r.verdict));
});

test('poly-desk risk: outcome skew reflects YES/NO value split', () => {
  const r = polyPortfolioRisk([{ market: 'A', outcome: 'Yes', valueUsd: 75 }, { market: 'B', outcome: 'No', valueUsd: 25 }]);
  assert.equal(r.outcomeSkew.yesPct, 75);
  assert.equal(r.outcomeSkew.noPct, 25);
});

test('poly-desk risk: empty book returns null (no fabrication)', () => {
  assert.equal(polyPortfolioRisk([]), null);
});
