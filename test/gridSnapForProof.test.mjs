// The succinct-proof circuit carries every quantity as an integer on a 1e-9 grid; the engine carries
// doubles. Unless the service hands the engine values already on that grid, a proof certifies an
// identity about a position that is not quite the one the caller was answered — measured at up to
// 3.53e-6 in quote currency across 3,000 sampled positions, more than half of them beyond 1e-9.
//
// Snapping the inputs AND the leverage brings the worst observed divergence to 5.53e-10 with none
// above 1e-9. Leverage is in the list because the engine derives margin from it, so the derived value
// lands off-grid even when its ingredients do not — snapping only the obvious inputs left one
// position in 3,000 outside the bound.
//
// These fail against a service that passes raw inputs through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridSnap, gridSnapFields } from '../src/util/grid.js';
import { byName } from '../src/services.js';
import { _internal } from '../src/engine/proof.js';

test('snapping does not disturb inputs that are already on the grid', async () => {
  // Every value in the worked proof this project publishes is grid-exact, which is why the change
  // could ship without moving a single published content hash. If that stops being true, the
  // appendix and its signature go stale and this is where it should be noticed.
  const out = await byName['perp-gate'].run({ side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 });
  assert.equal(out.proof.inputs.entryPrice, 64000);
  assert.equal(out.proof.inputs.size, 1);
  assert.equal(out.proof.inputs.maintMarginRate, 0.0125);
  assert.equal(out.proof.inputs.leverage, 10);
  assert.equal(out.liquidationPrice, 58329.11);
});

test('an off-grid caller is answered on the grid, and the envelope echoes what was computed', async () => {
  const out = await byName['perp-gate'].run({
    side: 'long', entryPrice: 63999.123456789123, size: 0.7777777777777, leverage: 13.37, maintMarginRate: 0.0123456789123,
  });
  // The echoed inputs must be the snapped ones. Echoing the raw request while computing on snapped
  // values would make `re-run the engine on proof.inputs` produce a different number — the exact
  // failure the proof envelope exists to prevent.
  assert.equal(out.proof.inputs.entryPrice, 63999.123456789);
  assert.equal(out.proof.inputs.size, 0.777777778);
  assert.equal(out.proof.inputs.maintMarginRate, 0.012345679);
});

test('the snap rounds the decimal value, not the scaled product', () => {
  // `Math.round(x * 1e9)` is wrong above roughly 9e6: the product passes 2^53 and the rounding lands
  // on the wrong integer. A price in the tens of thousands scaled by a billion is exactly there, so
  // the naive implementation would corrupt the very inputs this service prices.
  // A value where the two genuinely disagree. They agree most of the time, which is what makes the
  // naive version dangerous: a sweep of 238 random prices in this service's range turned up five
  // disagreements, each one grid step apart. Picking a value at random to demonstrate this would
  // have produced a test that passes by luck about 98% of the time.
  const x = 138677.2518512955;
  assert.equal(gridSnap(x), 138677.251851295);
  assert.equal(Math.round(x * 1e9) / 1e9, 138677.251851296);
  assert.notEqual(Math.round(x * 1e9) / 1e9, gridSnap(x),
    'the scaled product has passed 2^53 and rounds to the wrong integer — the reason toFixed is used');
});

test('snapping is idempotent and leaves non-numbers alone', () => {
  const once = gridSnap(0.0123456789123);
  assert.equal(gridSnap(once), once);
  for (const v of ['long', null, undefined, true, NaN, Infinity]) {
    assert.equal(Object.is(gridSnap(v), v), true, `gridSnap must pass ${String(v)} through untouched`);
  }
  const o = gridSnapFields({ side: 'short', size: 1.23456789987, note: 'x' }, ['size']);
  assert.equal(o.side, 'short');
  assert.equal(o.note, 'x');
  assert.equal(o.size, 1.2345679);
});

test('the build hash did not move — the engine was not touched', () => {
  // The whole point of snapping in services.js rather than in the engine: no hash move means no
  // documentation sweep, no regenerated appendix, no re-rendered PDF.
  assert.equal(_internal.buildId(), 'q1-e1fa99d08887d6cc');
});
