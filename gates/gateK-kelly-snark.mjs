// GATE K — the Kelly proof is reachable from `size-gate`, it is about the bet that was sized, and it
// can still say no.
//
// WHAT IT IS FOR. `zk/scripts/gateB0-kelly.mjs` already proved that `kelly.circom` proves, verifies
// and refuses. That gate builds its OWN witness from its own encoder, so what it establishes is a
// property of the circuit and of a script beside it — not of anything a caller can reach. Every one of
// the six circuits in this repository was in that position: proven by a gate that stood in for the
// service. This gate is the difference. It goes through `SERVICES['size-gate'].run`, the same function
// the paid HTTP route calls, and through `handleRpc`, the same entry point the free MCP surface uses,
// and it asks whether the proof a caller actually receives is a proof of the answer they were given.
//
// WHAT IT MEASURES. The same seven questions gate W asks of the liquidation guard, asked of a bound
// that was DERIVED here rather than inherited from it:
//
//   K.1  the expression the guard compares against is the ENGINE'S, bit for bit. Not "the two look
//        alike": `src/engine/sizeGate.js`'s own source line is lifted, compiled and required to return
//        the identical double over a sweep. Re-deriving an engine expression outside the engine is a
//        defect class this repository has shipped three times, most recently a `constantproduct`
//        encoder that rearranged the algebra into a mathematically equal, numerically different form
//        and was wrong by 64 grid steps.
//   K.2  the display rounding is the engine's, for the same reason — `round(f, 6)`, not `round(p, 2)`.
//   K.3  the recomputation reproduces the SERVED answer over a sweep run against the REAL engine, the
//        bound is never exceeded, and the worst honest bet uses a real fraction of it. A bound nothing
//        can approach is not measuring anything.
//   K.4  a proof built through the service verifies against the published key, and its public signals
//        ARE the encoded inputs — not merely consistent with them.
//   K.5  the half that can fail: every public signal perturbed by one is rejected, and so is a bent
//        proof point.
//   K.6  the four refusals, each for its own named reason: a continuous-mode answer has no discrete
//        identity, a non-positive edge has no size, a witness that sizes a different bet is refused,
//        and a bet the 1e-9 grid cannot pin to the width the answer is displayed at is refused.
//   K.7  both surfaces carry it, no content hash moved, and the recipe declares the new sibling.
//
//   node --test gates/gateK-kelly-snark.mjs     # fully offline; no venue is read
//   node gates/gateK-revert.mjs                 # six scripted defects, each must turn it red
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sizeGate } from '../src/engine/sizeGate.js';
import { round } from '../src/engine/stats.js';
import { gridSnapFields } from '../src/util/grid.js';
import { kellyWitnessFor, buildKellyInBackground, getProof, stopProver, verificationKey, _internalKelly } from '../src/util/snark.js';
import { byName } from '../src/services.js';
import { handleRpc } from '../src/mcp.js';
import { followPublishedRecipe } from '../src/util/recipe.js';

const require = createRequire(import.meta.url);
const scale = require('../src/util/scale.cjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC = Number(process.env.QUIVER_GATEK_SYNTHETIC || 120000);

// Real proofs are built in a real forked worker, and snarkjs spins up its own bn128 curve threads on
// this side to verify them. Both have to be told to stop or the runner never exits.
after(async () => {
  try { await stopProver(); } catch { /* already gone */ }
  try { await globalThis.curve_bn128?.terminate(); } catch { /* never started */ }
});

// ── the shared sweep machinery ───────────────────────────────────────────────────────────────────

// Everything the guard decides on, for one set of echoed inputs, measured rather than inferred.
function measure(inputs, served) {
  const w = kellyWitnessFor(inputs, served);
  if (!w) return null;
  return {
    served,
    engine: w.engineFraction,
    certified: scale.fromScaled(w.encoded.fHat),
    roundsBack: _internalKelly.displayRound(w.engineFraction) === served,
    gapToServed: w.gapToServed,
    gapToEngine: w.gapToEngine,
    bound: w.encodingBound,
    used: w.gapToEngine / w.encodingBound,
    publishable: w.encodingBound <= _internalKelly.DISPLAY_HALF_UNIT,
    // The circuit's own statement, checked on this side so a sweep can assert it rather than discover
    // it as an unsatisfied constraint 400 ms into a proof.
    circuitHolds: (w.residual < 0n ? -w.residual : w.residual) * 2n <= w.tolerance,
  };
}

const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// A deterministic sweep in four deliberately different shapes. Mode 0 is the shape a served answer
// actually has — both inputs snapped onto the grid by `gridSnapFields`. The other three exist because
// a bound that only holds on the shape the code normally sees is not a bound. Mode 3 crowds the
// break-even probability, where `p*(b+1) - 1` cancels catastrophically and the fraction is the
// difference of two nearly equal numbers; that is the region a naive floating-point term would miss.
function* synthetic(n) {
  let seed = 20260729;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  for (let i = 0; i < n; i++) {
    const mode = i % 4;
    let b, p;
    if (mode === 0) {          // as served: on the grid, a realistic book
      b = Number(logu(0.1, 50).toFixed(9));
      const be = 1 / (b + 1);
      p = Number((be + rnd() * (1 - be) * 0.98).toFixed(9));
    } else if (mode === 1) {   // off the grid entirely
      b = logu(0.1, 50);
      const be = 1 / (b + 1);
      p = be + rnd() * (1 - be) * 0.98;
    } else if (mode === 2) {   // odds at both extremes, including odds near the grid step itself
      b = logu(1e-4, 3e4);
      const be = 1 / (b + 1);
      p = be + rnd() * (1 - be) * 0.999;
    } else {                   // crowding break-even: the numerator cancels to almost nothing
      b = logu(1e-4, 50);
      const be = 1 / (b + 1);
      p = be * (1 + logu(1e-9, 1e-3));
    }
    if (!(p > 0 && p < 1 && b > 0)) continue;
    yield { mode, inputs: { winProb: p, winLossRatio: b } };
  }
}

// ── K.1 the expression is the engine's, and that is checked by running the engine's own source ────

test('K.1 the fraction the guard compares against is the engine\'s expression, term for term', () => {
  const engineSrc = readFileSync(join(ROOT, 'src', 'engine', 'sizeGate.js'), 'utf8');
  const scaleSrc = readFileSync(join(ROOT, 'src', 'util', 'scale.cjs'), 'utf8');

  // The engine states it once, on one line, with a trailing comment. The comment is dropped and
  // nothing else is: a rewrite that changed the expression would change what is captured here.
  const fromEngine = (engineSrc.match(/^\s*fullKelly = (.+?);\s*(?:\/\/.*)?$/m) || [])[1];
  const fromScale = (scaleSrc.match(/function engineKellyFraction\([^)]*\)\s*\{\s*return (.+);/) || [])[1];
  assert.ok(fromEngine, 'the engine no longer states its Kelly fraction on one line — this gate can no longer see the expression it exists to compare');
  assert.ok(fromScale, 'scale.cjs no longer states the engine expression as a single return');
  assert.equal(fromScale.replace(/\s+/g, ' ').trim(), fromEngine.replace(/\s+/g, ' ').trim(),
    'scale.engineKellyFraction has drifted from the engine line it is a copy of');

  // Not "they look the same": the engine's own source is compiled here and required to return the
  // identical double. A rearrangement that is mathematically equal and numerically different — the
  // exact defect class — passes a textual comparison only if the text is identical, and fails this one
  // on the first bet where the two orders of evaluation part. `(pw*b + pw - 1)/b` is that
  // rearrangement, and it disagrees on ordinary inputs.
  const engineFn = new Function('pw', 'b', `return ${fromEngine};`);
  let seed = 13572468;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  let checked = 0;
  for (let i = 0; i < 200000; i++) {
    // Weighted so a third of the draws sit just above break-even, where the subtraction cancels and
    // two orderings of the same algebra are most likely to disagree.
    const b = logu(1e-6, 1e5);
    const be = 1 / (b + 1);
    const p = i % 3 === 0 ? Math.min(1 - 1e-12, be * (1 + logu(1e-12, 1e-4))) : rnd();
    const a = engineFn(p, b);
    const c = scale.engineKellyFraction({ pw: p, b });
    assert.ok(Object.is(a, c), `the copy and the engine's own line disagree at p=${p} b=${b}: ${a} vs ${c}`);
    checked++;
  }
  assert.equal(checked, 200000, 'the sweep did not run — this assertion proved nothing');

  // And the OTHER half of "the same bet": the witness must read the request's own p and b, not the
  // engine's echoed `inputs` block, which carries whatever the caller sent rather than what was used.
  assert.match(readFileSync(join(ROOT, 'src', 'util', 'snark.js'), 'utf8'),
    /const fEngine = scale\.engineKellyFraction\(\{ pw: p, b \}\);/);
});

test('K.2 the display rounding the guard asks about is the engine\'s own', () => {
  let seed = 24681357;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  let checked = 0;
  for (let i = 0; i < 200000; i++) {
    // Weighted onto the 6dp boundaries, because everywhere else the two agree trivially and the
    // boundary is the only place a difference could hide.
    const x = i % 3 === 0 ? (Math.round(logu(1e-4, 1e3) * 2e6) + 1) / 2e6 : logu(1e-12, 1e4);
    assert.ok(Object.is(_internalKelly.displayRound(x), round(x, 6)),
      `the guard rounds ${x} to ${_internalKelly.displayRound(x)}; the engine displays it as ${round(x, 6)}`);
    checked++;
  }
  assert.equal(checked, 200000);
});

// ── K.3 the sweep, against the REAL engine ───────────────────────────────────────────────────────

test('K.3 the bound holds on a sweep run against the real engine, and is still tight', () => {
  const rows = [];
  for (const { mode, inputs } of synthetic(SYNTHETIC)) {
    // THE REAL ENGINE, not a recomputation of it. The served number this is measured against is
    // whatever `sizeGate` actually returns, so a divergence between the guard and the engine shows up
    // here rather than being defined away.
    //
    // MODE 0 IS SNAPPED AND THE OTHERS ARE NOT, DELIBERATELY. Mode 0 is the served path: the handler
    // runs `gridSnapFields` before the engine sees anything, so both inputs are ON the grid and the
    // bound collapses to the single rounding of the canonical solve. The first version of this sweep
    // snapped EVERY mode, which made all four shapes identical, drove the refusal count to zero, and
    // would have reported a guard that is never exercised as a guard that always passes. `witnessFor`
    // is an exported function and gate K.6 calls it with raw inputs; a bound that has only ever been
    // measured on snapped ones is a bound that has not been measured.
    const compute = mode === 0 ? gridSnapFields(inputs, ['winProb', 'winLossRatio']) : inputs;
    const r = sizeGate(compute);
    if (!r.ok || r.hasEdge !== true || !(r.fullKellyFraction > 0)) continue;
    const m = measure(compute, r.fullKellyFraction);
    if (m) rows.push({ mode, inputs: compute, ...m });
  }
  assert.ok(rows.length > SYNTHETIC * 0.5, `only ${rows.length} of ${SYNTHETIC} drawn bets produced a witness — the sweep is not exercising the guard`);
  for (const mode of [0, 1, 2, 3]) {
    assert.ok(rows.some((r) => r.mode === mode), `mode ${mode} contributed nothing — a shape this bound was written against is not being tested`);
  }

  const missed = rows.filter((r) => !r.roundsBack);
  assert.equal(missed.length, 0, `${missed.length} bets where the recomputation does not reproduce the engine, e.g. ${JSON.stringify(missed[0]?.inputs)}`);

  const broken = rows.filter((r) => !r.circuitHolds);
  assert.equal(broken.length, 0,
    `${broken.length} witnesses would not satisfy kelly.circom's own 2|R| <= b̂, e.g. ${JSON.stringify(broken[0]?.inputs)}`);

  const over = rows.filter((r) => r.used > 1);
  assert.equal(over.length, 0,
    `${over.length} of ${rows.length} bets exceed the bound they are certified under, e.g. ${over.slice(0, 2).map((r) => `${(r.used * 100).toFixed(2)}% ${JSON.stringify(r.inputs)}`).join(' | ')}`);

  // A bound the worst honest case cannot approach is not a bound, it is a ceiling nobody measured.
  const publishable = rows.filter((r) => r.publishable);
  const used = publishable.map((r) => r.used);
  assert.ok(Math.max(...used) >= 0.9, `the worst publishable bet uses only ${(Math.max(...used) * 100).toFixed(2)}% of the bound`);

  // Mode 0 is the shape a served answer actually has — both inputs snapped — so its bound must still
  // be the ONE grid rounding, not a widened constant. Asserted on the bound rather than on median
  // usage, for the reason gate W gives: usage is legitimately zero wherever the integer solve lands
  // exactly on the engine's own double.
  const mode0 = rows.filter((r) => r.mode === 0).map((r) => r.bound);
  const medianBound0 = quantile(mode0, 0.5);
  assert.ok(medianBound0 <= 8 * _internalKelly.HALF_STEP,
    `the median bound on snapped inputs is ${medianBound0.toExponential(3)}, ${(medianBound0 / _internalKelly.HALF_STEP).toFixed(1)}x the single grid rounding it should be — the guard has been widened`);

  // And the refusal is a real behaviour, not a branch nothing reaches: the sweep must contain bets
  // the grid genuinely cannot pin, or K.6's unpinnable case is the only evidence it works.
  const unpinnable = rows.filter((r) => !r.publishable);
  assert.ok(unpinnable.length > 0, 'no bet in the sweep was refused as unpinnable — the sweep does not reach the region the refusal exists for');

  // THE SERVED PATH IS THE TIGHT ONE, AND THAT IS WORTH ASSERTING RATHER THAN NOTICING. Every mode-0
  // bet — every bet a caller can actually be served, because the handler snaps — is publishable, and
  // the refusals all come from the off-grid shapes. If a snapped bet ever became unpinnable, the grid
  // would have stopped being fine enough for this identity and the service would be silently refusing
  // proofs for ordinary requests.
  const mode0Rows = rows.filter((r) => r.mode === 0);
  assert.equal(mode0Rows.filter((r) => !r.publishable).length, 0,
    'a bet whose inputs are already on the grid was refused as unpinnable — the served path has stopped being provable');

  const refusedOdds = unpinnable.map((r) => r.inputs.winLossRatio);
  console.log(`  K.3  ${rows.length} bets against the real engine, ${publishable.length} publishable, 0 over the bound`);
  console.log(`       worst ${(Math.max(...used) * 100).toFixed(3)}%, median ${(quantile(used, 0.5) * 100).toFixed(2)}%, p99 ${(quantile(used, 0.99) * 100).toFixed(2)}% of the bound`);
  console.log(`       bound: on-grid median ${medianBound0.toExponential(2)} (${(medianBound0 / _internalKelly.HALF_STEP).toFixed(2)}x one grid rounding), worst overall ${Math.max(...rows.map((r) => r.bound)).toExponential(2)}`);
  console.log(`       served shape (mode 0, snapped): ${mode0Rows.length} bets, ${mode0Rows.filter((r) => r.publishable).length} publishable, worst ${(Math.max(...mode0Rows.map((r) => r.used)) * 100).toFixed(3)}% of bound`);
  console.log(`       refused as unpinnable: ${unpinnable.length}, all off-grid, every one with odds in [${Math.min(...refusedOdds).toExponential(2)}, ${Math.max(...refusedOdds).toExponential(2)}]`);
});

// ── K.4 / K.5 a real proof, through the service, and the half that can fail ───────────────────────

// p = 0.55, b = 1.2 gives f* = 0.175 EXACTLY, which the live engine also returns. A case where the
// arithmetic is exact makes a residual of anything other than zero immediately suspicious — and it is
// `size-gate#0`, one of the two content hashes pinned in three separate gates, so K.7 can assert the
// same request is unmoved.
const WORKED = { winProb: 0.55, winLossRatio: 1.2, bankroll: 10000 };

let PROVEN = null;
async function proveThroughTheService() {
  if (PROVEN) return PROVEN;
  const env = await byName['size-gate'].run({ ...WORKED, snark: true });
  const deadline = Date.now() + 180_000;
  // `buildKellyInBackground` reads the durable store before it writes `building`, so for the first
  // few milliseconds there is legitimately no record at all. Waiting a bounded moment for one is
  // correct; asserting on the first poll tested the scheduler rather than the guard.
  const recordBy = Date.now() + 10_000;
  for (;;) {
    const rec = await getProof(env.proof.contentHash);
    if (rec && rec.status === 'ready') { PROVEN = { env, rec }; return PROVEN; }
    if (!rec) {
      assert.ok(Date.now() < recordBy, 'the handler wrote no proof record within ten seconds — nothing was even attempted');
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    assert.notEqual(rec.status, 'unavailable', `the service refused to prove its own worked case: ${rec.error}`);
    assert.notEqual(rec.status, 'failed', `proving the worked case failed: ${rec.error}`);
    assert.ok(Date.now() < deadline, 'the proof never finished building');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('K.4 a proof built through the SERVICE verifies, and its signals are the encoded bet', async () => {
  const { env, rec } = await proveThroughTheService();
  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));

  assert.equal(rec.circuit, 'kelly', 'the record does not say which circuit it is about');
  assert.equal(env.snark.circuit, 'kelly');
  assert.equal(env.snark.verificationKey, '/proof/vk/kelly');

  const vk = verificationKey('kelly');
  assert.ok(vk && vk.protocol === 'plonk', 'no Kelly verification key is published — a proof nobody can check is decoration');
  assert.equal(await snarkjs.plonk.verify(vk, rec.publicSignals, rec.proof), true,
    'the honest proof does not verify against the published Kelly key');

  // The signals must BE the scaled inputs, or the proof is about a different bet. Layout is the
  // circuit's: [residual, tolerance, pHat, bHat, fHat].
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const asInt = (x) => { const v = BigInt(x); return v > FIELD / 2n ? v - FIELD : v; };
  const [rSig, tSig, pSig, bSig, fSig] = rec.publicSignals;
  assert.equal(rec.publicSignals.length, 5, 'the Kelly circuit publishes five signals; this is not it');
  assert.equal(BigInt(pSig), 550000000n, 'public signal 2 is not the win probability that was sized');
  assert.equal(BigInt(bSig), 1200000000n, 'public signal 3 is not the odds that were sized');
  assert.equal(BigInt(fSig), 175000000n, 'public signal 4 is not the full-Kelly fraction that was served');
  assert.equal(scale.fromScaled(BigInt(fSig)), env.snark.fullKellyProven,
    'the fraction the response says was proven is not the fraction in the proof');
  // The exact case: the residual is zero, and the tolerance is the odds, published rather than hidden.
  assert.equal(asInt(rSig), 0n, `the worked case should have an exact residual; it is ${asInt(rSig)}`);
  assert.equal(BigInt(tSig), 1200000000n, 'the tolerance signal is not b̂ — the circuit is not publishing the bound it held R to');
  assert.equal(rec.gapToServedFraction, 0, `the certified fraction is ${rec.gapToServedFraction} from the served one on a case that is exact`);

  console.log(`  K.4  p 0.55 b 1.2 -> f* ${env.snark.fullKellyProven}; signals [${rec.publicSignals.join(', ')}]; residual 0, tolerance b̂`);
});

test('K.5 every perturbed public signal is rejected, and so is a bent proof', async () => {
  const { rec } = await proveThroughTheService();
  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const vk = verificationKey('kelly');

  let refused = 0;
  for (let i = 0; i < rec.publicSignals.length; i++) {
    const bad = [...rec.publicSignals];
    bad[i] = (BigInt(bad[i]) + 1n).toString();
    let accepted;
    try { accepted = await snarkjs.plonk.verify(vk, bad, rec.proof); } catch { accepted = false; }
    assert.equal(accepted, false, `signal[${i}] moved by one was ACCEPTED — this verifier cannot reject`);
    refused++;
  }
  assert.equal(refused, 5, 'not every signal was perturbed');

  const bent = JSON.parse(JSON.stringify(rec.proof));
  bent.A[0] = (BigInt(bent.A[0]) + 1n).toString();
  let bentAccepted;
  try { bentAccepted = await snarkjs.plonk.verify(vk, rec.publicSignals, bent); } catch { bentAccepted = false; }
  assert.equal(bentAccepted, false, 'a bent proof point was accepted');

  // And the two circuits are genuinely different keys: the liquidation key must not accept a Kelly
  // proof. Without this, a host that served the wrong vk would look fine.
  let crossAccepted;
  try { crossAccepted = await verificationKey() && await snarkjs.plonk.verify(verificationKey(), rec.publicSignals, rec.proof); } catch { crossAccepted = false; }
  assert.notEqual(crossAccepted, true, 'the LIQUIDATION key accepts a Kelly proof — the two circuits are not distinguishable and /proof/vk/kelly is decoration');

  console.log('  K.5  5 of 5 perturbed signals rejected, bent proof rejected, liquidation key rejects it');
});

// ── K.6 the refusals, each for its own reason ────────────────────────────────────────────────────

test('K.6 a bet the circuit cannot honestly speak about is refused, and says which reason', async () => {
  // (a) CONTINUOUS MODE. f* = mu/sigma^2 is a perfectly good answer and a different identity; there is
  //     no term for a mean or a variance anywhere in kelly.circom.
  const cont = await byName['size-gate'].run({ expectedReturn: 0.02, volatility: 0.1, bankroll: 10000, snark: true });
  assert.equal(cont.snark.status, 'unavailable');
  assert.match(cont.snark.reason, /DISCRETE Kelly identity/);
  assert.equal('retrieveAt' in cont.snark, false, 'an unavailable proof still advertises a retrieval URL');
  assert.equal(await getProof(cont.proof.contentHash), null, 'a continuous answer queued a proof anyway');

  // (b) NO EDGE. The engine declines to size it and the circuit excludes a zero fraction at its
  //     boundary, so there is nothing to certify.
  const flat = await byName['size-gate'].run({ winProb: 0.4, winLossRatio: 1, bankroll: 10000, snark: true });
  assert.equal(flat.result === undefined ? flat.hasEdge : flat.hasEdge, false, 'the fixture is no longer a no-edge bet');
  assert.equal(flat.snark.status, 'unavailable');
  assert.match(flat.snark.reason, /edge is non-positive/);

  // (c) A WITNESS THAT SIZES A DIFFERENT BET. The answer says one thing and the witness another; one
  //     displayed unit is the smallest lie this has to catch, and it is caught by an equality rather
  //     than by a tolerance.
  const r = sizeGate(WORKED);
  await buildKellyInBackground('gateK-wrong-answer', WORKED, round(r.fullKellyFraction + 0.000001, 6));
  const wrong = await getProof('gateK-wrong-answer');
  assert.equal(wrong.status, 'unavailable');
  assert.match(wrong.error, /refusing to certify a different bet/);
  assert.match(wrong.error, /witness sizes this bet at/);

  // (d) A BET THE GRID CANNOT PIN. At odds of 1e-4 a half-step of b moves the fraction by far more
  //     than the 5e-7 the answer is displayed to. Nothing here is dishonest and the arithmetic is
  //     sound; the grid simply cannot represent this bet tightly enough for a proof of it to be a
  //     proof of the answer.
  const unpinnable = { winProb: 0.99995, winLossRatio: 0.0001234567891 };
  const ur = sizeGate(unpinnable);
  assert.equal(ur.hasEdge, true, 'the unpinnable fixture no longer has an edge');
  const uw = kellyWitnessFor(unpinnable, ur.fullKellyFraction);
  assert.ok(uw && _internalKelly.displayRound(uw.engineFraction) === ur.fullKellyFraction,
    'the fixture must pass the same-answer check first, or this is testing the wrong refusal');
  assert.ok(uw.encodingBound > _internalKelly.DISPLAY_HALF_UNIT,
    `the fixture is pinnable after all (bound ${uw.encodingBound}) — pick a new one before trusting this case`);
  await buildKellyInBackground('gateK-unpinnable', unpinnable, ur.fullKellyFraction);
  const un = await getProof('gateK-unpinnable');
  assert.equal(un.status, 'unavailable');
  assert.match(un.error, /cannot pin this bet/);

  console.log(`  K.6  continuous -> named; no edge -> named; wrong answer -> ${wrong.error.slice(0, 60)}…`);
  console.log(`       unpinnable: bound ±${uw.encodingBound.toExponential(3)} on a fraction of ${ur.fullKellyFraction} -> refused`);
});

// ── K.7 both surfaces, and nothing that already worked moved ─────────────────────────────────────

// The two pinned size-gate hashes, restated here rather than imported. They are the SAME values gates
// C, L and V pin; a fourth independent statement of them is the point — a hash compared against
// something derived from itself proves nothing.
const PINNED = {
  '#0': 'e7442ce6867cec43d89402211a9f3df6153d3efd4c43021ddf7dfadb2b60e902',
  '#1': 'ba489cc51f9f918fc9e3e1a9e02ea79c1334b4b1c455f0f249acb9ab2748012d',
};
const FORMS = {
  '#0': { winProb: 0.55, winLossRatio: 1.2, bankroll: 10000 },
  '#1': { expectedReturn: 0.02, volatility: 0.1, bankroll: 10000 },
};

test('K.7 both surfaces carry the proof, and no content hash moved to get it', async () => {
  const mcp = async (args) => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'size_gate', arguments: args } });
    return JSON.parse(r.result.content[0].text);
  };

  for (const [form, inputs] of Object.entries(FORMS)) {
    // Without the flag: byte-identical to what this service returned before it could prove anything.
    const http = await byName['size-gate'].run(inputs);
    const free = await mcp(inputs);
    assert.equal(http.proof.contentHash, PINNED[form], `HTTP size-gate${form} moved: ${http.proof.contentHash}`);
    assert.equal(free.proof.contentHash, PINNED[form], `MCP size-gate${form} moved: ${free.proof.contentHash}`);
    assert.equal('snark' in http, false, 'a caller who asked for nothing got a snark sibling');
    assert.equal('snark' in free, false, 'a caller who asked for nothing got a snark sibling');

    // WITH the flag: the same hash. This is the trap `wantSnark` is destructured out of the request to
    // avoid — a position that hashes differently depending on whether a proof was asked for.
    const httpS = await byName['size-gate'].run({ ...inputs, snark: true });
    const freeS = await mcp({ ...inputs, snark: true });
    assert.equal(httpS.proof.contentHash, PINNED[form], `asking for a proof moved the HTTP hash for size-gate${form}`);
    assert.equal(freeS.proof.contentHash, PINNED[form], `asking for a proof moved the MCP hash for size-gate${form}`);
    assert.ok(httpS.snark, 'the HTTP surface attached no snark sibling');
    assert.ok(freeS.snark, 'the MCP surface attached no snark sibling — the forgotten fourth site again');

    // And the sibling is DECLARED. `src/util/recipe.js` derives the exclusion list from insertion
    // order, so a sibling attached after the envelope is named without anyone maintaining a list —
    // but that is a claim, and this executes it: the response's own published recipe must reproduce
    // its own published hash with the sibling present.
    assert.ok(freeS.proof.excludedFromContentHash.includes('snark'),
      `the MCP response attached \`snark\` and did not declare it: ${JSON.stringify(freeS.proof.excludedFromContentHash)}`);
    const followed = followPublishedRecipe(freeS);
    assert.equal(followed.ok, true,
      `the response carrying a snark sibling fails its own published recipe: recomputed ${followed.recomputed}, published ${followed.published}`);
  }

  // The two surfaces must also agree with EACH OTHER on the proof they offer, not merely each be
  // self-consistent. This is where perp-gate diverged for days.
  const a = await byName['size-gate'].run({ ...FORMS['#0'], snark: true });
  const b = await mcp({ ...FORMS['#0'], snark: true });
  for (const k of ['protocol', 'circuit', 'status', 'retrieveAt', 'verificationKey', 'fullKellyProven', 'proves', 'doesNotProve']) {
    assert.deepEqual(a.snark[k], b.snark[k], `the two surfaces disagree about \`${k}\` on the same request`);
  }

  console.log(`  K.7  size-gate#0 ${PINNED['#0'].slice(0, 12)}… and #1 ${PINNED['#1'].slice(0, 12)}… unmoved on both surfaces, with and without the flag`);
});

// ── K.8 the retrieval routes, over real HTTP ─────────────────────────────────────────────────────

test('K.8 a third party can fetch the Kelly proof and the key that checks it, and the liquidation shape did not move', async () => {
  // K.4 goes through the HANDLER. This goes through the ROUTES, because `src/app.js` is where the
  // second circuit could most easily be given the first circuit's verification key — a mistake that
  // produces a failed verification with no reason attached, which reads exactly like a forged proof.
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { rec } = await proveThroughTheService();
    const { env } = await proveThroughTheService();

    // The Kelly key is served, is a real key, and is NOT the liquidation key.
    const kellyVk = await (await fetch(`${base}/proof/vk/kelly`)).json();
    const liqVk = await (await fetch(`${base}/proof/vk`)).json();
    assert.equal(kellyVk.protocol, 'plonk');
    assert.equal(kellyVk.circuit, 'kelly');
    assert.equal(kellyVk.verificationKey.nPublic, 5, 'the key served for the Kelly circuit does not take five public signals');
    assert.equal(liqVk.verificationKey.nPublic, 8, 'the liquidation key at /proof/vk moved');
    assert.notDeepEqual(kellyVk.verificationKey, liqVk.verificationKey,
      '/proof/vk/kelly is serving the liquidation key — a verifier following it gets a failure with no reason, which reads as a forged proof');

    // An unknown circuit refuses and NAMES the ones that exist, rather than leaving a caller holding
    // a proof with no way to find the right URL.
    const bad = await fetch(`${base}/proof/vk/blackscholes`);
    assert.equal(bad.status, 404);
    const badBody = await bad.json();
    // WRITTEN OUT, NOT COUNTED, for the reason preflight's proof-emitting set is: this list is
    // published to anyone holding a proof they cannot check, so a circuit joining it is a decision.
    // It went red the moment `concentration` was added, which is the behaviour that makes it worth
    // having — a silently growing list of keys is a list nobody chose.
    assert.deepEqual(badBody.available, ['liquidation', 'kelly', 'concentration']);

    // The proof itself, fetched by a party who never saw the answer.
    const served = await (await fetch(`${base}/proof/${env.proof.contentHash}`)).json();
    assert.equal(served.status, 'ready');
    assert.equal(served.circuit, 'kelly', 'the retrieval route does not say which identity this proof is about');
    assert.equal(served.verificationKey, '/proof/vk/kelly');
    assert.equal(served.gapToServedPrice, undefined, 'a Kelly proof is carrying a field named for a price');
    assert.equal(served.gapToServedFraction, 0);
    assert.deepEqual(served.signalLayout, ['residual', 'tolerance', 'pHat', 'bHat', 'fHat']);
    assert.match(served.onChain.contract, /uint256\[5\] publicSignals/,
      'the on-chain instruction quotes the wrong number of public signals — it cannot compile against this circuit');
    assert.deepEqual(served.publicSignals, rec.publicSignals);

    // AND THE LIQUIDATION SHAPE DID NOT MOVE. gates/gateS-live-input-snark.mjs pins this exact key
    // list; restated here because this gate is the one that changed the route, and a pin in the file
    // that made the change is worth less than a pin in the file that did not — so both exist.
    const appendixC = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };
    const perp = await byName['perp-gate'].run({ ...appendixC, snark: true });
    assert.equal(perp.proof.contentHash, '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960',
      'Appendix C moved — the exhibit the paper invites a reader to re-derive no longer reproduces');
    const perpDeadline = Date.now() + 180_000;
    for (;;) {
      const pr = await getProof(perp.proof.contentHash);
      if (pr && pr.status === 'ready') break;
      assert.ok(Date.now() < perpDeadline, `the liquidation proof never finished: ${pr && pr.status}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const perpServed = await (await fetch(`${base}/proof/${perp.proof.contentHash}`)).json();
    assert.deepEqual(Object.keys(perpServed), [
      'status', 'contentHash', 'protocol', 'proof', 'publicSignals',
      'encodedInputs', 'gapToServedPrice', 'signalsAttestation',
      'verificationKey', 'verify', 'onChain',
    ], 'teaching this route a second circuit moved the shape of the first one');
    assert.equal(perpServed.verificationKey, '/proof/vk');
    assert.match(perpServed.onChain.contract, /uint256\[8\] publicSignals/);

    console.log(`  K.8  /proof/vk/kelly nPublic 5 vs /proof/vk nPublic 8; Kelly record announces its circuit; Appendix C ${perp.proof.contentHash.slice(0, 12)}… and its 11-key retrieval shape unmoved`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
