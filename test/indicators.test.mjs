// Anti-leakage + correctness for the technical indicators. The load-bearing test is NO-LOOKAHEAD: an
// indicator value at bar i must depend ONLY on bars 0..i. If adding future bars changes a past value,
// the indicator is peeking into the future — the single most important property for anything computed
// on a time series (this is the spirit of a proper quant anti-leakage suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, boll, stochastic, adx, atr, cci, mfi, williamsR, obv, roc } from '../src/engine/chart/indicators.js';

// Deterministic-but-varied OHLCV (noise so oscillators aren't degenerate).
function series(n = 120) {
  const c = [], h = [], l = [], v = [];
  let p = 64000;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 0.004, noise = ((i * 97) % 13 - 6) * 0.0012;
    p = p * (1 + drift + noise);
    c.push(p); h.push(p * (1 + Math.abs(noise) * 0.6 + 0.001)); l.push(p * (1 - Math.abs(noise) * 0.6 - 0.001)); v.push(800 + ((i * 137) % 900));
  }
  return { c, h, l, v };
}

// Assert an indicator is causal: value at index k is unchanged whether computed on bars[0..k] or bars[0..n].
function assertNoLookahead(name, fullOut, prefixOut, k) {
  const a = fullOut[k], b = prefixOut[k];
  if (a == null && b == null) return;
  assert.ok(a != null && b != null, `${name}: warmup mismatch at k=${k} (full=${a}, prefix=${b})`);
  assert.ok(Math.abs(a - b) < 1e-6, `${name}: LOOKAHEAD LEAK at k=${k}: full=${a} vs prefix=${b}`);
}

test('★ moving averages / RSI have NO lookahead (past values unchanged by future bars)', () => {
  const { c } = series();
  const k = 90; // a settled index well past warmup
  const prefix = c.slice(0, k + 1);
  assertNoLookahead('SMA20', sma(c, 20), sma(prefix, 20), k);
  assertNoLookahead('EMA20', ema(c, 20), ema(prefix, 20), k);
  assertNoLookahead('RSI14', rsi(c, 14), rsi(prefix, 14), k);
  assertNoLookahead('BOLL.mid', boll(c, 20).mid, boll(prefix, 20).mid, k);
  assertNoLookahead('ROC12', roc(c, 12), roc(prefix, 12), k);
});

test('★ OHLC oscillators have NO lookahead', () => {
  const { c, h, l, v } = series();
  const k = 90, pc = c.slice(0, k + 1), ph = h.slice(0, k + 1), pl = l.slice(0, k + 1), pv = v.slice(0, k + 1);
  assertNoLookahead('ATR14', atr(h, l, c, 14), atr(ph, pl, pc, 14), k);
  assertNoLookahead('CCI20', cci(h, l, c, 20), cci(ph, pl, pc, 20), k);
  assertNoLookahead('MFI14', mfi(h, l, c, v, 14), mfi(ph, pl, pc, pv, 14), k);
  assertNoLookahead('Williams%R', williamsR(h, l, c, 14), williamsR(ph, pl, pc, 14), k);
  assertNoLookahead('Stoch.k', stochastic(h, l, c, 14, 3).k, stochastic(ph, pl, pc, 14, 3).k, k);
  assertNoLookahead('ADX', adx(h, l, c, 14).adx, adx(ph, pl, pc, 14).adx, k);
});

test('all indicator outputs are right-aligned to the bar index (last value at last index)', () => {
  const { c, h, l, v } = series();
  const lastIdx = (arr) => arr.reduce((acc, x, i) => (x != null ? i : acc), -1);
  for (const [name, out] of [['SMA', sma(c, 20)], ['EMA', ema(c, 20)], ['RSI', rsi(c, 14)], ['ATR', atr(h, l, c, 14)], ['MFI', mfi(h, l, c, v, 14)], ['Stoch.k', stochastic(h, l, c, 14).k]]) {
    assert.equal(out.length, c.length, `${name} length aligns to bars`);
    assert.equal(lastIdx(out), c.length - 1, `${name} last value at last index (no trailing shift)`);
  }
});

test('bounded oscillators stay within their ranges', () => {
  const { c, h, l, v } = series();
  const inRange = (arr, lo, hi) => arr.filter((x) => x != null).every((x) => x >= lo - 1e-6 && x <= hi + 1e-6);
  assert.ok(inRange(rsi(c, 14), 0, 100), 'RSI ∈ [0,100]');
  assert.ok(inRange(stochastic(h, l, c, 14).k, 0, 100), 'Stoch %K ∈ [0,100]');
  assert.ok(inRange(mfi(h, l, c, v, 14), 0, 100), 'MFI ∈ [0,100]');
  assert.ok(inRange(williamsR(h, l, c, 14), -100, 0), 'Williams%R ∈ [-100,0]');
});

test('SMA matches a hand-computed reference (guards against a library swap regression)', () => {
  const { c } = series();
  const ref = (v, p) => { const o = Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; };
  const got = sma(c, 20), exp = ref(c, 20);
  for (let i = 0; i < c.length; i++) if (exp[i] != null) assert.ok(Math.abs(got[i] - exp[i]) < 1e-6, `SMA mismatch at ${i}`);
});
