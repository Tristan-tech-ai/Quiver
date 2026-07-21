// PolyFill — pre-trade fill simulation on a Polymarket order book:
// executable average price for $X, slippage vs mid, per-level walk, and the max size
// that stays inside a target slippage. The midpoint on thin books is a lie; this is the truth.
import * as pm from '../adapters/polymarket.js';
import { config } from '../config.js';
import { round } from './stats.js';

// Walk the FULL book and fit the executable-cost curve to the square-root market-impact law
// (cost ≈ k·√notional — the functional form Almgren et al. find for meta-order impact). We MEASURE the
// coefficient and fit quality on the live book rather than assuming a value, and only extrapolate beyond
// the visible depth with an explicit lower-bound caveat. Also returns total depth for the imbalance read.
function impactModel(levels, mid) {
  if (!mid || !levels.length) return null;
  let cumUsd = 0, cumShares = 0; const pts = [];
  for (const l of levels) {
    cumUsd += l.price * l.size; cumShares += l.size;
    const avg = cumUsd / cumShares;
    pts.push({ notional: cumUsd, slip: Math.abs((avg - mid) / mid) * 100, sqrtN: Math.sqrt(cumUsd) });
  }
  if (pts.length < 3) return { k: null, r2: null, visibleDepthUsd: cumUsd, pts };
  // through-origin OLS: slip = k·√notional; report a centered R² so a poor square-root fit is visible.
  let sxy = 0, sxx = 0; for (const p of pts) { sxy += p.sqrtN * p.slip; sxx += p.sqrtN * p.sqrtN; }
  const k = sxx > 0 ? sxy / sxx : null;
  const my = pts.reduce((a, b) => a + b.slip, 0) / pts.length;
  let ssres = 0, sstot = 0; for (const p of pts) { ssres += (p.slip - k * p.sqrtN) ** 2; sstot += (p.slip - my) ** 2; }
  return { k, r2: sstot > 0 ? 1 - ssres / sstot : null, visibleDepthUsd: cumUsd, pts };
}

export async function polyFill({ market, side = 'YES', action = 'buy', usd = 100, maxSlippagePct = null }, deps = pm) {
  const t0 = Date.now();
  const m = await deps.resolveMarket(market);
  const ids = deps.clobTokenIds(m);
  const tokenId = String(side).toUpperCase() === 'NO' ? ids.no : ids.yes;
  const book = await deps.book(tokenId);

  // Book freshness: the CLOB response carries a server timestamp — surface it instead of promising
  // "at call time" unverified. Absent timestamp = freshness UNVERIFIABLE, said out loud.
  const serverTs = Number(book?.timestamp) || null;
  const bookFreshness = serverTs
    ? { serverTimestampUtc: new Date(serverTs).toISOString(), ageMs: Math.max(0, Date.now() - serverTs) }
    : { serverTimestampUtc: null, ageMs: null, note: 'CLOB response carried no server timestamp — book freshness is unverifiable for this call.' };

  // Buying YES consumes asks; selling consumes bids.
  const levels = (action === 'sell' ? book.bids : book.asks || [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => l.price > 0 && l.size > 0)
    .sort((a, b) => (action === 'sell' ? b.price - a.price : a.price - b.price));

  const bestBid = Math.max(...(book.bids || []).map((l) => Number(l.price)), 0);
  const bestAsk = Math.min(...(book.asks || []).map((l) => Number(l.price)), 1);
  // A crossed book (best bid above best ask) means the snapshot is inconsistent/mid-update — a midpoint
  // computed from it is fiction. Refuse the mid rather than average a lie.
  const bookCrossed = bestBid > 0 && bestAsk <= 1 && bestBid > bestAsk;
  const mid = !bookCrossed && bestBid && bestAsk <= 1 ? (bestBid + bestAsk) / 2 : null;

  if (!levels.length) {
    return { service: 'poly-fill', version: config.version, market: m.slug, question: m.question, verdict: 'NO_LIQUIDITY', note: `No ${action === 'sell' ? 'bids' : 'asks'} on the ${side} book right now.` };
  }

  // Walk the book with $usd. Consumption walks the WHOLE book — the verdict must reflect true depth,
  // never a display cap (a 25-level consumption cap here once mislabeled deep granular books as
  // INSUFFICIENT_DEPTH). Only the RECORDED rows are capped.
  let remainingUsd = usd, shares = 0, spentUsd = 0, levelsConsumed = 0;
  const walk = [];
  for (const l of levels) {
    if (remainingUsd <= 0) break;
    const levelUsd = l.price * l.size;
    const takeUsd = Math.min(remainingUsd, levelUsd);
    const takeShares = takeUsd / l.price;
    shares += takeShares; spentUsd += takeUsd; remainingUsd -= takeUsd;
    levelsConsumed += 1;
    if (walk.length < 25) walk.push({ price: l.price, usdFilled: round(takeUsd, 2), sharesFilled: round(takeShares, 1) });
  }
  const avgPrice = shares > 0 ? spentUsd / shares : null;
  const slippagePct = avgPrice && mid ? ((avgPrice - mid) / mid) * 100 * (action === 'sell' ? -1 : 1) : null;
  const filledFully = remainingUsd <= 0.01;

  // Max clean size within target slippage (if requested): walk until slippage cap crossed.
  let maxCleanUsd = null;
  if (maxSlippagePct !== null && mid) {
    let cum = 0, cumShares = 0;
    for (const l of levels) {
      const nextShares = cumShares + l.size;
      const nextCum = cum + l.price * l.size;
      const nextAvg = nextCum / nextShares;
      const slip = Math.abs(((nextAvg - mid) / mid) * 100);
      if (slip > Math.abs(maxSlippagePct)) {
        // partial level to the cap
        maxCleanUsd = cum;
        break;
      }
      cum = nextCum; cumShares = nextShares; maxCleanUsd = cum;
    }
  }

  // Market-impact model + depth microstructure (D18): fit the cost curve to the square-root law, and read
  // the two-sided depth imbalance + maker/adverse-selection context — all measured off the live book.
  const im = impactModel(levels, mid);
  const bidDepthUsd = (book.bids || []).reduce((a, l) => a + Number(l.price) * Number(l.size), 0);
  const askDepthUsd = (book.asks || []).reduce((a, l) => a + Number(l.price) * Number(l.size), 0);
  const totalDepth = bidDepthUsd + askDepthUsd;
  const imbalance = totalDepth > 0 ? bidDepthUsd / totalDepth : null;
  const spreadCents = (bestBid && bestAsk <= 1 && bestAsk >= bestBid) ? (bestAsk - bestBid) * 100 : null;
  const bestLevelUsd = levels[0] ? levels[0].price * levels[0].size : null;

  return {
    service: 'poly-fill',
    version: config.version,
    market: m.slug, question: m.question, endDate: m.endDate,
    side: String(side).toUpperCase(), action, requestedUsd: usd,
    verdict: bookCrossed ? 'BOOK_CROSSED' : filledFully ? (slippagePct !== null && Math.abs(slippagePct) > 10 ? 'FILLS_WITH_HEAVY_SLIPPAGE' : 'FILLS_CLEAN') : 'INSUFFICIENT_DEPTH',
    bookFreshness,
    ...(bookCrossed ? { bookCrossedNote: `Best bid ${round(bestBid * 100, 2)}c > best ask ${round(bestAsk * 100, 2)}c — inconsistent snapshot (mid refused; fill math still walks the real resting levels, but re-fetch before acting).` } : {}),
    fill: {
      avgPriceCents: avgPrice ? round(avgPrice * 100, 2) : null,
      midCents: mid ? round(mid * 100, 2) : null,
      slippageVsMidPct: round(slippagePct, 2),
      sharesBought: round(shares, 1),
      usdFilled: round(spentUsd, 2),
      usdUnfilled: round(Math.max(0, remainingUsd), 2),
      levelsConsumed,
      maxUsdWithinSlippage: maxSlippagePct !== null ? round(maxCleanUsd, 2) : undefined,
      targetSlippagePct: maxSlippagePct ?? undefined,
    },
    marketImpact: im ? {
      model: 'executable cost ≈ k·√notional (square-root impact law, Almgren-style) FITTED to the live book',
      coeffPctPerSqrtUsd: im.k != null ? round(im.k, 4) : null,
      fitR2: im.r2 != null ? round(im.r2, 3) : null,
      visibleDepthUsd: round(im.visibleDepthUsd, 0),
      profile: [100, 500, 1000, 5000, 10000].map((n) => ({ notionalUsd: n, estCostPct: im.k != null ? round(im.k * Math.sqrt(n), 2) : null, beyondVisibleDepth: n > im.visibleDepthUsd })),
      note: 'The cost-vs-size curve of THIS book fitted to the square-root impact law; fitR2 shows how closely the book actually follows it (measured, not assumed). Rows flagged beyondVisibleDepth are EXTRAPOLATIONS past resting liquidity — a lower bound on true cost.',
    } : null,
    bookDepth: {
      totalBidUsd: round(bidDepthUsd, 0), totalAskUsd: round(askDepthUsd, 0),
      imbalance: imbalance != null ? round(imbalance, 3) : null,
      spreadCents: spreadCents != null ? round(spreadCents, 2) : null,
      note: 'imbalance = bid$/(bid$+ask$) over the visible book: >0.5 = more resting demand than supply (short-horizon upward pressure), <0.5 the reverse. Descriptive order-book microstructure, not a forecast.',
    },
    makerContext: bestLevelUsd != null ? {
      touchQueueUsd: round(bestLevelUsd, 0),
      note: 'If you REST at the touch instead of taking, roughly this much size sits ahead of you in the queue, and you carry adverse selection — a resting order tends to fill precisely when informed flow runs through your level (you trade right before the market moves against you). The taker cost above vs this maker trade-off is surfaced, not assumed.',
    } : undefined,
    bookWalk: walk.slice(0, 12),
    method: 'Live CLOB order-book walk: consumes real resting levels for the requested notional and reports the volume-weighted executable price against the current midpoint. The cost curve is also fitted to the square-root market-impact law, and the two-sided depth imbalance + maker/adverse-selection context are read off the same book.',
    limitations: 'Books move; this is the executable price at call time, not a quote guarantee. Large sizes beyond visible depth return INSUFFICIENT_DEPTH, and the impact profile past visibleDepthUsd is an extrapolated lower bound. Informational pre-trade calculation, not financial advice.',
    elapsedMs: Date.now() - t0,
  };
}
