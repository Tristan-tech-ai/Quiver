// PolyDesk — one call: a Polymarket wallet's live book — open positions with current marks and
// unrealized PnL, cash-out value, and biggest movers — for copy/portfolio agents tracking a trader.
import * as pm from '../adapters/polymarket.js';
import { config } from '../config.js';
import { round, hhi } from './stats.js';

// Portfolio RISK on a prediction-market book (the depth a flat position read lacks): concentration by
// market (Herfindahl → effective number of independent bets), the largest single-market share, and the
// YES/NO directional skew. Pure + deterministic given the positions, so it is unit-tested offline.
export function polyPortfolioRisk(norm) {
  const byMarket = {};
  for (const p of norm) { const k = p.market || 'unknown'; byMarket[k] = (byMarket[k] || 0) + Math.abs(p.valueUsd || 0); }
  const vals = Object.values(byMarket);
  const total = vals.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const H = hhi(vals);
  const shares = Object.entries(byMarket).map(([market, v]) => ({ market, sharePct: round((100 * v) / total, 1) })).sort((a, b) => b.sharePct - a.sharePct);
  let yes = 0, no = 0;
  for (const p of norm) { const o = String(p.outcome || '').toLowerCase(); const v = Math.abs(p.valueUsd || 0); if (o.includes('yes')) yes += v; else if (o.includes('no')) no += v; }
  const top = shares[0]?.sharePct ?? 0;
  return {
    marketsHeld: vals.length,
    concentrationHhi: round(H, 4),
    effectiveBets: round(1 / H, 2),
    largestPositionPct: top,
    topMarkets: shares.slice(0, 5),
    outcomeSkew: (yes + no) > 0 ? { yesPct: round((100 * yes) / (yes + no), 1), noPct: round((100 * no) / (yes + no), 1) } : null,
    verdict: top > 50
      ? `Over-concentrated: ${top}% of the book is in a single market (${shares[0].market}). One resolution dominates the P&L.`
      : H > 0.5
        ? `Concentrated: ~${round(1 / H, 1)} effective independent bets — a few markets drive the book.`
        : `Diversified across ~${round(1 / H, 1)} effective bets.`,
  };
}

export async function polyDesk(wallet, deps = pm) {
  const t0 = Date.now();
  // A failed positions fetch is NOT an empty portfolio — track fetch outcomes apart from emptiness.
  let posOk = true, actOk = true;
  const [posRaw, actRaw] = await Promise.all([
    deps.positions(wallet).catch(() => { posOk = false; return []; }),
    deps.activity(wallet, 40).catch(() => { actOk = false; return []; }),
  ]);
  const positions = Array.isArray(posRaw) ? posRaw : posRaw?.data || [];
  if (!posOk) {
    return { service: 'poly-desk', version: config.version, wallet, verdict: 'DATA_UNAVAILABLE', dataCompleteness: { positionsFetched: false, activityFetched: actOk }, note: 'The Polymarket positions fetch FAILED — this wallet\'s book is UNKNOWN for this call, not empty. Retry.' };
  }
  if (!positions.length) {
    return { service: 'poly-desk', version: config.version, wallet, verdict: 'NO_OPEN_POSITIONS', dataCompleteness: { positionsFetched: true, activityFetched: actOk }, note: 'The positions fetch succeeded and returned zero rows — genuinely no open Polymarket positions for this wallet.' };
  }

  const norm = positions.map((p) => {
    const size = Number(p.size ?? p.shares ?? 0);
    const cur = Number(p.curPrice ?? p.currentPrice ?? p.price ?? 0);
    const avg = Number(p.avgPrice ?? p.averagePrice ?? 0);
    const value = size * cur;
    const cost = size * avg;
    return {
      market: p.title || p.market || p.question || p.slug,
      outcome: p.outcome || p.side,
      shares: round(size, 1),
      avgPriceCents: round(avg * 100, 1),
      curPriceCents: round(cur * 100, 1),
      valueUsd: round(value, 2),
      unrealizedPnlUsd: round(value - cost, 2),
      unrealizedPnlPct: cost > 0 ? round(((value - cost) / cost) * 100, 1) : null,
    };
  }).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

  const totalValue = norm.reduce((a, p) => a + (p.valueUsd || 0), 0);
  const totalPnl = norm.reduce((a, p) => a + (p.unrealizedPnlUsd || 0), 0);
  const movers = [...norm].filter((p) => p.unrealizedPnlPct !== null).sort((a, b) => Math.abs(b.unrealizedPnlPct) - Math.abs(a.unrealizedPnlPct)).slice(0, 3);
  const recent = (Array.isArray(actRaw) ? actRaw : actRaw?.data || []).slice(0, 5).map((a) => ({
    type: a.type || a.side, market: a.title || a.market, usd: round(Number(a.usdcSize ?? a.value ?? 0), 2), ts: a.timestamp,
  }));

  return {
    service: 'poly-desk',
    version: config.version,
    wallet,
    verdict: totalPnl > 0 ? 'IN_PROFIT' : totalPnl < 0 ? 'IN_LOSS' : 'FLAT',
    dataCompleteness: { positionsFetched: true, activityFetched: actOk, ...(actOk ? {} : { note: 'The activity-feed fetch FAILED — recentActivity below is missing data, not evidence of inactivity.' }) },
    summary: {
      openPositions: norm.length,
      bookValueUsd: round(totalValue, 2),
      unrealizedPnlUsd: round(totalPnl, 2),
      unrealizedPnlPct: totalValue - totalPnl > 0 ? round((totalPnl / (totalValue - totalPnl)) * 100, 1) : null,
    },
    positions: norm.slice(0, 20),
    portfolioRisk: polyPortfolioRisk(norm),
    biggestMovers: movers,
    recentActivity: recent,
    method: 'Live Polymarket positions (data-api) marked to current CLOB prices for unrealized PnL and cash-out value; recent activity from the public activity feed.',
    limitations: 'Public positions only; marks are last CLOB price and move with the book. Resolved/closed positions are excluded from the open book. Informational portfolio read, not financial advice.',
    elapsedMs: Date.now() - t0,
  };
}
