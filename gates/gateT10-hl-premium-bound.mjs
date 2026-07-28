// GATE T10 — Hyperliquid funding attested from a BOUND on the premium.
//
// The claim under test is NOT "we can bound the premium". A bound that is wide enough is trivial
// and proves nothing. The claim is the pair:
//
//   POSITIVE   On the asset-hours where the chain-readable bound fits inside the no-clamp band
//              [-4e-4, +6e-4], the venue's published funding rate is EXACTLY 1.25e-5 — every time,
//              with no exceptions, checked against the venue's own fundingHistory.
//   NEGATIVE   On every other asset-hour the module returns UNATTESTABLE. It never approximates,
//              and a premium claimed outside the bound is REFUSED.
//
// A gate with only the positive half is a gate that cannot fail: widening the bound to infinity
// would pass it. So the tests below spend more effort on the refusals than on the agreements, and
// gateT10-revert.mjs removes each guard in turn and requires this file to go red.
//
//   node --test gates/gateT10-hl-premium-bound.mjs
//   node gates/gateT10-revert.mjs                    proves it can fail
//
// Live-network tests skip on transport failure and count the skip; a comparison that RUNS and
// disagrees is always a failure. Those two are never conflated.
//
// WHERE THE NUMBERS COME FROM. Not from preference:
//   band     [-4e-4, +6e-4] is the venue's own no-clamp region, derived from the documented
//            clamp(1e-4 - P, -5e-4, +5e-4) and re-verified on 50,976/50,976 live asset-hours.
//            Zero free parameters.
//   margin   measured by gates/calibrate-hl-premium-bound.mjs as 2x the worst hourly residual on
//            the best-covered hour, then validated OUT OF SAMPLE. The gate asserts the worst honest
//            case does not exceed it, and reports how much of it that case uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sampleBound, accumulate, pinFundingRate, checkClaimedPremium, verifyFundingHour,
  parseDecimal, formatFixed, readSnapshot,
  ONE, BAND_LO, BAND_HI, PINNED_RATE, PINNED_RATE_STR, PRECOMPILES, FundingBoundError,
} from '../src/adapters/hyperliquid-funding-bound.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(ROOT, 'gates', 'hl-premium-bound-fixture.json');
const CALIB_PATH = path.join(ROOT, 'gates', 'hl-premium-bound-calibration.json');

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const calib = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
const MARGIN = BigInt(calib.marginFixed);
const rows = fixture.rows.map((r) => ({ ...r, meanUB: BigInt(r.meanUB), meanLB: BigInt(r.meanLB) }));
const bps = (v) => (Number(v) / Number(ONE) * 1e4);

// The best-covered hour is the one the headline numbers are quoted from; a partly-covered hour is
// still scored, but coverage is carried into every claim rather than dropped.
const FULL = rows.filter((r) => r.coverage >= 0.9);

let skipped = 0;
const live = async (fn) => { try { return await fn(); } catch (e) { skipped++; return { _transport: String(e).slice(0, 140) }; } };

// ═══════════════════════════════════════════════════════════════════════════════════════════════
test('T10.1 the two precompiles are what the bound assumes: 0x807 is the oracle, 0x80E is the touch', async () => {
  const r = await live(async () => {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const [meta, ctxs] = await res.json();
    const idx = meta.universe.map((u, i) => ({ u, i })).filter(({ u }) => !u.isDelisted).slice(0, 60).map(({ i }) => i);
    const snap = await readSnapshot({ indices: idx });
    return { meta, ctxs, snap, idx };
  });
  if (r._transport) { console.log(`      SKIP (transport): ${r._transport}`); return; }
  let checked = 0, oracleExact = 0, midConsistent = 0, midChecked = 0;
  for (const i of r.idx) {
    const v = r.snap.values.get(i), c = r.ctxs[i], u = r.meta.universe[i];
    if (!v || v.oracle == null || !c) continue;
    const scale = 10 ** (6 - u.szDecimals);
    checked++;
    if (String(Math.round(Number(c.oraclePx) * scale)) === String(v.oracle)) oracleExact++;
    if (v.bid != null && v.ask != null && c.midPx != null) {
      midChecked++;
      const mid = (Number(v.bid) + Number(v.ask)) / 2 / scale;
      if (Math.abs(mid - Number(c.midPx)) / Number(c.midPx) < 1e-5) midConsistent++;
    }
  }
  console.log(`      0x807 == published oraclePx on ${oracleExact}/${checked}; mid(0x80E) == published midPx on ${midConsistent}/${midChecked}`);
  assert.ok(checked >= 20, `too few assets read to conclude anything (${checked})`);
  // Reads are seconds apart over unsigned HTTPS, so a fast mover can legitimately differ. The bar is
  // that the great majority agree EXACTLY — a wrong precompile would agree essentially never.
  assert.ok(oracleExact / checked >= 0.75, `0x807 is not the oracle price: only ${oracleExact}/${checked} exact`);
  assert.ok(midConsistent / midChecked >= 0.4, `0x80E is not the top of book: mid agrees on only ${midConsistent}/${midChecked}`);
});

test('T10.2 impact prices bracket the touch from outside — the inequality the whole bound rests on', async () => {
  const r = await live(async () => {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const [meta, ctxs] = await res.json();
    const idx = meta.universe.map((u, i) => ({ u, i })).filter(({ u }) => !u.isDelisted).slice(0, 80).map(({ i }) => i);
    return { meta, ctxs, snap: await readSnapshot({ indices: idx }), idx };
  });
  if (r._transport) { console.log(`      SKIP (transport): ${r._transport}`); return; }
  let n = 0, bidOk = 0, askOk = 0;
  for (const i of r.idx) {
    const v = r.snap.values.get(i), c = r.ctxs[i], u = r.meta.universe[i];
    if (!v || v.bid == null || v.ask == null || !c?.impactPxs) continue;
    const scale = 10 ** (6 - u.szDecimals);
    const ib = Number(c.impactPxs[0]) * scale, ia = Number(c.impactPxs[1]) * scale;
    n++;
    if (ib <= Number(v.bid) + 1e-6) bidOk++;
    if (ia >= Number(v.ask) - 1e-6) askOk++;
  }
  console.log(`      impact_bid <= best_bid on ${bidOk}/${n}; impact_ask >= best_ask on ${askOk}/${n} (point-in-time, ~1s of skew)`);
  assert.ok(n >= 30, `too few assets carry impactPxs to conclude (${n})`);
  // Measured 97-98% at a point read; the residual is what `margin` exists for. If this ever fell
  // near 50% the inequality would be wrong and the bound unsound in principle, not just in margin.
  assert.ok(bidOk / n >= 0.9, `impact_bid <= best_bid holds only ${bidOk}/${n} — the bound's premise is broken`);
  assert.ok(askOk / n >= 0.9, `impact_ask >= best_ask holds only ${askOk}/${n} — the bound's premise is broken`);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
test('T10.3 SOUNDNESS: every hour the module attests really did settle at exactly 1.25e-5', () => {
  assert.ok(FULL.length >= 100, `fixture has only ${FULL.length} well-covered asset-hours`);
  const attested = [], wrong = [];
  for (const r of FULL) {
    const v = verifyFundingHour({
      accumulated: { meanUB: r.meanUB, meanLB: r.meanLB, n: r.n, skipped: 0, oracleInsideBook: r.oracleInsideBook },
      margin: MARGIN, expectedSamples: 720, minCoverage: 0.9, coin: r.coin,
    });
    if (!v.attestable) continue;
    attested.push(r);
    if (parseDecimal(r.fundingRate) !== PINNED_RATE) wrong.push(r);
  }
  console.log(`      attested ${attested.length}/${FULL.length} asset-hours; published rate differed on ${wrong.length}`);
  for (const w of wrong.slice(0, 5)) console.log(`        ${w.coin}: published ${w.fundingRate}, premium ${w.premium}, bound [${formatFixed(w.meanLB, 10)}, ${formatFixed(w.meanUB, 10)}]`);
  assert.ok(attested.length > 0, 'the module attested nothing at all — the positive half is dead');
  assert.equal(wrong.length, 0, `${wrong.length} attested asset-hours did NOT settle at 1.25e-5`);
});

test('T10.4 the bound brackets the venue premium, and the worst honest case fits inside the margin', () => {
  let worst = 0n, worstRow = null, exceed = 0;
  for (const r of FULL) {
    const P = parseDecimal(r.premium);
    const below = r.meanLB - P, above = P - r.meanUB;
    const res = below > 0n ? below : (above > 0n ? above : 0n);
    if (res > worst) { worst = res; worstRow = r; }
    if (res > MARGIN) exceed++;
  }
  const usage = MARGIN > 0n ? Number(worst) / Number(MARGIN) : 0;
  console.log(`      margin ${bps(MARGIN).toFixed(3)} bps; worst honest asset-hour uses ${(100 * usage).toFixed(2)}% of it` +
    (worstRow ? ` (${worstRow.coin})` : ''));
  console.log(`      asset-hours exceeding the margin: ${exceed}/${FULL.length}`);
  assert.equal(exceed, 0, `${exceed} honest asset-hours fell outside the calibrated bound`);
  // A margin nothing comes near is not calibrated, it is padding. Saturation is what a real bound
  // looks like — the same standard gateF applies to its quantity band.
  assert.ok(usage > 0.02, `the margin is ${(1 / Math.max(usage, 1e-9)).toFixed(0)}x larger than anything honest needs — padding, not calibration`);
});

test('T10.5 NEGATIVE: a fabricated premium outside the bound is refused', () => {
  const usable = FULL.filter((r) => r.meanUB - r.meanLB < ONE / 100n);
  assert.ok(usable.length >= 50, 'not enough rows to test refusals');
  let refusedLow = 0, refusedHigh = 0, acceptedHonest = 0, leaked = 0;
  for (const r of usable) {
    const honest = checkClaimedPremium({ claimedPremium: r.premium, meanUB: r.meanUB, meanLB: r.meanLB, margin: MARGIN });
    if (honest.ok) acceptedHonest++;
    // fabricate: push the premium a full band-width past each edge of its own bound
    const lowFake = formatFixed(r.meanLB - MARGIN - ONE / 1000n, 12);
    const highFake = formatFixed(r.meanUB + MARGIN + ONE / 1000n, 12);
    const a = checkClaimedPremium({ claimedPremium: lowFake, meanUB: r.meanUB, meanLB: r.meanLB, margin: MARGIN });
    const b = checkClaimedPremium({ claimedPremium: highFake, meanUB: r.meanUB, meanLB: r.meanLB, margin: MARGIN });
    if (!a.ok) refusedLow++; else leaked++;
    if (!b.ok) refusedHigh++; else leaked++;
  }
  console.log(`      honest premiums accepted ${acceptedHonest}/${usable.length}; fabrications refused ${refusedLow + refusedHigh}/${2 * usable.length}`);
  assert.equal(leaked, 0, `${leaked} fabricated premiums passed the bound check`);
  assert.ok(acceptedHonest / usable.length > 0.95, `the check also rejects honest premiums (${acceptedHonest}/${usable.length}) — it is not discriminating, just strict`);
});

test('T10.6 NEGATIVE: a rate that disagrees with the pinned value is refused, not warned about', () => {
  const r = FULL.find((x) => (x.meanLB - MARGIN) >= BAND_LO && (x.meanUB + MARGIN) <= BAND_HI);
  assert.ok(r, 'no pinnable asset-hour in the fixture');
  const acc = { meanUB: r.meanUB, meanLB: r.meanLB, n: r.n, skipped: 0, oracleInsideBook: r.oracleInsideBook };
  const good = verifyFundingHour({ accumulated: acc, margin: MARGIN, claimedFundingRate: PINNED_RATE_STR, coin: r.coin });
  assert.equal(good.attestable, true, 'the honest rate was refused');
  for (const fake of ['0.0000126', '0.0', '-0.0000125', '0.0001']) {
    const bad = verifyFundingHour({ accumulated: acc, margin: MARGIN, claimedFundingRate: fake, coin: r.coin });
    assert.equal(bad.attestable, false, `claimed rate ${fake} was attested`);
    assert.ok(bad.refusals.includes('RATE_DISAGREES_WITH_PINNED_VALUE'), `claimed rate ${fake} refused for the wrong reason: ${bad.refusals}`);
    assert.equal(bad.fundingRate, null, 'a refused hour still returned a rate');
  }
  console.log(`      ${r.coin}: honest rate attested; 4 wrong rates each refused with the naming reason`);
});

test('T10.7 NEGATIVE: an hour the bound does not pin is UNATTESTABLE, never approximated', () => {
  const wide = FULL.filter((r) => !((r.meanLB - MARGIN) >= BAND_LO && (r.meanUB + MARGIN) <= BAND_HI));
  assert.ok(wide.length > 0, 'every asset-hour pinned — this test cannot discriminate on this fixture');
  let approximated = 0;
  for (const r of wide) {
    const v = verifyFundingHour({
      accumulated: { meanUB: r.meanUB, meanLB: r.meanLB, n: r.n, skipped: 0, oracleInsideBook: r.oracleInsideBook },
      margin: MARGIN, coin: r.coin,
    });
    if (v.attestable || v.fundingRate !== null) approximated++;
  }
  // and the ones it refuses include hours whose true rate WAS 1.25e-5: refusing those is correct
  // behaviour, not a bug, and the count is reported so the cost of the refusal is visible.
  const refusedButPinnable = wide.filter((r) => parseDecimal(r.fundingRate) === PINNED_RATE).length;
  console.log(`      ${wide.length} asset-hours not pinned; approximated anyway: ${approximated}`);
  console.log(`      of those, ${refusedButPinnable} really were 1.25e-5 — refused rather than guessed (that is the cost of soundness)`);
  assert.equal(approximated, 0, `${approximated} unpinnable asset-hours were given a rate`);
});

test('T10.8 NEGATIVE: dropping the loud samples must not manufacture a pin', () => {
  // mean(UB) and mean(LB) are means of NON-NEGATIVE excursions, so an attestor that keeps only the
  // quiet samples shrinks its own bound and can pin an hour that is not pinnable. The coverage
  // assertion is the only thing standing between this module and that attack. Same defect gateF
  // §F8 found in an intersection-only comparison.
  const victim = FULL.find((r) => !((r.meanLB - MARGIN) >= BAND_LO && (r.meanUB + MARGIN) <= BAND_HI));
  assert.ok(victim, 'no unpinnable hour to attack');
  const shrunk = { meanUB: 0n, meanLB: -ONE / 1000000n, n: 40, skipped: 0, oracleInsideBook: 40 };  // "I only kept 40 quiet samples"
  const v = verifyFundingHour({ accumulated: shrunk, margin: MARGIN, expectedSamples: 720, minCoverage: 0.9, coin: victim.coin });
  assert.equal(v.attestable, false, 'a 40-of-720-sample bound was accepted');
  assert.equal(v.reason, 'INSUFFICIENT_COVERAGE', `wrong refusal reason: ${v.reason}`);
  console.log(`      40/720 samples refused as ${v.reason}: ${v.detail}`);
  const full = verifyFundingHour({ accumulated: { ...shrunk, n: 700 }, margin: MARGIN, expectedSamples: 720, coin: victim.coin });
  assert.equal(full.attestable, true, 'coverage assertion is rejecting well-covered hours too — it is not discriminating');
});

test('T10.9 NEGATIVE: the margin cannot be used to narrow the bound', () => {
  const r = FULL[0];
  assert.throws(() => pinFundingRate({ meanUB: r.meanUB, meanLB: r.meanLB, margin: -ONE, n: 720 }), FundingBoundError);
  assert.throws(() => checkClaimedPremium({ claimedPremium: '0.0', meanUB: r.meanUB, meanLB: r.meanLB, margin: -ONE }), FundingBoundError);
  // and a bigger margin must never make MORE hours attestable
  const count = (m) => FULL.filter((x) => pinFundingRate({ meanUB: x.meanUB, meanLB: x.meanLB, margin: m, n: 720 }).attestable).length;
  const c0 = count(0n), c1 = count(MARGIN), c2 = count(MARGIN * 10n);
  console.log(`      attestable at margin 0 / calibrated / 10x: ${c0} / ${c1} / ${c2} (must be non-increasing)`);
  assert.ok(c0 >= c1 && c1 >= c2, 'widening the margin increased the attestable set — the margin is being applied backwards');
});

test('T10.10 the arithmetic is exact and rounds the safe way', () => {
  // scale cancels: the same book expressed on a finer grid must give the identical bound
  const a = sampleBound({ oracle: 100000n, bid: 99950n, ask: 99960n });
  const b = sampleBound({ oracle: 10000000n, bid: 9995000n, ask: 9996000n });
  assert.equal(a.lb, b.lb); assert.equal(a.ub, b.ub);
  // directed rounding: a non-representable ratio must round AWAY from the premium
  const c = sampleBound({ oracle: 3n, bid: 1n, ask: 2n });      // oracle above ask, (3-2)/3 = 0.333...
  assert.ok(-c.lb > ONE / 3n, 'lower bound rounded inward — unsound by one ULP per sample');
  const acc = accumulate([{ oracle: 3n, bid: 1n, ask: 2n }, { oracle: 3n, bid: 1n, ask: 2n }, { oracle: 3n, bid: 1n, ask: 2n }]);
  assert.ok(-acc.meanLB >= ONE / 3n, 'mean rounded inward');
  assert.throws(() => sampleBound({ oracle: 100n, bid: 110n, ask: 105n }), FundingBoundError, 'a crossed book was accepted');
  assert.throws(() => parseDecimal('1e-4'), FundingBoundError, 'scientific notation silently accepted');
  assert.equal(parseDecimal('-0.0004'), BAND_LO);
  assert.equal(parseDecimal('0.0006'), BAND_HI);
  assert.equal(parseDecimal(PINNED_RATE_STR), PINNED_RATE);
  console.log('      scale-invariance, directed rounding, crossed-book refusal, band constants: all exact');
});

test('T10.12 the bound is TIGHT: no better bound exists from (oracle, best bid, best ask)', () => {
  // This is the difference between "we could not find a narrower bound" and "there is none". The
  // venue's impact prices are VWAPs walking away from the touch (fitted from l2Book depth: exact on
  // BTC, 0.15 bps on BNB, 0.36 on HYPE). So for ONE (oracle, bid, ask) triple, two different books
  // consistent with it produce premia at the two ENDS of the bound, and every value between. A
  // verifier holding only those three numbers cannot separate them.
  const vwap = (levels, notional) => {
    let need = notional, cost = 0, got = 0;
    for (const [px, sz] of levels) { const take = Math.min(px * sz, need); cost += take; got += take / px; need -= take; if (need <= 1e-12) break; }
    return need > 1e-9 ? null : cost / got;
  };
  const premium = (ib, ia, o) => (Math.max(ib - o, 0) - Math.max(o - ia, 0)) / o;
  const o = 1000, bid = 998, ask = 999, NOTIONAL = 5000;          // oracle above the best ask
  const b = sampleBound({ oracle: 1000n, bid: 998n, ask: 999n });
  const lb = Number(b.lb) / Number(ONE), ub = Number(b.ub) / Number(ONE);

  // book A: all the depth sits at the touch -> impact == BBO -> premium lands ON the lower bound
  const deep = { bids: [[bid, 1000]], asks: [[ask, 1000]] };
  const pA = premium(vwap(deep.bids, NOTIONAL), vwap(deep.asks, NOTIONAL), o);
  // book B: a dust level at the touch, the rest past the oracle -> impact_ask > oracle -> premium 0
  const thin = { bids: [[bid, 0.001], [900, 1000]], asks: [[ask, 0.001], [1100, 1000]] };
  const pB = premium(vwap(thin.bids, NOTIONAL), vwap(thin.asks, NOTIONAL), o);

  console.log(`      same (oracle ${o}, bid ${bid}, ask ${ask}) -> bound [${(lb * 1e4).toFixed(2)}, ${(ub * 1e4).toFixed(2)}] bps`);
  console.log(`      depth at the touch  -> premium ${(pA * 1e4).toFixed(2)} bps (the lower endpoint)`);
  console.log(`      dust at the touch   -> premium ${(pB * 1e4).toFixed(2)} bps (the upper endpoint)`);
  assert.ok(Math.abs(pA - lb) < 1e-9, `deep book did not attain the lower bound: ${pA} vs ${lb}`);
  assert.ok(Math.abs(pB - ub) < 1e-9, `thin book did not attain the upper bound: ${pB} vs ${ub}`);
  assert.ok(pA < pB, 'the two books are not separated at all');
  // and the forced case: oracle inside the touch pins the premium at 0 for EVERY book
  const inside = sampleBound({ oracle: 1000n, bid: 999n, ask: 1001n });
  assert.equal(inside.lb, 0n); assert.equal(inside.ub, 0n);
  for (const book of [deep, thin, { bids: [[999, 0.001], [500, 1e6]], asks: [[1001, 0.001], [2000, 1e6]] }]) {
    const p = premium(vwap(book.bids, NOTIONAL) ?? 999, vwap(book.asks, NOTIONAL) ?? 1001, 1000);
    assert.ok(Math.abs(p) < 1e-12, `oracle inside the touch did not force premium 0: ${p}`);
  }
  console.log('      oracle inside the touch forces premium 0 for every book tried — zero-width, not a bound');
});

test('T10.11 headline coverage is reported, not rounded up', () => {
  const pinned = FULL.filter((r) => pinFundingRate({ meanUB: r.meanUB, meanLB: r.meanLB, margin: MARGIN, n: r.n, expectedSamples: 720, minCoverage: 0.9 }).attestable);
  const nonBinding = FULL.filter((r) => { const P = parseDecimal(r.premium); return P >= BAND_LO && P <= BAND_HI; });
  const recall = nonBinding.length ? pinned.length / nonBinding.length : 0;
  console.log(`      asset-hours ${FULL.length}: bound pins ${pinned.length} (${(100 * pinned.length / FULL.length).toFixed(2)}%)`);
  console.log(`      venue non-binding ${nonBinding.length} (${(100 * nonBinding.length / FULL.length).toFixed(2)}%) -> recall ${(100 * recall).toFixed(2)}%`);
  const lo = FULL.map((r) => -(r.meanLB - MARGIN)).sort((a, b) => (a < b ? -1 : 1));
  const hi = FULL.map((r) => r.meanUB + MARGIN).sort((a, b) => (a < b ? -1 : 1));
  console.log(`      |lower bound| p50 ${bps(lo[Math.floor(lo.length / 2)]).toFixed(2)} bps vs 4.00 allowed; upper bound p50 ${bps(hi[Math.floor(hi.length / 2)]).toFixed(2)} bps vs 6.00 allowed`);
  assert.ok(pinned.length > 0 && pinned.length < FULL.length, 'the bound pins everything or nothing — it is not measuring anything');
  console.log(`      (live-network subtests skipped this run: ${skipped})`);
});
