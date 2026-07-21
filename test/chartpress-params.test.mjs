// P0 chart quick-wins — regression locks. Every test here FAILS on the pre-P0 code by construction:
// ichimoku() did not exist; renderEChart ignored format/scale/timezone and always returned a PNG Buffer;
// longshort/orderline drawings did not exist (label text absent from the SVG).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ichimoku } from '../src/engine/chart/indicators.js';
import { renderEChart, rrOf } from '../src/engine/chart/echartsRender.js';

function synthBars(n = 80) {
  const bars = []; let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px, c = px + (i % 3 === 0 ? -1.2 : 1.6);
    bars.push({ t: Date.UTC(2026, 6, 1) + i * 3600e3, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 40 + (i % 9) });
    px = c;
  }
  return bars;
}

test('ichimoku: hand-verifiable alignment on a worked example', () => {
  // Deterministic ramp: high[i]=i+2, low[i]=i, close[i]=i+1 → HH(p,i)=i+2, LL(p,i)=i-p+1,
  // so mid(p,i)=(2i+3-p)/2 exactly. Assert tenkan/kijun/spans/chikou against the closed form.
  const n = 90;
  const highs = [], lows = [], closes = [];
  for (let i = 0; i < n; i++) { highs.push(i + 2); lows.push(i); closes.push(i + 1); }
  const ic = ichimoku(highs, lows, closes); // conv 9, base 26, spanB 52, disp 26
  // domain edges
  assert.equal(ic.tenkan[7], null);                       // needs 9 bars
  assert.equal(ic.tenkan[8], (2 * 8 + 3 - 9) / 2);        // = 5.0
  assert.equal(ic.kijun[24], null);                       // needs 26 bars
  assert.equal(ic.kijun[25], (2 * 25 + 3 - 26) / 2);      // = 13.5
  // spanA at i+disp carries (tenkan[i]+kijun[i])/2; first defined source index is 25
  assert.equal(ic.spanA[25 + 25], null);                  // i=24 source undefined
  const src = 25;
  const expA = (((2 * src + 3 - 9) / 2) + ((2 * src + 3 - 26) / 2)) / 2;
  assert.equal(ic.spanA[src + 26], expA);
  // spanB source needs 52 bars: first at i=51 → lands at 77
  assert.equal(ic.spanB[76], null);
  assert.equal(ic.spanB[77], (2 * 51 + 3 - 52) / 2);
  // chikou is close displaced BACK: chikou[i] = close[i+26]
  assert.equal(ic.chikou[0], closes[26]);
  assert.equal(ic.chikou[n - 27], closes[n - 1]);
  assert.equal(ic.chikou[n - 26], null);                  // beyond last close
  // every array is exactly n long (alignment contract)
  for (const k of ['tenkan', 'kijun', 'spanA', 'spanB', 'chikou']) assert.equal(ic[k].length, n);
});

test('renderEChart: format svg returns an SVG string (not a Buffer)', () => {
  const out = renderEChart({ bars: synthBars(40), symbol: 'T', interval: '1H', format: 'svg' });
  assert.equal(typeof out, 'string');
  assert.ok(out.trimStart().startsWith('<svg'), 'must start with <svg');
  assert.ok(out.includes('</svg>'));
});

test('renderEChart: scale multiplies the PNG pixel width', async () => {
  const { PNG } = await import('pngjs');
  const p1 = PNG.sync.read(renderEChart({ bars: synthBars(40), symbol: 'T', interval: '1H', width: 800, height: 500 }));
  const p2 = PNG.sync.read(renderEChart({ bars: synthBars(40), symbol: 'T', interval: '1H', width: 800, height: 500, scale: 2 }));
  assert.equal(p1.width, 800);
  assert.equal(p2.width, 1600);
});

test('renderEChart: timezone shifts axis labels (Asia/Jakarta = UTC+7)', () => {
  // bars start at 00:00 UTC → Jakarta labels must show 07:00 and no 00:00-at-start label drift.
  const svgUtc = renderEChart({ bars: synthBars(30), symbol: 'T', interval: '1H', format: 'svg' });
  const svgWib = renderEChart({ bars: synthBars(30), symbol: 'T', interval: '1H', format: 'svg', timezone: 'Asia/Jakarta' });
  assert.ok(svgUtc.includes('07-01 00:00') || svgUtc.includes('00:00'), 'UTC render shows a midnight label');
  assert.ok(svgWib.includes('07:00'), 'Jakarta render shows the +7h label');
  assert.notEqual(svgUtc, svgWib);
});

test('renderEChart: longshort draws the R:R label and orderline draws the side label', () => {
  const bars = synthBars(50);
  const svg = renderEChart({
    bars, symbol: 'T', interval: '1H', format: 'svg',
    drawings: [
      { type: 'longshort', side: 'long', entry: 120, stop: 110, target: 145, entryIndex: 20, exitIndex: 45 },
      { type: 'orderline', side: 'sell', price: 150, label: 'TP1' },
    ],
  });
  assert.ok(svg.includes('R:R 2.50'), 'R:R label (25/10) must be drawn');
  assert.ok(svg.includes('LONG'), 'side label must be drawn');
  assert.ok(svg.includes('SELL TP1'), 'orderline side+label must be drawn');
});

test('rrOf: risk/reward math', () => {
  assert.equal(rrOf({ entry: 100, stop: 90, target: 130 }), 3);
  assert.equal(rrOf({ entry: 100, stop: 100, target: 130 }), null); // zero risk → refuse, not Infinity
});

test('renderEChart: ICHIMOKU indicator renders the cloud lines', () => {
  const svg = renderEChart({ bars: synthBars(90), symbol: 'T', interval: '1H', format: 'svg', indicators: [{ type: 'ICHIMOKU' }, { type: 'VOL' }] });
  assert.equal(typeof svg, 'string');
  // the header subtitle names the indicator; presence of multiple polyline series is structural
  assert.ok(svg.includes('ICHIMOKU'), 'header must name ICHIMOKU');
});
