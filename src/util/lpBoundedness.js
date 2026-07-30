// lp-risk boundedness — the check re-evaluated on the EXACT fraction, outside the hashed tree.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
// `src/engine/lpRisk.js` asserts that its reported divergence lies in (-100%, 0], and evaluates that
// assertion on the ROUNDED DISPLAY VALUE:
//
//   const e = out.expectedDivergence.expectedIlPct;            // = round(E[IL] * 100, 4)
//   checks.push({ …, residual: e, pass: e <= 0 && e > -100 });
//
// Once E[IL] <= -0.9999995 the display value is exactly -100 and `-100 > -100` is false. Measured: at
// T = 365 the first total variance that flips it is sigma^2*T = 116.06874041832731 (sigma = 0.5639118274086009),
// and at sigma = 0.62 daily over a year — an ordinary high-vol LP question — the service answers
// `expectedIlPct: -100` with `allSelfChecksPass: false` over a value that is
// -0.9999999758323288, strictly inside the interval the check demands. `src/x402.js` then declines to
// bill it and `src/app.js` tells the buyer their "input [was] rejected by engine". Nothing about the
// arithmetic is wrong; a strict inequality is being asked about a number that has already been rounded
// past it. Disclosed as §5 of the defect register, where it was recorded as unfixable because the check
// lives inside the directory the build hash `q1-e1fa99d08887d6cc` is taken over.
//
// ── WHY IT IS FIXABLE HERE ANYWAY ────────────────────────────────────────────────────────────────
// The register's own §6 records the closed form, derived and verified independently:
//
//   2*sqrt(r)/(1+r) = sech(ln r / 2), and with a = sqrt(v)/2 the argument is a*z - a^2; shifting
//   z = w + a leaves sech(a*w) with the pdf gaining e^{-a*w - a^2/2}; symmetrising w -> -w turns
//   e^{-a*w} into cosh(a*w); cosh*sech == 1.  Therefore  E[IL](v) = exp(-v/8) - 1,  v = sigma^2*T.
//
// So the quantity the engine computes by 401-point quadrature over a local variable has an elementary
// closed form in the INPUTS, which the envelope echoes. Nothing has to be extracted from the engine:
// the exact fraction is recomputed from `proof.inputs` by anyone, here included.
//
// ── L-FORM, WHICH IS THE WHOLE TRICK ─────────────────────────────────────────────────────────────
// Recomputing E[IL] and then testing `> -1` reproduces the defect one significant digit lower down:
// at v = 300, exp(-v/8) is 5.18e-17, `exp(-v/8) - 1` is exactly -1 in IEEE-754 doubles, and the strict
// inequality is lost again — this time to subtraction rather than to `toFixed`. The quantity the strict
// bound is really about is
//
//   L := 1 + E[IL] = exp(-v/8)   in (0, 1],
//
// which is what `Math.exp` returns directly and never rounds to its own boundary until it underflows.
// So the interval test is carried out on L and never on L - 1: `E[IL] in (-1, 0]` becomes `L in (0, 1]`.
// Measured, at conc = 1: the engine's check flips at v = 116.06874041832731 and this one does not flip
// until v > 5961.07, where exp(-v/8) underflows to zero — 51x further out, and there the failure is
// real (see below).
//
// The complement M := -E[IL] = 1 - exp(-v/8) is taken from `Math.expm1`, for the same reason in the
// other regime: for small v, `1 - Math.exp(-v/8)` cancels. The concentration branch needs M, so both
// forms are computed and each is used where it is conditioned.
//
// ── ONE-WAY, AND FAIL-CLOSED ─────────────────────────────────────────────────────────────────────
// Re-deriving an engine expression outside the engine has been wrong three times on this project — a
// `constantproduct` encoder rearranged the same algebra into a numerically different form and was off
// by up to 64 grid steps. So this layer is not allowed to decide anything on its own authority:
//
//   1. it NEVER turns a passing check into a failing one — a check whose `pass` is not literally
//      `false` is returned untouched, so no call that passes today can start failing;
//   2. it overrides `pass: false` only when BOTH the exact fraction is inside the interval AND the
//      recomputation REPRODUCES THE SERVED DIGIT (`round(pct, 4) === the published percentage`).
//      A disagreement means the closed form is not describing the number this response published, and
//      the engine's own verdict stands. That is the direction that cannot invent a pass.
//
// Condition 2 is what keeps the check able to fail. It is not decoration: it is the reason a served
// -200% (the escape-hatch defect `judgeRound2` pins) still goes red — the guarded closed form returns
// -40% there, the digits disagree, and the override is withheld.
//
// MEASURED CONSEQUENCE OF CONDITION 2, disclosed rather than smoothed. The engine's quadrature and the
// closed form differ by a truncation floor belonging to the engine's own |z| <= 6 window — worst
// 1.41912e-9 over 20,001 log-spaced v in [1e-8, 1e4], invariant in N and collapsing to 2.22045e-15
// when the window widens to |z| <= 8. That floor straddles the 4-dp rounding boundary in one narrow
// band: for v in (116.06874041832731, 116.06926190819375) the engine's value rounds to -100 while the
// closed form's rounds to -99.9999, so the digits disagree and the false failure is RETAINED there.
// The band is 5.2149e-4 wide in total variance — 1.3e-6 wide in sigma at T = 365 — and its upper end
// is exactly the closed-form flip -8*ln(5e-7). It is a residual gap, not a fix.
//
// ── WHAT STILL FAILS, AND IT IS REACHABLE ────────────────────────────────────────────────────────
// `{volatility: 100, horizonPeriods: 1}` gives v = 10,000; `exp(-1250)` is 0 in double precision;
// L = 0 is NOT in (0, 1]; the override is withheld and the call keeps its failed check. That is the
// honest verdict: past v ~ 5961.07 there is no representable evidence that the served -100% is inside
// the open interval, the engine's own quadrature has itself saturated to exactly -1, and the number
// being published IS the boundary rather than a rounding of something inside it. Same for a
// non-finite v (`{volatility: 1e200, horizonPeriods: 1e200}`).
//
// ── REPRODUCIBILITY, WHICH THIS CHANGES ──────────────────────────────────────────────────────────
// `selfChecks` sits INSIDE the contentHash preimage, so correcting a `pass` moves the hash of exactly
// the calls that were publishing a false failure — and for those calls, re-running `src/engine/lpRisk.js`
// ALONE no longer reproduces the response. That is stated in the corrected check object itself
// (`reEvaluated.reproduce`) and appended to `proof.reproduce`, both of which name this file. The engine
// hash does not move, because nothing in `src/engine` is touched.
import { round } from '../engine/stats.js';
import { lpRisk } from '../engine/lpRisk.js';
import { proofEnvelope } from '../engine/proof.js';

/** The engine's own input coercions, transcribed from src/engine/lpRisk.js:56, 90, 91. */
const concOf = (i) => (Number(i?.concentrationFactor) > 0 ? Number(i.concentrationFactor) : 1);
const sigmaOf = (i) => (Number(i?.volatility) > 0 ? Number(i.volatility) : null);
const horizonOf = (i) => (Number(i?.horizonPeriods) > 0 ? Number(i.horizonPeriods) : 1);
const ratioOf = (i) => (Number(i?.priceRatio) > 0 ? Number(i.priceRatio) : null);

/**
 * Apply the engine's concentration branch in L-form.
 *
 * The engine multiplies the bounded figure by `conc`, and where that leaves (-100%, 0] it reverts to
 * the unamplified one (lpRisk.js:72-73 and 105-106). `eIlAmplifiedRaw <= -1` is exactly `conc*M >= 1`,
 * so the branch is decided on M without ever forming a difference near -1.
 */
function amplify(lFull, mFull, conc) {
  const ampOut = conc * mFull >= 1;
  const L = ampOut ? lFull : 1 - conc * mFull;
  return { ampOut, L, pct: (L - 1) * 100 };
}

/**
 * E[IL] over the horizon, exactly: L = 1 + E[IL] = exp(-sigma^2*T/8).
 * @returns null when the inputs carry no expected-divergence question.
 */
export function exactExpectedDivergence(input) {
  const sigma = sigmaOf(input);
  if (sigma == null) return null;
  const T = horizonOf(input);
  const conc = concOf(input);
  const v = sigma * sigma * T;                 // lpRisk.js:93, same expression, same order
  const lFull = Math.exp(-v / 8);              // 1 + E[IL], conditioned for L -> 0
  const mFull = -Math.expm1(-v / 8);           // -E[IL],    conditioned for M -> 0
  return { basis: 'E[IL] = exp(-sigma^2*T/8) - 1', totalVariance: v, lFull, mFull, conc, ...amplify(lFull, mFull, conc) };
}

/**
 * Realized IL at a price ratio, exactly: L = 2*sqrt(r)/(1+r), M = (sqrt(r)-1)^2/(1+r).
 * The two are complements by construction — 2*sqrt(r) + (sqrt(r)-1)^2 == 1 + r — and each is free of
 * cancellation where the other is not: L as r -> 0 or infinity, M as r -> 1.
 * @returns null when the inputs carry no realized-IL question.
 */
export function exactRealizedIl(input) {
  const r = ratioOf(input);
  if (r == null) return null;
  const s = Math.sqrt(r);
  const conc = concOf(input);
  const lFull = (2 * s) / (1 + r);
  const mFull = ((s - 1) * (s - 1)) / (1 + r);
  return { basis: 'IL = 2*sqrt(r)/(1+r) - 1', priceRatio: r, lFull, mFull, conc, ...amplify(lFull, mFull, conc) };
}

// The two checks this layer is allowed to touch, each with the published field it ranges over and the
// closed form that recomputes it. Matched on the engine's own wording, the way the tests match it.
const SUBJECTS = [
  {
    re: /^boundedness: reported expected divergence/,
    served: (r) => r?.expectedDivergence?.expectedIlPct,
    exact: exactExpectedDivergence,
    what: 'expected divergence',
  },
  {
    re: /^boundedness: reported realized IL/,
    served: (r) => r?.realizedIL?.impermanentLossPct,
    exact: exactRealizedIl,
    what: 'realized impermanent loss',
  },
];

/**
 * Re-evaluate lp-risk's boundedness checks on the exact fraction.
 *
 * @param  result  the engine's return value
 * @param  input   the inputs the engine was called on — the same object the envelope echoes, so this
 *                 recomputation is one a reader holding the response can perform
 * @returns {{ result: object, corrections: Array<{check: string, servedPct: number, exact: number}> }}
 *          `result` is the identical object when nothing was corrected, so an unaffected call's
 *          contentHash cannot move even by accident.
 */
export function recheckLpBoundedness(result, input) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.checks)) return { result, corrections: [] };
  const corrections = [];
  const checks = result.checks.map((c) => {
    if (!c || c.pass !== false) return c;                  // never touch a check that is not failing
    const subject = SUBJECTS.find((s) => s.re.test(String(c.name || '')));
    if (!subject) return c;
    const servedPct = subject.served(result);
    if (typeof servedPct !== 'number') return c;
    const ex = subject.exact(input);
    if (!ex) return c;
    // (1) the exact fraction must lie in (-1, 0], asserted on L so the strict bound survives, and
    // (2) the recomputation must reproduce the digit this response published.
    const inRange = Number.isFinite(ex.L) && ex.L > 0 && ex.L <= 1;
    const reproducesDigit = round(ex.pct, 4) === servedPct;
    if (!inRange || !reproducesDigit) return c;
    corrections.push({ check: c.name, servedPct, exact: ex.L - 1 });
    return {
      ...c,
      pass: true,
      reEvaluated: {
        by: 'src/util/lpBoundedness.js — outside src/engine, so the build hash does not move',
        why: `the engine evaluates this check on round(value*100, 4), which is exactly ${servedPct} here; a strict "> -100" asked of an already-rounded number fails on a value that is inside the interval`,
        closedForm: ex.basis,
        exactFraction: ex.L - 1,
        aboveMinusOne: ex.L,
        note: `${ex.L} is the exact 1 + ${subject.what}, evaluated directly rather than as a difference from 1, so the strict lower bound is decided on a quantity that never rounds to its own boundary. It is > 0, therefore the value is strictly inside (-100%, 0].`,
        reproducesServedPct: round(ex.pct, 4),
        reproduce: 'This one check is not a function of src/engine alone: re-run the engine on proof.inputs, then apply recheckLpBoundedness(result, inputs) from src/util/lpBoundedness.js. Every other field in this response comes from the engine unchanged.',
      },
    };
  });
  return { result: corrections.length ? { ...result, checks } : result, corrections };
}

/** The result a reproducer must compare against — the engine plus this correction, nothing else. */
export function lpRiskChecked(input) {
  return recheckLpBoundedness(lpRisk(input), input).result;
}

/**
 * The whole served answer: engine, correction, envelope. Used by every surface (paid HTTP, free MCP,
 * SDK) so none of them can publish a different verdict about the same call than the others.
 *
 * The sentence appended to `proof.reproduce` sits in the envelope, which is stripped from the hash
 * preimage, so adding it moves nothing — and it is added only on the calls that were corrected, so an
 * unaffected response is byte-identical to what it was before this file existed.
 */
export function lpRiskEnvelope(input, version = '0') {
  const { result, corrections } = recheckLpBoundedness(lpRisk(input), input);
  const env = proofEnvelope('lp-risk', input, result, version);
  if (corrections.length && env?.proof?.reproduce) {
    env.proof.reproduce += ` NOTE: ${corrections.length} self-check verdict${corrections.length > 1 ? 's were' : ' was'} re-evaluated after the engine ran — see \`selfChecks[].reEvaluated\` — so reproducing this exact result needs the engine AND src/util/lpBoundedness.js. The engine's numbers are untouched.`;
  }
  return env;
}
