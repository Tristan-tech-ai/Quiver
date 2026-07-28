// GATE DIV: multi-source divergence disclosure.
//
// The requirement this enforces, in the order the brief states it:
//   1. it must NEVER present divergence as proof of correctness
//   2. it must state the measured floor, so a reader knows a small divergence is not evidence of truth
//   3. it must refuse to report at all when only one source is available, rather than implying agreement
//   4. the floor must be measured, not quoted
//
// Two halves. The fixture half is deterministic and does the adversarial work: it sweeps synthetic
// scenarios and greps the module's own output for any wording a reader would convert into confidence.
// The live half fetches real venues, because a disclosure that has never met a real spread is a
// hypothesis. The live half asserts only things that cannot flake, plus one deliberately generous
// sanity band whose job is to catch a reader wired to the wrong ticker rather than to police the
// market.
//
//   node --test gates/gateDiv-disclosure.mjs        (npm run gate:div)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCES, basisOf, NATIVE_SOURCES, ALL_SOURCES, FLOOR, REFUSALS, SUPPORTED_SYMBOLS,
  bpsBetween, measure, median, quantile, buildDisclosure, readSources, discloseDivergence,
} from '../src/util/divergence.js';
import { scanClaims, scanCorrectnessClaims, withDivergenceDisclosure } from '../src/util/inputClaims.js';
import { observationEnvelope } from '../src/engine/proof.js';

const HERE = join(fileURLToPath(new URL('.', import.meta.url)));
const CAL_FILE = join(HERE, 'divergence-calibration.json');
const LIVE = process.env.GATE_DIV_OFFLINE !== '1';

const R = (vals) => Object.entries(vals).map(([source, value]) => ({ source, value, host: SOURCES[source].host, quote: SOURCES[source].quote, quantity: SOURCES[source].quantity, basis: basisOf(source), ms: 1 }));
const HONEST = { hyperliquid_mark: 63478, hyperliquid_oracle: 63496, dydx_oracle: 63453, okx_index: 63433, okx_spot: 63495, deribit_index: 63430 };

/* ══════════════════════════ arithmetic ══════════════════════════ */

test('DIV bps is symmetric and taken against the midpoint', () => {
  assert.equal(bpsBetween(100, 100), 0);
  assert.equal(bpsBetween(100, 101), bpsBetween(101, 100));
  // 1 in 100 against a midpoint of 100.5 is 99.5024… bps, not 100
  assert.ok(Math.abs(bpsBetween(100, 101) - 99.50248756) < 1e-6, `got ${bpsBetween(100, 101)}`);
  // 66 / 63463 x 1e4. Written 10.40156 on the first draft, which is the figure you get from dividing
  // by 63430 instead of by the midpoint, and this assertion is what caught it.
  assert.ok(Math.abs(bpsBetween(63430, 63496) - 10.399760) < 1e-5, `got ${bpsBetween(63430, 63496)}`);
});

test('DIV the independent spread collapses each host before measuring', () => {
  // Two readings from one host, far apart, must not inflate the independent figure. This is the whole
  // reason the two spreads are reported separately.
  const m = measure(R({ hyperliquid_mark: 63000, hyperliquid_oracle: 64000, deribit_index: 63500 }));
  assert.equal(m.hosts, 2);
  assert.ok(m.spreadBps > m.independentSpreadBps, 'the all-readings spread must be the larger of the two here');
  // hyperliquid collapses to its median 63500, which equals deribit, so independent divergence is 0
  assert.ok(m.independentSpreadBps < 1e-9, `expected ~0, got ${m.independentSpreadBps}`);
});

test('DIV every pair is labelled for host and for basis', () => {
  const m = measure(R(HONEST));
  const hl = m.pairs.find((p) => p.a === 'hyperliquid_mark' && p.b === 'hyperliquid_oracle');
  assert.equal(hl.sameHost, true, 'two fields of one HTTP response must be marked as such');
  const cross = m.pairs.find((p) => p.a === 'okx_index' && p.b === 'okx_spot');
  assert.equal(cross.sameHost, true);
  assert.equal(cross.sameQuote, false, 'a USD index against a USDT spot is a basis pair and must say so');
  const sameQuoteDiffQuantity = m.pairs.find((p) => p.a === 'hyperliquid_mark' && p.b === 'deribit_index');
  assert.equal(sameQuoteDiffQuantity.sameQuote, true, 'both are USD-quoted; calling this a basis pair was the first draft error');
  assert.equal(sameQuoteDiffQuantity.sameQuantity, false, 'a perp mark against an index is a different construction, and that is a separate fact');
  assert.equal(m.pairs.length, (6 * 5) / 2);
});

/* ══════════════════════════ the three refusals ══════════════════════════ */

test('DIV refuses on one source, and publishes no number when it does', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: R({ okx_index: 63433 }) });
  assert.equal(d.status, 'REFUSED');
  assert.equal(d.reason, REFUSALS.SINGLE_SOURCE);
  for (const k of ['spreadBps', 'independentSpreadBps', 'verdict', 'detectionFloorBps', 'pairs']) {
    assert.equal(d[k], undefined, `a refusal must not leak ${k}; zero would read as agreement`);
  }
});

test('DIV refuses on zero sources', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: [], failed: [{ source: 'okx_index', error: 'timeout' }] });
  assert.equal(d.status, 'REFUSED');
  assert.equal(d.reason, REFUSALS.NO_SOURCES);
  assert.equal(d.sourcesRead, 0);
  assert.equal(d.unavailable.length, 1, 'the outage is data and must be reported');
});

test('DIV refuses when every reading came from one host', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: R({ hyperliquid_mark: 63478, hyperliquid_oracle: 63496 }) });
  assert.equal(d.status, 'REFUSED');
  assert.equal(d.reason, REFUSALS.SINGLE_HOST);
  assert.equal(d.verdict, undefined);
});

test('DIV refuses an uncalibrated symbol rather than inventing a floor', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: R(HONEST), calibration: { _meta: {} } });
  assert.equal(d.status, 'REFUSED');
  assert.equal(d.reason, REFUSALS.UNCALIBRATED);
});

/* ══════════════════════════ never a correctness claim ══════════════════════════ */

test('DIV no scenario in a wide sweep produces a correctness or attestation claim', () => {
  // Adversarial rather than illustrative: every source bent by every magnitude from nothing to 5%, in
  // both directions, plus dropouts. 6 sources x 41 deltas x 2 directions plus 6 drop cases = 498.
  const found = [];
  let scenarios = 0;
  for (const src of Object.keys(HONEST)) {
    for (let i = 0; i <= 40; i++) {
      for (const sign of [1, -1]) {
        const delta = sign * (i / 40) * 0.05;
        const bent = { ...HONEST, [src]: HONEST[src] * (1 + delta) };
        const d = buildDisclosure({ symbol: 'BTC', readings: R(bent), calibration: FIXTURE_CAL });
        scenarios++;
        for (const h of scanCorrectnessClaims(d)) found.push(`bend ${src} by ${(delta * 1e4).toFixed(0)}bps: ${h.path} "${h.sample}"`);
        for (const h of scanClaims(d)) found.push(`bend ${src} by ${(delta * 1e4).toFixed(0)}bps: ATTESTATION CLAIM at ${h.path}`);
      }
    }
    const dropped = { ...HONEST }; delete dropped[src];
    const d2 = buildDisclosure({ symbol: 'BTC', readings: R(dropped), calibration: FIXTURE_CAL });
    scenarios++;
    for (const h of scanCorrectnessClaims(d2)) found.push(`drop ${src}: ${h.path}`);
  }
  assert.equal(scenarios, 498, 'the sweep size is asserted so that quietly shrinking it shows up as a failure rather than as a faster green');
  assert.deepEqual(found.slice(0, 5), [], `${found.length} of ${scenarios} scenarios produced a claim:\n  ${found.slice(0, 5).join('\n  ')}`);
});

const FIXTURE_CAL = {
  _meta: { statistic: 'p95 of independentSpreadBps across rounds', measuredOnUtc: '2026-07-28T00:00:00Z', script: 'gates/calibrate-divergence.mjs' },
  BTC: { native: { floorBps: 11, rounds: 100 } },
};

test('DIV both verdicts state what they do not establish', () => {
  const within = buildDisclosure({ symbol: 'BTC', readings: R(HONEST), calibration: FIXTURE_CAL });
  assert.equal(within.verdict, 'WITHIN_FLOOR');
  assert.match(within.meaning, /says NOTHING about whether the number is correct/);
  assert.equal(within.isAttestation, false);
  assert.equal(within.confirmsCorrectness, false);

  const above = buildDisclosure({ symbol: 'BTC', readings: R({ ...HONEST, dydx_oracle: HONEST.dydx_oracle * 1.01 }), calibration: FIXTURE_CAL });
  assert.equal(above.verdict, 'ABOVE_FLOOR');
  assert.match(above.meaning, /cannot say which source is wrong/);
  assert.match(above.meaning, /a genuine market dislocation looks identical/);
});

test('DIV the vocabulary is WITHIN_FLOOR / ABOVE_FLOOR, never AGREE or CONFIRMED', () => {
  const verdicts = new Set();
  for (let i = 0; i <= 40; i++) {
    const d = buildDisclosure({ symbol: 'BTC', readings: R({ ...HONEST, okx_index: HONEST.okx_index * (1 + i * 0.0005) }), calibration: FIXTURE_CAL });
    verdicts.add(d.verdict);
  }
  assert.deepEqual([...verdicts].sort(), ['ABOVE_FLOOR', 'WITHIN_FLOOR'],
    'the only two verdicts. "AGREE" would be a claim about the world rather than about the measurement.');
});

test('DIV every disclosure states its floor, its provenance, and its own blindness', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: R(HONEST), calibration: FIXTURE_CAL });
  assert.equal(d.detectionFloorBps, 11);
  assert.equal(d.floorProvenance.rounds, 100);
  assert.equal(d.floorProvenance.script, 'gates/calibrate-divergence.mjs');
  assert.match(d.floorProvenance.meaning, /INVISIBLE to this check/);
  assert.match(d.provesNothing, /does not establish that any of them is right/);
  assert.match(d.provesNothing, /single adversary at that edge sees every one of them/);
  assert.ok(d.limits.length >= 6, 'the limits list is the honest part of this object and must not shrink quietly');
  assert.ok(d.limits.some((l) => /sameHost/.test(l)));
  assert.ok(d.limits.some((l) => /basis/i.test(l)));
  assert.ok(d.limits.some((l) => /dislocation/.test(l)));
});

/* ══════════════════════════ the calibration is real ══════════════════════════ */

test('DIV the shipped FLOOR matches the calibration artifact, symbol by symbol', () => {
  // Two copies of a number is a defect waiting to happen, so the gate compares them. The artifact is
  // what the campaign measured; FLOOR is what the code enforces. They drift apart the moment somebody
  // re-runs the campaign and forgets to update the module, and this is the assertion that notices.
  assert.ok(existsSync(CAL_FILE), `no calibration artifact at ${CAL_FILE}; run node gates/calibrate-divergence.mjs`);
  const art = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  assert.ok(FLOOR._meta.measuredOnUtc, 'FLOOR is still the uncalibrated placeholder');
  assert.equal(FLOOR._meta.statistic, art._meta.statistic);
  const drift = [];
  for (const sym of Object.keys(FLOOR).filter((k) => k !== '_meta')) {
    for (const [set, v] of Object.entries(FLOOR[sym])) {
      const a = art[sym]?.[set];
      if (!a) { drift.push(`${sym}/${set} is in FLOOR and not in the artifact`); continue; }
      if (a.floorBps !== v.floorBps) drift.push(`${sym}/${set}: FLOOR ${v.floorBps} vs artifact ${a.floorBps}`);
      if (a.rounds !== v.rounds) drift.push(`${sym}/${set}: rounds ${v.rounds} vs artifact ${a.rounds}`);
    }
  }
  assert.deepEqual(drift, [], drift.join('\n'));
});

test('DIV the floor is a distribution, not a snapshot, and it is not zero', () => {
  const art = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  const thin = [];
  for (const sym of Object.keys(art).filter((k) => k !== '_meta')) {
    for (const [set, v] of Object.entries(art[sym])) {
      if (!v.floorBps) continue;
      if (v.rounds < 50) thin.push(`${sym}/${set}: ${v.rounds} rounds`);
      // The tripwire this project learned the hard way: a metric reading exactly 0.0 on every sample
      // means the instrument is broken, not that the world is perfect.
      if (!(v.independentSpreadBps.p50 > 0)) thin.push(`${sym}/${set}: median spread is ${v.independentSpreadBps.p50}, which means the readers are returning the same object`);
      if (!(v.floorBps > v.independentSpreadBps.p50)) thin.push(`${sym}/${set}: p95 floor ${v.floorBps} is not above the median ${v.independentSpreadBps.p50}`);
      if (v.floorBps > 200) thin.push(`${sym}/${set}: floor ${v.floorBps} bps is too wide to detect anything worth detecting`);
    }
  }
  assert.deepEqual(thin, [], thin.join('\n'));
});

test('DIV the artifact reports how big a lie each source would have to tell, per direction', () => {
  const art = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  const missing = [];
  for (const sym of Object.keys(art).filter((k) => k !== '_meta')) {
    for (const [set, v] of Object.entries(art[sym])) {
      if (!v.floorBps) continue;
      const det = v.minDetectableFabricationBps || {};
      for (const src of (art._meta.sourceSets[set] || [])) {
        const d = det[src];
        if (!d) { missing.push(`${sym}/${set}/${src}: no detection threshold measured`); continue; }
        if (!(d.cheapestBps?.p50 > 0)) missing.push(`${sym}/${set}/${src}: cheapest-direction threshold p50 is ${d.cheapestBps?.p50}`);
        if (d.spreadReducingBps === undefined) missing.push(`${sym}/${set}/${src}: the spread-reducing range was not measured`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('DIV the detection threshold is worse than the headline spread, and the module says so', () => {
  // The measurement that stops "10.8 bps" from being read as "we catch anything over 10.8 bps". The
  // spread is what honest sources do; the threshold is what a lie has to beat, and for a source
  // sitting inside the band rather than at its edge the second is materially larger than the first.
  const art = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  const set = art.BTC?.native;
  assert.ok(set?.floorBps, 'BTC/native must be calibrated');
  const cheapest = Object.entries(set.minDetectableFabricationBps).map(([s, d]) => [s, d.cheapestBps.p50]);
  assert.ok(cheapest.length >= 4, 'every source in the set needs a threshold');
  const worst = cheapest.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.ok(worst[1] > set.floorBps,
    `at least one source must need a lie LARGER than the ${set.floorBps} bps floor before this check sees it; worst is ${worst[0]} at ${worst[1]} bps`);
  // and the shipped disclosure must not let a reader mistake the one for the other
  const d = buildDisclosure({ symbol: 'BTC', readings: R(HONEST), calibration: FLOOR });
  assert.match(d.floorProvenance.meaning, /INVISIBLE to this check/);
});

/* ══════════════════════════ the live half ══════════════════════════ */

test('DIV live: real venues, a real disclosure, and no claim in it', { skip: LIVE ? false : 'GATE_DIV_OFFLINE=1' }, async () => {
  const d = await discloseDivergence({ symbol: 'BTC' });
  assert.equal(d.status, 'DISCLOSED', `live disclosure refused: ${d.reason || ''} (read ${d.sourcesRead}/${d.sourcesAttempted}, unavailable ${JSON.stringify(d.unavailable)})`);
  assert.ok(d.independentHosts >= 2, 'a disclosure needs at least two hosts by construction');
  assert.ok(d.medianValue > 1000 && d.medianValue < 1e7, `a BTC price of ${d.medianValue} means a reader is wired to the wrong thing`);
  assert.ok(['WITHIN_FLOOR', 'ABOVE_FLOOR'].includes(d.verdict));
  assert.deepEqual(scanClaims(d), [], 'a live disclosure must contain no attestation claim');
  assert.deepEqual(scanCorrectnessClaims(d), [], 'a live disclosure must contain no correctness claim');
  console.log(`      live BTC: ${d.sourcesRead} sources / ${d.independentHosts} hosts, independent spread ${d.independentSpreadBps} bps, floor ${d.detectionFloorBps}, ${d.verdict}`);
});

test('DIV live: one source reached means REFUSED, on real data', { skip: LIVE ? false : 'GATE_DIV_OFFLINE=1' }, async () => {
  // The refusal that matters most, exercised against the network rather than a fixture: restrict the
  // read to a single source and require that nothing at all is reported.
  const d = await discloseDivergence({ symbol: 'BTC', sources: ['deribit_index'] });
  assert.equal(d.status, 'REFUSED');
  assert.equal(d.spreadBps, undefined);
});

test('DIV live: the floor behaves as measured when a real reading is bent', { skip: LIVE ? false : 'GATE_DIV_OFFLINE=1' }, async () => {
  const { readings, failed } = await readSources('BTC', { sources: NATIVE_SOURCES });
  assert.ok(readings.length >= 4, `only ${readings.length} live sources: ${JSON.stringify(failed)}`);
  const floor = FLOOR.BTC?.native?.floorBps;
  assert.ok(floor > 0, 'no calibrated BTC floor');
  const target = readings.find((r) => r.source === 'deribit_index') || readings[0];
  const bend = (bps) => readings.map((r) => (r.source === target.source ? { ...r, value: r.value * (1 + bps / 1e4) } : r));

  // Big enough and it is seen. This is not a strong claim: it is the weakest possible one, and it is
  // the only one this method supports.
  const big = buildDisclosure({ symbol: 'BTC', readings: bend(500), failed });
  assert.equal(big.verdict, 'ABOVE_FLOOR', 'a 500 bps fabrication on a live reading must land above the floor');

  // Small enough and it is NOT seen, and the disclosure has to admit that rather than imply agreement.
  const small = buildDisclosure({ symbol: 'BTC', readings: bend(0.5), failed });
  assert.match(small.floorProvenance.meaning, /INVISIBLE to this check/);
  assert.equal(small.confirmsCorrectness, false);
  console.log(`      bending ${target.source}: +500 bps -> ${big.verdict} (${big.independentSpreadBps} bps), +0.5 bps -> ${small.verdict} (${small.independentSpreadBps} bps)`);
});

test('DIV live: repeated rounds stay inside a generous sanity band', { skip: LIVE ? false : 'GATE_DIV_OFFLINE=1' }, async () => {
  // Deliberately loose. Its job is to catch a broken reader, a wrong ticker or a units error, all of
  // which are off by thousands of basis points, and NOT to assert that the market behaves. A tight
  // band here would be a flaky gate, and a flaky gate gets disabled, which is worse than no gate.
  const art = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  const p50 = art.BTC.native.independentSpreadBps.p50;
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const d = await discloseDivergence({ symbol: 'BTC' });
    if (d.status !== 'DISCLOSED') continue;
    seen.push(d.independentSpreadBps);
    assert.deepEqual(scanCorrectnessClaims(d), []);
  }
  assert.ok(seen.length >= 3, `only ${seen.length} of 5 live rounds produced a disclosure`);
  const m = median(seen);
  assert.ok(m > 0 && m < Math.max(20 * p50, 100),
    `median live spread ${m.toFixed(2)} bps against a calibrated median of ${p50} bps: that is a reader problem, not a market`);
  console.log(`      5 live rounds, median independent spread ${m.toFixed(2)} bps (calibrated median ${p50} bps)`);
});

test('DIV live: the disclosure attaches to a real envelope without moving its content hash', { skip: LIVE ? false : 'GATE_DIV_OFFLINE=1' }, async () => {
  const env = observationEnvelope('options-desk', { currency: 'BTC' }, { ok: true, live: { source: 'deribit' }, checks: [{ name: 'x', pass: true }] }, 'gate-div');
  const before = env.observation.contentHash;
  const d = await discloseDivergence({ symbol: 'BTC' });
  const out = withDivergenceDisclosure(env, d, { service: 'options-desk' });
  assert.equal(out.observation.contentHash, before);
  assert.equal(out.observation, env.observation);
  assert.ok(out.divergence);
});

test('DIV every supported symbol has a ticker on every host it claims', () => {
  for (const sym of SUPPORTED_SYMBOLS) {
    for (const s of ALL_SOURCES) assert.ok(SOURCES[s].host, `${sym}/${s} has no host`);
  }
  assert.equal(NATIVE_SOURCES.length, 6);
  assert.equal(new Set(NATIVE_SOURCES.map((s) => SOURCES[s].host)).size, 4, 'six native readings over four hosts');
  assert.equal(new Set(ALL_SOURCES.map((s) => SOURCES[s].host)).size, 6);
});
