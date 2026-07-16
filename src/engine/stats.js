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

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const round = (x, dp = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(Number(x).toFixed(dp)));
