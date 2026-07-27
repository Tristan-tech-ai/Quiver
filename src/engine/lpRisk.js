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

// Inverse of the above: the total variance v = σ²T at which expected divergence exactly eats a given
// fee fraction. Solved by bisection because E[IL](v) is monotone decreasing from 0 toward −1. The
// leading-order breakeven σ = √(8·fees/T) comes from the SAME expansion that goes out of range above,
// so once the headline became the exact expectation the two numbers in this object disagreed — at 20%
// APR over 30 days the leading-order breakeven left a 1.3% net instead of 0. Returns null when fees
// exceed what divergence can ever cost (E[IL] is bounded by −100%), i.e. when no breakeven exists.
function breakevenVarianceExact(feeFracNoConc) {
  if (!(feeFracNoConc > 0)) return 0;
  if (feeFracNoConc >= 1) return null;                 // divergence can never catch fees this large
  let lo = 0, hi = 1;
  while (expectedIlNumerical(hi) > -feeFracNoConc) { hi *= 2; if (hi > 1e4) return null; }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (expectedIlNumerical(mid) > -feeFracNoConc) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function lpRisk(input = {}, { eps = 1e-6 } = {}) {
  const conc = Number(input.concentrationFactor) > 0 ? Number(input.concentrationFactor) : 1;
  const capital = Number(input.capitalUsd) > 0 ? Number(input.capitalUsd) : null;
  const out = { ok: true, concentrationFactor: conc };

  // 1) Realized IL for a given price ratio.
  if (Number(input.priceRatio) > 0) {
    const r = Number(input.priceRatio);
    const ilFull = ilOfRatio(r);              // exact, bounded in (-1, 0]
    const ilAmplifiedRaw = ilFull * conc;     // a LINEARISATION, unbounded below
    // Multiplying the full-range loss by a capital-efficiency factor is a small-move linearisation.
    // It has no upper bound, while a liquidity position cannot lose more than the capital in it, so
    // past -100% the linearisation has not found a bigger loss -- it has stopped describing anything.
    // It used to be served as the headline anyway (conc 5 at a 9x move returned -200%, and -$200,000
    // against $100,000 of capital) with the boundedness check hard-coded to pass whenever conc > 1.
    // The headline is now the exact full-range loss whenever the amplification leaves its range, the
    // raw linear figure is still reported beside it, and the caller is told which regime they are in.
    const outOfRange = ilAmplifiedRaw <= -1;
    const il = outOfRange ? ilFull : ilAmplifiedRaw;
    out.realizedIL = {
      priceRatio: r,
      impermanentLossPct: round(il * 100, 4),
      ...(conc > 1 ? {
        fullRangeIlPct: round(ilFull * 100, 4),
        linearAmplificationPct: round(ilAmplifiedRaw * 100, 4),
        concentratedModelInRange: !outOfRange,
        note: outOfRange
          ? `Full-range IL is ${round(ilFull * 100, 4)}%; multiplying it by ${conc} gives ${round(ilAmplifiedRaw * 100, 4)}%, which is past -100% and therefore not a loss a position can realise. The linear amplification is a small-move approximation and this move is not small: at a price ratio of ${r} a concentrated range is fully converted to one asset and its loss is bounded by the position, not by the multiplier. The headline is the exact full-range figure; use lp-desk to measure the realised concentrated case on actual swaps.`
          : `Full-range IL ${round(ilFull * 100, 4)}% amplified x${conc} for the concentrated range. Valid while the amplified figure stays inside (-100%, 0].`,
      } : {}),
      usd: capital != null ? round(il * capital, 2) : null,
    };
  }

  // 2) Expected divergence (LVR) over a horizon from volatility.
  const sigma = Number(input.volatility) > 0 ? Number(input.volatility) : null;   // per-period
  const T = Number(input.horizonPeriods) > 0 ? Number(input.horizonPeriods) : 1;
  if (sigma != null) {
    const v = sigma * sigma * T;                    // total variance over the horizon
    const eIlLeading = -(v / 8) * conc;             // leading-order E[IL] ≈ −σ²T/8, UNBOUNDED
    // The leading-order rate is a small-variance expansion and diverges without limit, while V2
    // divergence loss is bounded in (−100%, 0]. An adversarial live test drove it to −135% at
    // σ²T = 10.8 and a verdict was built on that impossible figure. The headline is therefore the
    // EXACT lognormal expectation, which is bounded by construction; the expansion is reported beside
    // it, and the gap between them is stated so the caller can see where the approximation left its
    // valid range instead of being told a number that cannot exist.
    // Same linearisation caveat as realizedIL: conc multiplies a bounded expectation into an
    // unbounded one. conc 3 at sigma^2*T = 5 served -139.42% and -$139,421 on $100,000 of capital.
    const eIlExactFull = expectedIlNumerical(v);
    const eIlAmplifiedRaw = eIlExactFull * conc;
    const ampOutOfRange = eIlAmplifiedRaw <= -1;
    const eIlExact = ampOutOfRange ? eIlExactFull : eIlAmplifiedRaw;
    const divergentPct = Math.abs(eIlLeading - eIlExact) * 100;
    out.expectedDivergence = {
      volatility: sigma, horizonPeriods: T, totalVariance: round(v, 6),
      expectedIlPct: round(eIlExact * 100, 4),
      expectedIlLeadingOrderPct: round(eIlLeading * 100, 4),
      approximationGapPct: round(divergentPct, 4),
      basis: 'exact lognormal expectation of 2√r/(1+r) − 1 under ln r ~ N(−v/2, v)',
      ...(conc > 1 ? {
        fullRangeExpectedIlPct: round(eIlExactFull * 100, 4),
        linearAmplificationPct: round(eIlAmplifiedRaw * 100, 4),
        concentratedModelInRange: !ampOutOfRange,
        ...(ampOutOfRange ? { concentrationNote: `Multiplying the expectation by ${conc} gives ${round(eIlAmplifiedRaw * 100, 4)}%, past the -100% bound and so not an expectation a position can realise. The headline reverts to the exact full-range expectation; the amplified figure is reported only as the raw linearisation.` } : {}),
      } : {}),
      note: v <= 0.25
        ? 'Small-variance regime: the leading-order rate −σ²T/8 and the exact expectation agree closely; either may be used.'
        : `Outside the small-variance regime (σ²T = ${round(v, 4)}): the leading-order rate −σ²T/8 OVERSTATES the loss and is unbounded, so the exact expectation is the headline. V2 divergence loss can never exceed −100%.`,
      usd: capital != null ? round(eIlExact * capital, 2) : null,
    };

    // 3) Fee vs divergence: net forecast + breakeven.
    if (Number(input.feeAprPct) >= 0 && input.feeAprPct != null) {
      const periodsPerYear = Number(input.periodsPerYear) > 0 ? Number(input.periodsPerYear) : 365;
      const feeFrac = (Number(input.feeAprPct) / 100) * (T / periodsPerYear) * conc;
      const netFrac = feeFrac + eIlExact;           // the bounded exact expectation, not the divergent expansion
      // Breakeven σ: fees == |E[IL]|. Solved against the EXACT expectation (the headline), so that
      // re-running this engine at breakevenVolatility actually returns a net of zero — asserted below
      // as a self-check. The leading-order σ = √(8·fees/T) is reported beside it. conc cancels: both
      // sides of fees == |E[IL]| carry the same factor.
      const feeFracNoConc = (Number(input.feeAprPct) / 100) * (T / periodsPerYear);
      const beVarLeading = 8 * feeFracNoConc;
      const beVarExact = breakevenVarianceExact(feeFracNoConc);
      const breakevenSigma = beVarExact == null ? null : Math.sqrt(beVarExact / T);
      const breakevenSigmaLeading = Math.sqrt(Math.max(0, beVarLeading / T));
      out.feeVsDivergence = {
        feeAprPct: Number(input.feeAprPct),
        horizonFeesPct: round(feeFrac * 100, 4),
        expectedNetPct: round(netFrac * 100, 4),
        breakevenVolatility: breakevenSigma == null ? null : round(breakevenSigma, 5),
        breakevenVolatilityLeadingOrder: round(breakevenSigmaLeading, 5),
        breakevenBasis: breakevenSigma == null
          ? `No breakeven exists: horizon fees (${round(feeFracNoConc * 100, 3)}% of capital) exceed the maximum expected divergence, which is bounded by −100%. Any realized volatility leaves this position ahead in expectation.`
          : 'Per-period σ solved against the exact lognormal expectation, so re-running at this σ nets zero (self-checked). The leading-order √(8·fees/T) is reported alongside and understates the tolerable vol.',
        verdict: netFrac >= 0
          ? `At ${input.feeAprPct}% fee APR and σ=${sigma}, expected fees beat expected divergence by ${round(netFrac * 100, 3)}% over the horizon.`
          : `Expected divergence EXCEEDS fees by ${round(-netFrac * 100, 3)}% over the horizon — providing this liquidity loses in expectation unless realized vol is below ${breakevenSigma == null ? 'n/a' : round(breakevenSigma, 4)} (per period).`,
        usd: capital != null ? round(netFrac * capital, 2) : null,
      };
      // Self-check: the breakeven must actually break even. Evaluated on the SERVED fee level, so it
      // fails on the leading-order solve wherever the expansion has drifted — which is the whole point.
      if (beVarExact != null) {
        const netAtBe = feeFracNoConc + expectedIlNumerical(beVarExact);
        out._breakevenCheck = { name: 'breakeven: expected fees == expected divergence at breakevenVolatility', residual: Number(Math.abs(netAtBe).toExponential(2)), tolerance: 1e-6, pass: Math.abs(netAtBe) <= 1e-6 };
      }
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
  // (c) BOUNDEDNESS, added after a live adversarial test drove the old headline to an impossible
  // -135%. V2 divergence loss lies in (-100%, 0]; a reported expectation outside that range is not a
  // large loss, it is a wrong answer. This check is evaluated on the INPUTS ACTUALLY SERVED, not on a
  // fixed reference, so unlike check (b) it can fail on a real call.
  if (out.expectedDivergence) {
    const e = out.expectedDivergence.expectedIlPct;
    checks.push({ name: 'boundedness: reported expected divergence lies in (-100%, 0] as V2 divergence loss must', residual: e, pass: e <= 0 && e > -100 });
  }
  if (out.realizedIL) {
    const rl = out.realizedIL.impermanentLossPct;
    // NO ESCAPE HATCH. This check previously read `pass: conc > 1 ? true : ...`, which disabled the
    // verifier in exactly the regime where the number breaks: at conc 5 and a 9x move it served
    // -200%, and -$200,000 against $100,000 of capital, with the check green. A position cannot lose
    // more than the capital in it, so that is not a large loss, it is a wrong answer -- the same class
    // this engine's own note calls impossible two lines above. The check now ranges over the served
    // value whatever the concentration factor, and the amplified branch is bounded below instead of
    // excused (see the note on realizedIL for why the linear amplification stops being valid).
    checks.push({ name: 'boundedness: reported realized IL lies in (-100%, 0], amplified or not', residual: rl, pass: rl <= 0 && rl > -100 });
  }
  if (out._breakevenCheck) { checks.push(out._breakevenCheck); delete out._breakevenCheck; }
  out.checks = checks;
  out.model = 'V2 (full-range) closed-form IL; expected divergence is the EXACT lognormal expectation, with the leading-order −σ²T/8 (V2 LVR rate) reported alongside it and flagged when the two diverge; concentration amplifies both fees and divergence by the supplied factor. Full-range/lognormal model — for the realized concentrated case on real swaps use lp-desk.';
  return out;
}
