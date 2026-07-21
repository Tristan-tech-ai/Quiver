// FULL tier — klinecharts rendered in headless Chromium (Playwright) -> PNG screenshot at 2x DPR.
// Feature-parity with the FAST tier: chart types (candles/heikin/renko/line/area), log scale, the
// drawing set (hline/vline/area/rect/trendline/ray/channel/fib/measure/text), and the indicator set
// mapped onto klinecharts' built-ins. Bars are FIT TO THE CANVAS (bar spacing adapts to data length),
// so a short history fills the frame instead of right-anchoring into a half-empty chart.
// Warm browser reused across calls. Any failure here is caught by the caller (chartPress), which
// falls back to the FAST tier — this never hard-errors upstream.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { heikinAshi, buildRenko } from './indicators.js';

let KLINE_UMD = null;
function klineJs() {
  if (KLINE_UMD == null) {
    const p = path.resolve('node_modules/klinecharts/dist/umd/klinecharts.min.js');
    KLINE_UMD = fs.readFileSync(p, 'utf8');
  }
  return KLINE_UMD;
}

// On Windows dev, use the local Chrome (no Playwright browser downloaded). On Linux/Railway, use
// undefined so Playwright launches its OWN downloaded chromium (a real static build, not the snap).
function localExe() {
  if (process.platform !== 'win32') return undefined;
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']) {
    try { if (fs.existsSync(c)) return c; } catch { /* */ }
  }
  return undefined;
}

let browserP = null;
async function getBrowser() {
  if (browserP) {
    try { const b = await browserP; if (b.isConnected()) return b; } catch { /* relaunch */ }
  }
  browserP = chromium.launch({
    executablePath: localExe(), headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  return browserP;
}

const HEAD = 56;
function html(W, H, header) {
  const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<!doctype html><html><head><meta charset="utf8"><style>
html,body{margin:0;background:#0e1626;font-family:Arial,Helvetica,sans-serif}
#wrap{width:${W}px;height:${H}px;position:relative;background:#0e1626}
#hd{height:${HEAD}px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;box-sizing:border-box}
#hd .l{color:#f4f7fb;font-size:27px;font-weight:700}
#hd .l span{color:#8aa0bd;font-size:15px;font-weight:400;margin-left:14px}
#hd .r{color:#3a4a63;font-size:15px}
#k{width:${W}px;height:${H - HEAD}px}
</style><script>${klineJs()}</script></head><body>
<div id="wrap"><div id="hd"><div class="l">${esc(header.title)}<span>${esc(header.sub)}</span></div><div class="r">${esc(header.brand)}</div></div><div id="k"></div></div>
<script>window.__overlayErrs=[];window.onerror=function(m,s,l,c,e){window.__overlayErrs.push('paint: '+String(e&&e.message||m));return true;};
window.__render=function(payload){try{
  // custom rectangle/band overlay (two anchor points -> filled box), used by rect + area drawings
  klinecharts.registerOverlay({
    name:'qrect', totalStep:3, needDefaultPointFigure:false, needDefaultXAxisFigure:false, needDefaultYAxisFigure:false,
    createPointFigures:function(o){var c=o.coordinates;if(c.length<2)return [];
      var col=(o.overlay.extendData&&o.overlay.extendData.color)||'#5b8def';
      return [{type:'polygon',attrs:{coordinates:[c[0],{x:c[1].x,y:c[0].y},c[1],{x:c[0].x,y:c[1].y}]},
               styles:{style:'stroke_fill',color:col+'22',borderColor:col,borderSize:1}}];}
  });
  var chart=klinecharts.init('k',{styles:payload.styles});
  chart.applyNewData(payload.data);
  (payload.indicators||[]).forEach(function(ind){
    if(ind.pane==='main'){chart.createIndicator({name:ind.name,calcParams:ind.params},true,{id:'candle_pane'});}
    else{chart.createIndicator({name:ind.name,calcParams:ind.params},false);}
  });
  (payload.overlays||[]).forEach(function(o){try{chart.createOverlay(o);}catch(e){window.__overlayErrs.push(o.name+': '+String(e&&e.message||e));}});
  // FIT TO DATA: bar spacing adapts to the bar count so the series fills the plot area
  // (klinecharts' default fixed spacing right-anchors short histories into a half-empty canvas).
  var n=payload.data.length||1;
  var plot=payload.plotWidth||(document.getElementById('k').clientWidth-96);
  var space=Math.max(3,Math.min(42,Math.floor(plot/(n+1))));
  chart.setBarSpace(space);
  chart.setOffsetRightDistance(8);
  window.__done=true;
}catch(e){window.__err=String(e&&e.message||e);window.__done=true;}};</script></body></html>`;
}

const DARK = {
  grid: { horizontal: { color: '#1f2a3a' }, vertical: { color: '#1f2a3a' } },
  candle: {
    bar: { upColor: '#34D399', downColor: '#F87171', upBorderColor: '#34D399', downBorderColor: '#F87171', upWickColor: '#34D399', downWickColor: '#F87171' },
    tooltip: { showRule: 'none' },
    priceMark: { last: { text: { color: '#0e1626' } } },
  },
  xAxis: { axisLine: { color: '#1f2a3a' }, tickText: { color: '#8aa0bd' } },
  yAxis: { axisLine: { color: '#1f2a3a' }, tickText: { color: '#8aa0bd' } },
  indicator: { tooltip: { showRule: 'none' } },
};

// Our indicator API -> klinecharts built-in { name, pane, params }. Anything unmapped is skipped
// (the caller's facts block discloses served indicators).
const KLINE_IND = {
  MA: (i) => ({ name: 'MA', pane: 'main', params: [i.period || 20] }),
  SMA: (i) => ({ name: 'MA', pane: 'main', params: [i.period || 20] }),
  EMA: (i) => ({ name: 'EMA', pane: 'main', params: [i.period || 20] }),
  BOLL: (i) => ({ name: 'BOLL', pane: 'main', params: [i.period || 20, i.mult || 2] }),
  PSAR: () => ({ name: 'SAR', pane: 'main' }),
  VOL: () => ({ name: 'VOL', pane: 'sub' }),
  RSI: (i) => ({ name: 'RSI', pane: 'sub', params: [i.period || 14] }),
  MACD: () => ({ name: 'MACD', pane: 'sub' }),
  KDJ: () => ({ name: 'KDJ', pane: 'sub' }),
  STOCH: () => ({ name: 'KDJ', pane: 'sub' }),
  WILLIAMSR: (i) => ({ name: 'WR', pane: 'sub', params: [i.period || 14] }),
  CCI: (i) => ({ name: 'CCI', pane: 'sub', params: [i.period || 20] }),
  ROC: (i) => ({ name: 'ROC', pane: 'sub', params: [i.period || 12] }),
  TRIX: (i) => ({ name: 'TRIX', pane: 'sub' }),
  OBV: () => ({ name: 'OBV', pane: 'sub' }),
  ADX: () => ({ name: 'DMI', pane: 'sub' }),
  MTM: (i) => ({ name: 'MTM', pane: 'sub' }),
};
const MAX_SUB_PANELS = 3; // price pane must stay readable

export async function renderBrowser({ bars, symbol, interval, indicators = [], drawings = [], annotations = [], theme = 'dark', width = 1200, height = 675, chartType = 'candles', logScale = false, timezone = null, scale = 2 }) {
  // Price representation: indicators/drawings anchor to the DISPLAYED bars (same rule as the fast tier).
  const type = String(chartType || 'candles').toLowerCase();
  let dbars = bars, renkoInfo = null;
  if (type === 'heikin' || type === 'heikinashi' || type === 'ha') dbars = heikinAshi(bars);
  else if (type === 'renko') { renkoInfo = buildRenko(bars, 0); if (renkoInfo.bricks.length >= 2) dbars = renkoInfo.bricks; }
  const isLine = type === 'line' || type === 'area';

  // Timezone: klinecharts formats axis labels from the raw timestamp (no tz hook in styles), so shift each
  // timestamp by the zone's UTC offset for display. Per-bar offset (DST-safe); invalid tz → no shift.
  let tzShift = (t) => t;
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }); // validate
      tzShift = (t) => {
        const d = new Date(t);
        const local = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
        const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
        return t + (local.getTime() - utc.getTime());
      };
    } catch { tzShift = (t) => t; }
  }
  if (timezone) dbars = dbars.map((b) => ({ ...b, t: tzShift(b.t) }));

  const data = dbars.map((b) => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 }));

  const inds = [];
  let subCount = 0;
  const wanted = indicators.length ? indicators : [{ type: 'EMA', period: 20 }, { type: 'BOLL' }, { type: 'VOL' }];
  for (const i of wanted) {
    const make = KLINE_IND[i.type];
    if (!make) continue;
    const spec = make(i);
    if (spec.pane === 'sub') { if (subCount >= MAX_SUB_PANELS || type === 'renko') continue; subCount += 1; }
    inds.push(spec);
  }

  const overlays = [];
  const tAt = (idx) => dbars[Math.max(0, Math.min(dbars.length - 1, idx ?? dbars.length - 1))]?.t;
  const pt = (p) => ({ timestamp: tAt(p.index), value: p.price });
  for (const d of drawings) {
    const dt = String(d.type || '').toLowerCase();
    if (dt === 'hline' && d.price != null) overlays.push({ name: 'priceLine', points: [{ value: d.price }], extendData: d.label });
    else if (dt === 'vline' && d.index != null) overlays.push({ name: 'verticalStraightLine', points: [{ timestamp: tAt(d.index), value: dbars[d.index]?.c ?? 0 }] });
    else if (dt === 'area' && d.fromPrice != null && d.toPrice != null) overlays.push({ name: 'qrect', points: [{ timestamp: dbars[0].t, value: d.fromPrice }, { timestamp: dbars[dbars.length - 1].t, value: d.toPrice }], extendData: { color: d.color || '#5b8def' } });
    else if ((dt === 'rect' || dt === 'rectangle') && d.p1 && d.p2) overlays.push({ name: 'qrect', points: [pt(d.p1), pt(d.p2)], extendData: { color: d.color || '#5b8def' } });
    else if (dt === 'trendline' && d.p1 && d.p2) overlays.push({ name: 'segment', points: [pt(d.p1), pt(d.p2)] });
    else if (dt === 'ray' && d.p1 && d.p2) overlays.push({ name: 'rayLine', points: [pt(d.p1), pt(d.p2)] });
    else if (dt === 'fib' && d.p1 && d.p2) overlays.push({ name: 'fibonacciLine', points: [pt(d.p1), pt(d.p2)] });
    else if (dt === 'channel' && d.p1 && d.p2 && d.width != null) overlays.push({ name: 'parallelStraightLine', points: [pt(d.p1), pt(d.p2), { timestamp: tAt(d.p1.index), value: d.p1.price + d.width }] });
    else if ((dt === 'measure' || dt === 'measuredmove') && d.p1 && d.p2) {
      const pct = ((d.p2.price - d.p1.price) / d.p1.price) * 100;
      overlays.push({ name: 'segment', points: [pt(d.p1), pt(d.p2)] });
      overlays.push({ name: 'simpleAnnotation', points: [pt(d.p2)], extendData: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` });
    } else if ((dt === 'text' || dt === 'arrow' || dt === 'callout') && d.price != null) {
      overlays.push({ name: 'simpleAnnotation', points: [{ timestamp: tAt(d.index), value: d.price }], extendData: d.text || d.label || '★' });
    } else if ((dt === 'longshort' || dt === 'position') && d.entry != null && d.stop != null && d.target != null) {
      const i1 = d.entryIndex != null ? d.entryIndex : Math.floor(dbars.length * 0.6);
      const i2 = d.exitIndex != null ? d.exitIndex : dbars.length - 1;
      overlays.push({ name: 'qrect', points: [{ timestamp: tAt(i1), value: d.entry }, { timestamp: tAt(i2), value: d.target }], extendData: { color: '#34D399' } });
      overlays.push({ name: 'qrect', points: [{ timestamp: tAt(i1), value: d.entry }, { timestamp: tAt(i2), value: d.stop }], extendData: { color: '#F87171' } });
      overlays.push({ name: 'priceLine', points: [{ value: d.entry }] });
      const risk = Math.abs(d.entry - d.stop), reward = Math.abs(d.target - d.entry);
      overlays.push({ name: 'simpleAnnotation', points: [{ timestamp: tAt(i1), value: d.target }], extendData: `${(d.side || 'long').toUpperCase()} R:R ${risk > 0 ? (reward / risk).toFixed(2) : '—'}` });
    } else if (dt === 'orderline' && d.price != null) {
      const buy = String(d.side || 'buy').toLowerCase() === 'buy';
      overlays.push({ name: 'priceLine', points: [{ value: d.price }] });
      overlays.push({ name: 'simpleAnnotation', points: [{ timestamp: tAt(dbars.length - 1), value: d.price }], extendData: `${buy ? 'BUY' : 'SELL'}${d.label ? ' ' + d.label : ''}` });
    }
  }
  for (const a of annotations) { const t = tAt(a.index); if (t && a.price != null) overlays.push({ name: 'simpleAnnotation', points: [{ timestamp: t, value: a.price }], extendData: a.text || '★' }); }

  const styles = theme === 'light' ? {} : JSON.parse(JSON.stringify(DARK));
  if (isLine) styles.candle = { ...(styles.candle || {}), type: 'area' };
  if (logScale) styles.yAxis = { ...(styles.yAxis || {}), type: 'log' };

  const indLabels = indicators.map((i) => i.type + (i.period ? i.period : '')).join(' ') || 'EMA20 BOLL VOL';
  const typeTag = type !== 'candles' ? `${type.toUpperCase()}  ·  ` : '';
  const header = { title: `$${symbol || 'TOKEN'}`, sub: `${interval || ''}  ·  ${typeTag}${indLabels}${logScale ? '  ·  LOG' : ''}`, brand: 'quiver' };

  const browser = await getBrowser();
  const dpr = Math.min(Math.max(Number(scale) || 2, 1), 3);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  try {
    await page.setContent(html(width, height, header), { waitUntil: 'load', timeout: 8000 });
    await page.evaluate((payload) => window.__render(payload), { data, indicators: inds, overlays, styles, plotWidth: width - 96 });
    await page.waitForFunction('window.__done === true', { timeout: 6000 });
    const err = await page.evaluate('window.__err || null');
    if (err) throw new Error('klinecharts: ' + err);
    await page.waitForTimeout(350); // let canvas paint
    const overlayErrs = await page.evaluate('window.__overlayErrs || []');
    if (overlayErrs.length) console.error('[browserRender] overlay errors:', overlayErrs.join(' | '));
    const el = await page.$('#wrap');
    const png = await el.screenshot({ type: 'png' });
    return png;
  } finally {
    await page.close().catch(() => {});
  }
}
