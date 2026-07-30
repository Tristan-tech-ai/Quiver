// GATE LB — lp-risk's boundedness verdict must be right on BOTH sides of the flip point.
//
// WHAT IT IS FOR. `src/engine/lpRisk.js` asserts that its reported divergence lies in (-100%, 0] and
// evaluates that assertion on `round(E[IL]*100, 4)`. Once the display value is exactly -100 the strict
// `> -100` is false, so an ordinary high-volatility LP question — 62% per-period vol over a year —
// shipped `allSelfChecksPass: false`, was declined by `isChargeable`, and told the buyer their input had
// been rejected, over an answer of -0.9999999758323288 that is strictly inside the interval. That was
// §5 of the defect register. `src/util/lpBoundedness.js` re-evaluates the verdict on the exact fraction,
// outside the hashed tree, so the build hash does not move.
//
// The correction is one-way (it can only turn a `false` into a `true`) and fail-closed (it withholds
// unless the recomputation reproduces the digit the response published). Both halves are asserted here,
// and so is the half that must NOT change: past v ~ 5961.07 the exact fraction is not representable as
// anything but -1 and the failure is real, so the call stays refused.
//
// ── WHY THIS FILE RESTATES THE CLOSED FORM INSTEAD OF IMPORTING IT ───────────────────────────────
// The rule gate V and gate L are written under: a checker that imports the function under test cannot
// witness that function changing. So `exp(-v/8)` is restated below, AND cross-checked against a
// genuinely different computation — a wide-window quadrature of `E[sech(ln r / 2)]` evaluated here in
// L-form. Two routes to the same number, neither of them the module's.
//
// The specific defect class this guards against is on the record three times on this project: an
// encoder re-derived an engine expression into a mathematically equal, numerically different form and
// was wrong by up to 64 grid steps. So the agreement is asserted over the WHOLE domain rather than at a
// sample, and the worst disagreement is printed whether or not it passes.
//
//   node --test gates/gateLB-lp-boundedness.mjs   (npm run gate:lb)
//   node gates/gateLB-revert.mjs                  (npm run gate:lb-revert)
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (...p) => pathToFileURL(join(ROOT, ...p)).href;

const { SERVICES } = await import(url('src', 'services.js'));
const { handleRpc } = await import(url('src', 'mcp.js'));
const { isChargeable } = await import(url('src', 'x402.js'));
const { lpRisk } = await import(url('src', 'engine', 'lpRisk.js'));
const { proofEnvelope, _internal } = await import(url('src', 'engine', 'proof.js'));
const { createRiskBrain } = await import(url('sdk', 'index.js'));
// The one import of the module under test: the fault-injection test has to call the corrector on a
// fabricated result, which is the only way to reach a served value the live engine cannot produce.
const { recheckLpBoundedness } = await import(url('src', 'util', 'lpBoundedness.js'));

const SVC = SERVICES.find((s) => s.name === 'lp-risk');
assert.ok(SVC, 'there is no lp-risk service — this gate describes something that is not here');

// ── the pinned truth ─────────────────────────────────────────────────────────────────────────────
const CODE_HASH = 'q1-e1fa99d08887d6cc';                    // must not move: the fix is outside src/engine
const APPENDIX_C = '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960';
const FIXTURE_PINS = {                                      // the same two gate V pins, restated
  '{"priceRatio":1.4,"feeAprPct":20}': 'e65cd458168072c2874335a9a3c177714f228a535e75ff947ccc12c3bd6277ba',
  '{"volatility":0.5,"horizonPeriods":30}': 'c3997db9b86ea5beaedf1d3af41e73d3013020221c73fb2d270c122625e2f332',
};
// Bisected, not recalled: the total variance at which the ENGINE's rounded-field check flips, and the
// closed form's own flip at -8*ln(5e-7). Between them the two round to different 4-dp figures, so the
// fail-closed guard withholds and the false failure is RETAINED — a disclosed residual gap, asserted
// below as a fact rather than described in prose.
const ENGINE_FLIP = 116.06874041832731;
const CLOSED_FLIP = -8 * Math.log(5e-7);                    // 116.06926190819375
// Where exp(-v/8) underflows to zero, so nothing can certify the served -100% is inside the interval.
const UNDERFLOW_V = 5961.07;

// ── the arithmetic, restated ─────────────────────────────────────────────────────────────────────
/** L = 1 + E[IL] = exp(-v/8). Restated here; NOT imported from the module under test. */
const closedL = (v) => Math.exp(-v / 8);
/**
 * The same quantity by a different route: E[sech(ln r / 2)] under ln r ~ N(-v/2, v), by quadrature,
 * in L-form (the ratio is summed directly and 1 is never subtracted, so nothing cancels). A WIDER
 * window than the engine's |z| <= 6, because that truncation is what the engine's own residual is.
 */
function quadratureL(v, W = 12, N = 6000) {
  const sd = Math.sqrt(v);
  let sum = 0, w = 0;
  for (let i = 0; i <= N; i++) {
    const z = -W + ((2 * W) * i) / N;
    const pdf = Math.exp(-0.5 * z * z);
    const r = Math.exp(-0.5 * v + sd * z);
    sum += pdf * (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) : 0);
    w += pdf;
  }
  return sum / w;
}
const round4 = (x) => Number(Number(x).toFixed(4));
const boundednessCheck = (r) => (r.proof?.selfChecks || r.checks || []).find((c) => /^boundedness: reported expected divergence/.test(String(c.name)));

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────
// Dense across the flip point, dense across the underflow knife-edge, and log-spaced over the whole
// reachable domain so no region is assumed to behave like its neighbour.
const T = 365;
const vGrid = [
  ...Array.from({ length: 401 }, (_, i) => 115.0 + i * 0.005),          // 115.000 .. 117.000 step 5e-3
  ...Array.from({ length: 261 }, (_, i) => 116.0685 + i * 1e-5),        // 116.06850 .. 116.07110 step 1e-5
  ...Array.from({ length: 200 }, (_, i) => 117 + i * 0.5),              // 117 .. 216.5
  ...Array.from({ length: 120 }, (_, i) => 220 + i * 5),                // 220 .. 815  (past engine saturation)
  ...Array.from({ length: 100 }, (_, i) => 5900 + i * 1.5),             // 5900 .. 6048.5 (the underflow edge)
  ...Array.from({ length: 60 }, (_, i) => Math.exp(Math.log(1e-6) + ((Math.log(1e6) - Math.log(1e-6)) * i) / 59)),
];
const rows = [];
for (const v of vGrid) {
  const sigma = Math.sqrt(v / T);
  const input = { volatility: sigma, horizonPeriods: T };
  const served = await SVC.run({ ...input });
  const raw = proofEnvelope('lp-risk', input, lpRisk(input), 'gate');       // the pre-fix path, exactly
  const c = boundednessCheck(served);
  const rawC = boundednessCheck(raw);
  const L = closedL(v);
  const pct = (L - 1) * 100;
  rows.push({
    v: served.expectedDivergence.totalVariance, vAsked: v, sigma, served, raw,
    servedPct: served.expectedDivergence.expectedIlPct,
    verdict: c?.pass, rawVerdict: rawC?.pass, corrected: !!c?.reEvaluated,
    L, exactInRange: Number.isFinite(L) && L > 0 && L <= 1, digitAgrees: round4(pct) === served.expectedDivergence.expectedIlPct,
    hashMoved: served.proof.contentHash !== raw.proof.contentHash,
    allPass: served.proof.allSelfChecksPass, chargeable: isChargeable(served),
  });
}
const corrected = rows.filter((r) => r.corrected);
const stillFailing = rows.filter((r) => r.verdict === false);
const untouched = rows.filter((r) => r.rawVerdict === true);

// ── the checks ───────────────────────────────────────────────────────────────────────────────────

test('★ the build hash has not moved — the whole point is that this fix is outside src/engine', () => {
  assert.equal(_internal.buildId(), CODE_HASH, 'src/engine changed; this correction was supposed to need no engine change');
  console.log(`    codeHash ${CODE_HASH}, ${rows.length} sweep points`);
});

test('★ the closed form IS the expectation — checked against a different computation, not asserted', () => {
  // exp(-v/8) against a 12-sigma quadrature of E[sech]. The engine's own |z| <= 6 window is the thing
  // being distrusted here, so the reference deliberately does not share it.
  let worst = 0, worstV = null;
  for (let i = 0; i <= 400; i++) {
    const v = Math.exp(Math.log(1e-6) + ((Math.log(250) - Math.log(1e-6)) * i) / 400);
    const d = Math.abs(quadratureL(v) - closedL(v));
    if (d > worst) { worst = d; worstV = v; }
  }
  console.log(`    worst |quadrature(|z|<=12, N=6000) - exp(-v/8)| = ${worst.toExponential(5)} at v = ${worstV.toExponential(5)}`);
  assert.ok(worst < 1e-12, `the closed form and an independent quadrature disagree by ${worst.toExponential(5)} — one of them is wrong`);
  // And it must be able to fail: the engine's OWN window reproduces the documented truncation floor,
  // which is six orders larger. A reference that agreed with everything would prove nothing.
  let engineWorst = 0;
  for (let i = 0; i <= 400; i++) {
    const v = Math.exp(Math.log(1e-6) + ((Math.log(250) - Math.log(1e-6)) * i) / 400);
    engineWorst = Math.max(engineWorst, Math.abs(quadratureL(v, 6, 400) - closedL(v)));
  }
  console.log(`    the same comparison at the engine's |z| <= 6, N = 400 window: ${engineWorst.toExponential(5)} — the truncation floor, and why the guard compares ROUNDED figures`);
  assert.ok(engineWorst > 1e-10, 'the |z| <= 6 window no longer shows a truncation floor, so this comparison can no longer distinguish the two windows');
});

test('★ below the flip point nothing changed at all', () => {
  const below = rows.filter((r) => r.v < ENGINE_FLIP);
  assert.ok(below.length >= 200, `only ${below.length} sweep points below the flip point`);
  const broke = below.filter((r) => r.verdict !== true || r.corrected || r.hashMoved);
  assert.equal(broke.length, 0,
    `a call below the flip point changed:\n      ${broke.slice(0, 5).map((r) => `v=${r.v} verdict=${r.verdict} corrected=${r.corrected} hashMoved=${r.hashMoved}`).join('\n      ')}`);
  console.log(`    ${below.length} points with v < ${ENGINE_FLIP}: verdict true, no correction, contentHash unmoved`);
});

test('★ no call that passed before may fail now — the one-way property, over the whole sweep', () => {
  const regressed = rows.filter((r) => r.rawVerdict === true && r.verdict !== true);
  assert.equal(regressed.length, 0, `${regressed.length} call(s) that passed pre-fix now fail`);
  const flippedWrongWay = rows.filter((r) => r.rawVerdict === false && r.verdict === false && r.corrected);
  assert.equal(flippedWrongWay.length, 0, 'a check reported as corrected is still failing');
  console.log(`    ${untouched.length} points passed pre-fix and all ${untouched.length} still pass`);
});

test('★ across the flip point the verdict is correct on BOTH sides', () => {
  // The expected verdict is derived from THIS file's closed form and rounding, not from the module.
  const wrong = rows.filter((r) => {
    const expected = r.rawVerdict === true ? true : (r.exactInRange && r.digitAgrees);
    return r.verdict !== expected;
  });
  assert.equal(wrong.length, 0,
    `the verdict disagrees with the exact fraction on ${wrong.length} call(s):\n      ${wrong.slice(0, 8).map((r) => `v=${r.v} served=${r.servedPct} L=${r.L.toExponential(3)} inRange=${r.exactInRange} digitAgrees=${r.digitAgrees} verdict=${r.verdict}`).join('\n      ')}`);
  const inBand = rows.filter((r) => r.v > ENGINE_FLIP && r.v < CLOSED_FLIP);
  const above = rows.filter((r) => r.v >= CLOSED_FLIP && r.v < UNDERFLOW_V);
  console.log(`    ${corrected.length} corrected, ${stillFailing.length} still failing, ${untouched.length} untouched`);
  console.log(`    the disclosed residual band (${ENGINE_FLIP}, ${CLOSED_FLIP}) holds ${inBand.length} sweep points`);
  assert.ok(inBand.length >= 40, `only ${inBand.length} points inside the residual band — the sweep no longer covers it`);
  assert.ok(inBand.every((r) => r.verdict === false && !r.corrected),
    'the residual band is documented as RETAINING the false failure; a point in it was corrected, so the disclosure is now wrong');
  assert.ok(above.length >= 200, `only ${above.length} points between the closed-form flip and the underflow edge`);
  assert.ok(above.every((r) => r.verdict === true && r.corrected),
    `${above.filter((r) => r.verdict !== true).length} point(s) above the closed-form flip are still failing`);
});

test('★ past the underflow edge the failure is REAL and is still refused', () => {
  // exp(-v/8) is 0 in double precision past v ~ 5961.07: the exact fraction is not representable as
  // anything but -1, the engine's own quadrature has itself saturated to exactly -1, and the served
  // -100% IS the boundary rather than a rounding of something inside it. Nothing may certify that.
  const past = rows.filter((r) => r.v > 5962);
  assert.ok(past.length >= 50, `only ${past.length} sweep points past the underflow edge`);
  const wronglyPassed = past.filter((r) => r.verdict !== false || r.corrected || r.allPass !== false || r.chargeable !== false);
  assert.equal(wronglyPassed.length, 0,
    `an unrepresentable expectation was certified as inside the interval:\n      ${wronglyPassed.slice(0, 5).map((r) => `v=${r.v} verdict=${r.verdict}`).join('\n      ')}`);
  // And the edge is where it is claimed to be, to the point: a subnormal L still counts as inside.
  const edge = [5960.9, 5961.0, 5961.07, 5961.1, 5962, 6000, 1e5, 1e7];
  for (const v of edge) {
    const r = probeAt(v);
    console.log(`    v=${String(v).padEnd(9)} L=${closedL(v).toExponential(3).padEnd(11)} verdict=${String(r.verdict).padEnd(5)} corrected=${r.corrected}`);
    assert.equal(r.verdict, closedL(v) > 0 && r.digitAgrees, `v=${v}: the verdict does not follow the representability of exp(-v/8)`);
  }
  // Non-finite total variance is the same case reached a different way.
  for (const input of [{ volatility: 1e200, horizonPeriods: 1e200 }, { volatility: 1e160, horizonPeriods: 1 }]) {
    const r = SVC.run({ ...input });
    const c = boundednessCheck(r);
    assert.equal(c.pass, false, `${JSON.stringify(input)} produced a non-finite variance and was certified anyway`);
  }
});
// Synchronous helper for the edge probe above. src/util/timing.js's wrapper is sync-preserving and
// this service is declared synchronously, so no await is needed; the probe is stronger for being
// computed at the exact v rather than at the nearest sweep point.
function probeAt(v) {
  const input = { volatility: Math.sqrt(v / T), horizonPeriods: T };
  const served = SVC.run({ ...input });
  const c = boundednessCheck(served);
  const L = closedL(input.volatility * input.volatility * T);
  return { verdict: c?.pass, corrected: !!c?.reEvaluated, digitAgrees: round4((L - 1) * 100) === served.expectedDivergence.expectedIlPct };
}

test('★ exactly the corrected calls move their contentHash, and no others', async () => {
  const moved = rows.filter((r) => r.hashMoved);
  const mismatch = rows.filter((r) => r.hashMoved !== r.corrected);
  assert.equal(mismatch.length, 0,
    `${mismatch.length} call(s) moved their hash without a correction, or were corrected without moving it`);
  console.log(`    ${moved.length} of ${rows.length} sweep contentHashes move; all ${moved.length} carry a corrected check`);
  assert.ok(moved.length >= 300, `only ${moved.length} hashes moved — the sweep no longer exercises the fix`);
  // The pinned exhibits, which are the reason the movement has to be exactly this set.
  for (const [body, pin] of Object.entries(FIXTURE_PINS)) {
    const r = SVC.run(JSON.parse(body));
    assert.equal(r.proof.contentHash, pin, `the pinned lp-risk fixture ${body} moved`);
  }
  const perp = SERVICES.find((s) => s.name === 'perp-gate');
  // perp-gate's handler is genuinely async (it may resolve a venue), unlike lp-risk's — awaited here
  // rather than assumed, because an unawaited Promise reads `undefined` and this assertion would then
  // have passed over nothing.
  const ac = await perp.run({ side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 });
  assert.equal(ac.proof?.contentHash, APPENDIX_C, 'the Appendix C exhibit no longer publishes 8575ce5a…');
  console.log(`    both lp-risk fixture pins hold; Appendix C still ${APPENDIX_C.slice(0, 12)}…`);
});

test('★ the paid HTTP and free MCP surfaces publish the same verdict and the same hash', async () => {
  const bodies = [
    { volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000 },   // the register's own input
    { volatility: 0.9, horizonPeriods: 365 },
    { volatility: 100, horizonPeriods: 1 },                                          // still-refused
    { volatility: 0.5, horizonPeriods: 30 },                                         // untouched
  ];
  for (const body of bodies) {
    const http = SVC.run({ ...body });
    const j = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lp_risk', arguments: { ...body } } });
    const mcp = JSON.parse(j.result.content[0].text);
    assert.equal(mcp.proof.contentHash, http.proof.contentHash, `${JSON.stringify(body)}: the two surfaces disagree about the same call`);
    assert.equal(mcp.proof.allSelfChecksPass, http.proof.allSelfChecksPass, `${JSON.stringify(body)}: allSelfChecksPass differs by surface`);
  }
  console.log(`    ${bodies.length} bodies, identical contentHash and verdict on both surfaces`);
});

test('★ the register\'s own input: served, self-checked, billed, and the value is stated', () => {
  const r = SVC.run({ volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000 });
  assert.equal(r.ok, true);
  assert.equal(r.expectedDivergence.expectedIlPct, -100, 'the served figure must not change — only the verdict about it');
  assert.equal(r.proof.allSelfChecksPass, true);
  assert.equal(isChargeable(r), true, 'a delivered, correct answer must be billable');
  const c = boundednessCheck(r);
  assert.equal(c.pass, true);
  assert.equal(c.residual, -100, 'the residual still reports the served percentage — the number did not change');
  assert.equal(c.reEvaluated.exactFraction, -0.9999999758323288, 'the exact fraction the defect register publishes');
  assert.ok(c.reEvaluated.aboveMinusOne > 0, 'the quantity the strict bound is about must be positive');
  assert.match(c.reEvaluated.reproduce, /src\/util\/lpBoundedness\.js/, 'a corrected check must say what reproduces it');
  assert.match(r.proof.reproduce, /lpBoundedness/, 'the envelope must disclose that the engine alone no longer reproduces this result');
  console.log(`    expectedIlPct ${r.expectedDivergence.expectedIlPct}, exact ${c.reEvaluated.exactFraction}, 1+E[IL] = ${c.reEvaluated.aboveMinusOne.toExponential(6)}`);
});

test('★ the SDK still reproduces an affected response, and still catches a tampered one', () => {
  const rb = createRiskBrain();
  const e = rb.lpRisk({ volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000 });
  assert.equal(boundednessCheck(e).pass, true, 'the SDK publishes a different verdict than the host');
  assert.equal(rb.verify(e).valid, true);
  assert.equal(rb.reproduce(e).reproduced, true,
    'reproduce() re-runs the engine and no longer matches — a caller following the published recipe would conclude an honest response was forged');
  const t = JSON.parse(JSON.stringify(e));
  t.expectedDivergence.expectedIlPct = -99;
  assert.equal(rb.verify(t).contentHashOk, false);
  assert.equal(rb.reproduce(t).reproduced, false);
  console.log('    verify + reproduce green on the corrected response, both red on a tampered one');
});

test('★ the guard has teeth: a served value the closed form does not reproduce is NOT overridden', () => {
  // These are the values this check exists for. None is reachable through the current engine — its own
  // amplification branch prevents them — so they are injected at the corrector's interface, which is
  // the only place a genuinely out-of-range served figure can be presented to it.
  const cases = [
    {
      what: 'the -135% divergence headline the live adversarial session produced',
      input: { volatility: 0.6, horizonPeriods: 30 },
      result: { ok: true, expectedDivergence: { expectedIlPct: -135 }, checks: [{ name: 'boundedness: reported expected divergence lies in (-100%, 0] as V2 divergence loss must', residual: -135, pass: false }] },
    },
    {
      what: 'the -200% amplified realized IL the escape hatch used to ship green',
      input: { priceRatio: 9, concentrationFactor: 5 },
      result: { ok: true, realizedIL: { impermanentLossPct: -200 }, checks: [{ name: 'boundedness: reported realized IL lies in (-100%, 0], amplified or not', residual: -200, pass: false }] },
    },
    {
      what: 'a positive expected divergence — a bounded loss reported as a gain',
      input: { volatility: 0.6, horizonPeriods: 30 },
      result: { ok: true, expectedDivergence: { expectedIlPct: 12.5 }, checks: [{ name: 'boundedness: reported expected divergence lies in (-100%, 0] as V2 divergence loss must', residual: 12.5, pass: false }] },
    },
    {
      what: 'a served figure one 4-dp step away from the exact fraction',
      input: { volatility: 0.62, horizonPeriods: 365 },
      result: { ok: true, expectedDivergence: { expectedIlPct: -99.9999 }, checks: [{ name: 'boundedness: reported expected divergence lies in (-100%, 0] as V2 divergence loss must', residual: -99.9999, pass: false }] },
    },
  ];
  for (const c of cases) {
    const { result, corrections } = recheckLpBoundedness(c.result, c.input);
    assert.equal(corrections.length, 0, `${c.what}: the corrector overrode a verdict it cannot justify`);
    assert.equal(result, c.result, `${c.what}: the result object was rebuilt even though nothing was corrected`);
    assert.equal(result.checks[0].pass, false, `${c.what}: still-failing check was flipped`);
    console.log(`    refused to override: ${c.what}`);
  }
});

test('★ the sweep actually contains every class it claims to check', () => {
  // Floors, so a sweep that quietly stops producing one of the three classes cannot report success.
  console.log(`    ${rows.length} calls: ${untouched.length} untouched-passing, ${corrected.length} corrected, ${stillFailing.length} still failing`);
  assert.ok(untouched.length >= 200, `only ${untouched.length} untouched-passing calls`);
  assert.ok(corrected.length >= 300, `only ${corrected.length} corrected calls`);
  assert.ok(stillFailing.length >= 50, `only ${stillFailing.length} still-failing calls — the refusal half is unexercised`);
  assert.ok(rows.some((r) => r.v > ENGINE_FLIP && r.v < CLOSED_FLIP), 'the residual band is unexercised');
  assert.ok(rows.some((r) => r.v > 5962), 'the underflow edge is unexercised');
});
