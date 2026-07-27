// GEX / dealer gamma / gamma-flip (gap 2) + aggregate open-interest greeks (gap 4).
//
// Dollar gamma per strike = gamma(Black-76) x OI(coin) x spot^2 x 0.01  — the change in aggregate
// delta-dollars dealers must hedge for a 1% spot move (the conventional GEX scaling).
//
// Dealer-sign convention (an ASSUMPTION, labeled in output): customers buy puts for protection and
// overwrite calls, so dealers run LONG call gamma / SHORT put gamma -> NetGEX = callGEX - putGEX.
// Net > 0 => dealers long gamma (hedging dampens moves, mean-reverting). Net < 0 => short gamma
// (hedging amplifies moves, trending). The GAMMA FLIP is the spot level where NetGEX crosses zero.
import { black76 } from './black76.js';
import { round } from './stats.js';

// options: [{ strike, type:'call'|'put', oi(coin), iv(decimal), F(forward), T(yrs), r }]
export function computeGex(options, spot, { mult = 1 } = {}) {
  const usable = options.filter((o) => o.iv > 0 && o.T > 0 && o.F > 0 && o.strike > 0 && o.oi > 0);
  if (!usable.length || !(spot > 0)) return null;

  const netGexAt = (S) => {
    let net = 0;
    for (const o of usable) {
      const Fp = o.F * (S / spot); // shift forward with spot, preserving the basis
      const g = black76(Fp, o.strike, o.T, o.iv, o.type, o.r || 0);
      if (!g) continue;
      const dollarGamma = g.gamma * o.oi * S * S * 0.01 * mult;
      net += (o.type === 'call' ? 1 : -1) * dollarGamma;
    }
    return net;
  };

  // Aggregate at current spot: per-strike + totals.
  const perStrike = new Map();
  let netGex = 0, grossGamma = 0, totalVega = 0, callGamma = 0, putGamma = 0, netVanna = 0, netVolga = 0;
  for (const o of usable) {
    const g = black76(o.F, o.strike, o.T, o.iv, o.type, o.r || 0);
    if (!g) continue;
    const dollarGamma = g.gamma * o.oi * spot * spot * 0.01 * mult;
    const signed = (o.type === 'call' ? 1 : -1) * dollarGamma;
    netGex += signed; grossGamma += dollarGamma;
    if (o.type === 'call') callGamma += dollarGamma; else putGamma += dollarGamma;
    totalVega += g.vega * o.oi * mult; // vega already per 1 vol-point
    // Dealer vanna/volga under the SAME long-call/short-put convention as NetGEX (assumption, see note).
    // vanna = ∂delta/∂σ (dimensionless) → ×spot to dollarize; volga carries the forward via vega already.
    const sgn = o.type === 'call' ? 1 : -1;
    netVanna += sgn * g.vanna * o.oi * spot * mult; // USD of delta dealers gain per +1 vol-point of IV
    netVolga += sgn * g.volga * o.oi * mult;        // USD of vega dealers gain per +1 vol-point of IV
    const cur = perStrike.get(o.strike) || { strike: o.strike, gex: 0 };
    cur.gex += signed;
    perStrike.set(o.strike, cur);
  }

  // Gamma-flip: scan spot +/-30% for the zero-crossing of NetGEX(S).
  let flip = null;
  const lo = spot * 0.7, hi = spot * 1.3, steps = 60;
  let prevS = lo, prevN = netGexAt(lo);
  for (let i = 1; i <= steps; i++) {
    const S = lo + (hi - lo) * (i / steps);
    const N = netGexAt(S);
    if (Number.isFinite(prevN) && Number.isFinite(N) && ((prevN <= 0 && N >= 0) || (prevN >= 0 && N <= 0)) && prevN !== N) {
      flip = prevS + (S - prevS) * (0 - prevN) / (N - prevN); // linear interpolation to zero
      break;
    }
    prevS = S; prevN = N;
  }

  const byStrike = [...perStrike.values()].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 8)
    .map((s) => ({ strike: s.strike, gexUsdPerPct: round(s.gex, 0), side: s.gex >= 0 ? 'support' : 'resist' }))
    .sort((a, b) => a.strike - b.strike);

  return {
    netGexUsdPerPct: round(netGex, 0),
    grossGammaUsdPerPct: round(grossGamma, 0),
    callGammaUsdPerPct: round(callGamma, 0),
    putGammaUsdPerPct: round(putGamma, 0),
    gammaFlipSpot: flip ? round(flip, 0) : null,
    regime: netGex >= 0 ? 'DEALER_LONG_GAMMA' : 'DEALER_SHORT_GAMMA',
    interpretation: netGex >= 0
      ? 'Dealer hedging dampens moves toward the largest strikes (mean-reverting pin).'
      : 'Dealer hedging amplifies moves away from spot (trend/acceleration risk).',
    spotVsFlip: flip ? (spot >= flip ? 'above_flip_long_gamma' : 'below_flip_short_gamma') : null,
    byStrike,
    aggregateGreeks: {
      totalVegaUsdPerVolPt: round(totalVega, 0),
      totalGammaUsdPerPct: round(grossGamma, 0),
      dealerVannaUsdPerVolPt: round(netVanna, 0),
      dealerVolgaUsdPerVolPt: round(netVolga, 0),
      vannaVolgaNote: `Second-order vol greeks under the same assumed dealer sign as NetGEX. dealerVanna = USD of delta the dealer book gains per +1 vol-point rise in IV: ${netVanna >= 0 ? 'positive → a vol spike lengthens dealer delta, so they SELL into it (a spot↓/vol↑ feedback that can accelerate down-moves)' : 'negative → a vol spike shortens dealer delta, so they BUY (dampening)'}. dealerVolga = USD of vega gained per +1 vol-point (vega convexity of the book).`,
    },
    // This string used to say the public feed "carries no block-trade tag ... (verified)". It does
    // carry one — `block_trade_id`, `block_trade_leg_count`, and `block_rfq_id` on ETH — and the
    // tagged share of contract volume is large: 48.9% of BTC and 30.2% of ETH option volume in a
    // 200-trade window sampled 27 July 2026. Shipping a false premise to a paying caller with the
    // word "verified" attached is worse than shipping no premise at all, so the reason is restated
    // as the one that actually holds, and the part that is still unmeasured is labelled as such.
    assumption: 'Dealer positioning is ASSUMED (dealers long call gamma / short put gamma), not observed; NetGEX = call GEX − put GEX, weighted by open interest. We do NOT infer the dealer sign from trade flow, and the reason is attribution rather than tagging: the public feed DOES mark block trades (block_trade_id / block_trade_leg_count), so they are identifiable, but a trade\'s reported direction identifies the side it was booked from, not whether the dealer was the buyer or the seller — and whether the block maker is a dealer at all is not something this feed states. A flow-based dealer sign would therefore be invertible on exactly the largest trades. The OI-based convention is a transparent assumption; treat GEX as a positioning map under that convention, not measured dealer inventory.',
    strikesUsed: usable.length,
  };
}
