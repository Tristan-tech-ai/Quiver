// Generate publication figures for the whitepaper from REAL engine output (not re-derived formulas), using
// ECharts SSR -> inline SVG. Run: node tools/genfigs.mjs  -> writes paper/figures/*.svg
//
// DESIGN (per the "figures for research papers" principles): vector output, readable fonts, one consistent
// style for the whole paper, and — the main lever — STRATEGIC color: hue carries the message, it does not
// just label a series. A calm slate-blue is the baseline / safe / recommended; a muted brick-red is
// reserved for DANGER and LOSS; ochre is the in-between. No bright, yellow, rainbow, or 3D. Each figure
// also guides the eye with one annotation (a danger band, a margin floor, an emphasized default).
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { sizeGate } from '../src/engine/sizeGate.js';
import { lpRisk } from '../src/engine/lpRisk.js';
import { perpGate } from '../src/engine/perpGate.js';
import { optionsRisk } from '../src/engine/optionsRisk.js';
const require = createRequire(import.meta.url);
const echarts = require('echarts');

const OUT = new URL('../paper/figures/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const AX = '#8a97a8', TXT = '#1a2332', GRID = '#e4e9f0';
const SAFE = '#2b6cb0', DANGER = '#c0392b', MID = '#b7791f', MUTED = '#9aa5b1';   // red always means "worse"
const COLORS = [SAFE, MID, DANGER, MUTED];
const base = (title, sub) => ({
  animation: false,   // CRITICAL for SSR: without this, ECharts captures the reveal animation mid-frame and
  backgroundColor: 'transparent',   // clips every line on the right (the "kepotong" curves). Renders full state.
  color: COLORS,
  title: { text: title, subtext: sub, left: 'center', textStyle: { color: TXT, fontSize: 15, fontWeight: 600 }, subtextStyle: { color: AX, fontSize: 11 } },
  textStyle: { fontFamily: 'Georgia, serif' },
  grid: { left: 64, right: 24, top: 88, bottom: 50 },
  legend: { top: 52, textStyle: { color: TXT, fontSize: 11 } },
});
const axis = (name, extra = {}) => ({ name, nameLocation: 'center', nameGap: 34, nameTextStyle: { color: TXT, fontSize: 12 }, axisLine: { lineStyle: { color: AX } }, axisLabel: { color: AX, fontSize: 10.5 }, splitLine: { lineStyle: { color: GRID } }, ...extra });

function render(option, w, h, file) {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: w, height: h });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  writeFileSync(new URL(file, OUT), svg);
  return svg.length;
}

// ── Fig (doc 2): Risk of ruin vs drawdown depth, full/half/quarter Kelly (from size-gate) ────────────
// Strategic color: full Kelly = red (ruinous), quarter Kelly = slate drawn heaviest (the recommended
// default), half Kelly = ochre between. The palette states the recommendation, not just the category.
const levels = []; for (let a = 0.95; a >= 0.05; a -= 0.025) levels.push(Number(a.toFixed(3)));
const rorSpec = [[1, 'Full Kelly (λ=1) — ruinous', DANGER, 2.4], [0.5, 'Half Kelly (λ=0.5)', MID, 2.2], [0.25, 'Quarter Kelly (λ=0.25) — default', SAFE, 3.2]];
const rorSeries = rorSpec.map(([lam, name, color, width]) => {
  const r = sizeGate({ winProb: 0.55, winLossRatio: 1, kellyFraction: lam, drawdownLevels: levels });
  const data = r.riskOfRuin.map((x) => [Number((100 * (1 - x.drawdownToFraction)).toFixed(1)), Number((100 * x.probEver).toFixed(2))]);
  return { name, type: 'line', showSymbol: false, lineStyle: { color, width }, itemStyle: { color }, data };
});
render({ ...base('Risk of ruin shrinks super-linearly with fractional Kelly', 'P(ever drawing down to a loss) — size-gate, RoR = α^((2−λ)/λ)'),
  xAxis: axis('drawdown from peak (%)', { type: 'value', min: 0, max: 95 }),
  yAxis: axis('probability of ever reaching it (%)', { type: 'value', min: 0, max: 100 }),
  series: rorSeries }, 640, 380, 'fig-ror.svg');

// ── Fig (doc 4): Impermanent loss vs price ratio (from lp-risk) ──────────────────────────────────────
// IL is always a COST, so the area under the curve is tinted red (loss), not a neutral blue fill.
const ilData = []; for (let r = 0.25; r <= 4.0001; r += 0.05) ilData.push([Number(r.toFixed(3)), Number(lpRisk({ priceRatio: r }).realizedIL.impermanentLossPct.toFixed(4))]);
render({ ...base('Impermanent loss is symmetric in log-price and always ≤ 0', 'IL(r) = 2√r/(1+r) − 1 — lp-risk, verified at the token level'),
  legend: { show: false }, grid: { left: 62, right: 24, top: 64, bottom: 52 },
  xAxis: axis('price ratio r = P₁ / P₀', { type: 'value', min: 0.25, max: 4 }),
  yAxis: axis('impermanent loss (%)', { type: 'value', max: 0 }),
  series: [{ type: 'line', showSymbol: false, lineWidth: 2.6, color: SAFE, areaStyle: { color: 'rgba(192,57,43,0.10)' }, data: ilData, markLine: { silent: true, symbol: 'none', lineStyle: { color: AX, type: 'dashed' }, label: { position: 'insideStartTop', rotate: 0, formatter: 'no move', color: AX, fontSize: 10 }, data: [{ xAxis: 1 }] } }] }, 640, 360, 'fig-il.svg');

// ── Fig (doc 1): Liquidation distance vs leverage (from perp-gate, BTC mmr 1.25%) ────────────────────
// The message is DANGER at high leverage: shade the high-leverage band red so the thin-buffer zone reads
// at a glance rather than being inferred from the slope of the curve.
const liqData = []; for (let lev = 2; lev <= 40; lev += 1) { const r = perpGate({ side: 'long', entryPrice: 100000, size: 1, margin: 100000 / lev, maxLeverage: 40 }); if (r.ok && !r.liquidatable_at_entry) liqData.push([lev, Number(r.moveToLiquidationPct.toFixed(3))]); }
render({ ...base('The liquidation buffer collapses with leverage', 'move-to-liquidation for a BTC long (maint. margin 1.25%) — perp-gate'),
  legend: { show: false }, grid: { left: 62, right: 24, top: 64, bottom: 52 },
  xAxis: axis('effective leverage (×)', { type: 'value', min: 2, max: 40 }),
  yAxis: axis('adverse move to liquidation (%)', { type: 'value', min: 0 }),
  series: [{ type: 'line', showSymbol: false, lineWidth: 2.6, color: SAFE, areaStyle: { color: 'rgba(43,108,176,0.06)' },
    markArea: { silent: true, itemStyle: { color: 'rgba(192,57,43,0.07)' }, label: { formatter: 'danger: thin buffer', color: DANGER, fontSize: 10, position: 'insideTopRight' }, data: [[{ xAxis: 25 }, { xAxis: 40 }]] },
    data: liqData }] }, 640, 360, 'fig-liq.svg');

// ── Fig (doc 3): SPAN scenario P&L of a short straddle across the price grid (from options-risk) ──────
// Three IV scenarios in ANALOGOUS shades of one slate (they are the same book under vol shifts, not three
// unrelated things), with a red margin-floor line marking the worst case — the message in one glance.
const sr = optionsRisk({ forward: 64000, positions: [{ type: 'call', strike: 64000, expiryDays: 30, iv: 0.6, quantity: -1 }, { type: 'put', strike: 64000, expiryDays: 30, iv: 0.6, quantity: -1 }], scanRangePct: 0.15, volShiftVolPts: 10 });
const byVol = {};
for (const s of sr.spanMargin.scenarios) { (byVol[s.volShiftPts] = byVol[s.volShiftPts] || []).push([s.underlyingMovePct, s.pnl]); }
const volNames = { '10': 'IV +10 pts', '0': 'IV unchanged', '-10': 'IV −10 pts' };
const spanShade = { 'IV unchanged': '#2b6cb0', 'IV +10 pts': '#7aa0cf', 'IV −10 pts': '#4d80bd' };
// Discrete SPAN scenarios: KEEP the data markers (they show the actually-computed 7 points per vol, not an
// implied continuum) with straight connectors. The earlier "broken" look was the reveal-animation clipping
// the line on the right (fixed by animation:false above), NOT the markers.
const spanSeries = Object.entries(byVol).map(([v, d]) => { const nm = volNames[v] || `IV ${v}`; const c = spanShade[nm] || SAFE; return { name: nm, type: 'line', symbol: 'circle', symbolSize: 5, lineStyle: { color: c, width: 2 }, itemStyle: { color: c }, data: d.sort((a, b) => a[0] - b[0]) }; });
spanSeries[0] = { ...spanSeries[0], markLine: { silent: true, symbol: 'none', lineStyle: { color: DANGER, type: 'dashed' }, label: { formatter: `worst case = SPAN margin −$${sr.spanMargin.requirement}`, color: DANGER, fontSize: 10, position: 'insideEndTop' }, data: [{ yAxis: -Number(sr.spanMargin.requirement) }] } };
render({ ...base('SPAN scenario P&L: a short straddle bleeds on any large move', `worst-case = margin ($${sr.spanMargin.requirement}) — options-risk price×vol grid`),
  xAxis: axis('underlying move (%)', { type: 'value' }),
  yAxis: axis('portfolio P&L ($)', { type: 'value' }),
  series: spanSeries }, 640, 380, 'fig-span.svg');

console.log('figures written to paper/figures/: fig-ror, fig-il, fig-liq, fig-span');
console.log('data points: ror', rorSeries[0].data.length, '| il', ilData.length, '| liq', liqData.length, '| span', sr.spanMargin.scenarios.length);
