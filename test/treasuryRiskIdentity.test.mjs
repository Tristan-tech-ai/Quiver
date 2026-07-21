// Lock for the broken identity CHECK (found by a live T0 spot-audit): the engine compared an UNROUNDED
// 1/(wᵀρw) against the 2dp-ROUNDED display value with a 1e-6 tolerance, so any book whose 1/HHI had >2dp
// (e.g. 60/30/10 → 2.1739…) reported allSelfChecksPass:false on a TRUE identity. FAILS pre-fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { treasuryRisk } from '../src/engine/treasuryRisk.js';
import { proofEnvelope } from '../src/engine/proof.js';

test('treasury-risk: 60/30/10 book passes ALL self-checks (identity compared unrounded)', () => {
  const input = { positions: [{ asset: 'USDC', amountUsd: 60000, apyPct: 4 }, { asset: 'USDT', amountUsd: 30000, apyPct: 5 }, { asset: 'DAI', amountUsd: 10000, apyPct: 6 }] };
  const r = treasuryRisk(input);
  for (const c of r.checks) assert.equal(c.pass, true, `check failed: ${c.name}`);
  const env = proofEnvelope('treasury-risk', input, r, 'test');
  assert.equal(env.proof.allSelfChecksPass, true);
});

test('treasury-risk: supplied correlations still compute and disclose (no identity check when ρ given)', () => {
  const input = {
    positions: [{ asset: 'USDC', amountUsd: 50000 }, { asset: 'USDT', amountUsd: 50000 }],
    assetCorrelation: { USDC: { USDT: 0.8 } },
  };
  const r = treasuryRisk(input);
  const corr = r.depegStress.correlated;
  assert.ok(corr.correlationAdjustedEffectiveExposures < corr.naiveEffectiveExposures, 'co-moving assets must reduce effective bets');
  for (const c of r.checks) assert.equal(c.pass, true, `check failed: ${c.name}`);
});
