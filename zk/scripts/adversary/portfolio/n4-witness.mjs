// ADVERSARIAL PROBE — build an N-leg portfoliogate witness for any N, using the SERVICE'S OWN
// encoder (util/snark.js witnessFor), so nothing here is a hand-rolled encoding.
//
// This is the encoder portfolio-witness.mjs uses, with the `book.length > 3` refusal lifted and the
// padding kept, because the question under test is whether the WIDE circuit can carry more than three
// legs at all.
import __P from '../paths.mjs';
const ZK = __P.zkUrl('') + '/';
const { toScaled } = await import(ZK + 'scripts/lib/gatekit.mjs');
const { load } = await import(ZK + 'scripts/service-root.mjs');
const ANCHOR = ZK + 'scripts/x.mjs';

const BOUNDS = {
  mHat: 1n << 60n, qHat: 1n << 55n, p0Hat: 1n << 50n,
  pLiqHat: 1n << 50n, refHat: 1n << 50n, mmrHat: 1n << 30n,
};
const PRICE_DISPLAY_ROUNDING = 0.005;
const PCT_DISPLAY_ROUNDING = 0.0005;

export async function makeWideBuilder(N) {
  const { portfolioGate } = await load(ANCHOR, 'engine/portfolioGate.js');
  const snark = await load(ANCHOR, 'util/snark.js');
  const scaleMod = await load(ANCHOR, 'util/scale.cjs');
  const scale = scaleMod.default ?? scaleMod;

  function nearestIndex(result) {
    const nl = result.nearestLiquidation;
    if (!nl) return null;
    const hits = result.positions.filter((p) => p.liquidation
      && p.venue === nl.venue && p.asset === nl.asset && p.side === nl.side
      && p.liquidation.price === nl.liquidationPrice
      && p.liquidation.moveToLiqPct === nl.moveToLiquidationPct);
    return hits.length === 1 ? hits[0].index : null;
  }

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
      if (!pos || !pos.liquidation || pos.liquidation.price == null) return { ok: false, why: `leg ${i} solved no liquidation price` };
      const built = snark.witnessFor({
        side: pos.side, entryPrice: Number(raw.entryPrice), size: Math.abs(Number(raw.size)),
        maintMarginRate: Number(raw.maintMarginRate), leverage: raw.leverage, margin: raw.margin,
      }, pos.liquidation.price);
      if (!built) return { ok: false, why: `leg ${i} outside the leg circuit's domain` };
      const e = built.encoded;
      let refHat;
      try { refHat = toScaled(pos.markPrice, 'markPrice'); } catch { return { ok: false, why: `leg ${i} mark not encodable` }; }
      if (refHat <= 0n) return { ok: false, why: `leg ${i} non-positive mark` };
      for (const [k, v] of [['mHat', e.mHat], ['qHat', e.qHat], ['p0Hat', e.p0Hat],
        ['pLiqHat', e.pLiqHat], ['refHat', refHat], ['mmrHat', e.mmrHat]]) {
        if (v >= BOUNDS[k]) return { ok: false, why: `leg ${i}: ${k} exceeds bound`, bound: k };
      }
      const d = BigInt(e.s) * (refHat - e.pLiqHat);
      if (d < 0n) return { ok: false, why: `leg ${i} already past liquidation`, breached: true };
      if (d >= BOUNDS.refHat) return { ok: false, why: `leg ${i} distance exceeds price bound` };
      const gapPrice = built.gapToServed;
      const exactPct = (Number(d) / Number(refHat)) * 100;
      const gapPct = Math.abs(exactPct - pos.liquidation.moveToLiqPct);
      if (gapPrice > PRICE_DISPLAY_ROUNDING) return { ok: false, why: `leg ${i} price diverges ${gapPrice}`, divergedPrice: true };
      if (gapPct > PCT_DISPLAY_ROUNDING) return { ok: false, why: `leg ${i} pct diverges ${gapPct}`, divergedPct: true };
      legs.push({ index: i, ...e, refHat, d, exactPct, servedPct: pos.liquidation.moveToLiqPct, servedPrice: pos.liquidation.price });
    }

    const star = legs[idx];
    for (const l of legs) {
      if (l.index === idx) continue;
      if (l.d * star.refHat < star.d * l.refHat) {
        return { ok: false, orderingSplit: true, why: `engine names ${idx} but ${l.index} is strictly nearer` };
      }
    }

    const padded = [...legs];
    while (padded.length < N) padded.push(padded[padded.length - 1]);
    const sel = padded.map((_, i) => (i === idx ? 1n : 0n));

    const witness = {
      mHat: padded.map((l) => l.mHat.toString()),
      qHat: padded.map((l) => l.qHat.toString()),
      p0Hat: padded.map((l) => l.p0Hat.toString()),
      s: padded.map((l) => l.s.toString()),
      mmrHat: padded.map((l) => l.mmrHat.toString()),
      pLiqHat: padded.map((l) => l.pLiqHat.toString()),
      refHat: padded.map((l) => l.refHat.toString()),
      nearest: String(idx),
      sel: sel.map((b) => b.toString()),
    };
    return { ok: true, witness, legs: padded, realLegs: legs, nearest: idx, result };
  }

  return { build, portfolioGate, scale };
}
