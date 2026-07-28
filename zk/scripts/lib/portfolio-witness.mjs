// Turning a portfolio-gate answer into a portfoliogate witness.
//
// Shared by all three B8 gates because a fourth hand-rolled encoder is the defect this project keeps
// finding in itself: gateB6 wrote one, and every leg of an eleven-leg book was refused by the
// constraint system, which was the encoder being wrong rather than the legs being bad.
//
// So the per-leg encoding is NOT written here. It is `witnessFor` out of the service's own
// `util/snark.js`, which already carries the margin recomputation (the engine echoes `margin` as
// `round(M, 2)`, and reading that certifies a position half a cent of margin away from the one that
// was priced), the grid snap, and the canonical integer solve for the liquidation price. What IS here
// is the part portfolio-gate adds and the leg circuit never had: the mark each distance is measured
// from, the ranking, and the tighter bit bounds three legs cost.
//
// TWO PUBLISHED PRECISIONS, and both are guarded rather than one:
//   liquidationPrice        is round(pLiq, 2)   -> a certified price must sit within 0.005 of it
//   moveToLiquidationPct    is round(pct, 3)    -> and the ranking is done on THAT, not on the exact
//                                                  ratio, so the ordering can differ at a tie and the
//                                                  sweep has to measure how often it does
import { toScaled } from './gatekit.mjs';
import { load } from '../service-root.mjs';

export const N = 3;
export const SCALE = 1_000_000_000n;

// Mirrored from circuits/portfoliogate.circom. A leg outside these cannot be encoded, so it is
// refused rather than approximated — and gateB8-1 measures how often the engine produces one.
export const BOUNDS = {
  mHat:    1n << 60n,   // margin  <= $1,152,921,504
  qHat:    1n << 55n,   // size    <= 36,028,797 units
  p0Hat:   1n << 50n,   // price   <= $1,125,899.9
  pLiqHat: 1n << 50n,
  refHat:  1n << 50n,
  mmrHat:  1n << 30n,
};

/** The served liquidation price is round(pLiq, 2), so half a cent is the honest ceiling on agreement. */
export const PRICE_DISPLAY_ROUNDING = 0.005;
/** The served distance is round(pct, 3), and it is what the engine RANKS on. */
export const PCT_DISPLAY_ROUNDING = 0.0005;

export async function makeBuilder(importMetaUrl) {
  const { portfolioGate } = await load(importMetaUrl, 'engine/portfolioGate.js');
  const snark = await load(importMetaUrl, 'util/snark.js');
  const scaleMod = await load(importMetaUrl, 'util/scale.cjs');
  const scale = scaleMod.default ?? scaleMod;

  /**
   * Which position did the engine name? Found by MATCHING the reported nearest back onto the
   * positions array, never by re-running the argmin — a recomputed argmin would agree with itself.
   * An ambiguous match (two legs identical in venue, asset, side, price and distance) is refused,
   * because then "the leg the engine named" is not a well-defined thing to prove.
   */
  function nearestIndex(result) {
    const nl = result.nearestLiquidation;
    if (!nl) return null;
    const hits = result.positions.filter((p) => p.liquidation
      && p.venue === nl.venue && p.asset === nl.asset && p.side === nl.side
      && p.liquidation.price === nl.liquidationPrice
      && p.liquidation.moveToLiqPct === nl.moveToLiquidationPct);
    return hits.length === 1 ? hits[0].index : null;
  }

  /**
   * @param {object[]} book  raw positions, exactly as portfolioGate would be handed them
   * @returns {{ok:false,why:string} | {ok:true, ...}}
   */
  function build(book) {
    if (!Array.isArray(book) || book.length < 1 || book.length > N) {
      return { ok: false, why: `book must have 1..${N} legs` };
    }
    const result = portfolioGate({ positions: book });
    if (!result.ok) return { ok: false, why: 'engine refused the book' };

    const idx = nearestIndex(result);
    if (idx == null) return { ok: false, why: 'the engine named no unambiguous nearest leg' };

    const legs = [];
    for (let i = 0; i < book.length; i++) {
      const raw = book[i] || {};
      const pos = result.positions.find((p) => p.index === i);
      if (!pos || !pos.liquidation || pos.liquidation.price == null) {
        return { ok: false, why: `leg ${i} solved no liquidation price` };
      }
      // Raw inputs, in the engine's own order — NOT the echoed row, whose `size` is round(q, 8) and
      // whose `marginUsed` is sized off the MARK notional rather than the entry notional.
      const entry = Number(raw.entryPrice);
      const sizeAbs = Math.abs(Number(raw.size));
      const built = snark.witnessFor({
        side: pos.side, entryPrice: entry, size: sizeAbs,
        maintMarginRate: Number(raw.maintMarginRate),
        leverage: raw.leverage, margin: raw.margin,
      }, pos.liquidation.price);
      if (!built) return { ok: false, why: `leg ${i} is outside the leg circuit's domain` };

      const e = built.encoded;
      let refHat;
      try { refHat = toScaled(pos.markPrice, 'markPrice'); } catch { return { ok: false, why: `leg ${i} mark is not encodable` }; }
      if (refHat <= 0n) return { ok: false, why: `leg ${i} has a non-positive mark` };

      for (const [k, v] of [['mHat', e.mHat], ['qHat', e.qHat], ['p0Hat', e.p0Hat],
        ['pLiqHat', e.pLiqHat], ['refHat', refHat], ['mmrHat', e.mmrHat]]) {
        if (v >= BOUNDS[k]) return { ok: false, why: `leg ${i}: ${k} exceeds the ${k} bound`, bound: k };
      }

      const d = BigInt(e.s) * (refHat - e.pLiqHat);
      // Negative distance is the engine's BELOW_MAINTENANCE state: the leg is already past its
      // liquidation price, the engine drops it from the ranking, and Num2Bits refuses it here.
      if (d < 0n) return { ok: false, why: `leg ${i} is already past liquidation`, breached: true };
      if (d >= BOUNDS.refHat) return { ok: false, why: `leg ${i} distance exceeds the price bound` };

      // THE GUARD THE SERVICE ALREADY RUNS, applied to both published precisions.
      //
      // `util/snark.js` refuses to publish a proof whose certified price is more than half a cent from
      // the served one: "publishing that proof would be publishing a lie that verifies". The same
      // reasoning applies a second time here, to the DISTANCE, because portfolio-gate publishes that
      // at 3dp and ranks on it. A certified distance that has drifted past 0.0005 is a ranking about a
      // different book even when every individual price is fine.
      const gapPrice = built.gapToServed;
      const exactPct = (Number(BigInt(e.s) * (refHat - e.pLiqHat)) / Number(refHat)) * 100;
      const gapPct = Math.abs(exactPct - pos.liquidation.moveToLiqPct);
      if (gapPrice > PRICE_DISPLAY_ROUNDING) {
        return { ok: false, why: `leg ${i} certified price diverges from the served price by ${gapPrice}`, divergedPrice: true, gap: gapPrice };
      }
      if (gapPct > PCT_DISPLAY_ROUNDING) {
        return { ok: false, why: `leg ${i} certified distance diverges from the served distance by ${gapPct}`, divergedPct: true, gap: gapPct };
      }

      legs.push({
        index: i, ...e, refHat, d,
        servedPrice: pos.liquidation.price,
        servedPct: pos.liquidation.moveToLiqPct,
        certifiedPrice: scale.fromScaled(e.pLiqHat),
        gapToServedPrice: gapPrice,
        exactPct, gapToServedPct: gapPct,
        residual: scale.residual({ ...e, pLiqHat: e.pLiqHat }),
        tolerance: scale.toleranceBound(e),
      });
    }

    // THE RANKING IS ROUNDED TOO, and this is where that bites.
    //
    // The engine ranks on `moveToLiquidationPct = round(pct, 3)` and breaks ties by book order. The
    // circuit ranks on the exact ratio d/ref. Those two orderings agree everywhere except in one
    // place: two legs that round to the same third decimal while being strictly ordered underneath.
    // There the engine names the EARLIER leg and the circuit, correctly, says the later one is nearer.
    //
    // MEASURED, not hypothesised — a book of BTC at 10x and ETH at 10.0000109x, both mmr 0.005, has
    // both legs served as 9.548% while the exact distances are 9.547738693% and 9.547727739%. The
    // engine names BTC. The circuit refuses it, and the circuit is right.
    //
    // So the split is detected here and the book is DECLINED. Certifying the engine's answer would be
    // certifying a minimum that is not one; silently naming the other leg would be certifying an
    // answer the service never gave. Neither is a proof of what was served.
    //
    // Done in exact integers. Comparing the two distances as doubles is the same class of mistake one
    // level down: 9.547738693467 and 9.547727738719 differ in the eleventh significant figure.
    const star = legs[idx];
    for (const l of legs) {
      if (l.index === idx) continue;
      if (l.d * star.refHat < star.d * l.refHat) {
        return {
          ok: false, orderingSplit: true,
          why: `the engine's rounded ranking names leg ${idx} but leg ${l.index} is strictly nearer`,
          named: idx, strictlyNearer: l.index,
        };
      }
    }

    // A book of one or two legs is padded by REPEATING its last leg. A duplicate of a leg already in
    // the book cannot change a minimum and cannot smuggle in a leg whose identity is unproven, and it
    // is visible in the public signals as an identical tuple rather than hidden behind a count.
    const padded = [...legs];
    while (padded.length < N) padded.push(padded[padded.length - 1]);

    const sel = padded.map((_, i) => (i === idx ? 1n : 0n));

    const witness = {
      mHat:    padded.map((l) => l.mHat.toString()),
      qHat:    padded.map((l) => l.qHat.toString()),
      p0Hat:   padded.map((l) => l.p0Hat.toString()),
      s:       padded.map((l) => l.s.toString()),
      mmrHat:  padded.map((l) => l.mmrHat.toString()),
      pLiqHat: padded.map((l) => l.pLiqHat.toString()),
      refHat:  padded.map((l) => l.refHat.toString()),
      nearest: String(idx),
      sel:     sel.map((b) => b.toString()),
    };

    return { ok: true, witness, legs: padded, realLegs: legs, nearest: idx, result, padded: N - legs.length };
  }

  return { portfolioGate, scale, witnessFor: snark.witnessFor, nearestIndex, build };
}

/** Exact distance as a percentage, from the ENCODED integers — the quantity the circuit orders on. */
export const distPct = (leg) => (Number(leg.d) / Number(leg.refHat)) * 100;
