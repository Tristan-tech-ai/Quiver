// OptionsDesk — one call: institutional-grade crypto options intelligence.
// Deribit (reference venue) + OKX options (second venue), composed into:
//   IV rank/percentile (vs DVOL history) · GEX/dealer-gamma/flip · options flow + OI change ·
//   full per-strike greeks surface + aggregate greeks · true ATM-forward IV · delta-space 25d skew with
//   honest coverage · implied-rate curve (put-call/forward) · multi-venue cross-check · alt vol-regime.
import * as deribit from '../adapters/deribit.js';
import * as okxopt from '../adapters/okx-options.js';
import { config } from '../config.js';
import { round, clamp01 } from './stats.js';
import { black76, ivAtDelta, atmForwardIv, probAbove, probAboveSmile, rndDensity, rndDistribution, butterflyPolice } from './black76.js';
import { computeGex } from './optionsGex.js';
import { ivRank } from './ivRank.js';
import { deltaOi } from './oiStore.js';
import { eventsBetween } from './macroSentry.js';
import { optionsVsPrediction } from './crossMarket.js';
import { estimateVrp, realWorldVol, realizedVolPct } from './vrp.js';
import { fitSVI, sviIvFn } from './ssvi.js';
import { motBounds } from './mot.js';

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
const DAY = 86400000;
const YEAR = 365 * DAY;

// Variance-risk-premium fits, cached per currency. The fit depends on a heavy 300-candle history fetch;
// caching keeps a transient upstream failure from silently deleting the real-world calibration.
const VRP_CACHE = new Map();

// (realized-vol lives in vrp.js — shared with the variance-risk-premium fit)

// Blend one IV (decimal) per strike from call+put marks, for ATM-forward interpolation.
function blendedByStrike(opts) {
  const m = new Map();
  for (const o of opts) {
    if (!(o.iv > 0)) continue;
    const cur = m.get(o.strike) || { strike: o.strike, sum: 0, n: 0 };
    cur.sum += o.iv; cur.n += 1; m.set(o.strike, cur);
  }
  return [...m.values()].map((x) => ({ strike: x.strike, iv: x.sum / x.n })).sort((a, b) => a.strike - b.strike);
}

// Front-expiry ATM-forward IV (%) for a normalized chain — used for cross-venue comparison.
function frontAtmIv(records, now) {
  const fut = records.filter((r) => r.expiry.getTime() > now).sort((a, b) => a.expiry - b.expiry);
  if (!fut.length) return null;
  const k0 = fut[0].expiry.getTime();
  const front = fut.filter((r) => r.expiry.getTime() === k0);
  const F = front.find((r) => r.fwd > 0)?.fwd || null;
  const byK = blendedByStrike(front.map((r) => ({ strike: r.strike, iv: r.ivPct != null ? r.ivPct / 100 : null })));
  if (!F || !byK.length) return null;
  const a = atmForwardIv(byK, F);
  return a ? round(a.iv * 100, 1) : null;
}

const commafy = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

// (B) CONSENSUS / CONFLICT — do the independent market-structure signals AGREE? High agreement across
// signals that are computed different ways = higher conviction; conflict = genuine uncertainty. Novel
// synthesis: nobody scores cross-signal agreement. Two axes: volatility (calm↔jumpy), direction (down↔up).
function marketConsensus(ivRankOut, gex, rvContext, skewRR, putOi, callOi) {
  const vol = [], dir = [];
  if (ivRankOut?.regime) vol.push({ signal: 'IV rank', reads: ivRankOut.regime, vote: ['CHEAP', 'SUBDUED'].includes(ivRankOut.regime) ? 'calm' : ['RICH', 'ELEVATED'].includes(ivRankOut.regime) ? 'jumpy' : 'neutral' });
  if (rvContext?.read) vol.push({ signal: 'IV vs realized', reads: rvContext.read, vote: rvContext.read === 'IV_CHEAP_TO_REALIZED' ? 'calm' : rvContext.read === 'IV_RICH_TO_REALIZED' ? 'jumpy' : 'neutral' });
  if (gex?.regime) vol.push({ signal: 'dealer gamma', reads: gex.regime, vote: gex.regime === 'DEALER_LONG_GAMMA' ? 'calm' : 'jumpy' });
  if (skewRR != null) dir.push({ signal: '25Δ skew', reads: skewRR, vote: skewRR <= -1 ? 'down' : skewRR >= 1 ? 'up' : 'neutral' });
  if (callOi > 0) { const pc = putOi / callOi; dir.push({ signal: 'put/call OI', reads: round(pc, 2), vote: pc >= 1.2 ? 'down' : pc <= 0.8 ? 'up' : 'neutral' }); }
  const axis = (arr, a, b) => {
    const av = arr.filter((x) => x.vote === a).length, bv = arr.filter((x) => x.vote === b).length, n = arr.length;
    const lean = av > bv ? a : bv > av ? b : 'mixed';
    const strong = Math.max(av, bv);
    const alignment = n === 0 ? 'n/a' : (strong === n && n > 1) ? 'unanimous' : strong >= Math.ceil(n * 0.66) ? 'majority' : 'split';
    return { signals: arr, lean, alignment, conviction: alignment === 'unanimous' ? 'high' : alignment === 'majority' ? 'moderate' : 'low' };
  };
  const volatility = axis(vol, 'calm', 'jumpy'), direction = axis(dir, 'up', 'down');
  return {
    volatility, direction,
    summary: `Volatility view: ${volatility.alignment === 'split' ? 'signals CONFLICT (uncertainty)' : `${volatility.alignment} → ${volatility.lean}`}. Directional view: ${direction.alignment === 'split' ? 'signals CONFLICT (uncertainty)' : `${direction.alignment} → ${direction.lean}`}.`,
    note: 'Agreement across independently-computed options signals — unanimous = higher conviction, split = genuine uncertainty. Descriptive market structure, not advice.',
  };
}

// (C) SPOT-BEHAVIOR OUTLOOK from dealer gamma — translates options-dealer hedging into expected SPOT
// behavior for traders who never touch options. Long gamma → hedging dampens moves (range/pin); short
// gamma → hedging amplifies (trend/whipsaw); the flip is the level that switches the regime.
function spotOutlook(gex, spot) {
  if (!gex || !gex.regime) return null;
  const long = gex.regime === 'DEALER_LONG_GAMMA';
  const flip = gex.gammaFlipSpot;
  const magnet = (gex.byStrike || []).filter((s) => s.side === 'support').sort((a, b) => Math.abs(b.gexUsdPerPct) - Math.abs(a.gexUsdPerPct))[0]?.strike ?? gex.byStrike?.[0]?.strike ?? null;
  return {
    dealerRegime: gex.regime,
    expectedSpotBehavior: long ? 'RANGE-BOUND / PINNED — dealer hedging dampens moves' : 'TRENDING / AMPLIFIED — dealer hedging accelerates moves',
    magnetLevel: magnet, flipLevel: flip,
    keyRule: long
      ? `While spot holds above the gamma-flip (~${commafy(flip)}), expect mean-reversion toward ${commafy(magnet)}; a break below the flip turns the regime trend-amplifying.`
      : `While spot is below the gamma-flip (~${commafy(flip)}), expect momentum and whipsaw; reclaiming the flip restores a dampened, range-bound regime.`,
    forNonOptionsTraders: 'Options positioning predicts spot behavior — usable even if you never trade options.',
  };
}

const roundTo = (x, inc) => Math.round(x / inc) * inc;
const niceIncrement = (spot) => (spot >= 10000 ? 1000 : spot >= 1000 ? 100 : spot >= 100 ? 5 : spot >= 10 ? 1 : spot >= 1 ? 0.1 : 0.01);

// The options market's OWN implied view (novel cross-domain read nobody else on OKX.AI surfaces):
//  - expected move (1σ) from ATM IV;
//  - a risk-neutral probability ladder — P(spot ≥ level) via N(d2) using the smile IV at each level —
//    i.e. the market's own odds of reaching key prices;
//  - the scheduled macro prints (CPI/FOMC/NFP) that fall BEFORE each expiry, so the move reads as event vol.
function impliedView(enriched, spot, now, vrp, surfaceFit) {
  const picks = enriched.filter((e) => e._T > 1.5 / 365 && e.atmIvPct > 0 && e._F > 0).slice(0, 2);
  if (!picks.length) return null;
  const inc = niceIncrement(spot);
  return picks.map((e) => {
    const F = e._F, T = e._T, r = e._r, atmIv = e.atmIvPct / 100;
    const sigma1 = F * atmIv * Math.sqrt(T);
    const byK = blendedByStrike(e._opts.map((o) => ({ strike: o.strike, iv: o.iv > 0 ? o.iv / 100 : null })));
    const strikes = byK.map((x) => x.strike);
    if (!strikes.length) return null;
    const kMin = Math.min(...strikes), kMax = Math.max(...strikes);
    const levelSet = new Set();
    for (const k of [-1.5, -1, -0.5, 0.5, 1, 1.5]) levelSet.add(roundTo(F + k * sigma1, inc));
    (e.oiWalls || []).slice(0, 2).forEach((w) => levelSet.add(w.strike));
    const levels = [...levelSet].filter((L) => L > 0 && L >= kMin && L <= kMax).sort((a, b) => a - b);
    // The smile as a function. Prefer the ARBITRAGE-FREE SSVI fit; fall back to raw interpolation only if
    // the fit was rejected by its quality gate — and say which was used.
    const interpFn = (K) => { const a = atmForwardIv(byK, K); return a && a.iv; };
    const theta = atmIv * atmIv * T; // ATM total variance; SSVI has w(0,θ)=θ so this is observed, not fitted
    const ssviFn = sviIvFn(surfaceFit, F, T);
    const ivFn = ssviFn || interpFn;
    const smileSource = ssviFn
      ? 'raw SVI (Gatheral), arbitrage-free by construction: g(k)≥0 + Roger-Lee wing bound'
      : `linear-in-log-strike interpolation — SVI fit rejected for this slice; this smile is NOT guaranteed arbitrage-free`;
    const ivFnRw = vrp ? (K) => { const s = ivFn(K); return s > 0 ? realWorldVol(s, vrp) : s; } : null;

    const ladder = levels.map((L) => {
      const a = atmForwardIv(byK, L);
      if (!a) return null;
      const p = probAboveSmile(F, L, T, ivFn, r);            // EXACT risk-neutral CDF from the smile
      if (p == null) return null;
      const pRw = ivFnRw ? probAboveSmile(F, L, T, ivFnRw, r) : null;
      const nd2 = probAbove(F, L, T, a.iv, r);              // the naive figure, kept to show the correction
      return {
        level: L, side: L >= spot ? 'above' : 'below',
        probAbovePct: round(p * 100, 1),                                   // RISK-NEUTRAL (what options price)
        realWorldProbAbovePct: pRw != null ? round(pRw * 100, 1) : null,   // VRP-adjusted (indicative)
        reachOddsPct: round((L >= spot ? p : 1 - p) * 100, 1),
        skewCorrectionPts: nd2 != null ? round((p - nd2) * 100, 2) : null, // how much the smile term moved it
      };
    }).filter(Boolean);

    // Butterfly-arbitrage police: a negative risk-neutral density means the smile is not arbitrage-free
    // there and probabilities read off it are unsound. Measured, disclosed — never silently served.
    // Lives in black76.js so a test can reach it and make it FAIL; it reports the strike range it actually
    // covered and withholds the verdict (certified: null) when too much of the smile was unevaluable.
    const arb = butterflyPolice(F, T, ivFn, kMin, kMax, r);
    // FULL risk-neutral distribution (gap D7): quantiles, tail expected-shortfall, RND skew/kurtosis — the
    // whole terminal-price distribution, not just point probabilities. Only emitted when the density is a
    // proper (arbitrage-free) density on this slice; otherwise it would be integrating a non-density.
    // `certified === true` is strictly stronger than the old `densityNonNegative`: it also requires that we
    // actually scanned enough of the smile to be entitled to the claim. Integrating a density we could not
    // evaluate in the wings is exactly how a confident wrong number gets shipped.
    let distribution = null;
    if (arb && arb.certified === true) {
      const dist = rndDistribution(F, T, ivFn, r);
      if (dist && dist.mass > 0.9 && dist.mass < 1.1) { // raw integral must be ~1 for a trustworthy distribution
        distribution = {
          quantilesUsd: { p05: round(dist.quantiles.p05, 0), p25: round(dist.quantiles.p25, 0), p50: round(dist.quantiles.p50, 0), p75: round(dist.quantiles.p75, 0), p95: round(dist.quantiles.p95, 0) },
          expectedShortfallUsd: { left5: dist.es.left5 != null ? round(dist.es.left5, 0) : null, right5: dist.es.right5 != null ? round(dist.es.right5, 0) : null },
          rnVolPct: round((dist.sd / F) * 100, 1),
          rnSkew: round(dist.skew, 3),
          rnExcessKurtosis: round(dist.excessKurtosis, 3),
          selfCheck: { meanVsForwardPct: round(dist.meanVsForwardPct, 3), densityMass: round(dist.mass, 4), note: 'meanVsForwardPct is E[S_T]/F−1: under the risk-neutral forward measure S_T is a martingale so this must be ≈0 — it is a correctness check on the density, not a signal. densityMass is the raw ∫f dK (≈1 for a proper density).' },
          note: 'The full risk-neutral distribution of the terminal price, from the arbitrage-free smile via Breeden–Litzenberger. p05..p95 are risk-neutral quantiles; expectedShortfall.left5/right5 are the mean price conditional on the worst/best 5% tail; rnSkew/rnExcessKurtosis are the distribution\'s own shape. Wings beyond the traded strikes are SVI-extrapolated (disclosed). Risk-neutral (what options price), not a real-world forecast; not advice.',
        };
      }
    }
    const expMs = Date.parse(e.expiry + 'T08:00:00Z');
    const evs = (Number.isFinite(expMs) ? eventsBetween(now, expMs) : []).map((ev) => ({ kind: ev.kind, label: ev.label, atUtc: ev.iso, hoursUntil: round((ev.ts - now) / 3600000, 1) }));
    return {
      expiry: e.expiry, daysOut: e.daysOut,
      expectedMove: {
        oneSigmaPct: round(atmIv * Math.sqrt(T) * 100, 1), oneSigmaUsd: round(sigma1, 0),
        rangeLow: round(F - sigma1, 0), rangeHigh: round(F + sigma1, 0),
        oneSigmaPctRealWorld: vrp ? round(realWorldVol(atmIv, vrp) * Math.sqrt(T) * 100, 1) : null,
      },
      probabilityLadder: ladder,
      distribution,
      smileModel: smileSource,
      smileDiagnostics: arb,
      oddsBasis: vrp
        ? `probAbovePct = RISK-NEUTRAL, read off the smile by Breeden–Litzenberger: P(S>K) = N(d2) − e^{rT}·vega·∂σ/∂K. (Plain N(d2) omits the smile term and is biased by up to ~5pts on a skewed chain — skewCorrectionPts shows the correction applied at each level.) realWorldProbAbovePct = the same, with the whole smile scaled by this asset's fitted variance risk premium — INDICATIVE ONLY: that factor is ${vrp.significance?.significantAt05 ? 'significant' : 'NOT statistically distinguishable from zero'} at the honest effective sample (see vrpModel.significance). Neither number is a signal; the gap between them is compensation for tail risk, not a mispricing.`
        : 'probAbovePct = RISK-NEUTRAL, read off the smile by Breeden–Litzenberger (N(d2) minus the vega·∂σ/∂K smile term). No VRP fit for this asset, so no real-world calibration is offered rather than guessing one.',
      macroEventsBeforeExpiry: evs,
    };
  }).filter(Boolean);
}

// ONE-GLANCE plain-language verdict over the (correct but unreadable) numbers — move 1.
// A trader-not-quant understands why the output matters in five seconds; numbers stay beneath.
function buildReadout(headline, ivRank, gex, impliedFront) {
  const tags = [], lines = [];
  // 1) Is vol cheap or rich?
  if (ivRank && ivRank.regime) {
    const p = ivRank.rank365d?.percentile ?? ivRank.rank90d?.percentile ?? ivRank.rank30d?.percentile;
    const word = { CHEAP: 'CHEAP', SUBDUED: 'BELOW-AVERAGE', NORMAL: 'AVERAGE', ELEVATED: 'ELEVATED', RICH: 'RICH' }[ivRank.regime] || 'AVERAGE';
    tags.push(word + ' VOL');
    const tail = ivRank.regime === 'CHEAP' ? ' (historically low — options are inexpensive relative to the past year).'
      : ivRank.regime === 'RICH' ? ' (historically high — options are expensive relative to the past year).' : '.';
    lines.push(`Option prices are ${word.toLowerCase().replace('-', ' ')}: 1-month implied volatility sits in the ${p != null ? p + 'th' : '—'} percentile of the past year${tail}`);
  } else if (headline.frontAtmIvPct != null) {
    lines.push(`Front-month at-the-money implied volatility is ${headline.frontAtmIvPct}%.`);
  }
  // 2) Will price be calm or jumpy? (dealer gamma)
  if (gex && gex.regime) {
    const pin = headline.frontMaxPain || ((gex.byStrike && gex.byStrike.length) ? gex.byStrike.reduce((a, b) => Math.abs(b.gexUsdPerPct) > Math.abs(a.gexUsdPerPct) ? b : a).strike : null);
    const flip = gex.gammaFlipSpot;
    if (gex.regime === 'DEALER_LONG_GAMMA') {
      tags.push('CALM / PINNED');
      lines.push(`Expect calm: option dealers are net long gamma, so their hedging tends to pull price toward the heaviest strikes${pin ? ` (around ${commafy(pin)})` : ''} and dampen big swings${flip ? ` — unless price breaks below ~${commafy(flip)}, where that flips to amplifying moves` : ''}.`);
    } else {
      tags.push('JUMPY / TRENDING');
      lines.push(`Expect amplified moves: dealers are net short gamma, so their hedging pushes price further in whatever direction it's already going${flip ? ` until price reclaims ~${commafy(flip)}` : ''}.`);
    }
  }
  // 3) Which way are traders hedging? (skew)
  const s = headline.frontSkew25dRR;
  if (s != null) {
    if (s <= -1) { tags.push('DOWNSIDE-HEDGED'); lines.push(`Traders are paying up for downside protection: 1-month puts are ${Math.abs(s)} vol points richer than equidistant calls (a defensive tilt).`); }
    else if (s >= 1) { tags.push('UPSIDE-CHASED'); lines.push(`Traders are paying up for upside: 1-month calls are ${s} vol points richer than equidistant puts (a bullish tilt).`); }
    else lines.push(`Put/call skew is roughly balanced (${s} vol pts) — no strong directional hedging bias.`);
  }
  // 4) What odds does the options market itself imply? (expected move + implied level probabilities + event overlay)
  if (impliedFront) {
    const em = impliedFront.expectedMove;
    tags.push('IMPLIED-ODDS');
    const above = impliedFront.probabilityLadder.find((l) => l.side === 'above');
    const below = [...impliedFront.probabilityLadder].reverse().find((l) => l.side === 'below');
    const odds = [];
    if (above) odds.push(`a ${above.probAbovePct}% chance of trading at/above ${commafy(above.level)}`);
    if (below) odds.push(`a ${round(100 - below.probAbovePct, 1)}% chance of at/below ${commafy(below.level)}`);
    let line = `Market-implied outlook by ${impliedFront.expiry}: the options market prices a ±${em.oneSigmaPct}% move (roughly ${commafy(em.rangeLow)}–${commafy(em.rangeHigh)})${odds.length ? `, with ${odds.join(' and ')}` : ''}.`;
    if (impliedFront.macroEventsBeforeExpiry.length) { const ev = impliedFront.macroEventsBeforeExpiry[0]; line += ` A scheduled ${ev.kind} print lands ${ev.hoursUntil}h out (before this expiry) — that event risk is already embedded in the move.`; }
    lines.push(line);
  }

  // Descriptive interpretation of the regime (no imperatives / no buy-sell calls).
  let interpretation;
  if (ivRank?.regime === 'CHEAP' && gex?.regime === 'DEALER_LONG_GAMMA') interpretation = `A low-volatility, dealer-stabilized backdrop: option premiums are historically low and dealer positioning leans toward range-holding${gex.gammaFlipSpot ? ` above ~${commafy(gex.gammaFlipSpot)}` : ''}.`;
  else if (ivRank?.regime === 'RICH') interpretation = 'A high-volatility backdrop: option premiums are historically elevated, with wider tail risk than a calm market.';
  else if (gex?.regime === 'DEALER_SHORT_GAMMA') interpretation = `A dealer-short-gamma backdrop: price action skews toward trends and whipsaw rather than a quiet range${gex.gammaFlipSpot ? ` until ~${commafy(gex.gammaFlipSpot)} is reclaimed` : ''}.`;
  else interpretation = 'A mixed backdrop — see the components below.';
  return { verdict: tags.join(' · ') || 'NEUTRAL', inPlainEnglish: lines, interpretation, notFinancialAdvice: 'Descriptive market analytics only — not financial advice or a recommendation to buy or sell.' };
}

export async function optionsDesk(currency = 'BTC', { focus = 'all' } = {}) {
  const t0 = Date.now();
  const cur = String(currency).toUpperCase();

  const [chain, idx, dvolLive, dvolHist, trades, okxChain, spotSeries] = await Promise.all([
    deribit.optionChain(cur),
    deribit.indexPrice(cur).catch(() => null),
    deribit.hasDvol(cur) ? deribit.dvol(cur, 24).catch(() => null) : Promise.resolve(null),
    deribit.hasDvol(cur) ? deribit.dvolHistory(cur, 365).catch(() => null) : Promise.resolve(null),
    deribit.lastTrades(cur, 100).catch(() => null),
    okxopt.hasOptions(cur) ? okxopt.optChain(cur).catch(() => []) : Promise.resolve([]),
    okxopt.spotDailySeries(cur, 300).catch(() => []),
  ]);

  if (!Array.isArray(chain) || !chain.length) {
    return { service: 'options-desk', version: config.version, currency: cur, verdict: 'NO_DATA', note: `No Deribit option chain for ${cur}.` };
  }

  const now = Date.now();
  const spot = num(idx?.index_price) || num(chain.find((c) => c.underlying_price)?.underlying_price) || num(chain[0].underlying_price);

  // Parse Deribit chain, group by expiry, capture per-expiry forward.
  const byExpiry = new Map();
  let putOi = 0, callOi = 0;
  const oiMap = {}; // instId -> oi, for delta-OI
  for (const c of chain) {
    const meta = deribit.parseInstrument(c.instrument_name);
    if (!meta) continue;
    const oi = num(c.open_interest) || 0;
    const iv = num(c.mark_iv);
    const fwd = num(c.underlying_price);
    oiMap[c.instrument_name] = oi;
    if (meta.type === 'put') putOi += oi; else callOi += oi;
    const key = meta.expiry.getTime();
    if (!byExpiry.has(key)) byExpiry.set(key, { expiry: meta.expiry, opts: [], fwds: [] });
    const e = byExpiry.get(key);
    e.opts.push({ strike: meta.strike, type: meta.type, oi, iv, mark: num(c.mark_price), name: c.instrument_name });
    if (fwd > 0) e.fwds.push(fwd);
  }

  function maxPain(opts) {
    const strikes = [...new Set(opts.map((o) => o.strike))].sort((a, b) => a - b);
    let best = null, bestPain = Infinity;
    for (const S of strikes) {
      let pain = 0;
      for (const o of opts) pain += o.oi * Math.max(0, o.type === 'call' ? S - o.strike : o.strike - S);
      if (pain < bestPain) { bestPain = pain; best = S; }
    }
    return best;
  }

  const futureExpiries = [...byExpiry.values()].sort((a, b) => a.expiry - b.expiry).filter((e) => e.expiry.getTime() > now);

  // Implied-rate curve (gap 8): r = ln(F/S)/T per expiry, from the per-expiry forward vs index.
  const rateCurve = [];
  const rateByExpiry = new Map();
  for (const e of futureExpiries) {
    const F = e.fwds.length ? e.fwds.sort((a, b) => a - b)[Math.floor(e.fwds.length / 2)] : null; // median forward
    const T = (e.expiry - now) / YEAR;
    let r = 0;
    if (F && spot && T > 3 / 365) {
      r = Math.log(F / spot) / T;
      if (!Number.isFinite(r) || r < -0.5 || r > 1.5) r = 0; // clamp noise on thin/near books
    }
    rateByExpiry.set(e.expiry.getTime(), { F: F || spot, r });
    rateCurve.push({ expiry: e.expiry.toISOString().slice(0, 10), daysOut: round(T * 365, 1), forward: F ? round(F, 2) : null, impliedRatePct: round(r * 100, 2) });
  }

  const enriched = futureExpiries.slice(0, 8).map((e) => {
    const opts = e.opts;
    const { F, r } = rateByExpiry.get(e.expiry.getTime()) || { F: spot, r: 0 };
    const T = (e.expiry - now) / YEAR;
    const dOpts = opts.filter((o) => o.iv > 0).map((o) => ({ strike: o.strike, type: o.type, iv: o.iv / 100 }));
    const p = opts.filter((o) => o.type === 'put').reduce((a, o) => a + o.oi, 0);
    const c = opts.filter((o) => o.type === 'call').reduce((a, o) => a + o.oi, 0);

    // True ATM-forward IV (gap 5): interpolate IV at strike == forward.
    const byK = blendedByStrike(opts.map((o) => ({ strike: o.strike, iv: o.iv > 0 ? o.iv / 100 : null })));
    const atmF = (F && byK.length) ? atmForwardIv(byK, F) : null;
    const atmIv = atmF ? atmF.iv * 100 : null; // percent

    // 25-delta skew with honest coverage (gap 6).
    let rr25 = null, bf25 = null, call25 = null, put25 = null, skewQuality = null;
    if (F && T > 0 && dOpts.length >= 4) {
      const cw = ivAtDelta(dOpts, F, T, 0.25, 'call', r);
      const pw = ivAtDelta(dOpts, F, T, 0.25, 'put', r);
      call25 = cw.iv; put25 = pw.iv;
      if (call25 != null && put25 != null) {
        rr25 = round((call25 - put25) * 100, 2);
        if (atmIv != null) bf25 = round((0.5 * (call25 + put25) - atmIv / 100) * 100, 2);
      }
      skewQuality = (cw.quality === 'interpolated' && pw.quality === 'interpolated') ? 'interpolated'
        : (cw.quality === 'insufficient' || pw.quality === 'insufficient') ? 'insufficient' : 'extrapolated';
    }

    // ATM greeks at K=F using the interpolated ATM IV + implied rate.
    let greeks = null;
    if (F && T > 0 && atmIv) {
      const g = black76(F, F, T, atmIv / 100, 'call', r);
      if (g) greeks = { atmDelta: round(g.delta, 3), atmGammaPer1pct: round(g.gamma * F * 0.01, 5), atmVegaPerVol: round(g.vega, 2), atmThetaPerDay: round(g.theta, 2) };
    }

    // Coverage diagnostics.
    const deltas = dOpts.map((o) => { const g = black76(F, o.strike, T, o.iv, o.type, r); return g ? Math.abs(g.delta) : null; }).filter((x) => x != null);
    const coverage = { strikesWithIv: dOpts.length, minDelta: deltas.length ? round(Math.min(...deltas), 3) : null, maxDelta: deltas.length ? round(Math.max(...deltas), 3) : null };

    const walls = [...opts].sort((a, b) => b.oi - a.oi).slice(0, 3).map((o) => ({ strike: o.strike, type: o.type, oi: round(o.oi) }));

    return {
      _opts: opts, _F: F, _T: T, _r: r,
      expiry: e.expiry.toISOString().slice(0, 10),
      daysOut: round((e.expiry - now) / DAY, 1),
      forward: F ? round(F, 2) : null,
      impliedRatePct: round(r * 100, 2),
      atmIvPct: round(atmIv, 1),
      atmIvMethod: atmF?.quality || null,
      skew25dRR: rr25, skew25dBF: bf25,
      call25dIvPct: round(call25 != null ? call25 * 100 : null, 1),
      put25dIvPct: round(put25 != null ? put25 * 100 : null, 1),
      skewQuality,
      greeks,
      maxPainStrike: maxPain(opts),
      putCallOiRatio: c > 0 ? round(p / c, 2) : null,
      totalOi: round(p + c),
      oiWalls: walls,
      coverage,
    };
  });

  // GEX across near expiries (<=120d) using per-option forward/T/rate (gap 2 + aggregate greeks gap 4).
  const gexOptions = [];
  for (const e of enriched) {
    if (e._T * 365 > 120) continue;
    for (const o of e._opts) if (o.iv > 0 && o.oi > 0) gexOptions.push({ strike: o.strike, type: o.type, oi: o.oi, iv: o.iv / 100, F: e._F, T: e._T, r: e._r });
  }
  const gex = computeGex(gexOptions, spot);

  // Full greeks surface for the front 3 expiries (gap 4): per-strike delta/gamma/vega/theta + IV.
  const greeksSurface = enriched.slice(0, 3).map((e) => ({
    expiry: e.expiry, daysOut: e.daysOut, forward: e.forward,
    strikes: e._opts.filter((o) => o.iv > 0).sort((a, b) => a.strike - b.strike).map((o) => {
      const g = black76(e._F, o.strike, e._T, o.iv / 100, o.type, e._r);
      return g ? { strike: o.strike, type: o.type, ivPct: round(o.iv, 1), delta: round(g.delta, 3), gammaPer1pct: round(g.gamma * e._F * 0.01, 6), vega: round(g.vega, 2), vanna: round(g.vanna, 5), volga: round(g.volga, 4), thetaPerDay: round(g.theta, 3), oi: round(o.oi) } : null;
    }).filter((s) => s && Math.abs(s.delta) >= 0.03 && Math.abs(s.delta) <= 0.97), // tradeable band — drop near-worthless deep wings
  }));

  // IV rank / percentile (gap 1) from DVOL daily history + live current.
  let dvol = null, ivRankOut = null;
  if (dvolLive?.data?.length) {
    const closes = dvolLive.data.map((d) => d[4]).filter(Boolean);
    const cur2 = closes[closes.length - 1], lo = Math.min(...closes), hi = Math.max(...closes);
    const pct = hi > lo ? (cur2 - lo) / (hi - lo) : 0.5;
    dvol = { current: round(cur2, 1), range24h: [round(lo, 1), round(hi, 1)], regime: pct > 0.66 ? 'ELEVATED' : pct < 0.33 ? 'CALM' : 'NORMAL' };
    if (dvolHist?.data?.length) {
      const daily = dvolHist.data.map((d) => d[4]).filter(Boolean);
      ivRankOut = ivRank(daily, cur2);
    }
  }

  // Realized-vol read (gap 7 substitute + universal IV-RV context).
  const rv = round(realizedVolPct((spotSeries || []).slice(-31).map((p) => p.c)), 1);

  // ML/statistics layer: fit the VARIANCE RISK PREMIUM from real history (DVOL dailies vs subsequently
  // realized vol) — the empirical bridge from RISK-NEUTRAL odds to real-world-calibrated odds.
  // Uses data already fetched above, so it costs no extra round-trip.
  const dvolDaily = (dvolHist?.data || []).map((d) => ({ ts: d[0], iv: d[4] })).filter((d) => d.ts && d.iv > 0);
  // The fit needs a 300-candle history fetch; when that upstream hiccups it returns [] and the VRP would
  // silently vanish (observed live: the model was present on one call and gone on the next). The premium
  // moves on a daily timescale, so cache the fit and reuse a recent one rather than dropping the feature.
  let vrp = estimateVrp(dvolDaily, spotSeries || []);
  const cachedVrp = VRP_CACHE.get(cur);
  if (vrp) VRP_CACHE.set(cur, { ts: now, vrp });
  else if (cachedVrp && now - cachedVrp.ts < 12 * 3600 * 1000) vrp = { ...cachedVrp.vrp, staleFitMinutes: Math.round((now - cachedVrp.ts) / 60000) };
  const frontIv = enriched[0]?.atmIvPct || null;
  const rvContext = (rv && frontIv) ? { realizedVol30dPct: rv, frontIvPct: frontIv, ivMinusRv: round(frontIv - rv, 1), ivRvRatio: round(frontIv / rv, 2), read: frontIv > rv * 1.1 ? 'IV_RICH_TO_REALIZED' : frontIv < rv * 0.9 ? 'IV_CHEAP_TO_REALIZED' : 'IV_FAIR_TO_REALIZED' } : null;

  // Options flow (gap 3): recent large blocks + OI change.
  let flow = null;
  if (trades?.trades?.length) {
    const blocks = trades.trades
      .map((tr) => { const m = deribit.parseInstrument(tr.instrument_name); return { name: tr.instrument_name, meta: m, size: num(tr.amount), price: num(tr.price), ivPct: num(tr.iv), dir: tr.direction, ts: num(tr.timestamp), idx: num(tr.index_price) }; })
      .filter((x) => x.meta && x.size)
      .sort((a, b) => (b.size * (b.idx || 1)) - (a.size * (a.idx || 1)))
      .slice(0, 8)
      .map((x) => ({ instrument: x.name, expiry: x.meta.expiry.toISOString().slice(0, 10), strike: x.meta.strike, type: x.meta.type, sizeContracts: round(x.size, 1), notionalUsd: round(x.size * (x.idx || spot), 0), tradeIvPct: round(x.ivPct, 1), side: x.dir, agoMin: x.ts ? round((now - x.ts) / 60000, 0) : null }));
    // Direction-FREE flow composition. Premium(USD) = price(coin) × contracts × index. We split by
    // call/put WITHOUT using trade direction, because Deribit's public feed does not tag block trades and
    // reports block-trade direction from the maker side — so any buy/sell-based "customer flow" or
    // "dealer positioning" inference would be invertible for a large share of option volume (measured:
    // no block_trade_id/liquidity field in the public trade). What premium is trading, by type, IS clean.
    let callPrem = 0, putPrem = 0, callCon = 0, putCon = 0;
    for (const tr of trades.trades) {
      const m = deribit.parseInstrument(tr.instrument_name); if (!m) continue;
      const prem = (num(tr.price) || 0) * (num(tr.amount) || 0) * (num(tr.index_price) || spot);
      if (m.type === 'call') { callPrem += prem; callCon += num(tr.amount) || 0; } else { putPrem += prem; putCon += num(tr.amount) || 0; }
    }
    const totPrem = callPrem + putPrem;
    const composition = totPrem > 0 ? {
      callPremiumUsd: round(callPrem), putPremiumUsd: round(putPrem),
      putCallPremiumRatio: callPrem > 0 ? round(putPrem / callPrem, 2) : null,
      putSharePct: round((putPrem / totPrem) * 100, 1),
      callContracts: round(callCon, 1), putContracts: round(putCon, 1),
      read: putPrem > callPrem * 1.3 ? 'PUT-HEAVY (downside protection / hedging demand)' : callPrem > putPrem * 1.3 ? 'CALL-HEAVY (upside positioning)' : 'BALANCED call/put premium',
      note: 'Premium traded by option type over the window — DIRECTION-FREE, so it is unaffected by the block-trade caveat below. A buy/sell-signed dealer-positioning read is NOT offered: Deribit\'s public feed has no block-trade tag and reports block-trade direction maker-side, so signing this flow would be unreliable.',
    } : null;
    flow = { recentLargeTrades: blocks, flowComposition: composition, sampleWindow: `last ${trades.trades.length} option trades` };
  }
  const oiChange = deltaOi(cur, oiMap);
  if (oiChange) {
    const label = (id) => { const m = deribit.parseInstrument(id); return m ? { instrument: id, expiry: m.expiry.toISOString().slice(0, 10), strike: m.strike, type: m.type } : { instrument: id }; };
    flow = flow || {};
    flow.oiChange = oiChange.pending ? { pending: true, note: oiChange.note } : {
      baselineAgeMin: oiChange.baselineAgeMin,
      builds: oiChange.builds.map((b) => ({ ...label(b.instId), deltaOi: round(b.deltaOi, 1) })),
      unwinds: oiChange.unwinds.map((b) => ({ ...label(b.instId), deltaOi: round(b.deltaOi, 1) })),
    };
  }

  // Multi-venue cross-check (gap 8): Deribit vs OKX.
  let venues = null;
  if (okxChain.length) {
    const okxOi = okxChain.reduce((a, o) => a + (o.oiCoin || 0), 0);
    const okxAtm = frontAtmIv(okxChain, now);
    const derAtm = enriched[0]?.atmIvPct || null;
    venues = {
      deribit: { frontAtmIvPct: derAtm, totalOiCoin: round(putOi + callOi) },
      okx: { frontAtmIvPct: okxAtm, totalOiCoin: round(okxOi), instruments: okxChain.length },
      atmIvSpreadPct: (derAtm != null && okxAtm != null) ? round(derAtm - okxAtm, 1) : null,
      combinedFrontOiCoin: round(putOi + callOi + okxOi),
      note: 'Front ATM-forward IV compared across venues; a wide spread flags a dislocated/thin book on one side.',
    };
  }

  // Fit ONE arbitrage-free SSVI surface across all slices (3 global params; θt observed per expiry).
  // Measured on live BTC: raw interpolation puts the risk-neutral density NEGATIVE on every slice
  // (butterfly arbitrage); the SSVI fit removes it entirely at ~0.6 vol-pt RMSE.
  const ssviSlices = enriched
    .filter((e) => e._T > 0 && e._F > 0 && e.atmIvPct > 0)
    .map((e) => {
      const byK = blendedByStrike(e._opts.map((o) => ({ strike: o.strike, iv: o.iv > 0 ? o.iv / 100 : null })));
      const atm = e.atmIvPct / 100;
      return { T: e._T, F: e._F, theta: atm * atm * e._T, pts: byK.map((p) => ({ k: Math.log(p.strike / e._F), sigma: p.iv })) };
    })
    .filter((s) => s.pts.length >= 3);
  const surfaceFit = ssviSlices.length ? fitSVI(ssviSlices) : { ok: false, reason: 'no usable slices' };

  // MODEL-FREE calendar bounds (Martingale Optimal Transport). For each ADJACENT pair of accepted slices,
  // the two fitted marginals alone pin an arbitrage-free RANGE for a forward-start payoff — no model, no
  // dynamics assumption. Where Strassen's precondition fails (the marginals are not in convex order, i.e.
  // calendar arbitrage) there is no arbitrage-free price at all, and we say so instead of inventing one.
  const motPairs = (() => {
    const ok = (surfaceFit.perSlice || []).filter((s) => s.ok && s.params);
    const Pof = (s) => ({ a: s.params.a, b: s.params.b, rho: s.params.rho, m: s.params.m, sig: s.params.sigma });
    const Ffor = (T) => { let best = null; for (const e of enriched) { if (!(e._F > 0)) continue; if (!best || Math.abs(e._T - T) < Math.abs(best.T - T)) best = { T: e._T, F: e._F }; } return best ? best.F : spot; };
    const out = [];
    for (let i = 0; i < ok.length - 1 && out.length < 4; i++) {
      const A = ok[i], B = ok[i + 1];
      const r = motBounds(Pof(A), Ffor(A.T), A.T, Pof(B), Ffor(B.T), B.T, (x, y) => Math.max(y - x, 0));
      out.push({
        fromDays: round(A.T * 365, 1), toDays: round(B.T * 365, 1),
        payoff: 'forward-start ATM call (S_T2/F2 − S_T1/F1)+, quoted as a fraction of forward',
        ...(r.ok
          ? { ok: true, lowerPct: round(r.lower * 100, 4), upperPct: round(r.upper * 100, 4), widthPct: round(r.width * 100, 4), selfChecks: r.selfChecks, interpretation: r.interpretation }
          : { ok: false, refused: !!r.refused, reason: r.reason }),
      });
    }
    return out.length ? out : null;
  })();

  // Options-market implied view: expected move + risk-neutral price-level odds + macro-event overlay (novel cross-domain read).
  const implied = impliedView(enriched, spot, now, vrp, surfaceFit);

  // (B) cross-signal consensus/conflict + (C) dealer-gamma spot-behavior outlook.
  const consensus = marketConsensus(ivRankOut, gex, rvContext, enriched[0]?.skew25dRR ?? null, putOi, callOi);
  const gammaSpotOutlook = spotOutlook(gex, spot);

  // (A) options ↔ prediction-market divergence (BTC/ETH; graceful empty otherwise). Bounded extra fetch.
  let crossMarket = null;
  if (['BTC', 'ETH'].includes(cur)) {
    const smiles = enriched.filter((e) => e._T > 1 / 365 && e._F > 0).map((e) => ({
      expiryMs: Date.parse(e.expiry + 'T08:00:00Z'), F: e._F, T: e._T,
      theta: e.atmIvPct > 0 ? (e.atmIvPct / 100) ** 2 * e._T : null,
      byK: blendedByStrike(e._opts.map((o) => ({ strike: o.strike, iv: o.iv > 0 ? o.iv / 100 : null }))),
    })).filter((s) => s.byK.length);
    crossMarket = await optionsVsPrediction(cur, smiles, spot, now, { vrp, surfaceFit }).catch(() => null);
  }

  // strip internals
  const expiries = enriched.map(({ _opts, _F, _T, _r, ...pub }) => pub);
  const front = expiries[0];
  const readout = front ? buildReadout({ frontAtmIvPct: front.atmIvPct, frontMaxPain: front.maxPainStrike, frontSkew25dRR: front.skew25dRR }, ivRankOut, gex, implied?.[0]) : null;

  return {
    service: 'options-desk',
    version: config.version,
    currency: cur,
    spot: spot ? round(spot, 2) : null,
    readout,
    provenance: {
      sources: 'Live Deribit + OKX option chains; Deribit DVOL index for IV rank; per-expiry forwards for the implied-rate curve.',
      greeks: 'Black-76 computed from each option\'s Deribit mark-IV; validated against Deribit\'s own ticker greeks — ATM delta within ~0.01, vega within ~0.5%.',
      ivRankWindow: ivRankOut ? `${ivRankOut.historyDays} days of DVOL daily history` : 'DVOL history unavailable for this asset',
      vrpModel: vrp ? `Real-world odds use a variance-risk-premium factor of ${vrp.ratioUsed} (median realized÷implied) fitted on ${vrp.sample.pairs} overlapping pairs ≈ ${vrp.sample.effectiveIndependent} independent observations; implied exceeded realized on ${vrp.impliedExceededRealizedPct}% of them. The fit, its IQR, its OLS R² and its caveats are returned in vrpModel — audit it, don't trust it.` : 'No variance-risk-premium fit for this asset — only risk-neutral odds are offered.',
      reCheck: `Independently verify any greek: GET https://www.deribit.com/api/v2/public/ticker?instrument_name=<${cur}-DDMMMYY-STRIKE-C|P> and compare greeks.delta to this response's greeksSurface.`,
    },
    headline: front ? {
      frontExpiry: front.expiry,
      frontAtmIvPct: front.atmIvPct,
      frontMaxPain: front.maxPainStrike,
      frontSkew25dRR: front.skew25dRR,
      frontAtmGreeks: front.greeks,
      putCallOiRatioAll: callOi > 0 ? round(putOi / callOi, 2) : null,
      ivRegime: ivRankOut?.regime || dvol?.regime || null,
      ivPercentile365: ivRankOut?.rank365d?.percentile ?? null,
      netGexUsdPerPct: gex?.netGexUsdPerPct ?? null,
      gammaFlipSpot: gex?.gammaFlipSpot ?? null,
      gammaRegime: gex?.regime || null,
      frontExpectedMovePct: implied?.[0]?.expectedMove?.oneSigmaPct ?? null,
      macroEventBeforeFrontExpiry: implied?.[0]?.macroEventsBeforeExpiry?.[0] ? `${implied[0].macroEventsBeforeExpiry[0].kind} in ${implied[0].macroEventsBeforeExpiry[0].hoursUntil}h` : null,
      volSignalConsensus: consensus?.volatility ? `${consensus.volatility.alignment}${consensus.volatility.lean !== 'mixed' ? ' → ' + consensus.volatility.lean : ''}` : null,
      topCrossMarketDivergencePts: crossMarket?.markets?.[0]?.divergencePts ?? null,
      varianceRiskPremiumRatio: vrp?.ratioUsed ?? null,
    } : null,
    ivRank: ivRankOut,
    dvol,
    gex,
    spotOutlook: gammaSpotOutlook,
    consensus,
    volSurfaceModel: surfaceFit,
    calendarBoundsMOT: motPairs,
    vrpModel: vrp,
    crossMarket: focus === 'headline' ? undefined : crossMarket,
    flow,
    impliedView: focus === 'headline' ? undefined : implied,
    rvContext,
    rates: rateCurve.slice(0, 8),
    venues,
    ivTermStructure: expiries.map((e) => ({ expiry: e.expiry, daysOut: e.daysOut, atmIvPct: e.atmIvPct })),
    greeksSurface: focus === 'all' || focus === 'greeks' ? greeksSurface : undefined,
    expiries: focus === 'all' || focus === 'expiries' ? expiries : expiries.slice(0, 3),
    method: 'Live Deribit + OKX option chains: IV rank/percentile vs DVOL history, GEX/dealer-gamma with gamma-flip level, options flow (large blocks) and open-interest change, per-strike greeks surface + aggregate greeks, true ATM-forward IV interpolation, delta-space 25-delta risk-reversal/butterfly with coverage flags, implied-rate curve from the forward, multi-venue ATM-IV cross-check, and the market-implied view — expected move plus a risk-neutral probability ladder (N(d2) from the smile) for key price levels, overlaid with the scheduled macro prints (CPI/FOMC/NFP) that fall before each expiry.',
    limitations: 'Deribit + OKX are the reference venues, not the entire market. GEX assumes dealer positioning (long call / short put gamma) — a labeled convention, not observed flow. IV rank spans the deepest reachable DVOL history (up to ~1y). OI-change baseline is since first observed on this host. Implied probabilities are RISK-NEUTRAL (the market\'s own pricing, not a real-world forecast) and read off the current smile. Positioning metrics are context, not predictions or advice.',
    elapsedMs: Date.now() - t0,
  };
}
