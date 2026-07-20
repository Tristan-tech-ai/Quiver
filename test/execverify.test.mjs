import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execVerify } from '../src/engine/execVerify.js';

// Constant-product reference: x=1000, y=2,000,000, f=0.003, dx=10 -> honestOut = 19743.16...
const POOL = { reserveIn: 1000, reserveOut: 2_000_000, feeTier: 0.003, amountIn: 10 };
const honest = (() => {
  const inEff = 10 * (1 - 0.003);
  return (2_000_000 * inEff) / (1000 + inEff);
})();

test('exec-verify: an honest fill (== pool-implied) shows ~0 adverse and passes the k-invariant', () => {
  const r = execVerify({ ...POOL, amountOutRealized: honest });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.adverseExecutionBps) < 0.01, `adverse=${r.adverseExecutionBps}`);
  const k = r.checks.find((c) => c.name.startsWith('constant-product invariant'));
  assert.ok(k.pass, 'k-invariant must hold');
  assert.ok(r.verdict.includes('no material adverse'));
});

test('exec-verify: a sandwiched fill (worse than honest) is flagged with the bps lost', () => {
  const robbed = honest * (1 - 0.006);   // 60 bps worse
  const r = execVerify({ ...POOL, amountOutRealized: robbed });
  assert.ok(Math.abs(r.adverseExecutionBps - 60) < 0.5, `adverse=${r.adverseExecutionBps}`);
  assert.ok(r.adverseValueOut > 0);
  assert.ok(/adverse execution|sandwich/i.test(r.verdict));
});

test('exec-verify: decomposes unavoidable cost into fee + own price impact', () => {
  const r = execVerify({ ...POOL, amountOutRealized: honest });
  assert.ok(Math.abs(r.unavoidableCostBps.fee - 30) < 0.01, 'fee = 30 bps');       // 0.003
  assert.ok(r.unavoidableCostBps.ownPriceImpact > 0, 'own impact > 0 for a finite-size trade');
  // total = fee + impact
  assert.ok(Math.abs(r.unavoidableCostBps.total - (r.unavoidableCostBps.fee + r.unavoidableCostBps.ownPriceImpact)) < 1e-6);
});

test('exec-verify: "within tolerance yet robbed" — the punchline', () => {
  const robbed = honest * (1 - 0.004);   // 40 bps adverse
  const r = execVerify({ ...POOL, amountOutRealized: robbed, slippageTolerancePct: 0.5 }); // 50 bps tolerance
  assert.equal(r.slippageTolerance.withinTolerance, true);      // 40 < 50
  assert.ok(r.adverseExecutionBps > 0);
  assert.ok(/not sandwich protection|slippage tolerance is not/i.test(r.slippageTolerance.lesson));
});

test('exec-verify: reference mode compares against a supplied fair price', () => {
  // fair price 1975 out/in, realized 1965 -> ~50.6 bps adverse
  const r = execVerify({ amountIn: 10, amountOutRealized: 19650, fairPrice: 1975 });
  assert.equal(r.mode, 'reference');
  assert.ok(Math.abs(r.adverseExecutionBps - ((1975 - 1965) / 1975) * 1e4) < 0.1);
});

test('exec-verify: rejects input with neither reserves nor fairPrice (no fabrication)', () => {
  const r = execVerify({ amountIn: 10, amountOutRealized: 19000 });
  assert.equal(r.ok, false);
});

test('exec-verify: a better-than-honest fill is reported as favorable, not adverse', () => {
  const better = execVerify({ ...POOL, amountOutRealized: honest * 1.01 }); // ~100 bps better
  assert.ok(better.adverseExecutionBps < 0, 'negative adverse = better than honest');
  assert.ok(/better|favorable/i.test(better.verdict), `verdict=${better.verdict}`);
});

test('exec-verify: surfaces the reserve-timing caveat (block-start vs pre-tx)', () => {
  const r = execVerify({ ...POOL, amountOutRealized: honest });
  assert.ok(/block|front-run|pre-trade/i.test(r.note || ''), 'must disclose reserve-timing dependency');
});
