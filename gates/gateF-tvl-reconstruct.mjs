// GATE F, DefiLlama TVL reconstruction, PER RESERVE.
//
// The claim under test is not "we can add up some balances and land near DefiLlama". It is:
// every reserve DefiLlama publishes for Aave V3 Ethereum is reproducible from Ethereum state at a
// named block, and a reserve that is NOT is refused.
//
// This gate exists because of a warning in PHASE_D_OFFCHAIN_VENUES.md §3.6: comparing the
// reconstruction against DefiLlama ON THE TOTAL produces a verifier that cannot fail. Errors cancel.
// This gate measures that cancellation (F7), runs the same fabrication against both comparison forms,
// and requires the per-reserve form to go red where the total form stays green.
//
// There is a second, sharper trap, and F8 is the whole reason to read this file. A per-reserve
// comparison that iterates the INTERSECTION of the two token sets is weaker than the total form, not
// stronger: delete a reserve from the reconstruction and it simply drops out of the loop. Measured
// below, that swallows a fabrication two orders of magnitude larger than anything the total form
// swallows. Per-reserve is not the fix. Per-reserve WITH A COVERAGE ASSERTION is the fix.
//
//   node --test gates/gateF-tvl-reconstruct.mjs
//   node gates/gateF-revert.mjs                    proves it goes red
//
// Live-network gate. Transport failure is skipped and counted; a comparison that runs and disagrees
// is a failure. Those are never conflated.
//
// WHERE THE BOUNDS COME FROM. Not from a guess:
//   quantity  DefiLlama publishes each quantity as a decimal string. The half-ULP of that string is
//             the tightest bound any reconstruction can be held to, and it has zero free parameters.
//             Measured over two drift-0 snapshots: the worst honest reserve uses 98.33% of it and
//             NOT ONE of 57 exceeds it. The band is saturated, which is what a real bound looks like.
//   price     Aave's oracle and DefiLlama's market quotes genuinely disagree, so this bound is
//             calibrated from measurement and carries a stated multiplier. It is the weak half of
//             this gate by a factor of about a million, and F5 says so in its own output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

// ---------------------------------------------------------------------------------------------
// SCRIPTED-REVERT TARGET. gateF-revert.mjs rewrites the line below to 'total-only' and requires this
// gate to go red. Everything that compares reads this one constant, so flipping it degrades the gate
// into exactly the defect §3.6 warns about rather than into a differently-broken program.
const COMPARISON_MODE = 'per-reserve';
// ---------------------------------------------------------------------------------------------

// A charitable band for the total-only form: wide enough that its failure cannot be dismissed as an
// unfairly tight total. The doc's table uses 10 bps; 50 is five times more generous.
const TOTAL_ONLY_BAND_BPS = 50;

// Bounds, each with its provenance.
const QTY_BOUND_K = 1;            // multiplier on DefiLlama's own print half-ULP. 1 = no slack at all.
const PRICE_IMPACT_BAND_BPS = 25; // per reserve, |mineUsd-llamaUsd| as bps of total. Worst measured 5.41.
const PRICE_IMPACT_MULTIPLIER_NOTE = '25 bps against a worst measured 5.413 bps = 4.6x, on 2 snapshots';
const UNMATCHED_DUST_USD = 10_000; // per on-chain bucket DefiLlama drops. Worst measured $789.

const RPCS = ['https://rpc.mevblocker.io', 'https://eth.drpc.org'];
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// DefiLlama's own aave-v3 adapter exclusions, quoted from projects/aave-v3/index.js. These are not
// our rules; applying anything beyond them would be fitting the answer.
const BLACKLIST_TOKENS = new Set([
  '0x3de0ff76e8b528c092d47b9dac775931cef80f49', '0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375',
  '0xaebf0bb9f57e89260d57f31af34eb58657d96ce0', '0x62c6e813b9589c3631ba0cdb013acdb8544038b7',
  '0xe6a934089bbee34f832060ce98848359883749b3', '0xbc6736d346a5ebc0debc997397912cd9b8fae10a',
  '0xe8483517077afa11a9b07f849cee2552f040d7b2',
]);
const BLACKLIST_LENDERS = ['0xb8734a14fbd4aa2d44e6aa830405ffc861ba313c', '0x3feaa7483fcfba130e68b41369dd78ff30465459'];
const POOLS = {
  core: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  prime: '0x4e033931ad43597d96D6bcc25c280717730B58B1',
  etherfi: '0x0AA97c284e98396202b6A04024F5E2c65026F3c0',
};
// DefiLlama names one contract differently from its own symbol(). Two entries, both verifiable by
// reading the contract. Anything larger than this would be a mapping fitted to make the diff vanish.
const SYMBOL_ALIAS = { EURC: 'EUROC' };

const M = { skipped: [], refusals: [], measurements: {} };

async function rpc(method, params, timeoutMs = 45000) {
  let last = null;
  for (let a = 0; a < RPCS.length * 2; a++) {
    const url = RPCS[a % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
      });
      const j = JSON.parse(await r.text());
      if (j.error) throw new Error(String(j.error.message || JSON.stringify(j.error)).slice(0, 130));
      return j.result;
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 250 * (a + 1))); }
  }
  throw last;
}

const I = new ethers.Interface([
  'function getReservesList() view returns (address[])',
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
  'function getReserveTokensAddresses(address) view returns (address,address,address)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function getAssetPrice(address) view returns (uint256)',
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
]);
const MCI = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[]) view returns ((bool success,bytes returnData)[])']);

async function multicall(calls, block) {
  const out = [];
  for (let i = 0; i < calls.length; i += 320) {
    const res = MCI.decodeFunctionResult('aggregate3',
      await rpc('eth_call', [{ to: MC3, data: MCI.encodeFunctionData('aggregate3', [calls.slice(i, i + 320)]) }, block]))[0];
    for (const r of res) out.push(r);
  }
  return out;
}

function decodeSymbol(hex) {
  try { return I.decodeFunctionResult('symbol', hex)[0]; } catch { /* bytes32 symbol, e.g. MKR */ }
  try {
    const b = ethers.getBytes(hex);
    if (b.length === 32) return Buffer.from(b).toString('utf8').replace(/\0+$/, '').trim() || null;
  } catch { /* ignore */ }
  return null;
}

// THE BOUND, derived rather than chosen. DefiLlama publishes "9352130.64906"; the most that string can
// be wrong by is half of the last digit. Relative to the value, that is the tightest honest tolerance
// that exists. JS drops trailing zeros when printing, which can only make this bound LARGER than the
// true one, never smaller, so it is conservative in the safe direction.
export function printHalfUlpPct(v) {
  const s = String(v);
  const m = s.match(/\.(\d+)$/);
  const dec = m ? m[1].length : 0;
  return ((0.5 * Math.pow(10, -dec)) / Math.abs(v)) * 100;
}

async function pinBlock(targetTs) {
  let hi = parseInt(await rpc('eth_blockNumber', []), 16);
  const hb = await rpc('eth_getBlockByNumber', ['0x' + hi.toString(16), false]);
  let lo = hi - Math.ceil((parseInt(hb.timestamp, 16) - targetTs) / 12) - 400;
  if (lo < 1) lo = 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = await rpc('eth_getBlockByNumber', ['0x' + mid.toString(16), false]);
    const t = parseInt(b.timestamp, 16);
    if (t <= targetTs) { best = { n: mid, ts: t, hash: b.hash }; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// The reconstruction, from Ethereum state alone. Prices come from Aave's OWN on-chain oracle, which is
// what makes the result a statement about chain state rather than about a price API.
async function reconstruct(blockNum) {
  const BLK = '0x' + blockNum.toString(16);
  const meta = {};
  for (const [name, pool] of Object.entries(POOLS)) {
    const assets = I.decodeFunctionResult('getReservesList', await rpc('eth_call', [{ to: pool, data: I.encodeFunctionData('getReservesList') }, BLK]))[0];
    const ap = I.decodeFunctionResult('ADDRESSES_PROVIDER', await rpc('eth_call', [{ to: pool, data: I.encodeFunctionData('ADDRESSES_PROVIDER') }, BLK]))[0];
    const [dpR, orR] = await multicall([
      [ap, true, I.encodeFunctionData('getPoolDataProvider')],
      [ap, true, I.encodeFunctionData('getPriceOracle')],
    ], BLK);
    const dataProvider = I.decodeFunctionResult('getPoolDataProvider', dpR.returnData)[0];
    const oracle = I.decodeFunctionResult('getPriceOracle', orR.returnData)[0];
    const unit = I.decodeFunctionResult('BASE_CURRENCY_UNIT', await rpc('eth_call', [{ to: oracle, data: I.encodeFunctionData('BASE_CURRENCY_UNIT') }, BLK]))[0];
    meta[name] = { pool, dataProvider, oracle, baseUnit: Number(unit), assets };
  }
  const flat = [];
  for (const [name, m] of Object.entries(meta)) for (const a of m.assets) flat.push({ market: name, asset: a });

  const c1 = [];
  for (const f of flat) {
    c1.push([meta[f.market].dataProvider, true, I.encodeFunctionData('getReserveTokensAddresses', [f.asset])]);
    c1.push([f.asset, true, I.encodeFunctionData('decimals')]);
    c1.push([f.asset, true, I.encodeFunctionData('symbol')]);
  }
  const r1 = await multicall(c1, BLK);
  const rows = [];
  for (let i = 0; i < flat.length; i++) {
    const tk = r1[3 * i], dc = r1[3 * i + 1], sy = r1[3 * i + 2];
    if (!tk.success || !dc.success) { rows.push({ ...flat[i], err: 'static read failed' }); continue; }
    rows.push({
      ...flat[i],
      aToken: I.decodeFunctionResult('getReserveTokensAddresses', tk.returnData)[0],
      decimals: Number(I.decodeFunctionResult('decimals', dc.returnData)[0]),
      symbol: sy.success ? decodeSymbol(sy.returnData) : null,
    });
  }
  const live = rows.filter((r) => !r.err);
  const c2 = [];
  for (const r of live) {
    c2.push([r.asset, true, I.encodeFunctionData('balanceOf', [r.aToken])]);
    c2.push([meta[r.market].oracle, true, I.encodeFunctionData('getAssetPrice', [r.asset])]);
    for (const L of BLACKLIST_LENDERS) c2.push([r.aToken, true, I.encodeFunctionData('balanceOf', [L])]);
  }
  const t0 = Date.now();
  const r2 = await multicall(c2, BLK);
  const latencyMs = Date.now() - t0;
  for (let i = 0; i < live.length; i++) {
    const r = live[i];
    const b = r2[4 * i], px = r2[4 * i + 1], l1 = r2[4 * i + 2], l2 = r2[4 * i + 3];
    r.rawQty = b.success ? Number(ethers.formatUnits(BigInt(b.returnData), r.decimals)) : null;
    r.price = px.success ? Number(BigInt(px.returnData)) / meta[r.market].baseUnit : null;
    r.lenderQty = (l1.success && BigInt(l1.returnData) > 0n ? Number(ethers.formatUnits(BigInt(l1.returnData), r.decimals)) : 0)
                + (l2.success && BigInt(l2.returnData) > 0n ? Number(ethers.formatUnits(BigInt(l2.returnData), r.decimals)) : 0);
    r.blacklisted = BLACKLIST_TOKENS.has(r.asset.toLowerCase());
    r.qty = r.blacklisted ? 0 : (r.rawQty ?? 0) - r.lenderQty;
    r.price = r.price ?? 0;
    r.usd = r.qty * r.price;
    r.key = r.symbol ? (SYMBOL_ALIAS[r.symbol.toUpperCase()] || r.symbol.toUpperCase()) : null;
  }
  return { meta, rows, subCalls: c1.length + c2.length, latencyMs };
}

function bucketBySymbol(rows) {
  const agg = new Map();
  for (const r of rows) {
    if (r.err || r.blacklisted || r.qty == null || !r.key) continue;
    const c = agg.get(r.key) || { key: r.key, qty: 0, usd: 0, legs: 0 };
    c.qty += r.qty; c.usd += r.usd; c.legs++;
    agg.set(r.key, c);
  }
  return agg;
}

// =============================================================================================
// THE COMPARISON. One function, two forms, selected by COMPARISON_MODE. The whole argument of this
// gate is the difference between them, so they live side by side and are fed identical input.
//
// Returns { green, findings[] }. `findings` is never a warning list; if it is non-empty the gate is
// red. A comparison that can return findings and still be green is not a comparison.
// =============================================================================================
export function compare(buckets, llamaQty, llamaUsd, opts = {}) {
  const mode = opts.mode || COMPARISON_MODE;
  const totalLlama = Object.values(llamaUsd).reduce((a, b) => a + b, 0);
  const totalMine = [...buckets.values()].reduce((a, b) => a + b.usd, 0);
  const findings = [];

  if (mode === 'total-only') {
    // The form §3.6 warns about, kept honest and charitable: a wide band, correctly computed.
    const bps = ((totalMine - totalLlama) / totalLlama) * 1e4;
    if (Math.abs(bps) > (opts.totalBandBps ?? TOTAL_ONLY_BAND_BPS)) {
      findings.push({ kind: 'total', bps, band: opts.totalBandBps ?? TOTAL_ONLY_BAND_BPS });
    }
    return { green: findings.length === 0, findings, totalMine, totalLlama, bps, mode };
  }

  // --- per-reserve ---------------------------------------------------------------------------
  // 1. COVERAGE, in both directions, and this is the half that makes per-reserve stronger rather
  //    than weaker than the total. Iterating the intersection is the defect; iterating DefiLlama's
  //    OWN key set and requiring a reconstruction for each is the fix.
  for (const key of Object.keys(llamaQty)) {
    if (!buckets.has(key)) {
      findings.push({ kind: 'coverage-missing', key, llamaUsd: llamaUsd[key],
        why: 'DefiLlama publishes this reserve and the reconstruction produced nothing for it' });
    }
  }
  // 2. and the other direction, bounded by a dust threshold DefiLlama's own adapter justifies
  for (const [key, b] of buckets) {
    if (llamaQty[key] === undefined && Math.abs(b.usd) > (opts.dustUsd ?? UNMATCHED_DUST_USD)) {
      findings.push({ kind: 'coverage-extra', key, mineUsd: b.usd,
        why: 'the reconstruction produced a reserve above the dust bound that DefiLlama does not publish' });
    }
  }
  // 3. QUANTITY, per reserve, against DefiLlama's own print precision. Zero free parameters.
  for (const key of Object.keys(llamaQty)) {
    const b = buckets.get(key);
    if (!b) continue;                                  // already a coverage finding above
    const rel = ((b.qty - llamaQty[key]) / llamaQty[key]) * 100;
    const bound = printHalfUlpPct(llamaQty[key]) * (opts.qtyK ?? QTY_BOUND_K);
    if (Math.abs(rel) > bound) findings.push({ kind: 'quantity', key, relPct: rel, boundPct: bound, use: Math.abs(rel) / bound });
  }
  // 4. PRICE, per reserve, as USD impact against the total. This is the weak half and F5 quantifies it.
  for (const key of Object.keys(llamaQty)) {
    const b = buckets.get(key);
    if (!b) continue;
    const impactBps = (Math.abs(b.usd - llamaUsd[key]) / totalLlama) * 1e4;
    if (impactBps > (opts.priceBandBps ?? PRICE_IMPACT_BAND_BPS)) findings.push({ kind: 'price-impact', key, impactBps });
  }
  return { green: findings.length === 0, findings, totalMine, totalLlama, bps: ((totalMine - totalLlama) / totalLlama) * 1e4, mode };
}

// The defect this gate exists to demonstrate, written out so F8 can run it rather than argue it.
// This is a per-reserve comparison. It is also two orders of magnitude weaker than the total form.
function compareIntersectionOnly(buckets, llamaQty) {
  for (const key of Object.keys(llamaQty)) {
    const b = buckets.get(key);
    if (!b) continue;                                  // <-- THE HOLE. A deleted reserve is not compared.
    const rel = ((b.qty - llamaQty[key]) / llamaQty[key]) * 100;
    if (Math.abs(rel) > printHalfUlpPct(llamaQty[key])) return { green: false, key };
  }
  return { green: true };
}

// =============================================================================================
// One reconstruction, shared. Fetching 9.5 MB of DefiLlama and 292 sub-calls per test would measure
// the network, not the gate.
// =============================================================================================
const S = await (async () => {
  const t0 = Date.now();
  const res = await fetch('https://api.llama.fi/protocol/aave-v3', { headers: { accept: 'application/json' } });
  const text = await res.text();
  const llamaBytes = Buffer.byteLength(text);
  const p = JSON.parse(text);
  const eth = p.chainTvls.Ethereum;
  const i = eth.tvl.length - 1;
  const snap = {
    date: eth.tvl[i].date, totalLiquidityUSD: eth.tvl[i].totalLiquidityUSD,
    tokens: eth.tokens[i].tokens, tokensInUsd: eth.tokensInUsd[i].tokens,
    tokensDate: eth.tokens[i].date, usdDate: eth.tokensInUsd[i].date,
  };
  const llamaMs = Date.now() - t0;
  const pin = await pinBlock(snap.date);
  const rec = await reconstruct(pin.n);
  const buckets = bucketBySymbol(rec.rows);
  // a historical daily point, used by F10 only
  const dIdx = eth.tvl.length - 2;
  const daily = { date: eth.tvl[dIdx].date, tokens: eth.tokens[dIdx].tokens };
  return { snap, pin, rec, buckets, llamaBytes, llamaMs, daily, series: eth.tvl.length };
})();

// =============================================================================================
test('F1, the comparison must be pinned to DefiLlama\'s own snapshot instant, not to "now"', () => {
  const drift = S.pin.ts - S.snap.date;
  console.log(`  F1 DefiLlama last Ethereum point ts=${S.snap.date} (${new Date(S.snap.date * 1000).toISOString()}), block ${S.pin.n} ts=${S.pin.ts}, drift ${drift}s`);
  // DefiLlama stamps its live point with the wall clock of its own read, so a block lands on it exactly.
  // Anything past one block means the two sides are looking at different books and every number below
  // would be measuring time, not agreement.
  assert.ok(Math.abs(drift) <= 12, `drift ${drift}s exceeds one block; the comparison would be across a moving book`);
  assert.equal(S.snap.tokensDate, S.snap.date, 'the token breakdown is stamped at a different instant from the total');
  assert.equal(S.snap.usdDate, S.snap.date, 'the USD breakdown is stamped at a different instant from the total');
  M.measurements.drift = drift;
  M.measurements.block = S.pin.n;
});

test('F2, coverage: every reserve DefiLlama publishes must be reconstructed, and this is not a formality', () => {
  const llamaKeys = Object.keys(S.snap.tokens);
  const missing = llamaKeys.filter((k) => !S.buckets.has(k));
  const extra = [...S.buckets.values()].filter((b) => S.snap.tokens[b.key] === undefined);
  const extraBig = extra.filter((b) => Math.abs(b.usd) > UNMATCHED_DUST_USD);
  console.log(`  F2 on chain: ${S.rec.rows.length} reserve rows across ${Object.keys(POOLS).length} pools, ${S.rec.rows.filter((r) => r.blacklisted).length} on DefiLlama's blacklist, ${S.buckets.size} symbol buckets`);
  console.log(`  F2 DefiLlama publishes ${llamaKeys.length} tokens; missing ${missing.length}, extra ${extra.length} (${extra.map((b) => `${b.key} $${b.usd.toFixed(0)}`).join(', ') || 'none'}), extra above $${UNMATCHED_DUST_USD}: ${extraBig.length}`);
  assert.equal(missing.length, 0, `${missing.length} DefiLlama reserve(s) not reconstructed: ${missing.join(', ')}`);
  assert.equal(extraBig.length, 0, `${extraBig.length} reconstructed reserve(s) above the dust bound are absent from DefiLlama: ${extraBig.map((b) => b.key).join(', ')}`);
  // the dust bound must stay a dust bound: if what DefiLlama drops ever grows, that is a finding, not noise
  const extraUsd = extra.reduce((a, b) => a + Math.abs(b.usd), 0);
  assert.ok(extraUsd < 0.0001 * S.snap.totalLiquidityUSD, `reserves DefiLlama drops now total $${extraUsd.toFixed(0)}, no longer dust`);
  M.measurements.extraUsd = extraUsd;
  M.measurements.buckets = S.buckets.size;
});

test('F3, per reserve, the quantity must sit inside DefiLlama\'s own print precision', () => {
  const rows = Object.keys(S.snap.tokens).map((k) => {
    const b = S.buckets.get(k);
    const rel = b ? ((b.qty - S.snap.tokens[k]) / S.snap.tokens[k]) * 100 : null;
    const bound = printHalfUlpPct(S.snap.tokens[k]);
    return { k, rel, bound, use: rel == null ? null : Math.abs(rel) / bound };
  }).filter((r) => r.rel != null);
  // An empty comparison is the classic vacuous pass: no rows, no violations, green. Assert the loop
  // actually had something to iterate before believing anything it says.
  assert.ok(rows.length >= 50, `only ${rows.length} reserves were compared; a comparison over that few rows is not the comparison this gate claims to run`);
  const uses = rows.map((r) => r.use).sort((a, b) => a - b);
  const worst = rows.slice().sort((a, b) => b.use - a.use)[0];
  const over = rows.filter((r) => r.use > QTY_BOUND_K);
  console.log(`  F3 bound = DefiLlama's own half-ULP, K=${QTY_BOUND_K}, zero free parameters`);
  console.log(`  F3 bound utilisation over ${rows.length} reserves: median ${(uses[Math.floor(uses.length / 2)] * 100).toFixed(1)}%, p90 ${(uses[Math.floor(uses.length * 0.9)] * 100).toFixed(1)}%, WORST ${(worst.use * 100).toFixed(2)}% (${worst.k})`);
  console.log(`  F3 reserves outside the bound: ${over.length}`);
  assert.equal(over.length, 0, `${over.length} reserve(s) outside DefiLlama's own print precision: ${over.map((r) => `${r.k} ${r.rel.toExponential(2)}% vs bound ${r.bound.toExponential(2)}%`).join('; ')}`);
  // A bound nothing comes close to is a bound that was guessed. This asserts the opposite: the honest
  // reading has to SATURATE it, or the bound is not measuring anything.
  assert.ok(worst.use > 0.5, `the worst honest reserve uses only ${(worst.use * 100).toFixed(1)}% of its bound; a bound with that much slack is not calibrated, it is chosen`);
  M.measurements.worstQtyBoundUse = worst.use;
  M.measurements.worstQtyKey = worst.k;
});

test('F4, the residual must be price, and the quantity half must be reproducible to the dollar', () => {
  let qtyUsd = 0, priceUsd = 0;
  for (const k of Object.keys(S.snap.tokens)) {
    const b = S.buckets.get(k); if (!b) continue;
    const llamaPrice = S.snap.tokensInUsd[k] / S.snap.tokens[k];
    qtyUsd += (b.qty - S.snap.tokens[k]) * llamaPrice;                    // quantity, held at DefiLlama's price
    priceUsd += b.qty * ((b.qty ? b.usd / b.qty : 0) - llamaPrice);       // price, held at our quantity
  }
  const tot = S.snap.totalLiquidityUSD;
  console.log(`  F4 residual split on $${(tot / 1e9).toFixed(3)}B: quantity $${qtyUsd.toFixed(2)} (${(qtyUsd / tot * 1e4).toExponential(2)} bps), price $${Math.round(priceUsd).toLocaleString('en-US')} (${(priceUsd / tot * 1e4).toFixed(3)} bps)`);
  // The point of separating them: they have different causes and cannot share a tolerance. The
  // quantity half is chain state on both sides and must agree to about a dollar out of eleven billion.
  assert.ok(Math.abs(qtyUsd) < 1000, `the quantity residual is $${qtyUsd.toFixed(2)}, which is no longer print rounding`);
  assert.ok(Math.abs(qtyUsd) < Math.abs(priceUsd) / 100, 'the quantity residual is no longer negligible against the price residual, so the two-band split has stopped being justified');
  M.measurements.qtyResidualUsd = qtyUsd;
  M.measurements.priceResidualUsd = priceUsd;
});

test('F5, the price band is the weak half, and the gate has to say how weak', () => {
  const tot = S.snap.totalLiquidityUSD;
  const impacts = Object.keys(S.snap.tokens).map((k) => {
    const b = S.buckets.get(k);
    return { k, bps: b ? (Math.abs(b.usd - S.snap.tokensInUsd[k]) / tot) * 1e4 : 0 };
  }).sort((a, b) => b.bps - a.bps);
  const worst = impacts[0];
  console.log(`  F5 worst honest per-reserve USD impact: ${worst.k} ${worst.bps.toFixed(3)} bps; band ${PRICE_IMPACT_BAND_BPS} bps (${PRICE_IMPACT_MULTIPLIER_NOTE}), utilisation ${(worst.bps / PRICE_IMPACT_BAND_BPS * 100).toFixed(1)}%`);
  console.log(`  F5 so the largest single-reserve PRICE lie this gate would not see is ~$${Math.round(PRICE_IMPACT_BAND_BPS / 1e4 * tot).toLocaleString('en-US')}, against ~$3 on the quantity side. The price half is about a million times weaker, and that is a property of the problem: Aave's oracle and DefiLlama's market quotes genuinely disagree.`);
  assert.ok(worst.bps <= PRICE_IMPACT_BAND_BPS, `${worst.k} at ${worst.bps.toFixed(2)} bps is outside the ${PRICE_IMPACT_BAND_BPS} bps price band`);
  // and the band must not be so wide it is decorative
  assert.ok(worst.bps / PRICE_IMPACT_BAND_BPS > 0.05, `the worst honest reserve uses ${(worst.bps / PRICE_IMPACT_BAND_BPS * 100).toFixed(1)}% of the price band; that band is decorative`);
  M.measurements.worstPriceImpactBps = worst.bps;
});

test('F6, the honest reading must be GREEN, or nothing below means anything', () => {
  const v = compare(S.buckets, S.snap.tokens, S.snap.tokensInUsd);
  console.log(`  F6 mode=${v.mode} reconstructed $${v.totalMine.toFixed(2)} vs DefiLlama $${v.totalLlama.toFixed(0)}, ${v.bps.toFixed(3)} bps on the total, findings ${v.findings.length}`);
  assert.equal(v.green, true, `the untampered reconstruction is already red: ${JSON.stringify(v.findings.slice(0, 3))}`);
});

test('F7, THE RED HALF: zero out reserves. The per-reserve form must catch one. The total form swallows dozens.', () => {
  const tot = S.snap.totalLiquidityUSD;
  const asc = [...S.buckets.values()].filter((b) => S.snap.tokens[b.key] !== undefined)
    .sort((a, b) => S.snap.tokensInUsd[a.key] - S.snap.tokensInUsd[b.key]);
  const zeroOut = (n) => {
    const kill = new Set(asc.slice(0, n).map((b) => b.key));
    const m = new Map();
    for (const [k, b] of S.buckets) m.set(k, kill.has(k) ? { ...b, qty: 0, usd: 0 } : b);
    return m;
  };
  // per-reserve, N = 1, the smallest reserve on the book
  const one = compare(zeroOut(1), S.snap.tokens, S.snap.tokensInUsd);
  const smallestUsd = S.snap.tokensInUsd[asc[0].key];
  console.log(`  F7 zeroing the SMALLEST reserve (${asc[0].key}, $${smallestUsd.toFixed(2)} = ${(smallestUsd / tot * 1e4).toExponential(2)} bps of TVL): per-reserve verdict ${one.green ? 'GREEN' : 'RED'}`);
  assert.equal(one.green, false, 'zeroing a reserve outright did not turn the per-reserve comparison red; it cannot be verifying anything');
  M.refusals.push('zeroed smallest reserve');

  // the same fabrication, escalated, against the total-only form
  let swallowed = 0, swallowedUsd = 0;
  for (let n = 1; n <= asc.length; n++) {
    const v = compare(zeroOut(n), S.snap.tokens, S.snap.tokensInUsd, { mode: 'total-only' });
    if (!v.green) break;
    swallowed = n; swallowedUsd = asc.slice(0, n).reduce((a, b) => a + S.snap.tokensInUsd[b.key], 0);
  }
  // and the per-reserve form against the largest fabrication the total form swallowed
  const perAtSwallowed = compare(zeroOut(Math.max(1, swallowed)), S.snap.tokens, S.snap.tokensInUsd);
  console.log(`  F7 SAME fabrication against a total-only comparison at a charitable ${TOTAL_ONLY_BAND_BPS} bps band:`);
  console.log(`  F7   ${swallowed} of ${asc.length} reserves can be zeroed and it still reads GREEN — $${Math.round(swallowedUsd).toLocaleString('en-US')}, ${(swallowedUsd / tot * 100).toFixed(3)}% of TVL`);
  console.log(`  F7   per-reserve on that same input: ${perAtSwallowed.green ? 'GREEN' : `RED, ${perAtSwallowed.findings.length} findings`}`);
  assert.ok(swallowed >= 10, `the total-only form only swallowed ${swallowed} zeroed reserves; the contrast this gate is built on is not reproducing`);
  assert.equal(perAtSwallowed.green, false, 'the per-reserve form went green on a fabrication the total form swallowed, which is the whole thing it exists to prevent');
  M.refusals.push(`per-reserve red where total-only swallowed ${swallowed}`);

  // WHY the total form is blind: signed errors cancel. Measured, not asserted.
  let absSum = 0;
  for (const k of Object.keys(S.snap.tokens)) { const b = S.buckets.get(k); if (b) absSum += Math.abs(b.usd - S.snap.tokensInUsd[k]); }
  const net = Math.abs([...S.buckets.values()].reduce((a, b) => a + b.usd, 0) - tot);
  console.log(`  F7 cancellation, measured: per-reserve divergences sum to $${Math.round(absSum).toLocaleString('en-US')} in absolute value but only $${Math.round(net).toLocaleString('en-US')} net, a factor of ${(absSum / net).toFixed(1)}x hidden by summing`);
  M.measurements.swallowedByTotal = swallowed;
  M.measurements.swallowedUsd = swallowedUsd;
  M.measurements.cancellation = absSum / net;
});

test('F8, THE TRAP: a per-reserve comparison that iterates the intersection is WEAKER than the total form', () => {
  const tot = S.snap.totalLiquidityUSD;
  const biggest = Object.keys(S.snap.tokensInUsd).sort((a, b) => S.snap.tokensInUsd[b] - S.snap.tokensInUsd[a])[0];
  const deleted = new Map(S.buckets);
  deleted.delete(biggest);                              // not zeroed. Gone.
  const naive = compareIntersectionOnly(deleted, S.snap.tokens);
  const strict = compare(deleted, S.snap.tokens, S.snap.tokensInUsd);
  const usd = S.snap.tokensInUsd[biggest];
  console.log(`  F8 DELETING the largest reserve (${biggest}, $${Math.round(usd).toLocaleString('en-US')} = ${(usd / tot * 100).toFixed(2)}% of TVL):`);
  console.log(`  F8   intersection-only per-reserve: ${naive.green ? 'GREEN — it never looked' : 'RED'}`);
  console.log(`  F8   coverage-asserting per-reserve: ${strict.green ? 'GREEN' : `RED (${strict.findings[0].kind}: ${strict.findings[0].key})`}`);
  console.log(`  F8   so "per reserve" alone is not the fix. Without the coverage assertion it swallows $${Math.round(usd).toLocaleString('en-US')}, against $${Math.round(M.measurements.swallowedUsd || 0).toLocaleString('en-US')} for the total form it was supposed to improve on.`);
  assert.equal(naive.green, true, 'the intersection-only form failed to reproduce the defect this test documents; the contrast below would be invented');
  assert.equal(strict.green, false, 'the shipped comparison did not notice a deleted reserve worth a fifth of the book');
  assert.equal(strict.findings[0].kind, 'coverage-missing');
  M.refusals.push('deleted largest reserve');
  M.measurements.deletedUsd = usd;
  M.measurements.deletedPct = (usd / tot) * 100;
});

test('F9, the sensitivity floor: red above the bound, green below it. A gate red in both states is broken, not strict.', () => {
  const tot = S.snap.totalLiquidityUSD;
  const results = [];
  for (const key of ['WETH', 'USDC', 'WBTC'].filter((k) => S.buckets.has(k) && S.snap.tokens[k] !== undefined)) {
    const b = S.buckets.get(key);
    const bound = printHalfUlpPct(S.snap.tokens[key]) / 100;             // fractional
    const already = Math.abs((b.qty - S.snap.tokens[key]) / S.snap.tokens[key]);
    const headroom = Math.max(0, bound - already);
    const under = new Map(S.buckets); under.set(key, { ...b, qty: b.qty * (1 + headroom * 0.5) });
    const over = new Map(S.buckets); over.set(key, { ...b, qty: b.qty * (1 + headroom + bound * 4) });
    const vU = compare(under, S.snap.tokens, S.snap.tokensInUsd);
    const vO = compare(over, S.snap.tokens, S.snap.tokensInUsd);
    const usdAtBound = headroom * S.snap.tokensInUsd[key];
    results.push({ key, under: vU.green, over: vO.green, usdAtBound });
    console.log(`  F9 ${key}: perturbation just under the bound -> ${vU.green ? 'GREEN' : 'RED'}, just over -> ${vO.green ? 'GREEN' : 'RED'}; largest undetectable quantity lie here $${usdAtBound.toFixed(2)} of $${Math.round(S.snap.tokensInUsd[key]).toLocaleString('en-US')}`);
    assert.equal(vU.green, true, `${key}: a perturbation inside DefiLlama's own print precision was refused; the gate is red in both directions, which makes it broken rather than strict`);
    assert.equal(vO.green, false, `${key}: a perturbation outside the bound was accepted`);
    M.refusals.push(`${key} over-bound perturbation`);
  }
  assert.ok(results.length >= 3, 'too few reserves exercised for the sensitivity floor to mean anything');
  const worstUndetectable = Math.max(...results.map((r) => r.usdAtBound));
  console.log(`  F9 across those, the largest quantity fabrication that survives is $${worstUndetectable.toFixed(2)} out of $${(tot / 1e9).toFixed(2)}B = ${(worstUndetectable / tot * 1e4).toExponential(2)} bps`);
  M.measurements.worstUndetectableQtyUsd = worstUndetectable;
});

test('F10, the calibration trap: DefiLlama\'s historical daily points are NOT chain state at their own timestamp', async () => {
  // This test exists because calibrating the band on historical points is the obvious thing to do and
  // it is wrong. A band fitted to them would be ~150 bps wide and would swallow everything. That is
  // the same failure as a bound written in the wrong units: it passes, and it means nothing.
  let pin;
  try { pin = await pinBlock(S.daily.date); } catch (e) { M.skipped.push(`F10 pin: ${e.message}`); return; }
  let rows;
  try { rows = await reconstruct(pin.n); } catch (e) { M.skipped.push(`F10 archive: ${String(e.message).slice(0, 80)}`); console.log(`  F10 SKIPPED (transport, not verification): ${String(e.message).slice(0, 90)}`); return; }
  const bk = bucketBySymbol(rows.rows);
  const over = Object.keys(S.daily.tokens).filter((k) => {
    const b = bk.get(k); if (!b) return false;
    return Math.abs(((b.qty - S.daily.tokens[k]) / S.daily.tokens[k]) * 100) > printHalfUlpPct(S.daily.tokens[k]);
  });
  console.log(`  F10 daily point ts=${S.daily.date}, block ${pin.n}, drift ${pin.ts - S.daily.date}s: ${over.length} of ${Object.keys(S.daily.tokens).length} reserves outside the print bound`);
  console.log(`  F10 so this gate pins to the LIVE last point only (drift 0, asserted in F1). ${S.series} daily points exist and none of them may be used to widen the band.`);
  assert.ok(over.length > 0, 'the daily point reconciled exactly, so the reason this gate refuses historical points no longer holds and the restriction should be revisited');
  M.measurements.dailyPointOverBound = over.length;
});

test('F11, the gate must state its own coverage rather than imply completeness', async () => {
  // Every figure here is fetched and computed, not quoted.
  let lite, hacks;
  try {
    lite = await (await fetch('https://api.llama.fi/lite/protocols2', { headers: { accept: 'application/json' } })).json();
    hacks = await (await fetch('https://api.llama.fi/hacks', { headers: { accept: 'application/json' } })).json();
  } catch (e) { M.skipped.push(`F11: ${e.message}`); console.log(`  F11 SKIPPED (transport): ${e.message}`); return; }

  let allTvl = 0; const byCat = new Map();
  for (const p of lite.protocols) {
    const t = Number(p.tvl) || 0; if (t <= 0) continue;
    allTvl += t; byCat.set(p.category || '(none)', (byCat.get(p.category || '(none)') || 0) + t);
  }
  const bridge = byCat.get('Bridge') || 0, rwa = byCat.get('RWA') || 0, canon = byCat.get('Canonical Bridge') || 0;
  const eth = S.snap.totalLiquidityUSD;
  const av = lite.protocols.find((p) => p.name === 'Aave V3');

  console.log(`  F11 this gate verifies Aave V3 ETHEREUM only: $${(eth / 1e9).toFixed(2)}B`);
  console.log(`  F11   = ${(eth / (av ? av.tvl : eth) * 100).toFixed(2)}% of Aave V3 across all chains, and ${(eth / allTvl * 100).toFixed(3)}% of the $${(allTvl / 1e9).toFixed(1)}B DefiLlama tracks`);
  console.log(`  F11 structurally out of reach of ANY chain-state reconstruction:`);
  console.log(`  F11   Bridge ${(bridge / allTvl * 100).toFixed(2)}% + RWA ${(rwa / allTvl * 100).toFixed(2)}% = ${((bridge + rwa) / allTvl * 100).toFixed(2)}% of tracked TVL`);
  console.log(`  F11   (+ a separate "Canonical Bridge" category at ${(canon / allTvl * 100).toFixed(2)}%, which the 30.1% figure in PHASE_D_OFFCHAIN_VENUES.md §3.9 does not include, so the honest total is ${((bridge + rwa + canon) / allTvl * 100).toFixed(2)}%)`);
  const withPointer = hacks.filter((h) => /0x[0-9a-fA-F]{40,}/.test(JSON.stringify(h))).length;
  const withSource = hacks.filter((h) => typeof h.source === 'string' && h.source.trim().length > 0).length;
  console.log(`  F11 /hacks: ${hacks.length} incident records, ${withPointer} contain any on-chain pointer, ${withSource} carry a source link. There is nothing to reconstruct.`);

  // These are the claims that would do real damage if they drifted, so they are asserted rather than printed.
  assert.ok(eth / allTvl < 0.10, `this gate now covers ${(eth / allTvl * 100).toFixed(1)}% of tracked TVL; the coverage statement above is stale`);
  assert.ok((bridge + rwa) / allTvl > 0.20, 'the unreconstructable share fell below 20%, the §3.9 claim needs re-measuring');
  assert.equal(withPointer, 0, `${withPointer} /hacks records now carry an on-chain pointer; the "structurally unverifiable" claim is no longer the whole truth`);
  M.measurements.coveragePctOfTracked = (eth / allTvl) * 100;
  M.measurements.unreconstructablePct = ((bridge + rwa) / allTvl) * 100;
  M.measurements.hacksWithPointer = withPointer;
});

test('F12, summary, and the gate must have refused enough to be worth its green', () => {
  const m = M.measurements;
  console.log('\n=== GATE F MEASUREMENTS (this run, not quoted) ===');
  console.log(`  snapshot                       block ${m.block}, drift ${m.drift}s, ${S.buckets.size} reserves, ${S.rec.subCalls} sub-calls, ${S.rec.latencyMs} ms`);
  console.log(`  wire                           DefiLlama ${(S.llamaBytes / 1e6).toFixed(2)} MB in ${S.llamaMs} ms vs one Multicall3 round trip for the chain side`);
  console.log(`  quantity residual              $${(m.qtyResidualUsd ?? 0).toFixed(2)} on $${(S.snap.totalLiquidityUSD / 1e9).toFixed(2)}B`);
  console.log(`  price residual                 $${Math.round(m.priceResidualUsd ?? 0).toLocaleString('en-US')} (${((m.priceResidualUsd ?? 0) / S.snap.totalLiquidityUSD * 1e4).toFixed(2)} bps) — the whole of the disagreement`);
  console.log(`  worst honest reserve           ${m.worstQtyKey} uses ${((m.worstQtyBoundUse ?? 0) * 100).toFixed(2)}% of its quantity bound`);
  console.log(`  worst honest price impact      ${(m.worstPriceImpactBps ?? 0).toFixed(3)} bps of ${PRICE_IMPACT_BAND_BPS} bps band`);
  console.log(`  largest fabrication swallowed  per-reserve: $${(m.worstUndetectableQtyUsd ?? 0).toFixed(2)} (quantity) | total-only: $${Math.round(m.swallowedUsd ?? 0).toLocaleString('en-US')} across ${m.swallowedByTotal} zeroed reserves`);
  console.log(`  intersection-only would swallow $${Math.round(m.deletedUsd ?? 0).toLocaleString('en-US')} (${(m.deletedPct ?? 0).toFixed(2)}% of TVL) — worse than the total form it "improves" on`);
  console.log(`  cancellation hidden by summing ${(m.cancellation ?? 0).toFixed(1)}x`);
  console.log(`  coverage                       ${(m.coveragePctOfTracked ?? 0).toFixed(3)}% of tracked TVL verified here; ${(m.unreconstructablePct ?? 0).toFixed(1)}% structurally unreconstructable; /hacks pointers: ${m.hacksWithPointer}`);
  console.log(`  refusals exercised             ${M.refusals.length}`);
  if (M.skipped.length) console.log(`  skipped (transport, NOT verification): ${M.skipped.length} — ${M.skipped.join('; ')}`);
  console.log('=== end measurements ===\n');
  assert.ok(M.refusals.length >= 5, `only ${M.refusals.length} refusals exercised; the red half is too thin to trust the green half`);
  assert.ok(M.skipped.length <= 1, `${M.skipped.length} checks were skipped for transport reasons; too much of this run did not execute`);
});
