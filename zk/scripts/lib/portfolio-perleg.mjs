// Turning a portfolio-gate answer into n INDEPENDENT portfolioleg witnesses.
//
// The sibling of `portfolio-witness.mjs`, and deliberately a separate file: that one builds the ONE
// wide witness `portfoliogate.circom` consumes, hard-caps the book at three legs, and pads a short
// book by repetition. None of those three things applies here, and editing it to do both jobs would
// put an `if (perLeg)` through the middle of the encoder every gate in B8 depends on.
//
// WHAT IS REUSED, and it is the part that matters. The per-leg encoding is NOT rewritten. It comes out
// of `makeBuilder`, which gets it from the service's own `util/snark.js:witnessFor` — the margin
// recomputation, the grid snap, the canonical integer solve. gateB6 hand-rolled an encoder and every
// one of eleven legs was refused by the constraint system; that is the mistake this file exists to not
// repeat for the third time.
//
// WHAT IS DIFFERENT FROM THE WIDE ROUTE, in full:
//
//   1. NO LEG CAP. The wide builder refuses a book of more than three because the circuit has three
//      slots. A per-leg witness has no slots, so the only bound left is the one the service has,
//      which is "at least one" — there is no maxItems anywhere in it.
//   2. NO PADDING. A one-leg book is one proof. The wide route repeats a leg to fill the slots.
//   3. WIDER BOUNDS. The three-leg circuit had to cut margin to 2^60, size to 2^55 and price to 2^50
//      to fit 4,096 gates. One leg has room for liquidation.circom's original widths, so these are
//      the bounds a single leg is actually checked against — and they are strictly more permissive,
//      which is why the refusal sweep in the gate is not a formality.
//   4. THE RANKING LEAVES THE CIRCUIT. The wide circuit proves the minimum internally with a one-hot
//      selector. Here each proof publishes (d, refHat) and the comparison is done by whoever is
//      reading — the gate does it in BigInt, the contract does it in uint256, and both do it by
//      cross-multiplication so that no division and no float ever touches the ordering.
import { toScaled } from './gatekit.mjs';
import { makeBuilder } from './portfolio-witness.mjs';

export const SCALE = 1_000_000_000n;

// Mirrored from circuits/portfolioleg.circom — full parity with liquidation.circom's widths. Compare
// against BOUNDS in portfolio-witness.mjs, which are what three legs in one domain cost.
export const BOUNDS = {
  mHat:    1n << 80n,   // margin  <= $1.2e15      (wide route: 2^60, $1.15e9)
  qHat:    1n << 60n,   // size    <= 1.15e9 units (wide route: 2^55, 3.6e7)
  p0Hat:   1n << 60n,   // price   <= $1.15e9      (wide route: 2^50, $1.1e6)
  pLiqHat: 1n << 60n,
  refHat:  1n << 60n,
  mmrHat:  1n << 30n,
};

/** The served liquidation price is round(pLiq, 2), so half a cent is the honest ceiling on agreement. */
export const PRICE_DISPLAY_ROUNDING = 0.005;
/** The served distance is round(pct, 3), and it is what the engine RANKS on. */
export const PCT_DISPLAY_ROUNDING = 0.0005;

/**
 * The comparison the whole shape turns on, in exact integers.
 *
 * `a` is nearer than `b`  <=>  d_a/ref_a < d_b/ref_b  <=>  d_a*ref_b < d_b*ref_a, both refs positive
 * and both provably so (portfolioleg pins refHat >= 1). Strict, and the caller keeps the incumbent on
 * a tie, which is the engine's tie-break: portfolioGate.js scans with a strict `<` and so keeps the
 * EARLIER leg. The contract does the identical thing in uint256.
 */
export const nearerThan = (a, b) => a.d * b.refHat < b.d * a.refHat;

export async function makePerLegBuilder(importMetaUrl) {
  const wide = await makeBuilder(importMetaUrl);
  const { portfolioGate, scale, witnessFor, nearestIndex } = wide;

  /**
   * Encode one leg on its own. Returns the witness portfolioleg.circom consumes plus the two integers
   * the ranking is a ratio of.
   */
  function buildLeg(raw, pos) {
    const entry = Number(raw.entryPrice);
    const sizeAbs = Math.abs(Number(raw.size));
    const built = witnessFor({
      side: pos.side, entryPrice: entry, size: sizeAbs,
      maintMarginRate: Number(raw.maintMarginRate),
      leverage: raw.leverage, margin: raw.margin,
    }, pos.liquidation.price);
    if (!built) return { ok: false, why: 'outside the leg circuit\'s domain' };

    const e = built.encoded;
    let refHat;
    try { refHat = toScaled(pos.markPrice, 'markPrice'); } catch { return { ok: false, why: 'mark is not encodable' }; }
    if (refHat <= 0n) return { ok: false, why: 'non-positive mark' };

    for (const [k, v] of [['mHat', e.mHat], ['qHat', e.qHat], ['p0Hat', e.p0Hat],
      ['pLiqHat', e.pLiqHat], ['refHat', refHat], ['mmrHat', e.mmrHat]]) {
      if (v >= BOUNDS[k]) return { ok: false, why: `${k} exceeds the ${k} bound`, bound: k };
    }

    const d = BigInt(e.s) * (refHat - e.pLiqHat);
    // Negative distance is the engine's BELOW_MAINTENANCE state: already past liquidation, dropped
    // from the ranking by the engine and refused by Num2Bits here.
    if (d < 0n) return { ok: false, why: 'already past liquidation', breached: true };
    if (d >= BOUNDS.refHat) return { ok: false, why: 'distance exceeds the price bound' };

    // The same two guards the service already runs, applied to both published precisions. A certified
    // price more than half a cent from the served one, or a certified distance more than 0.0005 from
    // the served one, is a proof about a different position however well it verifies.
    const gapPrice = built.gapToServed;
    const exactPct = (Number(d) / Number(refHat)) * 100;
    const gapPct = Math.abs(exactPct - pos.liquidation.moveToLiqPct);
    if (gapPrice > PRICE_DISPLAY_ROUNDING) return { ok: false, why: `certified price diverges by ${gapPrice}`, divergedPrice: true };
    if (gapPct > PCT_DISPLAY_ROUNDING) return { ok: false, why: `certified distance diverges by ${gapPct}`, divergedPct: true };

    return {
      ok: true,
      witness: {
        mHat: e.mHat.toString(), qHat: e.qHat.toString(), p0Hat: e.p0Hat.toString(),
        s: e.s.toString(), mmrHat: e.mmrHat.toString(), pLiqHat: e.pLiqHat.toString(),
        refHat: refHat.toString(),
      },
      ...e, refHat, d,
      servedPrice: pos.liquidation.price,
      servedPct: pos.liquidation.moveToLiqPct,
      certifiedPrice: scale.fromScaled(e.pLiqHat),
      gapToServedPrice: gapPrice,
      exactPct, gapToServedPct: gapPct,
      residual: scale.residual({ ...e, pLiqHat: e.pLiqHat }),
      tolerance: scale.toleranceBound(e),
    };
  }

  /**
   * A whole book, at any size. No leg cap, no padding.
   *
   * @param {object[]} book raw positions exactly as portfolioGate would be handed them
   */
  function build(book) {
    if (!Array.isArray(book) || book.length < 1) return { ok: false, why: 'need at least one leg' };
    const result = portfolioGate({ positions: book });
    if (!result.ok) return { ok: false, why: 'engine refused the book' };

    const idx = nearestIndex(result);
    if (idx == null) return { ok: false, why: 'the engine named no unambiguous nearest leg' };

    const legs = [];
    const refused = [];
    for (let i = 0; i < book.length; i++) {
      const pos = result.positions.find((p) => p.index === i);
      if (!pos || !pos.liquidation || pos.liquidation.price == null) {
        refused.push({ index: i, why: 'solved no liquidation price' });
        continue;
      }
      const leg = buildLeg(book[i] || {}, pos);
      if (!leg.ok) { refused.push({ index: i, ...leg }); continue; }
      legs.push({ index: i, ...leg });
    }
    // A minimum over a subset is not a minimum. If any leg cannot be encoded the book is declined
    // whole, exactly as the wide route declines it whole — the answer would otherwise be a minimum
    // over whichever legs happened to fit.
    if (refused.length) return { ok: false, why: `${refused.length} of ${book.length} legs refused`, refused, partial: legs.length };

    // The engine ranks on round(pct, 3) and breaks ties by book order; this ranks on the exact ratio.
    // Where two legs round to the same third decimal while being strictly ordered underneath, the two
    // orderings disagree and the book is DECLINED rather than certified either way. Same reasoning and
    // same exact-integer test as the wide builder.
    const star = legs.find((l) => l.index === idx);
    if (!star) return { ok: false, why: `the named leg ${idx} was refused` };
    for (const l of legs) {
      if (l.index === idx) continue;
      if (nearerThan(l, star)) {
        return { ok: false, orderingSplit: true, named: idx, strictlyNearer: l.index,
          why: `the engine's rounded ranking names leg ${idx} but leg ${l.index} is strictly nearer` };
      }
    }
    return { ok: true, legs, nearest: idx, result };
  }

  return { ...wide, buildLeg, build };
}
