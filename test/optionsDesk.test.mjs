// Locks the butterfly-arbitrage POLICE — the guard that decides whether options-desk is allowed to say
// "no butterfly arbitrage detected" and whether it may ship a risk-neutral distribution at all.
//
// Why this file exists: optionsDesk.js advertised 13 guarantees and had ZERO tests, because the guard was
// inline in a 500-line service function and unreachable. An untested guard is indistinguishable from no
// guard — and this codebase has already shipped a false "calendar-arb-free" claim for months. The guard is
// now in black76.js so these tests can reach it and make it FAIL.
//
// The operational question every test below asks: WHAT WOULD THIS CHECK DO IF THE THING WERE FALSE?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sviW, sviG } from '../src/engine/ssvi.js';
import { butterflyPolice } from '../src/engine/black76.js';

// The REAL parameters of the live BTC ~3.8d slice as it was fitted on 2026-07-17, BEFORE the butterfly fix.
// Not synthetic: this surface was served to payers with g(k) reaching -1.69e-3 over k in [0.175, 0.204].
const LIVE_BTC_3D8 = { a: -0.002597, b: 0.0358, rho: 0.3629, m: 0.0649, sig: 0.1027 };
const T = 3.8 / 365, F = 118000;
const ivOf = (P) => (K) => { const w = sviW(Math.log(K / F), P); return w > 0 ? Math.sqrt(w / T) : 0; };

// An arbitrage-free slice (g(k) > 0 everywhere): the guard must NOT cry wolf on this one.
const CLEAN = { a: 0.002, b: 0.03, rho: -0.15, m: 0.0, sig: 0.14 };

test('the arbitrageable live slice really does violate g(k) >= 0 (premise check)', () => {
  let minG = Infinity;
  for (let k = -0.35; k <= 0.35; k += 0.0005) minG = Math.min(minG, sviG(k, LIVE_BTC_3D8));
  assert.ok(minG < 0, `premise: LIVE_BTC_3D8 must be arbitrageable, got minG=${minG}`);
  let cleanMinG = Infinity;
  for (let k = -0.35; k <= 0.35; k += 0.0005) cleanMinG = Math.min(cleanMinG, sviG(k, CLEAN));
  assert.ok(cleanMinG > 0, `premise: CLEAN must be arb-free, got minG=${cleanMinG}`);
});

test('guard FIRES on the real arbitrageable slice when the board spans the arb region', () => {
  // Arb lives at k in [0.175, 0.204] => K in [140567, 144703]. A board out to 160k covers it.
  const out = butterflyPolice(F, T, ivOf(LIVE_BTC_3D8), 80000, 160000);
  assert.ok(out, 'guard returned null on a scannable board');
  assert.equal(out.certified, false, 'guard must NOT certify an arbitrageable slice');
  assert.equal(out.densityNonNegative, false);
  assert.ok(out.violationGridPoints > 0, 'must count the negative-density points');
  assert.ok(out.minDensity < 0, `minDensity must be negative, got ${out.minDensity}`);
  // it must say WHERE — a violation with no location is not actionable
  assert.ok(out.minDensityAtStrike > 138000 && out.minDensityAtStrike < 147000,
    `worst point should sit in the known arb region, got K=${out.minDensityAtStrike}`);
});

test('guard does NOT cry wolf on an arbitrage-free slice', () => {
  const out = butterflyPolice(F, T, ivOf(CLEAN), 80000, 160000);
  assert.ok(out, 'guard returned null on a scannable board');
  assert.equal(out.certified, true, 'an arb-free slice must certify');
  assert.equal(out.violationGridPoints, 0);
  assert.ok(out.minDensity >= 0, `minDensity must be >= 0, got ${out.minDensity}`);
});

// THE REGRESSION LOCK. This is the defect the old inline loop had: `if (d == null) continue` silently
// dropped unevaluable points from the denominator, so a smile that could only be evaluated near ATM
// produced a CLEAN, CONFIDENT verdict from a scan that never touched the wings — where the arb lives.
test('guard WITHHOLDS the verdict when most of the smile is unevaluable (old code said "clean")', () => {
  const full = ivOf(LIVE_BTC_3D8);
  // A smile that only evaluates within +/-5% of the forward — the wings return no vol, as a real
  // thin/illiquid board does. The arb at +19..23% is now invisible to the scan.
  const atmOnly = (K) => (Math.abs(K / F - 1) <= 0.05 ? full(K) : 0);
  const out = butterflyPolice(F, T, atmOnly, 80000, 160000);
  assert.ok(out, 'guard returned null');
  assert.ok(out.skippedGridPoints > 0, 'must COUNT the points it could not evaluate');
  assert.ok(out.coveragePct < 80, `coverage should be thin, got ${out.coveragePct}%`);
  // The whole point: no butterfly violation was SEEN, but the guard must not therefore claim safety.
  assert.equal(out.violationGridPoints, 0, 'premise: the ATM-only scan sees no violation');
  assert.equal(out.certified, null, 'MUST withhold — an unevaluable smile is not an arbitrage-free one');
  assert.match(out.note, /too thin to certify/i);
});

test('a certified verdict must disclose the strike range it actually scanned', () => {
  const out = butterflyPolice(F, T, ivOf(CLEAN), 80000, 160000);
  assert.ok(Array.isArray(out.scannedStrikeRange), 'must publish the domain of its claim');
  const [lo, hi] = out.scannedStrikeRange;
  assert.ok(lo >= 80000 && hi <= 160000 && hi > lo, `implausible scanned range [${lo}, ${hi}]`);
  assert.ok(Array.isArray(out.scannedMoneynessPct));
  // the sentence must name the range, so a caller can tell a clean scan from a narrow one
  assert.match(out.note, /no butterfly arbitrage detected over that range/i);
  assert.match(out.note, /Outside it, unchecked/i);
});

test('guard returns null rather than a verdict on a degenerate board', () => {
  assert.equal(butterflyPolice(F, T, ivOf(CLEAN), 100000, 100000), null, 'zero-width board');
  assert.equal(butterflyPolice(F, T, ivOf(CLEAN), 160000, 80000), null, 'inverted board');
  assert.equal(butterflyPolice(F, T, () => 0, 80000, 160000), null, 'smile evaluates nowhere');
  assert.equal(butterflyPolice(0, T, ivOf(CLEAN), 80000, 160000), null, 'no forward');
});
