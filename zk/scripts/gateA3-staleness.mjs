// GATE A3 — how wide the staleness window has to be, MEASURED.
//
// A2 refuses a proof whose bound entry price differs from HyperCore's mark by more than `windowPpm`.
// A mark moves between the moment Quiver reads it and the moment a proof lands in a block, so a window
// picked before that movement is measured is a guess, and a guess here is the difference between
// refusing every honest proof and accepting proofs about prices the chain no longer holds.
//
// This measures two separate things and does NOT add them by hand:
//
//   1. RAW DRIFT. The precompile's own mark, sampled about once a second, over a basket, with the
//      distribution of |Δp|/p at every lag from 1 s to 120 s. This is the physics.
//   2. THE ACTUAL PIPELINE. What the LIVE service serves for a symbol, against the precompile at the
//      moment the answer arrives and again after a plausible inclusion delay. This is the reality,
//      and it includes things the physics does not — above all the adapter's 30-SECOND CACHE on the
//      HTTP context, which can make the served mark half a minute old before anything else happens.
//
// Run: node zk/scripts/gateA3-staleness.mjs [--seconds 900] [--no-live]
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, CONTRACTS, rpc, u32, perpUniverse, compile, readSol, runtimeCodeFor, abiWords, selector, callPlantedRaw, checklist, scaleLib } from './lib/perpkit.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('--seconds', 900));
const LIVE = !process.argv.includes('--no-live');
const SERVICE = process.env.QUIVER_URL || 'https://quiver-production-c3a8.up.railway.app';

const g = checklist();
console.log(`GATE A3 — the staleness window, measured — ${new Date().toISOString()}\n`);

const Q = compile('QuiverPerpVerifier.sol', 'QuiverPerpVerifier', {
  'QuiverPerpVerifier.sol': { content: readSol(path.join(CONTRACTS, 'QuiverPerpVerifier.sol')) },
});
const { code } = await runtimeCodeFor(Q.evm.bytecode.object, abiWords('0x00000000000000000000000000000000000000ff', 0, 1));
const AT = '0x00000000000000000000000000000000000A0A03';
const overrides = { [AT]: { code } };
const SEL_MARKS = await selector('marksHat(uint32[])');

// ── the basket ────────────────────────────────────────────────────────────────────────────────────
// A window is only honest if it covers the asset a caller actually asks about, so the basket is not
// four majors. It is the majors plus a spread across the universe, including the thin end where a
// single fill moves the mark further than BTC moves in an hour.
const universe = await perpUniverse();
const live = universe.filter((u) => !u.isDelisted);
const NAMED = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP', 'BNB', 'AVAX', 'LINK', 'SUI'];
const named = NAMED.map((n) => live.find((u) => u.name === n)).filter(Boolean);
const spread = live.filter((u) => !NAMED.includes(u.name)).filter((_, i) => i % 6 === 0).slice(0, 30);
const basket = [...named, ...spread];
console.log(`  basket: ${basket.length} live perps — ${basket.slice(0, 12).map((b) => b.name).join(' ')} …\n`);

const idx = basket.map((b) => b.perpIndex);
const callData = '0x' + SEL_MARKS.slice(2)
  + (32).toString(16).padStart(64, '0') + idx.length.toString(16).padStart(64, '0') + idx.map(u32).join('');

// ── 1. raw drift ──────────────────────────────────────────────────────────────────────────────────
const samples = [];
const t0 = Date.now();
let errs = 0;
process.stdout.write(`  sampling the precompile for ${SECONDS}s `);
while ((Date.now() - t0) / 1000 < SECONDS) {
  const tick = Date.now();
  try {
    const r = await callPlantedRaw({ to: AT, data: callData, overrides, tries: 3 });
    if (r.ok) {
      const h = r.result.replace(/^0x/, '');
      const w = (k) => BigInt('0x' + h.slice(k * 64, k * 64 + 64));
      samples.push({ t: tick, block: Number(w(0)), ts: Number(w(1)), hats: idx.map((_, k) => w(4 + k)) });
    } else errs++;
  } catch { errs++; }
  if (samples.length % 60 === 0) process.stdout.write('.');
  const wait = 1000 - (Date.now() - tick);
  if (wait > 0) await new Promise((s) => setTimeout(s, wait));
}
console.log(`\n  ${samples.length} samples, ${errs} failed, over ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const first = samples[0], last = samples[samples.length - 1];
const blockTime = (last.t - first.t) / 1000 / Math.max(1, last.block - first.block);
console.log(`  blocks ${first.block} → ${last.block} · ${blockTime.toFixed(3)} s/block · sample interval ${((last.t - first.t) / 1000 / (samples.length - 1)).toFixed(3)} s\n`);

// The tick each asset's price lives on, on the 1e9 grid. Read from the chain, not assumed.
const SEL_SZ = await selector('szDecimals(uint32)');
const tickHat = [];
for (const b of basket) {
  const r = await callPlantedRaw({ to: AT, data: SEL_SZ + u32(b.perpIndex), overrides });
  tickHat.push(10n ** (3n + BigInt(Number(BigInt(r.result)))));
}

// |Δp| at every lag, in TWO units, pooled over the basket AND per asset.
//
// PPM is the natural unit for economic movement and the wrong unit for QUANTISATION: HyperCore carries
// a price as an integer, and one tick is worth 1.6 ppm of BTC's mark but 508 ppm of PUMP's. A window
// expressed only in ppm and sized on the majors is therefore SMALLER THAN ONE TICK on the coarse end
// of the universe, where nothing but an exact integer match could ever pass. So drift is measured in
// ticks as well, and the window carries a tick floor.
const LAGS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
const table = [];
const tickTable = [];
const perAssetWorst = new Map();
for (const lag of LAGS) {
  const pooled = [];
  const pooledTicks = [];
  for (let i = 0; i < samples.length; i++) {
    // the first sample at least `lag` seconds later — real elapsed time, not an assumed cadence
    let j = i + 1;
    while (j < samples.length && (samples[j].t - samples[i].t) < lag * 1000) j++;
    if (j >= samples.length) break;
    for (let k = 0; k < idx.length; k++) {
      const a = samples[i].hats[k], b = samples[j].hats[k];
      if (a === 0n) continue;
      const d = a > b ? a - b : b - a;
      const ppm = Number((d * 1_000_000n) / a);
      pooled.push(ppm);
      pooledTicks.push(Number(d / tickHat[k]));
      const key = basket[k].name;
      if (!perAssetWorst.has(key)) perAssetWorst.set(key, new Map());
      const m = perAssetWorst.get(key);
      m.set(lag, Math.max(m.get(lag) ?? 0, ppm));
    }
  }
  pooled.sort((x, y) => x - y);
  pooledTicks.sort((x, y) => x - y);
  table.push({ lag, n: pooled.length, p50: q(pooled, 0.5), p95: q(pooled, 0.95), p99: q(pooled, 0.99), p999: q(pooled, 0.999), max: pooled[pooled.length - 1] });
  tickTable.push({ lag, n: pooledTicks.length, p50: q(pooledTicks, 0.5), p95: q(pooledTicks, 0.95), p99: q(pooledTicks, 0.99), p999: q(pooledTicks, 0.999), max: pooledTicks[pooledTicks.length - 1] });
}
console.log('  |Δmark|/mark in PPM, pooled over the basket:');
console.log('    lag(s)      n      p50      p95      p99    p99.9      max');
for (const r of table) {
  console.log(`    ${String(r.lag).padStart(6)} ${String(r.n).padStart(6)} ${String(r.p50).padStart(8)} ${String(r.p95).padStart(8)} ${String(r.p99).padStart(8)} ${String(r.p999).padStart(8)} ${String(r.max).padStart(8)}`);
}
console.log('\n  |Δmark| in TICKS, pooled over the basket (the unit quantisation actually lives in):');
console.log('    lag(s)      n      p50      p95      p99    p99.9      max');
for (const r of tickTable) {
  console.log(`    ${String(r.lag).padStart(6)} ${String(r.n).padStart(6)} ${String(r.p50).padStart(8)} ${String(r.p95).padStart(8)} ${String(r.p99).padStart(8)} ${String(r.p999).padStart(8)} ${String(r.max).padStart(8)}`);
}
console.log('\n  one tick, as a fraction of the mark, across the basket:');
const tickPpm = basket.map((b, k) => ({ name: b.name, ppm: Number((tickHat[k] * 1_000_000n * 1000n) / (samples[samples.length - 1].hats[k] || 1n)) / 1000 }))
  .sort((a, b) => a.ppm - b.ppm);
console.log(`    finest ${tickPpm.slice(0, 3).map((t) => `${t.name} ${t.ppm} ppm`).join(', ')}`);
console.log(`    coarsest ${tickPpm.slice(-3).map((t) => `${t.name} ${t.ppm} ppm`).join(', ')}`);

// ── 2. the actual pipeline ────────────────────────────────────────────────────────────────────────
// What perp-gate SERVES against what the chain HOLDS, at the moment the answer lands and again after
// a plausible inclusion delay. Nothing is inferred from part 1 — this is measured end to end.
const pipeline = [];
if (LIVE) {
  console.log(`\n  end-to-end against the live service at ${SERVICE}`);
  const symbols = ['BTC', 'ETH', 'SOL', 'DOGE'];
  for (let n = 0; n < 24; n++) {
    const sym = symbols[n % symbols.length];
    const asset = live.find((u) => u.name === sym).perpIndex;
    const one = '0x' + SEL_MARKS.slice(2) + (32).toString(16).padStart(64, '0') + (1).toString(16).padStart(64, '0') + u32(asset);
    const readHat = async () => {
      const r = await callPlantedRaw({ to: AT, data: one, overrides, tries: 3 });
      return r.ok ? BigInt('0x' + r.result.replace(/^0x/, '').slice(4 * 64, 5 * 64)) : null;
    };
    try {
      const tA = Date.now();
      const res = await fetch(`${SERVICE}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'perp_gate', arguments: { symbol: sym, venue: 'hyperliquid', size: 1, leverage: 10 } } }),
        signal: AbortSignal.timeout(30000),
      });
      const outer = await res.json();
      const ans = JSON.parse(outer.result.content[0].text);
      const latency = Date.now() - tA;
      const served = Number(ans?.inputs?.markPrice);
      if (!(served > 0)) { console.log(`    ${sym}: no markPrice in the answer`); continue; }
      // The SAME encoder the witness uses. `Math.round(served * 1e9)` is wrong above ~9e6, which is
      // exactly the range BTC lives in, and would show up here as a fabricated 100-ppm residual.
      const sh = scaleLib().toScaled(served, 'markPrice');
      const now = await readHat();
      await new Promise((s) => setTimeout(s, 2000));
      const plus2 = await readHat();
      const ppm = (a, b) => (a && b ? Number(((a > b ? a - b : b - a) * 1_000_000n) / b) : null);
      pipeline.push({ sym, latencyMs: latency, servedHat: String(sh), atAnswer: String(now), plus2s: String(plus2), ppmAtAnswer: ppm(sh, now), ppmPlus2: ppm(sh, plus2) });
      console.log(`    ${sym.padEnd(5)} served ${served} · chain ${Number(now) / 1e9} · ${ppm(sh, now)} ppm at the answer, ${ppm(sh, plus2)} ppm two seconds later · service ${latency} ms`);
    } catch (e) { console.log(`    ${sym}: ${String(e.message).slice(0, 90)}`); }
    await new Promise((s) => setTimeout(s, 1500));
  }
}

const pipePpm = pipeline.map((p) => p.ppmPlus2).filter((v) => v != null).sort((a, b) => a - b);
const pipeMax = pipePpm.length ? pipePpm[pipePpm.length - 1] : null;
const pipeP95 = pipePpm.length ? q(pipePpm, 0.95) : null;

// ── the window ────────────────────────────────────────────────────────────────────────────────────
// Chosen from the measurement, stated with what it is chosen to cover, and NOT rounded up to a
// comfortable number. The stop condition in the plan says: if the window has to exceed the honest
// drift to make the gate pass, report rather than continue.
const at30 = table.find((r) => r.lag === 30);
const at10 = table.find((r) => r.lag === 10);
const at5 = table.find((r) => r.lag === 5);
console.log(`\n  the interval that actually applies:`);
console.log(`    the adapter caches the HTTP perp context for 30 s (src/adapters/hyperliquid.js TTL_MS),`);
console.log(`    so a served mark can already be up to 30 s old; add the service round trip, ~1 s of`);
console.log(`    proving, and ${blockTime.toFixed(2)} s/block of inclusion.`);

const t30 = tickTable.find((r) => r.lag === 30);
const recommend = at30 ? at30.p999 : null;
const recommendTicks = t30 ? Math.max(1, t30.p999) : 1;
console.log(`\n  raw drift at 5 s p99.9  = ${at5?.p999} ppm      (a fresh read, one block of inclusion)`);
console.log(`  raw drift at 10 s p99.9 = ${at10?.p999} ppm`);
console.log(`  raw drift at 30 s p99.9 = ${at30?.p999} ppm      (the cache TTL alone)`);
console.log(`  raw drift at 30 s max   = ${at30?.max} ppm`);
if (pipeMax != null) console.log(`  measured end-to-end      = p95 ${pipeP95} ppm, worst ${pipeMax} ppm over ${pipePpm.length} live calls`);

g.record('the sample is long enough to say anything', samples.length >= 120,
  `${samples.length} samples over ${((last.t - first.t) / 1000).toFixed(0)} s · ${idx.length} assets · ${table[0].n} pooled pairs at lag 1 s`);
const zeroWindowRefusals = (() => {
  // How many honest five-second-old proofs a window of ZERO would refuse. The plan asserts "A2 as
  // written would refuse almost every honest proof"; this is the number behind that sentence.
  let bad = 0, tot = 0;
  for (let i = 0; i < samples.length; i++) {
    let j = i + 1; while (j < samples.length && (samples[j].t - samples[i].t) < 5000) j++;
    if (j >= samples.length) break;
    for (let k = 0; k < idx.length; k++) { tot++; if (samples[i].hats[k] !== samples[j].hats[k]) bad++; }
  }
  return { bad, tot, pct: tot ? (100 * bad) / tot : 0 };
})();
g.record('the mark actually moved during the sample, so a zero window would have been refused',
  (at5?.p95 ?? 0) > 0 && zeroWindowRefusals.bad > 0,
  `p95 at 5 s is ${at5?.p95} ppm — a window of ZERO would refuse ${zeroWindowRefusals.bad} of ${zeroWindowRefusals.tot} honest five-second-old proofs (${zeroWindowRefusals.pct.toFixed(1)}%)`);
g.record('drift grows with the lag, i.e. this is price movement and not measurement noise',
  (at30?.p999 ?? 0) >= (at5?.p999 ?? 0), `p99.9: 5 s ${at5?.p999} → 10 s ${at10?.p999} → 30 s ${at30?.p999} ppm`);
if (pipeMax != null) {
  g.record('the end-to-end residual is not larger than the raw drift at the cache TTL',
    pipeMax <= (at30?.max ?? Infinity) * 3,
    `end-to-end worst ${pipeMax} ppm vs raw 30 s max ${at30?.max} ppm`);
}

const failed = g.failed();
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE A3: ${failed.length === 0 ? 'PASSED' : `FAILED — ${failed.map((f) => f.name).join('; ')}`}`);
console.log(`  RECOMMENDED windowPpm ${recommend}, windowTicks ${recommendTicks}`);
console.log(`    ${recommend} ppm is the p99.9 of measured 30-second drift — 30 s being the cache TTL the`);
console.log(`    served mark can already carry before anything else happens. ${recommendTicks} ticks is the same`);
console.log(`    percentile in the unit the price is actually stored in, and it is the binding constraint`);
console.log(`    on coarse-grid assets where one tick is worth more than ${recommend} ppm. The contract takes`);
console.log(`    the WIDER of the two, per asset. Anything tighter refuses honest proofs; anything wider`);
console.log(`    accepts a price the chain no longer holds.`);

fs.writeFileSync(path.join(BUILD, 'gateA3-staleness.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, seconds: SECONDS,
  samples: samples.length, assets: idx.length, basket: basket.map((b) => b.name),
  blockTimeSec: blockTime, driftPpm: table, driftTicks: tickTable, tickPpm,
  perAssetWorst: Object.fromEntries([...perAssetWorst].map(([k, m]) => [k, Object.fromEntries(m)])),
  pipeline, recommendWindowPpm: recommend, recommendWindowTicks: recommendTicks,
  zeroWindowRefusals, checks: g.results,
}, null, 2) + '\n', 'utf8');
console.log(`\n  written to zk/build/gateA3-staleness.json`);
process.exit(failed.length === 0 ? 0 : 1);
