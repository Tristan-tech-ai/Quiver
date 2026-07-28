// calibrate-divergence.mjs: measure the honest-disagreement floor, over many rounds, with the
// readers that ship.
//
// PHASE_D_RESEARCH.md §3.5 reports a full spread of 10.8 bps over four rounds of nine sources. Four
// rounds is a snapshot: it cannot separate "this is where the sources sit" from "this is where they
// sat for eight seconds". This script runs the SAME readers `src/util/divergence.js` uses in
// production, over hundreds of rounds, and reports a distribution rather than a number.
//
// It also measures the thing a reader actually wants to know and which a spread alone does not give:
// HOW BIG A FABRICATION HAS TO BE BEFORE THIS CHECK COULD SEE IT. For every source and every round it
// solves for the smallest multiplicative lie on that one source that pushes the independent headline
// spread past the floor. That number is the real detection threshold, it is different per source, and
// it is strictly worse than the headline spread for any source that already sits at an extreme.
//
//   node gates/calibrate-divergence.mjs --rounds 320 --interval 3500
//   node gates/calibrate-divergence.mjs --analyse-only        (re-derive from the saved raw samples)
//
// Writes gates/divergence-calibration.json. The FLOOR constant in src/util/divergence.js is checked
// against that artifact by gateDiv-disclosure.mjs, so the two cannot drift apart silently.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSources, measure, quantile, median, SOURCES, basisOf, NATIVE_SOURCES, ALL_SOURCES } from '../src/util/divergence.js';

const HERE = join(fileURLToPath(new URL('.', import.meta.url)));
const RAW = join(HERE, '.divergence-raw.json');
const OUT = join(HERE, 'divergence-calibration.json');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const ROUNDS = Number(arg('--rounds', 320));
const INTERVAL = Number(arg('--interval', 3500));
const CYCLE = ['BTC', 'BTC', 'ETH', 'SOL'];
const SETS = { native: NATIVE_SOURCES, all: ALL_SOURCES };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collect() {
  const samples = [];
  const started = new Date().toISOString();
  for (let n = 0; n < ROUNDS; n++) {
    const symbol = CYCLE[n % CYCLE.length];
    const t = Date.now();
    const { readings, failed } = await readSources(symbol, { sources: ALL_SOURCES, timeoutMs: 12000 });
    samples.push({ n, symbol, at: new Date().toISOString(), readings: readings.map((r) => ({ s: r.source, v: r.value })), failed: failed.map((f) => f.source) });
    if (n % 20 === 0) {
      const m = readings.length >= 2 ? measure(readings) : null;
      process.stdout.write(`  round ${String(n).padStart(4)}  ${symbol}  ${readings.length}/${ALL_SOURCES.length} sources  indep spread ${m ? m.independentSpreadBps.toFixed(2) : 'n/a'} bps\n`);
    }
    const wait = INTERVAL - (Date.now() - t);
    if (wait > 0 && n < ROUNDS - 1) await sleep(wait);
  }
  writeFileSync(RAW, JSON.stringify({ started, finished: new Date().toISOString(), rounds: ROUNDS, intervalMs: INTERVAL, samples }));
  return { started, samples };
}

// Smallest multiplicative perturbation of ONE source that pushes the independent headline spread past
// `floor`. Bisection per direction, and BOTH answers are kept, because the two audiences want
// different numbers:
//
//   cheapest: the smaller of the two directions. What an adversary needs, since they pick the
//               direction. This is the honest "detection floor" for that source.
//   hardest: the larger. What a defender needs before saying "a fabrication of this size is
//               caught", since they do not get to choose.
//
// `spreadReducing` is the uncomfortable third measurement: the largest lie that leaves the sources
// looking AT LEAST AS AGREED as the truth did. Inside that range a fabrication does not merely evade
// the check, it improves the number the check reports.
function detectionProfile(readings, target, floorBps) {
  const idx = readings.findIndex((r) => r.source === target);
  if (idx < 0) return null;
  const spreadWith = (delta) => {
    const bent = readings.map((r, i) => (i === idx ? { ...r, value: r.value * (1 + delta) } : r));
    return measure(bent).independentSpreadBps;
  };
  const base = spreadWith(0);
  const perDir = {};
  for (const sign of [1, -1]) {
    let lo = 0, hi = 0.02; // 0 to 200 bps
    if (spreadWith(sign * hi) <= floorBps) { perDir[sign] = null; continue; }
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (spreadWith(sign * mid) > floorBps) hi = mid; else lo = mid;
    }
    perDir[sign] = hi * 10000;
  }
  const both = [perDir[1], perDir[-1]].filter((v) => v !== null);
  if (!both.length) return null;

  // Largest |delta| in either direction that does not increase the reported spread. Scanned rather
  // than bisected because the function is V-shaped rather than monotone around the minimum.
  let reducing = 0;
  for (const sign of [1, -1]) {
    for (let bps = 0.25; bps <= 60; bps += 0.25) {
      if (spreadWith((sign * bps) / 10000) <= base) reducing = Math.max(reducing, bps); else break;
    }
  }
  return { cheapest: Math.min(...both), hardest: both.length === 2 ? Math.max(...both) : null, spreadReducing: reducing };
}

function analyse(samples, started) {
  const out = {
    _meta: {
      measuredOnUtc: started,
      script: 'gates/calibrate-divergence.mjs',
      statistic: 'p95 of independentSpreadBps across rounds',
      rounds: samples.length,
      intervalMs: INTERVAL,
      sourceSets: { native: NATIVE_SOURCES, all: ALL_SOURCES },
      hostsPerSet: Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, [...new Set(v.map((s) => SOURCES[s].host))].length])),
    },
  };
  for (const symbol of [...new Set(samples.map((s) => s.symbol))]) {
    out[symbol] = {};
    const rows = samples.filter((s) => s.symbol === symbol);
    for (const [setName, set] of Object.entries(SETS)) {
      const wanted = new Set(set);
      const per = [], pairAcc = new Map(), reads = new Map();
      for (const row of rows) {
        const readings = row.readings.filter((r) => wanted.has(r.s)).map((r) => ({ source: r.s, value: r.v, host: SOURCES[r.s].host, quote: SOURCES[r.s].quote, quantity: SOURCES[r.s].quantity, basis: basisOf(r.s) }));
        if (readings.length < 2) continue;
        const m = measure(readings);
        if (m.hosts < 2) continue;
        per.push({ readings, m });
        for (const p of m.pairs) {
          const k = `${p.a}|${p.b}`;
          if (!pairAcc.has(k)) pairAcc.set(k, { a: p.a, b: p.b, sameHost: p.sameHost, sameQuote: p.sameQuote, sameQuantity: p.sameQuantity, v: [] });
          pairAcc.get(k).v.push(p.bps);
        }
        for (const r of readings) reads.set(r.source, (reads.get(r.source) || 0) + 1);
      }
      const spreads = per.map((x) => x.m.independentSpreadBps);
      const allSpreads = per.map((x) => x.m.spreadBps);
      if (!spreads.length) { out[symbol][setName] = { rounds: 0, note: 'no usable round' }; continue; }
      const floorBps = Number(quantile(spreads, 0.95).toFixed(2));

      // detection thresholds, computed against the floor this campaign just derived
      const det = {};
      for (const src of set) {
        const profs = per.map((x) => detectionProfile(x.readings, src, floorBps)).filter(Boolean);
        if (!profs.length) continue;
        const cheap = profs.map((p) => p.cheapest);
        const hard = profs.map((p) => p.hardest).filter((v) => v !== null);
        const red = profs.map((p) => p.spreadReducing);
        det[src] = {
          n: profs.length,
          cheapestBps: { p50: r2(median(cheap)), p95: r2(quantile(cheap, 0.95)), max: r2(Math.max(...cheap)) },
          hardestBps: hard.length ? { p50: r2(median(hard)), p95: r2(quantile(hard, 0.95)), max: r2(Math.max(...hard)) } : null,
          spreadReducingBps: { p50: r2(median(red)), p95: r2(quantile(red, 0.95)), max: r2(Math.max(...red)) },
        };
      }

      out[symbol][setName] = {
        rounds: spreads.length,
        floorBps,
        independentSpreadBps: { p50: r2(median(spreads)), p95: r2(quantile(spreads, 0.95)), p99: r2(quantile(spreads, 0.99)), max: r2(Math.max(...spreads)), min: r2(Math.min(...spreads)) },
        allReadingsSpreadBps: { p50: r2(median(allSpreads)), p95: r2(quantile(allSpreads, 0.95)), max: r2(Math.max(...allSpreads)) },
        sourceCoverage: Object.fromEntries([...reads.entries()].sort()),
        pairs: [...pairAcc.values()].map((p) => ({ a: p.a, b: p.b, sameHost: p.sameHost, sameQuote: p.sameQuote, sameQuantity: p.sameQuantity, n: p.v.length, p50: r2(median(p.v)), p95: r2(quantile(p.v, 0.95)), max: r2(Math.max(...p.v)) })).sort((x, y) => y.p95 - x.p95),
        minDetectableFabricationBps: det,
      };
    }
  }
  return out;
}

const r2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);

let started, samples;
if (process.argv.includes('--analyse-only')) {
  if (!existsSync(RAW)) { console.error(`no raw samples at ${RAW}; run the campaign first`); process.exit(2); }
  const raw = JSON.parse(readFileSync(RAW, 'utf8'));
  ({ started, samples } = raw);
  console.log(`re-analysing ${samples.length} saved rounds from ${started}\n`);
} else {
  console.log(`DIVERGENCE CALIBRATION: ${ROUNDS} rounds at ${INTERVAL} ms, cycling ${CYCLE.join('/')}\n`);
  ({ started, samples } = await collect());
}

const summary = analyse(samples, started);
writeFileSync(OUT, JSON.stringify(summary, null, 1));
console.log(`\nwrote ${OUT}\n`);
for (const sym of Object.keys(summary).filter((k) => k !== '_meta')) {
  for (const set of Object.keys(summary[sym])) {
    const s = summary[sym][set];
    if (!s.floorBps) continue;
    console.log(`${sym} / ${set}: ${s.rounds} rounds, floor(p95) ${s.floorBps} bps, p50 ${s.independentSpreadBps.p50}, max ${s.independentSpreadBps.max}`);
  }
}
