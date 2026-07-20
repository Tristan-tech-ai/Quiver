import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRiskBrain } from '../sdk/index.js';

test('sdk: local mode computes proof-carrying results', () => {
  const rb = createRiskBrain();
  assert.equal(rb.mode, 'local');
  const size = rb.sizeGate({ winProb: 0.55, winLossRatio: 1 });
  assert.ok(size.proof.contentHash && size.proof.selfChecks.length);
  const opt = rb.optionsRisk({ forward: 64000, positions: [{ type: 'call', strike: 64000, expiryDays: 30, iv: 0.6, quantity: -1 }] });
  assert.equal(opt.proof.allSelfChecksPass, true);
});

test('sdk: verify() confirms a genuine envelope and rejects a tampered one', () => {
  const rb = createRiskBrain();
  const e = rb.sizeGate({ winProb: 0.6, winLossRatio: 1.5 });
  assert.equal(rb.verify(e).valid, true);
  const t = JSON.parse(JSON.stringify(e));
  t.recommendedSize = 999999;
  assert.equal(rb.verify(t).valid, false);
  assert.equal(rb.verify(t).contentHashOk, false);
});

test('sdk: reproduce() re-runs the engine and matches; fails on a tampered result', () => {
  const rb = createRiskBrain();
  const e = rb.treasuryRisk({ positions: [{ asset: 'USDC', amountUsd: 80000 }, { asset: 'DAI', amountUsd: 20000 }] });
  assert.equal(rb.reproduce(e).reproduced, true);
  const t = JSON.parse(JSON.stringify(e));
  t.totalUsd = 1;
  assert.equal(rb.reproduce(t).reproduced, false);
});

test('sdk: attest + verifyInclusion round-trip', () => {
  const rb = createRiskBrain();
  const a = rb.sizeGate({ winProb: 0.55, winLossRatio: 1 });
  const b = rb.lpRisk({ volatility: 0.05, horizonPeriods: 30 });
  const att = rb.attest({ items: [a, b] });
  assert.ok(rb.verifyInclusion(att.attestations[0].contentHash.slice(2), att.attestations[0].proof.map((x) => x.slice(2)), att.merkleRoot.slice(2)));
});
