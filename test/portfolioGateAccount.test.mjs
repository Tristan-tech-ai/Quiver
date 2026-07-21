// Account mode (opening #1 final slice): one HL address → full live book → three stress views, with the
// venue's own liquidationPx as an EXTERNAL cross-check. parseClearinghouseState is a new export → this
// file fails to import on pre-fix code (fail-on-revert lock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClearinghouseState, enrichPortfolioLegs } from '../src/adapters/hyperliquid.js';
import { portfolioGate } from '../src/engine/portfolioGate.js';
import { SERVICES } from '../src/services.js';

const FIXTURE = {
  marginSummary: { accountValue: '12345.6', totalNtlPos: '61500', totalMarginUsed: '9050' },
  crossMarginSummary: { accountValue: '12345.6' },
  withdrawable: '8000.1',
  assetPositions: [
    { type: 'oneWay', position: { coin: 'BTC', szi: '0.5', entryPx: '60000', positionValue: '32500', unrealizedPnl: '2500', leverage: { type: 'cross', value: 10 }, marginUsed: '3250', liquidationPx: '54321.5', maxLeverage: 40 } },
    { type: 'oneWay', position: { coin: 'ETH', szi: '-10', entryPx: '3000', positionValue: '29000', leverage: { type: 'isolated', value: 5 }, marginUsed: '5800', liquidationPx: '3480' } },
    { type: 'oneWay', position: { coin: 'SOL', szi: '0' } },
  ],
};

test('parseClearinghouseState: signed size → side, positionValue/|szi| → mark, venue liq + margin mode carried; flat coins skipped; malformed throws', () => {
  const a = parseClearinghouseState(FIXTURE);
  assert.equal(a.positions.length, 2, 'flat SOL (szi=0) skipped, open legs kept');
  const [btc, eth] = a.positions;
  assert.deepEqual({ asset: btc.asset, side: btc.side, size: btc.size, mark: btc.markPrice, mode: btc.marginMode, vLiq: btc.venueLiquidationPx, margin: btc.margin, lev: btc.leverage },
    { asset: 'BTC', side: 'long', size: 0.5, mark: 65000, mode: 'cross', vLiq: 54321.5, margin: 3250, lev: 10 });
  assert.deepEqual({ side: eth.side, mark: eth.markPrice, mode: eth.marginMode }, { side: 'short', mark: 2900, mode: 'isolated' });
  assert.equal(a.accountEquityUsd, 12345.6);
  assert.equal(a.withdrawableUsd, 8000.1);
  assert.throws(() => parseClearinghouseState({}), /unexpected clearinghouseState shape/, 'a failed fetch is an ERROR, never an empty book');
});

test('venue liquidation cross-check: agrees within tolerance → pass; an isolated leg deviating wildly → the check FAILS (external verifier can fail)', () => {
  const leg = { venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 100, markPrice: 100, leverage: 10, maxLeverage: 40 };
  const first = portfolioGate({ positions: [leg] });
  const computedLiq = first.positions[0].liquidation.price;
  assert.ok(computedLiq > 0 && computedLiq < 100);

  const agree = portfolioGate({ positions: [{ ...leg, venueLiquidationPx: computedLiq, marginMode: 'isolated' }] });
  const cAgree = agree.checks.find((c) => c.name.startsWith('venue liquidation cross-check'));
  assert.equal(cAgree.pass, true, 'venue price == computed price → deviation ~0 → pass');
  assert.ok(Math.abs(agree.positions[0].venueLiquidation.deviationPtsVsComputed) < 0.01);
  assert.equal(cAgree.coverage.isolatedLegsChecked, 1);

  const clash = portfolioGate({ positions: [{ ...leg, venueLiquidationPx: 50, marginMode: 'isolated' }] });
  const cClash = clash.checks.find((c) => c.name.startsWith('venue liquidation cross-check'));
  assert.equal(cClash.pass, false, 'a 50%-away venue price on an ISOLATED leg must FAIL the cross-check');

  const cross = portfolioGate({ positions: [{ ...leg, venueLiquidationPx: 50, marginMode: 'cross' }] });
  const cCross = cross.checks.find((c) => c.name.startsWith('venue liquidation cross-check'));
  assert.equal(cCross.pass, true, 'cross legs are excluded from pass/fail (pooled equity — different model)…');
  assert.equal(cCross.coverage.crossLegsExcludedFromPassFail, 1, '…but the exclusion is DISCLOSED');
  assert.ok(cross.positions[0].venueLiquidation.deviationPtsVsComputed != null, 'deviation still reported per leg');
});

test('enrich fills the mmr source even when marks are already present (caught LIVE: account-mode legs arrive with mark+entry but no maxLeverage/tiers, and every leg failed)', async () => {
  const accountLeg = { venue: 'hyperliquid', asset: 'BTC', side: 'short', size: 1, entryPrice: 65459, markPrice: 65458, margin: 44950, leverage: 20 };
  const injected = async () => ({ maxLeverage: 40, marginTiers: [{ lowerBound: 0, maxLeverage: 40 }], markPx: 65458, fundingHourly: 0 });
  const [enriched] = await enrichPortfolioLegs([accountLeg], injected);
  assert.ok(enriched.marginTiers || enriched.maxLeverage, 'mmr source filled despite marks being present');
  const r = portfolioGate({ positions: [enriched] });
  assert.ok(r.ok && r.positions[0].liquidation, 'leg now computes a liquidation instead of erroring');
  const [untouched] = await enrichPortfolioLegs([{ ...accountLeg, maxLeverage: 25 }], injected);
  assert.equal(untouched.maxLeverage, 25, 'caller-supplied mmr source is never overwritten');
});

test('exposure reconciliation tolerance scales with asset count (caught LIVE: 5-asset book false-failed intermittently on the fixed 1e-2 as marks drifted)', () => {
  // Five assets, each net notional 1.004 → per-asset display rounds to 1.00 (−0.004 each) while the total
  // rounds to 5.02: residual 0.02 — inside the rounding budget (0.005×6=0.03), NOT a defect. The old fixed
  // 1e-2 tolerance failed this book; reverting the fix fails this test.
  const book = { positions: ['A1', 'A2', 'A3', 'A4', 'A5'].map((a) => ({ venue: 'x', asset: a, side: 'long', size: 1, entryPrice: 1.004, markPrice: 1.004, leverage: 10, maxLeverage: 40 })) };
  const r = portfolioGate(book);
  const recon = r.checks.find((c) => c.name.startsWith('exposure reconciliation'));
  assert.equal(recon.pass, true, `residual ${recon.residual} must sit inside the scaled tolerance ${recon.tolerance}`);
  assert.ok(recon.tolerance >= 0.03 - 1e-9, 'tolerance carries the per-asset rounding budget');
});

test('account mode ships the OBSERVATION envelope (adversarial-review fix: a live-fetched book must not wear the deterministic proof costume), with the math-re-runnable property stated', async () => {
  const svc = SERVICES.find((s) => s.name === 'portfolio-gate');
  const CH_STATE = { marginSummary: { accountValue: '10000', totalNtlPos: '30000', totalMarginUsed: '3000' }, withdrawable: '7000', assetPositions: [{ type: 'oneWay', position: { coin: 'BTC', szi: '0.4', entryPx: '60000', positionValue: '26000', leverage: { type: 'cross', value: 10 }, marginUsed: '2600', liquidationPx: '54000' } }] };
  const META = [{ universe: [{ name: 'BTC', maxLeverage: 40, szDecimals: 5 }], marginTables: [] }, [{ markPx: '65000', funding: '0.0000125', oraclePx: '65000', openInterest: '1000' }]];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts?.body || '{}');
    const payload = body.type === 'clearinghouseState' ? CH_STATE : META;
    return { ok: true, json: async () => payload };
  };
  try {
    const r = await svc.run({ account: '0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2' });
    assert.ok(r.observation, 'account mode must carry an OBSERVATION envelope');
    assert.equal(r.proof, undefined, 'and must NOT carry the deterministic proof envelope');
    assert.equal(r.observation.deterministic, false);
    assert.ok(Array.isArray(r.observation.inputs.positions) && r.observation.inputs.positions.length === 1, 'frozen book echoed in observation.inputs');
    assert.match(r.mathReproducibility, /re-runnable/, 'the math-is-re-runnable property is stated, not lost');
    assert.ok(r.live?.fetchedAtUtc, 'fetch provenance kept');
  } finally { globalThis.fetch = realFetch; }
});

test('service validate: account mode accepts a 0x address, rejects junk, keeps positions precedence', () => {
  const svc = SERVICES.find((s) => s.name === 'portfolio-gate');
  assert.ok(/positions.*OR account/i.test(svc.validate({}).error), 'empty input names both paths');
  assert.ok(svc.validate({ account: 'nope' }).error, 'non-address rejected');
  const ok = svc.validate({ account: ' 0xb0a55f13d22f66e6d495ac98113841b2326e9540 ' });
  assert.equal(ok.account, '0xb0a55f13d22f66e6d495ac98113841b2326e9540', 'trimmed + accepted');
  const withPos = svc.validate({ positions: [{ asset: 'BTC' }], account: '0xb0a55f13d22f66e6d495ac98113841b2326e9540' });
  assert.ok(Array.isArray(withPos.positions), 'explicit positions pass through untouched');
});
