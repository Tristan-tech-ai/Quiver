// GATE S — the SNARK and the attestable input, in the same envelope, without claiming more than that.
//
// WHAT THIS IS FOR. `zk/contracts/QuiverPerpVerifier.sol` joins a Plonk proof of the liquidation
// identity to a HyperCore mark read from the precompiles inside the transaction. That join was built,
// gated against a real chain-999 node, and had no caller: `src/services.js` built the SNARK only on
// the branch where the caller supplied the entry price — a private fact no chain can corroborate —
// and defaulted the entry price to HyperCore's mark only on the branch that returned no SNARK at all.
// The proof existed exactly where it could not be attested. This gate is the evidence that it no
// longer does, and, more importantly, that connecting them did not quietly upgrade what is claimed.
//
// THE TWO HALVES ARE DIFFERENT SIZES AND THAT IS THE POINT.
//   POSITIVE — a symbol-mode call now yields a retrievable proof; it verifies against the published
//              key; and the numbers it certifies are the numbers the answer reported. (S.1–S.4)
//   NEGATIVE — and that proof must NOT let a reader conclude the mark is proven. The SNARK is over
//              five frozen integers. It says nothing about where they came from, and it would verify
//              identically if the venue had lied. That is asserted here EXECUTABLY, not by reading
//              the prose: the proof still verifies while the live mark has moved away from it, and
//              substituting today's mark into the price signal makes it fail. (S.5–S.7)
//   UNCHANGED — the caller-supplied path has published worked proofs against it, so it is asserted
//              byte for byte rather than left to inspection. (S.8)
//
// Hits live Hyperliquid and builds real Plonk proofs, so it is slow (~1-2 min) and needs the network.
//
//   node --test gates/gateS-live-input-snark.mjs        (npm run gate:s)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { byName } from '../src/services.js';
import { getProof, verificationKey, stopProver } from '../src/util/snark.js';
import { _internal } from '../src/engine/proof.js';

const require = createRequire(import.meta.url);
const scale = require('../src/util/scale.cjs');

// The circuit declares all six inputs public, so snarkjs emits them after the two outputs.
const SIG = { residual: 0, tolerance: 1, mHat: 2, qHat: 3, p0Hat: 4, s: 5, mmrHat: 6, pLiqHat: 7 };
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// snarkjs spins up a BN254 worker pool on this thread and never tears it down, and the prover is a
// forked process. Either one keeps the runner alive, and a gate that never exits looks exactly like a
// gate that never finishes.
after(async () => {
  try { await stopProver(); } catch { /* already gone */ }
  try { await globalThis.curve_bn128?.terminate(); } catch { /* nothing to close */ }
});

const perp = byName['perp-gate'];
const run = async (body) => {
  const v = perp.validate(body);
  assert.equal(v.error, undefined, `the service refused a call this gate depends on: ${v.error}`);
  return perp.run(v);
};

/** Ask in symbol mode, then wait for the proof the answer points at. */
async function provenSymbolMode(body, { timeoutMs = 150_000 } = {}) {
  const out = await run({ ...body, snark: true });
  assert.ok(out.observation, 'symbol mode must stay an OBSERVATION envelope');
  assert.ok(out.snark, 'symbol mode asked for a proof and the answer carried no pointer to one');
  assert.equal(out.snark.status, 'building', out.snark.reason || '');
  const h = out.observation.contentHash;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await getProof(h);
    if (rec && rec.status !== 'building') return { out, rec };
    assert.ok(Date.now() < deadline, `proof for ${h} never left "building"`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function verifier() {
  const snarkjs = await import('snarkjs');
  return snarkjs.default ?? snarkjs;
}

/** The live Hyperliquid mark, read direct and uncached — the adapter holds a 30 s cache. */
async function liveMark(symbol) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  const i = j[0].universe.findIndex((u) => String(u.name).toUpperCase() === symbol);
  return Number(j[1][i].markPx);
}

// A position no other gate or test proves, so a pass here can never be the store answering from a
// proof somebody else's call already built. That mistake has been made in this repository before: a
// "does a proof get built" assertion passed with the build call deleted, because it was reading a
// cache. The size is deliberately odd for the same reason.
const SYMBOL_POSITION = { symbol: 'BTC', side: 'long', size: 0.3157, leverage: 9 };

// ── S.1 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.1 a symbol-mode call produces a proof that can actually be fetched', async () => {
  // The whole finding in one assertion. Before this change the same call returned `snark: undefined`,
  // and there was no hash to fetch anything by.
  const { out, rec } = await provenSymbolMode(SYMBOL_POSITION);
  assert.equal(rec.status, 'ready', rec.error || '');
  assert.equal(rec.protocol, 'plonk');
  assert.equal(out.snark.retrieveAt, `/proof/${out.observation.contentHash}`);
  assert.equal(out.live.filled._entryDefaultedToMark, true,
    'the point of this branch is that the entry price came from the venue, not the caller');
});

// ── S.2 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.2 that proof verifies against the key the service publishes', async () => {
  const { rec } = await provenSymbolMode(SYMBOL_POSITION);
  const vk = verificationKey();
  assert.ok(vk, '/proof/vk must serve a real key — a proof nobody can check is decoration');
  const sj = await verifier();
  assert.equal(await sj.plonk.verify(vk, rec.publicSignals, rec.proof), true);
});

// ── S.3 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.3 the value it certifies is the value the answer reported', async () => {
  // A proof of a neighbouring position verifies just as cleanly and means nothing. On this branch
  // there is one extra way to land on a neighbour that the caller-supplied branch does not have: the
  // maintenance rate is DERIVED. Hyperliquid symbol mode fills `marginTiers` and no `maintMarginRate`,
  // so the witness takes the engine's own mmr — and if that ever drifts from the rate the answer was
  // computed at, the certified price is about a different position. Signal 6 is where that shows.
  const { out, rec } = await provenSymbolMode(SYMBOL_POSITION);
  assert.equal(rec.status, 'ready', rec.error || '');
  const echoed = out.observation.inputs;
  const ps = rec.publicSignals;

  assert.equal(ps[SIG.p0Hat], String(scale.toScaled(echoed.entryPrice, 'entryPrice')),
    'the certified entry price is not the one the envelope echoed');
  assert.equal(ps[SIG.qHat], String(scale.toScaled(echoed.size, 'size')));
  assert.equal(ps[SIG.s], echoed.side === 'long' ? '1' : String(FIELD - 1n));

  // The derived rate, checked against what the response published AND against the answer's own
  // display field, so a drift between the proof and the answer cannot hide behind one of them.
  assert.equal(ps[SIG.mmrHat], String(scale.toScaled(out.snark.maintenanceRateProven, 'maintMarginRate')));
  assert.equal(Number((out.snark.maintenanceRateProven * 100).toFixed(3)), out.maintenanceMarginRatePct,
    'the rate the proof certifies is not the rate the answer printed');

  // Margin was never sent — the caller passed leverage — so asserting mHat against the same
  // recomputation would only prove this gate can copy the implementation. Run the relation backwards
  // through `leverage`, which the circuit never sees.
  const certifiedMargin = Number(BigInt(ps[SIG.mHat])) / Number(scale.SCALE);
  assert.ok(Math.abs(certifiedMargin * echoed.leverage - echoed.size * echoed.entryPrice) < 1e-6,
    `certified margin ${certifiedMargin} at ${echoed.leverage}x is not the notional that was answered`);

  // And the price. 2dp is what the answer is displayed at, so that is the honest ceiling.
  const certified = Number(BigInt(ps[SIG.pLiqHat])) / Number(scale.SCALE);
  assert.ok(Math.abs(certified - out.liquidationPrice) <= 0.005,
    `certified ${certified} is not the served ${out.liquidationPrice}`);
});

// ── S.4 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.4 asking for the proof moved nothing that a buyer can check', async () => {
  // Two properties at once. The delivery flag must not reach the hashed inputs — it did on three
  // separate call sites before — and the published hash recipe must still reproduce the hash the
  // envelope carries. The observation hash commits observedAtUtc, so two calls cannot be compared
  // directly; the inputs they hash can, and that is the thing the flag could contaminate.
  const plain = await run({ ...SYMBOL_POSITION });
  const asked = await run({ ...SYMBOL_POSITION, snark: true });

  assert.equal(plain.snark, undefined, 'an unasked answer must carry no snark field');
  assert.equal('snark' in asked.observation.inputs, false, 'the flag leaked into the hashed inputs');
  assert.equal(JSON.stringify(asked.observation.inputs), JSON.stringify(plain.observation.inputs),
    'asking for a proof changed the inputs the content hash is taken over');

  // The recipe the envelope publishes, executed.
  const { observation, snark, ...served } = asked;
  const recomputed = sha256(_internal.canonical({
    engine: 'perp-gate',
    codeHash: observation.codeHash,
    observedAtUtc: observation.observedAtUtc,
    inputs: observation.inputs,
    result: JSON.parse(JSON.stringify(served)),
  }));
  assert.equal(recomputed, observation.contentHash, 'the published recipe no longer reproduces the published hash');

  // And the envelope is still the honest one. The hard rule of this codebase is that a result
  // carrying live provenance is never sealed as a deterministic proof; attaching a SNARK beside it
  // must not have turned it into one.
  assert.equal(asked.proof, undefined, 'a live-fetched answer must not carry a proof envelope');
  assert.equal(asked.observation.deterministic, false);
  assert.equal(asked.observation.kind, 'OBSERVATION');
  assert.equal(_internal.buildId(), 'q1-e1fa99d08887d6cc', 'the engine build hash moved');
});

// ── S.5 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.5 THE NEGATIVE: the answer says, in machine-readable form, that the inputs were fetched', async () => {
  // The distinction this whole field exists to preserve must not depend on a caller reading prose.
  const out = await run({ ...SYMBOL_POSITION, snark: true });
  assert.equal(out.snark.inputsWereFetchedLive, true);
  assert.equal(out.snark.entryPriceSource, 'live-mark');
  assert.equal(out.snark.entryPriceVenue, 'hyperliquid');
  assert.equal(out.snark.entryPriceProven, out.observation.inputs.entryPrice);
  assert.equal(out.snark.observedAtUtc, out.observation.observedAtUtc);

  // And it says what the proof does NOT cover, naming the mark. A proof shipped beside a live read
  // with no such statement is the over-claim this gate exists to forbid.
  assert.match(out.snark.doesNotProve, /mark/i);
  assert.match(out.snark.doesNotProve, /FETCHED rather than supplied/);
  assert.equal(out.snark.markAttestation.deployed, false,
    'nothing has been attested on chain; a response must not imply otherwise');

  // The over-claim, stated as a pattern rather than trusted to review: nothing in the snark block may
  // assert that the mark, the venue or the input is itself proven or attested. `doesNotProve` is
  // exempt because saying "this does not prove the mark" is the opposite of the claim being banned.
  const { doesNotProve, ...rest } = out.snark;
  const OVERCLAIM = /prove[sd]?\s+(?:that\s+)?(?:the\s+)?(?:mark|entry\s+price|input|oracle)|(?:mark|entry\s+price|input)\s+is\s+(?:proven|attested|verified)/i;
  assert.doesNotMatch(JSON.stringify(rest), OVERCLAIM,
    'the snark block claims the fetched input is proven — it is not, and the circuit has no term for it');
});

// ── S.6 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.6 THE NEGATIVE, EXECUTED: the proof is bound to a frozen number, not to "the mark"', async () => {
  // The prose above is a claim. This is the demonstration. If the SNARK attested the mark, then a
  // proof built against a mark that has since moved would have to stop verifying, and substituting
  // the current mark into the price signal would have to be acceptable. Both are the other way round.
  const { out, rec } = await provenSymbolMode(SYMBOL_POSITION);
  assert.equal(rec.status, 'ready', rec.error || '');
  const vk = verificationKey();
  const sj = await verifier();
  const provenEntry = out.observation.inputs.entryPrice;

  // Let the market move. The service's own measurement puts the p99.9 of 30-second drift at 4,055 ppm.
  await new Promise((r) => setTimeout(r, 8000));
  const now = await liveMark('BTC');
  const ppm = Math.abs(now - provenEntry) / provenEntry * 1e6;
  console.log(`      proven entry ${provenEntry}, mark now ${now} — ${ppm.toFixed(1)} ppm away`);

  assert.equal(await sj.plonk.verify(vk, rec.publicSignals, rec.proof), true,
    'the proof stopped verifying because the market moved — which would mean it was about the mark');

  // And the proof does not travel to the new mark. Only meaningful when the mark actually moved; if
  // it did not, the substitution is the identity and asserting failure would be asserting nonsense.
  const nowHat = String(scale.toScaled(now, 'markPrice'));
  if (nowHat !== rec.publicSignals[SIG.p0Hat]) {
    const swapped = [...rec.publicSignals];
    swapped[SIG.p0Hat] = nowHat;
    assert.equal(await sj.plonk.verify(vk, swapped, rec.proof), false,
      'the proof accepted a different entry price — it would then certify a position nobody was answered about');
  } else {
    console.log('      mark unchanged over the interval; the substitution half is vacuous this run');
  }

  // Which is the whole argument for the on-chain half, and the response has to point at it rather
  // than leave the reader to work out that the gap exists.
  assert.equal(out.snark.markAttestation.appliesToThisAnswer, true);
  assert.match(out.snark.markAttestation.mechanism, /HyperCore precompiles INSIDE the transaction/);
  assert.match(out.snark.markAttestation.window, /4055 ppm/);
});

// ── S.7 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.7 the two ways the input is NOT attestable are told apart, and neither is dressed up', async () => {
  // The join reads HyperCore. Two symbol-mode answers look identical in shape and neither can be
  // covered by it, for completely different reasons — and a single "on-chain verifiable" banner over
  // both would be the false-attestation failure this project has already shipped once.
  const callerEntry = await run({ symbol: 'BTC', entryPrice: 64000, side: 'long', size: 0.3157, leverage: 9, snark: true });
  assert.equal(callerEntry.snark.entryPriceSource, 'caller-supplied');
  assert.equal(callerEntry.snark.inputsWereFetchedLive, true, 'the tiers and funding were still fetched');
  assert.equal(callerEntry.snark.markAttestation.appliesToThisAnswer, false);
  assert.match(callerEntry.snark.markAttestation.note, /caller's own/);

  const otherVenue = await run({ symbol: 'BTC', venue: 'dydx', side: 'long', size: 0.3157, leverage: 9, snark: true });
  assert.equal(otherVenue.snark.entryPriceSource, 'live-mark');
  assert.equal(otherVenue.snark.entryPriceVenue, 'dydx');
  assert.equal(otherVenue.snark.markAttestation.appliesToThisAnswer, false,
    'a dYdX mark is not in HyperCore state and must not be advertised as attestable there');
  assert.match(otherVenue.snark.markAttestation.note, /HyperCore precompiles hold no dydx state/);
});

// ── S.8 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.8 the caller-supplied path is unchanged, byte for byte', async () => {
  // This path has published worked proofs against it and an appendix a reader checks by hand. It was
  // deliberately not touched, and "deliberately not touched" is a claim like any other.
  const appendixC = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };
  const plain = await run({ ...appendixC });
  const asked = await run({ ...appendixC, snark: true });

  assert.equal(plain.proof.contentHash, '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960');
  assert.equal(asked.proof.contentHash, plain.proof.contentHash);
  assert.equal(plain.snark, undefined);

  // The exact object, not a subset — an added key is as much a change as a removed one, and the
  // disclosure fields added on the observation branch must not have leaked across.
  assert.deepEqual(asked.snark, {
    protocol: 'plonk',
    status: 'building',
    retrieveAt: `/proof/${plain.proof.contentHash}`,
    verificationKey: '/proof/vk',
    note: 'A succinct proof of the liquidation identity for exactly these inputs, over the public Hermez reference string. Proving takes about 0.7s, so it is built off this request rather than inside it — fetch it at the URL above, free. It certifies the identity on a 1e-9 grid; the inputs echoed here are already snapped to that grid, so the proof and this answer describe the same position.',
  });
  assert.equal(asked.observation, undefined, 'a caller-supplied answer must still be a deterministic proof');
  assert.equal(asked.proof.deterministic, true);
});

// ── S.9 ──────────────────────────────────────────────────────────────────────────────────────────
test('S.9 a proof fetched WITHOUT its answer still says its input was a live read', async () => {
  // A proof outlives the answer it came from. /proof/<hash> is free and is meant to be fetched by
  // somebody who never saw the response — that is a stated feature of the design — and at that
  // endpoint a proof whose entry price was read off a venue was indistinguishable from one the caller
  // typed. Both are eight field elements and a Plonk transcript. The circuit cannot carry the
  // difference, so it has to travel beside the proof; this asserts that it does, and that it did not
  // leak onto the records that must not change.
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const vk = verificationKey();
  const sj = await verifier();
  try {
    const { out } = await provenSymbolMode(SYMBOL_POSITION);
    const served = await (await fetch(base + out.snark.retrieveAt)).json();
    assert.equal(served.status, 'ready');
    assert.ok(served.provenance, 'the detached proof lost the one fact that distinguishes it');
    assert.equal(served.provenance.inputsWereFetchedLive, true);
    assert.equal(served.provenance.entryPriceSource, 'live-mark');
    assert.equal(served.provenance.entryPriceVenue, 'hyperliquid');
    assert.equal(served.provenance.observedAtUtc, out.observation.observedAtUtc);
    assert.match(served.provenance.doesNotProve, /FETCHED from a venue/);
    // And it is a real proof at that endpoint, not just a labelled one.
    assert.equal(await sj.plonk.verify(vk, served.publicSignals, served.proof), true);

    // The other half, and the one that would be expensive to get wrong: a caller-supplied proof must
    // serialise here exactly as it did before this field existed. Asserted as the whole key list in
    // order — an added key is as much a change as a removed one, and this endpoint is what a buyer
    // checks a published proof against.
    const appendixC = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };
    const supplied = await run({ ...appendixC, snark: true });
    const deadline = Date.now() + 150_000;
    for (;;) {
      const rec = await getProof(supplied.proof.contentHash);
      if (rec && rec.status === 'ready') break;
      assert.ok(Date.now() < deadline, 'the caller-supplied proof never finished building');
      await new Promise((r) => setTimeout(r, 250));
    }
    const servedC = await (await fetch(base + `/proof/${supplied.proof.contentHash}`)).json();
    assert.equal('provenance' in servedC, false, 'a caller-supplied proof grew a key it never had');
    assert.deepEqual(Object.keys(servedC), [
      'status', 'contentHash', 'protocol', 'proof', 'publicSignals',
      'encodedInputs', 'gapToServedPrice', 'signalsAttestation',
      'verificationKey', 'verify', 'onChain',
    ], 'the published proof-retrieval shape moved');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
