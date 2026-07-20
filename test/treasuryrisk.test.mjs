import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treasuryRisk } from '../src/engine/treasuryRisk.js';

test('treasury-risk: uniform book => HHI 1/n, effective exposures n, no breach', () => {
  const r = treasuryRisk({ positions: [
    { asset: 'USDC', amountUsd: 25000, apyPct: 5 }, { asset: 'USDT', amountUsd: 25000, apyPct: 6 },
    { asset: 'DAI', amountUsd: 25000, apyPct: 4 }, { asset: 'USDE', amountUsd: 25000, apyPct: 8 },
  ] });
  assert.equal(r.concentration.byAsset.hhi, 0.25);
  assert.equal(r.concentration.byAsset.effectiveExposures, 4);
  assert.equal(r.concentration.breaches.length, 0);
  assert.equal(r.weightedApyPct, 5.75);
  assert.ok(r.checks.every((c) => c.pass));
});

test('treasury-risk: concentrated book flags the breach; HHI == Σw²', () => {
  const r = treasuryRisk({ positions: [{ asset: 'USDC', amountUsd: 80000 }, { asset: 'DAI', amountUsd: 20000 }], concentrationLimitPct: 25 });
  assert.ok(Math.abs(r.concentration.byAsset.hhi - 0.68) < 1e-9); // 0.8²+0.2²
  assert.equal(r.concentration.breaches.length, 1);
  assert.equal(r.concentration.breaches[0].key, 'USDC');
  assert.equal(r.concentration.breaches[0].sharePct, 80);
});

test('treasury-risk: depeg scenario loss is exact (USDC→0.97 = 3% of the USDC sleeve)', () => {
  const r = treasuryRisk({ positions: [{ asset: 'USDC', amountUsd: 80000 }, { asset: 'DAI', amountUsd: 20000 }], depegScenarios: [{ asset: 'USDC', price: 0.97 }] });
  assert.equal(r.depegStress.scenarios[0].portfolioLossUsd, 2400);   // 0.03 * 80000
  assert.equal(r.depegStress.scenarios[0].portfolioLossPct, 2.4);
  assert.ok(r.checks.find((c) => c.name.startsWith('depeg-loss identity')).pass);
});

test('treasury-risk: worst-single-depeg scan picks the largest exposure', () => {
  const r = treasuryRisk({ positions: [{ asset: 'USDC', amountUsd: 80000 }, { asset: 'DAI', amountUsd: 20000 }], depegFloor: 0.90 });
  assert.equal(r.depegStress.worstSingle.asset, 'USDC');
  assert.equal(r.depegStress.worstSingle.lossUsd, 8000); // 0.10 * 80000
});

test('treasury-risk: risk-adjusted yield subtracts expected depeg loss', () => {
  const r = treasuryRisk({ positions: [
    { asset: 'USDC', amountUsd: 50000, apyPct: 5, depegProbAnnual: 0.01 },
    { asset: 'USDE', amountUsd: 50000, apyPct: 12, depegProbAnnual: 0.05 },
  ] });
  assert.equal(r.weightedApyPct, 8.5);
  assert.equal(r.expectedAnnualDepegLossUsd, 300); // 0.01*50k*0.1 + 0.05*50k*0.1
  assert.equal(r.riskAdjustedApyPct, 8.2);          // 8.5 - 0.3
});

test('treasury-risk: rejects an empty book (no fabrication)', () => {
  assert.equal(treasuryRisk({ positions: [] }).ok, false);
});
