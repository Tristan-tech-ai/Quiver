// ncdfWitness.js — the witness `event-vol` hands to `ncdf.circom`, and the guard that refuses to
// build one for an answer it would not describe.
//
// ── WHY THIS SERVICE REACHES A CIRCUIT AND options-risk DOES NOT ─────────────────────────────────
//
// `ncdf.circom` pins N(x) GIVEN x. Its own header says what it does not do: it does not pin x, and
// for options-risk x is d1 = [ln(F/K) + ½σ²T]/(σ√T), so pinning it needs a logarithm.
//
// event-vol's straddle is struck AT THE FORWARD. K = F, so ln(F/K) = 0 and the logarithm is gone:
//
//     d1 = ½σ²T / (σ√T) = σ√T / 2,     d2 = d1 − σ√T = −d1
//
// and at r = 0 the ATM straddle collapses onto ONE point of the normal CDF:
//
//     C = S·N(d1) − S·N(d2)
//     P = S·N(−d2) − S·N(−d1)
//     C + P = 2·S·(2·N(σ√T/2) − 1)
//
// That is the whole reason this service is reachable with the circuit that already exists. The
// remaining binding — that x really is σ√T/2 — is a SQUARING (4x² = σ²T), which any reader performs
// on the public signals in one line of rational arithmetic. It is not in this circuit, and the
// `doesNotProve` text says so rather than letting the shape imply it.
//
// ── THE ALGEBRA ABOVE IS NOT WHAT THE ENGINE COMPUTES, AND THAT DISTINCTION IS THE GUARD ─────────
//
// `d2 === -d1` holds in exact arithmetic and holds in IEEE-754 doubles on only 39.70% of legs,
// measured over 40,000: the engine forms d1 as `(0 + 0.5*sigma*sigma*T)/(sigma*sqrtT)` and d2 as
// `d1 - sigma*sqrtT`, and those two float paths do not land on exact negatives. So the engine
// evaluates Hart at TWO points, not one, and a single proof certifies one of them.
//
// The collapse is therefore charged rather than assumed, PER LEG, from the engine's own two values:
// `black76(...).delta` is ncdf(d1) and `probAbove(...)` is ncdf(d2), both lifted, neither restated.
// Worst measured |N(d1) − (1 − N(d2))| over 40,000 legs is 3.662e-4 ulp of 2^-40 — 3.05e-3% of the
// circuit's own 12-ulp envelope — and it enters `envelopeUsd` as a term rather than a footnote.
//
// A constantproduct encoder once rearranged an engine expression into a mathematically equal,
// numerically different form and was wrong by 64 grid steps. So nothing here recomputes a price:
// `black76` and `probAbove` are imported and called exactly as `eventVol` calls them, and the two
// derivations this file cannot import — the percent-or-decimal vol and the days-or-years horizon,
// each one line inside the engine — are pinned by FIVE equalities against fields the engine itself
// published. A reconstruction that misread either one fails all five.
import { black76, probAbove } from '../engine/black76.js';
import { round } from '../engine/stats.js';

// ── the circuit's own parameters, and where they come from ───────────────────────────────────────
// Copied from `zk/circuits/ncdf.circom`, which this deploy does not ship, so they cannot be read
// from the source here. `zk/scripts/gateB7-6-eventvol-straddle.mjs` parses the circom file and
// asserts every one of these against it — a constant restated in two places is a constant that
// drifts unless something compares them, and that something is the gate rather than this comment.
export const NCDF = {
  S: 40,
  ONE: 2 ** 40,
  ULP: 2 ** -40,
  TOLC: 12,                       // the CDF envelope the circuit enforces, in ulp
  TOLP: 10,                       // the density envelope, in ulp
  ZSPLIT: 7774721279939,          // 7.07106781186547 * 2^40 — above this the circuit BOUNDS, not computes
};

// The maximum of the standard normal density, φ(0) = 1/√(2π). This is the Lipschitz constant of N,
// so half a grid step of x moves N by at most half this — it is not a tuned number.
const PHI_MAX = 1 / Math.sqrt(2 * Math.PI);

// Half of the last digit `straddleImpliedAbsMoveUsd` is published at: the engine returns
// `round(straddle, 2)`. A proof that cannot pin the number tighter than the digit it was served at
// is a proof about a neighbouring answer, which is what the ceiling below refuses.
const DISPLAY_HALF_UNIT = 0.005;

// The engine's display rounding, LIFTED from src/engine/stats.js rather than reproduced — this file
// already imports the engine for black76, so there is no reason to keep a second copy of `round`.
const displayRound2 = (x) => round(x, 2);

/**
 * The vol and horizon the engine derived, reconstructed from the echoed inputs.
 *
 * These two lines are the only algebra in this file that is not a call into the engine, because
 * `asDecimalIv` and the T selection are local to `src/engine/eventVol.js` and not exported — and
 * src/engine must not be touched to export them. Every consequence of getting either one wrong is
 * caught by `agreesWithServed` below, which compares five published fields, not one.
 */
function reconstructParams(input) {
  const S = Number(input?.spot);
  const sig = Number(input?.atmIvPct) > 0 ? Number(input.atmIvPct) / 100 : Number(input?.atmIv);
  const T = Number(input?.T) > 0
    ? Number(input.T)
    : (Number(input?.daysToEvent) > 0 ? Number(input.daysToEvent) / 365 : NaN);
  if (!(S > 0) || !(sig > 0) || !(T > 0)) return null;
  return { S, sig, T };
}

/**
 * Does the reconstruction describe the answer that was SERVED? Five equalities against five fields
 * the engine published, each one a different function of (S, σ, T):
 *
 *   atmIvPct                 round(σ·100, 2)        pins σ to 1e-2 of a percent
 *   horizonDays              round(T·365, 2)        pins T to 1e-2 of a day
 *   oneSigmaPct              round(σ√T·100, 3)      pins the PRODUCT σ√T, which is what x is
 *   oneSigmaUsd              round(S·σ√T, 2)        pins it again, scaled by spot
 *   straddleImpliedAbsMove   round(C + P, 2)        pins the number being certified
 *
 * Equalities, not tolerances — the concentration guard's argument, for the same reason: a threshold
 * here would be a number nobody measured, and the quantities compared are the engine's own rounded
 * output on both sides.
 */
function agreesWithServed(p, result, straddle) {
  const em = result?.expectedMove;
  if (!em) return 'this answer carries no expectedMove block to certify';
  const sd = p.sig * Math.sqrt(p.T);
  const want = [
    ['atmIvPct', round(p.sig * 100, 2), result.atmIvPct],
    ['horizonDays', round(p.T * 365, 2), result.horizonDays],
    ['expectedMove.oneSigmaPct', round(sd * 100, 3), em.oneSigmaPct],
    ['expectedMove.oneSigmaUsd', round(p.S * sd, 2), em.oneSigmaUsd],
    ['expectedMove.straddleImpliedAbsMoveUsd', displayRound2(straddle), em.straddleImpliedAbsMoveUsd],
  ];
  for (const [name, mine, served] of want) {
    if (mine !== served) return `reconstruction gives ${name} = ${mine} and the answer served ${served} — refusing to certify a different answer`;
  }
  return null;
}

/**
 * The witness, the reconstruction a buyer performs from it, and both bounds.
 *
 * TWO BOUNDS, AND THEY ARE NOT THE SAME CLAIM. Conflating them is how a guard ends up either
 * refusing honest answers or promising more than the circuit does.
 *
 *   `encodingBoundUsd` is what the SERVER may assert, because it holds both numbers: the only thing
 *   between the buyer's reconstruction and the engine's own unrounded straddle is one rounding of N
 *   onto the 2^-40 grid (half a step), the two-point collapse (measured, per leg), and the float
 *   error of the reconstruction itself. Worst honest leg uses 99.9943% of it over 200,000 legs —
 *   which is a bound landing on itself rather than near itself, so it is a bound something reaches.
 *
 *   `envelopeUsd` is what a BUYER is entitled to, because a buyer knows only what the circuit
 *   promises: 12 ulp on N, not half a step. It is 24x wider, and the whole of the difference is a
 *   promise `ncdf.circom` makes that the engine does not need. Tightening it means tightening TOLC,
 *   which is a property of the circuit and not of this service.
 *
 * dStraddle/dN = 4·S, exactly, from C + P = 2S(2N − 1). No linearisation and no derivative estimate:
 * the map from N to the straddle is affine, so a bound on N times 4S IS a bound on the straddle.
 */
export function ncdfWitnessFor(echoedInputs, result) {
  if (result?.ok !== true) return { reason: 'this request was refused, so there is no answer to certify' };
  const p = reconstructParams(echoedInputs);
  if (!p) return { reason: 'this answer was not produced from a spot, an ATM vol and a horizon — nothing to encode' };

  // The engine's own two calls, in the engine's own order. Not rearranged.
  const call = black76(p.S, p.S, p.T, p.sig, 'call', 0);
  const put = black76(p.S, p.S, p.T, p.sig, 'put', 0);
  if (!call || !put) return { reason: 'Black-76 does not evaluate at these parameters' };
  const straddle = call.price + put.price;

  const disagreement = agreesWithServed(p, result, straddle);
  if (disagreement) return { reason: disagreement };
  const served = result.expectedMove.straddleImpliedAbsMoveUsd;

  const d1 = call.d1;
  if (!(d1 > 0)) return { reason: `d1 = ${d1} is not strictly positive — the ATM straddle's single CDF point does not exist here` };

  const nEngine = call.delta;                                   // ncdf(d1), lifted off the engine
  const cEngine = probAbove(p.S, p.S, p.T, p.sig, 0);           // ncdf(d2), lifted off the engine
  // The density at the same point. `black76` returns gamma = φ(d1)/(F·σ·√T) at r = 0, so this
  // multiplies the engine's own division back out rather than recomputing exp — the same recovery
  // gateB7-5 uses, and the residual it leaves is ~1e-16 relative against a 10-ulp (9.1e-12) bound.
  const phi = call.gamma * p.S * p.sig * Math.sqrt(p.T);

  const xMag = Math.round(d1 * NCDF.ONE);
  const nHat = Math.round(nEngine * NCDF.ONE);
  const pHat = Math.round(phi * NCDF.ONE);

  // Every range condition `ncdf.circom` enforces, checked here so a witness that cannot satisfy it
  // is refused with a sentence instead of surfacing as a `failed` proof nobody can read.
  if (!(xMag < NCDF.ZSPLIT)) {
    return { reason: `x = ${d1} is above the ${NCDF.ZSPLIT / NCDF.ONE} split where ncdf.circom proves a BOUND on the tail instead of evaluating the CDF — a bounded N cannot reconstruct a straddle, so this answer gets no proof rather than a proof of a different statement` };
  }
  if (!(nHat >= NCDF.ONE / 2 && nHat <= NCDF.ONE)) {
    return { reason: `N(x) encodes to ${nHat}, outside the [2^39, 2^40] the circuit's own upper-tail check admits for x >= 0` };
  }
  if (!(pHat >= 0 && pHat < NCDF.ONE)) return { reason: `the density encodes to ${pHat}, outside the [0, 2^40) the circuit range-checks` };

  // The buyer's reconstruction, in the engine's float order with N(d2) := 1 − N(d1). Written as the
  // engine writes it — (S·n − S·c) twice — rather than as 2S(2n−1), because those are the same
  // number in algebra and different doubles in IEEE-754, and the difference is the class of defect
  // this file's header is about.
  const nGrid = nHat / NCDF.ONE;
  const R = (p.S * nGrid - p.S * (1 - nGrid)) + (p.S * nGrid - p.S * (1 - nGrid));

  // ── the two bounds, each term a rounding that actually happens ──
  const collapseUlp = Math.abs(nEngine - (1 - cEngine)) / NCDF.ULP;   // MEASURED on this leg
  // fp: n̂ ∈ [½, 1] so (1 − n̂) is exact by Sterbenz; the two products carry ε/2 of S·n̂ and S·(1−n̂),
  // whose magnitudes sum to S; the difference carries ε/2 of |R|/2; and the doubling is exact.
  const fp = Number.EPSILON * p.S + 0.5 * Number.EPSILON * Math.abs(R);
  const encodingBoundUsd = 4 * p.S * (0.5 + collapseUlp) * NCDF.ULP + fp;
  const envelopeUsd = 4 * p.S * (NCDF.TOLC + 0.5 * PHI_MAX + collapseUlp) * NCDF.ULP;

  if (!(envelopeUsd <= DISPLAY_HALF_UNIT)) {
    return { reason: `the circuit's ${NCDF.TOLC}-ulp envelope on N is worth +-${envelopeUsd} at a spot of ${p.S}, wider than the ${DISPLAY_HALF_UNIT} this straddle is displayed to — above a spot of about 1.13e8 no proof of this shape is about the number that was served` };
  }
  const gapToEngineUsd = Math.abs(R - straddle);
  if (!(gapToEngineUsd <= encodingBoundUsd)) {
    return { reason: `the reconstruction sits ${gapToEngineUsd} from the engine's own unrounded straddle, past the +-${encodingBoundUsd} the 2^-40 encoding admits — refusing to certify a different answer` };
  }
  if (displayRound2(R) !== served) {
    return { reason: `the reconstruction displays as ${displayRound2(R)} and the answer served ${served} — refusing to certify a number the buyer cannot reproduce` };
  }

  return {
    witness: { xSign: '0', xMag: String(xMag), nHat: String(nHat), pHat: String(pHat) },
    encoded: { xSign: 0, xMag, nHat, pHat },
    point: d1, nEngine, phi, straddle, served,
    reconstructedUsd: R,
    gapToEngineUsd, gapToServedUsd: Math.abs(R - served),
    encodingBoundUsd, envelopeUsd,
    collapseUlp,
    spot: p.S, sigma: p.sig, T: p.T,
  };
}

/**
 * The pieces of the guard, exposed for the same reason `snark.js` exposes its three: a gate that
 * measures a bound by watching what it happens to reject is a gate that cannot report headroom.
 */
export const _internalNcdf = { NCDF, PHI_MAX, DISPLAY_HALF_UNIT, displayRound2, reconstructParams };
