// GATE D3 — is the dYdX input actually attested, and can this gate still say no?
//
// Quiver's dYdX adapter (`src/adapters/dydx.js`) reads https://indexer.dydx.trade over plain HTTPS.
// That response carries no signature of any kind, so every risk number computed from it inherits the
// indexer's word. `src/adapters/dydx-attest.js` re-derives the same quantities out of dYdX's own
// committed state and this gate is the thing that keeps it honest.
//
// The half that passes: real markets agree with the chain, inside a bound taken from measurement.
// The half that can fail, and which is the actual point:
//   * a fabricated value must be REFUSED,
//   * a value only MARGINALLY past the bound must also be REFUSED (off-by-epsilon is where a
//     comparison silently becomes decorative),
//   * a value marginally INSIDE the bound must still be ATTESTED, so "refuse everything" cannot pass,
//   * a quantity with no proof path must be REFUSED rather than guessed at,
//   * the signature checker must reject tampered sign bytes,
//   * and on the funding path: a PERTURBED premium sample, a DROPPED premium sample, a proof lifted
//     from ANOTHER HEIGHT, and an ABSENT key must each be refused.
//
//   node --test gates/gateD3-dydx-input-attestation.mjs        (npm run gate:d3)
//
// ============================================================================================
// WHERE THE BOUNDS COME FROM. Measured 2026-07-28, not chosen.
// ============================================================================================
// 2,958 market-observations (296 dYdX markets x 10 rounds, three separate sweeps, ~15 min window),
// each comparing the live indexer against a signature-verified proof at the anchored height:
//
//   maintenanceMarginRate / initialMarginRate / maxLeverage
//       divergence was EXACTLY ZERO in 2958 of 2958 observations. Both sides are exact decimals
//       derived from the same integer ppm fields, so there is no honest source of drift at all.
//       BOUND_STATIC is therefore 1e-12 — a float-representation guard, nothing more. Worst honest
//       case uses 0.0% of it, and a lie of any size above 1e-12 relative is caught.
//
//   oraclePrice
//       99.04% of observations were EXACTLY zero. The divergence is not continuous drift: dYdX
//       posts oracle updates in discrete steps, so a market either has not moved since the anchored
//       height (exact match) or has taken one update step inside the ~5s gap between the anchored
//       block and the indexer read. Worst of 2958: 3.121e-3 (AVAX-USD). p99.9 was 1.118e-3.
//       BOUND_ORACLE is 1e-2, ~3.2x the worst observed, so ordinary steps do not false-refuse.
//       Worst honest case uses 31.2% of the bound.
//
// THE COST OF THAT BOUND, STATED PLAINLY: an indexer misreporting a price by less than 1% is NOT
// caught by this gate. That slack is bought by the timing gap and cannot be closed by tightening the
// number — only by shrinking the gap. The static quantities have no such slack, and that asymmetry
// is the honest summary of what dYdX input attestation is worth today.
//
// The sample is one ~15-minute window on one day, in a calm market. A volatile regime would widen the
// oracle tail and this bound would need re-deriving; it is a measurement, not a constant of nature.
//
// ============================================================================================
// FUNDING. Added 2026-07-28. What changed and what the numbers are.
// ============================================================================================
// `fundingHourly` used to be an unconditional REFUSAL here, on the grounds that dYdX does not store a
// funding rate. It does not — and that was never the obstacle. Every INPUT is a store key carrying an
// ICS-23 existence proof, and the aggregation is deterministic integer arithmetic, so the rate is
// recomputable from proven state. Two quantities are now attested, and they are NOT the same claim:
//
//   fundingTickHourly  — the REALIZED rate, recomputed by transcribing MaybeProcessNewFundingTickEpoch
//       against an anchor pinned at effectiveAtHeight-1 and compared to the rate the venue actually
//       published for that hour. INTEGER-EXACT, no bound at all. Measured through this adapter:
//       72 of 72 market-ticks across 24 markets and 3 tick heights, on archive anchors carrying
//       85.01% / 90.93% / 95.01% of verified voting power and corroborated by 2 providers.
//       30 of those 72 are markets whose whole rate is the default-funding term, and 15 are markets
//       whose whole rate is the premium term, so both branches are covered rather than one.
//
//   fundingHourly      — the PREDICTED rate over the partial epoch, which is what the indexer
//       publishes as nextFundingRate and the ONLY funding number perp-gate consumes. Measured over
//       280 market-observations in 5 rounds, all at num_premiums 50-53:
//         * 200 unsampled markets (no premium samples this epoch; the rate is purely the
//           default-funding term): divergence EXACTLY ZERO, 200 of 200. BOUND_FUNDING_EXACT is 1e-12.
//         * 80 sampled markets: bimodal. 22 exact to float noise (worst 4.0e-14) and the rest at a
//           full one-sample step, worst 2.51e-2 relative / 18.74 ppm absolute. The step hits ALL
//           sampled markets in a round simultaneously or none of them, which is the signature of a
//           num_premiums clock difference between the anchored block and the indexer's snapshot, not
//           of a per-market disagreement. BOUND_FUNDING_SAMPLED is 6e-2, ~2.4x the worst observed.
//
// AND THAT CALIBRATION WAS NOT ENOUGH — the first run of the new test went red and was right to.
// All 280 observations sat late in an epoch. Run at num_premiums = 1 the gate failed immediately on
// an UNSAMPLED market at relative divergence exactly 1: the indexer's snapshot and the anchored block
// are at different heights (measured: the indexer's /v4/height ran 3-9 blocks ahead of the anchor),
// and one sample round of difference moves `sum / num_premiums` by at most one sample's worth. The
// ABSOLUTE effect therefore scales as 1/num_premiums and the RELATIVE effect is unbounded — it
// reaches 1 the moment a market crosses from zero samples to one. A relative bound fitted late in an
// epoch is nine minutes of every hour away from being nonsense.
//
// So the assertion that always runs is a bound DERIVED from proven state rather than fitted:
//       |proven - claimed| ppm  <=  SKEW_ROUNDS x (largest premium sample here + |rate|) / num_premiums
// Every term is read out of the proof, it tightens as an epoch fills, and it is valid at
// num_premiums = 1. The two relative bounds above are still asserted, but only in the regime they
// were measured in (num_premiums >= half an epoch), and the gate prints why when it withholds them.
//
// THE COST OF ALL THIS, STATED PLAINLY: the live predicted rate cannot be pinned tightly against the
// indexer at all, because the two sides are computed at heights that cannot be aligned. It is here so
// the field is not silently omitted and so a gross fabrication is still refused; it is not a lie
// detector. The lie detector on this path is fundingTickHourly, which is exact and needs no bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openAnchor, proveMarket, attest, fetchIndexerMarkets,
  verifyCommitSignatures, voteSignBytes, TRUST, ATTESTABLE, NOT_ATTESTABLE, MIN_CORROBORATORS,
  proveKey, proveKeyAny, proveFundingContext, proveFunding,
  fundingTickPpm, nextFundingPpm, decodePremiumStore,
  fetchHistoricalFunding, DYDX_ARCHIVE_RPCS, FUNDING_PPM_PER_HOURLY, FUNDING_CAVEATS,
} from '../src/adapters/dydx-attest.js';

const BOUND_ORACLE = 1e-2;
const BOUND_STATIC = 1e-12;
const BOUND_FUNDING_EXACT = 1e-12;        // unsampled markets, LATE in an epoch: measured zero, 200/200
const BOUND_FUNDING_SAMPLED = 6e-2;       // sampled markets, LATE in an epoch: worst observed 2.51e-2
// How many 60-second sample rounds the indexer's snapshot may sit away from the anchored block. The
// measured offset is 3-9 blocks (~4-12 s), well inside one round; 2 is that with headroom, and it is
// the only fitted number in the derived bound.
const SKEW_ROUNDS = 2;
const WORST_OBSERVED_ORACLE = 3.121e-3;   // measured, see header
const WORST_OBSERVED_FUNDING_SAMPLED = 2.51e-2;
const MARKETS_SAMPLED = Number(process.env.GATE_D3_MARKETS || 40);
const TICK_HEIGHTS = Number(process.env.GATE_D3_TICK_HEIGHTS || 2);
// A deliberate mix: the first six carry premium samples, the last six have default_funding_ppm = 100
// and no samples at all. A funding check run only on the first group never exercises the term that
// decides 182 of dYdX's 296 markets; run only on the second, it never exercises the premium average.
const TICK_TICKERS = (process.env.GATE_D3_TICK_TICKERS
  || 'BTC-USD,ETH-USD,SOL-USD,XRP-USD,LINK-USD,DOGE-USD,GOAT-USD,MOG-USD,IO-USD,KAS-USD,AR-USD,TAIKO-USD').split(',');

// One anchor and one indexer snapshot shared by every test: re-anchoring per test would compare
// against different heights and manufacture divergence that is not real.
let anchor, indexer, sample, fundingCtx;

test('open a signature-verified anchor on dYdX mainnet', async () => {
  anchor = await openAnchor();
  indexer = await fetchIndexerMarkets();

  assert.equal(anchor.chainId, 'dydx-mainnet-1');
  assert.ok(anchor.corroborators >= MIN_CORROBORATORS,
    `need >=${MIN_CORROBORATORS} independent providers, got ${anchor.corroborators}`);

  // The signature step is the whole difference between "the RPC says so" and "the validators signed
  // it". If it ever silently stops happening, this gate must go red rather than quietly downgrade.
  assert.ok(anchor.signatures, 'anchor must carry a signature result');
  assert.equal(anchor.signatures.failed, 0, 'a present-but-invalid precommit is never acceptable');
  assert.ok(anchor.signatures.verified > 0, 'at least one precommit must actually verify');
  assert.ok(anchor.signatures.twoThirds,
    `verified voting power ${(anchor.signatures.powerFraction * 100).toFixed(2)}% must exceed 2/3`);
  assert.equal(anchor.signaturesVerified, true);
  assert.equal(anchor.trust, TRUST.SIGNED);

  // ...and the label must not overstate. TRUST.CHECKPOINTED used to be unreachable, and this
  // assertion used to say it must NEVER be returned. It IS reachable now — `openAnchor({checkpoint:
  // true})` pins the app_hash to a value another chain's validators independently committed to — so
  // "never" would now be asserting the feature does not work. The correct claim is EXACTLY WHEN:
  // returned if and only if that external pin was obtained, corroborated and matched.
  //
  // This half is the "never otherwise": THIS anchor asked for no checkpoint, so it must not carry the
  // label, and it must not carry the evidence either — a label without evidence is the failure mode.
  assert.notEqual(anchor.trust, TRUST.CHECKPOINTED,
    'an anchor opened WITHOUT a checkpoint must never claim the checkpointed label');
  assert.equal(anchor.checkpoint, null,
    'no checkpoint was requested, so no checkpoint evidence may be attached');

  // The other half — that the label IS returned when it is earned, plus the full battery of negatives
  // (wrong height, fabricated app_hash, expired checkpoint, single counterparty provider) — lives in
  // gates/gateD3c-dydx-checkpoint.mjs, `npm run gate:d3c`. It is a sibling rather than more tests here
  // because a checkpointed anchor is pinned MINUTES behind the tip, and every bound calibrated in this
  // file assumes a ~5-second tip gap. Mixing the two would silently re-calibrate this gate.
  assert.equal(typeof TRUST.CHECKPOINTED, 'string');

  const markets = Object.entries(indexer).filter(([, m]) => m.clobPairId !== undefined && Number(m.oraclePrice) > 0);
  assert.ok(markets.length > 50, `expected a broad market list, got ${markets.length}`);
  const stride = Math.max(1, Math.floor(markets.length / MARKETS_SAMPLED));
  sample = markets.filter((_, i) => i % stride === 0).slice(0, MARKETS_SAMPLED);

  // The four market-independent funding inputs, proven once and shared. Every one must verify; this
  // throwing is itself a refusal, and there is no path that proceeds without them.
  fundingCtx = await proveFundingContext(anchor);
  assert.equal(fundingCtx.appHash, anchor.appHash, 'funding inputs must be bound to the anchored app_hash');
  assert.ok(fundingCtx.tickEpoch.duration > 0 && fundingCtx.sampleEpoch.duration > 0,
    'epoch durations must be READ FROM STATE, not assumed');
  assert.ok(fundingCtx.params.fundingRateClampFactorPpm > 0, 'the clamp factor must come from proven module params');
  console.log(`      funding: num_premiums ${fundingCtx.premiumStore.numPremiums}, ${fundingCtx.premiumStore.markets.length} markets with entries, tick ${fundingCtx.tickEpoch.duration}s / sample ${fundingCtx.sampleEpoch.duration}s, ${fundingCtx.proofBytes} B of proof over ${fundingCtx.valueBytes} B of value`);
});

// Is this exception somebody else's server, or is it our attestation being wrong?
//
// THE DIRECTION OF THE DEFAULT IS THE WHOLE DESIGN. An allowlist of things that are definitely
// transport, and EVERYTHING ELSE COUNTS AS A REAL FAILURE. Written the other way round, as a list of
// strings that mean "broken", the first unanticipated error message would be silently excused and the
// gate would go quiet exactly when something new went wrong. An unrecognised error is not evidence of
// innocence.
//
// The names below are matched only against transport-layer text. Nothing here can match a proof that
// verifies against the wrong root, a value outside its bound, or a signature that does not check:
// those carry our own vocabulary and fall through to `failures`.
const UNAVAILABLE = [
  /fetch failed/i,                       // undici, the usual shape of a dead or refused connection
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED)\b/,
  /\b(408|429|500|502|503|504)\b/,       // busy, rate-limited, or restarting: not a wrong answer
  /timed? ?out/i,
  /socket hang up/i,
  /operation was aborted|AbortError/i,
  /network|terminated|other side closed/i,
  /(height|block).{0,30}(not available|is not available|pruned|too (old|low))/i,
  /no (archive|rpc|endpoint).{0,20}(available|responded|reachable)/i,
];
const isUnavailable = (e) => {
  const text = `${e?.name || ''} ${e?.message || ''} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`;
  return UNAVAILABLE.some((rx) => rx.test(text));
};

// The classifier is itself a claim, so it is tested rather than trusted. Both directions: a transport
// error must be forgiven AND a verification error must not be. Half of this test is the half that
// matters — without the second group, a classifier that returned `true` for everything would pass.
test('the availability classifier can still call a real failure a failure', () => {
  const transport = [
    Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    new Error('request to https://archive.example failed, reason: socket hang up'),
    new Error('HTTP 503 Service Unavailable'),
    new Error('height 12345678 is not available, lowest height is 20000000'),
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
  ];
  const real = [
    new Error('ICS-23 proof does not verify against the anchored app_hash'),
    new Error('root mismatch: computed 0xdead… expected 0xbeef…'),
    new Error('DIVERGENCE_EXCEEDS_BOUND'),
    new Error('precommit signature failed to verify'),
    new Error('perpetual 42 absent from the proven store'),
    new Error('something nobody anticipated'),   // the default, and it must land on the strict side
  ];
  for (const e of transport) assert.equal(isUnavailable(e), true, `should be forgiven: ${e.message}`);
  for (const e of real) assert.equal(isUnavailable(e), false, `MUST NOT be forgiven: ${e.message}`);
});

test('the indexer agrees with signed chain state across many markets', async () => {
  const results = [];
  const failures = [];
  const unavailable = [];
  let i = 0;
  const worker = async () => {
    while (i < sample.length) {
      const [ticker, m] = sample[i++];
      try {
        const market = await proveMarket(anchor, { ticker, perpetualId: Number(m.clobPairId) });
        for (const [q, claimed, bound] of [
          ['oraclePrice', Number(m.oraclePrice), BOUND_ORACLE],
          ['maintenanceMarginRate', Number(m.maintenanceMarginFraction), BOUND_STATIC],
          ['initialMarginRate', Number(m.initialMarginFraction), BOUND_STATIC],
        ]) {
          const r = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: q, claimed, bound, anchor, market });
          if (!r.ok) failures.push(`${ticker}/${q}: ${r.reason} rel=${r.relDiff} claimed=${claimed} proven=${r.proven}`);
          else results.push({ ticker, q, rel: r.relDiff, used: r.boundUsedPct });
        }
      } catch (e) {
        // WHY THIS IS NOT JUST `failures.push`. This gate read 15/1 then 10/6 on consecutive runs and
        // then 0/0/0 three times over, with no code change in between. It reads live dYdX archives
        // whose depth and availability vary by the minute, and only one of the two archive-serving
        // operators is deep enough for the historical path. So a red here could mean "the attestation
        // is broken" OR "somebody else's server was busy", and a check with two meanings is not
        // evidence. Same split the eth_getProof work makes between rate-limit HTML and a real
        // verification failure, and the same one gate-clone-portability makes between a missing npm
        // package and a broken path.
        (isUnavailable(e) ? unavailable : failures).push(`${ticker}: ${isUnavailable(e) ? 'ARCHIVE' : 'PROOF'} ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));

  assert.deepEqual(failures, [], `every honest market must attest; got ${failures.length} failure(s):\n  ${failures.slice(0, 8).join('\n  ')}`);

  // AND NOW THE PART THAT KEEPS THE SPLIT FROM BECOMING AN EXCUSE. Forgiving unreachable archives is
  // how a gate stops being able to fail: if every market were unreachable, `failures` would be empty
  // and this test would report success having proven nothing. So the coverage floor is the real
  // assertion, and it is stated in its own terms rather than left to be inferred from a count.
  const attempted = sample.length * 3;
  assert.ok(results.length >= attempted * 0.9,
    `NOT ENOUGH COVERAGE TO CONCLUDE ANYTHING: ${results.length} of ~${attempted} attestations completed.\n`
    + `  ${unavailable.length} market(s) were unreachable, which is tolerated individually but not in bulk.\n`
    + `  This is a REFUSAL TO REPORT A VERDICT, not a claim that attestation is broken.\n`
    + `  ${unavailable.slice(0, 5).join('\n  ')}`);

  if (unavailable.length) {
    console.log(`  note: ${unavailable.length} market(s) unreachable this run (archive depth varies); `
      + `${results.length}/${attempted} attestations still completed, above the ${Math.ceil(attempted * 0.9)} floor.`);
  }

  const oracle = results.filter((r) => r.q === 'oraclePrice');
  const statics = results.filter((r) => r.q !== 'oraclePrice');

  // The static quantities are the strong claim: exact, every time. If drift ever appears here it is
  // a real disagreement between the indexer and the chain, not a timing artefact.
  const worstStatic = Math.max(...statics.map((r) => r.rel));
  assert.equal(worstStatic, 0,
    `margin parameters must match the chain EXACTLY; worst relative divergence was ${worstStatic}`);

  // How much of the bound the worst honest case actually uses — the number that says whether the
  // bound is calibrated or merely generous.
  const worstOracle = Math.max(...oracle.map((r) => r.rel));
  const usedPct = (worstOracle / BOUND_ORACLE) * 100;
  console.log(`      oracle: ${oracle.length} markets, worst divergence ${worstOracle.toExponential(3)} = ${usedPct.toFixed(1)}% of the ${BOUND_ORACLE} bound`);
  console.log(`      static: ${statics.length} observations, worst divergence ${worstStatic} (exact)`);
  console.log(`      anchor: height ${anchor.height}, ${anchor.signatures.verified}/${anchor.validatorCount} precommits, ${(anchor.signatures.powerFraction * 100).toFixed(2)}% power, ${anchor.corroborators} providers`);

  // A bound that the honest worst case fills is a bound about to start false-refusing; one the honest
  // case barely touches is not measuring anything. Both directions are asserted.
  assert.ok(worstOracle <= BOUND_ORACLE, `worst honest divergence ${worstOracle} exceeded the bound ${BOUND_ORACLE}`);
  assert.ok(worstOracle < BOUND_ORACLE * 0.75,
    `honest worst case used ${usedPct.toFixed(1)}% of the bound — too close to the edge, re-derive it`);
});

// ---------------------------------------------------------------- the half that must be able to fail

test('a fabricated oracle price is REFUSED', async () => {
  const [ticker, m] = sample[0];
  const market = await proveMarket(anchor, { ticker, perpetualId: Number(m.clobPairId) });
  const real = market.proven.oraclePrice;

  for (const [label, fake] of [['+50%', real * 1.5], ['-50%', real * 0.5], ['zero', 0], ['1e9', 1e9]]) {
    const r = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'oraclePrice', claimed: fake, bound: BOUND_ORACLE, anchor, market });
    assert.equal(r.ok, false, `a fabricated price (${label}) must not attest`);
    assert.equal(r.status, 'REFUSED');
    assert.equal(r.reason, 'DIVERGENCE_EXCEEDS_BOUND');
  }
});

test('a value only MARGINALLY past the bound is REFUSED, and marginally inside is ATTESTED', async () => {
  // This is the test that catches a comparison which has quietly stopped comparing. A gate that only
  // ever sees 50%-wrong values would pass with `<=` replaced by anything at all.
  const [ticker, m] = sample[1];
  const market = await proveMarket(anchor, { ticker, perpetualId: Number(m.clobPairId) });
  const P = market.proven.oraclePrice;

  // relDiff(C,P) = (C-P)/C for C>P, so C = P/(1-d) lands exactly at relative difference d.
  const at = (d) => P / (1 - d);

  const justOver = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'oraclePrice', claimed: at(BOUND_ORACLE * 1.001), bound: BOUND_ORACLE, anchor, market });
  // Assert the construction landed where intended before trusting the verdict — otherwise this test
  // could pass by building a value that was never actually past the bound.
  assert.ok(justOver.relDiff > BOUND_ORACLE, `construction error: rel ${justOver.relDiff} is not past the bound`);
  assert.ok(justOver.relDiff < BOUND_ORACLE * 1.01, `construction error: rel ${justOver.relDiff} is not MARGINAL`);
  assert.equal(justOver.ok, false, `a value ${justOver.relDiff} past a ${BOUND_ORACLE} bound must be refused`);
  assert.equal(justOver.reason, 'DIVERGENCE_EXCEEDS_BOUND');

  const justUnder = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'oraclePrice', claimed: at(BOUND_ORACLE * 0.999), bound: BOUND_ORACLE, anchor, market });
  assert.ok(justUnder.relDiff <= BOUND_ORACLE, `construction error: rel ${justUnder.relDiff} is not inside the bound`);
  assert.equal(justUnder.ok, true, `a value just inside the bound must still attest, else the gate is just refusing everything`);
  assert.equal(justUnder.status, 'ATTESTED');

  // The same knife-edge on the exact bound: <= is inclusive, and that must be deliberate.
  const exact = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'oraclePrice', claimed: P, bound: 0 || BOUND_STATIC, anchor, market });
  assert.equal(exact.ok, true, 'an exactly-equal value attests even under the tightest bound');
});

test('a margin rate off by one part in a million is REFUSED', async () => {
  // The static bound is 1e-12, so this is the practical statement of "any lie is caught". A 1e-6
  // error in a maintenance margin is a real risk error, and it must not survive.
  const [ticker, m] = sample[2];
  const market = await proveMarket(anchor, { ticker, perpetualId: Number(m.clobPairId) });
  const real = market.proven.maintenanceMarginRate;

  const r = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'maintenanceMarginRate', claimed: real * (1 + 1e-6), bound: BOUND_STATIC, anchor, market });
  assert.equal(r.ok, false, `maintenance margin off by 1e-6 must be refused under a ${BOUND_STATIC} bound`);
  assert.equal(r.reason, 'DIVERGENCE_EXCEEDS_BOUND');

  const honest = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'maintenanceMarginRate', claimed: real, bound: BOUND_STATIC, anchor, market });
  assert.equal(honest.ok, true, 'the true value must still attest under the same bound');
  assert.equal(honest.relDiff, 0);
});

test('quantities with no proof path are REFUSED, never guessed', async () => {
  const [ticker, m] = sample[0];
  const market = await proveMarket(anchor, { ticker, perpetualId: Number(m.clobPairId) });

  // This test used to make its point with `fundingHourly`. It cannot any more, because fundingHourly
  // is now recomputed from proven state — and a test asserting a refusal that is no longer true would
  // be a lie in the other direction. The exemplar moves to `orderbook`, which dYdX documents as
  // in-memory per node and never written to application state, so it is unprovable in principle
  // rather than merely unimplemented. The assertion is otherwise unchanged.
  const noPath = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'orderbook', claimed: 1, bound: BOUND_ORACLE, anchor, market });
  assert.equal(noPath.ok, false);
  assert.equal(noPath.reason, 'NO_PROOF_PATH');
  assert.ok(NOT_ATTESTABLE.orderbook, 'the refusal must be backed by a stated reason');

  // And the other half of that move: fundingHourly must NOT be refused by name any more, and must not
  // be listed in both registries. A quantity that is attestable while still carrying a stated refusal
  // is how a stale "we cannot prove this" outlives the work that made it false.
  assert.equal(NOT_ATTESTABLE.fundingHourly, undefined, 'fundingHourly is attestable now; the stale refusal must be gone');
  assert.ok(ATTESTABLE.fundingHourly, 'fundingHourly must be registered with the store keys it is proven from');

  // A market proven WITHOUT a funding context must refuse funding for a reason that names its own
  // cause, rather than falling back to "unprovable".
  const noCtx = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'fundingHourly', claimed: 0.0000125, bound: BOUND_ORACLE, anchor, market });
  assert.equal(noCtx.ok, false);
  assert.equal(noCtx.reason, 'NOT_IN_PROOF');

  const unknown = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'openInterest', claimed: 1, bound: BOUND_ORACLE, anchor, market });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'UNKNOWN_QUANTITY');

  // No bound supplied is a refusal, not an invented default.
  const noBound = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'oraclePrice', claimed: 1, bound: undefined, anchor, market });
  assert.equal(noBound.ok, false);
  assert.equal(noBound.reason, 'NO_BOUND');

  const nan = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'oraclePrice', claimed: NaN, bound: BOUND_ORACLE, anchor, market });
  assert.equal(nan.ok, false);
  assert.equal(nan.reason, 'CLAIM_NOT_A_NUMBER');
});

test('a mislabelled perpetual id is REFUSED rather than silently attesting the wrong market', async () => {
  // clobPairId -> perpetualId is an assumption. If it is ever wrong, the failure mode without this
  // check is attesting BTC's price against ETH's proof, which is worse than no attestation.
  const [ticker, m] = sample[0];
  const wrongId = Number(m.clobPairId) === 1 ? 2 : 1;
  await assert.rejects(
    () => proveMarket(anchor, { ticker, perpetualId: wrongId }),
    /is ticker .* on chain, not|refusing/,
    'proving the wrong perpetual id against a ticker must throw, not return a value',
  );
});

test('the signature verifier rejects tampered sign bytes', async () => {
  // A signature checker that cannot say no is worth nothing, so the rejection path is exercised
  // directly against the real commit rather than assumed from the passing case.
  const header = anchor._header, commit = anchor._commit, validators = anchor._validators;
  assert.ok(header && commit && validators, 'anchor must retain the material needed to re-check');

  const honest = verifyCommitSignatures({ header, commit, validators });
  assert.equal(honest.failed, 0);
  assert.ok(honest.verified > 0);
  assert.equal(honest.twoThirds, true);

  const mutate = (fn) => {
    const c = JSON.parse(JSON.stringify(commit));
    const h = JSON.parse(JSON.stringify(header));
    fn(h, c);
    return verifyCommitSignatures({ header: h, commit: c, validators });
  };
  const flip = (hex, i) => { const b = Buffer.from(hex, 'hex'); b[i] ^= 1; return b.toString('hex').toUpperCase(); };

  const cases = {
    'block hash': mutate((h, c) => { c.block_id.hash = flip(c.block_id.hash, 0); }),
    'parts hash': mutate((h, c) => { c.block_id.parts.hash = flip(c.block_id.parts.hash, 3); }),
    'height': mutate((h, c) => { c.height = String(Number(c.height) + 1); }),
    'chain id': mutate((h) => { h.chain_id = 'dydx-mainnet-2'; }),
    'round': mutate((h, c) => { c.round = c.round + 1; }),
  };
  for (const [name, res] of Object.entries(cases)) {
    assert.equal(res.verified, 0, `tampered ${name} must verify ZERO signatures, got ${res.verified}`);
    assert.equal(res.twoThirds, false, `tampered ${name} must not reach the 2/3 threshold`);
    assert.equal(res.achieved, false);
  }

  // And the encoder's one subtlety, pinned: round 0 must be OMITTED, not written as an explicit zero.
  // Writing it is what made an earlier draft verify nothing at all while looking correct.
  if (Number(commit.round) === 0) {
    const bytes = voteSignBytes({ chainId: header.chain_id, height: commit.height, round: 0, blockId: commit.block_id, timestamp: commit.signatures.find((s) => s.signature).timestamp });
    assert.equal(bytes.includes(Buffer.from([0x19, 0, 0, 0, 0, 0, 0, 0, 0])), false,
      'proto3 omits a zero-valued sfixed64: an explicit zero round must never appear in the sign bytes');
  }
});

test('the registry refuses to grow silently', async () => {
  // Every attestable quantity must name the store key it is proven from. A row without a source is
  // how "attested" quietly starts meaning "we fetched it".
  for (const [q, meta] of Object.entries(ATTESTABLE)) {
    assert.ok(meta.source && /\//.test(meta.source), `${q} must name a store/key it is proven from`);
  }
  for (const [q, reason] of Object.entries(NOT_ATTESTABLE)) {
    assert.ok(typeof reason === 'string' && reason.length > 80, `${q} must carry a real stated reason, not a shrug`);
    assert.equal(ATTESTABLE[q], undefined, `${q} cannot be both attestable and not`);
  }

  // Adding funding to ATTESTABLE removed a refusal. The limits behind that refusal did not go away,
  // so they are asserted as data here: a green gate must not be readable as "funding is now proven
  // true". Each caveat is a sentence someone has to delete deliberately.
  for (const k of ['premiumProvenance', 'clampBranchUnexercised', 'voteToSampleStage', 'realizedNeedsTickHeight']) {
    assert.ok(typeof FUNDING_CAVEATS[k] === 'string' && FUNDING_CAVEATS[k].length > 120,
      `FUNDING_CAVEATS.${k} must state a real limit that survives a green run`);
  }
  assert.match(FUNDING_CAVEATS.premiumProvenance, /MemClob/,
    'the premium provenance caveat must name where the premium actually comes from');
});

// ================================================================================================
// FUNDING — the rate dYdX does not store, recomputed from the inputs it does
// ================================================================================================

test('the REALIZED funding rate recomputes integer-exactly from proven state at a historical tick', async () => {
  // The strong claim on this path, and the only one with no bound anywhere in it. The indexer
  // publishes `effectiveAtHeight`, the exact block at which each tick executed; the completed epoch's
  // samples exist at effectiveAtHeight-1, before the tick clears them. Pin an anchor there, verify
  // the signatures at THAT height, prove the inputs, run dYdX's own rule, and require the integer to
  // match the integer the venue published. Not "close" — equal.
  const ticks = new Map();
  for (const t of TICK_TICKERS) {
    let hist;
    try { hist = await fetchHistoricalFunding(t, { limit: TICK_HEIGHTS + 1 }); } catch { continue; }
    for (const h of hist) {
      const H = Number(h.effectiveAtHeight);
      if (!Number.isFinite(H)) continue;
      if (!ticks.has(H)) ticks.set(H, new Map());
      ticks.get(H).set(t, h);
    }
  }
  const heights = [...ticks.keys()].sort((a, b) => b - a).slice(0, TICK_HEIGHTS);
  assert.ok(heights.length > 0, 'the indexer must publish at least one recent funding tick to test against');

  const rows = [];
  const anchors = [];
  for (const H of heights) {
    // Archive providers only: measured, dYdX's publicnode endpoint prunes application state and
    // refuses the proof an hour back while still reporting 3M blocks of history.
    const a = await openAnchor({ rpcs: DYDX_ARCHIVE_RPCS, height: H - 1 });
    assert.equal(a.pinned, true);
    assert.equal(a.height, H - 1);
    assert.equal(a.signatures.failed, 0, `a present-but-invalid precommit at tick height ${H - 1} is never acceptable`);
    assert.ok(a.signatures.twoThirds, `verified voting power at ${H - 1} must exceed 2/3`);
    assert.equal(a.trust, TRUST.SIGNED);
    anchors.push(a);

    const ctx = await proveFundingContext(a);
    // At a completed epoch the store must show a full hour of sample rounds. If it does not, the
    // anchor is not where this test thinks it is and every match below would be luck.
    assert.equal(ctx.premiumStore.numPremiums, ctx.tickEpoch.duration / ctx.sampleEpoch.duration,
      `at effectiveAtHeight-1 the epoch must be complete: num_premiums ${ctx.premiumStore.numPremiums} != ${ctx.tickEpoch.duration}/${ctx.sampleEpoch.duration}`);

    for (const [t, rec] of ticks.get(H)) {
      const m = indexer[t];
      if (!m || !Number.isFinite(Number(m.clobPairId))) continue;
      const f = await proveFunding(a, { ticker: t, perpetualId: Number(m.clobPairId), fundingCtx: ctx });
      assert.equal(f.tickEpochComplete, true,
        `${t}@${H}: the tick rule's output is only a SETTLED rate on a complete epoch, and this anchor reports otherwise`);
      rows.push({
        H, t, recomputedPpm: f.ppm.tick, publishedPpm: Number(rec.rate) * FUNDING_PPM_PER_HOURLY,
        n: f.sampleCount, def: f.ppm.defaultFunding, clamped: f.clamped, clampBound: f.ppm.clampBound,
        proofBytes: f.proofBytes,
      });
    }
  }

  const mismatched = rows.filter((r) => r.recomputedPpm !== r.publishedPpm);
  assert.deepEqual(mismatched.map((r) => `${r.t}@${r.H}: recomputed ${r.recomputedPpm} != published ${r.publishedPpm}`), [],
    'every realized funding tick must recompute to the EXACT integer the venue published');
  assert.ok(rows.length >= 8, `expected a broad tick sample, got ${rows.length} market-ticks`);

  // Coverage of both terms, asserted rather than hoped for. A run that only sees zeros has proven
  // that padding works and nothing else; a run that only sees premium markets never exercises the
  // default-funding term that decides 182 of dYdX's 296 markets.
  const premiumDriven = rows.filter((r) => r.n > 0 && r.publishedPpm !== 0).length;
  const defaultDriven = rows.filter((r) => r.n === 0 && r.def !== 0 && r.publishedPpm === r.def).length;
  assert.ok(premiumDriven >= 2, `need ticks whose rate comes from the premium average, got ${premiumDriven}`);
  assert.ok(defaultDriven >= 2, `need ticks whose rate is the default-funding term, got ${defaultDriven}`);

  const clampBinding = rows.filter((r) => r.clamped).length;
  console.log(`      realized: ${rows.length}/${rows.length} integer-exact over ${heights.length} tick height(s), ${new Set(rows.map((r) => r.t)).size} markets, ${rows[0].proofBytes} B of proof per market-tick`);
  console.log(`      of which premium-driven ${premiumDriven}, default-funding-driven ${defaultDriven}, zero ${rows.filter((r) => r.publishedPpm === 0).length}`);
  console.log(`      anchors: ${anchors.map((a) => `${a.height}@${(a.signatures.powerFraction * 100).toFixed(2)}%/${a.corroborators}rpc`).join(' ')}`);
  console.log(`      largest |rate| recomputed: ${Math.max(...rows.map((r) => Math.abs(r.recomputedPpm)))} ppm; clamp bounds seen: ${[...new Set(rows.map((r) => r.clampBound))].join(', ')} ppm; clamp binding: ${clampBinding}`);
  if (clampBinding === 0) {
    console.log('      NOTE: the clamp did not bind on any observation — that branch is transcribed from source and exercised only synthetically.');
  }
});

test('the PREDICTED funding rate agrees with the indexer, and a fabricated one does not', async () => {
  // What perp-gate actually consumes.
  //
  // THIS TEST WAS WRONG THE FIRST TIME IT RAN, and the correction is the interesting part. It asserted
  // a fixed RELATIVE bound, calibrated over 280 observations at num_premiums 50-53: unsampled markets
  // exact 200/200, sampled markets worst 2.51e-2. Run at num_premiums = 1 it went red immediately, on
  // an unsampled market, at relative divergence exactly 1.
  //
  // The mechanism, then measured directly: the indexer's snapshot and the anchored block are at
  // DIFFERENT heights (measured: the indexer's own /v4/height ran 3-9 blocks AHEAD of the anchor,
  // which lags the tip by PROOF_LAG plus the spread across corroborating providers). One sample round
  // of difference moves `sum / num_premiums` by at most one sample's worth, so the ABSOLUTE effect
  // scales as 1/num_premiums — and the RELATIVE effect is unbounded, reaching 1 the moment a market
  // crosses from zero samples to one. A relative bound calibrated late in an epoch is nine minutes of
  // an hour away from being nonsense, which is the "bound written in the wrong units" failure again.
  //
  // So the bound below is DERIVED from proven state rather than fitted to one regime:
  //     skewPpm <= SKEW_ROUNDS x (largest premium sample at this height + |rate|) / num_premiums
  // Every term is read out of the proof. It tightens automatically as an epoch fills, it is valid at
  // num_premiums = 1, and it can still fail: a fabrication larger than one sample round is refused.
  const entries = Object.entries(indexer).filter(([, m]) => Number.isFinite(Number(m.clobPairId)));
  const sampledIds = new Set(fundingCtx.premiumStore.markets.filter((m) => m.premiums.length).map((m) => m.perpetualId));
  const pick = entries.filter(([, m], i) => sampledIds.has(Number(m.clobPairId)) || i % 9 === 0).slice(0, MARKETS_SAMPLED + 20);

  const N = fundingCtx.premiumStore.numPremiums;
  const maxSamplePpm = fundingCtx.premiumStore.markets.reduce(
    (a, m) => m.premiums.reduce((b, v) => Math.max(b, Math.abs(v)), a), 0);
  const skewBoundPpm = (ratePpm) => SKEW_ROUNDS * (maxSamplePpm + Math.abs(ratePpm)) / Math.max(1, N);

  const rows = [];
  const failures = [];
  let i = 0;
  const worker = async () => {
    while (i < pick.length) {
      const [ticker, m] = pick[i++];
      const pid = Number(m.clobPairId);
      try {
        const f = await proveFunding(anchor, { ticker, perpetualId: pid, fundingCtx });
        const claimedPpm = Number(m.nextFundingRate) * FUNDING_PPM_PER_HOURLY;
        const absPpm = Math.abs(f.ppm.next - claimedPpm);
        const bound = skewBoundPpm(f.ppm.next);
        rows.push({
          ticker, sampled: f.sampled, n: f.sampleCount, absPpm, bound, used: absPpm / bound,
          rel: f.fundingHourly === Number(m.nextFundingRate) ? 0
            : Math.abs(f.fundingHourly - Number(m.nextFundingRate)) / Math.max(Math.abs(f.fundingHourly), Math.abs(Number(m.nextFundingRate))),
          provenPpm: f.ppm.next, defPpm: f.ppm.defaultFunding, hourly: f.fundingHourly,
        });
        if (absPpm > bound) failures.push(`${ticker}${f.sampled ? ' (sampled)' : ''}: |${f.ppm.next} - ${claimedPpm}| = ${absPpm.toFixed(3)} ppm > ${bound.toFixed(3)} ppm`);
      } catch (e) { failures.push(`${ticker}: PROOF ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));

  const unsampled = rows.filter((r) => !r.sampled);
  const sampled = rows.filter((r) => r.sampled);
  assert.ok(rows.length >= 20, `expected a broad market sample, got ${rows.length}`);
  assert.ok(unsampled.length >= 10, `expected a body of unsampled markets, got ${unsampled.length}`);

  // (1) The derived bound, asserted at ANY num_premiums. This is the claim that always runs.
  assert.deepEqual(failures, [],
    `every market must agree with the indexer within one sample round of skew; got ${failures.length}:\n  ${failures.slice(0, 8).join('\n  ')}`);
  const worstUsed = Math.max(...rows.map((r) => r.used));
  assert.ok(worstUsed < 0.75,
    `honest worst case used ${(worstUsed * 100).toFixed(1)}% of the derived skew bound — the derivation is wrong or SKEW_ROUNDS is too small`);

  // (2) Self-consistency of the recomputation itself, independent of the indexer: a market with no
  // premium samples must land EXACTLY on its default-funding term. Drop that term and this goes red
  // whatever the indexer says.
  for (const r of unsampled) {
    assert.equal(r.provenPpm, r.defPpm,
      `${r.ticker} has no premium samples, so its predicted rate must be exactly default_funding_ppm ${r.defPpm}, not ${r.provenPpm}`);
  }

  // (3) The strong measured claim, in the regime it was measured in: late in an epoch the indexer and
  // the chain agree EXACTLY on markets with no samples (200/200 over 5 rounds at num_premiums 50-53).
  const halfEpoch = fundingCtx.tickEpoch.duration / fundingCtx.sampleEpoch.duration / 2;
  const worstUnsampledRel = Math.max(...unsampled.map((r) => r.rel));
  const worstSampledRel = sampled.length ? Math.max(...sampled.map((r) => r.rel)) : 0;
  console.log(`      predicted: num_premiums ${N}, largest sample ${maxSamplePpm} ppm, derived skew bound ~${skewBoundPpm(0).toFixed(2)} ppm; worst |diff| ${Math.max(...rows.map((r) => r.absPpm)).toFixed(3)} ppm = ${(worstUsed * 100).toFixed(1)}% of it`);
  console.log(`      predicted: ${unsampled.length} unsampled (worst rel ${worstUnsampledRel.toExponential(2)}), ${sampled.length} sampled (worst rel ${worstSampledRel.toExponential(2)})`);
  if (N >= halfEpoch) {
    assert.equal(worstUnsampledRel, 0,
      `late in an epoch, markets with no premium samples must match the indexer EXACTLY; worst was ${worstUnsampledRel}`);
    assert.ok(worstSampledRel < BOUND_FUNDING_SAMPLED * 0.75,
      `sampled-market worst case used ${((worstSampledRel / BOUND_FUNDING_SAMPLED) * 100).toFixed(1)}% of the ${BOUND_FUNDING_SAMPLED} relative bound — re-derive it`);
  } else {
    // Not a silent skip. The derived bound in (1) and the self-consistency in (2) both ran; what is
    // withheld is only the RELATIVE claim, and the reason is stated.
    console.log(`      NOTE: num_premiums ${N} < half an epoch (${halfEpoch}). The relative bounds (${BOUND_FUNDING_EXACT} unsampled / ${BOUND_FUNDING_SAMPLED} sampled) were calibrated at num_premiums 50-53 and do NOT transfer this early — one sample round is worth 1/${N} of the rate here, and a market crossing from zero samples to one moves relative divergence to 1. They are not asserted at this height; the derived absolute bound above is.`);
  }

  // (4) The half that must be able to fail. Run on the market with the LARGEST proven rate, so
  // "10x" and "sign-flipped" are genuinely different numbers rather than variations on zero.
  const biggest = rows.filter((r) => Number.isFinite(r.hourly)).sort((a, b) => Math.abs(b.provenPpm) - Math.abs(a.provenPpm))[0];
  const bm = indexer[biggest.ticker];
  const f = await proveFunding(anchor, { ticker: biggest.ticker, perpetualId: Number(bm.clobPairId), fundingCtx });
  const market = { proven: { fundingHourly: f.fundingHourly } };
  const nonZero = f.fundingHourly || 1e-5;
  for (const [label, fake] of [['10x', nonZero * 10], ['sign-flipped', -nonZero], ['1%/h', 0.01]]) {
    const bad = await attest({ ticker: biggest.ticker, perpetualId: Number(bm.clobPairId), quantity: 'fundingHourly', claimed: fake, bound: BOUND_FUNDING_SAMPLED, anchor, market });
    assert.equal(bad.ok, false, `a fabricated funding rate (${label}, proven ${f.fundingHourly}) must not attest`);
    assert.equal(bad.reason, 'DIVERGENCE_EXCEEDS_BOUND');
  }
  // ...and the honest value on the same path must still attest, or (4) is just refusing everything.
  const good = await attest({ ticker: biggest.ticker, perpetualId: Number(bm.clobPairId), quantity: 'fundingHourly', claimed: f.fundingHourly, bound: BOUND_FUNDING_EXACT, anchor, market });
  assert.equal(good.ok, true, 'the proven value itself must attest under the tightest bound');
  assert.equal(good.relDiff, 0);
});

test('a PERTURBED premium sample is REFUSED', async () => {
  // Control 1. The samples are the whole input, so a verifier that cannot notice one of them moving
  // is checking the shape of the computation and not its content.
  const { market, inputs, honest } = await pickSampledMarket();

  // +paddedTo ppm on one sample moves the truncated mean by exactly 1 ppm, by construction: for
  // integer division, trunc((S + P)/P) == trunc(S/P) + 1. So this control is arithmetic, not luck.
  const bumped = inputs.premiums.slice();
  bumped[0] += honest.paddedTo;
  const perturbedTick = fundingTickPpm({ ...inputs, premiums: bumped });
  assert.notEqual(perturbedTick.ppm, honest.tick.ppm,
    `perturbing one sample by the padding target must move the realized rate; ${honest.tick.ppm} stayed ${perturbedTick.ppm}`);
  assert.equal(perturbedTick.ppm - honest.tick.ppm, 1, 'and it must move by exactly one ppm');

  // Now the same perturbation as an ATTESTATION: the rate it produces no longer matches the proven one.
  const r = await attest({
    ticker: market.ticker, perpetualId: market.perpetualId, quantity: 'fundingTickHourly',
    claimed: perturbedTick.ppm / FUNDING_PPM_PER_HOURLY, bound: BOUND_FUNDING_EXACT, anchor,
    market: { proven: { fundingTickHourly: honest.tick.ppm / FUNDING_PPM_PER_HOURLY } },
  });
  assert.equal(r.ok, false, 'a rate computed from a perturbed sample must be refused');
  assert.equal(r.reason, 'DIVERGENCE_EXCEEDS_BOUND');

  // A SINGLE ppm on one sample is below the realized rate's own granularity and is normally absorbed
  // by the integer truncation. That is a real limit, so it is recorded rather than asserted away —
  // and the PREDICTED rate, which divides in floating point, does see it.
  const nudged = inputs.premiums.slice(); nudged[0] += 1;
  const nudgedTick = fundingTickPpm({ ...inputs, premiums: nudged });
  const nudgedNext = nextFundingPpm({ premiums: nudged, numPremiums: inputs.numPremiums, defaultFundingPpm: inputs.defaultFundingPpm });
  assert.notEqual(nudgedNext.ppm, honest.next.ppm, 'the predicted rate must see a one-ppm perturbation');
  console.log(`      perturb: +${honest.paddedTo} ppm -> realized ${honest.tick.ppm} becomes ${perturbedTick.ppm}; +1 ppm -> realized ${nudgedTick.ppm} (granularity ${nudgedTick.ppm === honest.tick.ppm ? 'absorbs it' : 'sees it'}), predicted sees it`);
});

test('a DROPPED premium sample is REFUSED', async () => {
  // Control 2. Pretending a minute never happened. Dropping sample v moves the sum by v while the
  // divisor stays at the padding target, so detection is guaranteed once |v| >= paddedTo — which is
  // why the market with the largest single sample is the one chosen.
  const { market, inputs, honest } = await pickSampledMarket();
  const biggest = inputs.premiums.reduce((best, v, i) => (Math.abs(v) > Math.abs(inputs.premiums[best]) ? i : best), 0);
  const v = inputs.premiums[biggest];
  assert.ok(Math.abs(v) >= honest.paddedTo,
    `no market at this height carries a sample of at least ${honest.paddedTo} ppm (largest ${v}), so this control could not be executed — that is a red, not a pass`);

  const dropped = inputs.premiums.slice(0, biggest).concat(inputs.premiums.slice(biggest + 1));
  const droppedTick = fundingTickPpm({ ...inputs, premiums: dropped });
  const droppedNext = nextFundingPpm({ premiums: dropped, numPremiums: inputs.numPremiums, defaultFundingPpm: inputs.defaultFundingPpm });
  assert.notEqual(droppedTick.ppm, honest.tick.ppm, `dropping a ${v} ppm sample must move the realized rate`);
  assert.notEqual(droppedNext.ppm, honest.next.ppm, 'and must move the predicted rate');

  const r = await attest({
    ticker: market.ticker, perpetualId: market.perpetualId, quantity: 'fundingTickHourly',
    claimed: droppedTick.ppm / FUNDING_PPM_PER_HOURLY, bound: BOUND_FUNDING_EXACT, anchor,
    market: { proven: { fundingTickHourly: honest.tick.ppm / FUNDING_PPM_PER_HOURLY } },
  });
  assert.equal(r.ok, false, 'a rate computed from a truncated sample set must be refused');
  assert.equal(r.reason, 'DIVERGENCE_EXCEEDS_BOUND');

  // The same shape of defect one layer down: reading `premiums` as int32 rather than sint32. This is
  // the wire type that made the whole recomputation look impossible, so it is pinned here.
  const asInt32 = inputs.premiums.map((x) => (x < 0 ? -x * 2 - 1 : x * 2));
  const wrongTick = fundingTickPpm({ ...inputs, premiums: asInt32 });
  assert.notEqual(wrongTick.ppm, honest.tick.ppm, 'decoding premiums as int32 instead of sint32 must be visible');
  console.log(`      drop: removing one ${v} ppm sample -> ${honest.tick.ppm} becomes ${droppedTick.ppm}; int32-not-sint32 -> ${wrongTick.ppm}`);
});

test('a funding proof lifted from ANOTHER HEIGHT is REFUSED', async () => {
  // Control 3, and the reason for the refusal matters as much as the refusal. A proof fetched at a
  // pruned height also fails, with a different message; accepting that as evidence would mean the
  // check "passes" on machines where the node happens to have forgotten the state. So a SECOND real
  // anchor is opened and the two are crossed: real proof, real height, wrong app_hash.
  const other = await openAnchor();
  assert.notEqual(other.height, anchor.height, 'the two anchors must actually be at different heights');
  assert.notEqual(other.appHash, anchor.appHash, 'and must therefore carry different app_hashes');

  const spoofed = { ...anchor, height: other.height };   // anchor A's app_hash, anchor B's height
  await assert.rejects(
    () => proveKey(spoofed, 'perpetuals', Buffer.from('PremSamples')),
    /proof roots to [0-9A-F]+ but the anchored app_hash/,
    'a valid proof from another height must be rejected BECAUSE it roots elsewhere, not for any other reason',
  );

  // The same attack one level up: funding inputs proven at one anchor, reused against another. The
  // per-key root check cannot see this, because each individual proof is internally valid.
  await assert.rejects(
    () => proveFunding(other, { ticker: 'BTC-USD', perpetualId: 0, fundingCtx }),
    /refusing to mix heights/,
    'funding inputs proven under one app_hash must not be reusable against another anchor',
  );

  // ...and the honest version of exactly that call must still succeed, or the check above is just
  // "refuse everything" wearing a different hat.
  const honest = await proveFunding(anchor, { ticker: 'BTC-USD', perpetualId: 0, fundingCtx });
  assert.equal(honest.ticker, 'BTC-USD');
  assert.equal(honest.appHash, anchor.appHash);

  // And funding for the wrong market must be refused for the same reason the price path refuses it.
  await assert.rejects(
    () => proveFunding(anchor, { ticker: 'BTC-USD', perpetualId: 1, fundingCtx }),
    /refusing to attest funding for the wrong market/,
    'the ticker cross-check must cover the funding path too, not just the price path',
  );
});

test('an ABSENT funding key is REFUSED, never silently zero', async () => {
  // Control 4. The failure this stops is the quiet one: ask for a key that does not exist, get an
  // empty value back, decode it to 0, and attest a funding rate of zero with a straight face.
  for (const key of ['FundingRate', 'NextFundingRate', 'PremSample', 'PremiumSamples']) {
    await assert.rejects(
      () => proveKeyAny(anchor, 'perpetuals', Buffer.from(key)),
      /the key does not exist in state/,
      `absent key "${key}" must be refused by name, not decoded as zero`,
    );
  }
  // And the hypothetical must be refused too, which is the same failure wearing a friendlier face:
  // mid-epoch the tick rule still returns a number, and it is not comparable to anything the venue
  // published. `proveMarket` withholds it and `attest` must say NOT_IN_PROOF rather than compare it.
  const [ticker, m] = Object.entries(indexer).find(([, x]) => Number(x.clobPairId) === 0)
    || Object.entries(indexer).filter(([, x]) => Number.isFinite(Number(x.clobPairId)))[0];
  const withFunding = await proveMarket(anchor, { ticker, perpetualId: Number(m.clobPairId), fundingCtx });
  const complete = withFunding.funding.tickEpochComplete;
  assert.equal(complete, fundingCtx.premiumStore.numPremiums === fundingCtx.tickEpoch.duration / fundingCtx.sampleEpoch.duration,
    'tickEpochComplete must be read from proven state, not asserted');
  assert.ok(Number.isFinite(withFunding.proven.fundingHourly), 'the predicted rate is always available');
  const tickAttempt = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'fundingTickHourly', claimed: 0, bound: BOUND_FUNDING_EXACT, anchor, market: withFunding });
  if (complete) {
    console.log(`      NOTE: the live anchor happens to sit on a COMPLETE epoch (num_premiums ${fundingCtx.premiumStore.numPremiums}), so the realized rate is legitimately offered here.`);
    assert.ok(Number.isFinite(withFunding.proven.fundingTickHourly));
  } else {
    assert.equal(withFunding.proven.fundingTickHourly, undefined,
      `mid-epoch (num_premiums ${fundingCtx.premiumStore.numPremiums}) the tick rule's output is a hypothetical and must NOT be offered for attestation`);
    assert.equal(tickAttempt.ok, false);
    assert.equal(tickAttempt.reason, 'NOT_IN_PROOF',
      'and the refusal must name its cause rather than falling back to "unprovable"');
  }

  // The decoders must refuse the same way, so a caller holding bytes from somewhere else cannot walk
  // around the proof layer into the same silent zero.
  assert.deepEqual(decodePremiumStore(Buffer.alloc(0)), { markets: [], numPremiums: 0 });
  assert.throws(() => nextFundingPpm({ premiums: [1, 2], numPremiums: 0, defaultFundingPpm: 0 }),
    /inconsistent store, refusing/, 'samples with num_premiums 0 must refuse rather than divide by zero');
  assert.throws(() => fundingTickPpm({ premiums: [], numPremiums: 60, defaultFundingPpm: 0, initialMarginPpm: 0, maintenanceFractionPpm: 600000, fundingRateClampFactorPpm: 6000000, tickDurationSec: 3600, sampleDurationSec: 60 }),
    /must be positive/, 'a zero margin parameter must refuse rather than produce a rate');
  assert.throws(() => fundingTickPpm({ premiums: [], numPremiums: 60, defaultFundingPpm: 0, initialMarginPpm: 20000, maintenanceFractionPpm: 600000, fundingRateClampFactorPpm: 6000000, tickDurationSec: 0, sampleDurationSec: 60 }),
    /must be positive/, 'a missing epoch duration must refuse rather than assume 3600');
});

test('the clamp branch and the direction of integer truncation are pinned', async () => {
  // Two pieces of the transcription that mainnet does not exercise, tested synthetically and labelled
  // as synthetic. Reporting "N of N exact" about code containing an unreached branch is how an
  // untested branch acquires a passing reputation.
  const tier = { initialMarginPpm: 20000, maintenanceFractionPpm: 600000, fundingRateClampFactorPpm: 6000000, tickDurationSec: 3600, sampleDurationSec: 60 };
  const hi = fundingTickPpm({ ...tier, premiums: new Array(60).fill(2000000), numPremiums: 60, defaultFundingPpm: 0 });
  const lo = fundingTickPpm({ ...tier, premiums: new Array(60).fill(-2000000), numPremiums: 60, defaultFundingPpm: 0 });
  // BTC's tier: IM 20,000 ppm, maintenance fraction 600,000 ppm -> MM 12,000 ppm; clamp factor
  // 6,000,000 ppm x 8,000 ppm = 48,000 ppm per hour, against realized rates of order 100 ppm.
  assert.equal(hi.clampBound, 48000, 'the clamp bound must be clampFactor x (IM - MM) in ppm');
  assert.equal(hi.ppm, 48000);
  assert.equal(hi.clamped, true);
  assert.equal(lo.ppm, -48000, 'the clamp must be two-sided');
  assert.equal(lo.clamped, true);
  const inside = fundingTickPpm({ ...tier, premiums: new Array(60).fill(100), numPremiums: 60, defaultFundingPpm: 0 });
  assert.equal(inside.clamped, false, 'and must not fire inside the bound, else it is just a constant');
  assert.equal(inside.ppm, 100);

  // AvgInt32 is Go integer division: it truncates TOWARD ZERO. Math.floor rounds toward minus
  // infinity and differs on every negative sum — right on positive funding, wrong on negative, which
  // is the shape of bug that survives a sample where most rates happen to be positive.
  const neg = fundingTickPpm({ ...tier, tickDurationSec: 120, premiums: [-7], numPremiums: 2, defaultFundingPpm: 0 });
  assert.equal(neg.premiumPpm, -3, 'AvgInt32(-7 / 2) must be -3 (trunc toward zero), not -4 (floor)');
  const pos = fundingTickPpm({ ...tier, tickDurationSec: 120, premiums: [7], numPremiums: 2, defaultFundingPpm: 0 });
  assert.equal(pos.premiumPpm, 3);

  // And the default-funding term, which is the entire rate for 182 of dYdX's 296 markets.
  const defaulted = fundingTickPpm({ ...tier, premiums: [], numPremiums: 60, defaultFundingPpm: 100 });
  assert.equal(defaulted.ppm, 100, 'a market with no premium samples must settle at its default_funding_ppm');
  assert.equal(nextFundingPpm({ premiums: [], numPremiums: 60, defaultFundingPpm: 100 }).ppm, 100);
  assert.equal(nextFundingPpm({ premiums: [], numPremiums: 0, defaultFundingPpm: 100 }).ppm, 100,
    'including at the instant a tick resets num_premiums to zero');
});

// ---------------------------------------------------------------- helper

/**
 * The market with the largest single premium sample at the live anchor, plus its proven inputs and
 * its honest rates. Chosen by largest sample so the drop control is guaranteed detectable by
 * arithmetic rather than by hoping the data cooperates.
 */
async function pickSampledMarket() {
  const withSamples = fundingCtx.premiumStore.markets.filter((m) => m.premiums.length);
  assert.ok(withSamples.length > 0, 'no market carries premium samples at this height, so the sample controls cannot run');
  const tickerOf = new Map(Object.entries(indexer).map(([t, m]) => [Number(m.clobPairId), t]));
  const ranked = withSamples
    .map((m) => ({ ...m, biggest: m.premiums.reduce((a, v) => Math.max(a, Math.abs(v)), 0) }))
    .filter((m) => tickerOf.has(m.perpetualId))
    .sort((a, b) => b.biggest - a.biggest);
  assert.ok(ranked.length > 0, 'no sampled market maps to an indexer ticker');
  const target = ranked[0];
  const ticker = tickerOf.get(target.perpetualId);
  const f = await proveFunding(anchor, { ticker, perpetualId: target.perpetualId, fundingCtx });
  const m = await proveMarket(anchor, { ticker, perpetualId: target.perpetualId });
  const inputs = {
    premiums: f.premiums,
    numPremiums: f.numPremiums,
    defaultFundingPpm: f.ppm.defaultFunding,
    initialMarginPpm: m.tier.initialMarginPpm,
    maintenanceFractionPpm: m.tier.maintenanceFractionPpm,
    fundingRateClampFactorPpm: fundingCtx.params.fundingRateClampFactorPpm,
    tickDurationSec: fundingCtx.tickEpoch.duration,
    sampleDurationSec: fundingCtx.sampleEpoch.duration,
  };
  const tick = fundingTickPpm(inputs);
  const next = nextFundingPpm({ premiums: f.premiums, numPremiums: f.numPremiums, defaultFundingPpm: f.ppm.defaultFunding });
  // The re-derivation must reproduce what the adapter returned, or the controls above are perturbing
  // a different computation than the one under test.
  assert.equal(tick.ppm, f.ppm.tick, 're-derived tick rate must equal the one the adapter returned');
  assert.equal(next.ppm, f.ppm.next, 're-derived predicted rate must equal the one the adapter returned');
  return { market: f, inputs, honest: { tick, next, paddedTo: f.paddedTo } };
}
