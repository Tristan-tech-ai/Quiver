// TapePulse — one call: a composed microstructure read of a token's live DEX tape.
// Correctness details clones get wrong (probe-proven): routed swaps emit MULTIPLE rows sharing
// one txHashUrl (dedupe or you double-count), and isFiltered rows are OKX-flagged noise (drop).
import * as data from '../adapters/data.js';
import { config } from '../config.js';
import { round, olsSlopeCI } from './stats.js';

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

// Real market-microstructure estimators on the deduped, time-sorted tape. Trade side comes from OKX's
// own buy/sell label (superior to Lee–Ready inference — no classifier error to propagate). Each metric
// self-gates to null when the tape is too thin or price never varies, rather than emitting false precision.
// Descriptive, not prescriptive.
//   • Kyle's λ  — OLS slope of PERIOD log return on PERIOD signed dollar flow (buys +, sells −): the price
//     impact per unit net order flow (Kyle 1985). Estimated on equal-count blocks, not tick-by-tick — a
//     block is the correct "period" analog, and it is immune to the sparse/large-trade sampling that the
//     OKX feed applies to hot tokens (where two consecutive trades can be hours apart → tick return = drift,
//     not impact).
//   • Amihud ILLIQ — mean(|period return| / period dollar volume) (Amihud 2002), reported as % move per
//     $1k. Also block-based: a per-TRADE ratio is dominated by sub-cent DEX dust (near-zero denominator
//     → nonsense); aggregating volume over a block removes that explosion while staying faithful.
//   • VPIN — mean |buyVol − sellVol| / bucketVol across equal-VOLUME buckets (Easley–López de Prado–
//     O'Hara 2012): order-flow toxicity / one-sidedness ∈ [0,1]. Unaffected by trade timing.
// Ground-truthed on BONK/PEPE: a naive per-trade Amihud returned 1.6e9 %/$1k from dust — this block form fixes it.
const BLOCK = 10; // trades per period-block for the λ / Amihud aggregation
export function microstructure(trades) {
  const n = trades.length;

  // Tape density — make sparse/sampled feeds VISIBLE rather than silently degrading the impact read.
  const gaps = [];
  for (let i = 1; i < n; i++) { const g = (trades[i].time - trades[i - 1].time) / 1000; if (g >= 0) gaps.push(g); }
  const gsort = [...gaps].sort((a, b) => a - b);
  const medGap = gsort.length ? gsort[Math.floor(gsort.length / 2)] : null;
  const spanHours = n > 1 ? (trades[n - 1].time - trades[0].time) / 3600000 : 0;
  const tape = medGap == null ? null : {
    trades: n, medianGapSeconds: round(medGap, 1), spanHours: round(spanHours, 2),
    note: medGap > 60
      ? 'Median gap > 1 min between trades: the OKX DEX feed is returning a sampled/large-trade subset of this hot token, not its full tape — so the price-impact read (Kyle λ) is a coarse lower bound. VPIN (a volume-imbalance measure) is unaffected by timing.'
      : 'Sub-minute median gap: a dense tape, so the price-impact estimates rest on firm ground.',
  };

  // Equal-count period blocks (non-overlapping) — the robust, dust-immune aggregation used for λ and Amihud.
  const blocks = [];
  for (let s = 0; s + BLOCK <= n; s += BLOCK) {
    const chunk = trades.slice(s, s + BLOCK);
    const p0 = chunk[0].price, p1 = chunk[BLOCK - 1].price;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    let signed = 0, dollar = 0;
    for (const t of chunk) { if (t.vol > 0) { dollar += t.vol; signed += (t.type === 'buy' ? t.vol : -t.vol); } }
    if (dollar <= 0) continue;
    blocks.push({ ret: Math.log(p1 / p0), signed, dollar });
  }

  const out = { tape, kyleLambda: null, amihud: null, vpin: null };

  // Kyle's λ — OLS of block return on block signed dollar flow; report slope, R², sign-agreement, and a
  // 95% confidence interval on the slope (the CI answers the real question: is the price impact even
  // distinguishable from zero, given this many noisy blocks?).
  if (blocks.length >= 8) {
    const m = blocks.length;
    const xs = blocks.map((b) => b.signed), ys = blocks.map((b) => b.ret);
    let agree = 0;
    for (let i = 0; i < m; i++) if (ys[i] !== 0 && Math.sign(ys[i]) === Math.sign(xs[i])) agree += 1;
    const fit = olsSlopeCI(xs, ys);
    if (fit && fit.r2 != null) {
      const toBps = (v) => (v == null ? null : round(v * 1e8, 1));
      out.kyleLambda = {
        priceImpactBpsPer10kUsd: toBps(fit.slope), // λ·$10k·1e4 bps
        ci95BpsPer10kUsd: fit.ciLo != null ? [toBps(fit.ciLo), toBps(fit.ciHi)] : null,
        impactDistinguishableFromZero: fit.excludesZero, // 95% CI excludes 0 → statistically-detectable impact
        rSquared: round(fit.r2, 3),
        signAgreement: round(agree / m, 2),           // fraction of blocks where flow & price agree
        blocks: m, tradesPerBlock: BLOCK,
        confidence: fit.excludesZero === false ? 'indeterminate (95% CI spans 0)' : fit.r2 >= 0.3 && m >= 20 ? 'high' : fit.r2 >= 0.1 ? 'medium' : 'low',
        note: 'Price impact: a net $10k of one-sided flow over a block is associated with this many bps of move. The 95% CI (normal approximation, df=blocks−2) shows the sampling range; if it SPANS ZERO the impact is not statistically distinguishable from noise on this tape — a common, honest outcome on thin/sampled feeds.',
      };
    }
  }

  // Amihud illiquidity — mean |block return| per $ of block volume, reported as % move per $1k.
  if (blocks.length >= 8) {
    const terms = blocks.map((b) => Math.abs(b.ret) / b.dollar);
    const mean = terms.reduce((a, b) => a + b, 0) / terms.length;
    out.amihud = {
      pctMovePer1kUsd: round(mean * 1000 * 100, 4),
      blocks: blocks.length, tradesPerBlock: BLOCK,
      note: 'Average price move per $1k traded, over equal-count blocks (block aggregation avoids the sub-cent-dust blow-up a per-trade ratio suffers). Higher = thinner, more impactful liquidity.',
    };
  }

  // VPIN — equal-VOLUME buckets, split trades at bucket boundaries, drop the trailing partial bucket.
  const totalVol = trades.reduce((a, t) => a + (t.vol > 0 ? t.vol : 0), 0);
  if (trades.length >= 50 && totalVol > 0) {
    const B = 20, bucketSize = totalVol / B;
    const imbalances = [];
    let curBuy = 0, curSell = 0, cap = bucketSize;
    for (const t of trades) {
      let v = t.vol > 0 ? t.vol : 0;
      const isBuy = t.type === 'buy';
      while (v > 1e-12) {
        const take = Math.min(v, cap);
        if (isBuy) curBuy += take; else curSell += take;
        v -= take; cap -= take;
        if (cap <= 1e-9) { imbalances.push(Math.abs(curBuy - curSell) / bucketSize); curBuy = 0; curSell = 0; cap = bucketSize; }
      }
    }
    if (imbalances.length >= 8) {
      const vpin = imbalances.reduce((a, b) => a + b, 0) / imbalances.length;
      out.vpin = {
        value: round(vpin, 3),
        buckets: imbalances.length,
        bucketVolumeUsd: round(bucketSize),
        note: 'Order-flow toxicity: mean |buy−sell| imbalance across equal-volume buckets (0 = perfectly two-sided, 1 = fully one-sided). Elevated values flag one-sided/informed flow, historically linked to higher near-term volatility.',
      };
    }
  }
  return out;
}

export async function tapePulse(chain, address) {
  const t0 = Date.now();
  const [tapeRaw, priceRaw] = await Promise.all([
    data.trades(chain, address, config.tapeLimit),
    data.priceInfo(chain, address).catch(() => ({})),
  ]);
  const rows = Array.isArray(tapeRaw) ? tapeRaw : tapeRaw?.list || [];
  if (!rows.length) {
    return { service: 'tape-pulse', version: config.version, chain, token: address, verdict: 'NO_TAPE', note: 'No recent DEX trades found for this token on this chain.' };
  }
  const price = Array.isArray(priceRaw) ? priceRaw[0] || {} : priceRaw || {};

  // Resolve the token symbol: priceInfo first, else from the trade rows' changedTokenInfo (same as chart-press).
  let tokenSymbol = price.tokenSymbol || null;
  if (!tokenSymbol) {
    for (const r of rows) {
      const hit = (r.changedTokenInfo || []).find((c) => String(c.tokenAddress).toLowerCase() === String(address).toLowerCase());
      if (hit?.tokenSymbol) { tokenSymbol = hit.tokenSymbol; break; }
    }
  }

  // Dedupe multi-leg routed swaps by tx hash, keep the largest leg per (tx, side).
  const byKey = new Map();
  let filteredDropped = 0;
  for (const r of rows) {
    if (String(r.isFiltered) === '1') { filteredDropped += 1; continue; }
    const key = `${r.txHashUrl || r.id}:${r.type}`;
    const vol = num(r.volume) || 0;
    const prev = byKey.get(key);
    if (!prev || vol > prev.vol) byKey.set(key, { type: r.type, vol, time: num(r.time) || 0, price: num(r.price), wallet: r.userAddress, tx: r.txHashUrl, dex: r.dexName });
  }
  const trades = [...byKey.values()].sort((a, b) => a.time - b.time);
  const spanMs = trades.length > 1 ? trades[trades.length - 1].time - trades[0].time : 0;

  let buyVol = 0, sellVol = 0, buyCnt = 0, sellCnt = 0, pv = 0, vv = 0;
  for (const t of trades) {
    if (t.type === 'buy') { buyVol += t.vol; buyCnt += 1; } else { sellVol += t.vol; sellCnt += 1; }
    if (t.price && t.vol) { pv += t.price * t.vol; vv += t.vol; }
  }
  const total = buyVol + sellVol;
  const imbalance = total > 0 ? buyVol / total : 0.5;
  const netUsd = buyVol - sellVol;
  const tapeVwap = vv > 0 ? pv / vv : null;
  const spot = num(price.price);
  const vwapVsSpotPct = tapeVwap && spot ? ((spot - tapeVwap) / tapeVwap) * 100 : null;

  // Whale prints: top individual deduped trades by USD.
  const whales = [...trades].sort((a, b) => b.vol - a.vol).slice(0, 3)
    .filter((t) => t.vol >= Math.max(2000, total / trades.length * 8))
    .map((t) => ({ side: t.type, usd: round(t.vol), wallet: t.wallet, dex: t.dex, secondsAgo: Math.round((Date.now() - t.time) / 1000), tx: t.tx }));

  // Acceleration: trade rate in the newest third vs the oldest third of the window.
  let acceleration = null;
  if (trades.length >= 60 && spanMs > 0) {
    const third = spanMs / 3;
    const t0w = trades[0].time;
    const oldN = trades.filter((t) => t.time < t0w + third).length;
    const newN = trades.filter((t) => t.time > t0w + 2 * third).length;
    if (oldN >= 5) acceleration = round(newN / oldN, 1);
  }

  const verdict =
    imbalance >= 0.62 ? 'BUYERS_IN_CONTROL'
    : imbalance <= 0.38 ? 'SELLERS_IN_CONTROL'
    : 'BALANCED';

  const micro = microstructure(trades);

  return {
    service: 'tape-pulse',
    version: config.version,
    chain, token: address,
    tokenSymbol,
    verdict,
    verdictBasis: 'Descriptive label of the buy/sell split on this tape window: BUYERS_IN_CONTROL when buy-share ≥ 0.62, SELLERS_IN_CONTROL when ≤ 0.38, else BALANCED. A disclosed heuristic cutoff, not a fitted or predictive boundary.',
    read: {
      buyImbalance: round(imbalance, 3),
      netFlowUsd: round(netUsd),
      buys: buyCnt, sells: sellCnt,
      tapeVwap: tapeVwap ? Number(tapeVwap.toPrecision(6)) : null,
      spot: spot ? Number(spot.toPrecision(6)) : null,
      spotVsTapeVwapPct: round(vwapVsSpotPct, 2),
      tradeRateAcceleration: acceleration,
      whalePrints: whales,
    },
    microstructure: micro,
    context: {
      priceChange1H: num(price.priceChange1H), priceChange24H: num(price.priceChange24H),
      volume24hUsd: num(price.volume24H), liquidityUsd: num(price.liquidity), holders: num(price.holders),
    },
    dataWindow: {
      rawRows: rows.length,
      dedupedTrades: trades.length,
      routedLegsMerged: rows.length - filteredDropped - trades.length,
      okxFilteredDropped: filteredDropped,
      tapeSpanMinutes: round(spanMs / 60000, 1),
      tapeVolumeUsd: round(total),
    },
    method: 'Last ~500 DEX trades, deduplicated by transaction hash (multi-leg routed swaps merged) with exchange-flagged rows excluded. On the clean tape: buy/sell imbalance, net USD flow, tape VWAP vs spot, whale prints, trade-rate acceleration, and real microstructure estimators — Kyle\'s λ (price-impact regression of tick return on signed dollar flow), Amihud illiquidity (|return| per $ traded), and VPIN (order-flow toxicity across equal-volume buckets). Trade side is OKX\'s own buy/sell label, so no Lee–Ready classifier error is introduced.',
    limitations: 'Reads the most recent tape window only (tapeSpanMinutes shows exactly how far it reaches — long spans mean a quiet token and a weaker read). Microstructure estimators self-gate to null when the tape is too thin or price never varies; Kyle\'s λ carries its own R²/sign-agreement and confidence so a weak fit is visible rather than hidden. VPIN here is measured over a single recent tape window, not a multi-day volume clock. Descriptive of the immediate tape, not fundamentals or financial advice.',
    elapsedMs: Date.now() - t0,
  };
}
