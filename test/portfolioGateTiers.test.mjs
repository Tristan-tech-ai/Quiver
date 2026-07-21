// Validated severity-tiered betas (pre-registered cross-event validation, Jul 21 2026). New export →
// FAILS to import on pre-fix code. Locks: the tier values ship with their validation provenance intact;
// tier selection actually changes the stress; default behavior (worst-case table) is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioGate, VALIDATED_BETA_TIERS, CRASH_BETAS } from '../src/engine/portfolioGate.js';

test('tiers carry the PRE-REGISTERED validation provenance (guard against silently editing results)', () => {
  const v = VALIDATED_BETA_TIERS.provenance.validation;
  assert.equal(v.PASS, true);
  assert.equal(v.h1MedianSpearman, 0.657, 'H1 result is the recorded number, not a re-run');
  assert.equal(v.h2RelativeRisk, 14.3, 'H2 result is the recorded number');
  assert.equal(v.h2bRelativeRisk, 13.3, 'H2b (second OOS event, Feb-2026) recorded');
  assert.ok(VALIDATED_BETA_TIERS.provenance.preRegistered === true);
  assert.deepEqual([VALIDATED_BETA_TIERS.mild.episodes, VALIDATED_BETA_TIERS.moderate.episodes, VALIDATED_BETA_TIERS.severe.episodes], [9, 3, 2], 'calibration episode counts disclosed');
});

test('tier values: spot-lock a few measured medians; severe ≠ the worst-case wick table (different constructions)', () => {
  assert.equal(VALIDATED_BETA_TIERS.moderate.betas.ETH, 1.39);
  assert.equal(VALIDATED_BETA_TIERS.severe.betas.AI16Z, 5.02);
  assert.equal(VALIDATED_BETA_TIERS.mild.betas.BNB, 1.06);
  assert.notEqual(VALIDATED_BETA_TIERS.severe.betas.PENGU, CRASH_BETAS.PENGU, 'tier medians are episode-window medians, not the single-event wick — both ship, labeled');
});

test('betaTier input selects the tier; default stays the worst-case table (backward compatible); explicit betas win', () => {
  const book = { positions: [{ venue: 'x', asset: 'PENGU', side: 'long', size: 1000, entryPrice: 0.03, markPrice: 0.03, leverage: 5, maxLeverage: 20 }] };
  const def = portfolioGate(book);
  const tiered = portfolioGate({ ...book, betaTier: 'severe' });
  const explicit = portfolioGate({ ...book, betaTier: 'severe', betas: { PENGU: 9 } });
  assert.equal(def.betaScaledStress.betasUsed.PENGU, CRASH_BETAS.PENGU, 'no tier → worst-case default (unchanged behavior)');
  assert.equal(tiered.betaScaledStress.betasUsed.PENGU, VALIDATED_BETA_TIERS.severe.betas.PENGU, 'tier selected → tier beta used');
  assert.equal(explicit.betaScaledStress.betasUsed.PENGU, 9, 'explicit betas override the tier');
  assert.match(tiered.betaScaledStress.betaSource, /validated tier 'severe'/);
  assert.match(def.betaScaledStress.betaSource, /worst-case/);
  assert.equal(tiered.betaScaledStress.betaValidation.h2RelativeRisk, 14.3, 'validation summary rides the response');
  assert.ok(def.checks.every((c) => c.pass) && tiered.checks.every((c) => c.pass), 'self-checks hold under both sources');
});

test('junk betaTier is ignored (falls back to default), never a crash or a guess', () => {
  const book = { positions: [{ venue: 'x', asset: 'BTC', side: 'long', size: 1, entryPrice: 60000, markPrice: 60000, leverage: 10, maxLeverage: 40 }] };
  const r = portfolioGate({ ...book, betaTier: 'apocalyptic' });
  assert.ok(r.ok);
  assert.match(r.betaScaledStress.betaSource, /worst-case/);
});
