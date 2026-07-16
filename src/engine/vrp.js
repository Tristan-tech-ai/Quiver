// VARIANCE RISK PREMIUM (VRP) — the empirically-fitted bridge from RISK-NEUTRAL to REAL-WORLD odds.
//
// Why this exists (the methodological gap it fills): option-implied probabilities (N(d2)) are
// RISK-NEUTRAL — they are the price of insurance, not the real-world chance. Implied vol systematically
// exceeds subsequently-realized vol because option sellers demand compensation for bearing variance risk
// (Bakshi–Kapadia, Carr–Wu). So "the options market implies an 18% chance of a dip" overstates the
// historical frequency. This module estimates that premium FROM DATA we already fetch (Deribit DVOL
// dailies vs subsequently-realized spot vol) and returns a factor that converts implied vol into an
// empirically-calibrated real-world vol.
//
// Model choice is deliberate, not lazy: the (IV_t, RV_{t→t+30}) pairs use OVERLAPPING windows, so the
// ~270 pairs carry only ~9 INDEPENDENT observations. In that data regime a neural net would overfit
// catastrophically and be unverifiable — the correct estimator is a robust, interpretable one. We use the
// MEDIAN ratio (outlier-resistant) as the primary estimate, report the IQR, the hit-rate, an OLS fit for
// transparency, and the effective sample size, so a caller can audit the model rather than trust it.
import { round } from './stats.js';

const DAY = 86400000;
const dayKey = (ts) => Math.floor(ts / DAY);

// Annualized close-to-close realized volatility (%) from a close series.
export function realizedVolPct(closes) {
  if (!closes || closes.length < 8) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  if (rets.length < 6) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(365) * 100;
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// One-sided binomial tail P(X >= k | n, p=0.5) — the honest significance test for the VRP hit-rate,
// evaluated at the EFFECTIVE (non-overlapping) sample size, not the inflated pair count.
function binomTailGE(k, n) {
  if (n <= 0 || k > n) return 1;
  const logC = (n, r) => { let s = 0; for (let i = 0; i < r; i++) s += Math.log(n - i) - Math.log(i + 1); return s; };
  let p = 0;
  for (let i = k; i <= n; i++) p += Math.exp(logC(n, i) + n * Math.log(0.5));
  return Math.min(1, p);
}

// Ordinary least squares y = a + b·x, with R².
function ols(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  const b = sxy / sxx, a = my - b * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  return { intercept: round(a, 2), slope: round(b, 3), r2: round(r * r, 3) };
}

/**
 * Fit the VRP from real history.
 * @param dvolDaily [{ ts, iv }]  Deribit DVOL daily closes (30-day constant-maturity implied vol, %)
 * @param spotSeries [{ ts, c }]  UTC daily spot closes, oldest->newest
 * @param horizonDays              must match DVOL's horizon (30)
 */
export function estimateVrp(dvolDaily, spotSeries, horizonDays = 30) {
  if (!Array.isArray(dvolDaily) || !Array.isArray(spotSeries) || spotSeries.length < horizonDays + 20) return null;
  const idxByDay = new Map();
  spotSeries.forEach((p, i) => idxByDay.set(dayKey(p.ts), i));

  const pairs = [];
  for (const d of dvolDaily) {
    if (!(d.iv > 0)) continue;
    const i = idxByDay.get(dayKey(d.ts));
    if (i == null) continue;
    const win = spotSeries.slice(i, i + horizonDays + 1);
    if (win.length < Math.floor(horizonDays * 0.8)) continue; // need most of the forward window
    const rv = realizedVolPct(win.map((p) => p.c));
    if (rv == null || !(rv > 0)) continue;
    pairs.push({ iv: d.iv, rv, ratio: rv / d.iv });
  }
  if (pairs.length < 40) return null; // too little overlap to say anything honest

  const ratios = pairs.map((p) => p.ratio).sort((a, b) => a - b);
  const median = quantile(ratios, 0.5);
  const hit = pairs.filter((p) => p.rv < p.iv).length / pairs.length;
  const fit = ols(pairs.map((p) => p.iv), pairs.map((p) => p.rv));
  // Guard: a wild estimate means the fit is unusable — clamp and flag rather than silently mis-price.
  const clamped = Math.max(0.45, Math.min(1.25, median));

  // HONEST SIGNIFICANCE: the pairs overlap, so the independent sample is pairs ÷ horizon. Test the
  // hit-rate at THAT n, not the inflated pair count. Reported whether or not it flatters the feature.
  const nEff = Math.max(1, Math.round(pairs.length / horizonDays));
  const hitsEff = Math.round(hit * nEff);
  const pValue = binomTailGE(hitsEff, nEff);
  const significant = pValue < 0.05;
  const iqrLo = quantile(ratios, 0.25), iqrHi = quantile(ratios, 0.75);
  const iqrSpansOne = iqrLo <= 1 && iqrHi >= 1;

  return {
    ratioRvToIv: round(median, 3),
    ratioUsed: round(clamped, 3),
    clamped: Math.abs(clamped - median) > 1e-9,
    iqr: [round(iqrLo, 3), round(iqrHi, 3)],
    impliedExceededRealizedPct: round(hit * 100, 1),
    premiumVolPoints: round(pairs.reduce((a, p) => a + (p.iv - p.rv), 0) / pairs.length, 2),
    sample: {
      pairs: pairs.length,
      effectiveIndependent: nEff,
      horizonDays,
      note: 'Pairs use OVERLAPPING forward windows, so the honest independent sample is pairs ÷ horizon — small. Treated with a robust median, not a fitted curve.',
    },
    significance: {
      test: `one-sided binomial sign test on the hit-rate at the EFFECTIVE sample (${hitsEff}/${nEff}), not the ${pairs.length} overlapping pairs`,
      pValue: round(pValue, 3),
      significantAt05: significant,
      iqrSpansOne,
      verdict: significant && !iqrSpansOne
        ? 'The premium is distinguishable from zero in this window.'
        : 'NOT statistically distinguishable from zero in this window — the point estimate is directionally consistent with the literature, but this sample alone does not establish it.',
    },
    olsFit: fit,
    olsNote: fit && fit.r2 < 0.05 ? `OLS R²=${fit.r2}: the LEVEL of implied vol does not linearly predict the level of realized vol here. The regression is uninformative — which is exactly why a robust median (and not a fitted curve, still less a neural net on ~${nEff} independent points) is the right estimator.` : undefined,
    method: `For each day with a DVOL close (30-day constant-maturity implied vol), the realized vol over the FOLLOWING ${horizonDays} days is computed from UTC daily closes. The variance risk premium is the median of realized ÷ implied across those pairs.`,
    evidenceGrade: 'The EXISTENCE of a variance risk premium is Grade-A literature (Bakshi–Kapadia 2003; Carr–Wu 2009). THIS number is a ~1-year, single-asset point estimate — treat the literature as the prior and this figure as a noisy local reading, not proof.',
    interpretation: median < 1
      ? `Realized volatility came in at a median ${round(median * 100, 1)}% of what options implied${significant ? '' : ', though not significantly so at this sample'}. Options price more movement than this window delivered — but that gap is COMPENSATION FOR TAIL RISK borne by option sellers, not evidence the market is wrong (BIS finds high crypto carry predicts crashes; the same logic applies to variance).`
      : `Realized volatility ran at a median ${round(median * 100, 1)}% of implied — no discount is evident in this window.`,
    notAnEdge: 'This is a MEASUREMENT-MEASURE conversion, not a trading edge. Risk-neutral odds answer "what does insurance cost"; real-world-calibrated odds answer "how often did this historically happen". Neither is a signal, and harvesting the premium is a separate question this does not address — mechanical crypto premia have been compressing (funding carry: ~30%/yr in 2021 → ~0% in 2026).',
    limitations: 'Estimated on the deepest reachable window (~1y of DVOL vs OKX UTC daily closes), on overlapping windows, at DVOL\'s 30-day horizon. Applying the factor scales the LEVEL of implied vol, not the SHAPE of the smile, and assumes the premium is horizon-stable. Published premia decay (McLean & Pontiff 2016: −26% out-of-sample, −58% post-publication) and the VRP is heavily published, so the live premium is plausibly smaller than any historical fit. A historical estimate — regimes change. It is an adjustment, not a forecast.',
  };
}

// Convert an implied vol (decimal) to the empirically-calibrated real-world vol.
export const realWorldVol = (impliedVol, vrp) => (vrp && vrp.ratioUsed > 0 ? impliedVol * vrp.ratioUsed : impliedVol);
