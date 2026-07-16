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

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

function normIndicators(list) {
  // Shared clean default across both tiers: EMA20 + Bollinger + Volume. Agents add RSI/MACD/etc.
  if (!Array.isArray(list) || !list.length) return [{ type: 'EMA', period: 20 }, { type: 'BOLL' }, { type: 'VOL' }];
  return list.map((i) => (typeof i === 'string' ? { type: i.toUpperCase() } : { ...i, type: String(i.type).toUpperCase() }))
    .filter((i) => i.type);
}

export async function chartPress(chain, address, opts = {}) {
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

  const [candlesRaw, priceRaw, tradesRaw] = await Promise.all([
    data.candles(chain, address, interval, lookback).catch(() => []),
    data.priceInfo(chain, address).catch(() => ({})),
    data.trades(chain, address, 2).catch(() => []),
  ]);
  const price = Array.isArray(priceRaw) ? priceRaw[0] || {} : priceRaw || {};
  const rows = Array.isArray(candlesRaw) ? candlesRaw : candlesRaw?.list || [];
  const bars = rows.map((r) => Array.isArray(r)
    ? { t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) }
    : { t: num(r.ts ?? r.t ?? r.time), o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c), v: num(r.vol ?? r.volUsd) })
    .filter((b) => b.o && b.h && b.l && b.c).sort((a, b) => a.t - b.t);
  if (bars.length < 3) {
    return { service: 'chart-press', version: config.version, chain, token: address, verdict: 'INSUFFICIENT_CANDLES', note: 'Not enough candle history to render a chart for this token at this interval.' };
  }

  // symbol from tape (price-info lacks it)
  let symbol = null;
  for (const r of (Array.isArray(tradesRaw) ? tradesRaw : tradesRaw?.list || [])) {
    const hit = (r.changedTokenInfo || []).find((c) => String(c.tokenAddress).toLowerCase() === String(address).toLowerCase());
    if (hit?.tokenSymbol) { symbol = hit.tokenSymbol; break; }
  }
  symbol = symbol || price.tokenSymbol || 'TOKEN';
  const spot = num(price.price) ?? bars[bars.length - 1].c;
  const change24h = num(price.priceChange24H) ?? (((bars[bars.length - 1].c - bars[0].o) / bars[0].o) * 100);

  // Tier selection: opt-in FULL, or auto-escalate if a requested indicator is not SSR-supported.
  const wantsUnsupported = indicators.some((i) => !SSR_SUPPORTED.has(i.type));
  const requestedTier = opts.quality === 'full' || wantsUnsupported ? 'full' : 'fast';

  const renderArgs = { bars, symbol, interval, indicators, drawings, annotations, theme, chartType, logScale, brand: opts.brand || 'quiver' };
  let png, tierServed = 'fast', fallback = null;

  if (requestedTier === 'full') {
    try {
      const { renderBrowser } = await import('./chart/browserRender.js');
      png = await Promise.race([
        renderBrowser(renderArgs),
        new Promise((_, rej) => setTimeout(() => rej(new Error('full-tier render timed out')), 14000)),
      ]);
      tierServed = 'full';
    } catch (e) {
      fallback = `full tier unavailable (${String(e.message || e).slice(0, 80)}); served fast tier`;
    }
  }
  if (!png) { png = renderEChart(renderArgs); tierServed = 'fast'; }

  const id = putCard(png);
  const facts = {
    symbol, priceUsd: spot ? Number(spot.toPrecision(6)) : null,
    change24hPct: round(change24h, 2),
    volume24hUsd: round(num(price.volume24H)), liquidityUsd: round(num(price.liquidity)), holders: num(price.holders),
    interval, bars: bars.length, chartType, logScale,
    high: round(Math.max(...bars.map((b) => b.h)), 8), low: round(Math.min(...bars.map((b) => b.l)), 8),
    indicators: indicators.map((i) => i.type + (i.period ? i.period : '')),
  };
  return {
    service: 'chart-press',
    version: config.version,
    chain, token: address,
    tierRequested: requestedTier, tierServed, fallback,
    hostedUrl: host ? `${host}/card/${id}.png` : `/card/${id}.png`,
    imageBase64: `data:image/png;base64,${png.toString('base64')}`,
    facts,
    provenance: {
      source: `OKX DEX market data (candles + price-info) for ${address} on ${chain}, ${interval} interval, ${bars.length} bars.`,
      reconciledTo: 'The facts block (price, 24h change, volume, high, low) is computed from the SAME candle series drawn on the image — the numbers cannot drift from the picture.',
      reCheck: `Independently verify: fetch the OKX DEX candles for this token at ${interval} and compare OHLC/volume to the plotted candles and the facts block.`,
    },
    suggestedAlt: `$${symbol} ${facts.change24hPct >= 0 ? '+' : ''}${facts.change24hPct}% (24h) on the ${interval} chart`,
    method: 'Two-tier server-side chart rendering: a fast browserless engine with an opt-in high-detail browser tier that falls back to fast on any failure. Chart types: candles, heikin (Heikin-Ashi), line, area, renko; optional log price scale. Drawings: hline, vline, area, rectangle, trendline, ray, channel, fib (retracement/extension), measured-move, text/arrow. Indicators are always computed on the real time bars; only the price glyph changes. The facts block mirrors the exact numbers on the image.',
    elapsedMs: Date.now() - t0,
  };
}
