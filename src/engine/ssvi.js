// SSVI — arbitrage-free implied-volatility surface (Gatheral & Jacquier, "Arbitrage-free SVI volatility
// surfaces", arXiv:1204.0646). Formulas taken from the paper, not from memory:
//
//   w(k, θt) = (θt/2)·{ 1 + ρ·φ(θt)·k + √( (φ(θt)·k + ρ)² + (1 − ρ²) ) }        (SSVI)
//   φ(θ)     = η·θ^(−γ),  η > 0, 0 < γ < 1                                        (power-law)
//   Butterfly (Thm 4.2, sufficient):  θφ(θ)(1+|ρ|) < 4   and   θφ(θ)²(1+|ρ|) ≤ 4
//   Calendar  (Thm 4.1):  ∂t θt ≥ 0  and  0 ≤ ∂θ(θφ(θ)) ≤ (1/ρ²)(1+√(1−ρ²))·φ(θ)
//
// WHY SSVI (not raw 5-param SVI per slice): our live Deribit slices are sparse (front expiry can have a
// single in-band strike; 1d≈10, 2d≈14). A 5-param-per-slice fit would overfit. SSVI has w(0,θ)=θ, so θt
// is the DIRECTLY OBSERVED ATM total variance — not fitted — leaving just 3 GLOBAL params (ρ, η, γ)
// shared across every slice. Dozens of points for 3 parameters: robust, not overfit.
//
// The no-arbitrage inequalities are enforced as penalties INSIDE the objective, so a converged fit is
// arbitrage-free BY CONSTRUCTION. A fit that fails the quality gate is REJECTED (caller falls back to the
// disclosed interpolation) — a silently mis-converged surface is worse than an honest imperfect one.
import { round } from './stats.js';

export const phiPowerLaw = (theta, eta, gamma) => eta * Math.pow(theta, -gamma);

// SSVI total implied variance at log-moneyness k.
export function ssviW(k, theta, rho, phi) {
  const x = phi * k + rho;
  const disc = x * x + (1 - rho * rho);
  if (!(disc >= 0) || !(theta > 0)) return null;
  return (theta / 2) * (1 + rho * phi * k + Math.sqrt(disc));
}

// Butterfly conditions (Thm 4.2). Returns the two slack values; both must be satisfied.
export function butterflySlack(theta, phi, rho) {
  const a = theta * phi * (1 + Math.abs(rho));          // must be < 4
  const b = theta * phi * phi * (1 + Math.abs(rho));    // must be <= 4
  return { c1: a, c2: b, ok: a < 4 && b <= 4 };
}

// ---- Nelder–Mead (derivative-free; 3 unconstrained params mapped to the admissible set) ----
function nelderMead(f, x0, { maxIter = 600, tol = 1e-10 } = {}) {
  const n = x0.length;
  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += (p[i] !== 0 ? 0.15 * Math.abs(p[i]) : 0.15); simplex.push(p); }
  let fv = simplex.map(f);
  const order = () => { const idx = fv.map((v, i) => i).sort((a, b) => fv[a] - fv[b]); return { s: idx.map((i) => simplex[i]), f: idx.map((i) => fv[i]) }; };
  for (let iter = 0; iter < maxIter; iter++) {
    const o = order();
    for (let i = 0; i <= n; i++) { simplex[i] = o.s[i]; fv[i] = o.f[i]; }
    if (Math.abs(fv[n] - fv[0]) < tol) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const refl = centroid.map((c, j) => c + 1.0 * (c - simplex[n][j]));
    const fr = f(refl);
    if (fr < fv[0]) {
      const exp = centroid.map((c, j) => c + 2.0 * (c - simplex[n][j]));
      const fe = f(exp);
      if (fe < fr) { simplex[n] = exp; fv[n] = fe; } else { simplex[n] = refl; fv[n] = fr; }
    } else if (fr < fv[n - 1]) { simplex[n] = refl; fv[n] = fr; }
    else {
      const con = centroid.map((c, j) => c + 0.5 * (simplex[n][j] - c));
      const fc = f(con);
      if (fc < fv[n]) { simplex[n] = con; fv[n] = fc; }
      else { for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); fv[i] = f(simplex[i]); } }
    }
  }
  const o = order();
  return { x: o.s[0], f: o.f[0] };
}

const unpack = (p) => ({ rho: Math.tanh(p[0]), eta: Math.exp(p[1]), gamma: 1 / (1 + Math.exp(-p[2])) });

const unpack2 = (p) => ({ rho: Math.tanh(p[0]), phi: Math.exp(p[1]) });

// ---------- RAW SVI slice (Gatheral) — used when SSVI's 2-param slice is too rigid ----------
// w(k) = a + b{ ρ(k−m) + √((k−m)² + σ²) }        with b≥0, |ρ|<1, σ>0
// Analytic derivatives (needed for g(k)):
//   w'(k)  = b{ ρ + (k−m)/√((k−m)²+σ²) }
//   w''(k) = b·σ² / ((k−m)²+σ²)^{3/2}
export const sviW = (k, P) => { const x = k - P.m; const s = Math.sqrt(x * x + P.sig * P.sig); return P.a + P.b * (P.rho * x + s); };
const sviW1 = (k, P) => { const x = k - P.m; const s = Math.sqrt(x * x + P.sig * P.sig); return P.b * (P.rho + x / s); };
const sviW2 = (k, P) => { const x = k - P.m; const s2 = x * x + P.sig * P.sig; return P.b * P.sig * P.sig / Math.pow(s2, 1.5); };

// Gatheral–Jacquier Lemma 2.2: butterfly-arbitrage-free ⟺ g(k) ≥ 0 ∀k AND lim_{k→∞} d₊(k) = −∞.
//   g(k) = (1 − k·w'(k)/(2w(k)))² − (w'(k)²/4)(1/w(k) + 1/4) + w''(k)/2
// The second condition is equivalent to the Roger-Lee wing bound b(1+|ρ|) < 2.
export function sviG(k, P) {
  const w = sviW(k, P); if (!(w > 0)) return -1;
  const w1 = sviW1(k, P), w2 = sviW2(k, P);
  const t1 = 1 - (k * w1) / (2 * w);
  return t1 * t1 - (w1 * w1 / 4) * (1 / w + 0.25) + w2 / 2;
}
const sviWingOk = (P) => P.b * (1 + Math.abs(P.rho)) < 2;
const unpack5 = (p) => ({ a: p[0], b: Math.exp(p[1]), rho: Math.tanh(p[2]), m: p[3], sig: Math.exp(p[4]) });

/**
 * Fit RAW SVI per slice with no-arbitrage enforced inside the objective:
 *  - g(k) ≥ 0 on a grid (butterfly, Lemma 2.2)
 *  - b(1+|ρ|) < 2 (Roger-Lee wing bound ⇔ lim d₊ = −∞)
 *  - w(k) > 0
 * 5 params against 20–45 strikes per slice — flexible enough for short-dated crypto smiles, where the
 * 2-param SSVI slice was measured to be too rigid (RMSE 5.8 vol pts on the front expiries).
 */
export function fitSVI(slices, { maxRmseVolPts = 1.5, kBand = 0.35, minPtsPerSlice = 6, minTdays = 1.5, gMargin = 1e-3, cMargin = 3e-5 } = {}) {
  // Penalty grid is DELIBERATELY finer than the fit needs, and the reported minima are measured on a
  // DENSE grid that the optimiser never sees. Scoring a constraint on the same nodes it was trained on
  // makes the check unfalsifiable: the optimiser satisfies g(k)≥0 at the nodes and dips negative between
  // them. Measured on the shipped 12-node grid: reported minG=+9.9e-8 while the true minimum was -1.7e-3
  // (butterfly arbitrage across 4.2% of the band). Penalty grid and audit grid must never coincide.
  const pgrid = []; for (let x = -kBand; x <= kBand + 1e-9; x += kBand / 150) pgrid.push(x);
  const dense = []; for (let x = -kBand; x <= kBand + 1e-9; x += kBand / 1500) dense.push(x);
  // Slices must be fitted in ascending T: each accepted slice becomes the CALENDAR FLOOR for the next.
  const inOrder = (slices || []).filter((s) => s.T > 0 && Array.isArray(s.pts)).slice().sort((a, b) => a.T - b.T);
  let floorP = null;
  const perSlice = inOrder.map((s) => {
    const floor = floorP;
    // SCOPE THE MODEL TO WHERE IT IS VALID. Near-expiry smiles are JUMP-dominated, not diffusive; SVI is a
    // diffusive parameterisation and cannot describe them (measured: RMSE 5.1–7.4 vol pts at ~15 min and
    // ~1 day to expiry, versus 0.1–1.2 at ≥2 days — the signature of jump dominance decaying with T).
    // Forcing a fit there would be model misuse, so those slices are EXCLUDED by design and never served.
    if (s.T * 365 < minTdays) return { T: round(s.T, 5), ok: false, n: (s.pts || []).length, excluded: true, reason: `near-expiry (${round(s.T * 365, 2)}d): jump-dominated regime — a diffusive SVI smile is not applicable, so this slice is excluded by design rather than force-fitted` };
    const pts = s.pts.filter((q) => Number.isFinite(q.k) && Math.abs(q.k) <= kBand && q.sigma > 0);
    if (pts.length < minPtsPerSlice) return { T: round(s.T, 5), ok: false, n: pts.length, reason: `only ${pts.length} liquid strikes within |k|<=${kBand}` };
    const objective = (p) => {
      const P = unpack5(p);
      if (!(P.b > 0) || !(P.sig > 0) || !Number.isFinite(P.a)) return 1e12;
      let pen = 0;
      if (!sviWingOk(P)) pen += 1e6 * Math.max(0, P.b * (1 + Math.abs(P.rho)) - 1.99);
      for (const k of pgrid) {
        const w = sviW(k, P);
        if (!(w > 0)) { pen += 1e6; continue; }
        const g = sviG(k, P);
        // LINEAR, not quadratic. A quadratic penalty on a one-sided constraint makes small violations
        // nearly free: at g=-7e-5 the old 1e4*g² cost 4.9e-5 — less than a single quote's fit error — so
        // the optimiser settled ON and just under the boundary. Linear keeps the gradient steep at zero,
        // and gMargin buys strict interior feasibility rather than boundary-hugging.
        if (g < gMargin) pen += 1e6 * (gMargin - g);
        // CALENDAR: w(k,T) must be non-decreasing in T at fixed k (Gatheral). Fitting slices independently
        // leaves this unconstrained, and sviIvFnAtT's linear-in-T interpolation is only calendar-arb-free
        // if its bracketing anchors are themselves ordered — a precondition nothing previously enforced.
        if (floor) { const d = w - (sviW(k, floor) + cMargin); if (d < 0) pen += 1e6 * (-d); }
      }
      let sse = 0;
      for (const q of pts) {
        const w = sviW(q.k, P);
        if (!(w > 0)) { sse += 1e4; continue; }
        sse += (Math.sqrt(w / s.T) - q.sigma) ** 2;
      }
      return sse + pen;
    };

    const th = s.theta > 0 ? s.theta : Math.max(1e-6, pts[0].sigma ** 2 * s.T);
    const starts = [
      [th * 0.5, Math.log(th * 2 + 1e-4), 0, 0, Math.log(0.1)],
      [th * 0.2, Math.log(0.05), -0.5, 0, Math.log(0.05)],
      [th * 0.8, Math.log(0.2), 0.2, 0.02, Math.log(0.2)],
      [1e-4, Math.log(0.02), -0.8, -0.02, Math.log(0.02)],
      [th, Math.log(0.5), -0.3, 0, Math.log(0.3)],
    ];
    let best = null;
    for (const s0 of starts) { const r = nelderMead(objective, s0, { maxIter: 900 }); if (!best || r.f < best.f) best = r; }
    const P = unpack5(best.x);

    let sse = 0; for (const q of pts) { const w = sviW(q.k, P); if (!(w > 0)) continue; sse += (Math.sqrt(w / s.T) - q.sigma) ** 2; }
    const rmseVolPts = round(Math.sqrt(sse / pts.length) * 100, 2);
    // AUDIT THE ARTIFACT THAT SHIPS. The guarantee must hold for the params the caller actually receives,
    // not for the full-precision optimum we happen to hold in memory. Rounding b to 4dp perturbs w by
    // ~1.5e-5 — enough to flip a marginal butterfly/calendar constraint — so a fit verified on P and served
    // as round(P) is verified on an object nobody ever sees. Round FIRST, then audit, then floor on the
    // rounded slice, so every check and every downstream consumer sees one and the same surface.
    const shipped = { a: round(P.a, 8), b: round(P.b, 8), rho: round(P.rho, 8), m: round(P.m, 8), sig: round(P.sig, 8) };
    // Audited on the DENSE grid, never the penalty grid.
    let minG = Infinity; for (const k of dense) { const g = sviG(k, shipped); if (g < minG) minG = g; }
    let calMinDw = null;
    if (floor) { calMinDw = Infinity; for (const k of dense) { const d = sviW(k, shipped) - sviW(k, floor); if (d < calMinDw) calMinDw = d; } }
    const calendarOk = calMinDw === null || calMinDw >= 0;
    const noArb = minG >= 0 && sviWingOk(shipped) && calendarOk;
    const ok = rmseVolPts <= maxRmseVolPts && noArb;
    if (ok) floorP = shipped;   // floor the next expiry on the SHIPPED slice, not the in-memory optimum
    return {
      T: round(s.T, 5), n: pts.length, ok, rmseVolPts,
      params: { a: shipped.a, b: shipped.b, rho: shipped.rho, m: shipped.m, sigma: shipped.sig },
      butterflyMinG: Number(minG.toExponential(2)), wingBoundOk: sviWingOk(P),
      calendarMinDw: calMinDw === null ? null : Number(calMinDw.toExponential(2)), calendarOk,
      reason: ok ? undefined : (!noArb ? `no-arbitrage violated (min g(k)=${minG.toExponential(2)}, wing bound ${sviWingOk(P) ? 'ok' : 'breached'}, calendar ${calendarOk ? 'ok' : `breached: min Δw=${calMinDw.toExponential(2)}`})` : `RMSE ${rmseVolPts} vol pts exceeds the ${maxRmseVolPts} gate`),
    };
  });
  const fitted = perSlice.filter((s) => s.ok);
  return {
    ok: fitted.length > 0, model: 'raw-SVI',
    slicesFitted: fitted.length, slicesTotal: perSlice.length,
    meanRmseVolPts: fitted.length ? round(fitted.reduce((a, s) => a + s.rmseVolPts, 0) / fitted.length, 2) : null,
    kBand, perSlice,
    method: 'Raw SVI per slice (Gatheral): w(k)=a+b{ρ(k−m)+√((k−m)²+σ²)}. No-arbitrage is enforced INSIDE the objective — g(k)≥0 on a log-moneyness grid (Gatheral–Jacquier Lemma 2.2, butterfly) and the Roger-Lee wing bound b(1+|ρ|)<2 (equivalent to lim d₊=−∞) — so an accepted slice is arbitrage-free by construction. Nelder–Mead, multi-start, deep wings trimmed to |k|≤kBand. A slice failing the RMSE or no-arb gate is REJECTED and falls back to disclosed interpolation.',
    reason: fitted.length ? undefined : 'no slice passed the fit-quality gate',
  };
}

export function sviIvFn(fit, F, T) {
  if (!fit || !Array.isArray(fit.perSlice) || !(T > 0) || !(F > 0)) return null;
  const s = fit.perSlice.find((x) => x.ok && Math.abs(x.T - T) < 1e-4);
  if (!s) return null;
  const P = { a: s.params.a, b: s.params.b, rho: s.params.rho, m: s.params.m, sig: s.params.sigma };
  return (K) => { if (!(K > 0)) return null; const w = sviW(Math.log(K / F), P); return w > 0 ? Math.sqrt(w / T) : null; };
}

const sviParams = (s) => ({ a: s.params.a, b: s.params.b, rho: s.params.rho, m: s.params.m, sig: s.params.sigma });

// σ(K) at an ARBITRARY expiry T by LINEAR-IN-T interpolation of TOTAL VARIANCE w=σ²T between the two
// bracketing fitted slices — the calendar-arbitrage-free way to price a date that is not a listed expiry
// (a flat σ or a nearest-expiry snap both admit calendar arbitrage; w must be non-decreasing in T at fixed
// moneyness, which linear-in-T interpolation of w preserves). Outside the fitted range we hold σ flat
// across the (short) gap — a disclosed extrapolation, never a fabricated term structure.
// Returns { fn, basis, tenorDays:{lo,hi} } or null when no slice is usable.
export function sviIvFnAtT(fit, F, T) {
  if (!fit || !Array.isArray(fit.perSlice) || !(T > 0) || !(F > 0)) return null;
  const oks = fit.perSlice.filter((x) => x.ok).sort((a, b) => a.T - b.T);
  if (!oks.length) return null;
  let lo = null, hi = null;
  for (const s of oks) { if (s.T <= T + 1e-9) lo = s; }
  for (let i = oks.length - 1; i >= 0; i--) { if (oks[i].T >= T - 1e-9) hi = oks[i]; }
  if (lo && hi && Math.abs(hi.T - lo.T) > 1e-9) {
    const Pa = sviParams(lo), Pb = sviParams(hi), wgt = (T - lo.T) / (hi.T - lo.T);
    const fn = (K) => {
      if (!(K > 0)) return null;
      const k = Math.log(K / F);
      const wa = sviW(k, Pa), wb = sviW(k, Pb);
      if (!(wa > 0) || !(wb > 0)) return null;
      const wt = wa + (wb - wa) * wgt;            // total variance, linear in T (calendar-arb-free)
      return wt > 0 ? Math.sqrt(wt / T) : null;   // → implied vol at target T
    };
    return { fn, basis: 'interpolated', tenorDays: { lo: round(lo.T * 365, 2), hi: round(hi.T * 365, 2) } };
  }
  // target outside the fitted maturity range → hold σ flat across the gap (disclosed extrapolation)
  const s = hi || lo, P = sviParams(s);
  const fn = (K) => { if (!(K > 0)) return null; const w = sviW(Math.log(K / F), P); return w > 0 ? Math.sqrt(w / s.T) : null; };
  return { fn, basis: 'flat-extrapolated', tenorDays: { lo: round(s.T * 365, 2), hi: round(s.T * 365, 2) } };
}

/**
 * Fit SSVI SLICE-BY-SLICE (the robust arbitrage-free calibration the literature recommends — Corbetta,
 * Cohort, Laachir & Martini, "Robust calibration and arbitrage-free interpolation of SSVI slices",
 * arXiv:1804.04924; global no-arb parametrization in Mingone, arXiv:2204.00312). Each expiry gets its own
 * (ρ, φ) with θ OBSERVED — 2 free parameters against 10–40 strikes, so no overfitting — instead of
 * forcing ONE global (ρ, η, γ) to span every maturity at once (measured: that is over-constrained,
 * RMSE 4.6–8.8 vol pts on live chains, and correctly rejected by the gate).
 *
 * Deep wings are trimmed to a liquid moneyness band before fitting: far-OTM Deribit marks are stale/wide
 * and are noise, not signal. The band is disclosed, not hidden.
 *
 * @param slices [{ T, theta, pts:[{k, sigma}] }]  theta = OBSERVED ATM total variance (σ_atm²·T)
 */
export function fitSSVI(slices, { maxRmseVolPts = 1.5, kBand = 0.35, minPtsPerSlice = 5 } = {}) {
  const out = (slices || [])
    .filter((s) => s.theta > 0 && s.T > 0 && Array.isArray(s.pts))
    .map((s) => {
      const pts = s.pts.filter((q) => Number.isFinite(q.k) && Math.abs(q.k) <= kBand && q.sigma > 0);
      if (pts.length < minPtsPerSlice) return { T: round(s.T, 5), theta: round(s.theta, 6), ok: false, n: pts.length, reason: `only ${pts.length} liquid strikes within |k|<=${kBand}` };

      const objective = (p) => {
        const { rho, phi } = unpack2(p);
        if (!Number.isFinite(phi) || phi <= 0) return 1e12;
        let sse = 0;
        const bf = butterflySlack(s.theta, phi, rho);
        if (bf.c1 >= 4) sse += 1e4 * (bf.c1 - 3.99) ** 2;   // no-arb enforced INSIDE the objective
        if (bf.c2 > 4) sse += 1e4 * (bf.c2 - 4) ** 2;
        for (const q of pts) {
          const w = ssviW(q.k, s.theta, rho, phi);
          if (!(w > 0)) { sse += 1e4; continue; }
          sse += (Math.sqrt(w / s.T) - q.sigma) ** 2;
        }
        return sse;
      };
      const starts = [[0, Math.log(1 / Math.sqrt(s.theta))], [-0.5, Math.log(0.5 / Math.sqrt(s.theta))], [0.5, Math.log(2 / Math.sqrt(s.theta))], [-1, Math.log(5)], [0, Math.log(20)]];
      let best = null;
      for (const s0 of starts) { const r = nelderMead(objective, s0); if (!best || r.f < best.f) best = r; }
      const { rho, phi } = unpack2(best.x);

      let sse = 0;
      for (const q of pts) { const w = ssviW(q.k, s.theta, rho, phi); if (!(w > 0)) continue; sse += (Math.sqrt(w / s.T) - q.sigma) ** 2; }
      const rmseVolPts = round(Math.sqrt(sse / pts.length) * 100, 2);
      const bf = butterflySlack(s.theta, phi, rho);
      const ok = rmseVolPts <= maxRmseVolPts && bf.ok;
      return {
        T: round(s.T, 5), theta: round(s.theta, 6), rho: round(rho, 4), phi: round(phi, 4),
        rmseVolPts, butterfly: { c1: round(bf.c1, 3), c2: round(bf.c2, 3), ok: bf.ok }, n: pts.length, ok,
        reason: ok ? undefined : (!bf.ok ? 'butterfly conditions violated at the fitted parameters' : `RMSE ${rmseVolPts} vol pts exceeds the ${maxRmseVolPts} gate`),
      };
    });

  const byT = out.filter((s) => s.theta > 0).slice().sort((a, b) => a.T - b.T);
  const calendarOk = byT.every((s, i) => i === 0 || s.theta >= byT[i - 1].theta - 1e-9);
  const fitted = out.filter((s) => s.ok);
  const rmseAll = fitted.length ? round(fitted.reduce((a, s) => a + s.rmseVolPts, 0) / fitted.length, 2) : null;
  return {
    ok: fitted.length > 0,
    slicesFitted: fitted.length, slicesTotal: out.length,
    meanRmseVolPts: rmseAll, calendarOk, kBand, perSlice: out,
    method: 'SSVI (Gatheral–Jacquier arXiv:1204.0646) calibrated SLICE-BY-SLICE, arbitrage-free per Corbetta et al. (arXiv:1804.04924). Per expiry: θ is the OBSERVED ATM total variance (SSVI has w(0,θ)=θ, so it is not fitted) and only (ρ, φ) are free — 2 parameters against 10–40 strikes. Butterfly conditions θφ(1+|ρ|)<4 and θφ²(1+|ρ|)≤4 are penalised inside the objective, so any accepted slice is arbitrage-free by construction. Nelder–Mead, multi-start. Deep wings trimmed to |log-moneyness| ≤ kBand (far-OTM marks are stale/wide). A slice failing the RMSE gate is REJECTED and falls back to disclosed interpolation — a silently mis-fitted smile is worse than an honest imperfect one.',
    reason: fitted.length ? undefined : 'no slice passed the fit-quality gate — all fall back to disclosed interpolation',
  };
}

// The fitted smile as σ(K) for ONE expiry — the ivFn our Breeden–Litzenberger reader expects.
// Returns null when that slice's fit was rejected, so the caller falls back and discloses.
export function ssviIvFn(fit, F, T, theta) {
  if (!fit || !Array.isArray(fit.perSlice) || !(theta > 0) || !(T > 0) || !(F > 0)) return null;
  // NOTE: perSlice.T is rounded for output, so match with a tolerance wider than that rounding
  // (slices differ by >=1e-3 in T, so 1e-4 is unambiguous).
  const s = fit.perSlice.find((x) => x.ok && Math.abs(x.T - T) < 1e-4);
  if (!s) return null;
  return (K) => {
    if (!(K > 0)) return null;
    const w = ssviW(Math.log(K / F), s.theta, s.rho, s.phi);
    return w > 0 ? Math.sqrt(w / T) : null;
  };
}
