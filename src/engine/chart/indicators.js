// Technical indicators, computed server-side from OHLCV bars, array-aligned to bars (null in warmup).
//
// The four originals (SMA/EMA/BOLL/RSI) were hand-rolled. They are now thin wrappers over the audited,
// MIT-licensed `technicalindicators` library (30+ indicators, its numbers cross-checked here in tests),
// so the FAST browserless tier gains real breadth — ATR, ADX, Stochastic, VWAP, OBV, MFI, CCI, Williams%R,
// PSAR, StochRSI, TRIX, ROC, Ichimoku, Keltner — instead of forcing anything beyond 4 indicators into the
// slow browser tier. Kept: the exact array-aligned shape the renderer already consumes.
import TI from 'technicalindicators';

const { SMA, EMA, WMA, BollingerBands, RSI: TI_RSI, ATR, ADX, Stochastic, WilliamsR, CCI, MFI, OBV, VWAP, PSAR, ROC, TRIX, StochasticRSI, ForceIndex, AwesomeOscillator, KeltnerChannels } = TI;

// Right-align a library output (which omits the warm-up region) back onto the full bar index.
function align(len, values) {
  const out = new Array(len).fill(null);
  const off = len - values.length;
  for (let i = 0; i < values.length; i++) out[off + i] = values[i];
  return out;
}
const num = (x) => (Number.isFinite(x) ? x : null);

// ---- price-overlay moving averages (kept API-compatible: return a plain aligned array) ----
export const sma = (vals, period = 20) => align(vals.length, SMA.calculate({ period, values: vals }));
export const ema = (vals, period = 20) => align(vals.length, EMA.calculate({ period, values: vals }));
export const wma = (vals, period = 20) => align(vals.length, WMA.calculate({ period, values: vals }));

export function boll(closes, period = 20, mult = 2) {
  const r = BollingerBands.calculate({ period, values: closes, stdDev: mult });
  return { mid: align(closes.length, r.map((x) => x.middle)), upper: align(closes.length, r.map((x) => x.upper)), lower: align(closes.length, r.map((x) => x.lower)) };
}
export const rsi = (closes, period = 14) => align(closes.length, TI_RSI.calculate({ period, values: closes }));

// ---- the broad set the FAST tier can now render, all array-aligned ----
// Sub-panel oscillators return { values } (single line) or structured objects; overlays return arrays.
export const atr = (h, l, c, period = 14) => align(c.length, ATR.calculate({ high: h, low: l, close: c, period }));
export const roc = (closes, period = 12) => align(closes.length, ROC.calculate({ period, values: closes }));
export const obv = (c, v) => align(c.length, OBV.calculate({ close: c, volume: v }));
export const vwap = (h, l, c, v) => align(c.length, VWAP.calculate({ high: h, low: l, close: c, volume: v }));
export const cci = (h, l, c, period = 20) => align(c.length, CCI.calculate({ high: h, low: l, close: c, period }));
export const mfi = (h, l, c, v, period = 14) => align(c.length, MFI.calculate({ high: h, low: l, close: c, volume: v, period }));
export const williamsR = (h, l, c, period = 14) => align(c.length, WilliamsR.calculate({ high: h, low: l, close: c, period }));
export const trix = (closes, period = 15) => align(closes.length, TRIX.calculate({ period, values: closes }));
export const psar = (h, l, step = 0.02, max = 0.2) => align(h.length, PSAR.calculate({ high: h, low: l, step, max }));

export function stochastic(h, l, c, period = 14, signalPeriod = 3) {
  const r = Stochastic.calculate({ high: h, low: l, close: c, period, signalPeriod });
  return { k: align(c.length, r.map((x) => num(x.k))), d: align(c.length, r.map((x) => num(x.d))) };
}
export function adx(h, l, c, period = 14) {
  const r = ADX.calculate({ high: h, low: l, close: c, period });
  return { adx: align(c.length, r.map((x) => num(x.adx))), pdi: align(c.length, r.map((x) => num(x.pdi))), mdi: align(c.length, r.map((x) => num(x.mdi))) };
}
export function stochRsi(closes, rsiPeriod = 14, stochasticPeriod = 14, kPeriod = 3, dPeriod = 3) {
  const r = StochasticRSI.calculate({ values: closes, rsiPeriod, stochasticPeriod, kPeriod, dPeriod });
  return { k: align(closes.length, r.map((x) => num(x.k))), d: align(closes.length, r.map((x) => num(x.d))) };
}
export function keltner(h, l, c, maPeriod = 20, atrPeriod = 10, mult = 2) {
  const r = KeltnerChannels.calculate({ high: h, low: l, close: c, maPeriod, atrPeriod, multiplier: mult, useSMA: false });
  return { mid: align(c.length, r.map((x) => x.middle)), upper: align(c.length, r.map((x) => x.upper)), lower: align(c.length, r.map((x) => x.lower)) };
}

// Indicator taxonomy the renderer uses to decide overlay (on price) vs its own sub-panel, plus the
// oscillator reference bands. All are SSR-renderable now, so nothing here forces the slow browser tier.
export const OVERLAYS = new Set(['MA', 'SMA', 'EMA', 'WMA', 'BOLL', 'KELTNER', 'PSAR', 'VWAP']);
export const PANELS = {
  RSI: { bands: [30, 70], range: [0, 100] },
  STOCH: { bands: [20, 80], range: [0, 100] },
  STOCHRSI: { bands: [20, 80], range: [0, 100] },
  ADX: { bands: [25], range: [0, 100] },
  CCI: { bands: [-100, 100] },
  MFI: { bands: [20, 80], range: [0, 100] },
  WILLIAMSR: { bands: [-80, -20], range: [-100, 0] },
  ATR: {}, ROC: { bands: [0] }, OBV: {}, TRIX: { bands: [0] }, VOL: {},
};

// The FULL set the FAST tier renders. Anything outside this still escalates to the browser tier.
export const SSR_SUPPORTED = new Set([...OVERLAYS, ...Object.keys(PANELS), 'VOL', 'MA']);
