// Regression lock for the treasury-risk correlated-depeg depth: the pre-fix engine only scanned WORST-SINGLE
// depegs (independent), missing the SVB-weekend lesson that correlated stables depeg together (USDC broke →
// DAI followed). These tests fail on the pre-fix code (no depegStress.correlated; 3 checks not 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treasuryRisk } from '../src/engine/treasuryRisk.js';

const book = {
  positions: [
    { asset: 'USDC', amountUsd: 5000000, apyPct: 4.5 },
    { asset: 'DAI', amountUsd: 3000000, apyPct: 6.0 },
    { asset: 'USDP', amountUsd: 2000000, apyPct: 3.0 },
  ],
};

test('treasury-risk: correlated CRASH exceeds worst-single (systemic risk the single-scan hides)', () => {
  const r = treasuryRisk({ ...book, correlatedScenarios: [{ name: 'SVB weekend', shocks: { USDC: 0.88, DAI: 0.90 } }] });
  assert.ok(r.depegStress.correlated, 'correlated stress must be present');
  assert.ok(r.depegStress.correlated.crash.portfolioLossPct > r.depegStress.worstSingle.lossPct, 'correlated crash must exceed worst-single');
  assert.ok(r.depegStress.correlated.scenarios[0].portfolioLossPct > 0, 'the SVB joint scenario is computed');
});

test('treasury-risk: correlation shrinks effective independent bets (co-moving assets are one bet)', () => {
  const indep = treasuryRisk(book);
  const corr = treasuryRisk({ ...book, assetCorrelation: { USDC: { DAI: 0.8 } } });
  assert.equal(indep.depegStress.correlated.correlationAdjustedEffectiveExposures, indep.depegStress.correlated.naiveEffectiveExposures, 'no ρ supplied → equals naive 1/HHI');
  assert.ok(corr.depegStress.correlated.correlationAdjustedEffectiveExposures < corr.depegStress.correlated.naiveEffectiveExposures, 'positive correlation → strictly fewer effective independent bets');
});

test('treasury-risk: all 5 self-checks pass (incl. the two new correlated identities)', () => {
  const r = treasuryRisk({ ...book, assetCorrelation: { USDC: { DAI: 0.8 } } });
  assert.equal(r.checks.length, 5);
  assert.ok(r.checks.every((c) => c.pass));
});
