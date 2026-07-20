// Martingale Optimal Transport — model-free no-arbitrage bounds across two expiries.
//
// Beiglböck–Henry-Labordère–Penkner (2013), "Model-independent bounds for option prices — a mass transport
// approach". Given the risk-neutral marginals μ (at T₁) and ν (at T₂) of the SAME underlying, the set of
// prices consistent with NO arbitrage for a payoff c(X,Y) is exactly
//
//     inf / sup   E_π[c(X,Y)]   over all MARTINGALE couplings π
//     s.t.  Σ_j π_ij = μ_i ,   Σ_i π_ij = ν_j ,   Σ_j π_ij (y_j − x_i) = 0 ,   π ≥ 0
//
// Everything strictly inside those bounds is a modelling choice; everything outside is an arbitrage. This
// prices a forward-start/calendar payoff WITHOUT choosing a model — the marginals alone pin the range.
//
// ── PRECONDITION (Strassen 1965) ────────────────────────────────────────────────────────────────────
// A martingale coupling exists  ⟺  μ ⪯cx ν  (convex order). Convex order forces EQUAL MEANS, so the two
// marginals must be expressed in martingale coordinates X_T = S_T/F(T), giving E[X_T]=1 at every T.
// For a fitted SVI surface, μ ⪯cx ν is EXACTLY the calendar condition: w(k,T) non-decreasing in T at fixed
// forward-moneyness k. So the precondition is checked on the fitted params — exact, no discretisation.
//
// If it fails there is NO arbitrage-free price for the payoff, and this module REFUSES rather than
// returning a number. Infeasibility is not an error path; it is the result.
//
// ── WHY THE GATE IS THE w-TEST AND NOT A DENSITY COMPARISON ─────────────────────────────────────────
// Measured 2026-07-17: a convex-order gate built from discretised Breeden–Litzenberger densities FLIPPED
// its verdict when the grid changed (1.8d→2.8d read "OK +1.5e-9" on one grid and "VIOLATED −1.9e-4" on
// another) because per-marginal mean-renormalisation rescales each support differently. The exact w-test
// on the fitted params has no such freedom and reproduces the independent calendar scan node-for-node.
import solverPkg from 'javascript-lp-solver';
import { sviW } from './ssvi.js';
import { rndDensity } from './black76.js';

const solver = solverPkg.default || solverPkg;

/** EXACT convex-order gate: w(k,T₂) ≥ w(k,T₁) ∀k ⟺ μ ⪯cx ν ⟺ no calendar arbitrage. */
export function convexOrderExact(P1, P2, { kBand = 0.35, n = 2000 } = {}) {
  let worst = Infinity, at = null;
  for (let i = 0; i <= n; i++) {
    const k = -kBand + (2 * kBand) * i / n;
    const d = sviW(k, P2) - sviW(k, P1);
    if (d < worst) { worst = d; at = k; }
  }
  return { ok: worst >= 0, minDw: worst, atK: at };
}

/** Marginal of X = S_T/F(T) via Breeden–Litzenberger on the fitted smile. */
export function marginalX(P, F, T, { n = 14, lo = 0.86, hi = 1.16 } = {}) {
  const ivFn = (K) => Math.sqrt(Math.max(sviW(Math.log(K / F), P), 1e-12) / T);
  const xs = [], w = [], dx = (hi - lo) / n;
  for (let i = 0; i < n; i++) {
    const x = lo + (i + 0.5) * dx;
    const d = rndDensity(F, x * F, T, ivFn, 0);
    xs.push(x); w.push(d != null && d > 0 ? d * F * dx : 0);
  }
  const mass = w.reduce((a, b) => a + b, 0);
  if (!(mass > 0)) return null;
  const p = w.map((v) => v / mass);
  const mean = xs.reduce((a, x, i) => a + x * p[i], 0);
  const xn = xs.map((x) => x / mean);            // martingale coordinates: E[X]=1
  return { xs: xn, p, mean: xn.reduce((a, x, i) => a + x * p[i], 0) };
}

/** Discrete convex order on the ATOMS: E_mu[(X-k)+] <= E_nu[(X-k)+] at every atom. Exact for these grids. */
export function convexOrderDiscrete(mu, nu) {
  const call = (M, k) => M.xs.reduce((a, x, i) => a + M.p[i] * Math.max(x - k, 0), 0);
  const ks = [...new Set([...mu.xs, ...nu.xs])].sort((a, b) => a - b);
  let worst = Infinity, at = null;
  for (const k of ks) { const d = call(nu, k) - call(mu, k); if (d < worst) { worst = d; at = k; } }
  return { ok: worst >= -1e-12, worst, at };
}

function solveMOT(mu, nu, c, opType) {
  const variables = {}, constraints = {};
  mu.xs.forEach((x, i) => { constraints['row' + i] = { equal: mu.p[i] }; constraints['mart' + i] = { equal: 0 }; });
  nu.xs.forEach((y, j) => { constraints['col' + j] = { equal: nu.p[j] }; });
  mu.xs.forEach((x, i) => nu.xs.forEach((y, j) => {
    const v = { z: c(x, y) }; v['row' + i] = 1; v['col' + j] = 1; v['mart' + i] = y - x;
    variables['p_' + i + '_' + j] = v;
  }));
  const r = solver.Solve({ optimize: 'z', opType, constraints, variables });
  return { feasible: !!r.feasible, value: r.feasible ? r.result : null };
}

/**
 * Model-free bounds for a two-date payoff c(X,Y), X=S_{T1}/F1, Y=S_{T2}/F2.
 * Returns { ok:false, refused:true, ... } when Strassen's precondition fails — by design.
 *
 * SELF-CHECKS (a correct LP must satisfy these EXACTLY, whatever the coupling):
 *   • a payoff depending only on Y  →  sup = inf = E_ν[Y] = 1
 *   • the payoff (Y − X)           →  sup = 0            (the martingale property itself)
 * They are computed on every call and reported; if either fails the bounds are NOT returned.
 */
export function motBounds(P1, F1, T1, P2, F2, T2, payoff, opts = {}) {
  const gate = convexOrderExact(P1, P2, opts);
  if (!gate.ok) {
    return {
      ok: false, refused: true, reason:
        `no martingale coupling exists between T=${T1} and T=${T2}: the fitted marginals violate convex order ` +
        `(min Δw=${gate.minDw.toExponential(2)} at k=${gate.atK.toFixed(3)}). By Strassen this is exactly calendar ` +
        `arbitrage, so NO arbitrage-free price for this payoff exists. Refusing rather than returning a number.`,
      convexOrder: gate,
    };
  }
  // GRID MUST SCALE WITH sigma*sqrt(T), not be hardcoded. A 1.8d BTC smile has sigma*sqrt(T)~1.8%, so its
  // mass lives inside +/-5%; forcing it onto a fixed +/-16% grid leaves ~5 useful cells and injects ~1e-3 of
  // discretisation error into the call prices — enough to destroy convex order for a pair that clears the
  // continuous gate by only 3e-5. Measured on live BTC 2026-07-17.
  const atmSqrtW = (P) => Math.sqrt(Math.max(sviW(0, P), 1e-12));
  const s1 = atmSqrtW(P1), s2 = atmSqrtW(P2);
  const mu = marginalX(P1, F1, T1, { n: opts.nMu ?? 14, lo: opts.muLo ?? Math.exp(-5 * s1), hi: opts.muHi ?? Math.exp(5 * s1) });
  // ν MUST have strictly wider support than μ: a martingale spreads, so each x must lie inside conv(supp ν).
  // Same-grid μ and ν renders the LP infeasible at the extreme atoms — measured, not assumed.
  // nu spans WIDER than mu in sigma units too: a martingale spreads, and every x must sit inside conv(supp nu).
  const nu = marginalX(P2, F2, T2, { n: opts.nNu ?? 20, lo: opts.nuLo ?? Math.exp(-9 * s2), hi: opts.nuHi ?? Math.exp(9 * s2) });
  if (!mu || !nu) return { ok: false, reason: 'could not build marginals from the fitted smiles' };

  // SECOND, DIFFERENT PRECONDITION. convexOrderExact answers "is the SURFACE arbitrage-free?" (continuous,
  // on the fitted params). This answers "does a martingale coupling exist for THESE ATOMS?" (discrete).
  // They are not the same question, and the gap between them is real: measured on live BTC 2026-07-17, the
  // 1.8d→2.8d pair cleared the continuous gate by exactly 3e-5 — the fitter's own cMargin — while the
  // discretised marginals fell OUT of convex order, because BL discretisation error is the same order.
  // The LP was then correctly infeasible. Discretising a barely-ordered pair can destroy the ordering, so
  // the discrete test must be run on the discrete objects rather than inferred from the continuous one.
  const cx = convexOrderDiscrete(mu, nu);
  if (!cx.ok) {
    return {
      ok: false, refused: true, convexOrder: gate, convexOrderDiscrete: cx,
      reason:
        `the fitted surface is calendar-arbitrage-free between T=${T1} and T=${T2}, but only by ` +
        `min Δw=${gate.minDw.toExponential(2)} — and the discretised marginals violate convex order by ` +
        `${cx.worst.toExponential(2)} at k=${cx.at.toFixed(3)}. The two laws are too close to separate at this ` +
        `grid resolution, so no martingale coupling exists for these atoms and no bound can be stated. ` +
        `This is a resolution limit of the discretisation, NOT a claim that the market is arbitrageable.`,
    };
  }

  const eNu = nu.xs.reduce((a, y, j) => a + nu.p[j] * y, 0);
  const chkYmax = solveMOT(mu, nu, (x, y) => y, 'max');
  const chkYmin = solveMOT(mu, nu, (x, y) => y, 'min');
  const chkMart = solveMOT(mu, nu, (x, y) => y - x, 'max');
  const selfChecks = {
    marginalConsistency: chkYmax.feasible && chkYmin.feasible &&
      Math.abs(chkYmax.value - eNu) < 1e-6 && Math.abs(chkYmin.value - eNu) < 1e-6,
    martingaleProperty: chkMart.feasible && Math.abs(chkMart.value) < 1e-6,
  };
  if (!selfChecks.marginalConsistency || !selfChecks.martingaleProperty) {
    return {
      ok: false, refused: true, selfChecks,
      reason: 'the transport LP failed its own exact self-checks (a Y-only payoff must return E_ν[Y] and E[Y−X] must be 0); ' +
        'the bounds would be meaningless, so they are not returned',
    };
  }
  const lo = solveMOT(mu, nu, payoff, 'min');
  const hi = solveMOT(mu, nu, payoff, 'max');
  if (!lo.feasible || !hi.feasible) return { ok: false, refused: true, selfChecks, reason: 'transport problem infeasible at the requested payoff' };
  return {
    ok: true, lower: lo.value, upper: hi.value, width: hi.value - lo.value,
    convexOrder: gate, selfChecks,
    interpretation: 'any price strictly inside [lower, upper] is consistent with the observed smiles and requires a model to pin down; ' +
      'any price outside is an arbitrage against the two fitted marginals alone',
  };
}
