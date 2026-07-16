// Black-76 (options on a forward/future) — analytic greeks + IV, pure JS.
// Deribit crypto options are quoted on the forward, so Black-76 is the correct model.
// Validated against Deribit's own ticker greeks (see options-desk validation).

// Standard normal PDF and CDF (Abramowitz-Stegun 7.1.26 erf approximation).
const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.319381530 * t - 0.356563782 * t * t + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5;
  const p = 1 - npdf(x) * d;
  return x >= 0 ? p : 1 - p;
}

// F=forward, K=strike, T=years, sigma=vol (decimal, e.g. 0.65), type='call'|'put'.
// r = continuously-compounded discount rate (default 0 = the classic Deribit convention).
// With r, price/delta/gamma/vega carry the e^{-rT} discount factor and theta gains the r*price carry term.
export function black76(F, K, T, sigma, type, r = 0) {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const df = Math.exp(-r * T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = npdf(d1);
  const isCall = type === 'call';
  const delta = df * (isCall ? ncdf(d1) : ncdf(d1) - 1);
  const gamma = df * nd1 / (F * sigma * sqrtT);
  const vega = df * F * nd1 * sqrtT / 100;      // per 1 vol-point (1%)
  // Second-order vol greeks (Black-76), put/call-identical, scaled to the same per-vol-point convention:
  //   vanna = ∂vega/∂F = ∂delta/∂σ  →  vega-per-vol-pt shift per unit forward (= Δdelta per +1 vol-pt)
  //   volga = ∂vega/∂σ (a.k.a. vomma) →  vega-per-vol-pt shift per +1 vol-pt of σ  (vol convexity)
  const vanna = (-df * nd1 * d2 / sigma) * 0.01;      // = (vega/F)·(1 − d1/(σ√T)); verified vs finite-diff
  const volga = vega * d1 * d2 / sigma * 0.01;        // = vega·d1·d2/σ, per vol-point
  const price = isCall ? df * (F * ncdf(d1) - K * ncdf(d2)) : df * (K * ncdf(-d2) - F * ncdf(-d1));
  const theta = ((-df * F * nd1 * sigma) / (2 * sqrtT) + r * price) / 365; // per calendar day
  return { delta, gamma, vega, vanna, volga, theta, price, d1, d2 };
}

// Risk-neutral probability the underlying finishes ABOVE strike K at expiry: N(d2).
// This is the options market's own implied probability — model-consistent with the Black-76 above.
export function probAbove(F, K, T, sigma, r = 0) {
  const g = black76(F, K, T, sigma, 'call', r);
  return g ? ncdf(g.d2) : null;
}

// EXACT risk-neutral CDF from an OBSERVED SMILE (Breeden–Litzenberger).
//
// P(S_T > K) = −e^{rT}·dC/dK. With a strike-dependent σ(K):
//     dC/dK = −e^{-rT}·N(d2) + vega·(∂σ/∂K)
// ⇒  P(S_T > K) = N(d2) − e^{rT}·vega·(∂σ/∂K)
//
// The plain N(d2) DROPS the `vega·∂σ/∂K` term. On a real skewed crypto smile that is a MEASURED error of
// up to ~5 percentage points (and it flips sign where the smile slope flips), so N(d2) must not be used
// as a probability whenever a smile is available. `ivFn(K)` supplies the interpolated smile.
export function probAboveSmile(F, K, T, ivFn, r = 0) {
  const sigma = ivFn(K);
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const g = black76(F, K, T, sigma, 'call', r);
  if (!g) return null;
  const dK = Math.max(K * 0.002, 1e-6);
  const sUp = ivFn(K + dK), sDn = ivFn(K - dK);
  if (!(sUp > 0) || !(sDn > 0)) return Math.max(0, Math.min(1, ncdf(g.d2))); // edge of the smile → no slope available
  const dSigdK = (sUp - sDn) / (2 * dK);
  const vegaPerUnitVol = g.vega * 100; // black76 returns vega per vol-POINT
  return Math.max(0, Math.min(1, ncdf(g.d2) - Math.exp(r * T) * vegaPerUnitVol * dSigdK));
}

// Risk-neutral DENSITY at K from the observed smile: e^{rT}·∂²C/∂K² (central difference on the smile).
// Used to police butterfly arbitrage — a negative density means the smile is not arbitrage-free there,
// and any probability read off it is unsound. We detect and disclose rather than silently serve it.
export function rndDensity(F, K, T, ivFn, r = 0) {
  const h = Math.max(K * 0.004, 1e-6);
  const px = (x) => { const s = ivFn(x); if (!(s > 0)) return null; const g = black76(F, x, T, s, 'call', r); return g ? g.price : null; };
  const c0 = px(K), cu = px(K + h), cd = px(K - h);
  if (c0 == null || cu == null || cd == null) return null;
  return Math.exp(r * T) * (cu - 2 * c0 + cd) / (h * h);
}

// FULL risk-neutral distribution from the smile: integrate the Breeden–Litzenberger density over a strike
// grid → normalized CDF → quantiles, tail expected-shortfall, and the RND's own skew/kurtosis. Point
// probabilities (probAboveSmile) are one slice of this; the distribution is strictly more information.
// BUILT-IN GROUND TRUTH: under the T-forward measure S_T is a martingale, so E[S_T] must equal the forward
// F — `meanVsForwardPct` reports that residual as a self-check (a correct density returns ≈0).
// Wings beyond the traded band are SVI-extrapolated (disclosed); `mass` is the raw integral (≈1 if proper).
export function rndDistribution(F, T, ivFn, r = 0, { loMult = 0.35, hiMult = 2.6, n = 400 } = {}) {
  if (!(F > 0) || !(T > 0)) return null;
  const loK = F * loMult, hiK = F * hiMult, dK = (hiK - loK) / n;
  const dens = [];
  for (let i = 0; i <= n; i++) { const d = rndDensity(F, loK + i * dK, T, ivFn, r); dens.push(d != null && d > 0 ? d : 0); }
  const midK = (i) => loK + (i + 0.5) * dK, wt = (i) => (dens[i] + dens[i + 1]) / 2 * dK;
  let mass = 0; for (let i = 0; i < n; i++) mass += wt(i);
  if (!(mass > 1e-6)) return null;
  let mean = 0; for (let i = 0; i < n; i++) mean += midK(i) * wt(i) / mass;
  let m2 = 0, m3 = 0, m4 = 0;
  for (let i = 0; i < n; i++) { const d = midK(i) - mean, w = wt(i) / mass; m2 += d * d * w; m3 += d * d * d * w; m4 += d * d * d * d * w; }
  const sd = Math.sqrt(Math.max(m2, 0));
  // CDF at each right edge, then invert for quantiles.
  const cdf = []; let acc = 0;
  for (let i = 0; i < n; i++) { acc += wt(i) / mass; cdf.push({ K: loK + (i + 1) * dK, p: acc }); }
  const quant = (target) => {
    for (let i = 0; i < cdf.length; i++) if (cdf[i].p >= target) {
      const p0 = i ? cdf[i - 1].p : 0, K0 = i ? cdf[i - 1].K : loK;
      return K0 + (target - p0) / ((cdf[i].p - p0) || 1e-9) * (cdf[i].K - K0);
    }
    return cdf[cdf.length - 1].K;
  };
  const p05 = quant(0.05), p95 = quant(0.95);
  // tail expected shortfalls: E[S | S ≤ p5] and E[S | S ≥ p95]
  let lN = 0, lW = 0, rN = 0, rW = 0;
  for (let i = 0; i < n; i++) { const K = midK(i), w = wt(i) / mass; if (K <= p05) { lN += K * w; lW += w; } if (K >= p95) { rN += K * w; rW += w; } }
  return {
    mass, mean, sd,
    skew: sd > 0 ? m3 / (sd ** 3) : null,
    excessKurtosis: sd > 0 ? m4 / (sd ** 4) - 3 : null,
    quantiles: { p05, p25: quant(0.25), p50: quant(0.5), p75: quant(0.75), p95 },
    es: { left5: lW ? lN / lW : null, right5: rW ? rN / rW : null },
    meanVsForwardPct: ((mean - F) / F) * 100,
  };
}

// One-touch barrier probabilities on the FORWARD (driftless GBM, reflection principle). These price
// "will the market REACH level H at ANY point before T" — the correct model for a "hit $X by <date>"
// prediction market, which is strictly ≥ the "finish above at T" probability (probAbove).
//   P(touch H>F) = N(d2) + (F/H)·N(d1);  P(touch L<F) = N(-d2) + (F/L)·N(-d1)
// with d1 = [ln(F/B)+½σ²T]/(σ√T), d2 = d1 − σ√T for barrier B.
export function probTouchAbove(F, H, T, sigma) {
  if (!(F > 0) || !(T > 0) || !(sigma > 0)) return null;
  if (H <= F) return 1; // already at/above
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / H) + 0.5 * sigma * sigma * T) / sq, d2 = d1 - sq;
  return Math.min(1, Math.max(0, ncdf(d2) + (F / H) * ncdf(d1)));
}
export function probTouchBelow(F, L, T, sigma) {
  if (!(F > 0) || !(T > 0) || !(sigma > 0) || !(L > 0)) return null;
  if (L >= F) return 1;
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / L) + 0.5 * sigma * sigma * T) / sq, d2 = d1 - sq;
  return Math.min(1, Math.max(0, ncdf(-d2) + (F / L) * ncdf(-d1)));
}

// Given a set of {strike, iv(decimal), type} at one expiry with forward F and T,
// interpolate the IV at a target |delta| (e.g. 0.25) on the call and put wings.
// Returns { iv, quality } where quality is 'interpolated' (target delta bracketed by real strikes),
// 'extrapolated' (nearest strike, target outside the traded range), or 'insufficient' (<2 strikes).
export function ivAtDelta(opts, F, T, targetAbsDelta, type, r = 0) {
  const pts = opts.filter((o) => o.iv > 0 && o.type === type)
    .map((o) => { const g = black76(F, o.strike, T, o.iv, type, r); return g ? { d: Math.abs(g.delta), iv: o.iv, strike: o.strike } : null; })
    .filter(Boolean).sort((a, b) => a.d - b.d);
  if (pts.length < 2) return { iv: pts[0]?.iv ?? null, quality: 'insufficient' };
  // find the two points bracketing targetAbsDelta and linearly interpolate IV in delta-space
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.d <= targetAbsDelta && b.d >= targetAbsDelta) || (a.d >= targetAbsDelta && b.d <= targetAbsDelta)) {
      const w = (targetAbsDelta - a.d) / (b.d - a.d || 1e-9);
      return { iv: a.iv + w * (b.iv - a.iv), quality: 'interpolated' };
    }
  }
  // target delta not bracketed by traded strikes -> nearest, flagged as extrapolated
  return { iv: pts.reduce((best, p) => Math.abs(p.d - targetAbsDelta) < Math.abs(best.d - targetAbsDelta) ? p : best).iv, quality: 'extrapolated' };
}

// Interpolate the ATM-forward IV: the IV at strike == forward, bracketing by the two nearest listed
// strikes (call+put averaged per strike) rather than snapping to one nearest strike. Log-strike linear.
export function atmForwardIv(byStrikeIv, F) {
  // byStrikeIv: [{ strike, iv }] (iv decimal), one blended iv per strike, sorted ascending by strike
  const pts = byStrikeIv.filter((o) => o.iv > 0 && o.strike > 0).sort((a, b) => a.strike - b.strike);
  if (!pts.length || !(F > 0)) return null;
  if (pts.length === 1) return { iv: pts[0].iv, quality: 'single-strike' };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.strike <= F && b.strike >= F) {
      const la = Math.log(a.strike), lb = Math.log(b.strike), lf = Math.log(F);
      const w = (lf - la) / (lb - la || 1e-9);
      return { iv: a.iv + w * (b.iv - a.iv), quality: 'interpolated' };
    }
  }
  // forward outside listed strikes -> nearest
  return { iv: pts.reduce((best, p) => Math.abs(p.strike - F) < Math.abs(best.strike - F) ? p : best).iv, quality: 'extrapolated' };
}
