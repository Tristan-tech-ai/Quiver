// GATE D (Hyperliquid) — do the numbers `hyperliquid.js` fetched over unsigned HTTPS match what
// HyperCore's own consensus holds, and can this check actually reject?
//
//   node --test gates/gateD-hl-attest.mjs          (npm run gate:d-hl)
//   node gates/gateD-hl-revert.mjs                 proves the gate can fail
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE BOUND, AND WHERE IT CAME FROM.
//
// A bound belongs to the gate that enforces it, never to the probe that suggested it. This one was
// measured here, over the FULL 232-perp universe rather than a sample:
//
//     bound = { rel: 5e-4, ticks: 2 }        allowance = rel·price + ticks·tickSize
//
// Calibration: 26 rounds x 232 assets = 6,032 observations, each one a real
// consensus→HTTP→consensus bracket.
//
//   observations breaching the bound                     0 of 6,032
//   rounds that would have turned this gate red          0 of 26
//   worst honest observation                             58.1% of the allowance (HYPER, 19 ticks)
//   inside the raw bracket with NO allowance at all      5,621 of 6,032  (93.2%)
//   p99 / p99.9 / max relative residual                  1.692e-4 / 3.436e-4 / 1.131e-3
//
// TWO TERMS, because measurement says the residual has two unrelated causes:
//
//   * The worst RELATIVE residual (1.131e-3, on W) is EXACTLY ONE TICK. W trades near 0.0088 with a
//     1e-5 grid, so one unavoidable step of price-grid quantisation is 1.1e-3 of its price.
//   * The worst residual in TICKS (500, on ZEC) is only 1.077e-4 relative — ZEC's grid is 1e-4
//     against a 464 price.
//
// Neither term alone covers both regimes. A purely relative bound admitting W needs ≥1.2e-3, which
// is LOOSER than the 10.8 bps cross-venue consensus floor this whole approach exists to beat — so a
// flat bound does not merely lose precision, it loses the argument. That is not hypothetical: the
// flat 1e-3 chosen in PHASE_D_RESEARCH §4.4 from a 40-asset sample is BREACHED by honest data at
// full-universe scale (W uses 113.1% of it). The 40-asset sample never contained a sub-cent asset,
// so it never saw the quantisation regime at all.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A GREEN RUN HERE DOES NOT MEAN.
//
// Both reads are unsigned HTTPS from this host, so one adversary at the network edge sees both.
// Green here is multi-source agreement with a much better second source — HyperCore's own consensus
// state — and NOT an attestation. It becomes an attestation only when the same comparison runs
// inside a contract on HyperEVM, where the precompile value arrives from consensus instead of from
// a wire. That a contract CAN do it is measured, not assumed (see the gas test below).
//
// Nor does it mean the number is CORRECT. Hyperliquid's mark is a stake-weighted median of external
// venues; a manipulated oracle would be attested with full force. Attestation reaches the venue's
// state and stops there.
//
// This gate is a LIVE-MARKET measurement. A genuine volatility spike can push an honest asset past
// the bound and turn it red. That is the correct behaviour for a divergence gate and the bound is
// not padded to prevent it: measured false-red rate over calibration was 0 of 26 rounds.
//
// Nothing here is served, deployed, or on chain, and nothing imports from src/engine/, so the
// published build hash q1-e1fa99d08887d6cc does not move.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTESTABILITY, VERDICT, AttestationError, PRECOMPILES,
  compareToBracket, attestPerpInputs, fetchPerpIndexHints,
  readPerpUniverse, readConsensusMarks, readConsensusPerp, ethCall,
} from '../src/adapters/hyperliquid-attest.js';

// THE BOUND. Owned here, by the gate that enforces it.
const BOUND = { rel: 5e-4, ticks: 2 };

// The number this approach has to beat to be worth building: the cross-venue consensus floor from
// PHASE_D_RESEARCH §3.5. If the bound is ever loosened past this, the gate is no longer evidence of
// anything a cheaper method could not already give you, and this assertion says so out loud.
const CROSS_VENUE_FLOOR_REL = 10.8e-4;

const GAP_MS = 1400;   // > the measured worst /info snapshot turnover (853 ms over 60 polls / 23.0 s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpUniverse() {
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`hyperliquid info ${r.status}`);
  const j = await r.json();
  return { universe: j[0].universe, ctxs: j[1], at: Date.now() };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   PART 1 — THE FAILING HALF, OFFLINE.
   No network, so these assertions are exact and cannot be excused by a moving market. If the
   comparison core cannot reject here, nothing the live half reports means anything.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const synthetic = { quantity: 'markPrice', lo: 63500, hi: 63520, ref: 63510, tick: 0.1, bound: BOUND };
const ALLOW = BOUND.rel * synthetic.ref + BOUND.ticks * synthetic.tick;

test('the knife edge: the bound is exactly where it claims to be', () => {
  // The sharpest possible pair. A gate whose refusals only start at 10x the bound has not shown
  // where its bound is; it has shown that 10x is a lot.
  const inside = compareToBracket({ ...synthetic, claimed: synthetic.hi + ALLOW * 0.98 });
  const outside = compareToBracket({ ...synthetic, claimed: synthetic.hi + ALLOW * 1.02 });
  assert.equal(inside.verdict, VERDICT.AGREE, 'a value 2% INSIDE the allowance must be accepted');
  assert.equal(outside.verdict, VERDICT.DISAGREE, 'a value 2% PAST the allowance must be refused');
  assert.ok(Math.abs(inside.usedFraction - 0.98) < 1e-9);
  assert.ok(Math.abs(outside.usedFraction - 1.02) < 1e-9);

  // and symmetrically below the bracket — a check that only rejects on one side is half a check
  assert.equal(compareToBracket({ ...synthetic, claimed: synthetic.lo - ALLOW * 1.02 }).verdict, VERDICT.DISAGREE);
  assert.equal(compareToBracket({ ...synthetic, claimed: synthetic.lo - ALLOW * 0.98 }).verdict, VERDICT.AGREE);
});

test('a fabricated mark is refused, and not narrowly', () => {
  // +0.5% is the plausible-looking lie: small enough to pass a human skim, large enough to move a
  // liquidation price materially.
  const lie = compareToBracket({ ...synthetic, claimed: synthetic.hi * 1.005 });
  assert.equal(lie.verdict, VERDICT.DISAGREE);
  assert.ok(lie.usedFraction > 5, `a 0.5% fabrication should blow far past the bound, used ${lie.usedFraction.toFixed(1)}x`);

  for (const mult of [1.05, 0.95, 2, 0.5]) {
    assert.equal(compareToBracket({ ...synthetic, claimed: synthetic.hi * mult }).verdict, VERDICT.DISAGREE,
      `a mark at ${mult}x consensus must be refused`);
  }
});

test('both terms of the bound do work the other cannot', () => {
  // These are the two real measured extremes, replayed as fixtures. If either term is ever dropped,
  // one of these two assertions goes red — which is the point of keeping both.
  //
  // W: one tick of grid quantisation on a sub-cent asset = 1.131e-3 relative.
  const w = { quantity: 'markPrice', lo: 0.00884, hi: 0.00884, ref: 0.00884, tick: 1e-5 };
  assert.equal(compareToBracket({ ...w, claimed: 0.00883, bound: BOUND }).verdict, VERDICT.AGREE,
    'the tick term must admit a one-tick disagreement on a sub-cent asset');
  assert.equal(compareToBracket({ ...w, claimed: 0.00883, bound: { rel: BOUND.rel, ticks: 0 } }).verdict, VERDICT.DISAGREE,
    'and without the tick term that same honest observation would be refused');

  // ZEC: 500 ticks, but only 1.077e-4 relative, because the grid is fine against a 464 price.
  const zec = { quantity: 'markPrice', lo: 464.34, hi: 464.34, ref: 464.34, tick: 1e-4 };
  assert.equal(compareToBracket({ ...zec, claimed: 464.39, bound: BOUND }).verdict, VERDICT.AGREE,
    'the relative term must admit a 500-tick disagreement on a fine-grid asset');
  assert.equal(compareToBracket({ ...zec, claimed: 464.39, bound: { rel: 0, ticks: BOUND.ticks } }).verdict, VERDICT.DISAGREE,
    'and without the relative term that same honest observation would be refused');
});

test('the bound is tighter than the alternative it has to beat', () => {
  // 10.8 bps is what multi-venue consensus already gives without any of this. A bound looser than
  // that would make the whole mechanism decorative.
  assert.ok(BOUND.rel < CROSS_VENUE_FLOOR_REL,
    `bound.rel ${BOUND.rel} must be tighter than the ${CROSS_VENUE_FLOOR_REL} cross-venue consensus floor`);
  // And the flat bound §4.4 proposed is NOT admissible: honest data breaches it.
  const w = { quantity: 'markPrice', lo: 0.00884, hi: 0.00884, ref: 0.00884, tick: 1e-5, claimed: 0.00883 };
  assert.equal(compareToBracket({ ...w, bound: { rel: 1e-3, ticks: 0 } }).verdict, VERDICT.DISAGREE,
    'the flat 1e-3 bound from §4.4 refuses a real honest observation — recorded here so it cannot quietly come back');
});

test('a missing bound is refused rather than defaulted', () => {
  // A default tolerance is a bound nobody chose, applied to data nobody measured.
  for (const bad of [undefined, null, {}, { rel: 1e-3 }, { ticks: 2 }, { rel: NaN, ticks: 2 }]) {
    assert.throws(() => compareToBracket({ ...synthetic, claimed: 63510, bound: bad }), AttestationError);
  }
});

test('unattestable quantities are never reported as agreeing', () => {
  // The whole point of the register. Every entry marked unattestable must carry a REASON, because
  // "we did not check this" and "we checked this and it was fine" must never be the same string.
  const unatt = Object.entries(ATTESTABILITY).filter(([, v]) => !v.attestable);
  assert.ok(unatt.length > 0);
  for (const [k, v] of unatt) {
    assert.ok(typeof v.reason === 'string' && v.reason.length > 20, `${k} must say WHY it cannot be attested`);
    assert.ok(!v.via, `${k} must not name a precompile it does not have`);
  }
  // funding is the one that matters most: perp-gate uses it, and no precompile returns it.
  assert.equal(ATTESTABILITY.fundingRateHourly.attestable, false);
  assert.equal(ATTESTABILITY.marginTiers.attestable, false);
});

test('every quantity the HTTP adapter can feed the engine appears in the register', () => {
  // Fails CLOSED: a new field added to hyperliquid.js and forgotten here shows up as an omission,
  // not as a silent pass. These are the keys `enrichPerpInputs` / `enrichPortfolioLegs` write.
  const ENGINE_INPUTS = ['markPrice', 'maxLeverage', 'marginTiers', 'maintMarginRate', 'fundingRateHourly'];
  for (const k of ENGINE_INPUTS) {
    assert.ok(ATTESTABILITY[k], `${k} reaches the engine from hyperliquid.js but is not in ATTESTABILITY`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   PART 2 — LIVE AGREEMENT ACROSS THE WHOLE UNIVERSE.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

// Shared across the live tests so the universe is read once.
let LIVE = null;
async function live() {
  if (LIVE) return LIVE;
  const { universe } = await httpUniverse();
  const names = universe.map((u) => u.name);
  const { meta, misaligned } = await readPerpUniverse({ names });

  // pc0 → HTTP → pc1. The HTTP snapshot is fetched BETWEEN the two consensus reads; a claim fetched
  // before pc0 is older than both and no allowance can legitimately bracket it.
  const a = await readConsensusMarks({ meta });
  await sleep(GAP_MS);
  const http = await httpUniverse();
  await sleep(GAP_MS);
  const b = await readConsensusMarks({ meta });

  const obs = [];
  for (const [i, m] of meta) {
    const p0 = a.marks.get(i), p1 = b.marks.get(i);
    const claimed = Number(http.ctxs[i].markPx);
    if (!(p0 > 0 && p1 > 0 && claimed > 0)) continue;
    const lo = Math.min(p0, p1), hi = Math.max(p0, p1), ref = (p0 + p1) / 2;
    obs.push({
      coin: m.coin, perpIndex: i, tick: m.tick,
      httpMaxLev: Number(universe[i].maxLeverage), chainMaxLev: m.maxLeverage,
      ...compareToBracket({ quantity: 'markPrice', claimed, lo, hi, ref, tick: m.tick, bound: BOUND }),
    });
  }
  LIVE = { names, meta, misaligned, obs, universe, http, windowMs: b.at - a.at };
  return LIVE;
}

test('index alignment: the on-chain coin name confirms every HTTP index', async () => {
  // The check that makes every other number mean what it says. The perpIndex comes from the HTTP
  // universe — the very source under test — so it is an untrusted hint until the chain confirms it.
  // A divergence computed across two different assets would look like agreement.
  const { names, meta, misaligned } = await live();
  assert.deepEqual(misaligned, [], `on-chain coin names must confirm the HTTP ordering; mismatched: ${JSON.stringify(misaligned)}`);
  assert.equal(meta.size, names.length, `all ${names.length} perps must be confirmed on chain`);
  console.log(`      index alignment: ${meta.size}/${names.length} confirmed on chain`);
});

test('maxLeverage agrees EXACTLY across the whole universe', async () => {
  // An integer. There is no tolerance and none is offered.
  const { obs } = await live();
  const bad = obs.filter((o) => o.httpMaxLev !== o.chainMaxLev).map((o) => `${o.coin} http=${o.httpMaxLev} chain=${o.chainMaxLev}`);
  assert.deepEqual(bad, [], `maxLeverage must match exactly; disagreements: ${bad.join(', ')}`);
  console.log(`      maxLeverage: ${obs.length}/${obs.length} agree exactly`);
});

test('every honest mark is inside the bound, and the bound is not generous', async () => {
  const { obs, windowMs } = await live();
  assert.ok(obs.length > 200, `expected the full universe, measured ${obs.length}`);

  const bad = obs.filter((o) => o.verdict !== VERDICT.AGREE);
  const worst = obs.reduce((m, o) => (o.usedFraction > m.usedFraction ? o : m));
  const zero = obs.filter((o) => o.outsideBracket === 0).length;

  console.log(`      ${obs.length} assets, bracket window ${windowMs} ms`);
  console.log(`      inside the raw consensus bracket with no allowance at all: ${zero} (${(100 * zero / obs.length).toFixed(1)}%)`);
  console.log(`      worst honest case: ${worst.coin} used ${(100 * worst.usedFraction).toFixed(1)}% of the bound ` +
              `(${worst.outsideBracketRel.toExponential(3)} rel, ${worst.outsideBracketTicks.toFixed(2)} ticks)`);

  assert.deepEqual(bad.map((o) => `${o.coin} ${o.outsideBracketRel.toExponential(3)}`), [],
    'every honest observation must fall inside the bound');

  // The other half of "is this bound evidence": it must not be so wide that nothing could fail it.
  // If the worst of 232 live assets uses under 1% of the allowance, the allowance is decoration.
  assert.ok(worst.usedFraction > 0.01,
    `worst honest case used only ${(100 * worst.usedFraction).toFixed(2)}% of the bound — that is a generous bound, not evidence`);
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   PART 3 — THE FAILING HALF, LIVE. Real consensus reads, fabricated claims.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

test('a fabricated live mark is refused', async () => {
  const { hints } = await fetchPerpIndexHints();
  const r = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: hints.get('BTC'), bound: BOUND, gapMs: GAP_MS,
    // read the real consensus price, then hand the attestor a lie built from it
    fetchClaimed: async () => {
      const c = await readConsensusPerp({ symbol: 'BTC', perpIndexHint: hints.get('BTC') });
      return { markPrice: c.markPx * 1.005 };
    },
  });
  assert.equal(r.ok, false, 'a +0.5% fabrication must not attest');
  const mk = r.checks.find((c) => c.quantity === 'markPrice');
  assert.equal(mk.verdict, VERDICT.DISAGREE);
  console.log(`      +0.5% fabrication used ${mk.usedFraction.toFixed(1)}x the bound -> REFUSED`);
});

test('a live value only marginally past the bound is also refused', async () => {
  // The one that separates a real bound from a round number someone liked. The overshoot is
  // computed from the LIVE bracket, so this is the tightest lie the gate must still reject.
  const { hints } = await fetchPerpIndexHints();
  const i = hints.get('BTC');
  let allowance = null;
  const r = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: i, bound: BOUND, gapMs: GAP_MS,
    fetchClaimed: async () => {
      const c = await readConsensusPerp({ symbol: 'BTC', perpIndexHint: i });
      allowance = BOUND.rel * c.markPx + BOUND.ticks * c.tick;
      return { markPrice: c.markPx + allowance * 1.05 };   // 5% past, nothing more
    },
  });
  const mk = r.checks.find((c) => c.quantity === 'markPrice');
  assert.equal(r.ok, false, 'a value just past the bound must not attest');
  assert.equal(mk.verdict, VERDICT.DISAGREE);
  console.log(`      +${allowance.toFixed(2)} (1.05x the allowance) -> REFUSED at ${mk.usedFraction.toFixed(2)}x`);
});

test('a tampered maxLeverage is refused with no tolerance at all', async () => {
  const { hints, universe } = await fetchPerpIndexHints();
  const i = hints.get('BTC');
  const real = Number(universe[i].maxLeverage);
  for (const fake of [real + 1, real - 1, 50, 3]) {
    const r = await attestPerpInputs({
      symbol: 'BTC', perpIndexHint: i, bound: BOUND, bracket: false,
      claimed: { maxLeverage: fake }, claimedAt: Date.now(),
    });
    assert.equal(r.ok, false, `maxLeverage ${fake} against a real ${real} must be refused`);
    assert.equal(r.checks.find((c) => c.quantity === 'maxLeverage').verdict, VERDICT.DISAGREE);
  }
  // and the true value passes, so the check is not simply always-red
  const good = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: i, bound: BOUND, bracket: false,
    claimed: { maxLeverage: real }, claimedAt: Date.now(),
  });
  assert.equal(good.checks.find((c) => c.quantity === 'maxLeverage').verdict, VERDICT.AGREE);
});

test('a misaligned perpIndex is REFUSED, not reported as a divergence', async () => {
  // Feeding BTC's price the index of some other asset must not produce a number. It must produce a
  // refusal — a divergence measured across two different assets is worse than no divergence.
  const { hints } = await fetchPerpIndexHints();
  const wrong = hints.get('ETH');
  const r = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: wrong, bound: BOUND, bracket: false,
    claimed: { markPrice: 63000 }, claimedAt: Date.now(),
  });
  assert.equal(r.verdict, VERDICT.UNAVAILABLE);
  assert.equal(r.ok, false);
  assert.match(r.error, /index alignment/);
  assert.deepEqual(r.checks, [], 'a refused read must not emit checks that look like measurements');
});

test('an unreachable RPC is UNAVAILABLE, never a pass', async () => {
  // Absence-as-success is the defect this codebase keeps catching. A gate that goes green when it
  // could not read anything is worse than no gate.
  const { hints } = await fetchPerpIndexHints();
  const r = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: hints.get('BTC'), bound: BOUND, bracket: false,
    claimed: { markPrice: 63000 }, claimedAt: Date.now(),
    rpcs: ['http://127.0.0.1:9'], timeoutMs: 1500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, VERDICT.UNAVAILABLE);
  assert.equal(r.fullyCovered, false);
});

test('funding is reported UNATTESTABLE, never attested and never silently dropped', async () => {
  const { hints, universe, ctxs } = await fetchPerpIndexHints();
  const i = hints.get('BTC');
  const r = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: i, bound: BOUND, bracket: false, claimedAt: Date.now(),
    claimed: { markPrice: undefined, maxLeverage: Number(universe[i].maxLeverage), fundingRateHourly: Number(ctxs[i].funding) },
  });
  const f = r.unattestable.find((u) => u.quantity === 'fundingRateHourly');
  assert.ok(f, 'funding must appear in the unattestable list, not vanish');
  assert.equal(f.verdict, VERDICT.UNATTESTABLE);
  assert.equal(r.fullyCovered, false, 'a run carrying an unattestable quantity is never fully covered');
  assert.ok(!r.checks.some((c) => c.quantity === 'fundingRateHourly'), 'funding must never appear as a check');
});

test('an unknown quantity fails closed', async () => {
  const { hints } = await fetchPerpIndexHints();
  const r = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: hints.get('BTC'), bound: BOUND, bracket: false, claimedAt: Date.now(),
    claimed: { markPrice: undefined, someNewFieldNobodyRegistered: 1.23 },
  });
  const u = r.unattestable.find((x) => x.quantity === 'someNewFieldNobodyRegistered');
  assert.ok(u, 'an unregistered quantity must be refused, not ignored');
  assert.equal(r.fullyCovered, false);
});

test('a claim of unknown age is not called a bracket', async () => {
  // The adapter documents the HTTP value as sitting BETWEEN two consensus reads. When the caller
  // pre-fetched it and cannot say when, that is unknown — and unknown is reported as unknown rather
  // than assumed. A bracket asserted over a claim of unknown age is a guarantee with a hole in it.
  const { hints } = await fetchPerpIndexHints();
  const i = hints.get('BTC');
  const stale = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: i, bound: BOUND, gapMs: GAP_MS,
    claimed: { maxLeverage: 40 },     // fetched who-knows-when, no timestamp offered
  });
  assert.equal(stale.claimWindow.straddled, null, 'an untimed claim must report straddled = null, not true');
  assert.equal(stale.bracketValid, false, 'and the result must not present itself as a valid bracket');

  // A claim fetched BEFORE the bracket opened is older than both reads: detected, not assumed away.
  const before = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: i, bound: BOUND, gapMs: GAP_MS,
    claimed: { maxLeverage: 40 }, claimedAt: Date.now() - 60_000,
  });
  assert.equal(before.claimWindow.straddled, false);
  assert.equal(before.bracketValid, false);

  // And the honest arrangement — the adapter fetching the claim itself, inside the window — is valid.
  const good = await attestPerpInputs({
    symbol: 'BTC', perpIndexHint: i, bound: BOUND, gapMs: GAP_MS,
    fetchClaimed: async () => ({ maxLeverage: 40 }),
  });
  assert.equal(good.claimWindow.straddled, true);
  assert.equal(good.bracketValid, true);
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   PART 4 — THE CLAIM THAT MAKES ANY OF THIS AN ATTESTATION RATHER THAN A SECOND OPINION.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

test('a CONTRACT can read the mark price, and it costs what we say it costs', async () => {
  // Off chain, both reads are unsigned HTTPS and one network adversary sees both. The mechanism only
  // becomes an attestation when the comparison runs on HyperEVM, where the precompile value comes
  // from consensus. So: plant bytecode that STATICCALLs the precompile and require byte-identical
  // output. `eth_call` with a state override — a simulation. Nothing is deployed and no transaction
  // is sent.
  // All three public RPCs were verified to support state overrides, so a failure on one is a rate
  // limit rather than a missing capability — rotate and back off. Without this the test failed with
  // a bare `undefined` after the universe sweep above had exhausted the primary RPC's budget, which
  // is an undiagnosable red and would have been read as the mechanism not working.
  const RPCS = ['https://rpc.hyperliquid.xyz/evm', 'https://rpc.purroofgroup.com', 'https://rpc.hypurrscan.io'];
  const CALLER = '0x000000000000000000000000000000000000dEaD';
  const seq = '60206020602060006108065afa50';        // 5 PUSHes, GAS, STATICCALL 0x806, POP
  const code = (n) => '0x' + seq.repeat(n) + '60206020f3';
  const at = (n) => '0x' + ('AA' + String(n).padStart(2, '0')).padStart(40, '0');
  let turn = 0;
  const rpc = async (method, params) => {
    let last = null;
    for (let t = 0; t < 8; t++) {
      const url = RPCS[turn++ % RPCS.length];
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25000),
        });
        const j = await r.json();
        if (j.result) return j;
        last = JSON.stringify(j.error);
      } catch (e) { last = String(e.message); }
      await sleep(300 * (t + 1));
    }
    throw new Error(`${method} failed on all RPCs: ${String(last).slice(0, 140)}`);
  };

  const direct = await ethCall(PRECOMPILES.markPx, '0x' + '0'.repeat(64));
  const viaContract = await rpc('eth_call', [{ from: CALLER, to: at(1), data: '0x', gas: '0x200000' }, 'latest', { [at(1)]: { code: code(1) } }]);
  assert.equal(viaContract.result, direct,
    'bytecode STATICCALLing the precompile must return byte-identical output to the direct read');

  // Marginal cost of ONE more precompile read, by differencing N against N-1. Differencing a single
  // call against a hand-written no-op instead measures the no-op's opcodes as well; this holds every
  // baseline and memory-expansion effect constant.
  const g = [];
  for (const n of [1, 2, 3]) {
    const j = await rpc('eth_estimateGas', [{ from: CALLER, to: at(n), data: '0x', gas: '0x400000' }, 'latest', { [at(n)]: { code: code(n) } }]);
    g.push(Number(BigInt(j.result)));
  }
  const m1 = g[1] - g[0], m2 = g[2] - g[1];
  assert.ok(Math.abs(m1 - m2) <= 2, `the marginal cost must be linear in N; got ${m1} then ${m2}`);
  const staticcall = m2 - 19;   // less the 5 PUSHes (15) + GAS (2) + POP (2) around it
  console.log(`      contract read verified byte-identical; ${m2} gas per additional read ` +
              `(${staticcall} for the STATICCALL itself), linear in N, no cold-access surcharge`);
  assert.ok(staticcall > 2500 && staticcall < 4000,
    `precompile read measured at ${staticcall} gas — outside the range this gate was calibrated against`);
});
