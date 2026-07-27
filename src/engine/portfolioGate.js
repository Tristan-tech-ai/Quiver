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
        liquidation = { price: g.liquidationPrice, moveToLiqPct: g.moveToLiquidationPct, mmrPct: g.maintenanceMarginRatePct, invariantOk: g.checks?.[0]?.pass === true, positionStatus: g.positionStatus, ...(g.statusNote ? { statusNote: g.statusNote } : {}) };
      } else if (g.ok && g.liquidatable_at_entry) {
        // Carry the status through. Without it this leg looked like a live position sitting exactly
        // at 0% from liquidation, won the nearest-liquidation ranking, and was described as the
        // book's distance to first blood. invariantOk is no longer asserted true here: nothing was
        // solved on this branch, so claiming a satisfied invariant counted an unchecked leg as
        // checked in the aggregate self-check below.
        liquidation = { price: mark, moveToLiqPct: 0, liquidatableAtEntry: true, invariantOk: null,
          positionStatus: g.positionStatus || 'BELOW_MAINTENANCE', statusNote: g.statusNote };
      } else if (!g.ok) {
        errors.push(`position ${i} (${asset}): ${(g.errors || ['could not compute liquidation']).join('; ')}`);
      }
    }
    const marginUsed = Number(p.margin) > 0 ? Number(p.margin) : (Number(p.leverage) > 0 ? notional / Number(p.leverage) : null);
    // Cross-margin equity is NOT the margin requirement re-derived at the mark. `marginUsed` above is
    // sized off the mark notional, which silently discards unrealized PnL — so a position 1.7% in
    // profit contributed its mark-sized margin to the pool instead of its posted margin plus the gain.
    // The account's real equity is what was POSTED (at entry) plus what the position has since made or
    // lost, which is also the basis the isolated liquidation is solved from, so the two views agree.
    const marginPosted = Number(p.margin) > 0 ? Number(p.margin)
      : (Number(p.leverage) > 0 ? (sizeAbs * entry) / Number(p.leverage) : null);
    const unrealizedPnlUsd = (side === 'long' ? 1 : -1) * sizeAbs * (mark - entry);
    const equityUsd = marginPosted != null ? marginPosted + unrealizedPnlUsd : null;
    // Venue-reported liquidation price (e.g. Hyperliquid clearinghouseState.liquidationPx) — an EXTERNAL
    // cross-check on our computed number, from a source this engine does not control. For isolated legs the
    // two models coincide and the deviation is a genuine correctness check; for cross legs the venue's price
    // embeds the shared equity pool (compare crossMarginLiquidation instead) — labeled, not force-matched.
    let venueLiquidation = null;
    if (Number(p.venueLiquidationPx) > 0 && mark > 0) {
      const vLiq = Number(p.venueLiquidationPx);
      const impliedMovePct = round(Math.abs(vLiq - mark) / mark * 100, 3);
      venueLiquidation = {
        price: vLiq, impliedMovePct,
        marginMode: p.marginMode === 'isolated' ? 'isolated' : p.marginMode === 'cross' ? 'cross' : null,
        deviationPtsVsComputed: liquidation && liquidation.moveToLiqPct != null ? round(liquidation.moveToLiqPct - impliedMovePct, 3) : null,
      };
    }
    positions.push({ index: i, venue: String(p.venue || '?'), asset, kind, side, size: round(sizeAbs, 8), notional: round(notional, 2), markPrice: mark, marginUsed,
      marginMode: p.marginMode === 'cross' ? 'cross' : p.marginMode === 'isolated' ? 'isolated' : null, ...(equityUsd != null ? { unrealizedPnlUsd: round(unrealizedPnlUsd, 2), equityUsd: round(equityUsd, 2) } : {}), liquidation, ...(venueLiquidation ? { venueLiquidation } : {}) });
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
  // A leg already past its liquidation price is not the book's nearest FUTURE liquidation, it is an
  // event that has happened. Ranking it as nearest made the report narrate a dead leg as the distance to
  // first blood. Already-liquidated legs are therefore separated out and reported as such, and "nearest"
  // means nearest among legs that are still live.
  const breached = withLiq.filter((p) => p.liquidation.positionStatus === 'BELOW_MAINTENANCE');
  const live = withLiq.filter((p) => p.liquidation.positionStatus !== 'BELOW_MAINTENANCE');
  let nearest = null;
  for (const p of live) if (nearest == null || p.liquidation.moveToLiqPct < nearest.liquidation.moveToLiqPct) nearest = p;

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

  // Factor-beta correlated stress (deep methodology): the realistic count between the ρ=1 upper bound and
  // full independence — each asset moves ~beta×the market factor. Beta source, by precedence: explicit
  // caller `betas` > a VALIDATED severity tier via `betaTier` (mild|moderate|severe — cross-event
  // validated, pre-registered) > the default worst-case single-event CRASH_BETAS table.
  const tierName = ['mild', 'moderate', 'severe'].includes(input.betaTier) ? input.betaTier : null;
  const betas = input.betas && typeof input.betas === 'object' ? input.betas
    : tierName ? VALIDATED_BETA_TIERS[tierName].betas : null;
  const betaSource = input.betas && typeof input.betas === 'object' ? 'caller-supplied'
    : tierName ? `validated tier '${tierName}' (${VALIDATED_BETA_TIERS[tierName].btcDdRange} BTC drawdown regime; pre-registered cross-event validation: H1 Spearman ${VALIDATED_BETA_TIERS.provenance.validation.h1MedianSpearman}, H2 relative risk ${VALIDATED_BETA_TIERS.provenance.validation.h2RelativeRisk}× — see betaValidation)`
    : 'worst-case single-event table (Oct-10-2025 cascade wicks) — pass betaTier: mild|moderate|severe for the cross-validated regime estimates';
  const betaStress = factorBetaStress(withLiq, shocks, betas, totalGross);
  const betasUsed = Object.fromEntries(withLiq.map((p) => [p.asset, betaFor(p.asset, betas)]));

  // Cross-margin portfolio liquidation (deep methodology): an isolated per-leg view OVERSTATES risk for a
  // cross-margined account — legs share one equity pool, so a losing leg is buffered by winning legs (and by
  // the pool). Compute the ACCOUNT-level liquidation: the market move at which total equity (pool + Σ leg
  // mark-to-market PnL, beta-scaled) falls to total maintenance margin. Hedged books liquidate MUCH later
  // than their nearest isolated leg — the real diversification an isolated view can't see.
  const perpLegs = positions.filter((p) => p.kind === 'perp' && p.liquidation && p.markPrice > 0);
  // Equity, not margin: a leg can legitimately be underwater, so this tests that equity is KNOWN, not
  // that it is positive. A pool that has already fallen below maintenance is a real state (breach at 0),
  // not a reason to withhold the answer.
  const marginsKnown = perpLegs.length > 0 && perpLegs.every((p) => Number.isFinite(Number(p.equityUsd)));
  const crossMargin = crossMarginLiquidation(perpLegs, input.accountEquityUsd, betas, marginsKnown);

  // What the caller actually told us about margin mode, kept separate from what we assume in its
  // absence. The isolated view is the DEFAULT model, not a fact about the account, and the headline
  // must not speak as though it were one.
  const perpKind = positions.filter((p) => p.kind === 'perp');
  const anyCross = perpKind.some((p) => p.marginMode === 'cross');
  const allIsolated = perpKind.length > 0 && perpKind.every((p) => p.marginMode === 'isolated');

  // Ground-truth self-checks (exact identities — a wrong aggregation fails its own check).
  // Reconciliation compares SUM-OF-ROUNDED (display values) vs ROUNDED-SUM, so its tolerance must carry
  // the rounding budget: each 2dp rounding contributes up to 0.005, so a fixed 1e-2 false-failed on real
  // 5-asset books (caught LIVE, intermittent — marks drift between fetches). A wrong aggregation is off by
  // dollars, not by the cent-scale rounding budget, so the check still catches real defects.
  const netRecon = Math.abs(exposures.reduce((s, e) => s + e.netNotional, 0) - round(totalNet, 2));
  const netReconTol = Math.max(0.01, 0.005 * (exposures.length + 1));
  // Only legs that actually solved a liquidation price have an invariant to satisfy. Counting the
  // others as checked overstated coverage (positionsChecked read 2 when one leg carried no checks at
  // all); counting them as failures would be just as wrong. Both counts are reported.
  const invariantLegs = withLiq.filter((p) => p.liquidation.invariantOk === true || p.liquidation.invariantOk === false);
  const noInvariantLegs = withLiq.length - invariantLegs.length;
  const allInvariants = invariantLegs.every((p) => p.liquidation.invariantOk === true);
  const nearestIsMin = nearest == null || live.every((p) => p.liquidation.moveToLiqPct >= nearest.liquidation.moveToLiqPct - 1e-9);
  const downMonotone = stress.every((s, i) => i === 0 || s.onDownMove.legsLiquidated >= stress[i - 1].onDownMove.legsLiquidated);
  const betaDownMonotone = betaStress.every((s, i) => i === 0 || s.onDownMove.legsLiquidated >= betaStress[i - 1].onDownMove.legsLiquidated);
  // Bound identity: for legs whose beta ≥ 1 (they move at least as much as the market), the beta model must
  // count at least as many breaches as ρ=1 at every shock — else the factor scaling is wrong.
  const betaDominatesForHighBeta = betaStress.every((bs, i) => {
    const hiBetaRho1 = withLiq.filter((p) => p.side === 'long' && betaFor(p.asset, betas) >= 1 && shocks[i] >= p.liquidation.moveToLiqPct).length;
    return bs.onDownMove.legsLiquidated >= hiBetaRho1;
  });
  // Cross-margin must liquidate NO EARLIER than the first long leg would on its own isolated margin: a shared
  // pool + any hedge can only extend survival. minLongIso = the market move at which the nearest long leg hits
  // its isolated liq (its asset-move-to-liq ÷ beta). Account down-liq ≥ that (tol for the 0.25 scan grid).
  const longPerp = positions.filter((p) => p.kind === 'perp' && p.liquidation && p.side === 'long' && p.markPrice > 0);
  const minLongIsoMktMove = longPerp.length ? Math.min(...longPerp.map((p) => p.liquidation.moveToLiqPct / betaFor(p.asset, betas))) : null;
  const crossMarginDominatesIsolated = !crossMargin.available || crossMargin.accountLiquidationDownMovePct == null || minLongIsoMktMove == null || crossMargin.accountLiquidationDownMovePct >= minLongIsoMktMove - 0.5;

  // Venue-liquidation cross-check — the one verifier this engine does NOT control. For ISOLATED legs the
  // venue's reported liquidation price and our isolated computation model the same thing, so a material
  // deviation is a real defect in one of them; the check FAILS beyond 2.5pts. Cross legs are excluded from
  // the pass/fail (the venue price embeds the shared pool — crossMarginLiquidation is the comparable view)
  // but their deviations remain visible per leg. Coverage is disclosed either way.
  const withVenueLiq = positions.filter((p) => p.venueLiquidation && p.venueLiquidation.deviationPtsVsComputed != null);
  const isoVenueLegs = withVenueLiq.filter((p) => p.venueLiquidation.marginMode === 'isolated');
  const crossVenueLegs = withVenueLiq.filter((p) => p.venueLiquidation.marginMode !== 'isolated');
  const venueCheckPass = isoVenueLegs.every((p) => Math.abs(p.venueLiquidation.deviationPtsVsComputed) <= 2.5);

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
      // Every liquidation here is solved under ISOLATED per-leg margin. On a cross-margined account
      // the shared equity pool carries each leg far past its isolated price — on one real five-leg
      // book the isolated view read 3% away while the venue's cross prices sat 240% to 62,000% away.
      // This sentence used to close with an unconditional "that is the whole book's real distance to
      // first blood", which is the one reading a caller must not take on a cross book, and it was
      // asserted most confidently exactly where the model does not apply. It is now conditional on
      // what the caller actually told us the margin mode is, and silence is treated as an assumption
      // rather than as isolated.
      marginModelAssumed: 'isolated per-leg margin',
      note: `${nearest.asset} ${nearest.side} on ${nearest.venue} is the binding constraint among legs that are still live under ISOLATED margin: it liquidates FIRST, at a ${nearest.liquidation.moveToLiqPct}% adverse move.`
        + (breached.length ? ` NOTE: ${breached.length} leg(s) are already PAST their liquidation price and are listed under breachedLegs; they are excluded from this ranking because their liquidation is not a future event.` : '')
        + (anyCross
          ? ' This is NOT the whole book\'s distance to first blood: at least one leg is cross-margined, so the shared equity pool carries it well past this price. Read crossMarginLiquidation for the account-level number, which is the binding one for this book.'
          : allIsolated
            ? " Every leg is declared isolated, so that is the whole book's real distance to first blood."
            : ' Margin mode was not supplied on every leg, so isolated is ASSUMED. If this account is cross-margined the account liquidates much later than this: crossMarginLiquidation is the comparable figure.'),
    } : null,
    // Legs whose mark has already crossed liquidation are reported here rather than ranked as the
    // nearest future event. A caller needs to reconcile these, not protect them.
    ...(breached.length ? { breachedLegs: breached.map((b) => ({ venue: b.venue, asset: b.asset, side: b.side, liquidationPrice: b.liquidation.price, moveToLiquidationPct: b.liquidation.moveToLiqPct, positionStatus: b.liquidation.positionStatus, note: b.liquidation.statusNote })) } : {}),
    correlatedShockStress: {
      note: 'The market moved ±X% with correlation→1 (the crash regime; Oct-10-2025 saw correlations go to 1). A down move liquidates LONG legs, an up move SHORT legs — counts legs crossing maintenance SIMULTANEOUSLY, i.e. bets that are secretly one bet. This is the UPPER BOUND (every asset moves the full market %); betaScaledStress below is the realistic estimate.',
      scenarios: stress,
    },
    crossMarginLiquidation: crossMargin,
    betaScaledStress: {
      model: 'factor-beta',
      betaSource,
      betaValidation: VALIDATED_BETA_TIERS.provenance.validation,
      note: 'A more realistic correlated stress than the ρ=1 bound: each asset moves ~beta×the market factor (proxy BTC=1), so high-beta alts liquidate at a SMALLER market move than majors. Betas were MEASURED from the real Oct-10-2025 crash (Hyperliquid 4h peak→trough, BTC −17.7% anchor; keyless-reproducible) — a first-pass guess table understated alt beta 2-3× and was corrected against the actual prices. These are SEVERE crash-regime betas that INCLUDE liquidation-cascade feedback on thin alt books (ETH 1.5, SOL 2.2, XRP 3.3, meme cohort 4-5; unlisted → 3.5 alt-median prior). For a milder correlated move, pass lower per-asset `betas`.',
      betasUsed,
      scenarios: betaStress,
    },
    positions,
    ...(errors.length ? { warnings: errors } : {}),
    model: 'Cross-venue perp portfolio. Net exposure = Σ signed notional per underlying; per-leg liquidation via the perp-gate condition + its invariant; nearest = min distance-to-liq. THREE stress views: (1) correlatedShockStress = the ρ=1 UPPER BOUND (every asset moves the full market %); (2) betaScaledStress = the realistic count with per-asset betas MEASURED from the Oct-10-2025 crash; (3) crossMarginLiquidation = ACCOUNT-level liquidation for a shared-equity book (hedges/offsets buffer each other — far more forgiving than the isolated per-leg view, which overstates risk on a hedged book). Isolated fields assume per-leg margin; cross-margin uses the pooled equity (accountEquityUsd or Σ per-leg margin).',
    checks: [
      { name: 'exposure reconciliation: Σ per-asset netNotional == totalNetNotional (within the 2dp rounding budget)', residual: Number(netRecon.toExponential(2)), tolerance: netReconTol, pass: netRecon <= netReconTol },
      { name: 'every per-leg liquidation satisfies its own invariant (account_value == maint at P_liq)', positionsChecked: invariantLegs.length, ...(noInvariantLegs ? { positionsWithNoInvariantToCheck: noInvariantLegs, note: 'Legs already liquidatable at entry solve no liquidation price, so there is no invariant to assert for them. They are excluded from this count rather than silently counted as checked.' } : {}), pass: allInvariants },
      { name: 'nearestLiquidation is the true minimum distance-to-liq across the LIVE legs (legs already past liquidation are reported separately, not ranked)', pass: nearestIsMin },
      { name: 'correlated down-crash breach count is monotone non-decreasing in shock size', pass: downMonotone },
      { name: 'factor-beta down-crash breach count is monotone non-decreasing in shock size', pass: betaDownMonotone },
      { name: 'factor-beta model dominates the ρ=1 count restricted to beta≥1 legs (factor scaling consistent)', pass: betaDominatesForHighBeta },
      ...(crossMargin.available ? [{ name: 'cross-margin account liquidation ≥ nearest isolated-leg liquidation (shared pool + hedges only help)', pass: crossMarginDominatesIsolated }] : []),
      ...(withVenueLiq.length ? [{
        name: 'venue liquidation cross-check: computed distance vs the venue\'s own reported liquidationPx (external verifier)',
        pass: venueCheckPass,
        coverage: { isolatedLegsChecked: isoVenueLegs.length, crossLegsExcludedFromPassFail: crossVenueLegs.length, tolerancePts: 2.5 },
        note: crossVenueLegs.length && !isoVenueLegs.length
          ? 'All venue-priced legs are cross-margined: the venue price embeds the shared equity pool, so the isolated computation is not the comparable model (see crossMarginLiquidation); per-leg deviations are reported but not pass/fail.'
          : 'Isolated legs must match the venue within tolerance — a deviation there is a real modeling defect on one side.',
      }] : []),
    ],
  };
}

// ── Factor-beta correlated stress (pure, exported for tests) ─────────────────────────────────────────────
// Crash-regime betas (asset move ÷ market move; market proxy = BTC), MEASURED — not guessed — from the real
// Oct-10-2025 event: Hyperliquid 4h peak→trough over Oct 10–11 (BTC −17.7% = the anchor), coin-by-coin,
// keyless-reproducible (scratchpad crash-replay/measure-betas-hl.mjs + measured-betas.json). A first-pass
// GUESS table (ETH 0.9, SOL 2.6, alts ~2-3) was replaced after measurement showed it understated alt beta
// 2-3× — the "verifier the model does not control" (real prices) correcting an interpolated prior.
// ⚠️ These INCLUDE liquidation-cascade feedback on thin alt books (the reflexive spiral this very stress
// warns about) — they are the SEVERE crash regime, not clean market betas. For a milder correlated move,
// pass lower `betas`.
export const CRASH_BETAS = {
  BTC: 1.0, WBTC: 1.0, XBT: 1.0,
  ETH: 1.5, WETH: 1.5, STETH: 1.5,
  BNB: 2.1, SOL: 2.2, ZEC: 3.1, XRP: 3.3, LTC: 3.6, ADA: 3.8, DOGE: 3.8, LINK: 3.8,
  XPL: 3.9, AVAX: 4.1, POPCAT: 4.1, CRV: 4.3, PUMP: 4.3, ENA: 4.4, LDO: 4.5,
  WIF: 4.6, KBONK: 4.6, PENGU: 4.7, SUI: 4.7, FARTCOIN: 4.9, AI16Z: 5.0,
};
// Unmeasured asset → the median MEASURED alt beta (the Oct-10 alt cohort ran 3.1–5.0). Was 1.9 (a guess);
// raised to a disclosed empirical prior. Callers with a specific view should pass `betas`.
const UNKNOWN_BETA = 3.5;

// ── VALIDATED severity-tiered betas (PRE-REGISTERED cross-event validation, Jul 21 2026) ────────────────
// Measured over ALL 28 stress episodes found in the Reservoir archive window (Jul 2025 → Jul 2026, HL 4h
// candles; episode = rolling-48h BTC peak→trough ≥5%): per-episode beta = asset dd ÷ BTC dd, tier value =
// MEDIAN across CALIBRATION-side episodes only (cutoff 2025-12-31; mild <8% BTC dd: 9 episodes, moderate
// 8-12%: 3, severe ≥12%: 2). Validation was pre-registered BEFORE computing (hypotheses + thresholds in
// QUIVER_MISSION_CONTROL.md), then evaluated strictly out-of-sample on 2026 events: H1 beta
// transportability — median Spearman rank-corr(calibration betas, realized per-episode betas) across five
// ≥8% 2026 episodes = 0.657 ≥ 0.6 PASS; H2 kill-move generality — on the Jun-2026 crash (BTC −17.24%,
// censoring-free victim set: 16,492 Long-liquidated addresses from the full fill stream), accounts flagged
// RED at T-24h were wiped at 25.37% vs 1.78% unflagged = RELATIVE RISK 14.3× ≥ 1.5 PASS, dose-response
// monotone (40.9%/11.6%/3.2%/0.8% by distance band). CRASH_BETAS above remains the single-event WORST-CASE
// wick anchor (default, conservative); these tiers are the cross-validated central estimates per regime.
// Reproduce: reservoir-data/{detect-episodes.mjs, measure-betas-episodes.mjs, gen-h2.mjs} + parquet files.
export const VALIDATED_BETA_TIERS = {
  provenance: {
    method: 'median per-episode beta, calibration side only (cutoff 2025-12-31); episode beta = asset 4h peak→trough dd ÷ BTC dd',
    preRegistered: true,
    validation: { h1MedianSpearman: 0.657, h1Threshold: 0.6, h2RelativeRisk: 14.3, h2Threshold: 1.5, h2Event: 'Jun-2026 crash (BTC −17.24%), out-of-sample, censoring-free victims', h2bRelativeRisk: 13.3, h2bEvent: 'Feb-2026 crash (deepest in archive), second out-of-sample event, pre-registered', PASS: true },
  },
  mild: { episodes: 9, btcDdRange: '5-8%', betas: { BTC: 1, ETH: 1.42, BNB: 1.06, SOL: 1.78, ZEC: 2.29, XRP: 1.52, LTC: 1.3, ADA: 1.72, DOGE: 1.5, LINK: 1.95, AVAX: 1.98, POPCAT: 2.27, CRV: 2.14, PUMP: 2.66, ENA: 2.53, LDO: 2.1, WIF: 2.72, KBONK: 2.58, PENGU: 2.54, SUI: 2.09, FARTCOIN: 3.09, AI16Z: 3.8, HYPE: 1.81 } },
  moderate: { episodes: 3, btcDdRange: '8-12%', betas: { BTC: 1, ETH: 1.39, BNB: 1.78, SOL: 1.71, ZEC: 2.14, XRP: 1.6, LTC: 1.56, ADA: 1.87, DOGE: 1.74, LINK: 2.1, AVAX: 1.94, POPCAT: 3.04, CRV: 1.77, PUMP: 2.42, ENA: 2.03, LDO: 2.39, WIF: 2.22, KBONK: 2.09, PENGU: 2.44, SUI: 2.13, FARTCOIN: 2.71, AI16Z: 2.78, HYPE: 1.63 } },
  severe: { episodes: 2, btcDdRange: '≥12%', betas: { BTC: 1, ETH: 1.31, BNB: 1.53, SOL: 1.62, ZEC: 2.65, XRP: 2.32, LTC: 2.37, ADA: 2.59, DOGE: 2.47, LINK: 2.45, AVAX: 2.74, POPCAT: 2.88, CRV: 2.81, PUMP: 3.07, ENA: 2.95, LDO: 2.94, WIF: 3.15, KBONK: 2.98, PENGU: 3.07, SUI: 3.1, FARTCOIN: 3.76, AI16Z: 5.02, HYPE: 1.75 } },
};

export function betaFor(asset, betas) {
  const a = String(asset || '').toUpperCase();
  if (betas && Number.isFinite(Number(betas[a]))) return Number(betas[a]);
  if (Number.isFinite(CRASH_BETAS[a])) return CRASH_BETAS[a];
  return UNKNOWN_BETA;
}

// Cross-margin ACCOUNT liquidation (pure). Equity(M) = pool + Σ leg PnL at a beta-scaled market move of M%;
// the account liquidates at the smallest M where Equity(M) ≤ total maintenance margin. Down move: longs lose,
// shorts gain (hedges buffer). Returns null-with-reason when per-leg margins are unknown (can't sum a pool).
export function crossMarginLiquidation(perpLegs, accountEquityUsd, betas, marginsKnown) {
  if (!perpLegs.length) return { available: false, note: 'No perp legs with a computed liquidation to aggregate.' };
  const explicitEquity = Number(accountEquityUsd) > 0 ? Number(accountEquityUsd) : null;
  if (explicitEquity == null && !marginsKnown) {
    return { available: false, note: 'Cross-margin liquidation needs the account equity: pass accountEquityUsd, or per-leg margin/leverage on every leg so the shared pool can be summed. Not assumed.' };
  }
  const pool = explicitEquity != null ? explicitEquity : perpLegs.reduce((s, p) => s + Number(p.equityUsd), 0);
  // A leg without a known equity makes the pool NaN, and every comparison against NaN is false — which
  // would have walked the whole scan and returned "survives a 100% move", the most reassuring answer
  // available, from an input that supported no answer at all. Refuse instead, and say which it was.
  if (!Number.isFinite(pool)) {
    return { available: false, note: 'Cross-margin liquidation needs every leg\'s equity (posted margin + unrealized PnL) or an explicit accountEquityUsd. At least one leg had neither, and a pool cannot be part-summed.' };
  }
  const assetMove = (p, M, dir) => (dir === 'down' ? -1 : 1) * betaFor(p.asset, betas) * (M / 100);
  // Equity(M) is piecewise-linear in M; scan finely for the first breach in each direction.
  const equityAt = (M, dir) => pool + perpLegs.reduce((s, p) =>
    s + (p.side === 'long' ? 1 : -1) * p.notional * assetMove(p, M, dir), 0); // long loses on a down move
  // Maintenance is charged on the notional AT THE MOVED PRICE, so it FALLS as the market falls. Holding
  // it fixed at today's notional compared a shrinking equity against a frozen requirement and reported
  // the account liquidating EARLIER than it does — on a one-leg book that contradicted the same engine's
  // own isolated liquidation for the identical position, which is why the self-check below fired.
  const maintAt = (M, dir) => perpLegs.reduce((s, p) =>
    s + ((p.liquidation.mmrPct || 0) / 100) * p.notional * Math.max(0, 1 + assetMove(p, M, dir)), 0);
  const totalMaint = maintAt(0, 'down'); // == the requirement at today's marks
  const breach = (dir) => {
    if (equityAt(0, dir) <= maintAt(0, dir)) return 0;
    for (let M = 0.25; M <= 100; M += 0.25) if (equityAt(M, dir) <= maintAt(M, dir)) return round(M, 2);
    return null; // survives a 100% move in this direction (e.g. a net-flat/over-hedged book)
  };
  const downPct = breach('down'), upPct = breach('up');
  return {
    available: true,
    equitySource: explicitEquity != null ? 'accountEquityUsd (caller)' : 'Σ per-leg (posted margin + unrealized PnL) — pool proxy',
    poolEquityUsd: round(pool, 2),
    totalMaintenanceUsd: round(totalMaint, 2),
    accountLiquidationDownMovePct: downPct,
    accountLiquidationUpMovePct: upPct,
    note: 'ACCOUNT-level (cross-margin) liquidation: the beta-scaled market move at which pooled equity falls to total maintenance margin. Hedged/offsetting legs push this FAR beyond the nearest isolated-leg liquidation — the real cross-margin diversification an isolated view overstates away. null = the book survives a 100% move that way (net-flat or over-hedged). Uses the same measured crash-betas as betaScaledStress.',
  };
}

// For each market shock M, a leg liquidates when beta_asset·M ≥ its distance-to-liquidation. Down move hits
// longs, up move hits shorts (same structure as the ρ=1 model, only the per-asset move is beta-scaled).
export function factorBetaStress(withLiq, shocks, betas, totalGross) {
  return shocks.map((M) => {
    let dL = 0, dN = 0, uL = 0, uN = 0;
    for (const p of withLiq) {
      if (betaFor(p.asset, betas) * M >= p.liquidation.moveToLiqPct) {
        if (p.side === 'long') { dL += 1; dN += p.notional; } else { uL += 1; uN += p.notional; }
      }
    }
    return {
      marketMovePct: M,
      onDownMove: { legsLiquidated: dL, notionalLiquidated: round(dN, 2), fractionOfBook: round(totalGross ? dN / totalGross : 0, 4) },
      onUpMove: { legsLiquidated: uL, notionalLiquidated: round(uN, 2), fractionOfBook: round(totalGross ? uN / totalGross : 0, 4) },
    };
  });
}
