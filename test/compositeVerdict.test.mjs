// Composite verdict — continuous-score fusion with identity self-checks (opening #4). New module →
// this file FAILS to import on pre-fix code (fail-on-revert lock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeVerdict, fuse, bandFor, lognormalSkewBaseline, leaveOneOut, pickTermSlices, VOL_WEIGHTS, BAND_THRESHOLDS } from '../src/engine/compositeVerdict.js';

const RICH_INPUTS = {
  ivPercentile: 90, frontIvPct: 60, rv30Pct: 35, vrpRatio: 0.85, vrpSignificant: true,
  termFront: { daysOut: 7, atmIvPct: 60 }, termBack: { daysOut: 30, atmIvPct: 52 }, // backwardation
  dealerGammaRegime: 'DEALER_LONG_GAMMA',
  skew25dRR: -3.2, atmIvForSkew: 60, rndSkew: 0.05, rndSigmaSqrtT: 0.12, putCallOiRatio: 1.4, flowPutSharePct: 68,
};

test('fuse: score is the exact renormalized weighted mean; <2 components refuses', () => {
  const comps = [{ name: 'iv-rank', score: 0.8 }, { name: 'iv-vs-realized', score: 0.4 }, { name: 'dealer-gamma', score: 0.5 }];
  const f = fuse(comps, VOL_WEIGHTS);
  const expected = (1.0 * 0.8 + 1.0 * 0.4 + 0.5 * 0.5) / 2.5;
  assert.ok(Math.abs(f.score - expected) < 1e-12, 'identity: Σwᵢsᵢ/Σwᵢ');
  assert.ok(Math.abs(f.components.reduce((s, c) => s + c.weight, 0) - 1) < 1e-3, 'renormalized weights sum to 1');
  assert.equal(fuse([{ name: 'iv-rank', score: 0.9 }], VOL_WEIGHTS), null, 'one signal is not a composite');
});

test('bands: thresholds are the disclosed literals', () => {
  assert.equal(bandFor(BAND_THRESHOLDS.neutral - 0.001, 'vol'), 'NEUTRAL');
  assert.equal(bandFor(0.3, 'vol'), 'LEAN_RICH');
  assert.equal(bandFor(-BAND_THRESHOLDS.clear, 'vol'), 'CHEAP');
  assert.equal(bandFor(0.5, 'dir'), 'UPSIDE_PRICED');
  assert.equal(bandFor(-0.2, 'dir'), 'LEAN_DOWNSIDE');
});

test('lognormal baseline: ≈3σ√T for small vol; RND direction scores EXCESS over it, not the raw skew', () => {
  const b = lognormalSkewBaseline(0.12);
  assert.ok(Math.abs(b - 3 * 0.12) < 0.02, `small-vol limit ~3σ√T, got ${b}`);
  // A raw RND skew of +0.05 at σ√T=0.12 is BELOW the ~0.36 lognormal baseline → downside-tilted, negative score.
  const r = compositeVerdict(RICH_INPUTS);
  const rnd = r.direction.components.find((c) => c.name === 'rnd-excess-skew');
  assert.ok(rnd.score < 0, 'positive raw price-skew below the lognormal baseline must score NEGATIVE (downside)');
});

test('sign conventions: backwardation → vol-rich vote; put-heavy skew/OI/flow → downside', () => {
  const r = compositeVerdict(RICH_INPUTS);
  assert.ok(r.volatility.components.find((c) => c.name === 'term-structure').score > 0, 'backwardation is a rich/stress vote');
  assert.ok(r.volatility.components.find((c) => c.name === 'iv-rank').score > 0.7, '90th pctile → strongly rich');
  for (const n of ['25d-skew', 'put-call-oi', 'flow-premium']) assert.ok(r.direction.components.find((c) => c.name === n).score < 0, `${n} put-heavy → negative`);
  assert.equal(r.volatility.band, bandFor(r.volatility.score, 'vol'));
  assert.ok(['LEAN_DOWNSIDE', 'DOWNSIDE_PRICED'].includes(r.direction.band), 'uniformly put-heavy inputs → downside band');
});

test('identity self-checks pass on both axes; carry = IV²−RV² exactly', () => {
  const r = compositeVerdict(RICH_INPUTS);
  for (const axis of [r.volatility, r.direction]) {
    assert.ok(axis.available);
    assert.ok(axis.selfChecks.length >= 4 && axis.selfChecks.every((c) => c.pass), JSON.stringify(axis.selfChecks));
  }
  assert.equal(r.carry.variancePremiumPts2, Math.round(60 ** 2 - 35 ** 2));
});

test('missing inputs → disclosed missing components + renormalization; axis with <2 signals refuses', () => {
  const r = compositeVerdict({ ivPercentile: 75, frontIvPct: 50, rv30Pct: 40 });
  assert.ok(r.volatility.available, 'two vol components suffice');
  assert.ok(r.volatility.missing.some((m) => m.name === 'term-structure'), 'absent inputs are LISTED');
  assert.equal(r.direction.available, false, 'zero direction signals → refuse');
  assert.ok(/fewer than 2/.test(r.direction.reason));
  const noVrp = r.volatility.components.find((c) => c.name === 'iv-vs-realized');
  assert.ok(/parity/.test(noVrp.note), 'no VRP fit → measured vs parity and says so');
});

test('pickTermSlices: skips the microstructure-dominated sub-2-day front (caught LIVE: "26.8% @0.2d" fed the term slope every Deribit daily-expiry morning)', () => {
  const slices = [
    { daysOut: 0.2, atmIvPct: 26.8 }, { daysOut: 1.2, atmIvPct: 28 },
    { daysOut: 7.2, atmIvPct: 31 }, { daysOut: 38.2, atmIvPct: 34.5 },
  ];
  const { front, back } = pickTermSlices(slices);
  assert.equal(front.daysOut, 7.2, 'front = first slice with ≥2 days to run');
  assert.equal(back.daysOut, 38.2, 'back = ≥14d slice nearest 30d, beyond the front');
  const onlyNear = pickTermSlices([{ daysOut: 0.2, atmIvPct: 26.8 }]);
  assert.equal(onlyNear.front.daysOut, 0.2, 'falls back to the true front only when nothing ≥2d exists');
  assert.equal(onlyNear.back, null);
});

test('leave-one-out flags a pivotal component on a borderline composite', () => {
  // iv-rank strongly rich, iv-vs-realized mildly cheap → composite sits near a band edge; dropping
  // the strong component must flip the band, and the block must say so.
  const comps = [{ name: 'iv-rank', score: 0.5 }, { name: 'iv-vs-realized', score: -0.1 }];
  const piv = leaveOneOut(comps, VOL_WEIGHTS, 'vol');
  assert.ok(piv.some((p) => p.name === 'iv-rank'), 'the verdict hangs on iv-rank and the analysis surfaces it');
});
