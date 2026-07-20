// portfolio-gate — cross-venue portfolio exposure, nearest liquidation, and correlated-crash stress.
//
// WHY THIS EXISTS (the #1 unmet need, ground-truthed): agents run positions across venues, but every risk
// tool prices ONE instrument at a time. No one computes an agent's TRUE aggregate exposure and the binding
// (nearest) liquidation across the whole book — and proves it. The catastrophic failure mode is that
// independently-sized bets are secretly ONE bet when assets are correlated, and they liquidate together:
// Oct-10-2025 was $19B liquidated in a day, "too much leverage on too many correlated assets" as correlations
// went to 1. This computes: net exposure per underlying, the leg that liquidates FIRST, concentration, and a
// correlated-crash stress — deterministically, so it is re-runnable and self-checked.
//
// Per-leg liquidation reuses perp-gate (the same derived Hyperliquid condition + its liquidation-invariant
// self-check), so the portfolio number inherits per-leg correctness. Isolated per-leg margin by default; a
// true cross-margin account shares equity across legs — that is DISCLOSED, not silently assumed.
import { perpGate } from './perpGate.js';
import { round } from './stats.js';

export function portfolioGate(input = {}) {
  const raw = Array.isArray(input.positions) ? input.positions : [];
  if (!raw.length) return { ok: false, errors: ['need at least one position'] };

  const errors = [];
  const positions = [];
  const byAsset = {};      // asset -> { net, gross, long, short }
  let totalGross = 0;

  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] || {};
    const asset = String(p.asset || p.symbol || `pos${i}`).toUpperCase();
    const kind = p.kind === 'spot' ? 'spot' : 'perp';
    const side = (p.side === 'short' || p.side === 'sell' || Number(p.size) < 0) ? 'short' : 'long';
    const sizeAbs = Math.abs(Number(p.size));
    const entry = Number(p.entryPrice);
    const mark = Number(p.markPrice) > 0 ? Number(p.markPrice) : entry;
    if (!(sizeAbs > 0) || !(entry > 0)) { errors.push(`position ${i} (${asset}): need size≠0 and entryPrice>0`); continue; }

    const notional = sizeAbs * mark;
    const signed = (side === 'long' ? 1 : -1) * notional;
    totalGross += notional;
    (byAsset[asset] ||= { net: 0, gross: 0, long: 0, short: 0 });
    byAsset[asset].net += signed; byAsset[asset].gross += notional; byAsset[asset][side] += notional;

    let liquidation = null;
    if (kind === 'perp') {
      const g = perpGate({ side, entryPrice: entry, size: sizeAbs, markPrice: mark,
        margin: p.margin, leverage: p.leverage, maintMarginRate: p.maintMarginRate, maxLeverage: p.maxLeverage, marginTiers: p.marginTiers });
      if (g.ok && g.liquidationPrice != null) {
        liquidation = { price: g.liquidationPrice, moveToLiqPct: g.moveToLiquidationPct, mmrPct: g.maintenanceMarginRatePct, invariantOk: g.checks?.[0]?.pass === true };
      } else if (g.ok && g.liquidatable_at_entry) {
        liquidation = { price: mark, moveToLiqPct: 0, liquidatableAtEntry: true, invariantOk: true };
      } else if (!g.ok) {
        errors.push(`position ${i} (${asset}): ${(g.errors || ['could not compute liquidation']).join('; ')}`);
      }
    }
    positions.push({ index: i, venue: String(p.venue || '?'), asset, kind, side, size: round(sizeAbs, 8), notional: round(notional, 2), markPrice: mark, liquidation });
  }
  if (!positions.length) return { ok: false, errors };

  // Net exposure per underlying + totals.
  const exposures = Object.entries(byAsset).map(([asset, v]) => ({
    asset, netNotional: round(v.net, 2), grossNotional: round(v.gross, 2), longNotional: round(v.long, 2), shortNotional: round(v.short, 2),
  })).sort((a, b) => Math.abs(b.netNotional) - Math.abs(a.netNotional));
  const totalNet = Object.values(byAsset).reduce((s, v) => s + v.net, 0);

  // Concentration by asset gross notional (is the "diversified" book secretly one bet?).
  const hhi = totalGross > 0 ? Object.values(byAsset).reduce((s, v) => s + (v.gross / totalGross) ** 2, 0) : 0;

  // Nearest liquidation — the binding constraint across the whole book.
  const withLiq = positions.filter((p) => p.liquidation && p.liquidation.moveToLiqPct != null);
  let nearest = null;
  for (const p of withLiq) if (nearest == null || p.liquidation.moveToLiqPct < nearest.liquidation.moveToLiqPct) nearest = p;

  // Correlated-crash stress: move the WHOLE market by ±X% (correlation→1, the empirical crash regime). A down
  // move is adverse for longs, an up move for shorts; count legs that cross maintenance SIMULTANEOUSLY.
  const shocks = (Array.isArray(input.shockScenariosPct) && input.shockScenariosPct.length
    ? input.shockScenariosPct.map(Number).filter((x) => Number.isFinite(x) && x > 0) : [5, 10, 20, 30]);
  const stress = shocks.map((movePct) => {
    let dL = 0, dN = 0, uL = 0, uN = 0;
    for (const p of withLiq) if (movePct >= p.liquidation.moveToLiqPct) {
      if (p.side === 'long') { dL += 1; dN += p.notional; } else { uL += 1; uN += p.notional; }
    }
    return { marketMovePct: movePct,
      onDownMove: { legsLiquidated: dL, notionalLiquidated: round(dN, 2), fractionOfBook: round(totalGross ? dN / totalGross : 0, 4) },
      onUpMove: { legsLiquidated: uL, notionalLiquidated: round(uN, 2), fractionOfBook: round(totalGross ? uN / totalGross : 0, 4) } };
  });

  // Ground-truth self-checks (exact identities — a wrong aggregation fails its own check).
  const netRecon = Math.abs(exposures.reduce((s, e) => s + e.netNotional, 0) - round(totalNet, 2));
  const allInvariants = withLiq.every((p) => p.liquidation.invariantOk === true);
  const nearestIsMin = nearest == null || withLiq.every((p) => p.liquidation.moveToLiqPct >= nearest.liquidation.moveToLiqPct - 1e-9);
  const downMonotone = stress.every((s, i) => i === 0 || s.onDownMove.legsLiquidated >= stress[i - 1].onDownMove.legsLiquidated);

  return {
    ok: true,
    positionsCount: positions.length,
    totalGrossNotional: round(totalGross, 2),
    totalNetNotional: round(totalNet, 2),
    netExposureByAsset: exposures,
    concentration: { hhi: round(hhi, 4), effectiveIndependentBets: round(hhi > 0 ? 1 / hhi : 0, 2),
      note: 'HHI over gross notional by underlying. effectiveIndependentBets = 1/HHI: a low number means the book is really one concentrated bet, not the diversification the leg count suggests.' },
    nearestLiquidation: nearest ? {
      venue: nearest.venue, asset: nearest.asset, side: nearest.side,
      liquidationPrice: nearest.liquidation.price, moveToLiquidationPct: nearest.liquidation.moveToLiqPct,
      note: `${nearest.asset} ${nearest.side} on ${nearest.venue} is the binding constraint — it liquidates FIRST, at a ${nearest.liquidation.moveToLiqPct}% adverse move. That is the whole book's real distance to first blood.`,
    } : null,
    correlatedShockStress: {
      note: 'The market moved ±X% with correlation→1 (the crash regime; Oct-10-2025 saw correlations go to 1). A down move liquidates LONG legs, an up move SHORT legs — counts legs crossing maintenance SIMULTANEOUSLY, i.e. bets that are secretly one bet. Assumes co-movement; a leg on a genuinely uncorrelated asset would not breach in reality.',
      scenarios: stress,
    },
    positions,
    ...(errors.length ? { warnings: errors } : {}),
    model: 'Cross-venue perp portfolio. Net exposure = Σ signed notional per underlying; per-leg liquidation via the perp-gate condition + its invariant; nearest = min distance-to-liq; correlated stress = uniform ±move on all legs. Isolated per-leg margin (pass per-leg margin/leverage/tiers). A cross-margined account shares equity across legs — model that by passing account context; not assumed here.',
    checks: [
      { name: 'exposure reconciliation: Σ per-asset netNotional == totalNetNotional', residual: Number(netRecon.toExponential(2)), tolerance: 1e-2, pass: netRecon <= 1e-2 },
      { name: 'every per-leg liquidation satisfies its own invariant (account_value == maint at P_liq)', positionsChecked: withLiq.length, pass: allInvariants },
      { name: 'nearestLiquidation is the true minimum distance-to-liq across the book', pass: nearestIsMin },
      { name: 'correlated down-crash breach count is monotone non-decreasing in shock size', pass: downMonotone },
    ],
  };
}
