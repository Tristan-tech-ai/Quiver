// ChartPress — agent-controlled two-tier chart rendering.
//  FAST (default): Apache ECharts server-side SVG -> PNG (no browser). Candles + MA/EMA/BOLL/RSI/VOL
//    + hlines/areas/trendlines/annotations. Low latency.
//  FULL (opt-in, quality:"full"): klinecharts via headless Chromium -> screenshot. Richer; higher cost.
//    Hard timeout + automatic FALLBACK to FAST so a browser failure never errors.
// Both tiers return a facts block whose numbers mirror the image (anti-hallucination).
import * as data from '../adapters/data.js';
import { config } from '../config.js';
import { putCard } from '../util/cardstore.js';
import { round } from './stats.js';
import { renderEChart } from './chart/echartsRender.js';
import { SSR_SUPPORTED } from './chart/indicators.js';
import * as cexMarket from '../adapters/okx-market.js';

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

function normIndicators(list) {
  // Shared clean default across both tiers: EMA20 + Bollinger + Volume. Agents add RSI/MACD/etc.
  if (!Array.isArray(list) || !list.length) return [{ type: 'EMA', period: 20 }, { type: 'BOLL' }, { type: 'VOL' }];
  return list.map((i) => (typeof i === 'string' ? { type: i.toUpperCase() } : { ...i, type: String(i.type).toUpperCase() }))
    .filter((i) => i.type);
}

export async function chartPress(chain, address, opts = {}, deps = data) {
  const t0 = Date.now();
  const interval = opts.interval || opts.bar || '1H';
  const lookback = Math.min(Math.max(Number(opts.lookback) || 72, 10), 300);
  const indicators = normIndicators(opts.indicators);
  const drawings = Array.isArray(opts.drawings) ? opts.drawings : [];
  const annotations = Array.isArray(opts.annotations) ? opts.annotations : (opts.caption ? [] : []);
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const CHART_TYPES = new Set(['candles', 'heikin', 'heikinashi', 'ha', 'line', 'area', 'renko']);
  const chartType = CHART_TYPES.has(String(opts.chartType || '').toLowerCase()) ? String(opts.chartType).toLowerCase() : 'candles';
  const logScale = opts.logScale === true || opts.logScale === 'true' || opts.logScale === 1 || opts.logScale === '1';
  const host = opts.host || '';
  // Output shaping (competitor-parity params): svg is fast-tier only (the full tier is a browser
  // screenshot); width/height/scale clamped; timezone validated here so facts can echo what was APPLIED.
  const format = String(opts.format || 'png').toLowerCase() === 'svg' ? 'svg' : 'png';
  const width = Math.min(Math.max(Number(opts.width) || 1200, 600), 2400);
  const height = Math.min(Math.max(Number(opts.height) || 675, 400), 1600);
  const scale = Math.min(Math.max(Number(opts.scale) || 1, 1), 3);
  let timezone = null;
  if (opts.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: String(opts.timezone) }); timezone = String(opts.timezone); } catch { timezone = null; } }

  // Source routing: a CEX symbol (BTC-USDT) goes to OKX public candles; a chain+address DEX token goes to
  // the DEX market feed. Detected up front so facts/provenance echo the source actually used.
  const cexSym = opts.symbol && cexMarket.looksLikeCexSymbol(opts.symbol) ? opts.symbol
    : (!address && cexMarket.looksLikeCexSymbol(chain) ? chain : null);
  const isCex = !!cexSym;

  let candlesFetchOk = true, bars, price = {}, cexInstId = null, tradesRawRef = null;
  if (isCex) {
    let cex = null;
    try { cex = await cexMarket.cexCandles(cexSym, interval, lookback); } catch { candlesFetchOk = false; }
    bars = cex ? cex.bars : [];
    cexInstId = cex ? cex.instId : cexMarket.normInstId(cexSym);
  } else {
    const [candlesRaw, priceRaw, tradesRaw] = await Promise.all([
      deps.candles(chain, address, interval, lookback).catch(() => { candlesFetchOk = false; return []; }),
      deps.priceInfo(chain, address).catch(() => ({})),
      deps.trades(chain, address, 2).catch(() => []),
    ]);
    price = Array.isArray(priceRaw) ? priceRaw[0] || {} : priceRaw || {};
    const rows = Array.isArray(candlesRaw) ? candlesRaw : candlesRaw?.list || [];
    bars = rows.map((r) => Array.isArray(r)
      ? { t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) }
      : { t: num(r.ts ?? r.t ?? r.time), o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c), v: num(r.vol ?? r.volUsd) })
      .filter((b) => b.o && b.h && b.l && b.c).sort((a, b) => a.t - b.t);
    tradesRawRef = tradesRaw;
  }
  if (bars.length < 3) {
    const tokenId = isCex ? cexInstId : address;
    return candlesFetchOk
      ? { service: 'chart-press', version: config.version, chain: isCex ? 'cex' : chain, token: tokenId, verdict: 'INSUFFICIENT_CANDLES', note: `The candle fetch SUCCEEDED but returned fewer than 3 usable bars — ${isCex ? 'this symbol has no candles at this interval (check the instId, e.g. BTC-USDT).' : 'this token genuinely lacks history at this interval.'}` }
      : { service: 'chart-press', version: config.version, chain: isCex ? 'cex' : chain, token: tokenId, verdict: 'DATA_UNAVAILABLE', note: 'The candle fetch FAILED — an upstream/data outage, NOT evidence that the market lacks history. Retry.' };
  }

  // symbol: for CEX use the instId's base; for DEX resolve from the trade tape (price-info lacks it)
  let symbol = null;
  if (isCex) {
    symbol = cexInstId.split('-')[0];
  } else {
    for (const r of (Array.isArray(tradesRawRef) ? tradesRawRef : tradesRawRef?.list || [])) {
      const hit = (r.changedTokenInfo || []).find((c) => String(c.tokenAddress).toLowerCase() === String(address).toLowerCase());
      if (hit?.tokenSymbol) { symbol = hit.tokenSymbol; break; }
    }
    symbol = symbol || price.tokenSymbol || 'TOKEN';
  }
  // The token price feed and the candle series are two different measurements of the same market, and
  // they disagree by a few basis points because the feed is a live quote while the last candle is a
  // closed bar. Prefer the feed (it is fresher), fall back to the last drawn close, and RECORD WHICH —
  // the provenance used to claim every fact came from the drawn series, which was false for exactly
  // these two fields, so a reader comparing priceUsd against the price label on the image found a
  // mismatch the response denied was possible.
  const spotFeed = num(price.price);
  const spot = spotFeed ?? bars[bars.length - 1].c;
  const priceSource = spotFeed != null ? 'token-price-feed (live quote)' : 'last drawn candle close';
  const change24hFeed = num(price.priceChange24H);
  const change24h = change24hFeed ?? (((bars[bars.length - 1].c - bars[0].o) / bars[0].o) * 100);
  const change24hSource = change24hFeed != null ? 'token-price-feed (live quote)' : 'first-to-last drawn candle';

  // Tier selection: opt-in FULL, or auto-escalate if a requested indicator is not SSR-supported.
  // SVG output forces the fast tier (the browser tier is a raster screenshot by construction).
  const wantsUnsupported = indicators.some((i) => !SSR_SUPPORTED.has(i.type));
  const requestedTier = format === 'svg' ? 'fast' : (opts.quality === 'full' || wantsUnsupported ? 'full' : 'fast');

  const renderArgs = { bars, symbol, interval, indicators, drawings, annotations, theme, chartType, logScale, brand: opts.brand || 'quiver', width, height, scale, timezone, format };
  let out, tierServed = 'fast', fallback = null;

  if (requestedTier === 'full') {
    try {
      const { renderBrowser } = await import('./chart/browserRender.js');
      out = await Promise.race([
        renderBrowser(renderArgs),
        new Promise((_, rej) => setTimeout(() => rej(new Error('full-tier render timed out')), 14000)),
      ]);
      tierServed = 'full';
    } catch (e) {
      fallback = `full tier unavailable (${String(e.message || e).slice(0, 80)}); served fast tier`;
    }
  }
  if (!out) { out = renderEChart(renderArgs); tierServed = 'fast'; }

  const isSvg = typeof out === 'string';
  const id = putCard(isSvg ? Buffer.from(out, 'utf8') : out, isSvg ? 'image/svg+xml' : 'image/png');
  const facts = {
    symbol, priceUsd: spot ? Number(spot.toPrecision(6)) : null,
    priceSource, change24hSource,
    lastDrawnCandleClose: round(bars[bars.length - 1].c, 8),
    change24hPct: round(change24h, 2),
    volume24hUsd: round(num(price.volume24H)), liquidityUsd: round(num(price.liquidity)), holders: num(price.holders),
    interval, bars: bars.length, chartType, logScale,
    format: isSvg ? 'svg' : 'png', width, height, scale: isSvg ? 1 : scale,
    timezone: timezone || 'UTC', timezoneRequested: opts.timezone || null,
    high: round(Math.max(...bars.map((b) => b.h)), 8), low: round(Math.min(...bars.map((b) => b.l)), 8),
    indicators: indicators.map((i) => i.type + (i.period ? i.period : '')),
  };
  const ext = isSvg ? 'svg' : 'png';
  return {
    service: 'chart-press',
    version: config.version,
    chain: isCex ? 'cex' : chain, token: isCex ? cexInstId : address, source: isCex ? 'okx-cex' : 'okx-dex',
    ...(isCex ? { instId: cexInstId } : {}),
    tierRequested: requestedTier, tierServed, fallback,
    hostedUrl: host ? `${host}/card/${id}.${ext}` : `/card/${id}.${ext}`,
    ...(isSvg
      ? { imageSvg: out }
      : { imageBase64: `data:image/png;base64,${out.toString('base64')}` }),
    facts,
    provenance: isCex
      ? {
          source: `OKX public CEX candles for ${cexInstId}, ${interval} interval (bar ${cexMarket.mapBar(interval)}), ${bars.length} bars.`,
          reconciledTo: 'The facts block (price, 24h change, high, low) is computed from the SAME candle series drawn on the image — the numbers cannot drift from the picture. On this CEX path there is no separate price feed, so facts.priceUsd IS the last drawn candle close; facts.priceSource states that explicitly.',
          reCheck: `Independently verify: GET https://www.okx.com/api/v5/market/candles?instId=${cexInstId}&bar=${cexMarket.mapBar(interval)} and compare OHLC to the plotted candles and the facts block.`,
        }
      : {
          source: `OKX DEX market data (candles + price-info) for ${address} on ${chain}, ${interval} interval, ${bars.length} bars.`,
          reconciledTo: `facts.high and facts.low are computed from the SAME candle series drawn on the image, so they cannot drift from the picture. facts.priceUsd and facts.change24hPct come from ${priceSource === 'token-price-feed (live quote)' ? 'the token price feed, NOT from the drawn candles' : 'the drawn candles (the price feed did not answer)'} — facts.priceSource and facts.change24hSource say which on every response, and facts.lastDrawnCandleClose gives the number the image labels, so the two can be compared instead of assumed equal. A few basis points between a live quote and a closed bar is the feed being fresher than the last candle, not a disagreement.`,
          reCheck: `Independently verify: fetch the OKX DEX candles for this token at ${interval} and compare OHLC/volume to the plotted candles and the facts block.`,
        },
    suggestedAlt: `$${symbol} ${facts.change24hPct >= 0 ? '+' : ''}${facts.change24hPct}% (24h) on the ${interval} chart`,
    method: 'Two-tier server-side chart rendering: a fast browserless engine with an opt-in high-detail browser tier that falls back to fast on any failure. Chart types: candles, heikin (Heikin-Ashi), line, area, renko; optional log price scale. Drawings: hline, vline, area, rectangle, trendline, ray, channel, fib (retracement/extension), measured-move, text/arrow, longshort (entry/stop/target R:R position box), orderline (side-labeled order level). Indicators include Ichimoku (hand-rolled, explicitly aligned: spans displaced +26, chikou −26; forward cloud beyond the last bar is not drawn). Output: png (width/height/scale up to 3x) or svg (fast tier only); axis labels in any IANA timezone (invalid tz falls back to UTC, disclosed in facts.timezone). Indicators are always computed on the real time bars; only the price glyph changes. facts.high/low are computed from the drawn series; facts.priceUsd and facts.change24hPct may instead come from the live token price feed, and facts.priceSource / facts.change24hSource / facts.lastDrawnCandleClose let a reader tell which and compare.',
    elapsedMs: Date.now() - t0,
  };
}
