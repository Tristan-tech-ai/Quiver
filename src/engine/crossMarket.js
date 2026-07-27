// (A) OPTIONS ↔ PREDICTION-MARKET DIVERGENCE — the novel cross-market read nobody computes.
// The options market and Polymarket price the SAME events (e.g. "BTC ≥ $70k by <date>") two different
// ways. We compute the options-implied risk-neutral probability of a prediction market's exact question
// and surface the divergence vs the market's own odds. Transparency safeguard: every row shows the exact
// Polymarket question it matched, so a mismatch is visible, never hidden. Any doubt → the row is skipped.
import { probAboveSmile, probTouchAbove, probTouchBelow, atmForwardIv } from './black76.js';
import { realWorldVol } from './vrp.js';
import { sviIvFnAtT } from './ssvi.js';
import { round } from './stats.js';

const YEAR = 365 * 86400000;
const GAMMA = 'https://gamma-api.polymarket.com';

const COIN_RE = { BTC: /\b(bitcoin|btc)\b/i, ETH: /\b(ethereum|eth)\b/i };

// Parse "$150,000" / "$150k" / "150K" / "$3,000" -> number. Returns null if no clean single threshold.
function parseThreshold(q) {
  const m = q.match(/\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|m|thousand|million)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'thousand') n *= 1e3;
  if (unit === 'm' || unit === 'million') n *= 1e6;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Classify the market's resolution semantics + side from its question text.
// Returns { side:'above'|'below', touch:boolean } or null if ambiguous (then we skip — never guess).
function classify(q) {
  const s = q.toLowerCase();
  if (/up or down|updown|higher or lower/.test(s)) return null; // handled by updown-pulse, not a threshold market
  if (/what price|which price|price range|between \$/.test(s)) return null; // multi-outcome, not binary threshold
  const below = /\b(dip|fall|drop|below|under|less than|down to|crash)\b/.test(s);
  const above = /\b(reach|hit|touch|above|over|exceed|surpass|top|cross|break|higher than|at least|climb to|rise to|get to)\b/.test(s);
  if (below === above) return null; // no clear single direction → skip
  const side = above ? 'above' : 'below';
  // "reach / hit / touch / by / dip to / get to" => touch (any time before resolution); "on <date> / closes" => European.
  const touch = /\b(reach|hit|touch|dip to|fall to|drop to|get to|climb to|rise to|by )\b/.test(s) && !/\b(close|closes|closing|end of day|on \w+ \d)\b/.test(s);
  return { side, touch };
}

async function fetchActiveMarkets(timeoutMs) {
  const url = `${GAMMA}/markets?active=true&closed=false&limit=150&order=volume24hr&ascending=false`;
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'okxai-asp/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`gamma ${r.status}`);
  return r.json();
}

// smiles: [{ expiryMs, F, byK:[{strike,iv(decimal)}] }] (per Deribit expiry). coin: 'BTC'|'ETH'. spot, nowMs.
export async function optionsVsPrediction(coin, smiles, spot, nowMs, { timeoutMs = 6000, vrp = null, surfaceFit = null } = {}) {
  const cur = String(coin).toUpperCase();
  const coinRe = COIN_RE[cur];
  if (!coinRe || !Array.isArray(smiles) || !smiles.length) return { markets: [], note: 'no matchable options smile' };

  let raw;
  try { raw = await fetchActiveMarkets(timeoutMs); } catch (e) { return { markets: [], note: `prediction-market feed unavailable (${String(e.message || e).slice(0, 40)})` }; }
  const markets = Array.isArray(raw) ? raw : (raw?.data || []);

  const strikesAll = smiles.flatMap((s) => s.byK.map((k) => k.strike));
  const kMin = Math.min(...strikesAll), kMax = Math.max(...strikesAll);

  const out = [];
  for (const m of markets) {
    const q = String(m.question || '');
    if (!coinRe.test(q)) continue;
    const K = parseThreshold(q);
    if (K == null || K < kMin || K > kMax) continue;            // threshold must be inside the traded strike range
    const cls = classify(q);
    if (!cls) continue;                                          // ambiguous semantics → skip
    const endMs = m.endDate ? Date.parse(m.endDate) : null;
    if (!endMs || endMs <= nowMs) continue;
    const T = (endMs - nowMs) / YEAR;
    if (T <= 1 / 365 || T > 1.1) continue;                       // horizon 1d–~1y (options coverage)
    // market-implied probability of YES
    let px; try { px = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices; } catch { px = null; }
    const yesProb = Array.isArray(px) && px.length >= 1 ? Number(px[0]) : null;
    if (yesProb == null || !(yesProb >= 0 && yesProb <= 1)) continue;

    // options-implied probability at the market's EXACT resolution date. That date is generally NOT a
    // listed option expiry, so we interpolate the arbitrage-free smile in TOTAL VARIANCE (w=σ²T, linear in
    // T) across the two bracketing Deribit expiries — the calendar-arb-free way — rather than snapping to
    // the nearest expiry (which biases the tenor by up to days). The forward is interpolated the same way.
    const sm = smiles.filter((s) => s.F > 0).slice().sort((a, b) => a.expiryMs - b.expiryMs);
    const loSm = [...sm].reverse().find((s) => s.expiryMs <= endMs), hiSm = sm.find((s) => s.expiryMs >= endMs);
    const nearestSmile = smiles.slice().sort((a, b) => Math.abs(a.expiryMs - endMs) - Math.abs(b.expiryMs - endMs))[0];
    let F;
    if (loSm && hiSm && loSm !== hiSm) { const wF = (endMs - loSm.expiryMs) / (hiSm.expiryMs - loSm.expiryMs); F = loSm.F + (hiSm.F - loSm.F) * wF; }
    else F = (hiSm || loSm || nearestSmile).F || spot;
    // At-date markets are priced by the EXACT smile CDF (Breeden–Litzenberger). Reach-by-date (touch)
    // markets use the one-touch barrier formula at the barrier's own smile vol — a disclosed approximation
    // (smile-consistency needs either a local-vol PDE or the closed-form vanna-volga overhedge, and
    // neither runs per-call — the roadmap commits the second). Smile comes from the SAME arbitrage-free
    // SVI surface the ladder uses, interpolated to the target tenor; fall back to nearest-expiry ATM only
    // if the surface is unusable there.
    const surf = surfaceFit ? sviIvFnAtT(surfaceFit, F, T) : null;
    const ivFn = surf ? surf.fn : ((x) => { const a = atmForwardIv(nearestSmile.byK, x); return a && a.iv; });
    const smileTenorBasis = surf ? { basis: surf.basis, bracketDays: surf.tenorDays } : { basis: 'nearest-expiry ATM interpolation (arbitrage-free surface unavailable at this tenor)' };
    const ivAtK = ivFn(K);
    if (!(ivAtK > 0)) continue;
    const ivFnRw = vrp ? (x) => { const s = ivFn(x); return s > 0 ? realWorldVol(s, vrp) : s; } : null;
    const priceIt = (fn, sigmaAtK) => {
      if (cls.touch) return cls.side === 'above' ? probTouchAbove(F, K, T, sigmaAtK) : probTouchBelow(F, K, T, sigmaAtK);
      const pa = probAboveSmile(F, K, T, fn, 0);
      if (pa == null) return null;
      return cls.side === 'above' ? pa : 1 - pa;
    };
    const optP = priceIt(ivFn, ivAtK);                                  // RISK-NEUTRAL
    if (optP == null) continue;
    const optRw = ivFnRw ? priceIt(ivFnRw, realWorldVol(ivAtK, vrp)) : null; // VRP-calibrated

    // TOUCH MARKETS: the one-touch is path-dependent, so a single vol cannot be smile-consistent — the
    // rigorous answers are a local-volatility (Dupire) PDE or the vanna-volga adjustment (Castagna–Mercurio,
    // the FX practitioner standard). We run neither per-call, so instead of implying false precision we
    // MEASURE the smile sensitivity: reprice at the barrier's vol vs the ATM vol and publish the span.
    let touchBand = null;
    if (cls.touch) {
      const sB = ivAtK, sA = ivFn(F) || sB;
      const pB = cls.side === 'above' ? probTouchAbove(F, K, T, sB) : probTouchBelow(F, K, T, sB);
      const pA = cls.side === 'above' ? probTouchAbove(F, K, T, sA) : probTouchBelow(F, K, T, sA);
      if (pA != null && pB != null) {
        touchBand = {
          atBarrierVolPct: round(pB * 100, 1), atAtmVolPct: round(pA * 100, 1),
          spanPts: round(Math.abs(pB - pA) * 100, 1),
          note: 'A one-touch is path-dependent: no single volatility is smile-consistent. This span is the model uncertainty from that choice — the rigorous fixes are a local-vol (Dupire) PDE or a vanna-volga adjustment, neither of which runs inside this call. Treat the point estimate as accurate to roughly this span.',
        };
      }
    }

    // The decomposition: a raw options-vs-prediction gap is NOT all mispricing. Part of it is the
    // variance risk premium options structurally carry. Strip that out and what remains is the
    // genuine cross-market dislocation.
    const explainedByVrp = optRw != null ? round((optP - optRw) * 100, 1) : null;
    const residual = optRw != null ? round((yesProb - optRw) * 100, 1) : null;

    out.push({
      question: q,
      resolvesUtc: m.endDate,
      threshold: K,
      resolution: `${cls.side === 'above' ? 'reaches/above' : 'falls to/below'} ${cls.touch ? '(any time before date)' : '(at date)'}`,
      smileTenor: smileTenorBasis,
      predictionMarketProbPct: round(yesProb * 100, 1),
      optionsImpliedProbPct: round(optP * 100, 1),
      optionsRealWorldProbPct: optRw != null ? round(optRw * 100, 1) : null,
      touchSmileUncertainty: touchBand,
      divergencePts: round((yesProb - optP) * 100, 1),                     // vs risk-neutral (raw gap)
      explainedByVariancePremiumPts: explainedByVrp,                       // structural, not an edge
      residualDivergencePts: residual,                                     // the genuine dislocation
      cheaperSide: yesProb > optP ? 'prediction-market prices it HIGHER than options imply' : 'prediction-market prices it LOWER than options imply',
    });
  }
  // Rank by the GENUINE dislocation (after removing the variance premium) when we have it.
  const mag = (x) => Math.abs(x.residualDivergencePts ?? x.divergencePts ?? 0);
  out.sort((a, b) => mag(b) - mag(a));
  return {
    markets: out.slice(0, 5),
    method: 'For each live Polymarket price market on this coin, the options-implied probability of the SAME threshold/date is computed from the option smile and compared to the market\'s own odds. Because the resolution date is generally not a listed option expiry, the arbitrage-free SVI smile is interpolated to that exact tenor in TOTAL VARIANCE (w=σ²T, linear in T across the two bracketing Deribit expiries — calendar-arb-free; σ held flat beyond the fitted range, disclosed per row in smileTenor), and the forward is interpolated likewise. At-date markets use the EXACT risk-neutral CDF via Breeden–Litzenberger, P(S>K)=N(d2)−e^{rT}·vega·∂σ/∂K (plain N(d2) omits the smile term and is biased up to ~5pts on a skewed chain). Reach-by-date markets use the one-touch barrier formula at the barrier\'s own smile vol — a disclosed approximation. A smile-consistent barrier price needs either a local-volatility (Dupire) PDE or the closed-form vanna-volga overhedge built from three vanilla quotes already in the fitted smile; neither runs inside this call, and the model-uncertainty span is published in place of a false precision. The raw gap is then decomposed into the part explained by the variance risk premium options structurally carry (see vrpModel) and the residual dislocation.',
    note: out.length
      ? 'divergencePts is vs the RISK-NEUTRAL options price; much of it is usually the variance risk premium (compensation for tail risk), NOT an edge — residualDivergencePts is what survives after removing it. The residual is not an edge claim either: it also carries the two markets\' different fee, capital and counterparty costs, and the VRP factor itself is not statistically established (see vrpModel.significance). Descriptive cross-market comparison, not advice.'
      : 'No live Polymarket price market on this coin cleanly matched the traded option strikes/expiries right now.',
  };
}
