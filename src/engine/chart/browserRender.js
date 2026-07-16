// FULL tier — klinecharts rendered in headless Chromium (Playwright) -> PNG screenshot.
// Uses klinecharts' built-in indicators/overlays. Warm browser reused across calls.
// Chromium path from CHROMIUM_PATH env (Railway nix) or common local install. Any failure here is
// caught by the caller (chartPress), which falls back to the FAST tier — this never hard-errors upstream.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

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
<script>window.__render=function(payload){try{
  var chart=klinecharts.init('k',{styles:payload.styles});
  chart.applyNewData(payload.data);
  (payload.indicators||[]).forEach(function(ind){
    if(ind.pane==='main'){chart.createIndicator({name:ind.name,calcParams:ind.params},true,{id:'candle_pane'});}
    else{chart.createIndicator({name:ind.name,calcParams:ind.params},false);}
  });
  (payload.overlays||[]).forEach(function(o){chart.createOverlay(o);});
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

export async function renderBrowser({ bars, symbol, interval, indicators = [], drawings = [], annotations = [], theme = 'dark', width = 1200, height = 675 }) {
  const data = bars.map((b) => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 }));
  const inds = [];
  for (const i of indicators) {
    if (i.type === 'MA') inds.push({ name: 'MA', pane: 'main', params: [i.period || 20] });
    else if (i.type === 'EMA') inds.push({ name: 'EMA', pane: 'main', params: [i.period || 20] });
    else if (i.type === 'BOLL') inds.push({ name: 'BOLL', pane: 'main', params: [i.period || 20, i.mult || 2] });
    else if (i.type === 'VOL') inds.push({ name: 'VOL', pane: 'sub' });
    else if (i.type === 'RSI') inds.push({ name: 'RSI', pane: 'sub', params: [i.period || 14] });
    else if (i.type === 'MACD') inds.push({ name: 'MACD', pane: 'sub' });
    else if (i.type === 'KDJ') inds.push({ name: 'KDJ', pane: 'sub' });
  }
  if (!indicators.length) inds.push({ name: 'EMA', pane: 'main', params: [20] }, { name: 'BOLL', pane: 'main', params: [20, 2] }, { name: 'VOL', pane: 'sub' });
  const overlays = [];
  for (const d of drawings) {
    if (d.type === 'hline' && d.price != null) overlays.push({ name: 'priceLine', points: [{ value: d.price }], extendData: d.label });
    else if (d.type === 'area' && d.fromPrice != null && d.toPrice != null) overlays.push({ name: 'priceLine', points: [{ value: d.fromPrice }] }, { name: 'priceLine', points: [{ value: d.toPrice }] });
    else if (d.type === 'trendline' && d.p1 && d.p2) { const t1 = bars[d.p1.index]?.t, t2 = bars[d.p2.index]?.t; if (t1 && t2) overlays.push({ name: 'segment', points: [{ timestamp: t1, value: d.p1.price }, { timestamp: t2, value: d.p2.price }] }); }
  }
  for (const a of annotations) { const t = bars[a.index]?.t; if (t && a.price != null) overlays.push({ name: 'simpleAnnotation', points: [{ timestamp: t, value: a.price }], extendData: a.text || '★' }); }

  const indLabels = indicators.map((i) => i.type + (i.period ? i.period : '')).join(' ') || 'EMA20 BOLL VOL';
  const header = { title: `$${symbol || 'TOKEN'}`, sub: `${interval || ''}  ·  ${indLabels}`, brand: 'quiver' };

  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  try {
    await page.setContent(html(width, height, header), { waitUntil: 'load', timeout: 8000 });
    await page.evaluate((payload) => window.__render(payload), { data, indicators: inds, overlays, styles: theme === 'light' ? {} : DARK });
    await page.waitForFunction('window.__done === true', { timeout: 6000 });
    const err = await page.evaluate('window.__err || null');
    if (err) throw new Error('klinecharts: ' + err);
    await page.waitForTimeout(350); // let canvas paint
    const el = await page.$('#wrap');
    const png = await el.screenshot({ type: 'png' });
    return png;
  } finally {
    await page.close().catch(() => {});
  }
}
