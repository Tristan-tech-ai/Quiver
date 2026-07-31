// lp-risk's HEADLINE, certified: E[IL](v) = exp(-v/8) - 1.
//
// `lpBracket.js` certifies the breakeven volatility underneath this answer. This certifies the number at
// the top of it — the expected divergence the caller actually reads — and the two are different sentences
// about the same response, which is why both exist.
//
// WHY THIS IS PROVABLE AT ALL. The engine computes the expectation with a 401-point trapezoid, and a
// quadrature is not a statement a circuit can restate cheaply: `lpexpectation.circom` is 36,613 R1CS.
// But the integral has an exact closed form. IL(r) = 2√r/(1+r) − 1 is sech(X/2) − 1 for r = e^X, and
// under the martingale lognormal the engine assumes, E[sech(X/2)] = E[√r] = exp(−v/8). Checked against an
// independent fine midpoint rule at v = 0.5, 1, 5, 20, 50, 100 and 200: agreement to 1.3e-13 or better.
// So the engine's trapezoid is the approximation and `expm1(-v/8)` is the answer, and certifying the
// closed form takes 3,854 R1CS rather than 36,613.
//
// WHAT IT COSTS. 7,471 Plonk constraints, domain 8,192, which is the first circuit here that does not fit
// `hez_final_12` — snarkjs refuses it outright. It is built against `hez_final_13`, a public download that
// moves no hash.
//
// FAIL CLOSED, AND THIS IS THE PART THAT MATTERS. The circuit certifies `expm1(-v/8)`; the response
// publishes a trapezoid of the same integral, rounded to four decimals. Those agree on every (σ, T) a
// caller can send that was swept — 4,000 of 4,000 — but they are not the same computation, and on a grid
// that concentrates samples near v ≈ 1.13, where the trapezoid's truncation error peaks at 1.4191e-7
// percentage points, they can print a different last digit. So the proof is attached ONLY when the
// certified value rounds to the figure the response actually served. Anything else withholds it rather
// than placing a proof beside a number it disagrees with.
import { exactExpectedIlPct, totalVarianceFromPublished, checkAgreesWithServed } from './lpClosedForm.js';

const SCALE = 1_000_000_000n;                 // the 1e-9 grid the circuit's public signals live on
const TOL = 500065536n;                       // half a grid step at the 1e18 working scale, plus 2^16 ulps

/**
 * Build the witness the circuit takes, from the fields the response publishes.
 *
 * `volatility` and `horizonPeriods` are used rather than `totalVariance`, and that is deliberate:
 * `totalVariance` is published rounded to 6dp, and rebuilding v from it loses 1.12e-6 percentage points
 * at σ = 0.0123456789, T = 7 — about eight times the quadrature error this whole circuit is about.
 */
export function encodeLpClosed(expectedDivergence) {
  const agree = checkAgreesWithServed(expectedDivergence);
  if (!agree.agrees) return { refused: agree.why };

  const v = totalVarianceFromPublished(expectedDivergence.volatility, expectedDivergence.horizonPeriods);
  if (v == null) return { refused: 'volatility and horizonPeriods are not both published as finite positives' };

  // The circuit's declared range. Above v = 1e4 the bisection cap means nothing reaches here, and below
  // that the squaring ladder covers it; outside, refuse rather than prove something the ladder cannot.
  if (!(v > 0) || v > 1e4) return { refused: `totalVariance ${v} is outside the circuit's declared range (0, 1e4]` };

  const vHat = BigInt(Math.round(v * 1e9));
  const lHat = BigInt(Math.round(Math.exp(-v / 8) * 1e9));   // L-form: 1 + E[IL], on the 1e-9 grid
  if (vHat <= 0n) return { refused: 'totalVariance underflows the 1e-9 grid' };
  if (lHat <= 0n) return { refused: `exp(-v/8) underflows the 1e-9 grid at v = ${v}; every such answer is the -100.0000% floor` };

  return {
    witness: { vHat: vHat.toString(), lHat: lHat.toString() },
    encoded: { vHat, lHat, tolerance: TOL, scale: SCALE },
    exactPct: exactExpectedIlPct(expectedDivergence.volatility, expectedDivergence.horizonPeriods),
    servedPct: Number(expectedDivergence.expectedIlPct),
  };
}

/** What the proof says, and what it does not. Written once so the two served paths cannot drift. */
export const LPCLOSED_CLAIMS = {
  proves: 'That the expected impermanent loss this answer publishes is exp(-sigma^2*T/8) - 1 evaluated '
    + 'INSIDE the circuit, not asserted: the seed exp(-x) is a Horner series over a range-reduced x, then '
    + 'sixteen squarings reach exp(-v/8), and every multiply carries a range-checked remainder so the '
    + 'prover cannot choose a rounding. Both public signals are the figures the response serves, on a '
    + '1e-9 grid: v = sigma^2*T, and 1 + E[IL].',
  doesNotProve: 'That sigma or the horizon are what any venue would say — they are caller inputs and this '
    + 'circuit takes them as given. Nor the fee arithmetic, the concentration factor, the USD figures, or '
    + 'the breakeven, which is lpbracket. And it does not prove the engine’s 401-point trapezoid EQUALS '
    + 'the closed form: it proves the closed form, and the response is attached to it only when the two '
    + 'round to the same four decimals. Where they do not, no proof is attached at all.',
};
