// GATE W — the divergence guard is a guard, at every price, and it can still say no.
//
// WHAT IT IS FOR. `src/util/snark.js` refuses to publish a Plonk proof whose witness disagrees with
// the answer that was served. Until this gate it refused on `|certified - round(pLiq, 2)| <= 0.005`
// — half a cent, sized off the engine's own display rounding. That is correct reasoning for BTC and
// it is not a guard below a dollar: the display rounding contributes an ABSOLUTE half-cent to that
// comparison whatever the price is, so on a $0.24 liquidation the whole tolerance is two percent of
// the number. Measured over the live Hyperliquid universe at ~$5,000 notional and a leverage safely
// above each asset's own maintenance tier: 189 of 232 perps liquidate below $1, the gaps fill
// [0, 0.005] almost uniformly with a median of 2.6e-3, 32 sit within a tenth of the ceiling, and
// RUNE was refused a proof outright with nothing wrong with it. Widening the tolerance would have
// made the majority case strictly worse.
//
// WHAT THIS GATE MEASURES. Four properties, and the first two are the ones that make the other two
// worth reading:
//
//   the expression the guard compares against is the ENGINE'S, bit for bit. Re-deriving an engine
//     expression outside the engine is a defect class this repository has shipped three times — a
//     `constantproduct` encoder rearranged the algebra into a mathematically equal, numerically
//     different form and was wrong by 64 grid steps. So W.1 does not read the two expressions and
//     agree they look the same: it lifts the engine's own source line out of src/engine/perpGate.js,
//     compiles it, and requires Object.is agreement with what the guard uses over a random sweep.
//   the display rounding is the engine's, for the same reason (W.2).
//   the recomputation reproduces the SERVED answer over the whole live universe and over a synthetic
//     sweep built to break it, and the bound is never exceeded (W.3, W.4, W.5).
//   the bound is not slack. A bound the worst honest case cannot approach is not measuring anything;
//     W.4 and W.5 require the worst honest position to use a real fraction of it.
//
// And then the two behaviours: the boundary case that used to be refused is published now, with the
// witness exactly equal to the engine's own double (W.6); a witness that prices a different position
// is still refused (W.7); a position the 1e-9 grid cannot pin to the width the answer is displayed
// at is refused, and says which of the two it is (W.8).
//
//   node --test gates/gateW-divergence-guard.mjs      # needs the network for W.3/W.4
//   node gates/gateW-revert.mjs                       # five scripted defects, each must turn it red
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { perpGate } from '../src/engine/perpGate.js';
import { round } from '../src/engine/stats.js';
import { gridSnapFields } from '../src/util/grid.js';
import { witnessFor, buildInBackground, getProof, stopProver, _internal } from '../src/util/snark.js';
import { enrichPerpInputs, fetchPerpContexts } from '../src/adapters/hyperliquid.js';

const require = createRequire(import.meta.url);
const scale = require('../src/util/scale.cjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC = Number(process.env.QUIVER_GATEW_SYNTHETIC || 120000);

// The proof this gate lets through is really built, in a real forked worker. Nothing here waits for
// it — the guard's decision is visible the moment the record says `building` — but the worker still
// has to be told to stop or the runner never exits.
after(async () => { try { await stopProver(); } catch { /* already gone */ } });

// ── the shared sweep machinery ───────────────────────────────────────────────────────────────────

// Everything the guard decides on, for one set of echoed inputs, measured rather than inferred.
function measure(inputs, served) {
  const w = witnessFor(inputs, served);
  if (!w) return null;
  return {
    served,
    engine: w.enginePrice,
    certified: scale.fromScaled(w.encoded.pLiqHat),
    roundsBack: _internal.displayRound(w.enginePrice) === served,
    gapToServed: w.gapToServed,
    gapToEngine: w.gapToEngine,
    bound: w.encodingBound,
    used: w.gapToEngine / w.encodingBound,
    publishable: w.encodingBound <= _internal.DISPLAY_HALF_UNIT,
  };
}

const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// A deterministic sweep, in four deliberately different shapes. Mode 0 is the shape a served answer
// actually has — every input already snapped onto the grid by `gridSnapFields`. The other three exist
// because a bound that only holds on the shape the code normally sees is not a bound, and one of them
// already found a real defect: a first-order sensitivity bound, which is the natural way to write
// this, was exceeded by 153 of 357,138 positions at sizes near the grid step itself, where a half-step
// perturbation is a third of the value and Taylor says nothing. That is why the shipped bound
// evaluates the corners of the encoding box instead of differentiating it.
function* synthetic(n) {
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  for (let i = 0; i < n; i++) {
    const mode = i % 4;
    let entryPrice, size, maintMarginRate, leverage;
    if (mode === 0) {            // as served: on the grid
      entryPrice = Number(logu(1e-7, 5e5).toFixed(9)); size = Number(logu(1e-7, 5e6).toFixed(9));
      maintMarginRate = Number(logu(1e-5, 0.4).toFixed(9)); leverage = Number(logu(1.001, 60).toFixed(9));
    } else if (mode === 1) {     // off the grid entirely
      entryPrice = logu(1e-7, 5e5); size = logu(1e-7, 5e6); maintMarginRate = logu(1e-5, 0.4); leverage = logu(1.001, 60);
    } else if (mode === 2) {     // magnitudes at both ends, including sizes near the grid step
      entryPrice = logu(1e-9, 1e9); size = logu(1e-9, 1e9); maintMarginRate = logu(1e-9, 0.99); leverage = logu(1.0000001, 1000);
    } else {                     // maintenance rate crowding the side sign: cancellation
      entryPrice = logu(1e-4, 1e5); size = logu(1e-4, 1e5);
      maintMarginRate = logu(0.5, 0.999999); leverage = 1 / (maintMarginRate * (1 + logu(1e-9, 0.2)));
    }
    const inputs = { side: rnd() < 0.5 ? 'long' : 'short', entryPrice, size, maintMarginRate, leverage };
    if (rnd() < 0.3) inputs.margin = mode === 0 ? Number(((size * entryPrice) / leverage).toFixed(9)) : (size * entryPrice) / leverage;
    yield { mode, inputs };
  }
}

// ── W.1 the expression is the engine's, and that is checked by running the engine's own source ────

test('W.1 the price the guard compares against is the engine\'s expression, term for term', () => {
  const engineSrc = readFileSync(join(ROOT, 'src', 'engine', 'perpGate.js'), 'utf8');
  const scaleSrc = readFileSync(join(ROOT, 'src', 'util', 'scale.cjs'), 'utf8');

  const fromEngine = (engineSrc.match(/^\s*const pLiq = (.+);$/m) || [])[1];
  const fromScale = (scaleSrc.match(/function engineLiquidationPrice\([^)]*\)\s*\{\s*return (.+);/) || [])[1];
  assert.ok(fromEngine, 'the engine no longer states its liquidation price on one line — this gate can no longer see the expression it exists to compare');
  assert.ok(fromScale, 'scale.cjs no longer states the engine expression as a single return');
  assert.equal(fromScale.replace(/\s+/g, ' ').trim(), fromEngine.replace(/\s+/g, ' ').trim(),
    'scale.engineLiquidationPrice has drifted from the engine line it is a copy of');

  // Not "they look the same": the engine's own source is compiled here and required to return the
  // identical double. A rearrangement that is mathematically equal and numerically different — the
  // exact defect class — passes a textual comparison only if the text is identical, and fails this
  // one on the first position where the two orders of evaluation part.
  const engineFn = new Function('s', 'q', 'P0', 'M', 'mmr', `return ${fromEngine};`);
  let seed = 24681357;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  let checked = 0;
  for (let i = 0; i < 200000; i++) {
    const s = rnd() < 0.5 ? 1 : -1;
    const q = logu(1e-9, 1e9), P0 = logu(1e-9, 1e9), M = logu(1e-9, 1e12), mmr = logu(1e-9, 0.999);
    const a = engineFn(s, q, P0, M, mmr);
    const b = scale.engineLiquidationPrice({ M, q, P0, s, mmr });
    assert.ok(Object.is(a, b), `the copy and the engine's own line disagree at s=${s} q=${q} P0=${P0} M=${M} mmr=${mmr}: ${a} vs ${b}`);
    checked++;
  }
  assert.equal(checked, 200000, 'the sweep did not run — this assertion proved nothing');

  // The other half of "the same position": margin. The engine forms the notional FIRST and divides
  // it, and the witness has to do the arithmetic in that order or it is pricing a neighbour.
  assert.match(engineSrc, /const notionalEntry = q \* P0;/);
  assert.match(engineSrc, /notionalEntry \/ Number\(p\.leverage\)/);
  assert.match(readFileSync(join(ROOT, 'src', 'util', 'snark.js'), 'utf8'), /\(size \* entryPrice\) \/ Number\(leverage\)/);
});

test('W.2 the display rounding the guard asks about is the engine\'s own', () => {
  let seed = 13572468;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  let checked = 0;
  for (let i = 0; i < 200000; i++) {
    // Weighted onto the half-cent boundaries, because everywhere else the two agree trivially and
    // the boundary is the only place a difference could hide — it is where RUNE was refused.
    const x = i % 3 === 0 ? (Math.round(logu(1e-4, 1e6) * 200) + 1) / 200 : logu(1e-9, 1e9);
    assert.ok(Object.is(_internal.displayRound(x), round(x, 2)),
      `the guard rounds ${x} to ${_internal.displayRound(x)}; the engine displays it as ${round(x, 2)}`);
    checked++;
  }
  assert.equal(checked, 200000);
});

// ── W.3 / W.4 the live universe ──────────────────────────────────────────────────────────────────

let LIVE = null;
async function liveSweep() {
  if (LIVE) return LIVE;
  const map = await fetchPerpContexts({ force: true });
  const rows = [];
  for (const mode of ['halfint', 'half', 'max', 'ten']) {
    for (const side of ['long', 'short']) {
      for (const [sym, ctx] of map) {
        const maxLev = ctx.maxLeverage;
        const leverage = mode === 'max' ? maxLev : mode === 'ten' ? Math.min(10, maxLev)
          : mode === 'halfint' ? Math.max(2, Math.floor(maxLev / 2)) : maxLev / 2;
        const e = await enrichPerpInputs({ symbol: sym, side, size: 5000 / ctx.markPx, leverage });
        const { live: _l, snark: _s, ...raw } = e;
        const compute = gridSnapFields(raw, ['entryPrice', 'size', 'notional', 'margin', 'leverage', 'maintMarginRate', 'maxLeverage', 'markPrice']);
        const r = perpGate(compute);
        if (!r.ok || !Number.isFinite(r.liquidationPrice)) continue;
        // Exactly what src/services.js hands the prover on the symbol-mode branch: Hyperliquid
        // publishes notional tiers and no rate, so the engine's own derived mmr is supplied.
        const wi = compute.maintMarginRate != null ? compute : { ...compute, maintMarginRate: r.inputs?.maintMarginRate };
        const m = measure(wi, r.liquidationPrice);
        if (m) rows.push({ sym, mode, side, ...m });
      }
    }
  }
  LIVE = { universe: map.size, rows };
  return LIVE;
}

test('W.3 the recomputed price reproduces the served answer across the live universe', async () => {
  const { universe, rows } = await liveSweep();
  assert.ok(universe >= 100, `only ${universe} perps came back — the venue read is too thin to conclude anything from`);
  assert.ok(rows.length >= universe * 6, `only ${rows.length} positions priced across ${universe} perps and eight configurations`);
  const missed = rows.filter((r) => !r.roundsBack);
  assert.equal(missed.length, 0,
    `the recomputation does not reproduce the engine for ${missed.length} positions, e.g. ${missed.slice(0, 3).map((r) => `${r.sym}/${r.mode}/${r.side} served ${r.served} vs ${_internal.displayRound(r.engine)}`).join('; ')}`);
  console.log(`  W.3  ${rows.length} live positions over ${universe} perps x 4 leverages x 2 sides, 0 misses`);
});

test('W.4 the bound holds on the live universe, and the worst honest position uses a real part of it', async () => {
  const { rows } = await liveSweep();
  const over = rows.filter((r) => r.used > 1);
  assert.equal(over.length, 0,
    `${over.length} live positions exceed the bound they are certified under, e.g. ${over.slice(0, 3).map((r) => `${r.sym}/${r.mode}/${r.side} ${(r.used * 100).toFixed(1)}%`).join('; ')}`);

  const used = rows.map((r) => r.used);
  const worst = Math.max(...used);
  // A bound nothing can approach is not a bound. The saturating positions are the ones whose
  // canonical solve lands near a tie on the grid, and with this many samples one of them always does;
  // the assertion is deliberately far below the measured value so it fails on a widened bound rather
  // than on a quiet market.
  assert.ok(worst >= 0.5, `the worst honest live position uses only ${(worst * 100).toFixed(2)}% of the bound — it is measuring nothing`);

  // And the bound itself is not inflated. Asserted on the BOUND rather than on the median usage,
  // because usage is legitimately zero wherever the integer solve lands exactly on the engine's own
  // double — which is most of the universe most of the time — and a median-usage floor would go red
  // on a quiet market rather than on a defect. What cannot be legitimate is the bound drifting away
  // from the single grid rounding that dominates it when the inputs arrive snapped, which they do on
  // every served path.
  const medianBound = quantile(rows.map((r) => r.bound), 0.5);
  assert.ok(medianBound <= 8 * _internal.HALF_STEP,
    `the median live bound is ${medianBound.toExponential(3)}, ${(medianBound / _internal.HALF_STEP).toFixed(1)}x the one grid rounding it should be — the guard has been widened`);
  assert.ok(rows.filter((r) => r.used >= 0.5).length >= rows.length * 0.05,
    `only ${rows.filter((r) => r.used >= 0.5).length} of ${rows.length} positions come within half the bound — it is not sized to this universe`);

  const belowDollar = rows.filter((r) => r.served < 1).length;
  const nearOldCeiling = rows.filter((r) => r.gapToServed >= 0.0045).length;
  console.log(`  W.4  worst ${(worst * 100).toFixed(2)}% of bound, median ${(quantile(used, 0.5) * 100).toFixed(2)}%, p99 ${(quantile(used, 0.99) * 100).toFixed(2)}%`);
  console.log(`       bound: median ${quantile(rows.map((r) => r.bound), 0.5).toExponential(2)}, worst ${Math.max(...rows.map((r) => r.bound)).toExponential(2)}`);
  console.log(`       the old rule's view: ${belowDollar}/${rows.length} liquidate below $1, ${nearOldCeiling} sat within a tenth of its 0.005 ceiling`);
});

// ── W.5 the synthetic sweep ──────────────────────────────────────────────────────────────────────

test('W.5 the bound holds on a sweep built to break it, and is still tight', () => {
  const rows = [];
  for (const { mode, inputs } of synthetic(SYNTHETIC)) {
    const r = perpGate(inputs);
    if (!r.ok || !Number.isFinite(r.liquidationPrice)) continue;
    const m = measure(inputs, r.liquidationPrice);
    if (m) rows.push({ mode, inputs, ...m });
  }
  assert.ok(rows.length > SYNTHETIC * 0.5, `only ${rows.length} of ${SYNTHETIC} drawn positions produced a witness — the sweep is not exercising the guard`);
  for (const mode of [0, 1, 2, 3]) {
    assert.ok(rows.some((r) => r.mode === mode), `mode ${mode} contributed nothing — a shape this bound was written against is not being tested`);
  }

  const missed = rows.filter((r) => !r.roundsBack);
  assert.equal(missed.length, 0, `${missed.length} positions where the recomputation does not reproduce the engine, e.g. ${JSON.stringify(missed[0]?.inputs)}`);

  const over = rows.filter((r) => r.used > 1);
  assert.equal(over.length, 0,
    `${over.length} of ${rows.length} positions exceed the bound, e.g. ${over.slice(0, 2).map((r) => `${(r.used * 100).toFixed(2)}% ${JSON.stringify(r.inputs)}`).join(' | ')}`);

  const publishable = rows.filter((r) => r.publishable);
  const used = publishable.map((r) => r.used);
  assert.ok(Math.max(...used) >= 0.9, `the worst publishable position uses only ${(Math.max(...used) * 100).toFixed(2)}% of the bound`);
  // Mode 0 is the shape a served answer actually has — every input snapped — so its bound must still
  // be the one grid rounding, not a widened constant. See W.4 for why this is asked of the bound
  // rather than of the median usage.
  const mode0 = rows.filter((r) => r.mode === 0).map((r) => r.bound);
  const medianBound0 = quantile(mode0, 0.5);
  assert.ok(medianBound0 <= 8 * _internal.HALF_STEP,
    `the median bound on snapped inputs is ${medianBound0.toExponential(3)}, ${(medianBound0 / _internal.HALF_STEP).toFixed(1)}x the single grid rounding it should be`);
  console.log(`  W.5  ${rows.length} synthetic positions, ${publishable.length} publishable, 0 over the bound`);
  console.log(`       worst ${(Math.max(...used) * 100).toFixed(3)}%, median ${(quantile(used, 0.5) * 100).toFixed(2)}%, p99 ${(quantile(used, 0.99) * 100).toFixed(2)}%`);
  console.log(`       refused as unpinnable: ${rows.length - publishable.length}, of which the old half-cent rule would have accepted ${rows.filter((r) => !r.publishable && r.gapToServed <= 0.005).length}`);
});

// ── W.6 / W.7 / W.8 the three behaviours ─────────────────────────────────────────────────────────

// The RUNE shape, constructed rather than waited for. The engine's unrounded price here is 0.065
// EXACTLY, the circuit's integer solve is 0.065 exactly — the two agree to the last bit — and the
// display rounds it up to 0.07 because the double for 0.065 sits a hair above the decimal. The old
// rule read that half-cent of its own display rounding as tampering and refused a proof of a position
// nothing was wrong with. This is the defect, reproducible without a venue.
const BOUNDARY = { side: 'long', entryPrice: 0.5, size: 1, margin: 0.4358125, maintMarginRate: 0.0125 };

test('W.6 the display-rounding boundary is published, and the witness there is the engine\'s own double', async () => {
  const r = perpGate(BOUNDARY);
  assert.equal(r.ok, true);
  const w = witnessFor(BOUNDARY, r.liquidationPrice);
  assert.ok(w, 'the fixture stopped producing a witness — it no longer exercises the guard');

  // The defect, still present in the number the old rule decided on.
  assert.ok(w.gapToServed > 0.005,
    `the fixture no longer straddles the display boundary (gap ${w.gapToServed}) — pick a new one before trusting this gate`);
  // And the witness is not merely close to the engine's price, it IS it.
  assert.equal(w.gapToEngine, 0, `the witness is ${w.gapToEngine} from the engine's own price at the boundary`);
  assert.ok(w.encodingBound <= _internal.DISPLAY_HALF_UNIT);

  // Asserted empty first: `building` below has to be this call's doing, not a record an earlier
  // assertion in this file left behind. `status: building` is the whole claim — the guard let it
  // through — and waiting the further 700ms for Plonk would be testing snarkjs, not the guard.
  assert.equal(await getProof('gateW-boundary'), null, 'the store already holds this hash — the assertion below would be reading a cache');
  await buildInBackground('gateW-boundary', BOUNDARY, r.liquidationPrice);
  const after = await getProof('gateW-boundary');
  assert.ok(after, 'no record was written at all');
  assert.notEqual(after.status, 'unavailable',
    `still refused at the display boundary: ${after.error}`);
  console.log(`  W.6  served ${r.liquidationPrice}, engine ${w.enginePrice}, certified ${scale.fromScaled(w.encoded.pLiqHat)}, old rule's gap ${w.gapToServed} -> refused; witness/engine gap ${w.gapToEngine} -> ${after.status}`);
});

test('W.7 a witness that prices a different position is still refused', async () => {
  const r = perpGate(BOUNDARY);
  // The answer says one thing, the witness prices another. One displayed unit is the smallest lie
  // this check has to catch, and it is caught by an equality rather than by a tolerance.
  await buildInBackground('gateW-wrong-answer', BOUNDARY, round(r.liquidationPrice + 0.01, 2));
  const rec = await getProof('gateW-wrong-answer');
  assert.equal(rec.status, 'unavailable');
  assert.match(rec.error, /refusing to certify a different position/);
  assert.match(rec.error, /witness prices this position at/);

  // And the same when there is no answer at all: a position already at or below maintenance has no
  // future threshold, and the old refusal reached that state as "diverges by NaN".
  const dead = { side: 'long', entryPrice: 1000, size: 1, margin: 1, maintMarginRate: 0.0125 };
  assert.equal(perpGate(dead).liquidationPrice, undefined, 'the fixture is no longer below maintenance');
  await buildInBackground('gateW-no-answer', dead, perpGate(dead).liquidationPrice);
  const rec2 = await getProof('gateW-no-answer');
  assert.equal(rec2.status, 'unavailable');
  assert.match(rec2.error, /no liquidation price to certify/);
  assert.doesNotMatch(rec2.error, /NaN/);
  console.log(`  W.7  wrong answer -> ${rec.error.slice(0, 96)}…`);
});

test('W.8 a position the grid cannot pin to the width it is displayed at is refused, for that reason', async () => {
  // A size a hair over one grid step, off the grid: encoding it moves the liquidation price by more
  // than four dollars on a $25 answer. Nothing here is dishonest and the arithmetic is sound; the
  // grid simply cannot represent this position tightly enough for a proof of it to be a proof of the
  // answer. The old rule refused most of these as a side effect of its absolute ceiling and let
  // others through; this refuses them for the reason, and names it.
  const unpinnable = { side: 'long', entryPrice: 33.218586195485344, size: 1.4979449840075012e-9, maintMarginRate: 1.2759854069276015e-9, leverage: 4.3200491333557 };
  const r = perpGate(unpinnable);
  assert.equal(r.ok, true);
  const w = witnessFor(unpinnable, r.liquidationPrice);
  assert.ok(w && _internal.displayRound(w.enginePrice) === r.liquidationPrice,
    'the fixture must pass the same-answer check first, or this is testing the wrong refusal');
  assert.ok(w.encodingBound > _internal.DISPLAY_HALF_UNIT);

  await buildInBackground('gateW-unpinnable', unpinnable, r.liquidationPrice);
  const rec = await getProof('gateW-unpinnable');
  assert.equal(rec.status, 'unavailable');
  assert.match(rec.error, /cannot pin this position/);
  console.log(`  W.8  bound ±${w.encodingBound.toExponential(3)} on a $${r.liquidationPrice} answer -> refused`);
});
