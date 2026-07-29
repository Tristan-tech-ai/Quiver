// Encode a bracket certificate for lp-risk's breakeven volatility.
//
// WHAT THIS DOES AND DOES NOT RECOMPUTE, because the distinction is the whole point of the circuit.
//
// The CIRCUIT recomputes nothing iterative. It checks four inequalities over published integers.
// This ENCODER, being a witness generator, has to find the bracket, and finding it means running a
// search — the same doubling-then-halving the engine runs. That is not a weakness of the scheme: a
// witness generator is allowed to search, a verifier is not. `gateB4-1` has the same shape, where the
// encoder runs a Newton integer square root that the circuit never performs.
//
// The engine does not export `expectedIlNumerical` or `breakevenVarianceExact`, so the two are
// reproduced here from `src/engine/lpRisk.js`. That copy is a liability and it is checked rather than
// trusted: `validateQuadratureCopy` below evaluates it at the variance the SERVICE reports and
// requires the result to round to the figure the SERVICE published. If the copy ever drifts from the
// engine, that check fails before any bracket is encoded.
//
// THE HALVING COUNT IS A DELIBERATE CHOICE, not a copy of the engine's 200. After 200 halvings the
// bracket is about 3e-17 wide, and on the shared 1e-9 grid both endpoints land on the SAME integer —
// so `lo < hi` is not even expressible and the certificate would be vacuous. The encoder therefore
// halves only until the bracket is narrow enough that BOTH endpoints round to the breakeven
// volatility the service published, and reports how many halvings that took. Measured at 15 to 23
// across the fee levels swept, against the engine's 200.
import { SCALE, toScaled } from './gatekit.mjs';

export const GRID = SCALE;

/** The engine's IL closed form. */
export const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);

/** The engine's 401-point quadrature, reproduced. Validated against the service, not trusted. */
export function expectedIlNumerical(v) {
  const sd = Math.sqrt(v);
  let sum = 0, w = 0;
  const N = 400, lo = -6, hi = 6;
  for (let i = 0; i <= N; i++) {
    const z = lo + ((hi - lo) * i) / N;
    const pdf = Math.exp(-0.5 * z * z);
    const r = Math.exp(-0.5 * v + sd * z);
    sum += pdf * ilOfRatio(r);
    w += pdf;
  }
  return sum / w;
}

/**
 * Prove the copy above is the engine's arithmetic, by evaluating it at the variance the service
 * REPORTS and requiring agreement at the precision the service PUBLISHES.
 * @returns {{ ok: boolean, served: number, mine: number, v: number }}
 */
export function validateQuadratureCopy(lpRisk, round, { volatility, horizonPeriods }) {
  const res = lpRisk({ volatility, horizonPeriods });
  const v = res.expectedDivergence.totalVariance;
  const served = res.expectedDivergence.expectedIlPct;
  const mine = expectedIlNumerical(v) * 100;
  return { ok: round(mine, 4) === served, served, mine, v };
}

/** Integer square root, rounded rather than floored. Seven lines, off-circuit, and the entire
 *  content of the "needs a rounded BigInt integer square root" blocker. */
export const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
export const rsqrt = (n) => { let s = isqrt(n); if ((s + 1n) * (s + 1n) - n < n - s * s) s += 1n; return s; };

/**
 * Find the narrowest bracket that still pins the published breakeven volatility.
 *
 * @param {number} feeFrac  horizon fees as a fraction of capital, WITHOUT the concentration factor —
 *                          which is what the engine solves against, since conc cancels on both sides.
 * @param {number} T        horizonPeriods
 * @param {number} served   the breakevenVolatility the service published (5 dp)
 * @param {(x:number,dp:number)=>number} round  the ENGINE's rounding function, imported not rewritten
 * @param {number} maxHalvings
 */
export function narrowestBracket(feeFrac, T, served, round, maxHalvings = 200) {
  if (!(feeFrac > 0) || feeFrac >= 1) return null;
  let lo = 0, hi = 1, doublings = 0;
  while (expectedIlNumerical(hi) > -feeFrac) { hi *= 2; doublings++; if (hi > 1e4) return null; }
  for (let k = 1; k <= maxHalvings; k++) {
    const mid = (lo + hi) / 2;
    if (expectedIlNumerical(mid) > -feeFrac) lo = mid; else hi = mid;
    // Stop as soon as the WHOLE bracket rounds to the published figure. Both endpoints, not the
    // midpoint: a bracket whose ends disagree about the answer has not pinned the answer.
    const sLo = Math.sqrt(lo / T), sHi = Math.sqrt(hi / T);
    if (round(sLo, 5) === served && round(sHi, 5) === served) {
      return { lo, hi, halvings: k, doublings, vStar: (lo + hi) / 2 };
    }
  }
  return null;
}

/**
 * Turn a bracket into the circuit's witness, plus everything a gate needs to check it independently.
 * Returns null when the bracket cannot be honestly expressed on the grid — which is a refusal, not
 * an error, and the callers count them.
 */
export function encodeBracket({ feeFrac, T, bracket, servedSigma, TOL_SIG = 2n }) {
  const loHat = toScaled(bracket.lo, 'lo');
  const hiHat = toScaled(bracket.hi, 'hi');
  const feeHat = toScaled(feeFrac, 'feeFrac');

  // The bracket must be at least two grid steps wide, or `lo < hi` is not expressible.
  if (hiHat - loHat < 2n) return { refused: 'bracket narrower than two grid steps' };
  if (feeHat <= 0n || feeHat >= SCALE) return { refused: 'fee fraction outside (0, 1)' };

  // v* is the midpoint ON THE GRID, so the circuit's midpoint residual is 0 or 1 by construction.
  const sum = loHat + hiHat;
  const vStarHat = (sum + 1n) / 2n;

  // σ̂ at full precision from the SNAPPED midpoint, because that is the number the circuit will see.
  // Deriving it from the served 5-dp figure would put the residual where the display rounding is
  // instead of where the root is.
  // σ̂ is the integer that best satisfies the statement the circuit checks, σ̂²·T = v̂*·S — chosen by
  // testing the three candidates around the floor, so it is the true minimiser and not whatever a
  // truncating division happened to land on.
  const N = vStarHat * SCALE, Tb = BigInt(T);
  let sigHat = isqrt(N / Tb);
  {
    const err = (x) => { const d = x * x * Tb - N; return d < 0n ? -d : d; };
    for (const c of [sigHat - 1n, sigHat + 1n, sigHat + 2n]) if (c > 0n && err(c) < err(sigHat)) sigHat = c;
  }
  if (sigHat <= 0n) return { refused: 'breakeven volatility underflows the grid' };

  // L-form of the expectation at each endpoint: L = E[IL] + 1 ∈ (0, 1].
  const eLo = expectedIlNumerical(bracket.lo) + 1;
  const eHi = expectedIlNumerical(bracket.hi) + 1;
  if (!(eLo > 0) || !(eHi > 0) || eLo > 1 || eHi > 1) return { refused: 'endpoint expectation outside (-100%, 0]' };
  const eLoHat = toScaled(eLo, 'eLo');
  const eHiHat = toScaled(eHi, 'eHi');
  if (eLoHat <= 0n || eHiHat <= 0n) return { refused: 'endpoint expectation underflows the grid' };

  // The straddle, in the integers the circuit will compare. Rounding can destroy a straddle whose
  // margin is under half a grid step, and when it does this is a refusal rather than a proof of
  // something else.
  if (!(eLoHat + feeHat > SCALE)) return { refused: 'g(lo) > 0 does not survive the grid' };
  if (!(eHiHat + feeHat <= SCALE)) return { refused: 'g(hi) <= 0 does not survive the grid' };
  if (!(eHiHat <= eLoHat)) return { refused: 'endpoint expectations are not in decreasing order' };

  // The width bound is a POLICY, rounded up to the next power of two in grid steps, so the published
  // slack is a real number rather than always zero.
  let widthHat = 2n;
  while (widthHat < hiHat - loHat) widthHat *= 2n;

  const mid = 2n * vStarHat - loHat - hiHat;
  const Rs = sigHat * sigHat * BigInt(T) - vStarHat * SCALE;
  const sigTol = 2n * (sigHat + 1n) * BigInt(T) + TOL_SIG * SCALE;

  return {
    witness: {
      feeHat: feeHat.toString(), loHat: loHat.toString(), hiHat: hiHat.toString(),
      vStarHat: vStarHat.toString(), eLoHat: eLoHat.toString(), eHiHat: eHiHat.toString(),
      sigHat: sigHat.toString(), horizonT: String(T), widthHat: widthHat.toString(),
    },
    feeHat, loHat, hiHat, vStarHat, eLoHat, eHiHat, sigHat, widthHat, T,
    mid, Rs, sigTol,
    widthSlack: widthHat - (hiHat - loHat),
    sigRatio: Number(Rs < 0n ? -Rs : Rs) * 2 / Number(sigTol),
    certifiedSigma: Number(sigHat) / Number(SCALE),
    servedSigma,
  };
}
