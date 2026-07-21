// Small statistics helpers used by both engines.

// Wilson score interval for a binomial proportion (win rate given n trades).
export function wilsonInterval(successes, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// Herfindahl–Hirschman index of a list of shares (0..1). 1 = single actor.
export function hhi(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return values.reduce((acc, v) => acc + (v / total) ** 2, 0);
}

// Coefficient of variation of inter-event gaps; low CV with many events = machine cadence.
export function gapCv(timestampsMs) {
  if (timestampsMs.length < 3) return null;
  const ts = [...timestampsMs].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean === 0) return 0;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean;
}

// Simple-OLS slope with an analytic 95% confidence interval (normal approximation). For a regression
// coefficient like Kyle's λ, the point estimate alone hides whether the impact is even distinguishable
// from zero — the CI answers that. df = n-2; SE(β) = sqrt( (SSE/df) / Sxx ); CI = β ± 1.96·SE.
// Returns null when the fit is degenerate (no x-variance) or underpowered (df < 1). z is the normal
// multiplier (1.96 ≈ 95%); this is a large-sample approximation, disclosed by the caller.
export function olsSlopeCI(xs, ys, z = 1.96) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (!(sxx > 0)) return null;                       // no x-variance → slope undefined
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : null;
  const df = n - 2;
  if (df < 1) return { slope, r2, se: null, ciLo: null, ciHi: null, excludesZero: null, n };
  const sse = Math.max(0, syy - slope * sxy);        // residual sum of squares (>=0 up to fp)
  const se = Math.sqrt((sse / df) / sxx);
  const ciLo = slope - z * se, ciHi = slope + z * se;
  return { slope, r2, se, ciLo, ciHi, excludesZero: ciLo > 0 || ciHi < 0, n };
}

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const round = (x, dp = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(Number(x).toFixed(dp)));
