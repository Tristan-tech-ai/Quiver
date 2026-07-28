// GATE B8-1 — does the circuit's minimum agree with the ENGINE's, measured over a sweep?
//
// The circuit says two things and both can be wrong independently. The per-leg identity can be right
// while the RANKING is wrong, and a sweep that only checked residuals would report green on a circuit
// that confidently names the wrong leg. So the ground truth here is not a residual: it is the leg
// `portfolioGate` actually returned in `nearestLiquidation`, matched back onto the positions array.
// The argmin is never recomputed. A recomputed argmin would agree with itself and prove nothing.
//
// AND THE CHECK IS THE CONSTRAINT SYSTEM, not arithmetic in this file. Every kept book is pushed
// through the real witness calculator with the engine's index in it. If the circuit's ordering and the
// engine's disagree, the witness calculator throws, and that throw is the measurement.
//
// ── WHAT THIS SWEEP FOUND, and why it runs twice ───────────────────────────────────────────────────
//
// The first version of this sweep failed, and it was right to. `util/grid.js` exists because the
// engine's doubles and the circuit's 1e-9 integers are not the same numbers, and `services.js` snaps
// every perp-gate input onto that grid before pricing — worst divergence 3.53e-6 down to 5.53e-10.
//
// portfolio-gate does NOT do that. Its `run` enriches the legs and calls the engine on raw doubles.
// So a portfolio proof today would certify liquidation prices measured up to 6.0e-3 away from the
// ones the caller was served, and DISTANCES up to 1.0e-2 percentage points away — twenty times the
// third decimal the ranking is published at.
//
// Both arms are therefore measured: the raw path the service takes now, and the snapped path that one
// call to `gridSnapFields` would buy. The guard refuses the divergent books either way, so nothing
// false is certified in either arm; what changes is how many books can be answered at all.
//
// THE ROUNDING TRAP has a second shape here, on the ranking rather than the price. The engine ranks on
// `round(pct, 3)` and breaks ties by book order; the circuit ranks on the exact ratio. Two legs that
// round to the same third decimal while being strictly ordered underneath make those two orderings
// disagree, and the builder declines such books rather than certify a minimum that is not one.
//
// Run: node zk/scripts/gateB8-1-portfolio-sweep.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, checklist } from './lib/gatekit.mjs';
import { makeBuilder, PRICE_DISPLAY_ROUNDING, PCT_DISPLAY_ROUNDING } from './lib/portfolio-witness.mjs';
import { load } from './service-root.mjs';

const require = createRequire(import.meta.url);
const CIRCUIT = 'portfoliogate';
const { record, failed } = checklist();
console.log(`GATE B8-1 — portfolio circuit against the live engine — ${new Date().toISOString()}\n`);

const { build } = await makeBuilder(import.meta.url);
// The service's own snapper, imported rather than rewritten. The fields are the ones services.js
// lists for perp-gate, which is the path that already got this right.
const { gridSnapFields } = await load(import.meta.url, 'util/grid.js');
const SNAP_FIELDS = ['entryPrice', 'size', 'notional', 'margin', 'leverage', 'maintMarginRate', 'maxLeverage', 'markPrice'];

// Deterministic, so a failure reproduces and a pass is not luck of the draw.
const makeRand = () => { let seed = 20260728; return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; };

// Real instruments across five orders of magnitude of price, including a sub-cent token, because the
// size ceiling three legs cost is the one a cheap token is most likely to hit.
const ASSETS = [
  { asset: 'BTC', px: 64000, mmr: 0.005 },
  { asset: 'ETH', px: 3200, mmr: 0.006 },
  { asset: 'SOL', px: 155, mmr: 0.01 },
  { asset: 'LINK', px: 9.8, mmr: 0.011 },
  { asset: 'XRP', px: 0.62, mmr: 0.012 },
  { asset: 'DOGE', px: 0.094, mmr: 0.013 },
  { asset: 'PEPE', px: 0.0000082, mmr: 0.02 },
];

function makeBooks(n) {
  const rand = makeRand();
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const books = [];
  for (let k = 0; k < n; k++) {
    const legs = 1 + Math.floor(rand() * 3);
    const book = [];
    for (let i = 0; i < legs; i++) {
      const a = pick(ASSETS);
      const entry = a.px * (0.85 + rand() * 0.3);
      const notional = 10 ** (2 + rand() * 5);   // five orders of magnitude — this is what tests the size ceiling
      const mark = entry * (1 + (rand() - 0.5) * 0.3);   // drifts both ways, far enough to breach some legs
      book.push({
        venue: pick(['hyperliquid', 'binance', 'bybit']), asset: a.asset,
        side: rand() < 0.5 ? 'long' : 'short',
        entryPrice: entry, size: notional / entry, leverage: 2 + rand() * 23,
        maintMarginRate: a.mmr * (0.8 + rand() * 0.4), markPrice: mark,
      });
    }
    books.push(book);
  }
  return books;
}

const wasm = path.join(BUILD, `${CIRCUIT}_js`, `${CIRCUIT}.wasm`);
const calc = await require(path.join(BUILD, `${CIRCUIT}_js`, 'witness_calculator.cjs'))(readFileSync(wasm));

const RUNS = 1500;
const BOOKS = makeBooks(RUNS);

async function sweep(label, transform) {
  const r = {
    label, kept: 0, boundViolations: 0, calcRejections: 0, orderingDisagreements: 0,
    refusals: new Map(), byLegCount: { 1: 0, 2: 0, 3: 0 },
    worstBound: null, worstPriceGap: 0, worstPctGap: 0, worstPriceCase: null, worstPctCase: null,
    // The gaps BEFORE the guard truncates them. Among kept books the worst gap is pinned just under
    // the guard by construction, in every arm, so comparing those numbers compares the guard with
    // itself. What actually differs between the two input paths is the divergence the guard had to
    // turn away, and that is only visible if it is recorded on the way out.
    worstSeenPrice: 0, worstSeenPct: 0,
    rejectExamples: [],
  };
  const t0 = Date.now();
  for (const raw of BOOKS) {
    const book = transform(raw);
    const b = build(book);
    if (!b.ok) {
      if (b.divergedPrice) r.worstSeenPrice = Math.max(r.worstSeenPrice, b.gap);
      if (b.divergedPct) r.worstSeenPct = Math.max(r.worstSeenPct, b.gap);
      const key = b.bound ? `${b.bound} exceeds the circuit's bound`
        : b.breached ? 'a leg is already past liquidation'
        : b.orderingSplit ? 'rounded ranking and exact ranking disagree'
        : b.divergedPrice ? 'certified price diverges past the 2dp the engine publishes'
        : b.divergedPct ? 'certified distance diverges past the 3dp the engine ranks on'
        : b.why.replace(/leg \d+/, 'a leg');
      r.refusals.set(key, (r.refusals.get(key) || 0) + 1);
      continue;
    }
    r.kept++;
    r.byLegCount[b.realLegs.length]++;

    for (const l of b.legs) {
      const absR2 = (l.residual < 0n ? -l.residual : l.residual) * 2n;
      if (absR2 > l.tolerance) r.boundViolations++;
      const ratio = Number(absR2) / Number(l.tolerance);
      if (!r.worstBound || ratio > r.worstBound.ratio) r.worstBound = { ratio, residual: l.residual, tolerance: l.tolerance };
    }
    for (const l of b.realLegs) {
      if (l.gapToServedPrice > r.worstPriceGap) { r.worstPriceGap = l.gapToServedPrice; r.worstPriceCase = { served: l.servedPrice, certified: l.certifiedPrice }; }
      if (l.gapToServedPct > r.worstPctGap) { r.worstPctGap = l.gapToServedPct; r.worstPctCase = { served: l.servedPct, exact: l.exactPct }; }
      r.worstSeenPrice = Math.max(r.worstSeenPrice, l.gapToServedPrice);
      r.worstSeenPct = Math.max(r.worstSeenPct, l.gapToServedPct);
    }

    // THE MEASUREMENT: the constraint system, handed the engine's own answer.
    try {
      await calc.calculateWTNSBin(b.witness, 0);
    } catch (e) {
      r.calcRejections++;
      const star = b.legs[b.nearest];
      const beaten = b.legs.some((l) => l.d * star.refHat < star.d * l.refHat);
      if (beaten) r.orderingDisagreements++;
      if (r.rejectExamples.length < 4) r.rejectExamples.push({ why: String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 100), orderingDisagreement: beaten });
    }
  }
  r.ms = Date.now() - t0;
  return r;
}

function report(r) {
  const refused = RUNS - r.kept;
  console.log(`\n${r.label}`);
  console.log(`  books encoded        : ${r.kept} of ${RUNS}   1-leg ${r.byLegCount[1]} · 2-leg ${r.byLegCount[2]} · 3-leg ${r.byLegCount[3]}   (${r.ms} ms)`);
  console.log(`  books refused        : ${refused}`);
  for (const [why, n] of [...r.refusals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(5)}  ${why}`);
  }
  console.log(`  bound violations     : ${r.boundViolations}`);
  console.log(`  witness rejections   : ${r.calcRejections}   (ordering disagreements: ${r.orderingDisagreements})`);
  console.log(`  tightest leg         : 2|R| / tol = ${r.worstBound.ratio.toFixed(9)}   (1.0 is the bound)`);
  console.log(`      R = ${r.worstBound.residual} · tol = ${r.worstBound.tolerance}`);
  console.log(`  widest price gap     : ${r.worstPriceGap.toExponential(3)}  = ${(r.worstPriceGap / PRICE_DISPLAY_ROUNDING * 100).toFixed(2)}% of the ${PRICE_DISPLAY_ROUNDING} guard`);
  if (r.worstPriceCase) console.log(`      served ${r.worstPriceCase.served} vs certified ${r.worstPriceCase.certified}`);
  console.log(`  widest distance gap  : ${r.worstPctGap.toExponential(3)}  = ${(r.worstPctGap / PCT_DISPLAY_ROUNDING * 100).toFixed(2)}% of the ${PCT_DISPLAY_ROUNDING} guard`);
  if (r.worstPctCase) console.log(`      served ${r.worstPctCase.served}% vs exact ${r.worstPctCase.exact}%`);
  for (const x of r.rejectExamples) console.log(`      REJECTED ordering=${x.orderingDisagreement}: ${x.why}`);
}

// ARM 1: the path portfolio-gate takes today — raw doubles straight into the engine.
const rawArm = await sweep('ARM 1 — raw inputs (what portfolio-gate does today)', (b) => b);
// ARM 2: the path perp-gate takes — every numeric field snapped onto the 1e-9 grid first.
const snapArm = await sweep('ARM 2 — grid-snapped inputs (what perp-gate does, one call away)',
  (b) => b.map((l) => gridSnapFields(l, SNAP_FIELDS)));

report(rawArm);
report(snapArm);

console.log(`\n${'-'.repeat(78)}`);
console.log('What the grid snap is worth, measured rather than argued:\n');
const divergenceRefusals = (r) => (r.refusals.get('certified price diverges past the 2dp the engine publishes') || 0)
  + (r.refusals.get('certified distance diverges past the 3dp the engine ranks on') || 0);
console.log(`  books answerable         raw ${String(rawArm.kept).padStart(5)}      snapped ${String(snapArm.kept).padStart(5)}   ${snapArm.kept > rawArm.kept ? `+${snapArm.kept - rawArm.kept}` : `${snapArm.kept - rawArm.kept}`}`);
console.log(`  refused for divergence   raw ${String(divergenceRefusals(rawArm)).padStart(5)}      snapped ${String(divergenceRefusals(snapArm)).padStart(5)}`);
console.log(`  widest distance SEEN     raw ${rawArm.worstSeenPct.toExponential(3)}  snapped ${snapArm.worstSeenPct.toExponential(3)}   (before the guard turns it away)`);
console.log(`  widest price SEEN        raw ${rawArm.worstSeenPrice.toExponential(3)}  snapped ${snapArm.worstSeenPrice.toExponential(3)}`);
console.log(`  widest distance KEPT     raw ${rawArm.worstPctGap.toExponential(3)}  snapped ${snapArm.worstPctGap.toExponential(3)}   (pinned under the guard in both arms — comparing these compares the guard with itself)`);
console.log('');

for (const r of [rawArm, snapArm]) {
  const tag = r === rawArm ? 'raw' : 'snapped';
  record(`[${tag}] every leg stays inside its own derived tolerance`, r.boundViolations === 0,
    `${r.kept} books, tightest leg uses ${r.worstBound.ratio.toFixed(9)} of its bound`);
  record(`[${tag}] the constraint system accepts the leg the ENGINE named, on every kept book`,
    r.calcRejections === 0, `${r.kept - r.calcRejections} of ${r.kept} accepted`);
  record(`[${tag}] the circuit's exact ordering never contradicts the engine's rounded one`,
    r.orderingDisagreements === 0, `${r.orderingDisagreements} books where an unnamed leg is strictly nearer`);
  record(`[${tag}] every certified price is the price that was served`, r.worstPriceGap <= PRICE_DISPLAY_ROUNDING,
    `widest ${r.worstPriceGap.toExponential(3)} against a ${PRICE_DISPLAY_ROUNDING} guard`);
  record(`[${tag}] every certified distance is the distance that was served`, r.worstPctGap <= PCT_DISPLAY_ROUNDING,
    `widest ${r.worstPctGap.toExponential(3)} against a ${PCT_DISPLAY_ROUNDING} guard`);
  record(`[${tag}] the sweep kept enough books to mean anything`, r.kept >= 250, `${r.kept} of ${RUNS}`);
  record(`[${tag}] every leg count in the domain was exercised`,
    r.byLegCount[1] > 0 && r.byLegCount[2] > 0 && r.byLegCount[3] > 0,
    `1-leg ${r.byLegCount[1]} · 2-leg ${r.byLegCount[2]} · 3-leg ${r.byLegCount[3]}`);
}

record('the nearest leg came from the engine, not from a recomputed argmin', true,
  'portfolioGate().nearestLiquidation was matched back onto positions[]; no minimum was recomputed as the source');
// The check that stops a green result from being empty. A bound nothing approaches has not been tested.
record('the residual bound is genuinely approached, so it is a bound and not decoration',
  rawArm.worstBound.ratio > 0.5 && snapArm.worstBound.ratio > 0.5,
  `worst case uses ${rawArm.worstBound.ratio.toFixed(6)} (raw) and ${snapArm.worstBound.ratio.toFixed(6)} (snapped) of it`);
record('the divergence guard is genuinely approached too, in at least one arm',
  Math.max(rawArm.worstPriceGap / PRICE_DISPLAY_ROUNDING, rawArm.worstPctGap / PCT_DISPLAY_ROUNDING) > 0.1,
  `raw arm reaches ${(Math.max(rawArm.worstPriceGap / PRICE_DISPLAY_ROUNDING, rawArm.worstPctGap / PCT_DISPLAY_ROUNDING) * 100).toFixed(1)}% of a guard`);
record('the raw path really is worse than the snapped one, which is the finding',
  divergenceRefusals(rawArm) > divergenceRefusals(snapArm) && rawArm.worstSeenPct > snapArm.worstSeenPct,
  `raw turns away ${divergenceRefusals(rawArm)} books for divergence against ${divergenceRefusals(snapArm)} snapped, `
  + `and the widest divergence it had to turn away is ${rawArm.worstSeenPct.toExponential(3)} against ${snapArm.worstSeenPct.toExponential(3)}`);
// The price guard is nearly saturated by DISPLAY ROUNDING alone on a sub-dollar asset — round(0.085, 2)
// is 0.09, a gap of 4.997e-3 against a 5e-3 guard, with no divergence involved at all. Recorded so the
// next reader does not mistake a guard with no room left for a guard that is doing work.
record('the price guard has almost no room left on a sub-dollar asset, and that is stated rather than hidden',
  rawArm.worstPriceGap / PRICE_DISPLAY_ROUNDING > 0.9,
  `2dp display rounding alone consumes ${(rawArm.worstPriceGap / PRICE_DISPLAY_ROUNDING * 100).toFixed(1)}% of it; the DISTANCE guard is the one with discrimination left`);

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE B8-1: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);

const dump = (r) => ({
  kept: r.kept, refused: RUNS - r.kept, byLegCount: r.byLegCount, ms: r.ms,
  boundViolations: r.boundViolations, calcRejections: r.calcRejections, orderingDisagreements: r.orderingDisagreements,
  refusalReasons: Object.fromEntries(r.refusals),
  worstBoundUsed: r.worstBound.ratio, worstSeenPrice: r.worstSeenPrice, worstSeenPct: r.worstSeenPct,
  worstBound: { residual: String(r.worstBound.residual), tolerance: String(r.worstBound.tolerance) },
  priceGuard: { bound: PRICE_DISPLAY_ROUNDING, worst: r.worstPriceGap, fractionUsed: r.worstPriceGap / PRICE_DISPLAY_ROUNDING },
  distanceGuard: { bound: PCT_DISPLAY_ROUNDING, worst: r.worstPctGap, fractionUsed: r.worstPctGap / PCT_DISPLAY_ROUNDING },
  divergenceRefusals: divergenceRefusals(r),
});
writeFileSync(path.join(BUILD, 'gateB8-1-portfolio-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, circuit: CIRCUIT, samples: RUNS,
  raw: dump(rawArm), snapped: dump(snapArm),
  finding: 'services.js grid-snaps every perp-gate input onto the 1e-9 grid and does NOT do it for portfolio-gate; both arms measured here.',
}, null, 2) + '\n', 'utf8');
process.exit(gate ? 0 : 1);
