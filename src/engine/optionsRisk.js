// options-risk — portfolio greeks + SPAN-style scenario margin for an options book. Deterministic.
//
// WHY: the agent risk layer (RiskState, exchange caps) checks "is this within my limits" but does not
// COMPUTE the portfolio's aggregate greeks or its scenario margin. An options book's real risk is not the
// sum of per-leg notionals — it's the net delta/gamma/vega and the worst-case P&L across a price×vol grid.
// This computes those, on Black-76 (the correct model for options on a forward — Deribit's convention).
//
// SELF-CHECK (the discipline): analytic portfolio greeks are verified against FINITE-DIFFERENCE derivatives
// of the actually-repriced portfolio. dValue/d(relative forward shock) must equal Σ qᵢ·deltaᵢ·Fᵢ, and the
// second difference must equal Σ qᵢ·gammaᵢ·Fᵢ². A wrong greek fails its own check — it cannot ship silently.
import { black76 } from './black76.js';
import { round } from './stats.js';

const GREEKS = ['delta', 'gamma', 'vega', 'vanna', 'volga', 'theta'];

// Portfolio value under a uniform relative forward shock and an absolute vol shift (decimal).
function priceAt(positions, shock, dSig, dT, r) {
  let v = 0;
  for (const p of positions) {
    const g = black76(p.F * (1 + shock), p.K, p.T + dT, Math.max(p.sigma + dSig, 1e-6), p.type, r);
    if (g) v += g.price * p.qty;
  }
  return v;
}

export function optionsRisk(input = {}, { eps = 1e-6 } = {}) {
  const r = Number(input.r) || 0;
  const sharedF = Number(input.forward) > 0 ? Number(input.forward) : null;
  const raw = Array.isArray(input.positions) ? input.positions : [];
  const errors = [];
  const positions = raw.map((p, i) => {
    const type = p.type === 'put' ? 'put' : 'call';
    const K = Number(p.strike);
    const T = Number(p.T) > 0 ? Number(p.T) : (Number(p.expiryDays) > 0 ? Number(p.expiryDays) / 365 : NaN);
    const sigma = Number(p.iv);
    const qty = Number(p.quantity);
    const F = Number(p.forward) > 0 ? Number(p.forward) : sharedF;
    if (!(K > 0) || !(T > 0) || !(sigma > 0) || !Number.isFinite(qty) || qty === 0 || !(F > 0)) {
      errors.push(`position ${i}: need strike>0, expiry(T or expiryDays)>0, iv>0, non-zero quantity, and a forward (per-position or shared)`);
    }
    return { type, K, T, sigma, qty, F };
  });
  if (!positions.length) errors.push('need at least one position');
  if (errors.length) return { ok: false, errors };

  // Aggregate greeks (position-weighted sums) + per-position breakdown.
  const agg = Object.fromEntries(GREEKS.map((g) => [g, 0]));
  // Analytic aggregates in RAW-derivative units, one per greek, to check against finite differences of the
  // repriced book. black76 reports vega/vanna/volga per vol-POINT (×0.01, volga ×0.01²) and theta per
  // calendar DAY (= −∂price/∂T / 365); undo those scalings so each self-check compares like-for-like.
  let relDelta = 0, relGamma = 0, relVega = 0, relVanna = 0, relVolga = 0, relTheta = 0;
  const perPos = positions.map((p) => {
    const g = black76(p.F, p.K, p.T, p.sigma, p.type, r);
    const pg = {};
    for (const k of GREEKS) { pg[k] = g[k] * p.qty; agg[k] += pg[k]; }
    relDelta += p.qty * g.delta * p.F;          // ∂value/∂(relative fwd shock)
    relGamma += p.qty * g.gamma * p.F * p.F;     // ∂²value/∂(shock)²
    relVega  += p.qty * g.vega * 100;            // ∂value/∂σ    (g.vega  = ∂price/∂σ · 0.01)
    relVanna += p.qty * g.vanna * 100 * p.F;     // ∂²value/∂(shock)∂σ  (g.vanna = ∂²price/∂F∂σ · 0.01)
    relVolga += p.qty * g.volga * 1e4;           // ∂²value/∂σ²  (g.volga = ∂²price/∂σ² · 0.01²)
    relTheta += p.qty * (-365) * g.theta;        // ∂value/∂T    (g.theta = −∂price/∂T / 365)
    return {
      type: p.type, strike: p.K, T: round(p.T, 5), iv: p.sigma, quantity: p.qty, forward: p.F,
      value: round(g.price * p.qty, 6),
      positionGreeks: Object.fromEntries(GREEKS.map((k) => [k, round(pg[k], 6)])),
    };
  });
  const V0 = priceAt(positions, 0, 0, 0, r);

  // FD self-checks against the repriced portfolio — for ALL SIX greeks, not just delta/gamma. An aggregate
  // greek that is never differenced against the repriced book is UNVERIFIED: a wrong vega/vanna/volga/theta
  // would ship silently (the "verifier that cannot fail"). Plain central differences are inaccurate for
  // short-dated high-convexity legs, so we use RICHARDSON EXTRAPOLATION (O(h²)→O(h⁴)) — sharpen the check,
  // never loosen the tolerance (loosening until it passes is the trap). Shocks: relative forward (hs),
  // absolute vol (hv), and time-in-years (ht, kept safely below the shortest expiry).
  const hs = 1e-3, hv = 5e-3;
  const ht = Math.min(1e-4, 0.1 * Math.min(...positions.map((p) => p.T)));
  const dS  = (h) => (priceAt(positions, h, 0, 0, r) - priceAt(positions, -h, 0, 0, r)) / (2 * h);
  const d2S = (h) => (priceAt(positions, h, 0, 0, r) - 2 * V0 + priceAt(positions, -h, 0, 0, r)) / (h * h);
  const dV  = (h) => (priceAt(positions, 0, h, 0, r) - priceAt(positions, 0, -h, 0, r)) / (2 * h);
  const d2V = (h) => (priceAt(positions, 0, h, 0, r) - 2 * V0 + priceAt(positions, 0, -h, 0, r)) / (h * h);
  const dTt = (h) => (priceAt(positions, 0, 0, h, r) - priceAt(positions, 0, 0, -h, r)) / (2 * h);
  const mix = (a, b) => (priceAt(positions, a, b, 0, r) - priceAt(positions, a, -b, 0, r)
                       - priceAt(positions, -a, b, 0, r) + priceAt(positions, -a, -b, 0, r)) / (4 * a * b);
  const rich = (f, h) => (4 * f(h / 2) - f(h)) / 3;                  // Richardson O(h⁴)
  const fdDelta = rich(dS, hs), fdGamma = rich(d2S, hs);
  const fdVega = rich(dV, hv), fdVolga = rich(d2V, hv), fdTheta = rich(dTt, ht);
  const fdVanna = (4 * mix(hs / 2, hv / 2) - mix(hs, hv)) / 3;       // Richardson mixed partial O(h⁴)
  const chk = (name, rel, fd, rf, af) => {
    const res = Math.abs(rel - fd), tol = rf * Math.max(1, Math.abs(rel)) + af;
    return { name, residual: Number(res.toExponential(2)), tolerance: Number(tol.toExponential(2)), pass: res <= tol };
  };

  // SPAN-style scenario margin: worst P&L over a price × vol grid.
  const scanPct = Number(input.scanRangePct) > 0 ? Number(input.scanRangePct) : 0.15;
  const volPts = Number(input.volShiftVolPts) > 0 ? Number(input.volShiftVolPts) : 10;
  const dVol = volPts / 100;
  const priceScen = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1].map((x) => x * scanPct);
  const volScen = [dVol, 0, -dVol];
  const scenarios = [];
  let worst = 0, worstScen = null;
  for (const ps of priceScen) {
    for (const vs of volScen) {
      const pnl = priceAt(positions, ps, vs, 0, r) - V0;
      scenarios.push({ underlyingMovePct: round(ps * 100, 2), volShiftPts: round(vs * 100, 1), pnl: round(pnl, 2) });
      if (pnl < worst) { worst = pnl; worstScen = { underlyingMovePct: round(ps * 100, 2), volShiftPts: round(vs * 100, 1) }; }
    }
  }

  return {
    ok: true,
    positionsCount: positions.length,
    portfolioValue: round(V0, 6),
    greeks: {
      delta: round(agg.delta, 6), gamma: round(agg.gamma, 8), vega: round(agg.vega, 6),
      theta: round(agg.theta, 6), vanna: round(agg.vanna, 6), volga: round(agg.volga, 6),
    },
    pnlPerUnderlyingPctMove: round(0.01 * relDelta, 2), // first-order P&L per +1% underlying move
    spanMargin: {
      requirement: round(-worst, 2),
      worstScenario: worstScen,
      scanRangePct: scanPct, volShiftVolPts: volPts,
      note: 'Worst portfolio P&L over a 7×3 price/vol scenario grid (SPAN-style). Requirement is the loss to hold against.',
      scenarios,
    },
    positions: perPos,
    model: 'Black-76 per leg; portfolio greeks are position-weighted sums; SPAN-style margin = worst repriced P&L over a price×vol grid (all forwards shocked by the same relative amount). vega is per 1 vol-point; theta per calendar day.',
    checks: [
      chk('delta self-check: Σ qᵢ·δᵢ·Fᵢ == ∂value/∂(fwd shock) [Richardson FD]', relDelta, fdDelta, 1e-6, 1e-3),
      chk('gamma self-check: Σ qᵢ·γᵢ·Fᵢ² == ∂²value/∂(shock)² [Richardson FD]', relGamma, fdGamma, 1e-5, 1e-2),
      chk('vega self-check: Σ qᵢ·∂priceᵢ/∂σ == ∂value/∂σ [Richardson FD]', relVega, fdVega, 1e-5, 1e-2),
      chk('vanna self-check: Σ qᵢ·(∂²priceᵢ/∂F∂σ)·Fᵢ == ∂²value/∂(shock)∂σ [Richardson FD]', relVanna, fdVanna, 1e-4, 1e-1),
      chk('volga self-check: Σ qᵢ·∂²priceᵢ/∂σ² == ∂²value/∂σ² [Richardson FD]', relVolga, fdVolga, 1e-4, 1e-1),
      chk('theta self-check: Σ qᵢ·∂priceᵢ/∂T == ∂value/∂T [Richardson FD]', relTheta, fdTheta, 1e-5, 1e-2),
    ],
  };
}
