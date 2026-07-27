// Snap a value onto the 1e-9 grid the succinct-proof circuit works over.
//
// The circuit carries every quantity as an integer scaled by 1e9; the engine carries IEEE-754
// doubles. Unless the service hands the engine values that are already on that grid, the circuit
// proves an identity about a position slightly different from the one the caller was answered —
// measured at up to 3.5e-6 in quote currency over a 3,000-position sample, which is small but is not
// the same number. A proof of a nearby position is not a proof of the answer.
//
// Snapping the inputs AND the leverage brings the worst observed divergence to 5.5e-10, with zero of
// 3,000 sampled positions above 1e-9. Leverage matters because margin is derived from it inside the
// engine, so it lands off-grid even when its ingredients do not; snapping leverage is what keeps the
// derived margin close enough without changing the shape of the echoed inputs, which would break
// every published content hash.
//
// This lives outside src/engine deliberately: the engine is unchanged, so the build hash does not
// move and no document needs re-sweeping.

// `Math.round(x * 1e9)` is wrong above roughly 9e6, where the product exceeds 2^53 and the rounding
// silently lands on the wrong integer — a real trap for a price in the tens of thousands scaled by a
// billion. `toFixed(9)` is specified to round the exact decimal value of the double, so it stays
// correct across the whole range this service prices.
const MAX_FIXED = 1e21;   // toFixed switches to exponential notation beyond this

export function gridSnap(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  if (Math.abs(x) >= MAX_FIXED) return x;
  return Number(x.toFixed(9));
}

/** Snap the named numeric fields of an input object, leaving everything else untouched. */
export function gridSnapFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const f of fields) if (f in out) out[f] = gridSnap(out[f]);
  return out;
}
