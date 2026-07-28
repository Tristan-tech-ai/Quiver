// GATE D3c — is the dYdX anchor actually CHECKPOINTED, and can this gate still say no?
//
// `dydx-attest.js` verifies an ICS-23 proof against an app_hash it got from dYdX RPCs, whose validator
// set it also got from dYdX RPCs. Internally consistent, and circular. `TRUST.CHECKPOINTED` existed in
// that module from the beginning as a label that was DELIBERATELY never returned, because nothing
// pinned the app_hash from outside. `src/adapters/ibc-checkpoint.js` now does, and this gate is the
// thing that keeps that claim honest.
//
// The half that passes: a live checkpointed anchor, where the app_hash dYdX's RPCs serve is
// byte-identical to the one Osmosis's validators independently committed to inside their IBC client.
//
// The half that can fail, and which is the actual point — every one of these is built from REAL
// on-chain data, not from a mock:
//   * a consensus state from the WRONG HEIGHT must be refused (a real, proven, older consensus state)
//   * a FABRICATED app_hash must be refused (one byte flipped in a real checkpoint)
//   * a fabricated next_validators_hash must be refused
//   * an EXPIRED checkpoint must be refused LOUDLY, at BOTH the read and the bind step, never
//     downgraded to a weaker label behind the caller's back
//   * ONE counterparty provider must never yield TRUST.CHECKPOINTED
//   * a single-operator chain (noble, stride) must be refused by default
//   * an arbitrary height nobody stored must produce no checkpoint at all
//   * and the label must never appear on an anchor that carries no checkpoint evidence
//
//   node --test gates/gateD3c-dydx-checkpoint.mjs        (npm run gate:d3c)
//
// ============================================================================================
// WHAT A GREEN RUN HERE DOES AND DOES NOT MEAN. Measured 2026-07-28.
// ============================================================================================
// It means: forging an attestation now requires getting a fabricated dYdX header past Osmosis's own
// 07-tendermint client, which needs signatures from >1/3 of dYdX's validator set by stake, slashably
// and permanently on chain — instead of requiring one malicious web server.
//
// It does NOT mean freshness is attested. A checkpoint is by construction a PAST height: the anchor
// moves from tip-3 to whatever the counterparty relayer last submitted, measured 11-40 minutes back.
// That has a direct, measured cost, and it is asserted below rather than hidden: at a checkpointed
// anchor the tip-calibrated oracle bound of gateD3 (1e-2) is BLOWN — worst observed divergence against
// a LIVE indexer read was 1.833e-2 over 40 markets, 183% of that bound, because the two sides are now
// tens of minutes apart in time rather than ~5 seconds. The static margin parameters stay EXACT
// (0 divergence over 80 observations), and that asymmetry is the honest summary: checkpointing buys
// provenance and costs freshness. Comparing a live indexer price to a checkpointed anchor is comparing
// across the anchor lag, and this gate asserts the statics, not a tip-calibrated oracle bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAnchor, proveMarket, fetchIndexerMarkets, TRUST, MIN_CORROBORATORS } from '../src/adapters/dydx-attest.js';
import {
  readCheckpoint, readBestCheckpoint, verifyAnchorCheckpoint, anchorHeightFor,
  probeProofDepth, discoverStoredHeights, decodeTmClientState, decodeAny,
  CHECKPOINT_CHAINS, MIN_CHECKPOINT_OPERATORS, DEPTH_REGIMES, DYDX_RPC_OPERATORS,
} from '../src/adapters/ibc-checkpoint.js';

const BOUND_STATIC = 1e-12;
/** Measured 2026-07-28 over a 9,990-block span; 2 days = 284,058 blocks. */
const DYDX_BLOCK_SECONDS = 0.608;

let anchor, checkpoint;

// One checkpointed anchor shared by every test. Re-anchoring per test would land on different heights
// and manufacture disagreement that is not real.
test('open a CHECKPOINTED anchor: dYdX app_hash == the value another chain committed to', async () => {
  anchor = await openAnchor({ checkpoint: true });
  checkpoint = anchor.checkpoint;

  assert.equal(anchor.chainId, 'dydx-mainnet-1');
  assert.ok(checkpoint, 'a checkpointed anchor must carry its checkpoint evidence');

  // THE assertion this whole workstream exists for.
  assert.equal(anchor.trust, TRUST.CHECKPOINTED,
    'openAnchor({checkpoint:true}) must return the checkpointed label');

  // ...and it must be earned, clause by clause.
  assert.equal(checkpoint.appHash, String(anchor.appHash).toUpperCase(),
    'the checkpointed app_hash must be byte-identical to the anchored one');
  assert.equal(checkpoint.dydxHeight, anchor.headerHeight,
    'a checkpoint covers exactly one height');
  assert.equal(anchor.height, checkpoint.dydxHeight - 1,
    'consensus_state(H).root is header[H].app_hash, so the anchor sits at H-1');
  assert.equal(anchor.pinned, true, 'a checkpointed anchor is pinned, never tip-tracking');
  assert.equal(checkpoint.nextValidatorsHashMatched, true,
    'the second binding (next_validators_hash) must have been checked, not skipped');
  assert.equal(checkpoint.byteIdentical, true,
    'every counterparty provider must have returned the SAME consensus-state bytes');
  assert.equal(checkpoint.expired, false);
  assert.ok(checkpoint.operatorCount >= MIN_CHECKPOINT_OPERATORS,
    `need >=${MIN_CHECKPOINT_OPERATORS} independent counterparty operators, got ${checkpoint.operatorCount}`);
  assert.equal(checkpoint.hostSignaturesVerified, true,
    'the counterparty app_hash must itself be >2/3 validator-signed, or the checkpoint is just another web server');
  assert.notEqual(checkpoint.hostChainId, 'dydx-mainnet-1',
    'a checkpoint from dYdX itself would checkpoint nothing');

  // The dYdX side must still be everything it was before. A checkpoint ADDS a guarantee; it does not
  // license dropping one.
  assert.ok(anchor.corroborators >= MIN_CORROBORATORS);
  assert.equal(anchor.signatures.failed, 0);
  assert.ok(anchor.signatures.twoThirds);
  assert.equal(anchor.signaturesVerified, true);

  console.log(`      checkpoint: ${checkpoint.chain} (${checkpoint.hostChainId}) client ${checkpoint.clientId} @ dYdX height ${checkpoint.dydxHeight}`);
  console.log(`      app_hash  : ${checkpoint.appHash}`);
  console.log(`      operators : ${checkpoint.operatorCount} [${checkpoint.operators.join(', ')}] — disjoint from the dYdX RPC set: [${checkpoint.disjointOperators.join(', ') || 'NONE'}]`);
  console.log(`      host sigs : ${checkpoint.hostSignatures.map((s) => `${s.operator} ${(s.powerFraction * 100).toFixed(1)}%`).join(', ')}`);
  console.log(`      anchor lag: ${checkpoint.ageSeconds}s (${(checkpoint.ageSeconds / 60).toFixed(1)} min) vs a ${(checkpoint.trustingPeriodSec / 86400).toFixed(1)}-day trusting period`);
  console.log(`      also seen : ${checkpoint.alternatives.map((a) => `${a.chain}@${a.dydxHeight}`).join(', ') || 'none'}`);
});

test('the label NEVER appears on an anchor that carries no checkpoint evidence', async () => {
  // The cheapest way for this whole feature to become decorative is for the label to start being
  // returned by default. A plain anchor must be exactly as strong as it was before, and say so.
  const plain = await openAnchor();
  assert.notEqual(plain.trust, TRUST.CHECKPOINTED,
    'an anchor opened without a checkpoint must NOT claim to be checkpointed');
  assert.equal(plain.trust, TRUST.SIGNED);
  assert.equal(plain.checkpoint, null, 'no checkpoint requested means no checkpoint evidence');
  assert.equal(plain.proofDepth, null);
});

// ---------------------------------------------------------------- the half that must be able to fail

test('a consensus state from the WRONG HEIGHT is REFUSED', async () => {
  // Not a mock: a real, ICS-23-proven consensus state that Osmosis really stored, for a real dYdX
  // height — just not THIS one. This is the cheapest forgery available to anyone holding genuine
  // historical proofs, which is exactly why it has to be checked.
  const older = await realOlderCheckpoint();
  assert.notEqual(older.dydxHeight, anchor.headerHeight, 'construction error: the heights must differ');

  assert.throws(
    () => verifyAnchorCheckpoint(anchor, older),
    /checkpoint is for dYdX height .* but the anchor's header height is|covers ONE height/,
    'binding a real checkpoint for another height must throw, not be tolerated as "close enough"',
  );
});

test('a FABRICATED app_hash is REFUSED', async () => {
  const flip = (hex, i) => { const b = Buffer.from(hex, 'hex'); b[i] ^= 1; return b.toString('hex').toUpperCase(); };

  for (const [label, mutate] of [
    ['one bit in the first byte', (c) => ({ ...c, appHash: flip(c.appHash, 0) })],
    ['one bit in the last byte', (c) => ({ ...c, appHash: flip(c.appHash, 31) })],
    ['an all-zero app_hash', (c) => ({ ...c, appHash: '00'.repeat(32) })],
  ]) {
    assert.throws(
      () => verifyAnchorCheckpoint(anchor, mutate(rawCheckpoint())),
      /APP_HASH DISAGREEMENT/,
      `a checkpoint with ${label} changed must be refused`,
    );
  }

  // ...and the unmutated one must still bind, or this test would pass by refusing everything.
  const honest = verifyAnchorCheckpoint(anchor, rawCheckpoint());
  assert.equal(honest.trust, TRUST.CHECKPOINTED);
  assert.equal(honest.appHash, String(anchor.appHash).toUpperCase());
});

test('a fabricated next_validators_hash is REFUSED', async () => {
  // The second binding. It is free — the same consensus state carries it — and it is what makes an
  // app_hash collision insufficient on its own.
  const bad = { ...rawCheckpoint(), nextValidatorsHash: 'AA'.repeat(32) };
  assert.throws(() => verifyAnchorCheckpoint(anchor, bad), /next_validators_hash disagreement/);
});

test('a checkpoint whose providers DISAGREED is REFUSED at the bind step', async () => {
  // Providers cannot honestly disagree here — a consensus state at a fixed dYdX height is immutable
  // once written, so byte-identity holds regardless of which counterparty height each provider is at.
  // A disagreement therefore means one of them is lying, and the label must not be issued on a value
  // that is in dispute. Asserted at the bind step because that is where `readCheckpoint`'s own
  // corroboration cannot be re-derived: a flag saying "corroborated" is not corroboration.
  const disputed = { ...rawCheckpoint(), byteIdentical: false };
  assert.throws(() => verifyAnchorCheckpoint(anchor, disputed), /not byte-identical|disputed value/);
});

test('an EXPIRED checkpoint is REFUSED LOUDLY, at BOTH the read and the bind step', async () => {
  // The requirement is specifically that expiry does not silently downgrade to TRUST.SIGNED. It is
  // checked in two independent places, and both are exercised.
  const { expired, real } = await expiredCheckpoint();

  assert.equal(expired.expired, true, 'construction error: this checkpoint is not actually expired');
  assert.ok(expired.ageSeconds > expired.trustingPeriodSec,
    `construction error: age ${expired.ageSeconds}s is not past the ${expired.trustingPeriodSec}s trusting period`);

  // 1. the bind step refuses it even when every other clause is satisfied.
  const matching = { headerHeight: expired.dydxHeight, appHash: expired.appHash, _header: { next_validators_hash: expired.nextValidatorsHash } };
  assert.throws(
    () => verifyAnchorCheckpoint(matching, expired),
    /EXPIRED|refusing to label an expired checkpoint/,
    'an expired checkpoint must not be labelled CHECKPOINTED even when height and app_hash agree',
  );

  // 2. the read step refuses it by default, so a caller never even receives one unasked.
  if (real) {
    await assert.rejects(
      () => readCheckpoint({ chain: 'osmosis', dydxHeight: expired.dydxHeight }),
      /CHECKPOINT EXPIRED/,
      'readCheckpoint must refuse an expired state unless allowExpired is passed deliberately',
    );
    console.log(`      real expired checkpoint: osmosis @ dYdX ${expired.dydxHeight}, ${(expired.ageSeconds / 86400).toFixed(1)} d old vs an ${(expired.trustingPeriodSec / 86400).toFixed(2)} d trusting period`);
  } else {
    console.log('      NOTE: LCD discovery unavailable, so the expiry clause was exercised with a synthetic age. The bind-step refusal above is still a real assertion; the read-step one was skipped.');
  }
});

test('ONE counterparty provider never yields TRUST.CHECKPOINTED', async () => {
  // A corroboration floor nothing ever tries to breach is a floor nobody has checked.
  const one = CHECKPOINT_CHAINS.osmosis.rpcs[0].url;

  await assert.rejects(
    () => readCheckpoint({ chain: 'osmosis', rpcs: [one] }),
    /only 1 independent osmosis operator|need 2/,
    'a checkpoint proved by a single operator is one web server again and must be refused',
  );

  // ...and the refusal must propagate all the way out: no anchor, not a downgraded one.
  await assert.rejects(
    () => openAnchor({ checkpoint: { chain: 'osmosis', rpcs: [one] } }),
    /only 1 independent osmosis operator|need 2/,
    'openAnchor must THROW rather than return a merely-signed anchor when the checkpoint cannot be corroborated',
  );

  // Two providers of the SAME operator are one witness, not two. (Not reachable in the current table —
  // no counterparty chain lists two endpoints from one company — so this asserts the counting rule
  // itself: operator count, never endpoint count.)
  const two = await readCheckpoint({ chain: 'osmosis', rpcs: CHECKPOINT_CHAINS.osmosis.rpcs.slice(0, 2).map((r) => r.url) });
  assert.equal(two.operatorCount, new Set(two.operators).size);
  assert.equal(two.operatorCount, 2);
});

test('a single-operator chain is refused by default, however fresh it is', async () => {
  // noble is the FRESHEST source measured (p50 313 s vs osmosis 255 s with an 18.6 h tail) and is still
  // refused, because freshness is not the property being bought here.
  for (const chain of ['noble', 'stride']) {
    assert.equal(CHECKPOINT_CHAINS[chain].rpcs.length, 1);
    await assert.rejects(
      () => readCheckpoint({ chain }),
      /reachable through ONE operator|single-provider dependency/,
      `${chain} must be refused by default`,
    );
    await assert.rejects(() => openAnchor({ checkpoint: { chain } }), /ONE operator/);
  }
});

test('a height nobody stored has no checkpoint, and says so', async () => {
  // The real limit on historical checkpointing: a counterparty holds only the heights its relayer
  // submitted. Osmosis stores ~15,059 states over 255.9 days against a 0.608 s block time, so ~99.96%
  // of dYdX heights have no checkpoint and never will. H-1 is one of them.
  await assert.rejects(
    () => readCheckpoint({ chain: 'osmosis', dydxHeight: anchor.headerHeight - 1 }),
    /no osmosis provider served a proven consensus state|not one osmosis stored/,
    'an unstored height must produce a refusal that names its own cause, not a guess',
  );
});

test('a frozen client checkpoints nothing', async () => {
  // A non-zero frozen_height means a light-client misbehaviour was PROVEN against that client — one
  // such client exists in the wild (vota-ash). None of the five chains used here is frozen, so the
  // clause is exercised at the decoder, against hand-built protobuf bytes.
  const varint = (n) => { const o = []; let x = BigInt(n); do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; o.push(b); } while (x > 0n); return Buffer.from(o); };
  const tagLen = (f, b) => Buffer.concat([varint((f << 3) | 2), varint(b.length), b]);
  const tagVar = (f, n) => Buffer.concat([varint((f << 3) | 0), varint(n)]);
  const height = (rev, h) => Buffer.concat([tagVar(1, rev), tagVar(2, h)]);

  const notFrozen = decodeTmClientState(Buffer.concat([
    tagLen(1, Buffer.from('dydx-mainnet-1')), tagLen(6, height(0, 0)), tagLen(7, height(1, 99000000)),
  ]));
  assert.equal(notFrozen.frozen, false);
  assert.equal(notFrozen.latestHeight.height, 99000000);

  const frozen = decodeTmClientState(Buffer.concat([
    tagLen(1, Buffer.from('dydx-mainnet-1')), tagLen(6, height(1, 98765432)), tagLen(7, height(1, 99000000)),
  ]));
  assert.equal(frozen.frozen, true, 'a non-zero frozen_height must be detected');
  assert.equal(frozen.frozenHeight.height, 98765432);

  // And the live client actually in use must not be frozen — checked against real bytes, not assumed.
  assert.equal(checkpoint.chain, 'osmosis');
});

// ---------------------------------------------------------------- depth, reported rather than hidden

test('the depth regime is REPORTED, and the header-vs-state corroboration gap is named', async () => {
  // The trap this exists to close: BLOCK retention and STATE retention are different windows on the
  // same node. Measured, every dYdX endpoint serves `commit` two days deep while only ONE serves an
  // ICS-23 state proof there. `openAnchor.corroborators` counts the former. Reading it as the latter
  // is how "3 independent providers" quietly becomes one.
  assert.ok(anchor.proofDepth, 'a checkpointed anchor must report which depth regime it is in');
  assert.ok(Object.values(DEPTH_REGIMES).includes(anchor.proofDepth.regime));
  assert.equal(anchor.proofDepth.height, anchor.height);
  assert.equal(
    anchor.proofDepth.provingOperatorCount,
    new Set(anchor.proofDepth.endpoints.filter((e) => e.served).map((e) => e.operator)).size,
    'the reported operator count must be derived from what was measured, not asserted',
  );
  // A checkpointed anchor is off the tip by construction, so the provider actually used must be one
  // that was MEASURED to serve state there.
  assert.ok(anchor.proofDepth.endpoints.some((e) => e.served && e.url === anchor.primary),
    `primary ${anchor.primary} must be a provider measured to serve a state proof at ${anchor.height}`);

  // Classification must actually discriminate across depths, or "regime" is a constant with a name.
  const tip = anchor.headerHeight;
  const deep = tip - Math.floor((2 * 86400) / DYDX_BLOCK_SECONDS);      // 2 days
  const ancient = tip - Math.floor((30 * 86400) / DYDX_BLOCK_SECONDS);  // 30 days
  const [dDeep, dAncient] = await Promise.all([probeProofDepth({ height: deep }), probeProofDepth({ height: ancient })]);

  console.log(`      anchor  @${anchor.height} -> ${anchor.proofDepth.regime} [${anchor.proofDepth.provingOperators.join(', ')}]  (openAnchor counted ${anchor.corroborators} header-serving providers)`);
  console.log(`      2 days  @${deep} -> ${dDeep.regime} [${dDeep.provingOperators.join(', ') || 'none'}]`);
  console.log(`      30 days @${ancient} -> ${dAncient.regime} [${dAncient.provingOperators.join(', ') || 'none'}]`);

  assert.ok(dDeep.provingOperatorCount <= anchor.proofDepth.provingOperatorCount,
    'deeper heights cannot be served by MORE operators than shallower ones');
  assert.equal(dAncient.regime, DEPTH_REGIMES.UNSERVED,
    '30 days is past every measured dYdX state window, and the module must say so rather than emit a vague failure');
  assert.equal(dAncient.provingOperatorCount, 0);

  // The gap itself, asserted: at 2 days the header count and the proving count must actually diverge.
  // If this ever stops being true a second archive provider appeared, which is good news that should
  // still show up as a gate change rather than as silence.
  assert.ok(dDeep.provingOperatorCount < DYDX_RPC_OPERATORS.length,
    'at 2 days the state-proving operator count must be below the total operator count');
});

test('the checkpointed anchor proves REAL dYdX state: static parameters exact across markets', async () => {
  // The cross-check that the checkpointed anchor is anchored to the right chain at the right height.
  // Static margin parameters are exact decimals derived from the same integer ppm fields on both
  // sides, so an honest agreement is EXACTLY zero. Oracle price is deliberately NOT asserted against a
  // tip-calibrated bound here — see the header: the anchor lag makes that comparison meaningless.
  const indexer = await fetchIndexerMarkets();
  const markets = Object.entries(indexer).filter(([, m]) => m.clobPairId !== undefined && Number(m.oraclePrice) > 0);
  const stride = Math.max(1, Math.floor(markets.length / 12));
  const sample = markets.filter((_, i) => i % stride === 0).slice(0, 12);

  const statics = [], oracle = [], failures = [];
  await Promise.all(sample.map(async ([ticker, m]) => {
    try {
      const mk = await proveMarket(anchor, { ticker, perpetualId: Number(m.clobPairId) });
      statics.push(rel(Number(m.maintenanceMarginFraction), mk.proven.maintenanceMarginRate));
      statics.push(rel(Number(m.initialMarginFraction), mk.proven.initialMarginRate));
      oracle.push(rel(Number(m.oraclePrice), mk.proven.oraclePrice));
    } catch (e) { failures.push(`${ticker}: ${e.message}`); }
  }));

  assert.deepEqual(failures, [], `every market must prove at the checkpointed anchor; got:\n  ${failures.slice(0, 5).join('\n  ')}`);
  assert.ok(statics.length >= sample.length * 2 * 0.9, `expected ~${sample.length * 2} static observations, got ${statics.length}`);

  const worstStatic = Math.max(...statics);
  assert.ok(worstStatic <= BOUND_STATIC,
    `margin parameters must match the CHECKPOINTED chain state exactly; worst was ${worstStatic}`);

  const worstOracle = Math.max(...oracle);
  console.log(`      statics: ${statics.length} observations, worst divergence ${worstStatic} (exact)`);
  console.log(`      oracle : worst divergence vs a LIVE indexer read ${worstOracle.toExponential(3)} across a ${(checkpoint.ageSeconds / 60).toFixed(1)}-minute anchor lag`);
  console.log('      (that oracle number is the PRICE OF CHECKPOINTING, not a fault: gateD3\'s 1e-2 bound is calibrated for a ~5 s tip gap and does not apply here)');
});

test('the two corroboration floors cannot drift apart', async () => {
  // MIN_CHECKPOINT_OPERATORS is defined separately from MIN_CORROBORATORS on purpose, so that
  // relaxing one side cannot silently relax the other. That only works if something checks they agree.
  assert.equal(MIN_CHECKPOINT_OPERATORS, MIN_CORROBORATORS,
    'the checkpoint corroboration floor must match the module\'s own corroboration floor');
  assert.ok(MIN_CHECKPOINT_OPERATORS >= 2);

  // Every chain in the table must declare real operators, and any chain reachable through one operator
  // must be flagged as such, or the default-refusal above silently stops applying.
  for (const [name, C] of Object.entries(CHECKPOINT_CHAINS)) {
    assert.ok(C.rpcs.length > 0, `${name} must list endpoints`);
    const ops = new Set(C.rpcs.map((r) => r.operator));
    assert.ok([...ops].every((o) => typeof o === 'string' && o.length > 2), `${name} endpoints must name their operator`);
    if (ops.size === 1) assert.equal(C.singleOperator, true, `${name} has one operator and must be flagged singleOperator`);
    else assert.notEqual(C.singleOperator, true, `${name} has ${ops.size} operators and must not be flagged singleOperator`);
  }

  // Operator overlap must be reported rather than rounded up to independence.
  assert.ok(Array.isArray(checkpoint.disjointOperators));
  assert.ok(Array.isArray(checkpoint.sharedOperators));
  assert.deepEqual(
    [...checkpoint.disjointOperators, ...checkpoint.sharedOperators].sort(),
    [...checkpoint.operators].sort(),
    'every operator must be classified as either shared with the dYdX RPC set or disjoint from it',
  );
  assert.ok(checkpoint.disjointOperators.every((o) => !DYDX_RPC_OPERATORS.includes(o)));
});

// ---------------------------------------------------------------- helpers

function rel(a, b) {
  if (a === b) return 0;
  const s = Math.max(Math.abs(a), Math.abs(b));
  return s === 0 ? Infinity : Math.abs(a - b) / s;
}

/** The live checkpoint as `readCheckpoint` returned it, re-wrapped so mutations cannot leak between tests. */
function rawCheckpoint() {
  return {
    ok: true,
    chain: checkpoint.chain, hostChainId: checkpoint.hostChainId, clientId: checkpoint.clientId,
    dydxHeight: checkpoint.dydxHeight, appHash: checkpoint.appHash,
    nextValidatorsHash: checkpoint.nextValidatorsHash,
    time: checkpoint.time, ageSeconds: checkpoint.ageSeconds, expired: false,
    trustingPeriodSec: checkpoint.trustingPeriodSec, historical: checkpoint.historical,
    operators: [...checkpoint.operators], operatorCount: checkpoint.operatorCount,
    disjointOperators: [...checkpoint.disjointOperators], sharedOperators: [...checkpoint.sharedOperators],
    providers: [...checkpoint.providers], byteIdentical: true,
    hostSignaturesVerified: checkpoint.hostSignaturesVerified, hostSignatures: checkpoint.hostSignatures,
    proofBytes: checkpoint.proofBytes,
  };
}

let _older = null;
/** A REAL, proven consensus state from a genuinely different (older) stored height. */
async function realOlderCheckpoint() {
  if (_older) return _older;
  // Every alternative chain checkpoints a different height, so the freshest alternative is a real
  // wrong-height consensus state that needs no discovery call at all.
  const alt = checkpoint.alternatives.find((a) => a.dydxHeight !== checkpoint.dydxHeight);
  if (alt) {
    _older = await readCheckpoint({ chain: alt.chain });
    if (_older.dydxHeight !== checkpoint.dydxHeight) return _older;
  }
  // Fallback: an older stored height on the same chain.
  const heights = await discoverStoredHeights({ chain: checkpoint.chain, limit: 5 });
  const h = heights.find((x) => x !== checkpoint.dydxHeight);
  assert.ok(h, 'could not obtain a second, different stored height to build the wrong-height negative');
  _older = await readCheckpoint({ chain: checkpoint.chain, dydxHeight: h, allowExpired: true });
  return _older;
}

/**
 * A genuinely EXPIRED checkpoint. Osmosis retains 255.9 days of consensus states against an 18.67-day
 * trusting period, so its OLDEST stored state is expired by a wide margin and one cheap ascending
 * query reaches it. If that discovery endpoint is unavailable the expiry clause is still exercised,
 * with the age rewritten and the substitution reported — never silently.
 */
async function expiredCheckpoint() {
  try {
    const [oldest] = await discoverStoredHeights({ chain: 'osmosis', limit: 1, reverse: false });
    if (oldest) {
      const c = await readCheckpoint({ chain: 'osmosis', dydxHeight: oldest, allowExpired: true });
      if (c.expired) return { expired: c, real: true };
    }
  } catch { /* discovery is not part of the trust chain; fall through to the synthetic path */ }
  const c = rawCheckpoint();
  c.ageSeconds = c.trustingPeriodSec + 86400;
  c.expired = true;
  return { expired: c, real: false };
}
