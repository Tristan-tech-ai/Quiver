// treasury-risk — deterministic risk for a stablecoin / on-chain treasury book. The Q3 institutional wedge:
// treasury agents already rebalance stablecoins across chains and venues for yield (49% of institutions use
// stablecoins; 60% of that volume is B2B). Their real risk is not the headline APY — it is CONCENTRATION
// (too much in one issuer/venue/chain), DEPEG (a "dollar" that isn't), and whether the yield covers it.
// This computes those, deterministically, with proofs.
//
// GROUND TRUTH & SELF-CHECKS:
//   • Concentration = Herfindahl–Hirschman index, HHI = Σ wᵢ² (wᵢ = USD share). Range [1/n, 1]; effective
//     number of independent exposures = 1/HHI. Self-checked: HHI == Σ wᵢ² recomputed, and 1/n ≤ HHI ≤ 1.
//   • Depeg mark-loss for asset at price p (peg q): Σ amountᵢ·(q−p)/q over holdings of that asset. Exact;
//     self-checked by independent recomputation on the worst-single-depeg scenario.
//   • Risk-adjusted yield = Σ wᵢ·apyᵢ − annualised expected depeg loss (when depeg probabilities are given).
import { hhi, round } from './stats.js';

export function treasuryRisk(input = {}) {
  const raw = Array.isArray(input.positions) ? input.positions : [];
  const positions = raw.map((p, i) => ({
    label: p.label ? String(p.label) : `pos${i}`,
    asset: (String(p.asset || '').toUpperCase()) || 'UNKNOWN',
    venue: p.venue ? String(p.venue) : '(none)',
    chain: p.chain ? String(p.chain) : '(none)',
    amountUsd: Number(p.amountUsd),
    apyPct: Number(p.apyPct) || 0,
    pegTarget: Number(p.pegTarget) > 0 ? Number(p.pegTarget) : 1,
    depegProbAnnual: Number(p.depegProbAnnual) >= 0 ? Number(p.depegProbAnnual) : null,
  })).filter((p) => p.amountUsd > 0);
  if (!positions.length) return { ok: false, errors: ['need positions: [{asset, amountUsd, apyPct?, venue?, chain?, pegTarget?}]'] };

  const total = positions.reduce((s, p) => s + p.amountUsd, 0);
  const weights = positions.map((p) => p.amountUsd / total);

  const concBy = (key) => {
    const groups = {};
    for (const p of positions) groups[p[key]] = (groups[p[key]] || 0) + p.amountUsd;
    const vals = Object.values(groups);
    const H = hhi(vals);
    const shares = Object.entries(groups)
      .map(([k, v]) => ({ key: k, sharePct: round((100 * v) / total, 2), usd: round(v, 2) }))
      .sort((a, b) => b.usd - a.usd);
    return { hhi: round(H, 4), effectiveExposures: round(1 / H, 2), groups: vals.length, top: shares[0], shares };
  };
  const byAsset = concBy('asset'), byVenue = concBy('venue'), byChain = concBy('chain');

  const limit = Number(input.concentrationLimitPct) > 0 ? Number(input.concentrationLimitPct) : 25;
  const breaches = [];
  for (const [dim, c] of [['asset', byAsset], ['venue', byVenue], ['chain', byChain]]) {
    for (const s of c.shares) if (s.key !== '(none)' && s.sharePct > limit) breaches.push({ dimension: dim, ...s, limitPct: limit });
  }

  const weightedApyPct = positions.reduce((s, p, i) => s + weights[i] * p.apyPct, 0);

  // Depeg stress: explicit scenarios + a worst-single-depeg scan to a floor.
  const depegLoss = (asset, price) => positions.reduce((s, p) => (p.asset === asset ? s + p.amountUsd * (p.pegTarget - price) / p.pegTarget : s), 0);
  const scenarios = (Array.isArray(input.depegScenarios) ? input.depegScenarios : []).map((sc) => {
    const asset = String(sc.asset || '').toUpperCase(), price = Number(sc.price);
    const loss = depegLoss(asset, price);
    return { asset, toPrice: price, portfolioLossUsd: round(loss, 2), portfolioLossPct: round((100 * loss) / total, 3) };
  });
  const floor = Number(input.depegFloor) > 0 ? Number(input.depegFloor) : 0.90;
  const assets = [...new Set(positions.map((p) => p.asset))];
  const perAssetDepeg = assets.map((a) => ({ asset: a, toPrice: floor, lossUsd: round(depegLoss(a, floor), 2), lossPct: round((100 * depegLoss(a, floor)) / total, 3) })).sort((x, y) => y.lossUsd - x.lossUsd);
  const worstSingle = perAssetDepeg[0] || null;

  // ── Correlated depeg stress (the SVB-weekend lesson) ────────────────────────────────────────────────────
  // The worst-single scan above treats depegs as INDEPENDENT. They are not: USDC breaking (Mar-2023) dragged
  // DAI down with it (DAI was USDC-collateralised), so a "diversified" stable book can be one correlated bet.
  const assetWeights = {};
  for (const p of positions) assetWeights[p.asset] = (assetWeights[p.asset] || 0) + p.amountUsd / total;
  const jointLoss = (shocks) => positions.reduce((s, p) => { const pr = shocks[p.asset]; return pr != null ? s + p.amountUsd * (p.pegTarget - pr) / p.pegTarget : s; }, 0);
  // (a) Explicit joint scenarios (real history / caller-supplied), e.g. {name:'SVB weekend', shocks:{USDC:0.88, DAI:0.90}}.
  const correlatedScenarios = (Array.isArray(input.correlatedScenarios) ? input.correlatedScenarios : []).map((sc) => {
    const shocks = sc.shocks && typeof sc.shocks === 'object' ? Object.fromEntries(Object.entries(sc.shocks).map(([k, v]) => [String(k).toUpperCase(), Number(v)])) : {};
    const loss = jointLoss(shocks);
    return { name: String(sc.name || 'correlated'), shocks, portfolioLossUsd: round(loss, 2), portfolioLossPct: round((100 * loss) / total, 3) };
  });
  // (b) Correlated CRASH: every asset depegs to the floor SIMULTANEOUSLY (correlation→1, the systemic regime) —
  //     the honest worst case the independent worst-single hides.
  const crashLoss = jointLoss(Object.fromEntries(assets.map((a) => [a, floor])));
  const correlatedCrash = {
    toPrice: floor, portfolioLossUsd: round(crashLoss, 2), portfolioLossPct: round((100 * crashLoss) / total, 3),
    note: `If ALL stablecoins depeg to ${floor} together (SVB-style systemic contagion, correlation→1), the book loses ${round((100 * crashLoss) / total, 2)}% — vs the worst-SINGLE ${worstSingle ? worstSingle.lossPct : 0}% the independent scan shows. The gap is correlation risk a per-asset view cannot see.`,
  };
  // (c) Correlation-adjusted effective exposures: with a supplied ρ (assetCorrelation:{A:{B:ρ}}), the TRUE
  //     number of independent bets is 1/(wᵀρw) ≤ the naive 1/HHI when assets co-move. Default ρ = identity —
  //     correlations are NOT fabricated; supply them, or read worst-single→crash as the bound.
  const corrIn = input.assetCorrelation && typeof input.assetCorrelation === 'object' ? input.assetCorrelation : null;
  const rho = (a, b) => { if (a === b) return 1; const v = corrIn?.[a]?.[b] ?? corrIn?.[b]?.[a]; return Number.isFinite(Number(v)) ? Number(v) : 0; };
  let wRw = 0; for (const a of assets) for (const b of assets) wRw += (assetWeights[a] || 0) * (assetWeights[b] || 0) * rho(a, b);
  const corrAdjEffExposures = wRw > 0 ? 1 / wRw : null;

  // Annualised expected depeg loss (only over positions that supplied a probability).
  let expectedAnnualDepegUsd = 0, haveProb = false;
  for (const p of positions) if (p.depegProbAnnual != null) { haveProb = true; expectedAnnualDepegUsd += p.depegProbAnnual * p.amountUsd * (p.pegTarget - floor) / p.pegTarget; }
  const riskAdjustedApyPct = haveProb ? weightedApyPct - (100 * expectedAnnualDepegUsd) / total : null;

  // Self-checks.
  const wSum = weights.reduce((a, b) => a + b, 0);
  const assetShares = {}; for (const p of positions) assetShares[p.asset] = (assetShares[p.asset] || 0) + p.amountUsd / total;
  const hhiRecompute = Object.values(assetShares).reduce((s, w) => s + w * w, 0);
  const hhiRes = Math.abs(hhiRecompute - byAsset.hhi);
  const boundsOk = byAsset.hhi >= 1 / byAsset.groups - 1e-9 && byAsset.hhi <= 1 + 1e-9;
  // Depeg identity on the worst single: recompute independently.
  let depegRes = 0;
  if (worstSingle) {
    let indep = 0; for (const p of positions) if (p.asset === worstSingle.asset) indep += p.amountUsd * (p.pegTarget - floor) / p.pegTarget;
    depegRes = Math.abs(round(indep, 2) - worstSingle.lossUsd);
  }

  return {
    ok: true,
    totalUsd: round(total, 2),
    concentration: { byAsset, byVenue, byChain, limitPct: limit, breaches },
    weightedApyPct: round(weightedApyPct, 3),
    depegStress: {
      scenarios, perAssetToFloor: perAssetDepeg, floor, worstSingle,
      correlated: {
        scenarios: correlatedScenarios, crash: correlatedCrash,
        correlationAdjustedEffectiveExposures: corrAdjEffExposures != null ? round(corrAdjEffExposures, 2) : null,
        naiveEffectiveExposures: byAsset.effectiveExposures,
        note: corrIn ? 'Effective independent bets adjusted for the supplied asset correlations (< 1/HHI when assets co-move — the diversification you actually have).' : 'No asset-correlation matrix supplied → correlation-adjusted exposures equal the independent 1/HHI. The correlated-crash figure is the correlation→1 bound; the true loss sits between worst-single and crash.',
      },
    },
    expectedAnnualDepegLossUsd: haveProb ? round(expectedAnnualDepegUsd, 2) : null,
    riskAdjustedApyPct: riskAdjustedApyPct != null ? round(riskAdjustedApyPct, 3) : null,
    verdict: breaches.length
      ? `${breaches.length} concentration breach(es) over ${limit}% — e.g. ${breaches[0].sharePct}% in ${breaches[0].key} (${breaches[0].dimension}). Diversify issuer/venue/chain before adding size.`
      : `No single exposure exceeds ${limit}%. Worst single-depeg (to ${floor}) costs ${worstSingle ? worstSingle.lossPct : 0}% of the book.`,
    model: 'Concentration = HHI over USD shares; depeg loss = Σ amount·(peg−price)/peg; risk-adjusted yield subtracts annualised expected depeg loss where probabilities are supplied. Deterministic; no market data fetched.',
    checks: [
      { name: 'weights sum to 1', residual: Number(Math.abs(wSum - 1).toExponential(2)), pass: Math.abs(wSum - 1) <= 1e-12 },
      { name: 'HHI(asset) == Σ wᵢ² and 1/n ≤ HHI ≤ 1', residual: Number(hhiRes.toExponential(2)), pass: hhiRes <= 1e-9 && boundsOk },
      { name: 'depeg-loss identity on worst-single (independent recompute)', residual: Number(depegRes.toExponential(2)), pass: depegRes <= 1e-6 },
      { name: 'correlated-crash loss == Σ per-asset floor losses (joint-loss identity)', residual: Number(Math.abs(crashLoss - assets.reduce((s, a) => s + depegLoss(a, floor), 0)).toExponential(2)), pass: Math.abs(crashLoss - assets.reduce((s, a) => s + depegLoss(a, floor), 0)) <= 1e-6 * Math.max(1, total) },
      { name: 'correlation-adjusted effective exposures == 1/HHI when no ρ supplied (identity)', pass: corrIn != null || corrAdjEffExposures == null || Math.abs(corrAdjEffExposures - byAsset.effectiveExposures) <= 1e-6 * Math.max(1, byAsset.effectiveExposures) },
    ],
  };
}
