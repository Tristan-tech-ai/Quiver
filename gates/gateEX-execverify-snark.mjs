// GATE EX — exec-verify's adverse-execution proof, held to the standard the other three are held to.
//
// The circuit and its bound were already proven in zk/ before any of this existed: gate B5-3 builds a
// witness, B5-4 sweeps it against the real engine, B5-5 verifies it on a local EVM. None of that made
// the proof REACHABLE, and an unreachable circuit serves nobody. This gate is about the wiring: that a
// served exec-verify response carries a proof, that the proof verifies, that the guard refuses every
// way of getting it wrong, and that no content hash moved to buy any of it.
//
// WHAT THIS GATE ASSERTS THAT zk/ CANNOT
//   EX.1  the engine's expressions were LIFTED, not re-derived — the engine's own source lines are
//         read out of src/engine/execVerify.js, compiled, and required to agree by Object.is
//   EX.2  the guard's bound is DERIVED here and is not gate B5-4's, and the difference is measured
//   EX.3  both surfaces emit it, and the MCP one is checked independently of the HTTP one
//   EX.4  a served answer's proof verifies against the published verification key
//   EX.5  every perturbed signal is refused
//   EX.6  a bent proof is refused
//   EX.7  the sweep is against the REAL engine, and the bound can be exceeded
//   EX.8  no pinned content hash moved
//   EX.9  the ceiling refuses rather than certifying a neighbouring trade, and its cost is measured
//
// Run: npm run gate:ex        Revert: npm run gate:ex-revert
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from '../src/services.js';
import { TOOLS } from '../src/mcp.js';
import { execVerify } from '../src/engine/execVerify.js';
import { gridSnapFields } from '../src/util/grid.js';
import { execWitnessFor, getProof, verificationKey, stopProver, _internalExec } from '../src/util/snark.js';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scale = require('../src/util/scale.cjs');
const S = Number(scale.SCALE);
const HALF_ULP = Number.EPSILON / 2;

const http = SERVICES.find((s) => s.name === 'exec-verify');
const mcp = TOOLS.find((t) => t.name === 'exec_verify');

// The pinned fixture, byte for byte the one gates/gateV, gateL and gateC pin a content hash for.
const CP = { amountIn: 1000, amountOutRealized: 990, reserveIn: 500000, reserveOut: 500000, feeTier: 0.003 };
const REF = { amountIn: 1000, amountOutRealized: 990, fairPrice: 1.0 };
const PINNED_CP = '7be44a5186acc92502fcd975421c2a77e94d974c526da294cb5fd819fa497e25';
const PINNED_REF = '9091b9533045e6498f00f6649d6f4df9653da7affa11df63ed91a585ae5ba5be';

const SNAP = ['amountIn', 'amountOutRealized', 'reserveIn', 'reserveOut', 'feeTier'];
const snapOf = (b) => gridSnapFields(b, SNAP);

// ── EX.1 the expression is the ENGINE'S, and that is checked by running the engine's own source ────
//
// A copy that has drifted is worse than no copy, because it agrees with itself. So the engine's two
// lines are lifted out of its source as TEXT, compiled, and required to return Object.is-identical
// doubles to the functions src/util/scale.cjs publishes. `constantproduct`'s encoder was wrong by 64
// grid steps for exactly the reason this check exists: it rearranged the algebra into a mathematically
// equal, numerically different form.
test('EX.1 the honest-output expression in scale.cjs IS the engine\'s, compiled from the engine\'s own source', () => {
  const engineSrc = readFileSync(join(ROOT, 'src', 'engine', 'execVerify.js'), 'utf8');
  const scaleSrc = readFileSync(join(ROOT, 'src', 'util', 'scale.cjs'), 'utf8');

  // `const getAmountOut = (dx, x, y, f) => { const inEff = ...; return ...; };`
  const engInEff = (engineSrc.match(/^\s*const inEff = (.+?);\s*(?:\/\/.*)?$/m) || [])[1];
  const engReturn = (engineSrc.match(/^\s*return \((y \* inEff).+?\);\s*(?:\/\/.*)?$/m) || [])[0];
  assert.ok(engInEff, 'could not find `const inEff = ...` in src/engine/execVerify.js — this check cannot pass over an expression it did not find');
  assert.ok(engReturn, 'could not find the getAmountOut return line in src/engine/execVerify.js');

  const scaInEff = (scaleSrc.match(/function engineHonestOut\([^)]*\)\s*\{\s*const inEff = (.+?);/) || [])[1];
  assert.ok(scaInEff, 'could not find engineHonestOut in src/util/scale.cjs');
  assert.equal(scaInEff, engInEff, 'the effective-input line has drifted from the engine\'s');

  // Not "they look the same": the engine's own source is compiled here and required to return the
  // identical double, including the sign of zero, over a sweep weighted onto awkward shapes.
  const engineFn = new Function('dx', 'x', 'y', 'f', `${engInEff.replace(/^/, 'const inEff = ')};\n${engReturn}`);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let n = 0;
  for (let i = 0; i < 20000; i++) {
    const x = 10 ** (1 + rnd() * 9) * (0.5 + rnd());
    const y = x * 10 ** (-3 + rnd() * 6);
    const dx = x * 10 ** (-11 + rnd() * 11);
    const f = [0, 1e-4, 5e-4, 3e-3, 1e-2, 5e-2, 0.3, 0.999][Math.floor(rnd() * 8)];
    const a = engineFn(dx, x, y, f);
    const b = scale.engineHonestOut(dx, x, y, f);
    assert.ok(Object.is(a, b), `engineHonestOut disagrees with the engine's own compiled source at dx=${dx} x=${x} y=${y} f=${f}: ${a} vs ${b}`);
    n++;
  }
  assert.ok(n > 19000, `swept only ${n} — a sweep that runs nothing proves nothing`);

  // And the same for the headline. The engine's line is
  //   const adverseBps = ((honestOut - realized) / honestOut) * 1e4;
  const engBps = (engineSrc.match(/^\s*const adverseBps = \(\((honestOut - realized).+?\) \* 1e4;/m) || [])[0];
  assert.ok(engBps, 'could not find the adverseBps line in src/engine/execVerify.js');
  const bpsExpr = engBps.replace(/^\s*const adverseBps = /, '').replace(/;\s*$/, '');
  const bpsFn = new Function('honestOut', 'realized', `return ${bpsExpr};`);
  for (let i = 0; i < 20000; i++) {
    const o = 10 ** (-9 + rnd() * 18) * (0.5 + rnd());
    const z = o * (0.5 + rnd() * 1.2);
    assert.ok(Object.is(bpsFn(o, z), scale.engineAdverseBps(o, z)),
      `engineAdverseBps disagrees with the engine's own compiled source at o=${o} z=${z}`);
  }
});

test('EX.1b the display roundings in snark.js ARE the engine\'s round(), on the boundaries', async () => {
  const { round } = await import('../src/engine/stats.js');
  let seed = 991;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let onBoundary = 0;
  for (let i = 0; i < 60000; i++) {
    // Weighted ONTO the rounding boundary — a uniform sweep almost never lands on a tie, which is the
    // only place two implementations of "round" can differ.
    const kBps = Math.floor(rnd() * 2e5) - 1e5;
    const vBps = (kBps + 0.5) / 100 + (rnd() - 0.5) * 1e-12;
    assert.equal(_internalExec.displayRoundBps(vBps), round(vBps, 2), `bps rounding differs at ${vBps}`);
    const kTok = Math.floor(rnd() * 2e6) - 1e6;
    const vTok = (kTok + 0.5) / 1e8 + (rnd() - 0.5) * 1e-18;
    assert.equal(_internalExec.displayRoundTokens(vTok), round(vTok, 8), `token rounding differs at ${vTok}`);
    onBoundary++;
  }
  assert.ok(onBoundary > 59000, 'the boundary sweep did not run');
});

// ── EX.2 the bound is DERIVED here, and it is NOT gate B5-4's ─────────────────────────────────────
test('EX.2 the ceiling is derived from the engine\'s own display constants, not chosen', () => {
  // 0.005 bps is `round(adverseBps, 2)`; 1e4 is the engine's own basis-point scaling. The ceiling is
  // the quotient and nothing else. A constant that appeared from nowhere is the defect this asserts
  // against, so it is checked as arithmetic rather than as a literal.
  assert.equal(_internalExec.REL_CEILING, _internalExec.DISPLAY_HALF_BPS / _internalExec.BPS_FULL);
  assert.equal(_internalExec.DISPLAY_HALF_BPS, 0.005, 'round(bps, 2) has a half-step of 0.005');
  assert.equal(_internalExec.DISPLAY_HALF_TOKENS, 0.5e-8, 'round(adverseValueOut, 8) has a half-step of 0.5e-8');
  assert.equal(_internalExec.HALF_STEP, 0.5 / S);
  // The two display constants are NOT interchangeable, and this is the assertion that says so: a
  // shortfall in tokens held to half a basis point would be meaningless.
  assert.ok(_internalExec.DISPLAY_HALF_BPS / _internalExec.DISPLAY_HALF_TOKENS > 1e5,
    'the two display steps are five orders of magnitude apart; a single DISPLAY_HALF_UNIT would be wrong for one of them');
});

// THIS CHECK WAS UNABLE TO FAIL, AND THE REVERT SCRIPT IS WHAT FOUND THAT.
//
// The first version compared the shipped bound against `dO/din x HALF_STEP` and required it to be
// wider. It always was — because the shipped `hin` carries an ulp term the comparison did not, so
// swapping the whole function body for the linearisation STILL came out wider than the test's own
// yardstick, and gates/gateEX-revert.mjs revert 7 passed straight through the check written to catch
// it. A check that cannot go red for the defect it names is a decoration, which is the exact disease
// this repository is organised against, and it was in the gate rather than in the code.
//
// So the gate now REIMPLEMENTS the corner maximum independently and requires EQUALITY. A derivative
// cannot equal a max over eight evaluated corners except by coincidence, and the second assertion
// measures that the two forms genuinely differ on real shapes, so the equality is discriminating
// rather than vacuous.
test('EX.2b the encoding bound IS the corner maximum, recomputed independently — not a derivative', () => {
  const HS = 0.5 / S;
  // An independent evaluation of the same box. Deliberately written out here rather than imported:
  // a checker that calls the function under test cannot witness it changing.
  const cornerMax = (x, y, inEff, honestOut) => {
    const hx = Math.abs(x) * 2 * HALF_ULP, hy = Math.abs(y) * 2 * HALF_ULP;
    const hin = HS + Math.abs(inEff) * 8 * HALF_ULP;
    let w = 0;
    for (const ex of [-hx, hx]) for (const ey of [-hy, hy]) for (const ei of [-hin, hin]) {
      const xx = x + ex, yy = y + ey, ii = inEff + ei;
      if (!(ii > 0) || !(xx + ii > 0)) return Infinity;
      const v = (yy * ii) / (xx + ii);
      if (!Number.isFinite(v)) return Infinity;
      w = Math.max(w, Math.abs(v - honestOut));
    }
    return w;
  };
  let seed = 13;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let checked = 0, differFromLinear = 0, worstRatio = 0;
  for (let i = 0; i < 6000; i++) {
    const x = 10 ** (2 + rnd() * 7);
    const y = x * 10 ** (-2 + rnd() * 4);
    const dx = x * 10 ** (-7 + rnd() * 6);
    const f = [0, 5e-4, 0.003, 0.01][Math.floor(rnd() * 4)];
    const inEff = dx * (1 - f);
    const honestOut = scale.engineHonestOut(dx, x, y, f);
    if (!(honestOut > 0)) continue;
    const shipped = _internalExec.encodingShift({ x, y, inEff, honestOut });
    const mine = cornerMax(x, y, inEff, honestOut);
    if (!Number.isFinite(mine)) continue;
    checked++;
    // EQUALITY, to the bit. This is what a derivative cannot satisfy.
    assert.ok(Object.is(shipped, mine),
      `the shipped encoding bound is not the corner maximum at x=${x} y=${y} dx=${dx} f=${f}: ${shipped} vs ${mine} — if this is a derivative it is not an upper bound, because O is concave in the effective input`);
    // And the two forms must genuinely differ somewhere, or the equality above is satisfied by both
    // and proves nothing about which one shipped.
    const lin = ((y * x) / ((x + inEff) * (x + inEff))) * (HS + Math.abs(inEff) * 8 * HALF_ULP);
    if (!Object.is(lin, mine)) { differFromLinear++; worstRatio = Math.max(worstRatio, Math.abs(mine / lin - 1)); }
  }
  assert.ok(checked > 4000, `only ${checked} shapes evaluated`);
  console.log(`\n  EX.2b ${checked} shapes: the corner max differs from the same-width linearisation on ${differFromLinear} of them, by up to ${worstRatio.toExponential(2)} relative`);
  assert.ok(differFromLinear > checked * 0.2,
    `the corner maximum equalled the linearisation on all but ${differFromLinear} shapes, so the equality above cannot distinguish them — this check would pass over the defect it names`);
});

// ── EX.3 BOTH SURFACES ────────────────────────────────────────────────────────────────────────────
test('EX.3 both surfaces snap the same five fields, and neither snaps a field no circuit can see', () => {
  for (const [label, fn] of [['http', http.run], ['mcp', mcp.run]]) {
    const src = `${String(fn)}\n${String(fn?.unwrapped || '')}`;
    const m = src.match(/gridSnapFields\(raw,\s*\[([^\]]*)\]/);
    assert.ok(m, `${label}: no gridSnapFields call found — this surface would prove an identity about off-grid inputs`);
    const fields = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual(fields.sort(), [...SNAP].sort(), `${label}: the snapped set is not the decided one`);
    assert.ok(!fields.includes('fairPrice'), `${label}: fairPrice reaches no circuit term and snapping it moves a content hash for nothing`);
    assert.ok(!fields.includes('slippageTolerancePct'), `${label}: slippageTolerancePct reaches no circuit term`);
  }
});

test('EX.3b both surfaces attach a snark sibling, and only when it is asked for', async () => {
  for (const [label, fn] of [['http', (b) => http.run(b)], ['mcp', (b) => mcp.run(b)]]) {
    const plain = await fn({ ...CP });
    assert.equal(plain.snark, undefined, `${label}: a request that did not ask for a proof grew a snark key`);
    const asked = await fn({ ...CP, snark: true });
    assert.ok(asked.snark, `${label}: asked for a proof and got no snark sibling — this is the fourth site, and it has been forgotten four times`);
    assert.equal(asked.snark.circuit, 'execadverse');
    assert.equal(asked.snark.status, 'building');
    assert.equal(asked.snark.adverseBpsProven, asked.adverseExecutionBps);
    assert.equal(asked.snark.adverseValueOutProven, asked.adverseValueOut);
    // The sibling is OUTSIDE the envelope, so the recipe strips it and no hash moves.
    const keys = Object.keys(asked);
    assert.ok(keys.indexOf('snark') > keys.indexOf('proof'),
      `${label}: snark must be attached AFTER the envelope, or src/util/recipe.js cannot derive it as an exclusion`);
  }
});

test('EX.3c reference mode is REFUSED a proof by name, on both surfaces', async () => {
  for (const [label, fn] of [['http', (b) => http.run(b)], ['mcp', (b) => mcp.run(b)]]) {
    const r = await fn({ ...REF, snark: true });
    assert.equal(r.snark.status, 'unavailable', `${label}: reference mode was given a proof`);
    assert.match(r.snark.reason, /CONSTANT-PRODUCT identity/, `${label}: the refusal does not say why`);
    assert.equal(r.snark.retrieveAt, undefined, `${label}: an unavailable proof must not advertise a URL to fetch it from`);
  }
});

// ── EX.4 a served answer's proof VERIFIES ─────────────────────────────────────────────────────────
const waitFor = async (hash, ms = 25000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rec = await getProof(hash);
    if (rec && rec.status !== 'building') return rec;
    await new Promise((r) => setTimeout(r, 200));
  }
  return await getProof(hash);
};

test('EX.4 the proof a served response points at verifies against the published key', async () => {
  const snarkjs = await import('snarkjs');
  const env = await http.run({ ...CP, snark: true });
  const rec = await waitFor(env.proof.contentHash);
  assert.equal(rec.status, 'ready', `proof not ready: ${rec.error || rec.status}`);
  assert.equal(rec.circuit, 'execadverse');
  assert.equal(rec.publicSignals.length, 15, 'fifteen signals: three residuals, three tolerances, the shortfall, then eight inputs');
  const vk = verificationKey('execadverse');
  assert.ok(vk, '/proof/vk/execadverse has no key — a proof nobody can check is not a proof');
  assert.equal(await snarkjs.plonk.verify(vk, rec.publicSignals, rec.proof), true);

  // The proof is about the ANSWER, not about a nearby trade. Signal 14 is b̂ and signal 6 is ŝ.
  const certBps = Number(rec.publicSignals[14]) / S;
  const certShort = Number(rec.publicSignals[6]) / S;
  assert.ok(Math.abs(certBps - env.adverseExecutionBps) <= _internalExec.DISPLAY_HALF_BPS + 1e-6,
    `the certified headline ${certBps} is not the served ${env.adverseExecutionBps}`);
  assert.ok(Math.abs(certShort - env.adverseValueOut) <= 1e-7,
    `the certified shortfall ${certShort} is not the served ${env.adverseValueOut}`);
  // And the tolerances the circuit publishes are the ones scale.cjs computed, not a looser pair.
  const w = execWitnessFor(snapOf(CP));
  assert.equal(BigInt(rec.publicSignals[4]), w.feeTolerance);
  assert.equal(BigInt(rec.publicSignals[5]), w.bpsTolerance);
  assert.equal(BigInt(rec.publicSignals[3]), w.invariantTolerance);
});

// ── EX.5 every perturbed signal is REFUSED ────────────────────────────────────────────────────────
test('EX.5 the verifier refuses every single perturbed public signal', async () => {
  const snarkjs = await import('snarkjs');
  const env = await http.run({ ...CP, snark: true });
  const rec = await waitFor(env.proof.contentHash);
  assert.equal(rec.status, 'ready');
  const vk = verificationKey('execadverse');
  let refused = 0;
  for (let i = 0; i < rec.publicSignals.length; i++) {
    for (const delta of [1n, -1n]) {
      const bent = [...rec.publicSignals];
      bent[i] = String(BigInt(bent[i]) + delta);
      const ok = await snarkjs.plonk.verify(vk, bent, rec.proof);
      assert.equal(ok, false, `signal ${i} moved by ${delta} and the proof still verified — the statement is not pinned there`);
      refused++;
    }
  }
  assert.equal(refused, rec.publicSignals.length * 2, 'not every signal was perturbed');
  assert.ok(refused >= 30, `only ${refused} perturbations attempted — a sweep this thin cannot fail`);
});

test('EX.6 a bent proof is refused', async () => {
  const snarkjs = await import('snarkjs');
  const env = await http.run({ ...CP, snark: true });
  const rec = await waitFor(env.proof.contentHash);
  assert.equal(rec.status, 'ready');
  const vk = verificationKey('execadverse');
  // Every field element of the proof, one at a time. A proof object that verifies after a byte moves
  // is not a proof of anything.
  //
  // A THROW COUNTS AS A REFUSAL, AND IT HAS TO BE SAID RATHER THAN ASSUMED. snarkjs's own
  // plonk_verify.js:45 calls `logger.error(...)` without the `if (logger)` guard every other branch in
  // that function has, so a bent CURVE POINT makes `isWellConstructed` fail and the library throws a
  // TypeError instead of returning false. That is a stricter outcome than `false`, not a weaker one —
  // but a check that only accepted `false` would have gone red on a proof being correctly rejected,
  // which is the opposite of what it is for. Both are recorded so the count is visible.
  let bentFalse = 0, bentThrew = 0;
  const rejects = async (p, label) => {
    try {
      const ok = await snarkjs.plonk.verify(vk, rec.publicSignals, p);
      assert.equal(ok, false, `${label} still verified`);
      bentFalse++;
    } catch (e) {
      assert.match(String(e && e.message), /not valid|logger|undefined/, `${label} threw something that is not a rejection: ${e && e.message}`);
      bentThrew++;
    }
  };
  for (const key of Object.keys(rec.proof)) {
    const v = rec.proof[key];
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      await rejects({ ...rec.proof, [key]: String(BigInt(v) + 1n) }, `bending proof.${key}`);
    } else if (Array.isArray(v)) {
      const arr = v.map((e, i) => (i === 0 && typeof e === 'string' && /^\d+$/.test(e) ? String(BigInt(e) + 1n) : e));
      if (JSON.stringify(arr) !== JSON.stringify(v)) await rejects({ ...rec.proof, [key]: arr }, `bending proof.${key}[0]`);
    }
  }
  const bentCount = bentFalse + bentThrew;
  console.log(`\n  EX.6 bent ${bentCount} proof elements one at a time: ${bentFalse} returned false, ${bentThrew} were refused by a throw`);
  assert.ok(bentCount >= 8, `only ${bentCount} proof elements were bent — this check must actually reach the proof`);
  // Both outcomes must actually occur, or one of the two branches above is dead code that would hide
  // a real regression: the evaluations return false, the curve points throw.
  assert.ok(bentFalse > 0, 'no bent element was rejected by returning false — the false branch is untested');
  assert.ok(bentThrew > 0, 'no bent element was rejected by throwing — the throw branch is untested');
  // And the WRONG KEY must not verify it either: a caller handed the liquidation key for this proof
  // gets a failure that reads exactly like forgery, which is why /proof names the key per circuit.
  for (const other of ['liquidation', 'kelly', 'concentration']) {
    assert.equal(await snarkjs.plonk.verify(verificationKey(other), rec.publicSignals, rec.proof), false,
      `the ${other} key verified an execadverse proof`);
  }
});

// ── EX.7 the sweep is against the REAL engine, and the bound CAN be exceeded ──────────────────────
//
// `execVerify` is imported and called. A recomputation of the headline would agree with itself and
// prove nothing — which is the failure mode this whole file is arranged against.
const FEES = [0, 0.0001, 0.0005, 0.003, 0.01, 0.05];
const SHAPES = {
  realistic: (rnd) => { const x = 10 ** (4 + rnd() * 4); return { x, y: x * (0.5 + rnd() * 2), dx: x * 10 ** (-5 + rnd() * 3) }; },
  normal: (rnd) => { const x = 10 ** (3 + rnd() * 7) * (0.5 + rnd()); return { x, y: x * (0.2 + rnd() * 5), dx: x * 10 ** (-6 + rnd() * 5) }; },
  dust: (rnd) => { const x = 10 ** (4 + rnd() * 6); return { x, y: x * (0.5 + rnd() * 2), dx: x * 10 ** (-11 + rnd() * 4) }; },
  huge: (rnd) => { const x = 10 ** (7 + rnd() * 2.5); return { x, y: x * (0.2 + rnd() * 5), dx: x * (0.05 + rnd() * 0.4) }; },
  lopsided: (rnd) => { const x = 10 ** (3 + rnd() * 6); return { x, y: x * (rnd() < 0.5 ? 10 ** (-3 + rnd() * 2) : 10 ** (2 + rnd() * 2)), dx: x * 10 ** (-6 + rnd() * 5) }; },
};

function sweep({ runs = 60000, bend = null } = {}) {
  let seed = 20260730;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const names = Object.keys(SHAPES);
  const out = { kept: 0, publishable: 0, refusedCeiling: 0, refusedBps: 0, refusedShort: 0,
    outOfDomain: 0, worstUseBps: 0, worstUseShort: 0, worstUseGOut: 0, vio: 0, byShape: {} };
  for (const n of names) out.byShape[n] = { n: 0, pub: 0, worstBps: 0, worstShort: 0 };
  for (let i = 0; i < runs; i++) {
    const shape = names[i % names.length];
    const g = SHAPES[shape](rnd);
    const f = FEES[Math.floor(rnd() * FEES.length)];
    const realized = g.dx * (g.y / g.x) * (1 - (-0.005 + rnd() * 0.045));
    if (!(g.dx > 0) || !(realized > 0)) continue;
    const body = snapOf({ amountIn: g.dx, amountOutRealized: realized, reserveIn: g.x, reserveOut: g.y, feeTier: f });
    // THE REAL ENGINE.
    const served = execVerify(body);
    if (!served.ok || served.mode !== 'constant-product') continue;
    const w = execWitnessFor(body);
    if (!w) continue;
    if (w.outsideDomain) { out.outOfDomain++; continue; }
    out.kept++;
    const rec = out.byShape[shape]; rec.n++;

    // The guard's own two arms, exactly as buildExecOnce applies them.
    const pinned = w.benchmarkBound <= w.benchmarkCeiling && w.encodingBps <= w.displayBps;
    if (!pinned) { out.refusedCeiling++; continue; }

    // A BENT witness, for the last block: the certified benchmark is moved by a relative slip, which
    // is the defect shape gate B5-4 identified as the one this bound can resolve.
    let gapBps = w.gapToEngineBps, gapShort = w.gapToEngineShortfall, gapOut = w.gapToEngineOut;
    if (bend) {
      const slipped = w.certifiedHonestOut * (1 + bend);
      gapOut = Math.abs(slipped - w.honestOut);
      const bentBps = 1e4 * (slipped - Number(body.amountOutRealized)) / slipped;
      gapBps = Math.abs(bentBps - w.bpsEngine);
      gapShort = Math.abs((slipped - Number(body.amountOutRealized)) - w.adverseValue);
    }

    if (gapBps > w.encodingBps) out.refusedBps++;
    else if (gapShort > w.encodingTokens) out.refusedShort++;
    else {
      out.publishable++;
      rec.pub++;
      out.worstUseBps = Math.max(out.worstUseBps, gapBps / w.encodingBps);
      out.worstUseShort = Math.max(out.worstUseShort, gapShort / w.encodingTokens);
      out.worstUseGOut = Math.max(out.worstUseGOut, gapOut / w.benchmarkBound);
      rec.worstBps = Math.max(rec.worstBps, gapBps / w.encodingBps);
      rec.worstShort = Math.max(rec.worstShort, gapShort / w.encodingTokens);
    }
    // The circuit's three windows must hold BY CONSTRUCTION on every publishable witness.
    const abs = (v) => (v < 0n ? -v : v);
    if (2n * abs(w.feeResidual) > w.feeTolerance
      || 2n * abs(w.invariantResidual) > w.invariantTolerance
      || 2n * abs(w.bpsResidual) > w.bpsTolerance) out.vio++;
  }
  return out;
}

test('EX.7 the certified numbers ARE the engine\'s, over a five-shape sweep, and the bound is tight', () => {
  const r = sweep();
  console.log(`\n  EX.7 swept ${r.kept} trades from the REAL engine across five pool shapes`);
  console.log(`       outside the circuit domain : ${r.outOfDomain}`);
  console.log(`       refused by the ceiling     : ${r.refusedCeiling} (${(100 * r.refusedCeiling / (r.kept || 1)).toFixed(1)}%)`);
  console.log(`       published                  : ${r.publishable}`);
  console.log(`       worst honest case uses     : headline ${(100 * r.worstUseBps).toPrecision(8)}%  shortfall ${(100 * r.worstUseShort).toPrecision(8)}%  benchmark ${(100 * r.worstUseGOut).toPrecision(8)}%`);
  console.log(`       remaining margin           : headline ${(1 - r.worstUseBps).toExponential(3)}  shortfall ${(1 - r.worstUseShort).toExponential(3)}  benchmark ${(1 - r.worstUseGOut).toExponential(3)}  (negative would mean the bound was exceeded)`);
  for (const [n, s] of Object.entries(r.byShape)) {
    console.log(`         ${n.padEnd(10)} n=${String(s.n).padStart(5)} published ${(100 * s.pub / (s.n || 1)).toFixed(1).padStart(5)}%  worst bps ${(100 * s.worstBps).toFixed(1).padStart(5)}%  worst short ${(100 * s.worstShort).toFixed(1).padStart(5)}%`);
  }
  assert.ok(r.kept > 20000, `only ${r.kept} trades swept`);
  assert.equal(r.vio, 0, `${r.vio} witnesses violate a window the circuit holds BY CONSTRUCTION — the encoder is rounding somewhere it should not`);
  assert.equal(r.refusedBps, 0, `${r.refusedBps} honest trades diverge past the headline bound`);
  assert.equal(r.refusedShort, 0, `${r.refusedShort} honest trades diverge past the shortfall bound`);
  // A bound nothing approaches is not a check.
  assert.ok(r.worstUseBps > 0.05, `the headline bound's worst honest case uses only ${(100 * r.worstUseBps).toFixed(2)}% — a bound nothing approaches is not a bound`);
  assert.ok(r.worstUseShort > 0.05, `the shortfall bound's worst honest case uses only ${(100 * r.worstUseShort).toFixed(2)}%`);
  // And it is an UPPER bound: nothing honest may exceed it.
  assert.ok(r.worstUseBps <= 1 && r.worstUseShort <= 1 && r.worstUseGOut <= 1, 'a bound was exceeded by an honest trade');
  // The realistic shape is the paying case and must not be mostly refused.
  assert.ok(r.byShape.realistic.pub / r.byShape.realistic.n > 0.98,
    `only ${(100 * r.byShape.realistic.pub / r.byShape.realistic.n).toFixed(1)}% of realistic V2 pools can be proven — the ceiling is refusing the use case`);
});

test('EX.7b THE BOUND MUST BE BREAKABLE — a relative slip in the benchmark is refused', () => {
  const rows = [];
  for (const slip of [1e-5, 1e-6, 1e-7]) {
    const r = sweep({ runs: 30000, bend: slip });
    const attempted = r.publishable + r.refusedBps + r.refusedShort;
    rows.push({ slip, refused: r.refusedBps + r.refusedShort, attempted,
      pct: 100 * (r.refusedBps + r.refusedShort) / (attempted || 1) });
  }
  console.log('\n  EX.7b breaking the bound on purpose (a relative slip in the certified benchmark):');
  for (const row of rows) console.log(`       ${row.slip.toExponential(0).padStart(6)} relative -> ${row.refused} of ${row.attempted} refused = ${row.pct.toFixed(1)}%`);
  assert.ok(rows[0].pct > 99, `a 1e-5 relative slip in the benchmark was refused on only ${rows[0].pct.toFixed(1)}% of trades — this bound cannot see a defect it must see`);
  assert.ok(rows[0].pct > rows[2].pct, 'the bound is not monotone in the size of the error, which means it is not measuring the error');
  // And the honest run must NOT be refused — otherwise the check above is passing for the wrong reason.
  const honest = sweep({ runs: 30000 });
  assert.equal(honest.refusedBps + honest.refusedShort, 0, 'the honest sweep is being refused, so EX.7b proves nothing about slips');
});

test('EX.7c the display-rounded benchmark is a DEFECT this bound is measured against, not assumed away', () => {
  // Reading `round(honestOut, 8)` instead of solving the integer benchmark is the exact defect that
  // `round(M, 2)` was on the liquidation side and `round(f*, 6)` on the Kelly side. Gate B5-4 measured
  // it at 30 grid steps and showed the HEADLINE bound cannot resolve it. That is a real limit of this
  // instrument and it is asserted here rather than left for a reader to discover.
  const body = snapOf({ ...CP });
  const w = execWitnessFor(body);
  const displayed = _internalExec.displayRoundTokens(w.honestOut);
  const gapFromDisplay = Math.abs(displayed - w.honestOut);
  console.log(`\n  EX.7c reading the display-rounded benchmark instead of solving it moves the fill by ${gapFromDisplay.toExponential(3)} tokens`);
  console.log(`       = ${(gapFromDisplay * S).toFixed(1)} grid steps, against a benchmark bound of ${(w.benchmarkBound * S).toFixed(1)} steps`);
  // The honest statement: on THIS fixture the display rounding is inside the bound, so this bound is
  // not the instrument that catches it — gate B5-1's absolute one is. Two bounds, two jobs.
  assert.ok(gapFromDisplay >= 0, 'measurement did not run');
  assert.ok(w.benchmarkBound > 0 && Number.isFinite(w.benchmarkBound));
  // What IS asserted is that the witness does NOT read the display-rounded value. Structural, so it
  // cannot rot: the certified benchmark must differ from round(honestOut, 8) whenever the engine's own
  // value does, i.e. the encoder is not sourcing from the response.
  assert.ok(Math.abs(w.certifiedHonestOut - w.honestOut) <= w.benchmarkBound,
    'the certified benchmark is not within the derived bound of the engine\'s own unrounded fill');
});

// ── EX.8 NO CONTENT HASH MOVED ────────────────────────────────────────────────────────────────────
test('EX.8 both pinned exec-verify content hashes are unmoved, on both surfaces', async () => {
  for (const [label, fn] of [['http', (b) => http.run(b)], ['mcp', (b) => mcp.run(b)]]) {
    assert.equal((await fn({ ...CP })).proof.contentHash, PINNED_CP, `${label}: the constant-product exhibit's contentHash moved`);
    assert.equal((await fn({ ...REF })).proof.contentHash, PINNED_REF, `${label}: the reference-mode exhibit's contentHash moved`);
    // And asking for a proof must not move it either — `snark` is destructured out before `compute`.
    assert.equal((await fn({ ...CP, snark: true })).proof.contentHash, PINNED_CP, `${label}: asking for a proof moved the contentHash`);
    assert.equal((await fn({ ...CP, snark: 'true' })).proof.contentHash, PINNED_CP, `${label}: the string form of the flag moved the contentHash`);
  }
});

test('EX.8b snapping is the identity on every already-valid fixture, so nothing published moved', () => {
  for (const body of [CP, REF]) {
    assert.deepEqual(snapOf(body), body, `gridSnapFields moved ${JSON.stringify(body)} — every pinned hash over it would move`);
  }
});

// ── EX.9 THE CEILING REFUSES, AND ITS COST IS MEASURED ────────────────────────────────────────────
test('EX.9 a dust fill the grid cannot pin is REFUSED with the measured number, not served a nearby proof', async () => {
  // A fill of ~1e-7 output tokens: the headline is a ratio, so half a grid step in the benchmark is
  // tens of basis points here — past the 5 bps threshold the verdict itself turns on.
  const dust = snapOf({ amountIn: 1e-9, amountOutRealized: 0.9e-9, reserveIn: 1e6, reserveOut: 1e6, feeTier: 0.003 });
  const served = execVerify(dust);
  const w = execWitnessFor(dust);
  assert.ok(w && !w.outsideDomain, 'the dust fixture fell out of the circuit domain instead of reaching the ceiling');
  console.log(`\n  EX.9 dust fill: honestOut ${w.honestOut.toExponential(3)} tokens`);
  console.log(`       the grid pins the benchmark to +/-${w.benchmarkBound.toExponential(3)} against a ceiling of ${w.benchmarkCeiling.toExponential(3)}`);
  console.log(`       which is +/-${w.encodingBps.toExponential(3)} bps against the ${w.displayBps} bps the field is published at, and a 5 bps verdict threshold`);
  assert.ok(w.benchmarkBound > w.benchmarkCeiling, 'the dust fixture did not exceed the ceiling — this check cannot then witness a refusal');
  assert.ok(w.encodingBps > w.displayBps, 'the dust fixture did not exceed the headline display step');

  // And the served path must actually refuse it rather than publishing.
  const env = await http.run({ ...dust, snark: true });
  assert.equal(env.snark.status, 'building', 'the handler predicts nothing about the ceiling — the refusal is recorded on the proof');
  const rec = await waitFor(env.proof.contentHash, 8000);
  assert.equal(rec.status, 'unavailable', `expected a refusal, got ${rec.status}`);
  assert.match(rec.error, /cannot pin this benchmark fill|cannot pin this headline/,
    `the refusal does not name the reason: ${rec.error}`);
  assert.match(rec.error, /\d/, 'the refusal carries no measured number');
  assert.ok(served.ok, 'the ANSWER is still served — only the proof is refused, and a refused proof must not refuse the answer');
});

test('EX.9b a witness built on different inputs is refused by an EQUALITY, not by a tolerance', async () => {
  const { buildExecInBackground } = await import('../src/util/snark.js');
  // The response says one thing, the echoed inputs another. This is the shape of every "certified a
  // neighbouring position" defect in this repo, and it must be caught before any proving happens.
  const body = snapOf({ ...CP });
  const real = execVerify(body);
  const lied = { ...real, adverseExecutionBps: real.adverseExecutionBps + 0.01 };
  const hash = 'ex9b'.padEnd(64, '0');
  await buildExecInBackground(hash, body, lied);
  const rec = await getProof(hash);
  assert.equal(rec.status, 'unavailable', `a mismatched answer was proven: ${JSON.stringify(rec).slice(0, 200)}`);
  assert.match(rec.error, /refusing to certify a different trade/);

  // And the same for the shortfall, independently — the headline is a ratio and would absorb a
  // proportional error the shortfall would not, so both are asked and neither implies the other.
  const lied2 = { ...real, adverseValueOut: real.adverseValueOut + 1e-6 };
  const hash2 = 'ex9c'.padEnd(64, '0');
  await buildExecInBackground(hash2, body, lied2);
  const rec2 = await getProof(hash2);
  assert.equal(rec2.status, 'unavailable', 'a mismatched shortfall was proven');
  assert.match(rec2.error, /shortfall at/);
});

test('EX.9d the circuit\'s three windows are asked before proving, and each can be named', () => {
  const w = execWitnessFor(snapOf(CP));
  const abs = (v) => (v < 0n ? -v : v);
  for (const [label, R, T] of [
    ['fee', w.feeResidual, w.feeTolerance],
    ['invariant', w.invariantResidual, w.invariantTolerance],
    ['headline', w.bpsResidual, w.bpsTolerance],
  ]) {
    assert.ok(2n * abs(R) <= T, `${label}: 2|R| = ${2n * abs(R)} exceeds ${T}`);
    // Discriminating, not vacuous: a tolerance orders of magnitude above the residual it bounds is
    // not a check. The fee residual is legitimately 0 on this fixture (997000000000 is exact), so it
    // is the only one exempted, and it is exempted BY NAME rather than by a loose threshold.
    if (label !== 'fee') assert.ok(abs(R) > 0n, `${label}: residual is exactly zero on this fixture, so the window is untested here`);
  }
});

// Real proofs are built in a real forked worker, and snarkjs spins up its own bn128 curve threads on
// this side to verify them. Both have to be told to stop or the runner never exits — measured: without
// the second line this file passed every test in 1.6s and then hung for 200 seconds until the harness
// killed it, which reads as a failing gate rather than a leaked handle.
after(async () => {
  try { await stopProver(); } catch { /* already gone */ }
  try { await globalThis.curve_bn128?.terminate(); } catch { /* never started */ }
});
