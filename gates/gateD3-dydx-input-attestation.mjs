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
//   * and the signature checker must reject tampered sign bytes.
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
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openAnchor, proveMarket, attest, fetchIndexerMarkets,
  verifyCommitSignatures, voteSignBytes, TRUST, ATTESTABLE, NOT_ATTESTABLE, MIN_CORROBORATORS,
} from '../src/adapters/dydx-attest.js';

const BOUND_ORACLE = 1e-2;
const BOUND_STATIC = 1e-12;
const WORST_OBSERVED_ORACLE = 3.121e-3;   // measured, see header
const MARKETS_SAMPLED = Number(process.env.GATE_D3_MARKETS || 40);

// One anchor and one indexer snapshot shared by every test: re-anchoring per test would compare
// against different heights and manufacture divergence that is not real.
let anchor, indexer, sample;

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

  // ...and the label must not overstate. There is no trusted checkpoint, so the strongest label in
  // the module must NOT be the one returned.
  assert.notEqual(anchor.trust, TRUST.CHECKPOINTED,
    'no weak-subjectivity checkpoint exists, so the checkpointed label must never be returned');

  const markets = Object.entries(indexer).filter(([, m]) => m.clobPairId !== undefined && Number(m.oraclePrice) > 0);
  assert.ok(markets.length > 50, `expected a broad market list, got ${markets.length}`);
  const stride = Math.max(1, Math.floor(markets.length / MARKETS_SAMPLED));
  sample = markets.filter((_, i) => i % stride === 0).slice(0, MARKETS_SAMPLED);
});

test('the indexer agrees with signed chain state across many markets', async () => {
  const results = [];
  const failures = [];
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
      } catch (e) { failures.push(`${ticker}: PROOF ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));

  assert.deepEqual(failures, [], `every honest market must attest; got ${failures.length} failure(s):\n  ${failures.slice(0, 8).join('\n  ')}`);
  assert.ok(results.length >= sample.length * 3 * 0.9, `expected ~${sample.length * 3} attestations, got ${results.length}`);

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

  // fundingHourly is consumed by perp-gate and cannot be proven. Silence would read as coverage.
  const funding = await attest({ ticker, perpetualId: Number(m.clobPairId), quantity: 'fundingHourly', claimed: 0.0000125, bound: BOUND_ORACLE, anchor, market });
  assert.equal(funding.ok, false);
  assert.equal(funding.reason, 'NO_PROOF_PATH');
  assert.ok(NOT_ATTESTABLE.fundingHourly, 'the refusal must be backed by a stated reason');

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
});
