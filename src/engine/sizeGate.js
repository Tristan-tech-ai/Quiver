// size-gate — deterministic position sizing (fractional Kelly + risk-of-ruin) for autonomous agents.
//
// WHY THIS EXISTS: the single most direct antidote to the blowups. GPT-5 lost 62% of capital trading
// perps autonomously; the survivors "won not by being smarter but by being tightly leashed with rigid
// rules." Full Kelly over-bets thin edges and rides to ruin; professionals bet 10-25% of full Kelly.
// An agent that sized fractional-Kelly instead of guessing does not lose 62%. This computes the sized
// bet deterministically and reports the actual probability of ruin at that size.
//
// GROUND TRUTH (all verified against known anchors on 2026-07-18, not recalled blindly):
//   • Discrete Kelly: f* = (p(b+1) - 1) / b  for win prob p, net win/loss odds b. This is the argmax of
//     expected log-growth g(f) = p·ln(1+fb) + (1-p)·ln(1-f); we self-check g'(f*) == 0 (the FOC).
//   • Continuous Kelly (vol targeting): f* = mu / sigma^2  (excess return / variance). Growth
//     g(f) = f·mu - 0.5·f^2·sigma^2. Half-Kelly gives 0.75x growth for 0.5x vol — self-checked.
//   • Risk of ruin, DERIVED from the Brownian hitting probability (log-wealth is a drifting BM): the
//     probability of EVER drawing down to fraction alpha of capital under fractional-Kelly lambda is
//         RoR(alpha, lambda) = alpha ^ ((2 - lambda) / lambda)
//     Anchored by the classic result RoR(alpha, 1) = alpha (full Kelly). Self-checked at lambda=1.
//   • Fractional Kelly default = 0.25 (quarter Kelly) — the conservative end of professional practice,
//     chosen because edge estimates are themselves uncertain and over-estimating edge over-bets toward ruin.
import { round } from './stats.js';

// expected log-growth per unit time (continuous) or per bet (discrete)
const gContinuous = (f, mu, s2) => f * mu - 0.5 * f * f * s2;
const gDiscrete = (f, p, b) => (f <= 0 || f >= 1 ? -Infinity : p * Math.log(1 + f * b) + (1 - p) * Math.log(1 - f));
const gDiscretePrime = (f, p, b) => (p * b) / (1 + f * b) - (1 - p) / (1 - f);

// RoR(alpha, lambda) = alpha^((2-lambda)/lambda). lambda = fraction of FULL Kelly actually bet.
const riskOfRuin = (alpha, lambda) => (lambda > 0 ? Math.pow(alpha, (2 - lambda) / lambda) : 0);

/**
 * @param p.mode         'discrete' (odds) or 'continuous' (returns). Auto-detected if omitted.
 * @param p.winProb      p in (0,1)      [discrete]
 * @param p.winLossRatio b > 0 net odds  [discrete]
 * @param p.expectedReturn mu (per period, excess) [continuous]
 * @param p.volatility     sigma > 0 (per period)  [continuous]
 * @param p.bankroll     capital to size against (required for a $ size; else fractions only)
 * @param p.kellyFraction fraction of FULL Kelly to bet (default 0.25). Clamped to (0,1].
 * @param p.drawdownLevels fractions to report ruin probability for (default [0.5,0.25,0.1]).
 */
export function sizeGate(p = {}, { eps = 1e-9 } = {}) {
  const errors = [];
  const mode = p.mode || (p.winProb != null && p.winLossRatio != null ? 'discrete'
                        : (p.expectedReturn != null && p.volatility != null ? 'continuous' : null));
  if (!mode) errors.push('provide {winProb, winLossRatio} (discrete) or {expectedReturn, volatility} (continuous)');

  const lambda = p.kellyFraction != null ? Number(p.kellyFraction) : 0.25;
  if (!(lambda > 0 && lambda <= 1)) errors.push('kellyFraction must be in (0,1]');
  if (errors.length) return { ok: false, errors };

  let fullKelly, growthAtFull, growthAtBet, checks = [];
  if (mode === 'discrete') {
    const pw = Number(p.winProb), b = Number(p.winLossRatio);
    if (!(pw > 0 && pw < 1) || !(b > 0)) return { ok: false, errors: ['winProb in (0,1), winLossRatio > 0'] };
    fullKelly = (pw * (b + 1) - 1) / b;                 // may be <= 0 if no edge
    if (fullKelly > 0) {
      // self-check: f* is where expected-log-growth derivative is zero (the DEFINITION of Kelly)
      const foc = gDiscretePrime(fullKelly, pw, b);
      checks.push({ name: 'kelly-FOC: g\'(f*) == 0 (f* maximizes expected log-growth)', residual: Number(Math.abs(foc).toExponential(2)), pass: Math.abs(foc) <= 1e-9 });
      growthAtFull = gDiscrete(fullKelly, pw, b);
      growthAtBet = gDiscrete(lambda * fullKelly, pw, b);
    }
  } else {
    const mu = Number(p.expectedReturn), sig = Number(p.volatility);
    if (!(sig > 0)) return { ok: false, errors: ['volatility must be > 0'] };
    const s2 = sig * sig;
    fullKelly = mu / s2;
    if (fullKelly > 0) {
      growthAtFull = gContinuous(fullKelly, mu, s2);
      growthAtBet = gContinuous(lambda * fullKelly, mu, s2);
      // self-check: half-Kelly identity — growth ratio 0.75, vol ratio 0.5 (independent of mu, sig)
      const half = gContinuous(0.5 * fullKelly, mu, s2);
      checks.push({ name: 'half-Kelly identity: g(0.5f*)/g(f*) == 0.75', residual: Number(Math.abs(half / growthAtFull - 0.75).toExponential(2)), pass: Math.abs(half / growthAtFull - 0.75) <= 1e-9 });
    }
  }

  if (!(fullKelly > 0)) {
    return {
      ok: true, hasEdge: false, fullKellyFraction: round(fullKelly, 6),
      recommendation: 'No positive edge — Kelly says do not bet (size 0). Any positive size has negative expected log-growth.',
      inputs: { mode, ...(mode === 'discrete' ? { winProb: p.winProb, winLossRatio: p.winLossRatio } : { expectedReturn: p.expectedReturn, volatility: p.volatility }) },
    };
  }

  const betFraction = lambda * fullKelly;                // fraction of bankroll to allocate
  const bankroll = Number(p.bankroll) > 0 ? Number(p.bankroll) : null;
  const levels = Array.isArray(p.drawdownLevels) && p.drawdownLevels.length ? p.drawdownLevels : [0.5, 0.25, 0.1];

  // RoR anchor self-check: at lambda=1, RoR(alpha) must equal alpha exactly.
  const anchorAlpha = 0.5;
  const anchorErr = Math.abs(riskOfRuin(anchorAlpha, 1) - anchorAlpha);
  checks.push({ name: 'risk-of-ruin anchor: RoR(alpha, lambda=1) == alpha (full-Kelly classic result)', residual: Number(anchorErr.toExponential(2)), pass: anchorErr <= 1e-12 });

  const ruin = levels.map((a) => ({
    drawdownToFraction: a,
    lossPct: round((1 - a) * 100, 1),
    probEver: round(riskOfRuin(a, lambda), 5),
  }));

  // Leverage guard: a recommended bet > 100% of bankroll REQUIRES margin. The continuous risk-of-ruin
  // model assumes no forced liquidation — leverage breaks that assumption, so real ruin risk is HIGHER
  // than the figures above. Surfacing this is exactly the kind of confident-wrong-number the tool prevents.
  const leveraged = betFraction > 1;

  return {
    ok: true, hasEdge: true, mode,
    fullKellyFraction: round(fullKelly, 6),
    kellyFractionUsed: lambda,
    recommendedBetFraction: round(betFraction, 6),                 // fraction of bankroll
    recommendedSize: bankroll != null ? round(betFraction * bankroll, 2) : null,
    impliedPortfolioVolPct: mode === 'continuous' ? round(betFraction * Number(p.volatility) * 100, 3) : null,
    expectedLogGrowth: { atFullKelly: round(growthAtFull, 6), atRecommended: round(growthAtBet, 6), fractionOfMax: round(growthAtBet / growthAtFull, 4) },
    riskOfRuin: ruin,
    leverage: {
      required: leveraged,
      grossExposurePct: round(betFraction * 100, 1),
      warning: leveraged
        ? 'Recommended size EXCEEDS 100% of bankroll — this requires margin/leverage. The risk-of-ruin above assumes continuous rebalancing with NO forced liquidation; leverage adds liquidation risk it does not model, so TRUE ruin risk is higher. Lower kellyFraction, or run perp-gate to check the liquidation distance for the levered position.'
        : undefined,
    },
    note: `Betting ${round(lambda * 100, 0)}% of full Kelly. Full Kelly maximizes growth but its drawdowns are brutal (P(ever halving)=50%); at this fraction P(ever halving)=${round(riskOfRuin(0.5, lambda) * 100, 2)}%. If your edge estimate is optimistic, true lambda is higher and ruin risk rises — prefer under-betting.${fullKelly > 1 ? ` NOTE: full Kelly here is ${round(fullKelly, 2)}× bankroll (>1) — the estimated edge implies leverage; such edges are rare and easily over-estimated, so treat with extra caution.` : ''}`,
    model: 'Kelly optimal-growth sizing; risk-of-ruin is the continuous-Kelly (GBM) drawdown probability, exact for continuous mode and an approximation for discrete bets (and it excludes forced-liquidation risk under leverage).',
    checks,
  };
}
