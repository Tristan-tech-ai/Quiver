// lp-risk — forward-looking impermanent loss / divergence (LVR) and fee-breakeven for an LP position.
// Deterministic. Complements lp-desk (which REPLAYS history) with a forecast grounded in closed forms,
// so an agent about to provide liquidity can see whether the fee yield can plausibly beat the bleed.
//
// GROUND TRUTH (derived + independently verified here, not recalled):
//   • V2 (full-range) impermanent loss for a realized price ratio r = P1/P0:  IL(r) = 2·√r/(1+r) − 1.
//     VERIFIED at the token level (the self-check): with constant product k = x·y, the LP holds
//     x1 = √(k/P1), y1 = √(k·P1); LP value = x1·P1 + y1 = 2√(k·P1); hold value = x0·P1 + y0. Their ratio − 1
//     equals the closed form. IL(1)=0; IL(4)=−0.20 (a 4× move costs 20% vs holding).
//   • Expected divergence over a horizon: IL ≈ −(ln r)²/8 to leading order, so for a lognormal underlying
//     E[IL] ≈ −σ²T/8 (σ = per-period vol, T = periods). This leading-order rate is the V2 loss-versus-
//     rebalancing rate (Milionis–Moallemi–Roughgarden–Zhang). Self-checked against a numerical E[IL].
//   • A concentrated (V3) range amplifies BOTH fees and divergence by a capital-efficiency factor ≥ 1;
//     we accept it as an input (default 1 = full range) and note lp-desk measures the realized concentrated
//     case on-chain — we do not fabricate the per-tick amplification here.
import { round } from './stats.js';

const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);

// Numerical E[IL] under lognormal ln r ~ N(-v/2, v) (v = σ²T), via Gauss–Hermite-ish fine grid.
function expectedIlNumerical(v) {
  const sd = Math.sqrt(v);
  let sum = 0, w = 0;
  const N = 400, lo = -6, hi = 6;
  for (let i = 0; i <= N; i++) {
    const z = lo + ((hi - lo) * i) / N;
    const pdf = Math.exp(-0.5 * z * z);
    const r = Math.exp(-0.5 * v + sd * z); // martingale-centered lognormal
    sum += pdf * ilOfRatio(r);
    w += pdf;
  }
  return sum / w;
}

export function lpRisk(input = {}, { eps = 1e-6 } = {}) {
  const conc = Number(input.concentrationFactor) > 0 ? Number(input.concentrationFactor) : 1;
  const capital = Number(input.capitalUsd) > 0 ? Number(input.capitalUsd) : null;
  const out = { ok: true, concentrationFactor: conc };

  // 1) Realized IL for a given price ratio.
  if (Number(input.priceRatio) > 0) {
    const r = Number(input.priceRatio);
    const il = ilOfRatio(r) * conc;
    out.realizedIL = {
      priceRatio: r,
      impermanentLossPct: round(il * 100, 4),
      note: conc > 1 ? `Full-range IL ${round(ilOfRatio(r) * 100, 4)}% amplified ×${conc} for the concentrated range.` : undefined,
      usd: capital != null ? round(il * capital, 2) : null,
    };
  }

  // 2) Expected divergence (LVR) over a horizon from volatility.
  const sigma = Number(input.volatility) > 0 ? Number(input.volatility) : null;   // per-period
  const T = Number(input.horizonPeriods) > 0 ? Number(input.horizonPeriods) : 1;
  if (sigma != null) {
    const v = sigma * sigma * T;                    // total variance over the horizon
    const eIlLeading = -(v / 8) * conc;             // leading-order E[IL] ≈ −σ²T/8
    out.expectedDivergence = {
      volatility: sigma, horizonPeriods: T, totalVariance: round(v, 6),
      expectedIlPct: round(eIlLeading * 100, 4),
      note: 'Leading-order E[IL] ≈ −σ²T/8 (the V2 loss-versus-rebalancing rate). Exact for small variance; understates the loss as variance grows.',
      usd: capital != null ? round(eIlLeading * capital, 2) : null,
    };

    // 3) Fee vs divergence: net forecast + breakeven.
    if (Number(input.feeAprPct) >= 0 && input.feeAprPct != null) {
      const periodsPerYear = Number(input.periodsPerYear) > 0 ? Number(input.periodsPerYear) : 365;
      const feeFrac = (Number(input.feeAprPct) / 100) * (T / periodsPerYear) * conc;
      const netFrac = feeFrac + eIlLeading;         // eIlLeading is negative
      // breakeven σ: fees == |E[IL]| => feeFrac = σ²T/8·conc => σ = sqrt(8·feeFrac/(T·conc))... feeFrac already ×conc
      const feeFracNoConc = (Number(input.feeAprPct) / 100) * (T / periodsPerYear);
      const breakevenSigma = Math.sqrt(Math.max(0, (8 * feeFracNoConc) / T));
      out.feeVsDivergence = {
        feeAprPct: Number(input.feeAprPct),
        horizonFeesPct: round(feeFrac * 100, 4),
        expectedNetPct: round(netFrac * 100, 4),
        breakevenVolatility: round(breakevenSigma, 5),
        verdict: netFrac >= 0
          ? `At ${input.feeAprPct}% fee APR and σ=${sigma}, expected fees beat expected divergence by ${round(netFrac * 100, 3)}% over the horizon.`
          : `Expected divergence EXCEEDS fees by ${round(-netFrac * 100, 3)}% over the horizon — providing this liquidity loses in expectation unless realized vol is below ${round(breakevenSigma, 4)} (per period).`,
        usd: capital != null ? round(netFrac * capital, 2) : null,
      };
    }
  }

  if (!out.realizedIL && !out.expectedDivergence) {
    return { ok: false, errors: ['provide priceRatio (realized IL) and/or volatility (+ horizonPeriods) for an expected-divergence forecast'] };
  }

  // Self-checks (ground-truth invariants).
  const checks = [];
  // (a) IL token-level identity at a nontrivial ratio: closed form == explicit constant-product tokens.
  {
    const rC = 2.0, P0 = 1, P1 = P0 * rC, k = 1; // x0=√(k/P0)=1, y0=√(k P0)=1 (a 50/50 unit position)
    const x0 = Math.sqrt(k / P0), y0 = Math.sqrt(k * P0);
    const x1 = Math.sqrt(k / P1), y1 = Math.sqrt(k * P1);
    const ilTokens = (x1 * P1 + y1) / (x0 * P1 + y0) - 1;
    const ilClosed = ilOfRatio(rC);
    const res = Math.abs(ilTokens - ilClosed);
    checks.push({ name: 'IL identity: closed form 2√r/(1+r)−1 == explicit constant-product token value', residual: Number(res.toExponential(2)), pass: res <= 1e-12 });
  }
  // (b) E[IL] leading order == numerical E[IL] at a small reference variance (independent of inputs).
  {
    const vRef = 0.01; // σ²T = 0.01
    const leading = -vRef / 8;
    const numer = expectedIlNumerical(vRef);
    const res = Math.abs(leading - numer);
    checks.push({ name: 'E[IL] check: −σ²T/8 == numerical E[IL] at σ²T=0.01', residual: Number(res.toExponential(2)), tolerance: 1e-4, pass: res <= 1e-4 });
  }
  out.checks = checks;
  out.model = 'V2 (full-range) closed-form IL; expected divergence is the leading-order −σ²T/8 (V2 LVR rate); concentration amplifies both fees and divergence by the supplied factor. Full-range/lognormal model — for the realized concentrated case on real swaps use lp-desk.';
  return out;
}
