// FAST tier — Apache ECharts server-side (SSR SVG, no browser) -> PNG via resvg.
// Candles + MA/EMA/BOLL overlays + volume panel + RSI panel + hlines/areas/trendlines/annotations.
import * as echarts from 'echarts';
import { Resvg } from '@resvg/resvg-js';
import { sma, ema, wma, boll, rsi, atr, roc, obv, vwap, cci, mfi, williamsR, trix, psar, stochastic, adx, stochRsi, keltner, OVERLAYS, PANELS } from './indicators.js';

// One overlay series spec (on the price pane) from an indicator request.
function overlaySeries(ind, bars, closes, highs, lows, vols, col, mk) {
  const t = ind.type, p = ind.period;
  const line = (data, name, style = {}) => ({ type: 'line', xAxisIndex: 0, yAxisIndex: 0, data, smooth: true, symbol: 'none', lineStyle: { width: 1.6, color: col, ...style }, name });
  if (t === 'MA' || t === 'SMA') return [line(sma(closes, p || 20), `MA${p || 20}`)];
  if (t === 'EMA') return [line(ema(closes, p || 20), `EMA${p || 20}`)];
  if (t === 'WMA') return [line(wma(closes, p || 20), `WMA${p || 20}`)];
  if (t === 'VWAP') return [line(vwap(highs, lows, closes, vols), 'VWAP', { type: 'dashed' })];
  if (t === 'BOLL') { const b = boll(closes, p || 20, ind.mult || 2); return [line(b.upper, 'BOLL up', { width: 1, opacity: 0.7 }), line(b.mid, 'BOLL mid', { width: 1, type: 'dashed' }), line(b.lower, 'BOLL low', { width: 1, opacity: 0.7 })]; }
  if (t === 'KELTNER') { const k = keltner(highs, lows, closes, p || 20, ind.atrPeriod || 10, ind.mult || 2); return [line(k.upper, 'KC up', { width: 1, opacity: 0.7 }), line(k.mid, 'KC mid', { width: 1, type: 'dashed' }), line(k.lower, 'KC low', { width: 1, opacity: 0.7 })]; }
  if (t === 'PSAR') return [{ type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: psar(highs, lows, ind.step, ind.max).map((v, i) => v == null ? null : [i, v]).filter(Boolean), symbolSize: 2.4, itemStyle: { color: '#e5c07b' } }];
  return [];
}

// Series for one sub-panel oscillator on its own axis index. Returns { series[], label, bands, range }.
function panelSeries(ind, gi, bars, closes, highs, lows, vols, col) {
  const t = ind.type, p = ind.period, meta = PANELS[t] || {};
  const L = (data, color, style = {}) => ({ type: 'line', xAxisIndex: gi, yAxisIndex: gi, data, symbol: 'none', lineStyle: { color, width: 1.6, ...style } });
  const bands = (meta.bands || []).map((y) => ({ yAxis: y }));
  const ml = bands.length ? { markLine: { symbol: 'none', silent: true, lineStyle: { color: '#3a4a63' }, data: bands } } : {};
  let series = [], label = t;
  if (t === 'RSI') { series = [{ ...L(rsi(closes, p || 14), '#c678dd'), ...ml }]; label = `RSI ${p || 14}`; }
  else if (t === 'ROC') { series = [{ ...L(roc(closes, p || 12), '#56b6c2'), ...ml }]; label = `ROC ${p || 12}`; }
  else if (t === 'TRIX') { series = [{ ...L(trix(closes, p || 15), '#e5c07b'), ...ml }]; label = `TRIX ${p || 15}`; }
  else if (t === 'ATR') { series = [L(atr(highs, lows, closes, p || 14), '#f0b90b')]; label = `ATR ${p || 14}`; }
  else if (t === 'OBV') { series = [L(obv(closes, vols), '#5b8def')]; label = 'OBV'; }
  else if (t === 'CCI') { series = [{ ...L(cci(highs, lows, closes, p || 20), '#c678dd'), ...ml }]; label = `CCI ${p || 20}`; }
  else if (t === 'MFI') { series = [{ ...L(mfi(highs, lows, closes, vols, p || 14), '#56b6c2'), ...ml }]; label = `MFI ${p || 14}`; }
  else if (t === 'WILLIAMSR') { series = [{ ...L(williamsR(highs, lows, closes, p || 14), '#e06c75'), ...ml }]; label = `%R ${p || 14}`; }
  else if (t === 'STOCH') { const s = stochastic(highs, lows, closes, p || 14, ind.signalPeriod || 3); series = [{ ...L(s.k, '#5b8def'), ...ml }, L(s.d, '#e5c07b', { width: 1 })]; label = `Stoch ${p || 14}`; }
  else if (t === 'STOCHRSI') { const s = stochRsi(closes, p || 14); series = [{ ...L(s.k, '#5b8def'), ...ml }, L(s.d, '#e5c07b', { width: 1 })]; label = 'StochRSI'; }
  else if (t === 'ADX') { const a = adx(highs, lows, closes, p || 14); series = [{ ...L(a.adx, '#f4f7fb'), ...ml }, L(a.pdi, '#34D399', { width: 1 }), L(a.mdi, '#F87171', { width: 1 })]; label = `ADX ${p || 14}`; }
  return { series, label, range: meta.range };
}

const THEMES = {
  dark: { bg: '#0e1626', bg2: '#080d18', grid: '#1f2a3a', text: '#8aa0bd', title: '#f4f7fb', up: '#34D399', down: '#F87171', line: ['#f0b90b', '#5b8def', '#c678dd', '#56b6c2'] },
  light: { bg: '#ffffff', bg2: '#f4f6fa', grid: '#e6ebf2', text: '#5b6b82', title: '#0b1220', up: '#16a34a', down: '#dc2626', line: ['#b45309', '#2563eb', '#7c3aed', '#0891b2'] },
};

// Heikin-Ashi transform (D14): smooths noise; HAclose=(o+h+l+c)/4, HAopen=(prevHAopen+prevHAclose)/2.
function heikinAshi(bars) {
  const out = []; let po = null, pc = null;
  for (const b of bars) {
    const hc = (b.o + b.h + b.l + b.c) / 4;
    const ho = po == null ? (b.o + b.c) / 2 : (po + pc) / 2;
    out.push({ t: b.t, o: ho, h: Math.max(b.h, ho, hc), l: Math.min(b.l, ho, hc), c: hc, v: b.v });
    po = ho; pc = hc;
  }
  return out;
}

// Renko bricks (D14): price-driven, time-independent. Box size = param, else ~ATR(14)-ish (0.5·median|Δclose|·k).
// Each brick is a synthetic up/down candle; returns { bricks, brickSize }.
function buildRenko(bars, brickSize) {
  const closes = bars.map((b) => b.c);
  let box = brickSize > 0 ? brickSize : null;
  if (!box) {
    const diffs = []; for (let i = 1; i < closes.length; i++) diffs.push(Math.abs(closes[i] - closes[i - 1]));
    diffs.sort((a, b) => a - b);
    box = (diffs[Math.floor(diffs.length / 2)] || closes[closes.length - 1] * 0.01) * 2; // ~2× median move
  }
  if (!(box > 0)) return { bricks: [], brickSize: 0 };
  const bricks = []; let base = Math.round(closes[0] / box) * box;
  for (let i = 1; i < closes.length; i++) {
    let diff = closes[i] - base;
    while (Math.abs(diff) >= box) {
      const up = diff > 0; const nb = base + (up ? box : -box);
      bricks.push({ t: bars[i].t, o: base, c: nb, h: Math.max(base, nb), l: Math.min(base, nb), v: 0, up });
      base = nb; diff = closes[i] - base;
    }
  }
  return { bricks, brickSize: box };
}

// Fibonacci retracement/extension levels between two price points (D13).
const FIB_RETRACE = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXTEND = [0, 0.618, 1, 1.272, 1.618, 2.618];

const fmtPrice = (n) => (n == null ? '' : n >= 1 ? n.toFixed(2) : n >= 0.0001 ? n.toPrecision(4) : n.toExponential(1));
const fmtCompact = (n) => { if (n == null) return ''; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return String(Math.round(n)); };

export function renderEChart({ bars, symbol, interval, indicators = [], drawings = [], annotations = [], theme = 'dark', width = 1200, height = 675, brand = 'quiver', chartType = 'candles', logScale = false }) {
  const th = THEMES[theme] || THEMES.dark;
  const type = String(chartType || 'candles').toLowerCase();
  // Price representation (D14). Indicators are ALWAYS computed on the real time bars; only the glyph changes.
  let dbars = bars, renkoInfo = null;
  if (type === 'heikin' || type === 'heikinashi' || type === 'ha') dbars = heikinAshi(bars);
  else if (type === 'renko') { renkoInfo = buildRenko(bars, 0); if (renkoInfo.bricks.length >= 2) dbars = renkoInfo.bricks; }
  const priceOnly = type === 'renko';               // point/price-based view drops time-aligned sub-panels
  const isLine = type === 'line' || type === 'area';
  const closes = bars.map((b) => b.c);
  const fmtCat = (t) => { const d = new Date(t); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:00`; };
  const cat = priceOnly ? dbars.map((_, i) => String(i + 1)) : dbars.map((b) => fmtCat(b.t));
  const kdata = dbars.map((b) => [b.o, b.c, b.l, b.h]);

  const highs = bars.map((b) => b.h), lows = bars.map((b) => b.l), vols = bars.map((b) => b.v || 0);
  // Classify each requested indicator: overlay (on price) vs sub-panel oscillator. VOL is its own panel.
  // Renko is price-indexed (not time-indexed), so time-aligned indicators are suppressed for it.
  const overlays = priceOnly ? [] : indicators.filter((i) => OVERLAYS.has(i.type));
  const oscillators = priceOnly ? [] : indicators.filter((i) => PANELS[i.type] && i.type !== 'VOL');
  const wantVol = !priceOnly && (indicators.some((i) => i.type === 'VOL') || indicators.length === 0);

  // Precompute each sub-panel's series so we know its axis index up front. Cap sub-panels so the price
  // pane stays readable (extra oscillators beyond the cap are dropped, disclosed in the facts block).
  const MAX_PANELS = 3;
  const panelDefs = [];
  if (wantVol) panelDefs.push({ id: 'VOL', label: 'VOL', kind: 'vol' });
  for (const ind of oscillators.slice(0, MAX_PANELS - (wantVol ? 1 : 0))) panelDefs.push({ id: ind.type, ind, kind: 'osc' });
  const droppedPanels = oscillators.length - panelDefs.filter((p) => p.kind === 'osc').length;

  // dynamic grid layout: price pane + N sub-panels
  const panels = [{ id: 'price' }, ...panelDefs];
  const topPad = 64, botPad = 34, gap = 22;
  const subFrac = panelDefs.length ? Math.min(0.18, 0.5 / panelDefs.length) : 0;
  const priceH = 1 - subFrac * panelDefs.length;
  let acc = topPad;
  const grids = [], xAxes = [], yAxes = [], panelLabels = [];
  const totalH = height - topPad - botPad - gap * (panels.length - 1);
  const colOf = (t) => th.line[[...OVERLAYS].indexOf(t) % th.line.length] || th.line[0];
  panels.forEach((p, i) => {
    const isPrice = p.id === 'price';
    const h = (isPrice ? priceH : subFrac) * totalH;
    grids.push({ left: 60, right: 62, top: acc, height: h });
    xAxes.push({ type: 'category', gridIndex: i, data: cat, boundaryGap: true, axisLine: { lineStyle: { color: th.grid } }, axisLabel: { show: i === panels.length - 1, color: th.text, fontSize: 12 }, axisTick: { show: false }, splitLine: { show: false } });
    const range = p.ind ? (PANELS[p.ind.type] || {}).range : null;
    yAxes.push({ type: isPrice && logScale ? 'log' : 'value', scale: !range, gridIndex: i, position: 'right', splitNumber: isPrice ? 5 : 2, min: range ? range[0] : null, max: range ? range[1] : null, axisLine: { show: false }, axisLabel: { color: th.text, fontSize: 12, formatter: p.kind === 'vol' ? (v) => fmtCompact(v) : isPrice ? (v) => fmtPrice(v) : '{value}' }, splitLine: { lineStyle: { color: th.grid } } });
    if (!isPrice) panelLabels.push({ type: 'text', left: 66, top: acc + 4, style: { text: p.label || p.id, fill: th.text, font: 'bold 13px sans-serif' } });
    acc += h + gap;
  });

  const series = [];
  // Price glyph (candles / heikin / renko share the candlestick series; line/area use a line). Drawings and
  // annotations (D13) attach to whichever price series is drawn.
  const markLine = { symbol: 'none', label: { color: th.title, fontSize: 13, position: 'insideEndTop' }, lineStyle: { width: 1.4 }, data: [] };
  const markArea = { itemStyle: { color: 'rgba(90,141,239,0.10)' }, label: { color: th.text, fontSize: 12 }, data: [] };
  const extraPoints = [];
  const cx = (i) => (i != null && cat[i] != null) ? cat[i] : cat[cat.length - 1];
  for (const d of drawings) {
    const dt = String(d.type || '').toLowerCase(), col = d.color;
    if (dt === 'hline' && d.price != null) markLine.data.push({ yAxis: d.price, name: d.label || '', lineStyle: { color: col || '#e5c07b', type: 'dashed' }, label: { position: 'end', distance: 2, formatter: d.label ? `${d.label} ${fmtPrice(d.price)}` : fmtPrice(d.price), color: '#0b1220', backgroundColor: col || '#e5c07b', padding: [3, 5], borderRadius: 3, fontSize: 12, fontWeight: 600 } });
    else if (dt === 'vline' && d.index != null) markLine.data.push({ xAxis: cx(d.index), lineStyle: { color: col || '#8aa0bd', type: 'dashed' }, label: { formatter: d.label || '', color: th.text } });
    else if (dt === 'area' && d.fromPrice != null && d.toPrice != null) markArea.data.push([{ yAxis: d.fromPrice, name: d.label || '', itemStyle: col ? { color: col } : undefined }, { yAxis: d.toPrice }]);
    else if ((dt === 'rect' || dt === 'rectangle') && d.p1 && d.p2) markArea.data.push([{ xAxis: cx(d.p1.index), yAxis: d.p1.price, name: d.label || '', itemStyle: col ? { color: col } : undefined }, { xAxis: cx(d.p2.index), yAxis: d.p2.price }]);
    else if (dt === 'trendline' && d.p1 && d.p2) markLine.data.push([{ coord: [cx(d.p1.index), d.p1.price], lineStyle: { color: col || '#5b8def' } }, { coord: [cx(d.p2.index), d.p2.price] }]);
    else if (dt === 'ray' && d.p1 && d.p2 && d.p1.index != null && d.p2.index != null) {
      const di = (d.p2.index - d.p1.index) || 1, slope = (d.p2.price - d.p1.price) / di, iEnd = cat.length - 1;
      markLine.data.push([{ coord: [cx(d.p1.index), d.p1.price], lineStyle: { color: col || '#5b8def' } }, { coord: [cx(iEnd), d.p2.price + slope * (iEnd - d.p2.index)] }]);
    } else if (dt === 'channel' && d.p1 && d.p2 && d.width != null) {
      markLine.data.push([{ coord: [cx(d.p1.index), d.p1.price], lineStyle: { color: col || '#c678dd' } }, { coord: [cx(d.p2.index), d.p2.price] }]);
      markLine.data.push([{ coord: [cx(d.p1.index), d.p1.price + d.width], lineStyle: { color: col || '#c678dd', type: 'dashed' } }, { coord: [cx(d.p2.index), d.p2.price + d.width] }]);
    } else if (dt === 'fib' && d.p1 && d.p2) {
      const hi = Math.max(d.p1.price, d.p2.price), lo = Math.min(d.p1.price, d.p2.price), rng = (hi - lo) || 1;
      for (const L of (d.extension ? FIB_EXTEND : FIB_RETRACE)) { const y = hi - rng * L; markLine.data.push({ yAxis: y, lineStyle: { color: col || '#e5c07b', opacity: 0.55, type: 'dotted' }, label: { position: 'start', formatter: `${(L * 100).toFixed(1)}%`, color: th.text, fontSize: 10 } }); }
    } else if ((dt === 'measure' || dt === 'measuredmove') && d.p1 && d.p2) {
      const pct = ((d.p2.price - d.p1.price) / d.p1.price) * 100;
      markLine.data.push([{ coord: [cx(d.p1.index), d.p1.price], lineStyle: { color: col || (pct >= 0 ? th.up : th.down), width: 2 } }, { coord: [cx(d.p2.index), d.p2.price], label: { formatter: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, color: th.title, fontSize: 12 } }]);
    } else if ((dt === 'text' || dt === 'arrow' || dt === 'callout') && d.price != null) {
      extraPoints.push({ coord: [cx(d.index), d.price], value: d.text || d.label || '', symbol: dt === 'arrow' ? 'arrow' : 'pin', itemStyle: { color: col || '#5b8def' } });
    }
  }
  const markPoint = { symbol: 'pin', symbolSize: 44, label: { color: '#fff', fontSize: 11 }, data: [...annotations.filter((a) => a.price != null).map((a) => ({ coord: [a.index != null ? cx(a.index) : cat[cat.length - 1], a.price], value: a.text || '', itemStyle: { color: a.color || '#5b8def' } })), ...extraPoints] };
  if (isLine) series.push({ type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: closes, smooth: true, symbol: 'none', lineStyle: { color: th.line[1], width: 2 }, areaStyle: type === 'area' ? { color: 'rgba(91,141,239,0.16)' } : undefined, markLine, markArea, markPoint });
  else series.push({ type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: kdata, itemStyle: { color: th.up, color0: th.down, borderColor: th.up, borderColor0: th.down }, markLine, markArea, markPoint });

  // price-pane overlays (moving averages, bands, PSAR, VWAP)
  let ci = 0;
  for (const ind of overlays) {
    const col = th.line[ci++ % th.line.length];
    for (const s of overlaySeries(ind, bars, closes, highs, lows, vols, col)) series.push(s);
  }

  // sub-panels (VOL bars + oscillators), each on its own grid index
  panels.forEach((p, gi) => {
    if (p.kind === 'vol') series.push({ type: 'bar', xAxisIndex: gi, yAxisIndex: gi, data: bars.map((b) => ({ value: b.v || 0, itemStyle: { color: b.c >= b.o ? th.up : th.down, opacity: 0.55 } })) });
    else if (p.kind === 'osc') for (const s of panelSeries(p.ind, gi, bars, closes, highs, lows, vols).series) series.push(s);
  });

  const option = {
    backgroundColor: th.bg,
    animation: false,
    grid: grids, xAxis: xAxes, yAxis: yAxes, series,
    title: {
      left: 24, top: 16,
      text: `$${symbol || 'TOKEN'}`,
      subtext: `${interval || ''}${type !== 'candles' ? '  ·  ' + type.toUpperCase() : ''}${logScale ? '  ·  LOG' : ''}${renkoInfo && renkoInfo.brickSize ? '  ·  brick ' + fmtPrice(renkoInfo.brickSize) : ''}${overlays.length ? '  ·  ' + overlays.map((o) => o.type + (o.period ? o.period : '')).join(' ') : ''}`,
      textStyle: { color: th.title, fontSize: 30, fontWeight: 700 }, subtextStyle: { color: th.text, fontSize: 14 },
    },
    graphic: [{ type: 'text', right: 20, bottom: 10, style: { text: brand, fill: '#3a4a63', font: '14px sans-serif' } }, ...panelLabels],
  };

  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } }).render().asPng();
  return png;
}
