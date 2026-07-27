// The lower-severity half of the second review. Each of these is a claim the service made that it
// did not deliver, rather than a number that was wrong — which is the same defect class, one layer out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execVerify } from '../src/engine/execVerify.js';
import { optionsRisk } from '../src/engine/optionsRisk.js';
import { chartPress } from '../src/engine/chartPress.js';

// ---------------------------------------------------------------------------------------------
// exec-verify: the invariant tolerance scaled with k = x*y, which is QUADRATIC in reserve size,
// while honestOut — the number it certifies — is linear. On a real pool it permitted a residual
// worth ~1e6 bps of the output, against the 5 bps threshold this same engine calls sandwiching.
// ---------------------------------------------------------------------------------------------
const bigPool = { amountIn: 1e4, amountOutRealized: 19700000, reserveIn: 1e6, reserveOut: 2e9, feeTier: 0.003 };

test('exec-verify: the invariant tolerance is scale-free, not proportional to x*y', () => {
  const r = execVerify(bigPool);
  const inv = r.checks.find((c) => /constant-product invariant/.test(c.name));
  assert.match(inv.name, /RELATIVE error on k/);
  assert.equal(inv.tolerance, 1e-12, 'a fixed relative budget, independent of pool size');
  assert.ok(inv.residual <= 1e-12, `residual ${inv.residual}`);
  assert.equal(inv.pass, true);
  // The check that matters, in the units that matter. A relative error of t on k propagates to
  // roughly the same relative error on the output, so the tolerance in BASIS POINTS of the output is
  // t*1e4 — which must sit far below the 5 bps at which this engine calls a fill adverse. The old
  // absolute budget eps*k was 2e9 output units on this pool, about a hundred times the entire honest
  // output, i.e. a tolerance looser than the effect it was paired with.
  const toleranceBps = inv.tolerance * 1e4;
  assert.ok(toleranceBps < 5e-3, `tolerance is ${toleranceBps} bps of output; the adverse-execution threshold is 5 bps`);
  const oldAbsoluteBudget = 1e-6 * (1e6 * 2e9);
  const honestOut = 2e9 - (1e6 * 2e9) / (1e6 + 1e4 * 0.997);
  assert.ok(oldAbsoluteBudget > honestOut,
    'precondition: the previous absolute budget exceeded the whole honest output, which is why it certified nothing');
});

test('exec-verify: the benchmark is reconstructed in OUTPUT units against the output', () => {
  const r = execVerify(bigPool);
  const rec = r.checks.find((c) => /benchmark reconstruction/.test(c.name));
  assert.ok(rec, 'a second, output-denominated check must exist');
  assert.equal(rec.tolerance, 1e-12);
  assert.equal(rec.pass, true);
  assert.ok(rec.residual <= 1e-12, `residual ${rec.residual}`);
});

test('exec-verify: the tolerance does not loosen as the pool grows', () => {
  const small = execVerify({ ...bigPool, reserveIn: 1e3, reserveOut: 2e6, amountIn: 10, amountOutRealized: 19700 });
  const large = execVerify({ ...bigPool, reserveIn: 1e9, reserveOut: 2e12 });
  const t = (r) => r.checks.find((c) => /RELATIVE error on k/.test(c.name)).tolerance;
  assert.equal(t(small), t(large), 'a pool a million times larger must not buy a million times the slack');
});

test('exec-verify: reference mode reports the invariant as NOT RUN, not as a pass', () => {
  const r = execVerify({ amountIn: 100, amountOutRealized: 199, fairPrice: 2 });
  const inv = r.checks.find((c) => /constant-product invariant/.test(c.name));
  assert.equal(inv.skipped, true, 'no pool state means no invariant to assert');
  assert.equal(inv.pass, null, 'null, not true — claiming a pass inflates the guarantee');
  assert.match(inv.reason, /caller-supplied fairPrice/);
});

// ---------------------------------------------------------------------------------------------
// options-risk: a 7-point price grid misses an interior worst case, so the margin requirement —
// the number a caller holds capital against — could be lower than the true worst inside its own box.
// ---------------------------------------------------------------------------------------------
const iv = 0.6;
const shortCondor = [
  { type: 'call', strike: 85, quantity: -1, iv, expiryDays: 7 },
  { type: 'call', strike: 95, quantity: 1, iv, expiryDays: 7 },
  { type: 'call', strike: 105, quantity: 1, iv, expiryDays: 7 },
  { type: 'call', strike: 115, quantity: -1, iv, expiryDays: 7 },
];

test('options-risk: the requirement is never below the conventional seven-point grid', () => {
  for (const legs of [shortCondor,
    [{ type: 'call', strike: 100, quantity: -1, iv, expiryDays: 7 }, { type: 'put', strike: 100, quantity: -1, iv, expiryDays: 7 }],
    [{ type: 'call', strike: 90, quantity: -1, iv, expiryDays: 3 }, { type: 'call', strike: 100, quantity: 2, iv, expiryDays: 3 }, { type: 'call', strike: 110, quantity: -1, iv, expiryDays: 3 }]]) {
    const s = optionsRisk({ positions: legs, forward: 100 }).spanMargin;
    assert.ok(s.requirement >= s.sevenPointGridRequirement - 1e-9,
      `requirement ${s.requirement} must be >= seven-point ${s.sevenPointGridRequirement}`);
    assert.ok(s.gridUnderstatementPct >= 0, `understatement cannot be negative, got ${s.gridUnderstatementPct}`);
  }
});

test('options-risk: an interior worst case IS found and the gap disclosed', () => {
  const s = optionsRisk({ positions: shortCondor, forward: 100 }).spanMargin;
  assert.ok(s.gridUnderstatementPct > 0, 'this book loses more between grid points than on them');
  assert.ok(typeof s.sevenPointGridRequirement === 'number', 'the conventional figure stays visible');
  assert.match(s.note, /understating this requirement by/);
  assert.equal(s.scenarios.length, 21, 'the conventional 7x3 grid is still returned');
});

test('options-risk: the note does not claim an understatement when there is none', () => {
  const s = optionsRisk({ positions: [{ type: 'call', strike: 100, quantity: -1, iv, expiryDays: 7 }], forward: 100 }).spanMargin;
  if (s.gridUnderstatementPct <= 0.01) assert.match(s.note, /both grids find the same worst case/);
});

// ---------------------------------------------------------------------------------------------
// chart-press: round(x,8) is toFixed(8), which returns 0 below 5e-9 — so on a sub-nano token the
// three fields added to make the picture and the facts comparable all read zero.
// ---------------------------------------------------------------------------------------------
const bars = (n, last) => {
  const r = [];
  for (let i = 0; i < n; i++) { const c = i === n - 1 ? last : last * (1 + 0.01 * ((i % 5) - 2)); const o = c * 0.999; r.push([Date.UTC(2026, 6, 14) + i * 4 * 3600e3, o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, 1000 + i]); }
  return r;
};
const deps = (px) => ({ candles: async () => bars(72, px), priceInfo: async () => ({ price: px, tokenSymbol: 'MEME' }), trades: async () => [] });

test('chart-press: a sub-nano price does not collapse the comparison fields to zero', async () => {
  const r = await chartPress('ethereum', '0xmeme', { interval: '4H', bars: 72 }, deps(1.234e-9));
  for (const k of ['lastDrawnCandleClose', 'high', 'low']) {
    assert.ok(r.facts[k] > 0, `facts.${k} came back ${r.facts[k]} — the field exists to be compared against the image`);
  }
  assert.equal(r.facts.lastDrawnCandleClose, 1.234e-9);
  assert.ok(r.facts.high > r.facts.low);
});

test('chart-press: a normal price keeps its existing form', async () => {
  const r = await chartPress('ethereum', '0xwbtc', { interval: '4H', bars: 72 }, deps(64480.5865119));
  assert.equal(r.facts.lastDrawnCandleClose, 64480.5865119);
});
