// PolyDesk — one call: a Polymarket wallet's live book — open positions with current marks and
// unrealized PnL, cash-out value, and biggest movers — for copy/portfolio agents tracking a trader.
import * as pm from '../adapters/polymarket.js';
import { config } from '../config.js';
import { round } from './stats.js';

export async function polyDesk(wallet) {
  const t0 = Date.now();
  const [posRaw, actRaw] = await Promise.all([
    pm.positions(wallet).catch(() => []),
    pm.activity(wallet, 40).catch(() => []),
  ]);
  const positions = Array.isArray(posRaw) ? posRaw : posRaw?.data || [];
  if (!positions.length) {
    return { service: 'poly-desk', version: config.version, wallet, verdict: 'NO_OPEN_POSITIONS', note: 'No open Polymarket positions for this wallet.' };
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
    summary: {
      openPositions: norm.length,
      bookValueUsd: round(totalValue, 2),
      unrealizedPnlUsd: round(totalPnl, 2),
      unrealizedPnlPct: totalValue - totalPnl > 0 ? round((totalPnl / (totalValue - totalPnl)) * 100, 1) : null,
    },
    positions: norm.slice(0, 20),
    biggestMovers: movers,
    recentActivity: recent,
    method: 'Live Polymarket positions (data-api) marked to current CLOB prices for unrealized PnL and cash-out value; recent activity from the public activity feed.',
    limitations: 'Public positions only; marks are last CLOB price and move with the book. Resolved/closed positions are excluded from the open book. Informational portfolio read, not financial advice.',
    elapsedMs: Date.now() - t0,
  };
}
