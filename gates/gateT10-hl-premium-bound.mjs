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
  // SANDWICH, WITH THE CHAIN'S OWN LAG ACCOUNTED FOR. A naive comparison measures skew rather than
  // the precompile. But an `api -> chain -> api` sandwich is not enough either: the block a chain
  // read returns is ~1 s OLDER than the moment we asked for it (block timestamp vs fetch time,
  // p10/p50/p90 all 1.00-1.01 s, measured over 471 snapshots). So the block can predate the FIRST
  // API read, and then a mismatch is guaranteed whenever the oracle refreshed in the last second —
  // which is exactly what made an earlier version of this test fail on a third of the universe at
  // random. Padding ~1.5 s before the chain read pushes the block timestamp inside the two API
  // reads, which is what makes "unmoved across the block we read" mean anything at all.
  //
  // The pad is MEASURED, not chosen. Exact-match rate on sandwich-stable rows against the pad:
  //     0 ms -> 89.58%    1500 ms -> 82.86%    3000 ms -> 99.21%    4500 ms -> 100.00%
  // (the count of "stable" rows falls as the pad grows — the honest cost of a longer window). The
  // effective delay is worse than the ~1 s block lag alone because a HyperCore oracle refresh only
  // reaches the EVM at the next block, so the two stack. 4 s sits past the knee.
  const LAG_PAD_MS = 4000;
  const r = await live(async () => {
    const idxOf = (meta) => meta.universe.map((u, i) => ({ u, i })).filter(({ u }) => !u.isDelisted).slice(0, 60).map(({ i }) => i);
    const api = async () => {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      return res.json();
    };
    const rounds = [];
    let meta = null, idx = null;
    for (let k = 0; k < 3; k++) {
      const [m, ctxs0] = await api();
      if (!meta) { meta = m; idx = idxOf(meta); }
      await new Promise((s) => setTimeout(s, LAG_PAD_MS));
      const chain = await readSnapshot({ indices: idx });
      const [, ctxs] = await api();
      rounds.push({ ctxs0, chain, ctxs });
    }
    return { meta, idx, rounds };
  });
  if (r._transport) { console.log(`      SKIP (transport): ${r._transport}`); return; }
  let stable = 0, oracleExact = 0, midStable = 0, midConsistent = 0;
  for (const round of r.rounds) for (const i of r.idx) {
    const a = round.chain.values.get(i);
    const c0 = round.ctxs0[i], c = round.ctxs[i], u = r.meta.universe[i];
    if (!a || !c || !c0 || a.oracle == null) continue;
    const scale = 10 ** (6 - u.szDecimals);
    if (c0.oraclePx === c.oraclePx) {                     // unmoved across the block we read
      stable++;
      if (String(Math.round(Number(c.oraclePx) * scale)) === String(a.oracle)) oracleExact++;
    }
    if (a.bid != null && a.ask != null && c.midPx != null && c0.midPx === c.midPx) {
      midStable++;
      // EXACT equality is the wrong bar here and measuring it would be self-deception. The chain
      // read is ~1s behind wall clock (block timestamp vs fetch time: p50 1.01s, measured), and a
      // liquid book moves a tick inside a second — so the residual disagreement is one tick of book
      // movement, not a wrong register. Scored in units of the book's own spread: measured p50
      // 0.009 spreads, and within ONE spread on 98.9% of 622 stable reads. The control that makes
      // this discriminating rather than lax: a genuinely different register (the oracle) sits ~9.9
      // bps from the mid, which is well over one spread for a typical ~6 bps book.
      const mid = (Number(a.bid) + Number(a.ask)) / 2, spread = Number(a.ask) - Number(a.bid);
      if (spread > 0 && Math.abs(mid - Number(c.midPx) * scale) <= spread) midConsistent++;
    }
  }
  console.log(`      sandwich-stable: 0x807 == published oraclePx EXACTLY on ${oracleExact}/${stable}; mid(0x80E) within one spread of published midPx on ${midConsistent}/${midStable}`);
  assert.ok(stable >= 15, `too few sandwich-stable assets to conclude anything (${stable})`);
  assert.ok(midStable >= 10, `too few sandwich-stable books to conclude anything (${midStable})`);
  // The bar comes from the measured DISTRIBUTION, not from one lucky sample — setting a threshold
  // off a four-round probe is the same error as calling one block a measurement. Over 18 rounds at
  // this pad the pooled rate is 97.31% and the per-round rate is bimodal: 15 rounds at exactly
  // 1.000, three at 0.737 / 0.842 / 0.846 when a market-wide oracle refresh straddles the window.
  // Pooling three rounds puts the floor near 0.83 even with a bad one; 0.80 clears it, and a wrong
  // register would score near ZERO, so this still fails loudly for the reason it exists.
  assert.ok(oracleExact / stable >= 0.80, `0x807 is not the oracle price: only ${oracleExact}/${stable} exact`);
  assert.ok(midConsistent / midStable >= 0.9, `0x80E is not the top of book: mid within one spread on only ${midConsistent}/${midStable}`);
});

test('T10.2 impact prices bracket the touch from outside — the inequality the whole bound rests on', async () => {
  // POOLED OVER TIME, deliberately. The residual violations are the ~1s chain lag during a price
  // move, and a move is MARKET-WIDE — so on a single snapshot the failures are correlated across
  // assets and 80 of them do not average anything out. Measured over 471 tape snapshots x 80 assets:
  // a single snapshot's pass rate has a floor of 0.575, while pooling five snapshots 5 s apart lifts
  // the floor to 0.838. Pooling is what makes this test stable; a bigger single snapshot is not.
  const ROUNDS = 5, SPACING_MS = 5000;
  const r = await live(async () => {
    const api = async () => {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      return res.json();
    };
    const [meta] = await api();
    const idx = meta.universe.map((u, i) => ({ u, i })).filter(({ u }) => !u.isDelisted).slice(0, 80).map(({ i }) => i);
    const rounds = [];
    for (let k = 0; k < ROUNDS; k++) {
      if (k) await new Promise((s) => setTimeout(s, SPACING_MS));
      const [, ctxs] = await api();
      rounds.push({ ctxs, snap: await readSnapshot({ indices: idx }) });
    }
    return { meta, rounds, idx };
  });
  if (r._transport) { console.log(`      SKIP (transport): ${r._transport}`); return; }
  let n = 0, bidOk = 0, askOk = 0;
  for (const round of r.rounds) for (const i of r.idx) {
    const v = round.snap.values.get(i), c = round.ctxs[i], u = r.meta.universe[i];
    if (!v || v.bid == null || v.ask == null || !c?.impactPxs) continue;
    const scale = 10 ** (6 - u.szDecimals);
    const ib = Number(c.impactPxs[0]) * scale, ia = Number(c.impactPxs[1]) * scale;
    n++;
    if (ib <= Number(v.bid) + 1e-6) bidOk++;
    if (ia >= Number(v.ask) - 1e-6) askOk++;
  }
  console.log(`      pooled over ${ROUNDS} snapshots ${SPACING_MS / 1000}s apart: impact_bid <= best_bid on ${bidOk}/${n} (${(100 * bidOk / n).toFixed(1)}%); impact_ask >= best_ask on ${askOk}/${n} (${(100 * askOk / n).toFixed(1)}%)`);
  assert.ok(n >= 150, `too few asset-samples carry impactPxs to conclude (${n})`);
  // The bar separates "the premise holds, with a lag artefact" from "the premise is wrong". Honest
  // floor measured at 0.838; a premise that did not hold — impact inside the touch — would score
  // near 0.5 or below. 0.75 sits between the two with room on both sides, so this can fail without
  // failing spuriously. Pooled rate over the whole tape: 98.12% bid, 97.79% ask.
  assert.ok(bidOk / n >= 0.75, `impact_bid <= best_bid holds only ${bidOk}/${n} — the bound's premise is broken`);
  assert.ok(askOk / n >= 0.75, `impact_ask >= best_ask holds only ${askOk}/${n} — the bound's premise is broken`);
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
  // Scored over EVERY hour in the fixture, not just the well-covered one. Scoring only the hour the
  // margin was fitted on would be a check that cannot fail — and it matters here, because the
  // calibration's own leave-one-out found the residual is NOT stable hour to hour: a margin fitted
  // on the full hour alone was exceeded on the other hour, whose worst residual was 3.59x the
  // in-sample worst. That is why the shipped margin is fitted across all observed hours, and why
  // the write-up calls it the weak half rather than "validated".
  const raw = rows.filter((r) => r.meanUB - r.meanLB < ONE / 100n);
  let worst = 0n, worstRow = null, exceed = 0, bracketedRaw = 0;
  const perHour = new Map();
  for (const r of raw) {
    const P = parseDecimal(r.premium);
    const below = r.meanLB - P, above = P - r.meanUB;
    const res = below > 0n ? below : (above > 0n ? above : 0n);
    if (res === 0n) bracketedRaw++;
    if (res > worst) { worst = res; worstRow = r; }
    if (res > MARGIN) exceed++;
    const cur = perHour.get(r.hour) ?? 0n;
    if (res > cur) perHour.set(r.hour, res);
  }
  const usage = MARGIN > 0n ? Number(worst) / Number(MARGIN) : 0;
  console.log(`      raw bound (no margin) already contained the published premium on ${bracketedRaw}/${raw.length}`);
  for (const [h, w] of [...perHour.entries()].sort((a, b) => a[0] - b[0])) console.log(`        hour ${new Date(h).toISOString().slice(11, 16)} worst residual ${bps(w).toFixed(3)} bps`);
  console.log(`      margin ${bps(MARGIN).toFixed(3)} bps; worst honest asset-hour uses ${(100 * usage).toFixed(2)}% of it` +
    (worstRow ? ` (${worstRow.coin})` : ''));
  console.log(`      asset-hours exceeding the margin: ${exceed}/${raw.length}`);
  assert.ok(raw.length >= 200, `too few fixture rows to score the margin (${raw.length})`);
  assert.ok(perHour.size >= 2, 'the fixture covers only one hour, so the margin cannot be scored out of sample at all');
  assert.equal(exceed, 0, `${exceed} honest asset-hours fell outside the calibrated bound`);
  if (MARGIN === 0n) {
    // The strongest outcome available: the RAW bound, with no allowance at all, already contained
    // the venue's own hourly premium on every asset-hour. Per-sample violations exist (~2% of
    // samples) but they do not survive averaging over the hour, which is the only level the clamp
    // is applied at. Nothing to saturate, so the saturation check would be vacuous rather than lax.
    assert.equal(worst, 0n, 'margin is zero but a residual was measured');
    console.log('      margin is ZERO: the raw bound contained every honest hourly premium unaided');
    return;
  }
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
  assert.throws(() => parseDecimal(''), FundingBoundError, 'empty string parsed as a number');
  assert.throws(() => parseDecimal('0.0000000000000000001'), FundingBoundError, 'a 19th significant decimal was silently truncated');
  assert.equal(parseDecimal('0.00040000000000000000'), -BAND_LO, 'trailing zeros past 18 decimals must be fine');
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
  // and the forced case: with the oracle INSIDE the touch (bid 999 <= 1000 <= ask 1001) the premium
  // is 0 for EVERY book consistent with that touch, whatever the depth behind it.
  const inside = sampleBound({ oracle: 1000n, bid: 999n, ask: 1001n });
  assert.equal(inside.lb, 0n); assert.equal(inside.ub, 0n);
  const insideBooks = [
    { bids: [[999, 1e6]], asks: [[1001, 1e6]] },                          // all depth at the touch
    { bids: [[999, 0.001], [500, 1e6]], asks: [[1001, 0.001], [2000, 1e6]] }, // dust at the touch
    { bids: [[999, 3], [998, 3], [990, 1e6]], asks: [[1001, 3], [1002, 3], [1010, 1e6]] },
  ];
  for (const book of insideBooks) {
    const p = premium(vwap(book.bids, NOTIONAL), vwap(book.asks, NOTIONAL), 1000);
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
