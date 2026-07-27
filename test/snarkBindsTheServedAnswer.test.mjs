// A succinct proof is only worth anything if it is a proof OF THE ANSWER THAT WAS SERVED. A proof of
// a position one grid step away verifies just as cleanly and means nothing, so the property under
// test here is not "the proof verifies" — it is that the proof's public signals are the scaled form
// of the very inputs the response echoed, and that the price it certifies is the price that was sold.
//
// The circuit declares all six inputs public, so snarkjs emits them after the two outputs:
//   [ residual, tolerance, mHat, qHat, p0Hat, s, mmrHat, pLiqHat ]
// which is what lets a verifier who holds only the JSON response and the published key check the
// binding without re-running anything.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { byName } from '../src/services.js';
import { getProof, verificationKey } from '../src/util/snark.js';

const require = createRequire(import.meta.url);
const scale = require('../src/util/scale.cjs');

const SIG = { residual: 0, tolerance: 1, mHat: 2, qHat: 3, p0Hat: 4, s: 5, mmrHat: 6, pLiqHat: 7 };

// snarkjs spins up a BN254 worker pool and never tears it down, so a test process that has proved
// anything hangs after the last assertion instead of exiting. A long-lived server does not care; a
// test runner does, and a suite that never exits looks exactly like a suite that never finishes.
after(async () => { try { await globalThis.curve_bn128?.terminate(); } catch { /* nothing to close */ } });

async function proven(input, { timeoutMs = 90_000 } = {}) {
  const out = await byName['perp-gate'].run({ ...input, snark: true });
  const h = out.proof.contentHash;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = getProof(h);
    if (rec && rec.status !== 'building') return { out, rec };
    if (Date.now() > deadline) throw new Error(`proof for ${h} never left "building"`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test('the proof verifies against the key the service publishes', async () => {
  const { rec } = await proven({ side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 });
  assert.equal(rec.status, 'ready', rec.error || '');
  assert.equal(rec.protocol, 'plonk');
  const snarkjs = await import('snarkjs');
  const sj = snarkjs.default ?? snarkjs;
  const vk = verificationKey();
  assert.ok(vk, '/proof/vk must serve a real key — a proof nobody can check is decoration');
  assert.equal(await sj.plonk.verify(vk, rec.publicSignals, rec.proof), true);
});

test('the public signals are the scaled form of the inputs the response echoed', async () => {
  // This is the binding. Break it and the service is handing out proofs of positions it was never
  // asked about — which is strictly worse than serving no proof, because it looks like evidence.
  const req = { side: 'short', entryPrice: 3421.5, size: 12.25, leverage: 8, maintMarginRate: 0.005 };
  const { out, rec } = await proven(req);
  assert.equal(rec.status, 'ready', rec.error || '');
  const echoed = out.proof.inputs;
  const ps = rec.publicSignals;

  assert.equal(ps[SIG.p0Hat], String(scale.toScaled(echoed.entryPrice, 'entryPrice')));
  assert.equal(ps[SIG.qHat], String(scale.toScaled(echoed.size, 'size')));
  assert.equal(ps[SIG.mmrHat], String(scale.toScaled(echoed.maintMarginRate, 'maintMarginRate')));

  // Margin is the one quantity the caller did not send — the engine derived it from leverage and
  // never published it back, so the witness recomputes it. Asserting `mHat === toScaled(the same
  // recomputation)` would only prove the test can copy the implementation. The check that can
  // actually fail runs the relation backwards through `leverage`, which the circuit never sees:
  // the margin it certified, times the leverage the caller asked for, must be the notional.
  const certifiedMargin = Number(BigInt(ps[SIG.mHat])) / Number(scale.SCALE);
  assert.ok(Math.abs(certifiedMargin * echoed.leverage - echoed.size * echoed.entryPrice) < 1e-6,
    `certified margin ${certifiedMargin} at ${echoed.leverage}x is not the notional the caller asked about`);

  // `s` is ±1 in the field, so a short is p−1, not −1. Checking it matters: a proof that silently
  // flipped the side would certify a liquidation price on the wrong side of entry.
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  assert.equal(BigInt(ps[SIG.s]), echoed.side === 'long' ? 1n : FIELD - 1n);

  // And the certified price must be the price that was sold, up to the 2dp the answer is displayed at.
  const certified = Number(BigInt(ps[SIG.pLiqHat])) / Number(scale.SCALE);
  assert.ok(Math.abs(certified - out.liquidationPrice) <= 0.005,
    `certified ${certified} is not the served ${out.liquidationPrice}`);
});

test('a tampered public signal is rejected', async () => {
  const { rec } = await proven({ side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 });
  const snarkjs = await import('snarkjs');
  const sj = snarkjs.default ?? snarkjs;
  const vk = verificationKey();
  const bad = [...rec.publicSignals];
  bad[SIG.pLiqHat] = String(BigInt(bad[SIG.pLiqHat]) + 1n);   // one grid step: 1e-9 of a dollar
  assert.equal(await sj.plonk.verify(vk, bad, rec.proof), false,
    'moving the certified price by a single grid step must invalidate the proof');
});

test('the proof is opt-in and costs the response nothing', async () => {
  // Two guarantees in one: asking for a proof must not change the answer or its content hash (the
  // published appendix would go stale), and the caller must not wait 700ms for proving.
  const req = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };
  const plain = await byName['perp-gate'].run({ ...req });
  const t0 = Date.now();
  const withSnark = await byName['perp-gate'].run({ ...req, snark: true });
  const elapsed = Date.now() - t0;

  assert.equal(withSnark.proof.contentHash, plain.proof.contentHash);
  assert.equal(withSnark.proof.contentHash, '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960');
  assert.equal('snark' in withSnark.proof.inputs, false, 'the flag must not leak into the hashed inputs');
  assert.equal(plain.snark, undefined);
  assert.equal(withSnark.snark.status === 'building' || withSnark.snark.status === 'ready', true);
  assert.ok(elapsed < 250, `paid path took ${elapsed}ms — proving must not be on it`);
});

test('a position outside the circuit domain is refused a proof rather than given a wrong one', async () => {
  // The circuit speaks about margin-backed linear perps with a positive maintenance rate. Anything
  // else must come back "unavailable": proving an adjacent position would be the failure this whole
  // file exists to prevent.
  const { rec } = await proven({ side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0 });
  assert.equal(rec.status, 'unavailable');
  assert.match(rec.error, /outside the circuit domain/);
});

test('the verification key on disk is the one the circuit was compiled to', () => {
  const vk = verificationKey();
  assert.equal(vk.protocol, 'plonk');
  assert.equal(vk.curve, 'bn128');
  assert.equal(vk.nPublic, 8, 'six public inputs plus residual and tolerance');
  const onDisk = JSON.parse(readFileSync(new URL('../assets/zk/vk_plonk.json', import.meta.url), 'utf8'));
  assert.deepEqual(vk, onDisk);
});

test('the free MCP path strips the proof flag and builds the proof too', async () => {
  // The MCP handler is a second implementation of perp-gate, and it is the one a builder reaches
  // first because it is free. It has already leaked a non-input into a content hash once — the
  // comment in that handler records it — so the opt-in flag gets the same test rather than the same
  // assumption. Both halves matter: the hash must not move, AND asking must actually produce a proof.
  const { handleRpc } = await import('../src/mcp.js');
  const call = async (args) => {
    const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'perp_gate', arguments: args } });
    return JSON.parse(res.result.content[0].text);
  };
  // A position no other test in this file proves. The first version of this test used the Appendix C
  // position, and the store had already been filled with its proof by an earlier test — so the
  // "a proof gets built" half passed with the build call deleted. It was checking the cache.
  const base = { side: 'short', entryPrice: 2500, size: 3, leverage: 5, maintMarginRate: 0.01 };
  const plain = await call(base);
  const asked = await call({ ...base, snark: true });

  assert.equal(asked.proof.contentHash, plain.proof.contentHash,
    'asking for a proof over MCP must not change the answer it is a proof of');
  assert.equal('snark' in asked.proof.inputs, false);

  // And the published appendix must still come back from this path byte-identical when asked with
  // the flag — that is the constant a reader of the paper would check against.
  const appendixC = await call({ side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125, snark: true });
  assert.equal(appendixC.proof.contentHash, '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960');
  assert.equal(plain.snark, undefined);
  assert.ok(asked.snark, 'the MCP response must carry the retrieval pointer');
  assert.equal(asked.snark.retrieveAt, `/proof/${asked.proof.contentHash}`);

  const deadline = Date.now() + 90_000;
  for (;;) {
    const rec = getProof(asked.proof.contentHash);
    if (rec && rec.status === 'ready') break;
    assert.ok(Date.now() < deadline, 'MCP asked for a proof and none was ever built');
    await new Promise((r) => setTimeout(r, 250));
  }
});
