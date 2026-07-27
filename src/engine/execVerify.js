// exec-verify — deterministic execution-quality / fair-fill verification for autonomous agents.
//
// WHY THIS EXISTS: "slippage is not protection by itself" (ground truth, 2026). A sandwich bot lets the
// agent's swap complete WITHIN its slippage tolerance while still extracting 0.3-0.8%; the agent only sees
// "filled OK" and cannot tell it was sandwiched. 60-90k sandwiches/month on Ethereum. No agent-facing
// service verifies the fill. This one does: it computes the fill the pool HONESTLY implied for the agent's
// own size, and reports everything worse than that as adverse execution the agent could not otherwise see.
//
// GROUND TRUTH & SELF-CHECK: for a constant-product pool (x*y=k, Uniswap V2 & forks), the honest output
// for input dx at fee f is  out = y*dx*(1-f) / (x + dx*(1-f)). This EXACTLY preserves the fee-adjusted
// constant product:  (x + dx*(1-f)) * (y - out) = x*y  (derived & verified; residual ~0). We assert that
// invariant on every call — a wrong benchmark fails loudly rather than mislabeling a fair fill as adverse.
//
// SCOPE (honest): v0 benchmarks against the constant-product (V2) model, exact for V2-style pools. V3
// concentrated liquidity depends on the tick liquidity distribution, not simple reserves — benchmarking
// that needs tick data (a follow-up on the existing univ3 adapter). For non-CP venues, pass `fairPrice`
// (e.g. mid/oracle at submit) to use the model-free reference mode instead.
import { round } from './stats.js';

// Uniswap V2 getAmountOut (exact).
const getAmountOut = (dx, x, y, f) => {
  const inEff = dx * (1 - f);
  return (y * inEff) / (x + inEff);
};

/**
 * @param p.amountIn            input amount (base units, same scale as reserveIn)
 * @param p.amountOutRealized   what the agent actually received
 * @param p.reserveIn           pool reserve of the input token BEFORE the trade  [constant-product mode]
 * @param p.reserveOut          pool reserve of the output token BEFORE the trade [constant-product mode]
 * @param p.feeTier             pool fee as a fraction (e.g. 0.003 for 0.30%)      [constant-product mode]
 * @param p.fairPrice           out-per-in fair reference (mid/oracle at submit)   [reference mode]
 * @param p.slippageTolerancePct the agent's slippage setting — to demonstrate "within tolerance yet robbed"
 */
export function execVerify(p = {}, { eps = 1e-6 } = {}) {
  const dx = Number(p.amountIn);
  const realized = Number(p.amountOutRealized);
  if (!(dx > 0) || !(realized > 0)) return { ok: false, errors: ['amountIn and amountOutRealized must be > 0'] };

  const haveReserves = Number(p.reserveIn) > 0 && Number(p.reserveOut) > 0 && p.feeTier != null;
  const haveFair = Number(p.fairPrice) > 0;
  if (!haveReserves && !haveFair) return { ok: false, errors: ['provide {reserveIn,reserveOut,feeTier} (constant-product) or fairPrice (reference)'] };

  const realizedPrice = realized / dx;
  let out;

  if (haveReserves) {
    const x = Number(p.reserveIn), y = Number(p.reserveOut), f = Number(p.feeTier);
    if (!(f >= 0 && f < 1)) return { ok: false, errors: ['feeTier must be in [0,1)'] };
    const honestOut = getAmountOut(dx, x, y, f);
    const inEff = dx * (1 - f);
    // constant-product invariant self-check
    const kBefore = x * y, kAfter = (x + inEff) * (y - honestOut);
    const residual = Math.abs(kAfter - kBefore);
    // The tolerance must not scale with k. k is QUADRATIC in reserve size while honestOut — the
    // number this check exists to certify — is linear, so an absolute budget of eps*k let the
    // invariant drift by more than the entire honest output on any realistic pool: at reserves of
    // 1e6 and 2e9 it permitted a residual worth ~1.0e6 bps of honestOut, against the 5 bps threshold
    // this same engine uses to call a fill a sandwich. A check looser than the effect it is paired
    // with certifies nothing. Two scale-free forms replace it: a RELATIVE error on k, and a
    // reconstruction of honestOut measured in output units against honestOut itself.
    const relResidual = kBefore > 0 ? residual / kBefore : residual;
    const invariantOk = relResidual <= 1e-12;
    // Independent reconstruction: solve the invariant for the output and compare in output units.
    const outFromInvariant = y - kBefore / (x + inEff);
    const outResidual = Math.abs(outFromInvariant - honestOut);
    const outRelResidual = honestOut > 0 ? outResidual / honestOut : outResidual;
    const outputOk = outRelResidual <= 1e-12;

    const mid = y / x;                                   // pre-trade spot (out per in)
    const honestPrice = honestOut / dx;                  // fill the pool honestly implies for YOUR size (incl fee)
    const slipVsMidBps = ((mid - honestPrice) / mid) * 1e4;   // unavoidable: your own impact + fee
    const feeBps = f * 1e4;
    const ownImpactBps = slipVsMidBps - feeBps;          // pure price impact of your size (fee removed)
    const adverseBps = ((honestOut - realized) / honestOut) * 1e4;  // shortfall vs honest = sandwich/MEV/stale
    const adverseValue = honestOut - realized;           // in output-token units

    out = {
      mode: 'constant-product',
      midPrice: round(mid, 8),
      honestFillPrice: round(honestPrice, 8),
      realizedFillPrice: round(realizedPrice, 8),
      honestOut: round(honestOut, 8),
      unavoidableCostBps: { total: round(slipVsMidBps, 2), fee: round(feeBps, 2), ownPriceImpact: round(ownImpactBps, 2) },
      adverseExecutionBps: round(adverseBps, 2),
      adverseValueOut: round(adverseValue, 8),
      verdict: adverseBps > 5
        ? `Lost ${round(adverseBps, 1)} bps to adverse execution beyond your honest price impact — consistent with sandwiching / MEV / a stale quote. This is money your slippage tolerance did NOT protect.`
        : adverseBps < -5
          ? `Fill was ${round(-adverseBps, 1)} bps BETTER than the honest pool price (favorable — you received more than the pre-trade pool implied, e.g. positive-slippage routing or a quote stale in your favor).`
          : `Fill is within ${round(Math.abs(adverseBps), 1)} bps of the honest pool price — no material adverse execution detected.`,
      note: "Benchmark uses the SUPPLIED pre-trade reserves. To detect a full sandwich, pass the pool state at the START of your trade's block (before any attacker front-run); passing the state immediately before your own tx under-detects, because the front-run's impact is already baked into those reserves.",
      checks: [
        { name: 'constant-product invariant: (x+dx(1-f))(y-honestOut) == xy, as a RELATIVE error on k',
          residual: Number(relResidual.toExponential(2)), tolerance: 1e-12, pass: invariantOk,
          note: 'Relative, not absolute: an absolute budget scaled with k, which is quadratic in reserve size, so it grew far looser than the output it certifies as pools get larger.' },
        { name: 'benchmark reconstruction: honestOut solved from the invariant matches the served honestOut, relative to honestOut',
          residual: Number(outRelResidual.toExponential(2)), tolerance: 1e-12, pass: outputOk,
          note: 'Measured in output units against the output itself, so the check is as tight as the 5 bps threshold this engine uses to call a fill adverse.' },
      ],
    };
  } else {
    const fair = Number(p.fairPrice);
    const adverseBps = ((fair - realizedPrice) / fair) * 1e4;
    out = {
      mode: 'reference',
      fairPrice: round(fair, 8),
      realizedFillPrice: round(realizedPrice, 8),
      adverseExecutionBps: round(adverseBps, 2),
      verdict: adverseBps > 5
        ? `Realized ${round(adverseBps, 1)} bps worse than the fair reference — adverse execution your slippage tolerance did not prevent.`
        : `Within ${round(Math.abs(adverseBps), 1)} bps of the fair reference.`,
      // Reported as NOT RUN rather than as a pass. In this mode the benchmark is a number the caller
      // supplied, so there is no pool state and no invariant to assert against — and a check that
      // asserts nothing while reporting `pass: true` inflates the self-check count with a guarantee
      // that was never made. The verdict below is only as good as the fairPrice handed in.
      checks: [{ name: 'constant-product invariant', skipped: true, pass: null,
        reason: 'reference mode: the benchmark is the caller-supplied fairPrice, so no pool model is asserted and there is no invariant to check. Pass reserveIn/reserveOut/feeTier to get the invariant-backed benchmark instead.' }],
      note: 'Reference mode compares realized vs a caller-supplied fair price; it does not model the pool. For an exact, self-verified benchmark pass pool reserves + feeTier.',
    };
  }

  // "Within tolerance yet robbed" — the punchline that motivates the service.
  if (p.slippageTolerancePct != null && out.adverseExecutionBps != null) {
    const tolBps = Number(p.slippageTolerancePct) * 100;
    out.slippageTolerance = {
      toleranceBps: round(tolBps, 1),
      withinTolerance: out.adverseExecutionBps <= tolBps,
      lesson: out.adverseExecutionBps > 0 && out.adverseExecutionBps <= tolBps
        ? 'The fill was WITHIN your slippage tolerance and STILL lost the bps above — proof that slippage tolerance is not sandwich protection. Use private-RPC / intent-based execution (CowSwap, 1inch Fusion, MEV Blocker).'
        : undefined,
    };
  }

  return { ok: true, inputs: { amountIn: dx, amountOutRealized: realized }, ...out };
}
