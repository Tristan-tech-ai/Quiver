// perp-gate — deterministic perpetual-futures liquidation & funding risk for autonomous agents.
//
// WHY THIS EXISTS: LLM agents cannot reliably compute liquidation distance, and they trade perps with
// leverage. GPT-5 lost 62% of capital trading perps autonomously (ground truth, 2026). An agent that
// knew its true liquidation price and funding drag before sizing would not have. This returns that number
// deterministically, with a self-check that proves it correct.
//
// GROUND TRUTH — Hyperliquid docs, verified 2026-07-18 from the PRIMARY source (not a search summary):
//   • Liquidation CONDITION (verbatim): a position is liquidated when account value (incl. unrealized PnL)
//     is < maintenance_margin. maintenance_margin = notional * maint_rate  (base tier; the per-tier
//     maintenance_deduction that keeps margin continuous across tiers is 0 at the first tier).
//   • maint_rate is HALF the initial-margin rate at max leverage  =>  maint_rate = 0.5 / maxLeverage.
//     (BTC max lev is 40x => maint_rate 1.25%. A search summary claimed 50x/1% — WRONG, primary docs say 40x.)
//   • Initial margin requirement = notional / leverage.
//   • Isolated liquidation uses ONLY that position's margin and notional (docs, verbatim). Cross uses
//     account-wide equity, which needs the whole account — out of scope for v0; this engine is ISOLATED.
//
// The docs give the CONDITION, not a closed-form price. We DERIVE the price from the condition and then
// VERIFY the derivation numerically against that same condition (the `liquidation-invariant` self-check),
// so a wrong derivation FAILS LOUDLY instead of shipping a confident wrong number. Verified by hand:
// BTC-40x long entry 100k/1BTC/margin2500 -> liq 98734.18 (move 1.27%), invariant residual ~1e-11.
//
//   account_value(P) = M + side*q*(P - P0)        // M = isolated margin, q = size (base), P0 = entry
//   maint_margin(P)  = q * P * mmr
//   liquidation when equal  =>  P_liq = (side*q*P0 - M) / (q*(side - mmr))
//     long : (P0 - M/q) / (1 - mmr)      short : (P0 + M/q) / (1 + mmr)
import { round } from './stats.js';

const sideSign = (s) => (s === 'short' || s === 'sell' || s === -1 || s === '-1' ? -1 : 1);

/**
 * @param p.side            'long'|'short' (default long)
 * @param p.entryPrice      entry / average price (required)
 * @param p.size            position size in BASE units (e.g. BTC). OR pass notional.
 * @param p.notional        position notional in quote (USD). Used to derive size if size absent.
 * @param p.margin          isolated margin posted (quote). OR pass leverage to derive it.
 * @param p.leverage        used to derive margin = notional/leverage if margin absent.
 * @param p.maintMarginRate maintenance margin rate (e.g. 0.0125). OR pass maxLeverage to derive it.
 * @param p.maxLeverage     venue max leverage for the asset; mmr derived as 0.5/maxLeverage.
 * @param p.markPrice       current mark price (optional) — distance-to-liq measured from here, else entry.
 * @param p.fundingRateHourly hourly funding rate (optional; Hyperliquid funds HOURLY). No default — we do
 *                            not fabricate a live rate; funding is only projected when a rate is supplied.
 * @param p.horizonHours    funding projection horizon (default 8).
 */
export function perpGate(p = {}, { eps = 1e-6 } = {}) {
  const errors = [];
  const s = sideSign(p.side);
  const P0 = Number(p.entryPrice);
  if (!(P0 > 0)) errors.push('entryPrice must be > 0');

  let q = p.size != null ? Number(p.size) : (p.notional != null && P0 > 0 ? Number(p.notional) / P0 : NaN);
  if (!(q > 0)) errors.push('need size > 0 (base units) or notional > 0');

  const notionalEntry = q * P0;
  let M = p.margin != null ? Number(p.margin)
        : (Number(p.leverage) > 0 ? notionalEntry / Number(p.leverage) : NaN);
  if (!(M > 0)) errors.push('need margin > 0 or leverage > 0');

  // Maintenance margin rate. Priority: explicit maintMarginRate > NOTIONAL-TIERED maxLeverage > flat maxLeverage.
  // Hyperliquid (verified live from `meta.marginTables`) tiers the maintenance rate by notional: marginTiers =
  // [{lowerBound, maxLeverage}] ascending, applicable tier = the highest lowerBound ≤ position notional. A larger
  // position falls into a LOWER-max-leverage tier ⇒ HIGHER mmr ⇒ liquidation is CLOSER. Using the headline
  // (tier-0) leverage for a big position UNDERSTATES its liquidation risk — the exact positions this exists to
  // protect. (e.g. BTC: 40× to $150M notional, then 20× above → mmr 1.25% → 2.5%.)
  let mmr = NaN, tier = null;
  const tiers = Array.isArray(p.marginTiers)
    ? p.marginTiers.map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: Number(t.maxLeverage) }))
        .filter((t) => t.maxLeverage > 0 && Number.isFinite(t.lowerBound)).sort((a, b) => a.lowerBound - b.lowerBound)
    : null;
  if (p.maintMarginRate != null) {
    mmr = Number(p.maintMarginRate);
  } else if (tiers && tiers.length) {
    let sel = tiers[0];
    for (const t of tiers) if (notionalEntry >= t.lowerBound) sel = t;   // highest lowerBound ≤ notional
    mmr = 0.5 / sel.maxLeverage;
    tier = { appliedMaxLeverage: sel.maxLeverage, tierLowerBound: sel.lowerBound, baseMaxLeverage: tiers[0].maxLeverage, tierCount: tiers.length };
  } else if (Number(p.maxLeverage) > 0) {
    mmr = 0.5 / Number(p.maxLeverage);
  }
  if (!(mmr > 0 && mmr < 1)) errors.push('need maintMarginRate in (0,1), or maxLeverage > 0, or marginTiers');

  // margin cannot exceed notional-implied bounds sanity: initial margin >= maintenance requirement
  if (errors.length) return { ok: false, errors };

  // Effective leverage implied by the posted margin, and whether it already breaches maintenance.
  const effLeverage = notionalEntry / M;
  const initialMarginRate = M / notionalEntry;             // = 1/effLeverage
  if (initialMarginRate <= mmr) {
    // Posted margin is at/below maintenance — position is already liquidatable at entry.
    return {
      ok: true, liquidatable_at_entry: true,
      note: `Posted margin (${round(initialMarginRate * 100, 3)}% of notional) is at or below the maintenance requirement (${round(mmr * 100, 3)}%). Position is liquidatable immediately — reduce size or add margin.`,
      inputs: { side: s === 1 ? 'long' : 'short', entryPrice: P0, size: q, margin: M, mmr },
      effLeverage: round(effLeverage, 2),
    };
  }

  // Derived liquidation price (unified form), then the invariant self-check.
  const pLiq = (s * q * P0 - M) / (q * (s - mmr));
  const av = M + s * q * (pLiq - P0);      // account value at pLiq
  const mm = q * pLiq * mmr;               // maintenance margin at pLiq
  const residual = Math.abs(av - mm);
  const invariantOk = residual <= eps * Math.max(1, notionalEntry);

  const ref = Number(p.markPrice) > 0 ? Number(p.markPrice) : P0;
  // % ADVERSE move from ref to liquidation (positive = how far price must move against you).
  const moveToLiqPct = s === 1 ? ((ref - pLiq) / ref) * 100 : ((pLiq - ref) / ref) * 100;

  let funding = null;
  if (p.fundingRateHourly != null && Number.isFinite(Number(p.fundingRateHourly))) {
    const h = Number(p.horizonHours) > 0 ? Number(p.horizonHours) : 8;
    const rate = Number(p.fundingRateHourly);
    const notionalRef = q * ref;
    // Hyperliquid: funding accrues HOURLY. When perp > spot, rate > 0 and LONGS PAY shorts.
    // Cost to THIS side over the horizon (positive = you pay, negative = you receive):
    const cost = s * rate * notionalRef * h;
    funding = {
      rateHourly: rate, horizonHours: h,
      costOverHorizon: round(cost, 2),
      costPctOfMargin: round((cost / M) * 100, 3),
      note: 'Hyperliquid funds hourly. rate>0 => longs pay shorts. cost>0 = this side pays.',
    };
  }

  return {
    ok: true,
    inputs: { side: s === 1 ? 'long' : 'short', entryPrice: P0, size: round(q, 8), notionalEntry: round(notionalEntry, 2), margin: round(M, 2), maintMarginRate: mmr, markPrice: ref },
    liquidationPrice: round(pLiq, 2),
    moveToLiquidationPct: round(moveToLiqPct, 3),
    // A negative distance is not a small distance: the mark has already passed the liquidation price,
    // so the event the number describes is in the past. An adversarial live test found this reported as
    // a plain negative percentage with no flag, which portfolio-gate then narrated as the book's nearest
    // FUTURE liquidation. Naming the state explicitly is the difference between a caller de-risking a
    // live position and a caller acting on one that is already gone.
    positionStatus: moveToLiqPct < 0 ? 'BELOW_MAINTENANCE' : 'ABOVE_MAINTENANCE',
    ...(moveToLiqPct < 0 ? {
      statusNote: `The mark (${round(ref, 2)}) is already beyond the liquidation price (${round(pLiq, 2)}). moveToLiquidationPct is negative because the threshold has been crossed, not because liquidation is near: on the venue this position is at or past liquidation now. Treat it as a position to reconcile, not one to protect.`,
    } : {}),
    effectiveLeverage: round(effLeverage, 2),
    initialMarginRatePct: round(initialMarginRate * 100, 3),
    maintenanceMarginRatePct: round(mmr * 100, 3),
    marginTier: tier ? {
      appliedMaxLeverage: tier.appliedMaxLeverage, baseMaxLeverage: tier.baseMaxLeverage,
      tierLowerBound: tier.tierLowerBound, tierCount: tier.tierCount,
      note: tier.appliedMaxLeverage < tier.baseMaxLeverage
        ? `Position notional (${round(notionalEntry, 0)}) falls in a tiered-DOWN bracket: max leverage ${tier.appliedMaxLeverage}× (base ${tier.baseMaxLeverage}×) ⇒ mmr ${round(mmr * 100, 3)}% ⇒ liquidation is CLOSER than the headline tier implies.`
        : `Base tier (max leverage ${tier.appliedMaxLeverage}×).`,
    } : null,
    funding,
    model: 'Isolated margin; notional-TIERED maintenance rate (Hyperliquid marginTables). Liquidation from the Hyperliquid condition. Excludes accrued fees; funding shown separately. Cross-margin / cross-venue portfolio liquidation → use portfolio-gate.',
    checks: [{
      name: 'liquidation-invariant: account_value(P_liq) == maintenance_margin(P_liq)',
      residual: Number(residual.toExponential(2)),
      tolerance: Number((eps * Math.max(1, notionalEntry)).toExponential(2)),
      pass: invariantOk,
    }],
  };
}
