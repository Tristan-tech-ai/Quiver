// GATE LP — lp-risk serves a bracket certificate, and the guard in front of it can still say no.
//
// The claim under test is narrow on purpose: lp-risk's 200-iteration bisection over a 401-point
// quadrature is not unprovable, because a bisection RESULT is certified by its BRACKET rather than by
// replaying the search. What that leaves unproven is larger than what it proves, and this gate is
// required to measure both halves rather than the flattering one.
//
// Every number printed here is computed in this run. Nothing is quoted from zk/scripts/gateLP0 or
// gateLP1 — those built their own witnesses and never touched a served response, which is the whole
// distance between "we built a circuit" and "a caller can get a proof".
//
//   node --test gates/gateLP-bracket-snark.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from '../src/services.js';
import { TOOLS } from '../src/mcp.js';
import { round } from '../src/engine/stats.js';
import { lpRisk } from '../src/engine/lpRisk.js';
import { getProof, verificationKey, flushProofWrites, stopProver, lpBracketRefusal, _internalLpBracket } from '../src/util/snark.js';
import {
  engineExpectedIl, closedFormExpectedIl, engineBreakevenVariance, engineFeeFraction,
  bracketWitnessFor, encodeBracket, findBracket, lpDisplayRound, LP_DISPLAY_HALF_UNIT, SAFETY,
} from '../src/util/lpBracket.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const svc = SERVICES.find((s) => s.name === 'lp-risk');
const tool = TOOLS.find((t) => t.name === 'lp_risk');
const CALL = { volatility: 0.05, horizonPeriods: 30, feeAprPct: 20, periodsPerYear: 365, capitalUsd: 100000 };

const silent = { error: () => {}, info: () => {}, debug: () => {}, warn: () => {} };
let snarkjs = null;
const sj = async () => (snarkjs ??= (await import('snarkjs')).default ?? await import('snarkjs'));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('LP.1 the quadrature in src/util/lpBracket.js IS the engine\'s, compiled from the engine\'s own source', async () => {
  // Not "agrees to a tolerance" and not "reproduces the served digit" — those are the per-request
  // check the served path already performs. This lifts `expectedIlNumerical` OUT of
  // src/engine/lpRisk.js as text, compiles it, and requires bit-identical agreement. Re-deriving an
  // engine expression outside the engine has been wrong three times here; a rearrangement that is
  // equal on paper and different in floating point is exactly what this catches, and nothing softer
  // would.
  const src = readFileSync(join(ROOT, 'src', 'engine', 'lpRisk.js'), 'utf8');
  const ilSrc = src.match(/^const ilOfRatio = .*$/m);
  const quadSrc = src.match(/^function expectedIlNumerical\(v\) \{[\s\S]*?^\}$/m);
  assert.ok(ilSrc, 'the engine no longer defines ilOfRatio on one line — this check is reading the wrong file');
  assert.ok(quadSrc, 'the engine no longer defines expectedIlNumerical — this check is reading the wrong file');
  const compiled = new Function(`${ilSrc[0]}\n${quadSrc[0]}\nreturn expectedIlNumerical;`)();

  let worst = 0, at = 0, n = 0;
  for (let i = 0; i <= 3000; i++) {
    const v = Math.exp(Math.log(1e-8) + (Math.log(1e4) - Math.log(1e-8)) * (i / 3000));
    const a = compiled(v), b = engineExpectedIl(v);
    n++;
    if (!Object.is(a, b)) { const d = Math.abs(a - b); if (d > worst) { worst = d; at = v; } }
  }
  console.log(`  LP.1  ${n} variances, bit-identical to the engine's own compiled source: ${worst === 0 ? 'ALL' : `worst gap ${worst.toExponential(3)} at v=${at}`}`);
  assert.equal(worst, 0, `the transcription has drifted from the engine by ${worst} at v=${at}`);
});

test('LP.2 the guard\'s constants are properties of the engine\'s own rounding, not choices', () => {
  // `breakevenVolatility: round(breakevenSigma, 5)` — the 5 is in src/engine/lpRisk.js, and this
  // constant is that 5, halved. Read out of the engine's source so a change there fails here.
  const src = readFileSync(join(ROOT, 'src', 'engine', 'lpRisk.js'), 'utf8');
  const m = src.match(/breakevenVolatility:\s*breakevenSigma == null \? null : round\(breakevenSigma,\s*(\d+)\)/);
  assert.ok(m, 'the engine no longer publishes breakevenVolatility through round(breakevenSigma, dp)');
  const dp = Number(m[1]);
  assert.equal(LP_DISPLAY_HALF_UNIT, 0.5 * 10 ** -dp, `the display half-unit must be half of 1e-${dp}`);
  console.log(`  LP.2  the engine displays the breakeven at ${dp} dp, so the half-unit is ${LP_DISPLAY_HALF_UNIT}`);

  // And it is NOT any of the other five guards' constants. A bound sized off the liquidation
  // half-cent would admit a breakeven 5,000 grid steps away; off the Kelly half-millionth it would
  // refuse most of the domain.
  assert.notEqual(LP_DISPLAY_HALF_UNIT, 0.005);
  assert.notEqual(LP_DISPLAY_HALF_UNIT, 0.5e-6);

  // The display rounding reproduced here must be the engine's, weighted onto the boundaries where a
  // reproduction that is merely close stops agreeing.
  let mismatch = 0;
  for (let k = 0; k < 40000; k++) {
    const base = Math.random() * 2;
    const x = k % 2 === 0 ? base : Math.round(base * 1e5) / 1e5 + (Math.random() - 0.5) * 1e-10;
    if (lpDisplayRound(x) !== round(x, dp)) mismatch++;
  }
  assert.equal(mismatch, 0, `the reproduced display rounding disagrees with the engine's on ${mismatch} of 40,000 values`);
  assert.equal(_internalLpBracket.DISPLAY_HALF_UNIT, LP_DISPLAY_HALF_UNIT);
  console.log('  LP.2  40,000 values, half of them on a 5th-decimal boundary: the reproduced rounding is the engine\'s');
});

test('LP.2b the bound is the CORNER evaluation, recomputed independently — not a derivative', () => {
  // The defect this repository has shipped and documented: a first-order sensitivity term is not an
  // upper bound where the function is concave, and sigma(v) = sqrt(v/T) is concave. So the shipped
  // bound is recomputed here from the encoded integers alone and required to be bit-equal, and the
  // linearisation is computed beside it and required to be SMALLER — which is what makes it wrong.
  const f = engineFeeFraction(CALL);
  const br = findBracket(f, CALL.horizonPeriods, { targetSigma: lpRisk(CALL).feeVsDivergence.breakevenVolatility });
  assert.ok(!br.refused, br.refused);
  const S = 1e9, T = CALL.horizonPeriods;
  const sigOf = (x) => Math.sqrt(Math.max(0, x) / T);
  const m = Number(br.encoded.vStarHat) / S;
  let corner = 0;
  for (const x of [m - 1 / S, m + 1 / S]) for (const y of [br.lo, br.hi]) corner = Math.max(corner, Math.abs(sigOf(x) - sigOf(y)));
  assert.ok(Object.is(corner, br.bracketTerm), `the shipped bracket term ${br.bracketTerm} is not the corner maximum ${corner}`);
  const linear = ((br.hi - br.lo) / 2 + 1 / S) / (2 * Math.sqrt(m * T));
  console.log(`  LP.2b corner ${corner.toExponential(6)} · linearisation ${linear.toExponential(6)} · ratio ${(linear / corner).toFixed(6)}`);
  assert.ok(linear < corner, 'the linearisation is not smaller here, so this check would not detect the substitution');
});

test('LP.3 the closed form for the block that is NOT proven, measured against the engine', () => {
  // E[IL](v) = exp(-v/8) - 1 exactly. This is the one-line check the response's doesNotProve invites a
  // reader to perform on the two ASSUMED endpoint values, so the agreement it claims is measured here
  // rather than quoted — and the same measurement is the reason the closed form is NOT what gets
  // encoded: on a 1e-9 grid a gap above one grid step would certify a bracket around the root of a
  // different function from the one the engine bisected.
  let worst = 0, at = 0;
  for (let i = 0; i <= 20000; i++) {
    const v = Math.exp(Math.log(1e-8) + (Math.log(1e4) - Math.log(1e-8)) * (i / 20000));
    const d = Math.abs(closedFormExpectedIl(v) - engineExpectedIl(v));
    if (d > worst) { worst = d; at = v; }
  }
  // The ceiling is not a tolerance: |IL| <= 1, so the truncation cannot exceed the Gaussian weight the
  // engine's |z| <= 6 window discards. Computed here, not looked up.
  const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const droppedWeight = 2 * phi(6) * (1 / 6 - 1 / 6 ** 3 + 3 / 6 ** 5 - 15 / 6 ** 7);
  console.log(`  LP.3  worst |closed - engine| = ${worst.toExponential(6)} at v=${at}`);
  console.log(`  LP.3  dropped weight outside |z|<=6 = ${droppedWeight.toExponential(6)}; the gap is ${(worst / droppedWeight * 100).toFixed(2)}% of it`);
  assert.ok(worst < droppedWeight, 'the gap exceeds the truncated tail weight, so it is not the engine\'s window truncation');
  assert.ok(worst > 1e-9, 'the gap is under one grid step, which would make the closed form safe to encode — the header of lpBracket.js argues the opposite and would need rewriting');
  // And the closed form solves the breakeven outright, which is why the bisection is a search and not
  // a necessity: v* = -8 ln(1-f).
  let worstBe = 0, nBe = 0;
  for (let k = 1; k <= 400; k++) {
    const f = k / 401;
    const mine = engineBreakevenVariance(f);
    if (mine == null) continue;
    nBe++;
    worstBe = Math.max(worstBe, Math.abs(mine - -8 * Math.log1p(-f)));
  }
  console.log(`  LP.3  over ${nBe} fee levels, |bisected v* - (-8 ln(1-f))| worst ${worstBe.toExponential(4)}`);
  assert.ok(nBe > 300);
});

test('LP.4 the SERVED handler builds a proof, it verifies, and every tampering is refused', async () => {
  const s = await sj();
  const env = svc.run({ ...CALL, snark: true });
  assert.equal(env.snark.status, 'building');
  assert.equal(env.snark.circuit, 'lpbracket');
  assert.equal(env.snark.retrieveAt, `/proof/${env.proof.contentHash}`);
  assert.ok(!('snark' in env.proof.inputs), 'the delivery flag must not enter the hashed inputs');

  let rec = null;
  for (let i = 0; i < 400; i++) {
    rec = await getProof(env.proof.contentHash);
    if (rec && rec.status !== 'building') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(rec?.status, 'ready', `the served path produced no proof: ${rec?.status} ${rec?.error || ''}`);
  assert.equal(rec.publicSignals.length, 13);
  const vk = verificationKey('lpbracket');
  assert.ok(vk, 'no verification key for lpbracket is published');
  assert.equal(await s.plonk.verify(vk, rec.publicSignals, rec.proof), true, 'the honest proof does not verify');

  let refused = 0;
  for (let k = 0; k < rec.publicSignals.length; k++) {
    const bad = [...rec.publicSignals];
    bad[k] = (BigInt(bad[k]) + 1n).toString();
    if (!(await s.plonk.verify(vk, bad, rec.proof, silent))) refused++;
  }
  assert.equal(refused, rec.publicSignals.length, `only ${refused} of ${rec.publicSignals.length} moved signals were refused`);
  const bent = JSON.parse(JSON.stringify(rec.proof));
  bent.A[0] = (BigInt(bent.A[0]) + 1n).toString();
  assert.equal(await s.plonk.verify(vk, rec.publicSignals, bent, silent), false, 'a bent proof point verified');
  console.log(`  LP.4  proof ready · 13 signals · honest verifies · ${refused}/13 moved signals refused · bent point refused`);

  // The certified figure IS the served one at the precision it was served, and the full-precision
  // value is published because the served one is rounded three orders of magnitude coarser than the
  // bound.
  const served = env.feeVsDivergence.breakevenVolatility;
  assert.equal(lpDisplayRound(rec.certifiedBreakevenVolatility), served);
  assert.ok(rec.gapToServedBreakeven <= LP_DISPLAY_HALF_UNIT, `the certified figure sits ${rec.gapToServedBreakeven} from the served one, past the display half-unit`);
  assert.ok(rec.gapToEngineBreakeven <= rec.encodingBound);
  assert.ok(rec.encodingBound <= rec.displayHalfUnit);
  console.log(`  LP.4  certified ${rec.certifiedBreakevenVolatility} · served ${served} · gap to engine ${rec.gapToEngineBreakeven.toExponential(3)} · bound ${rec.encodingBound.toExponential(3)} (${(rec.boundUsed * 100).toFixed(2)}% of the display half-unit)`);

  // THE UNPROVEN HALF IS PUBLISHED, in the signals and on the record. This is the assertion that keeps
  // the honesty statement from being decoration: the two assumed values must be findable.
  const a = rec.assumedEndpointExpectations;
  assert.ok(rec.publicSignals.includes(a.lHatLo) && rec.publicSignals.includes(a.lHatHi),
    'the two ASSUMED expectation values are not among the public signals, so a reader cannot see what was not proven');
  assert.ok(Math.abs(a.closedFormGapLo) < 1e-8 && Math.abs(a.closedFormGapHi) < 1e-8);
  assert.match(env.snark.doesNotProve, /PUBLIC INPUTS/);
  assert.match(env.snark.doesNotProve, /exp\(-v\/8\)/);
  assert.match(env.snark.doesNotProve, /MONOTONICITY/);
  assert.match(env.snark.doesNotProve, /realizedIL/);
  console.log(`  LP.4  the two assumed values are public signals ${a.lHatLo} and ${a.lHatHi}; the closed form reproduces them to ${Math.max(a.closedFormGapLo, a.closedFormGapHi).toExponential(3)}`);
});

test('LP.4b the ENCODED endpoint values are the engine\'s quadrature and not the exact closed form', async () => {
  // THIS CHECK EXISTS BECAUSE gateLP-revert PROVED IT WAS MISSING. Revert 2 substitutes
  // `closedFormExpectedIl` for `engineExpectedIl` inside `encodeBracket` — the most seductive edit
  // available here, because the closed form is EXACT and the quadrature is the approximation — and the
  // gate stayed green through all twelve tests. It stayed green because the substitution moves only the
  // two values the circuit does not prove, by about one grid step, while the straddle it has to satisfy
  // has 104 and 1,772 grid steps of margin. Nothing about the certified volatility changes.
  //
  // That is a real fact about what the certificate covers, and it is also a labelling defect: the
  // response calls those two signals "the engine's 401-point quadrature", and a reader checking them
  // against the engine would find a different integer. So the encoder is required to produce the
  // quadrature's integers — recomputed here from the engine's own compiled source, as LP.1 does — and
  // the check is only meaningful if the two ever DISAGREE on the grid, so that is counted too.
  const { createRequire } = await import('node:module');
  const scale = createRequire(import.meta.url)('../src/util/scale.cjs');
  const src = readFileSync(join(ROOT, 'src', 'engine', 'lpRisk.js'), 'utf8');
  const compiled = new Function(`${src.match(/^const ilOfRatio = .*$/m)[0]}\n${src.match(/^function expectedIlNumerical\(v\) \{[\s\S]*?^\}$/m)[0]}\nreturn expectedIlNumerical;`)();

  let seen = 0, wrong = 0, discriminating = 0;
  for (const horizonPeriods of [1, 7, 30, 365]) {
    for (let k = 0; k <= 60; k++) {
      const feeAprPct = Math.exp(Math.log(0.05) + (Math.log(1500) - Math.log(0.05)) * (k / 60));
      const env = svc.run({ volatility: 0.05, horizonPeriods, feeAprPct, periodsPerYear: 365 });
      if (env.feeVsDivergence?.breakevenVolatility == null) continue;
      const w = bracketWitnessFor(env.proof.inputs, env);
      if (lpBracketRefusal(w)) continue;
      seen++;
      for (const [end, hatKey] of [[w.lo, 'eLoHat'], [w.hi, 'eHiHat']]) {
        const fromEngine = scale.toScaled(compiled(end) + 1, 'engine');
        const fromClosed = scale.toScaled(closedFormExpectedIl(end) + 1, 'closed');
        if (w.encoded[hatKey] !== fromEngine) wrong++;
        if (fromEngine !== fromClosed) discriminating++;
      }
    }
  }
  console.log(`  LP.4b ${seen} served brackets · ${wrong} endpoints encoded to something other than the engine's quadrature`);
  console.log(`  LP.4b ${discriminating} of ${seen * 2} endpoints are ones where the exact closed form would encode to a DIFFERENT integer, so this check discriminates`);
  assert.equal(wrong, 0, 'an encoded endpoint value is not the engine\'s quadrature rounded onto the grid');
  assert.ok(discriminating > 0, 'on none of the swept brackets would the closed form encode differently, so this check could not detect the substitution');
  assert.ok(seen > 100);
});

test('LP.5 the witness calculator refuses every dishonest bracket, before a proof exists', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const ZK = join(ROOT, 'assets', 'zk');
  const wasm = readFileSync(join(ZK, 'lpbracket_js', 'lpbracket.wasm'));
  const build = async (w) => {
    try {
      const calc = await require(join(ZK, 'lpbracket_js', 'witness_calculator.cjs'))(wasm);
      await calc.calculateWTNSBin(w, 0);
      return true;
    } catch { return false; }
  };
  const good = bracketWitnessFor(svc.run(CALL).proof.inputs, svc.run(CALL));
  assert.ok(!good.refused, good.refused);
  assert.equal(await build(good.witness), true, 'the honest witness does not build');

  const w = good.witness;
  const S = 1000000000n;
  const bad = [
    ['a bracket that does not straddle — both ends short of the fee level', { ...w, eHiHat: String(S - BigInt(w.feeHat) + 1n) }],
    ['a reversed bracket', { ...w, loHat: w.hiHat, hiHat: w.loHat }],
    ['a root that is not the bracket midpoint', { ...w, vStarHat: String(BigInt(w.vStarHat) + 1000n) }],
    ['a volatility that is not the root of the midpoint', { ...w, sigHat: String(BigInt(w.sigHat) + 100000n) }],
    ['a width bound narrower than the bracket', { ...w, widthHat: String(BigInt(w.hiHat) - BigInt(w.loHat) - 1n) }],
    ['fees at 100% of capital, where no breakeven exists', { ...w, feeHat: String(S) }],
    ['endpoint expectations in increasing order', { ...w, eLoHat: w.eHiHat, eHiHat: w.eLoHat }],
    ['a zero horizon', { ...w, horizonT: '0' }],
    ['an expectation past the -100% bound', { ...w, eHiHat: String(S + 1n) }],
  ];
  const results = [];
  for (const [label, witness] of bad) results.push([label, await build(witness)]);
  for (const [label, built] of results) console.log(`  LP.5  ${built ? '*** BUILT ***' : 'refused'}  ${label}`);
  assert.ok(results.every(([, built]) => built === false), `${results.filter(([, b]) => b).length} dishonest witnesses built anyway`);

  // The single smallest volatility perturbation the circuit rejects — the resolution of what it pins.
  let smallest = null;
  for (let d = 1n; d <= 8n; d++) {
    if (!(await build({ ...w, sigHat: String(BigInt(w.sigHat) + d) }))) { smallest = d; break; }
  }
  console.log(`  LP.5  smallest rejected volatility perturbation: ${smallest} grid step(s) = ${Number(smallest) / 1e9}`);
  assert.ok(smallest !== null && smallest <= 4n, 'the circuit does not pin the volatility to a few grid steps');
});

test('LP.6 swept against the REAL engine: the bound holds, is tight, and the guard is reached', () => {
  // Every row calls the served handler. No recomputation stands in for the engine anywhere in here.
  const SIGMAS = [0.005, 0.02, 0.05, 0.1, 0.3, 0.8, 2];
  const TS = [1, 2, 7, 30, 90, 365, 1000];
  const APRS = [0.02, 0.5, 2, 5, 20, 60, 150, 400, 1200];
  const CONCS = [1, 3];
  let n = 0, proved = 0, engineNull = 0, ceiling = 0, encoderRefused = 0, replayDisagreed = 0, divergent = 0, digitDiffered = 0;
  let worstUsed = 0, worstUsedAt = null, worstBoundFrac = 0, worstRoot = 0, minStraddle = Infinity;
  let halvMin = Infinity, halvMax = 0;
  const reasons = {};
  for (const volatility of SIGMAS) for (const horizonPeriods of TS) for (const feeAprPct of APRS) for (const concentrationFactor of CONCS) {
    const env = svc.run({ volatility, horizonPeriods, feeAprPct, periodsPerYear: 365, concentrationFactor, capitalUsd: 100000 });
    n++;
    const fee = env.feeVsDivergence;
    if (!fee || fee.breakevenVolatility == null) { engineNull++; continue; }
    const w = bracketWitnessFor(env.proof.inputs, env);
    // THE SHIPPED GUARD, called rather than paraphrased. The first draft of this sweep re-implemented
    // the four checks here, so 882 rows measured a copy while the guard the service actually runs went
    // untested — the disease this repository names, one level up from where it usually appears.
    const refusal = lpBracketRefusal(w);
    if (refusal) {
      if (w.refused) { encoderRefused++; reasons[w.refused.slice(0, 60)] = (reasons[w.refused.slice(0, 60)] || 0) + 1; }
      else if (/replayed here lands on/.test(refusal)) replayDisagreed++;
      else if (/cannot pin this breakeven/.test(refusal)) ceiling++;
      else if (/diverges from the engine/.test(refusal)) divergent++;
      else { reasons[refusal.slice(0, 60)] = (reasons[refusal.slice(0, 60)] || 0) + 1; encoderRefused++; }
      continue;
    }
    proved++;
    if (lpDisplayRound(w.certifiedSigma) !== fee.breakevenVolatility) digitDiffered++;
    const used = w.gapToEngine / w.sigmaBound;
    if (used > worstUsed) { worstUsed = used; worstUsedAt = { volatility, horizonPeriods, feeAprPct, gapToEngine: w.gapToEngine, bound: w.sigmaBound }; }
    worstBoundFrac = Math.max(worstBoundFrac, w.boundUsed);
    worstRoot = Math.max(worstRoot, w.rootBoundUsed);
    minStraddle = Math.min(minStraddle, w.straddleMarginLo, w.straddleMarginHi);
    halvMin = Math.min(halvMin, w.halvings); halvMax = Math.max(halvMax, w.halvings);
  }
  console.log(`  LP.6  ${n} served answers · ${proved} proved · ${engineNull} have no breakeven at all · ${ceiling} refused by the ceiling · ${encoderRefused} refused by the encoder · ${replayDisagreed} replay disagreements · ${divergent} divergent`);
  for (const [k, v] of Object.entries(reasons)) console.log(`  LP.6    ${v} x ${k}`);
  console.log(`  LP.6  the DERIVED BOUND: worst honest case uses ${(worstUsed * 100).toFixed(4)}% of it, at ${JSON.stringify(worstUsedAt)}`);
  console.log(`  LP.6  the CEILING: the widest proved bound is ${(worstBoundFrac * 100).toFixed(3)}% of the ${LP_DISPLAY_HALF_UNIT} display half-unit (the search targets 1/${SAFETY} of it)`);
  console.log(`  LP.6  the circuit's OWN root tolerance: worst honest case uses ${(worstRoot * 100).toFixed(3)}%`);
  console.log(`  LP.6  straddle margin floor ${minStraddle} grid step(s) · halvings ${halvMin}..${halvMax} against the engine's 200`);
  assert.equal(divergent, 0, 'the derived bound was exceeded by an honest case');
  assert.equal(replayDisagreed, 0, 'the replayed bisection did not reproduce a served figure');
  assert.equal(digitDiffered, 0, 'a proved answer certified a volatility that displays as a different figure');
  assert.ok(proved > 500, `only ${proved} of ${n} answers could be certified`);
  // TIGHT, not generous. A bound nothing can approach cannot fail, which is the whole disease.
  assert.ok(worstUsed > 0.5, `the worst honest case uses only ${(worstUsed * 100).toFixed(2)}% of the bound — a bound nothing approaches cannot detect anything`);
  assert.ok(worstUsed <= 1);
  // And the ceiling must be REACHED. A refusal path nothing reaches is a refusal path nobody tested.
  assert.ok(ceiling > 0, 'nothing in this sweep was refused by the ceiling, so the ceiling is untested');
  assert.ok(worstBoundFrac <= 1 / SAFETY + 1e-12, 'the search returned a bracket past its own stopping rule');

  // ── ARM B, and it exists because gateLP-revert proved the sweep above cannot see revert 6 ────────
  //
  // The guard compares the certified volatility against the engine's UNROUNDED bisection rather than
  // against the served 5-decimal figure. Substituting an equality on the rounded figure left the sweep
  // above completely green — because the bracket search TARGETS the served digit and reaches it on
  // every row of that grid. So the grid was the wrong grid: the cases where the digit cannot be reached
  // are the ones where the engine's own root sits within the narrowest achievable bound of a 5th-decimal
  // boundary, and they are found by sweeping fee levels finely rather than horizons broadly.
  //
  // Measured over the fine sweep: 15 of 11,049 honest answers. They are ADMITTED here, and an equality
  // on the rounded figure would refuse every one of them — which is the RUNE defect, on a different
  // quantity.
  let nB = 0, roundedWouldRefuse = 0, guardRefused = 0, firstB = null;
  for (const horizonPeriods of [1, 2]) {
    for (let k = 0; k <= 400; k++) {
      const feeAprPct = Math.exp(Math.log(0.02) + (Math.log(2000) - Math.log(0.02)) * (k / 400));
      const env = svc.run({ volatility: 0.05, horizonPeriods, feeAprPct, periodsPerYear: 365 });
      const served = env.feeVsDivergence?.breakevenVolatility;
      if (served == null) continue;
      const w = bracketWitnessFor(env.proof.inputs, env);
      if (lpBracketRefusal(w)) { guardRefused++; continue; }
      nB++;
      if (lpDisplayRound(w.certifiedSigma) !== served) {
        roundedWouldRefuse++;
        if (!firstB) firstB = { horizonPeriods, feeAprPct, served, certified: w.certifiedSigma, displaysAs: lpDisplayRound(w.certifiedSigma), gapToEngine: w.gapToEngine, bound: w.sigmaBound };
      }
    }
  }
  console.log(`  LP.6B ${nB} honest answers over a fine fee sweep · ${guardRefused} refused by the guard · ${roundedWouldRefuse} whose certified volatility cannot be made to display as the served figure`);
  console.log(`  LP.6B first such: ${JSON.stringify(firstB)}`);
  assert.ok(roundedWouldRefuse > 0, 'the fine sweep found no answer that an equality on the rounded figure would refuse, so the decision to compare against the engine\'s unrounded bisection is untested here');
  // And every one of them is inside the bound, so refusing them would be refusing correct arithmetic.
  assert.ok(firstB.gapToEngine <= firstB.bound, 'the case cited is not actually inside the bound, so it is not an example of an honest refusal');
});

test('LP.7 the ceiling refuses with a MEASURED number, and says which wall it hit', async () => {
  // sigma = sqrt(v/T) has unbounded slope at v = 0, so for a small enough breakeven variance the
  // coarsest bracket whose straddle survives the 1e-9 grid maps to a range of volatilities wider than
  // the 5 decimals the figure is published at. This is not defensive: it is reached on the served path.
  const tiny = { volatility: 0.05, horizonPeriods: 1, feeAprPct: 0.0001, periodsPerYear: 365, snark: true };
  const env = svc.run(tiny);
  assert.equal(env.snark.status, 'building', 'this refusal needs the witness, so the response cannot predict it');
  let rec = null;
  for (let i = 0; i < 200; i++) { rec = await getProof(env.proof.contentHash); if (rec && rec.status !== 'building') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(rec?.status, 'unavailable', `expected the ceiling to refuse; got ${rec?.status}`);
  assert.match(rec.error, /cannot pin this breakeven tighter than/);
  const num = Number((rec.error.match(/tighter than ±([0-9.e+-]+)/) || [])[1]);
  assert.ok(Number.isFinite(num) && num > LP_DISPLAY_HALF_UNIT, 'the refusal does not carry a number bigger than the ceiling it cites');
  console.log(`  LP.7  refused: the grid cannot pin this breakeven tighter than ±${num}, against the ${LP_DISPLAY_HALF_UNIT} the field is published to (${(num / LP_DISPLAY_HALF_UNIT).toFixed(1)}x)`);

  // And the four refusals a reader can see WITHOUT a witness are each named rather than collapsed.
  const named = [
    [{ priceRatio: 1.4, snark: true }, /no feeVsDivergence block/],
    [{ volatility: 0.5, horizonPeriods: 30, snark: true }, /no feeVsDivergence block/],
    [{ volatility: 0.5, horizonPeriods: 365, feeAprPct: 200, periodsPerYear: 365, snark: true }, /No breakeven exists/],
    [{ volatility: 0.05, horizonPeriods: 30.5, feeAprPct: 20, snark: true }, /integer count of periods/],
  ];
  for (const [body, re] of named) {
    const e = svc.run(body);
    assert.equal(e.snark.status, 'unavailable');
    assert.match(e.snark.reason, re, `the refusal for ${JSON.stringify(body)} does not say why`);
  }
  console.log(`  LP.7  ${named.length} witness-free refusals each name their own reason`);
});

test('LP.8 monotonicity — the property that makes the straddled root UNIQUE, which no proof supplies', () => {
  // The response's doesNotProve says monotonicity is established by sweep and not by the circuit, so
  // the sweep is run here rather than cited.
  //
  // AND IT IS NOT STRICT EVERYWHERE. `zk/build/gateLP1-bracket-sweep.json` publishes
  // `nonDecreasingSteps: 0` over 20,001 log-spaced v in this same range, and reading that as "strictly
  // decreasing" is an overclaim: the field counts steps where the value INCREASES, and the first draft
  // of this check asked for STRICT decrease and found 2,673 of 20,000 steps flat. They are the
  // saturated floor — past v ≈ 293, exp(-v/8) underflows the 2.2e-16 resolution of a double near 1 and
  // the quadrature returns exactly -1, so consecutive nodes are equal.
  //
  // That does not break uniqueness, and the reason has to be CHECKED rather than asserted. The second
  // draft of this check assumed every flat step sat at exactly -1 and found 49 that did not: near the
  // floor the value is within an ulp of -1 without being -1, so two adjacent log-spaced nodes land on
  // the same double from v ≈ 240 onward while exactly -1 arrives later. So the right statement is not
  // about -1 but about L = 1 + E[IL]: a flat run can only fail to be a root of g(v) = E[IL](v) + f if
  // its L is below every L a root can sit at. The steepest fee fraction the 1e-9 grid can express is
  // 1 - 1e-9, whose root is at L = 1e-9, so every flat step must have L < 1e-9 — measured below, with
  // the largest L among the flat steps printed so the margin is visible rather than implied.
  const L_DEEPEST_ROOT = 1e-9;              // f = 1 - 1e-9, the steepest expressible fee level
  let increasing = 0, flat = 0, flatAboveDeepest = 0, firstFlatAt = null, lastStrictAt = 0, worstFlatL = 0;
  let prev = engineExpectedIl(1e-8), prevV = 1e-8, n = 0;
  const N = 20001;
  for (let i = 1; i < N; i++) {
    const v = Math.exp(Math.log(1e-8) + (Math.log(1e4) - Math.log(1e-8)) * (i / (N - 1)));
    const cur = engineExpectedIl(v);
    n++;
    if (cur > prev) increasing++;
    else if (cur === prev) {
      flat++;
      if (firstFlatAt === null) firstFlatAt = prevV;
      const L = 1 + cur;                    // exact: two doubles within a factor of two (Sterbenz)
      if (L > worstFlatL) worstFlatL = L;
      if (!(L < L_DEEPEST_ROOT)) flatAboveDeepest++;
    } else lastStrictAt = v;
    prev = cur; prevV = v;
  }
  console.log(`  LP.8  ${n} steps over log-spaced v in [1e-8, 1e4]: ${increasing} increasing · ${flat} flat · ${flatAboveDeepest} flat at an L a root could sit at`);
  console.log(`  LP.8  flatness begins at v ≈ ${firstFlatAt}; the last strictly decreasing step is at v ≈ ${lastStrictAt}`);
  console.log(`  LP.8  the largest L among the flat steps is ${worstFlatL.toExponential(4)}, against the ${L_DEEPEST_ROOT} where the steepest expressible fee puts its root — ${(L_DEEPEST_ROOT / worstFlatL).toExponential(2)}x of margin`);
  assert.equal(increasing, 0, 'expected divergence increases with variance somewhere in the swept range');
  assert.equal(flatAboveDeepest, 0, `${flatAboveDeepest} flat steps sit at an L that an expressible fee level could root at — that plateau admits a non-unique root`);
  assert.ok(flat > 0, 'no flat step was found, which contradicts exp(-v/8) underflowing a double — this check is not reading what it thinks it is');
  // And the same statement in variance, so it is legible: the deepest root any expressible fee level
  // can have is well short of where the double stops resolving.
  const deepestRootV = -8 * Math.log(L_DEEPEST_ROOT);
  console.log(`  LP.8  the deepest root any expressible fee level can have is v = ${deepestRootV.toFixed(4)}, below the flat region at v ≈ ${firstFlatAt}`);
  assert.ok(deepestRootV < firstFlatAt, 'the flat region is reachable by a root, so uniqueness is not established');
});

test('LP.9 both surfaces publish the same claim, and no content hash moves', () => {
  const http = svc.run({ ...CALL, snark: true });
  const mcp = tool.run({ ...CALL, snark: true });
  assert.equal(mcp.proof.contentHash, http.proof.contentHash);
  assert.equal(mcp.snark.proves, http.snark.proves, 'the two surfaces publish different `proves` text');
  assert.equal(mcp.snark.doesNotProve, http.snark.doesNotProve, 'the two surfaces publish different `doesNotProve` text');
  assert.equal(mcp.snark.circuit, 'lpbracket');
  assert.notEqual(mcp.snark.note, http.snark.note, 'the notes are identical, so one of them is describing the wrong surface');

  // The flag is a delivery preference and must not move a hash. Both pinned fixtures re-measured.
  const plain = svc.run(CALL);
  assert.equal(plain.proof.contentHash, http.proof.contentHash, 'asking for a proof moved the content hash');
  assert.equal(plain.snark, undefined, 'an unasked-for answer grew a snark block');
  const PINNED = {
    'lp-risk#0': ['e65cd458168072c2874335a9a3c177714f228a535e75ff947ccc12c3bd6277ba', { priceRatio: 1.4, feeAprPct: 20 }],
    'lp-risk#1': ['c3997db9b86ea5beaedf1d3af41e73d3013020221c73fb2d270c122625e2f332', { volatility: 0.5, horizonPeriods: 30 }],
  };
  for (const [name, [hash, body]] of Object.entries(PINNED)) {
    const got = svc.run(body).proof.contentHash;
    assert.equal(got, hash, `${name} moved: ${hash} -> ${got}`);
    const withFlag = svc.run({ ...body, snark: true }).proof.contentHash;
    assert.equal(withFlag, hash, `${name} moved when a proof was requested: ${hash} -> ${withFlag}`);
  }
  console.log(`  LP.9  both pinned fixtures unmoved with and without the flag; the two surfaces publish one claim`);
});

test('LP.10 the encoder refuses rather than certifying something adjacent', () => {
  // Each of these is a bracket that cannot be honestly expressed, and each must come back as a
  // sentence rather than as a witness. An encoder that returns SOMETHING for every input is the
  // failure mode this list exists against.
  const cases = [
    ['a fee fraction of zero', () => encodeBracket({ feeFrac: 0, T: 30, lo: 0.1, hi: 0.2 }), /round to zero|no fee level/],
    ['a fee fraction at 100% of capital', () => encodeBracket({ feeFrac: 1, T: 30, lo: 0.1, hi: 0.2 }), /at or above 100%/],
    ['a bracket one grid step wide', () => encodeBracket({ feeFrac: 0.01, T: 30, lo: 0.1, hi: 0.100000001 }), /two grid steps/],
    ['a fractional horizon', () => encodeBracket({ feeFrac: 0.01, T: 30.5, lo: 0.1, hi: 0.2 }), /whole number of periods/],
    ['a horizon past the circuit\'s 24 bits', () => encodeBracket({ feeFrac: 0.01, T: 2 ** 25, lo: 0.1, hi: 0.2 }), /24-bit horizon/],
    ['a bracket that does not straddle', () => encodeBracket({ feeFrac: 0.5, T: 30, lo: 0.1, hi: 0.2 }), /straddle|does not survive/],
    ['a variance past the circuit\'s 46 bits', () => encodeBracket({ feeFrac: 0.01, T: 30, lo: 1e5, hi: 2e5 }), /46-bit variance|straddle|-100%/],
    // The steepest fee level the grid can express: 1 - 1e-9 rounds UP to 1e9 = SCALE, so the encoded
    // fee is at 100% of capital and there is nothing to catch it.
    ['a fee fraction one grid step under 100%', () => findBracket(0.999999999999, 30), /at or above 100%/],
  ];
  for (const [label, fn, re] of cases) {
    const r = fn();
    assert.ok(r.refused, `${label} produced a witness instead of a refusal`);
    assert.match(r.refused, re, `${label} refused for the wrong reason: ${r.refused}`);
    console.log(`  LP.10 refused (${label}): ${r.refused.slice(0, 90)}`);
  }

  // AND ONE REFUSAL PATH IS UNREACHABLE, which is worth measuring rather than leaving as dead code
  // nobody has decided about. `findBracket` gives up if the doubling passes v = 1e4, and it cannot:
  // the quadrature saturates at exactly -1 well before then, so E[IL](hi) > -f becomes false at some
  // hi <= 256 for EVERY fee fraction the grid can express.
  let worstHi = 0;
  for (let k = 1; k < 1000; k++) {
    const f = k / 1000 * (1 - 1e-9);
    let hi = 1;
    while (engineExpectedIl(hi) > -f) { hi *= 2; if (hi > 1e4) break; }
    worstHi = Math.max(worstHi, hi);
  }
  console.log(`  LP.10 the doubling terminates at hi <= ${worstHi} for every one of 999 fee levels, so the v <= 1e4 give-up is unreachable`);
  assert.ok(worstHi <= 1024, `the doubling reached hi = ${worstHi}, so the 1e4 give-up may be reachable after all`);
});

test('LP.11 what this gate does NOT establish', async () => {
  // Written down in the gate rather than only in the response, because a gate that lists only its
  // successes is how a proof of a ceiling gets advertised as a proof of the number it leads with.
  const lines = [
    'that the two endpoint expectations are the true ones — they are PUBLIC INPUTS to lpbracket.circom and nothing certifies them',
    'that expectedDivergence.expectedIlPct, the percentage this service leads with, is right — it IS the quadrature that is assumed',
    'that realizedIL is right — that identity belongs to divergence.circom, which this handler does not reach',
    'that the fee arithmetic, the concentration factor, the USD figures or the verdict sentence are right',
    'anything about a caller\'s actual pool, position or realized volatility — every input is supplied',
  ];
  for (const l of lines) console.log(`  LP.11 NOT PROVEN: ${l}`);
  // The claim above is checkable in one place: the circuit's public input list must still contain the
  // two endpoint values, or the sentence has gone stale.
  const circ = readFileSync(join(ROOT, '..', '..', 'zk', 'circuits', 'lpbracket.circom'), 'utf8');
  assert.match(circ, /component main \{public \[[^\]]*eLoHat[^\]]*eHiHat[^\]]*\]\}/, 'the circuit no longer publishes the two assumed values, so doesNotProve is describing a different circuit');
  assert.match(circ, /A PUBLIC INPUT, NOT PROVEN HERE/, 'the circuit no longer says which signals it does not prove');
});

// Real proofs are built in a real forked worker, and snarkjs spins up its own bn128 curve threads on
// this side to verify them. Both have to be told to stop or the runner never exits — measured on the
// first run of this file: every test finished in 5.5 seconds and the process then hung until the
// harness killed it at 900, which reads as a broken gate rather than a leaked handle.
after(async () => {
  try { await flushProofWrites(); } catch { /* nothing queued */ }
  try { await stopProver(); } catch { /* already gone */ }
  try { await globalThis.curve_bn128?.terminate(); } catch { /* never started */ }
});
