// COMPOSITE VERDICT — the quantitative fusion the desk actually wants: one continuous score per axis
// (volatility richness, directional tilt) from independently-computed signals, with the FORMULA, the
// weights, every component's raw value→score mapping, leave-one-out sensitivity, and identity self-checks
// returned in the response. This is deliberately NOT another vote count (marketConsensus already does
// that): scores are continuous, weights are disclosed literals, missing components renormalize (and say
// so), and the block refuses to emit a verdict from fewer than 2 components rather than dressing one
// signal up as a consensus.
//
// Two correctness details that make this defensible rather than decorative:
//  1. RND price-space skewness has a POSITIVE lognormal baseline (≈3σ√T for small σ√T) — a symmetric-in-
//     log-returns market still shows positive price skew. The direction component therefore scores the
//     EXCESS of the measured RND skew over the lognormal baseline at ATM vol, not the raw number.
//  2. When a variance-risk-premium fit exists, "IV vs realized" is measured against the asset's own
//     HABITUAL premium (current IV/RV × median RV/IV), not against 1.0 — IV exceeding RV is the norm,
//     not a signal; the signal is exceeding it by more than usual.
// Everything is descriptive market structure. No advice, no sizing of anyone's trade.
import { round } from './stats.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Disclosed literals — weights are relative importances renormalized over AVAILABLE components.
export const VOL_WEIGHTS = { 'iv-rank': 1.0, 'iv-vs-realized': 1.0, 'term-structure': 0.75, 'dealer-gamma': 0.5 };
export const DIR_WEIGHTS = { '25d-skew': 1.0, 'rnd-excess-skew': 1.0, 'put-call-oi': 0.75, 'flow-premium': 0.5 };
export const BAND_THRESHOLDS = { neutral: 0.15, clear: 0.45 }; // |score| < neutral → NEUTRAL; ≥ clear → CLEAR

// Slice selection for the vol axis: sub-2-day ATM IV is microstructure-dominated (and every day before
// Deribit's 08:00 UTC daily expiry the front slice IS sub-1-day), so the composite's "front" is the first
// expiry with ≥2 days to run; "back" is the ≥14d slice nearest 30d. Falls back to the true front only when
// nothing ≥2d exists — and the component value strings always print the daysOut actually used.
export function pickTermSlices(slices) {
  const ok = (slices || []).filter((s) => s && s.atmIvPct > 0 && Number.isFinite(s.daysOut));
  if (!ok.length) return { front: null, back: null };
  const front = ok.find((s) => s.daysOut >= 2) || ok[0];
  const back = ok.filter((s) => s.daysOut >= 14 && s.daysOut > front.daysOut)
    .sort((a, b) => Math.abs(a.daysOut - 30) - Math.abs(b.daysOut - 30))[0] || null;
  return { front, back };
}

// Lognormal price-space skewness for total vol w = (σ√T)²: (e^w + 2)·√(e^w − 1).
export function lognormalSkewBaseline(sigmaSqrtT) {
  if (!(sigmaSqrtT > 0)) return null;
  const ew = Math.exp(sigmaSqrtT * sigmaSqrtT);
  return (ew + 2) * Math.sqrt(ew - 1);
}

// Weighted mean over available components, weights renormalized to sum 1. Pure; the self-check re-derives it.
export function fuse(components, weights) {
  const avail = components.filter((c) => c.score != null && Number.isFinite(c.score));
  if (avail.length < 2) return null; // one signal is not a composite — refuse rather than fabricate
  const wSum = avail.reduce((s, c) => s + weights[c.name], 0);
  const score = avail.reduce((s, c) => s + weights[c.name] * c.score, 0) / wSum;
  return {
    score,
    components: avail.map((c) => ({ ...c, weight: round(weights[c.name] / wSum, 4) })),
    missing: components.filter((c) => c.score == null).map((c) => ({ name: c.name, reason: c.reason || 'input unavailable' })),
  };
}

export function bandFor(score, kind) {
  const a = Math.abs(score);
  if (a < BAND_THRESHOLDS.neutral) return kind === 'vol' ? 'NEUTRAL' : 'BALANCED';
  const lean = a < BAND_THRESHOLDS.clear;
  if (kind === 'vol') return score > 0 ? (lean ? 'LEAN_RICH' : 'RICH') : (lean ? 'LEAN_CHEAP' : 'CHEAP');
  return score > 0 ? (lean ? 'LEAN_UPSIDE' : 'UPSIDE_PRICED') : (lean ? 'LEAN_DOWNSIDE' : 'DOWNSIDE_PRICED');
}

// Conviction = share of non-abstaining components agreeing with the composite's sign.
export function convictionOf(score, components) {
  const voters = components.filter((c) => Math.abs(c.score) >= 0.05); // |s|<0.05 abstains
  if (!voters.length || Math.abs(score) < 1e-12) return { agreeShare: null, label: 'low' };
  const agree = voters.filter((c) => Math.sign(c.score) === Math.sign(score)).length / voters.length;
  return { agreeShare: round(agree, 2), label: agree >= 0.75 && voters.length >= 3 ? 'high' : agree >= 0.6 ? 'moderate' : 'low' };
}

// Leave-one-out: which single component, if dropped, flips the BAND? Those are pivotal — the verdict
// hangs on them, and saying so out loud is the honest form of confidence.
export function leaveOneOut(components, weights, kind) {
  const pivotal = [];
  const full = fuse(components, weights);
  if (!full) return pivotal;
  const fullBand = bandFor(full.score, kind);
  for (const drop of full.components) {
    const rest = full.components.filter((c) => c.name !== drop.name);
    const sub = fuse(rest, weights);
    const band = sub ? bandFor(sub.score, kind) : 'UNAVAILABLE';
    if (band !== fullBand) pivotal.push({ name: drop.name, bandWithoutIt: band });
  }
  return pivotal;
}

function axisBlock(components, weights, kind, formula) {
  const fused = fuse(components, weights);
  if (!fused) {
    return { available: false, reason: `fewer than 2 independent signals available — a composite from ${components.filter((c) => c.score != null).length} component(s) would be a costume, not a fusion`, missing: components.filter((c) => c.score == null).map((c) => ({ name: c.name, reason: c.reason || 'input unavailable' })) };
  }
  const score = round(fused.score, 4);
  const band = bandFor(fused.score, kind);
  const conviction = convictionOf(fused.score, fused.components);
  const pivotal = leaveOneOut(components, weights, kind);
  const comps = fused.components.map((c) => ({ name: c.name, value: c.value, score: round(c.score, 4), weight: c.weight, note: c.note }));
  // Identity self-checks — each re-derives the headline number from the returned parts and CAN fail.
  const recomputed = comps.reduce((s, c) => s + c.weight * c.score, 0);
  const wSum = comps.reduce((s, c) => s + c.weight, 0);
  const selfChecks = [
    { name: 'score = Σ weightᵢ·scoreᵢ over returned components (weights renormalized)', pass: Math.abs(recomputed - score) < 1e-3, recomputed: round(recomputed, 4) },
    { name: 'renormalized weights sum to 1', pass: Math.abs(wSum - 1) < 1e-3, sum: round(wSum, 4) },
    { name: 'band matches disclosed thresholds given the returned score', pass: bandFor(score, kind) === band },
    { name: 'every component score within [-1, 1]', pass: comps.every((c) => c.score >= -1 - 1e-9 && c.score <= 1 + 1e-9) },
  ];
  return { available: true, score, band, conviction, components: comps, pivotalComponents: pivotal, missing: fused.missing, formula, selfChecks };
}

// inputs — every field nullable; absent inputs become disclosed missing components, never guesses.
//  ivPercentile (0..100, deepest DVOL window) · frontIvPct/rv30Pct (%) · vrpRatio (median RV/IV) ·
//  vrpSignificant (bool) · termFront/termBack ({daysOut, atmIvPct}) · dealerGammaRegime ·
//  skew25dRR (vol pts) + atmIvForSkew (%) · rndSkew + rndSigmaSqrtT (certified RND only) ·
//  putCallOiRatio (putOi/callOi) · flowPutSharePct (0..100).
export function compositeVerdict(inputs) {
  const i = inputs || {};
  const ivTag = i.frontIvDaysOut != null ? `IV@${i.frontIvDaysOut}d` : 'IV';
  const volComponents = [
    i.ivPercentile != null
      ? { name: 'iv-rank', value: `${i.ivPercentile}th pctile`, score: clamp((i.ivPercentile / 100) * 2 - 1, -1, 1), note: 'score = 2·percentile − 1 over the deepest DVOL window' }
      : { name: 'iv-rank', score: null, reason: 'no DVOL history for this asset' },
    i.frontIvPct > 0 && i.rv30Pct > 0
      ? (i.vrpRatio > 0
        ? { name: 'iv-vs-realized', value: `${ivTag}/RV30 ${round(i.frontIvPct / i.rv30Pct, 2)} vs habitual ${round(1 / i.vrpRatio, 2)}`, score: clamp(Math.log((i.frontIvPct / i.rv30Pct) * i.vrpRatio) / Math.log(1.5), -1, 1), note: `score = ln((IV/RV)·vrpRatio)/ln(1.5) — premium vs this asset's OWN habitual premium${i.vrpSignificant === false ? ' (habitual-premium fit NOT statistically significant — see vrpModel)' : ''}` }
        : { name: 'iv-vs-realized', value: `${ivTag}/RV30 ${round(i.frontIvPct / i.rv30Pct, 2)}`, score: clamp(Math.log(i.frontIvPct / i.rv30Pct) / Math.log(1.5), -1, 1), note: 'score = ln(IV/RV)/ln(1.5) — no VRP fit, so measured against parity (disclosed limitation: IV>RV is the norm)' })
      : { name: 'iv-vs-realized', score: null, reason: 'front IV or 30d realized vol unavailable' },
    i.termFront?.atmIvPct > 0 && i.termBack?.atmIvPct > 0 && i.termBack.daysOut > i.termFront.daysOut
      ? { name: 'term-structure', value: `${i.termFront.atmIvPct}% @${i.termFront.daysOut}d vs ${i.termBack.atmIvPct}% @${i.termBack.daysOut}d`, score: clamp(-((i.termBack.atmIvPct - i.termFront.atmIvPct) / i.termFront.atmIvPct) / 0.15, -1, 1), note: 'score = −slope/0.15; backwardation (front above back) reads stressed/front-rich → positive' }
      : { name: 'term-structure', score: null, reason: 'need two expiries with ATM IV (front + ~1 month)' },
    i.dealerGammaRegime === 'DEALER_LONG_GAMMA' || i.dealerGammaRegime === 'DEALER_SHORT_GAMMA'
      ? { name: 'dealer-gamma', value: i.dealerGammaRegime, score: i.dealerGammaRegime === 'DEALER_LONG_GAMMA' ? 0.5 : -0.5, note: 'long dealer gamma suppresses realized vol (hedging dampens) → current IV richer vs what will realize; capped ±0.5 — a labeled dealer-positioning convention, not observed flow' }
      : { name: 'dealer-gamma', score: null, reason: 'no GEX regime' },
  ];

  const baseline = lognormalSkewBaseline(i.rndSigmaSqrtT);
  const dirComponents = [
    i.skew25dRR != null && i.atmIvForSkew > 0
      ? { name: '25d-skew', value: `RR ${i.skew25dRR} vol pts (ATM ${i.atmIvForSkew}%)`, score: clamp(i.skew25dRR / (0.10 * i.atmIvForSkew), -1, 1), note: 'score = RR25 / (10% of ATM IV); puts richer than calls → negative (downside paid up)' }
      : { name: '25d-skew', score: null, reason: '25Δ risk-reversal unavailable' },
    i.rndSkew != null && baseline != null
      ? { name: 'rnd-excess-skew', value: `RND skew ${round(i.rndSkew, 3)} vs lognormal baseline ${round(baseline, 3)}`, score: clamp((i.rndSkew - baseline) / 0.5, -1, 1), note: 'score = (RND price-skew − lognormal baseline (e^w+2)√(e^w−1), w=(σ√T)²)/0.5 — a symmetric-in-log market scores 0; certified arbitrage-free density only' }
      : { name: 'rnd-excess-skew', score: null, reason: 'no certified risk-neutral density on the front slice' },
    i.putCallOiRatio != null
      ? { name: 'put-call-oi', value: `P/C OI ${i.putCallOiRatio}`, score: clamp((1 - i.putCallOiRatio) / 0.5, -1, 1), note: 'score = (1 − putOi/callOi)/0.5; put-heavy OI read as hedging demand — a labeled convention (OI is positioning, not signed flow)' }
      : { name: 'put-call-oi', score: null, reason: 'open interest unavailable' },
    i.flowPutSharePct != null
      ? { name: 'flow-premium', value: `put share ${i.flowPutSharePct}% of premium`, score: clamp((50 - i.flowPutSharePct) / 30, -1, 1), note: 'score = (50 − put premium share)/30 over recent trades; direction-free premium split (block-trade direction is unreliable on the public feed)' }
      : { name: 'flow-premium', score: null, reason: 'no recent trade flow' },
  ];

  const volatility = axisBlock(volComponents, VOL_WEIGHTS, 'vol',
    'volScore = Σ wᵢ·sᵢ / Σ wᵢ over available components; w = {iv-rank 1.0, iv-vs-realized 1.0, term-structure 0.75, dealer-gamma 0.5}');
  const direction = axisBlock(dirComponents, DIR_WEIGHTS, 'dir',
    'dirScore = Σ wᵢ·sᵢ / Σ wᵢ over available components; w = {25d-skew 1.0, rnd-excess-skew 1.0, put-call-oi 0.75, flow-premium 0.5}');

  // Descriptive carry metric: annualized variance premium, the payoff scale of a variance swap.
  const carry = (i.frontIvPct > 0 && i.rv30Pct > 0) ? {
    ivMinusRv30VolPts: round(i.frontIvPct - i.rv30Pct, 1),
    variancePremiumPts2: round(i.frontIvPct ** 2 - i.rv30Pct ** 2, 0),
    note: 'σ_imp² − σ_real,30d² in annualized vol-points² — the scale of a variance-swap payoff if FUTURE realized matched the trailing 30d (it will not, exactly; this is the premium on offer, not a forecast).',
  } : null;

  return {
    volatility, direction, carry,
    thresholds: { ...BAND_THRESHOLDS, bands: '|score| < neutral → NEUTRAL/BALANCED; < clear → LEAN_*; ≥ clear → full band' },
    note: 'Continuous-score fusion of independently-computed signals with disclosed weights and per-component formulas. Weights renormalize over available components (missing listed, never guessed); an axis with <2 signals refuses to emit a verdict. pivotalComponents lists any single signal whose removal flips the band — the verdict hangs on those. Identity self-checks re-derive the score from the returned parts. Descriptive market structure, not advice.',
  };
}
