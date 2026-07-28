// Calibration for the Hyperliquid premium bound.
//
// Two numbers have to come from measurement rather than from a preference, and this script produces
// both, then writes them where the gate can read them:
//
//   margin   The bound LB(t) <= p(t) <= UB(t) rests on impact_bid <= best_bid and
//            impact_ask >= best_ask. That inequality is structural but the published impact prices
//            are rounded to the price grid and HyperCore's book moves between the states the EVM
//            precompiles expose, so at the HOUR level the mean bound occasionally sits a hair inside
//            the venue's own hourly premium. `margin` is the measured size of that, and it only ever
//            widens the bound. It is calibrated on one hour and VALIDATED OUT OF SAMPLE on another,
//            because a margin fitted and tested on the same rows is not a measurement.
//
//   the fixture   Per asset-hour: the accumulated bound from chain reads, beside the venue's OWN
//            published hourly premium and funding rate for that same hour. The gate replays it, so
//            the gate is deterministic while still being about real venue data.
//
// Usage:
//   node gates/calibrate-hl-premium-bound.mjs --tape <tape.jsonl> [--out gates/hl-premium-bound-calibration.json]
//
// The tape is produced by the sampler described in T10_HL_PREMIUM_BOUND.md §3: every 5 s, one
// pinned-block multicall reading 0x807 (oracle) and 0x80E (top of book) for the whole perp
// universe. It is large (~15 MB/hour) and lives outside the repo; only the derived calibration and
// the small fixture are committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accumulate, parseDecimal, formatFixed, ONE, BAND_LO, BAND_HI, PINNED_RATE } from '../src/adapters/hyperliquid-funding-bound.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TAPE = argOf('--tape');
const OUT = argOf('--out', path.join(ROOT, 'gates', 'hl-premium-bound-calibration.json'));
const FIXTURE = argOf('--fixture', path.join(ROOT, 'gates', 'hl-premium-bound-fixture.json'));
const UNIVERSE = argOf('--universe', TAPE ? path.join(path.dirname(TAPE), 'universe.json') : null);
if (!TAPE) { console.error('need --tape <tape.jsonl>'); process.exit(2); }

const INFO = 'https://api.hyperliquid.xyz/info';
const post = async (body) => {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 500 * (t + 1))); continue; }
      return await r.json();
    } catch { await new Promise((s) => setTimeout(s, 500 * (t + 1))); }
  }
  throw new Error('info exhausted');
};

const uni = JSON.parse(fs.readFileSync(UNIVERSE, 'utf8'));
const ticks = fs.readFileSync(TAPE, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log(`tape: ${ticks.length} ticks, ${new Date(ticks[0].t).toISOString()} -> ${new Date(ticks.at(-1).t).toISOString()}`);

// ── accumulate the chain bound per asset-hour ──────────────────────────────────────────────────
const byHour = new Map();
for (const tk of ticks) { const h = Math.floor(tk.t / 3600e3) * 3600e3; if (!byHour.has(h)) byHour.set(h, []); byHour.get(h).push(tk); }
const hours = [...byHour.keys()].sort((a, b) => a - b);
console.log('hours in tape:', hours.map((h) => `${new Date(h).toISOString().slice(11, 16)} (${byHour.get(h).length}/720)`).join('  '));

const rows = [];   // one per asset-hour
for (const h of hours) {
  const ts = byHour.get(h);
  for (const u of uni) {
    if (u.isDelisted) continue;
    const samples = [];
    for (const tk of ts) {
      const o = tk.orc[u.i], b = tk.bid[u.i], a = tk.ask[u.i];
      if (o == null || b == null || a == null || b === '0' || a === '0' || o === '0') continue;
      samples.push({ oracle: BigInt(o), bid: BigInt(b), ask: BigInt(a) });
    }
    if (samples.length < 20) continue;
    let acc; try { acc = accumulate(samples); } catch { continue; }
    rows.push({ hour: h, coin: u.name, idx: u.i, n: acc.n, coverage: ts.length / 720, oracleInsideBook: acc.oracleInsideBook, meanUB: acc.meanUB, meanLB: acc.meanLB });
  }
}
console.log(`accumulated ${rows.length} asset-hours`);

// ── the venue's own published hourly premium + funding rate for those hours ────────────────────
const coins = [...new Set(rows.map((r) => r.coin))];
const start = hours[0], end = hours.at(-1) + 3600e3;
const truth = new Map();
for (let k = 0; k < coins.length; k++) {
  const h = await post({ type: 'fundingHistory', coin: coins[k], startTime: start, endTime: end });
  if (Array.isArray(h)) for (const e of h) truth.set(`${coins[k]}|${e.time}`, { premium: e.premium, fundingRate: e.fundingRate });
  if (k % 50 === 0) console.log(`  truth ${k}/${coins.length}`);
  await new Promise((s) => setTimeout(s, 260));
}
let matched = 0;
for (const r of rows) { const t = truth.get(`${r.coin}|${r.hour}`); if (t) { r.premium = t.premium; r.fundingRate = t.fundingRate; matched++; } }
console.log(`asset-hours with a published premium: ${matched}/${rows.length}`);

// ── the residual: how far outside its own bound does the venue's hourly premium fall? ──────────
function residual(r) {
  const P = parseDecimal(r.premium);
  const below = r.meanLB - P, above = P - r.meanUB;
  return below > 0n ? below : (above > 0n ? above : 0n);
}
const scored = rows.filter((r) => r.premium != null && !(parseDecimal(r.premium) === 0n && parseDecimal(r.fundingRate) === 0n));
const bps = (v) => (Number(v) / Number(ONE) * 1e4).toFixed(3);
const qOf = (a, p) => { const s = [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const perHour = new Map();
for (const r of scored) { if (!perHour.has(r.hour)) perHour.set(r.hour, []); perHour.get(r.hour).push(r); }

console.log('\n=== residual per hour (0 means the bound already contains the venue premium) ===');
for (const [h, rs] of [...perHour.entries()].sort((a, b) => a[0] - b[0])) {
  const res = rs.map(residual);
  const nz = res.filter((v) => v > 0n);
  console.log(`${new Date(h).toISOString().slice(11, 16)}  n=${rs.length} coverage=${(100 * rs[0].coverage).toFixed(0)}%  bracketed ${rs.length - nz.length}/${rs.length} (${(100 * (rs.length - nz.length) / rs.length).toFixed(2)}%)`);
  if (nz.length) console.log(`      residual when it misses (bps): p50 ${bps(qOf(nz, .5))} p90 ${bps(qOf(nz, .9))} max ${bps(nz.reduce((a, b) => (a > b ? a : b)))}`);
}

// calibrate on the hour with the best coverage; validate on the others
const ranked = [...perHour.entries()].sort((a, b) => b[1][0].coverage - a[1][0].coverage);
const [calHour, calRows] = ranked[0];
const valEntries = ranked.slice(1);
const calRes = calRows.map(residual);
const worstCal = calRes.reduce((a, b) => (a > b ? a : b), 0n);
const MULT = 2n;                                   // stated, not hidden: 2x the worst measured
const margin = worstCal * MULT;
console.log(`\ncalibration hour  : ${new Date(calHour).toISOString().slice(11, 16)} (coverage ${(100 * calRows[0].coverage).toFixed(0)}%, ${calRows.length} asset-hours)`);
console.log(`worst residual    : ${bps(worstCal)} bps`);
console.log(`margin  = ${MULT}x worst = ${bps(margin)} bps   (widens the bound on both sides, never narrows it)`);

console.log('\n=== out-of-sample validation ===');
const validation = [];
for (const [h, rs] of valEntries) {
  const res = rs.map(residual);
  const exceed = res.filter((v) => v > margin).length;
  const worst = res.reduce((a, b) => (a > b ? a : b), 0n);
  const usage = margin > 0n ? Number(worst) / Number(margin) : 0;
  console.log(`${new Date(h).toISOString().slice(11, 16)}  asset-hours ${rs.length}  exceeding the margin: ${exceed}  worst honest case uses ${(100 * usage).toFixed(2)}% of it`);
  validation.push({ hour: h, n: rs.length, exceed, worstResidual: worst.toString(), usage });
}

// ── what the bound actually buys ───────────────────────────────────────────────────────────────
console.log('\n=== coverage of the result ===');
for (const [h, rs] of [...perHour.entries()].sort((a, b) => a[0] - b[0])) {
  const pinned = rs.filter((r) => (r.meanLB - margin) >= BAND_LO && (r.meanUB + margin) <= BAND_HI);
  const nonBinding = rs.filter((r) => { const P = parseDecimal(r.premium); return P >= BAND_LO && P <= BAND_HI; });
  const unsound = pinned.filter((r) => parseDecimal(r.fundingRate) !== PINNED_RATE);
  console.log(`${new Date(h).toISOString().slice(11, 16)}  pinned ${pinned.length}/${rs.length} = ${(100 * pinned.length / rs.length).toFixed(2)}%   venue non-binding ${nonBinding.length}/${rs.length} = ${(100 * nonBinding.length / rs.length).toFixed(2)}%   recall ${(100 * pinned.length / Math.max(1, nonBinding.length)).toFixed(2)}%`);
  console.log(`      pinned hours whose published rate is NOT 1.25e-5: ${unsound.length} ${unsound.length ? '*** UNSOUND ***' : '(sound)'}`);
  const lo = rs.map((r) => -(r.meanLB - margin)), hi = rs.map((r) => r.meanUB + margin);
  console.log(`      |mean LB| (bps): p50 ${bps(qOf(lo, .5))} p90 ${bps(qOf(lo, .9))}  vs 4.000 allowed`);
  console.log(`       mean UB  (bps): p50 ${bps(qOf(hi, .5))} p90 ${bps(qOf(hi, .9))}  vs 6.000 allowed`);
}

const calibration = {
  generatedAt: new Date().toISOString(),
  tape: { path: path.basename(TAPE), ticks: ticks.length, from: new Date(ticks[0].t).toISOString(), to: new Date(ticks.at(-1).t).toISOString() },
  marginFixed: margin.toString(), marginBps: Number(bps(margin)),
  worstResidualCalibrationFixed: worstCal.toString(), multiplier: Number(MULT),
  calibrationHour: new Date(calHour).toISOString(), calibrationRows: calRows.length,
  validation,
  note: 'margin widens the premium bound on both sides. Calibrated as 2x the worst residual on the best-covered hour, validated out of sample on the others.',
};
fs.writeFileSync(OUT, JSON.stringify(calibration, null, 2));
console.log(`\nwrote ${OUT}`);

const fixture = {
  generatedAt: new Date().toISOString(),
  source: 'HyperEVM precompiles 0x807/0x80E sampled every 5s at a pinned block; premium/fundingRate from the venue fundingHistory for the same hour',
  hours: hours.map((h) => ({ hour: h, iso: new Date(h).toISOString(), ticks: byHour.get(h).length })),
  rows: scored.map((r) => ({
    hour: r.hour, coin: r.coin, n: r.n, coverage: Number(r.coverage.toFixed(4)), oracleInsideBook: r.oracleInsideBook,
    meanUB: r.meanUB.toString(), meanLB: r.meanLB.toString(), premium: r.premium, fundingRate: r.fundingRate,
  })),
};
fs.writeFileSync(FIXTURE, JSON.stringify(fixture));
console.log(`wrote ${FIXTURE}  (${fixture.rows.length} asset-hours)`);
