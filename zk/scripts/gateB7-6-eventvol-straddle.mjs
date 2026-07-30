// GATE B7-6 — event-vol's straddle, WIRED to the normal-CDF circuit.
//
// gateB7-5 built `ncdf.circom`, proved it, refused every perturbation of it, and ended with the line
// "NOTHING SERVED, NOTHING DEPLOYED. options-risk does not emit this." That was honest and it was the
// whole gap: a circuit nothing serves is a circuit, not a proof.
//
// This gate closes it for ONE field of ONE service, and the reason it is only one field is the
// mathematics rather than a shortage of effort. `ncdf.circom` pins N(x) GIVEN x; pinning options-risk's
// d1 needs ln(F/K). event-vol's straddle is struck AT the forward, so K = F, ln(F/K) = 0, and
//
//     d1 = ½σ²T / (σ√T) = σ√T/2 ,  d2 = −d1 ,  C + P = 2·S·(2·N(σ√T/2) − 1)
//
// — one point of the CDF, no logarithm, and therefore reachable with the circuit that already exists.
//
// SEVEN THINGS HAVE TO HOLD AND EACH ONE CAN FAIL:
//
//   1. the constants the SERVICE carries are the constants the CIRCUIT enforces (they live in two
//      files; nothing but this gate compares them)
//   2. the artifacts the service proves against are byte-identical to the ones this gate gates
//   3. the single-point claim is TRUE — and the exact form of it is not the textbook form: the engine
//      evaluates Hart at d1 AND d2, which are exact negatives on a minority of legs
//   4. the guard's bound holds over the real engine, is REACHED, and its ceiling fires
//   5. a real proof built by the REAL SERVED HANDLER verifies; every perturbed signal and a bent
//      proof are refused
//   6. a service running a wrong CDF cannot get one accepted — measured on THIS service's narrow
//      slice of the x-axis, which is not options-risk's
//   7. the exported verifier does the same inside an EVM
//
// Run: node zk/scripts/gateB7-6-eventvol-straddle.mjs
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BUILD, checklist, proveVerifyRefuse, evmRehearsal, shutdown, snarkjs } from './lib/gatekit.mjs';
import { serviceRoot, load } from './service-root.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const ZK = path.join(BUILD, '..');
const { black76, probAbove } = await load(import.meta.url, 'engine/black76.js');
const { eventVol } = await load(import.meta.url, 'engine/eventVol.js');
const { ncdfWitnessFor, NCDF } = await load(import.meta.url, 'util/ncdfWitness.js');
const { SERVICES } = await load(import.meta.url, 'services.js');
const { TOOLS } = await load(import.meta.url, 'mcp.js');
const { getProof, flushProofWrites, stopProver } = await load(import.meta.url, 'util/snark.js');
const SERVICE_SRC = serviceRoot(import.meta.url);

const { record, failed } = checklist();
console.log(`GATE B7-6 — event-vol's straddle, wired to ncdf.circom — ${new Date().toISOString()}\n`);

// =================================================================================================
// 1. THE CONSTANTS, IN TWO FILES, COMPARED
// =================================================================================================
// src/util/ncdfWitness.js cannot read the circom source — the deploy does not ship it — so it carries
// a copy. A constant restated in two places drifts unless something compares them. This is that
// something, and it parses the CIRCUIT, which is what gets proved against.
console.log('1. THE CIRCUIT PARAMETERS THE SERVICE CARRIES vs THE ONES THE CIRCUIT ENFORCES.\n');
const CSRC = readFileSync(path.join(ZK, 'circuits', 'ncdf.circom'), 'utf8');
const grabVar = (nm) => {
  const m = CSRC.match(new RegExp(`var ${nm}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`ncdf.circom: no var ${nm}`);
  return Number(m[1]);
};
const circuitParams = { S: grabVar('S'), TOLC: grabVar('TOLC'), TOLP: grabVar('TOLP'), ZSPLIT: grabVar('ZSPLIT') };
for (const [k, v] of Object.entries(circuitParams)) {
  record(`the service's ${k} is the circuit's ${k}`, NCDF[k] === v, `service ${NCDF[k]} · circuit ${v}`);
}
record('the service\'s ONE and ULP follow from its S', NCDF.ONE === 2 ** NCDF.S && NCDF.ULP === 2 ** -NCDF.S,
  `ONE ${NCDF.ONE} · ULP ${NCDF.ULP.toExponential(3)}`);

// =================================================================================================
// 2. THE ARTIFACTS
// =================================================================================================
// The service proves against assets/zk; this gate proves against zk/build. If they differ, this whole
// file is gating a circuit nobody serves — which is exactly what gateB7-5 ended up doing, on purpose,
// and what this gate exists to stop being true.
console.log('\n2. THE ARTIFACTS THE SERVICE PROVES AGAINST vs THE ONES THIS GATE GATES.\n');
// `fileURLToPath`, not `url.pathname`. A path with a space in it — and this checkout has one — comes
// back percent-encoded from `pathname` and every read fails on a directory that does exist.
const { fileURLToPath } = await import('node:url');
const ASSETS = path.join(fileURLToPath(SERVICE_SRC.url), '..', 'assets', 'zk');
{
  const { createHash } = await import('node:crypto');
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
  const pairs = [
    ['ncdf_plonk.zkey', path.join(BUILD, 'ncdf_plonk.zkey'), path.join(ASSETS, 'ncdf_plonk.zkey')],
    ['ncdf_vk.json', path.join(BUILD, 'ncdf_vk.json'), path.join(ASSETS, 'ncdf_vk.json')],
    ['ncdf_js/ncdf.wasm', path.join(BUILD, 'ncdf_js', 'ncdf.wasm'), path.join(ASSETS, 'ncdf_js', 'ncdf.wasm')],
    ['ncdf_js/witness_calculator.cjs', path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'), path.join(ASSETS, 'ncdf_js', 'witness_calculator.cjs')],
  ];
  let same = 0;
  for (const [name, a, b] of pairs) {
    const ok = sha(a) === sha(b);
    if (ok) same++;
    console.log(`  [${ok ? 'PASS' : '*** FAIL ***'}] ${name.padEnd(30)} ${sha(a)} ${ok ? '==' : '!='} ${sha(b)}  (${statSync(a).size} bytes)`);
  }
  record('every artifact the service proves against is the one this gate gates', same === pairs.length,
    `${same} of ${pairs.length} byte-identical between zk/build and assets/zk`);
}

// =================================================================================================
// 3. THE SINGLE-POINT CLAIM, AND THE EXACT FORM OF IT
// =================================================================================================
console.log('\n3. IS THE STRADDLE A SINGLE N(x)? The textbook says yes. IEEE-754 says "at one point,');
console.log('   within a residual you have to charge for" — and the difference is the guard.\n');

let seed = 20260730;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const U = NCDF.ULP;

{
  let n = 0, d2EqNegD1 = 0, worstCollapse = 0, worstGapUlp = 0, xMax = 0, worstAt = null;
  for (let i = 0; i < 40000; i++) {
    const S = 10 ** (0.5 + rand() * 5.5), sig = (5 + rand() * 295) / 100, T = (0.25 + rand() * 400) / 365;
    if (eventVol({ spot: S, atmIvPct: sig * 100, daysToEvent: T * 365 }).ok !== true) continue;
    const call = black76(S, S, T, sig, 'call', 0);
    if (!call) continue;
    n++;
    if (call.d2 === -call.d1) d2EqNegD1++;
    xMax = Math.max(xMax, call.d1);
    const gap = Math.abs(Math.abs(call.d2) - call.d1) / U;
    if (gap > worstGapUlp) worstGapUlp = gap;
    const c = Math.abs(call.delta - (1 - probAbove(S, S, T, sig, 0))) / U;
    if (c > worstCollapse) { worstCollapse = c; worstAt = { S, sig, T, d1: call.d1 }; }
  }
  console.log(`  ${n} legs · vol 5–300% · horizon 6h–400d`);
  console.log(`  d2 === -d1 in doubles       : ${d2EqNegD1} of ${n} = ${((100 * d2EqNegD1) / n).toFixed(2)}%`);
  console.log(`  worst |‖d2‖ - d1|           : ${worstGapUlp.toExponential(3)} ulp of 2^-40`);
  console.log(`  worst |N(d1) - (1 - N(d2))| : ${worstCollapse.toExponential(3)} ulp  (the circuit's CDF envelope is ${NCDF.TOLC} ulp)`);
  console.log(`  max x reached               : ${xMax.toPrecision(6)}  (the circuit's branch split is ${(circuitParams.ZSPLIT / NCDF.ONE).toPrecision(6)})\n`);

  // THE CLAIM UNDER TEST WAS "a field which is a single N(x)". It is a single POINT and it is not a
  // single EVALUATION: the engine calls Hart four times, at two magnitudes. Recording the exact
  // status rather than the convenient one.
  record('the engine does NOT evaluate the CDF at one point in doubles', d2EqNegD1 < n,
    `${n - d2EqNegD1} of ${n} legs have d2 !== -d1 — the textbook identity is exact in the reals and false in IEEE-754, because d1 = (0 + 0.5*sigma*sigma*T)/(sigma*sqrtT) and d2 = d1 - sigma*sqrtT are different float paths`);
  record('collapsing the two points is worth less than 1% of the circuit\'s own envelope',
    worstCollapse < 0.01 * NCDF.TOLC,
    `worst ${worstCollapse.toExponential(3)} ulp = ${((100 * worstCollapse) / NCDF.TOLC).toExponential(2)}% of ${NCDF.TOLC} ulp, at x = ${worstAt.d1.toPrecision(6)} — so ONE proof carries the field, and the residual is charged per leg rather than waved at`);
  record('the whole served domain is on the COMPUTED branch, not the bounded tail', xMax < circuitParams.ZSPLIT / NCDF.ONE,
    `x = sigma*sqrt(T)/2 reaches ${xMax.toPrecision(6)}; the tail branch would need sigma*sqrt(T) = 14.14, e.g. 300% vol over 22 years. The encoder refuses it BY NAME anyway rather than relying on this sweep`);
  globalThis.__points = { legs: n, d2EqNegD1, worstCollapseUlp: worstCollapse, worstPointGapUlp: worstGapUlp, xMax };
}

// =================================================================================================
// 4. THE GUARD, AGAINST THE REAL SERVICE HANDLER
// =================================================================================================
console.log('4. THE GUARD. Every witness comes out of the SERVED handler — `SERVICES[].run` with');
console.log('   snark:true — so the numbers compared are the ones a caller is answered with, not a');
console.log('   recomputation that would agree with itself.\n');

const httpEventVol = SERVICES.find((s) => s.name === 'event-vol');
const mcpEventVol = TOOLS.find((t) => t.name === 'event_vol');
record('both surfaces carry the handler this gate measures', !!httpEventVol && !!mcpEventVol,
  `http:event-vol ${!!httpEventVol} · mcp:event_vol ${!!mcpEventVol}`);

// BOTH SURFACES, SAME ANSWER. The MCP array has been the forgotten site four times in this repo.
{
  const body = { spot: 60000, atmIvPct: 55, daysToEvent: 7, snark: true };
  const a = httpEventVol.run({ ...body }), b = mcpEventVol.run({ ...body });
  const strip = (e) => { const { proof, snark, ...rest } = e; return { rest, ch: proof.contentHash, snark: { ...snark } }; };
  const sa = strip(a), sb = strip(b);
  record('the two surfaces publish the same contentHash for one call', sa.ch === sb.ch, `${sa.ch}`);
  record('the two surfaces publish the same snark block', JSON.stringify(sa.snark) === JSON.stringify(sb.snark),
    `circuit ${sa.snark.circuit} · status ${sa.snark.status} · field ${sa.snark.fieldProven}`);
  // AND THE HASH HAS NOT MOVED for a request that already worked. This is the number three other
  // gates pin for event-vol.
  const plain = httpEventVol.run({ spot: 60000, atmIvPct: 55, daysToEvent: 7 });
  record('the pinned contentHash for the event-vol fixture has not moved',
    plain.proof.contentHash === '8d653115a9c4e8752725a63288b283c5c10c25be2ee63b92b0e48f82ba09fd8a',
    `${plain.proof.contentHash}`);
  record('a request that does not ask for a proof grows no snark key', plain.snark === undefined,
    'the response shape for every existing caller is byte-identical');
}

let kept = 0, refusedCount = 0, worstTight = 0, worstEnv = 0, worstCase = null, exceedances = 0;
const refusalReasons = new Map();
for (let i = 0; i < 20000; i++) {
  const spot = 10 ** (0.5 + rand() * 5.5), atmIvPct = 5 + rand() * 295, daysToEvent = 0.25 + rand() * 400;
  const env = httpEventVol.run({ spot, atmIvPct, daysToEvent, snark: true });
  if (env.snark.status === 'unavailable') {
    refusedCount++;
    const k = env.snark.reason.slice(0, 40);
    refusalReasons.set(k, (refusalReasons.get(k) || 0) + 1);
    continue;
  }
  const { proof, snark, ...result } = env;
  const w = ncdfWitnessFor(proof.inputs, result);
  kept++;
  const ft = w.gapToEngineUsd / w.encodingBoundUsd;
  if (ft > worstTight) { worstTight = ft; worstCase = { spot, atmIvPct, daysToEvent, ...w }; }
  worstEnv = Math.max(worstEnv, w.gapToEngineUsd / w.envelopeUsd);
  if (w.gapToEngineUsd > w.encodingBoundUsd) exceedances++;
}
console.log(`  served legs certified       : ${kept}`);
console.log(`  served legs refused         : ${refusedCount}${refusedCount ? ` (${[...refusalReasons].map(([r, c]) => `${c}x "${r}…"`).join(', ')})` : ''}`);
console.log(`  worst |R - engine| / encodingBound : ${(worstTight * 100).toFixed(4)}%`);
console.log(`  worst |R - engine| / buyer envelope: ${(worstEnv * 100).toFixed(4)}%\n`);

record('the encoding bound holds on every served leg', exceedances === 0,
  `${kept} legs, ${exceedances} exceedances`);
// A BOUND NOTHING REACHES IS NOT A BOUND. The encoding bound is one rounding of N onto 2^-40 plus a
// measured collapse plus the reconstruction's own float error, so the worst honest leg should land ON
// it rather than near it.
record('the encoding bound is REACHED, not merely respected', worstTight > 0.9,
  `worst honest leg uses ${(worstTight * 100).toFixed(4)}% of it — a bound at 10% would be a number nobody measured`);
// And the buyer's envelope is 24x wider ON PURPOSE, because a buyer knows only what the circuit
// promises (12 ulp) and not that the engine needed half a step. Saying so is the honest version of a
// headroom number that would otherwise look like slack.
record('the buyer envelope is wider than the encoding bound, and the ratio is the circuit\'s promise',
  worstEnv < worstTight,
  `worst honest leg uses ${(worstEnv * 100).toFixed(4)}% of the buyer envelope. The ratio is (${NCDF.TOLC} + 0.5*phi_max)/0.5 = ${((NCDF.TOLC + 0.5 / Math.sqrt(2 * Math.PI)) / 0.5).toFixed(1)}x — all of it a promise ncdf.circom makes that this engine does not need. Tightening it means tightening TOLC, which is a property of the circuit`);

// THE CEILING FIRES. Above a spot where the circuit's 12-ulp envelope is worth more than half of the
// last digit the straddle is displayed at, no proof of this shape is about the number that was served.
{
  const PHI_MAX = 1 / Math.sqrt(2 * Math.PI);
  const predicted = 0.005 / (4 * (NCDF.TOLC + 0.5 * PHI_MAX) * U);
  let lo = 1e6, hi = 1e12;
  for (let k = 0; k < 200; k++) {
    const m = Math.sqrt(lo * hi);
    const e = httpEventVol.run({ spot: m, atmIvPct: 60, daysToEvent: 3, snark: true });
    if (e.snark.status === 'building') lo = m; else hi = m;
  }
  record('the display ceiling fires, at the spot the derivation predicts',
    Math.abs(lo / predicted - 1) < 0.01,
    `refuses above spot ${lo.toExponential(4)}; derived 0.005 / (4*(${NCDF.TOLC} + 0.5*phi_max)*2^-40) = ${predicted.toExponential(4)}`);
  const over = httpEventVol.run({ spot: 2e8, atmIvPct: 60, daysToEvent: 3, snark: true });
  record('a spot above the ceiling is refused with a reason, not served with a proof',
    over.snark.status === 'unavailable' && /wider than the 0.005/.test(over.snark.reason),
    over.snark.reason.slice(0, 150));
  globalThis.__ceiling = { spotCeiling: lo, derived: predicted };
}

// AND THE REFUSALS THE ENCODER OWES A SENTENCE FOR. Each is constructed, not hoped for.
{
  const cases = [
    ['a refused request', { spot: -1, atmIvPct: 55, daysToEvent: 7 }, /refused/],
    ['a spot above the display ceiling', { spot: 5e8, atmIvPct: 55, daysToEvent: 7 }, /wider than the 0.005/],
  ];
  let named = 0;
  for (const [label, body, re] of cases) {
    // `validate` refuses the negative spot before `run` is reached on the served path, so the encoder
    // is asked directly for that one — the point is that it answers with a sentence either way.
    const r = body.spot > 0 ? httpEventVol.run({ ...body, snark: true }).snark : { status: 'unavailable', reason: ncdfWitnessFor(body, eventVol(body)).reason };
    const ok = r.status === 'unavailable' && re.test(r.reason);
    if (ok) named++;
    console.log(`  [${ok ? 'PASS' : '*** FAIL ***'}] ${label}: ${String(r.reason).slice(0, 110)}`);
  }
  record('every refusal path answers with its own sentence', named === cases.length, `${named} of ${cases.length}`);
}

// =================================================================================================
// 5. A REAL PROOF — FROM THE SERVED PATH
// =================================================================================================
console.log('\n5. A REAL PROOF, on the worst leg the SERVED sweep found.');
console.log(`   spot ${worstCase.spot.toPrecision(7)} · atmIvPct ${worstCase.atmIvPct.toPrecision(6)} · daysToEvent ${worstCase.daysToEvent.toPrecision(6)}`);
console.log(`   x ${worstCase.point.toPrecision(10)} · N(x) ${worstCase.nEngine.toPrecision(12)} · straddle ${worstCase.straddle}`);
console.log(`   served ${worstCase.served} · reconstruction ${worstCase.reconstructedUsd}\n`);
const { proof, publicSignals, proveMs, vk } = await proveVerifyRefuse('ncdf', worstCase.witness, { record });

// The public signals a buyer reads, and the reconstruction they perform. `computed` first, so a reader
// can tell an evaluated statement from a bounded one without asking.
record('the proof publishes computed = 1, so the CDF was evaluated and not bounded', publicSignals[0] === '1',
  `computed ${publicSignals[0]} · tailC ${publicSignals[1]} · tailP ${publicSignals[2]} · xSign ${publicSignals[3]} · xMag ${publicSignals[4]} · nHat ${publicSignals[5]} · pHat ${publicSignals[6]}`);
{
  const nHat = Number(publicSignals[5]);
  const R = (worstCase.spot * (nHat / NCDF.ONE) - worstCase.spot * (1 - nHat / NCDF.ONE)) * 2;
  record('the buyer\'s reconstruction from the PUBLIC SIGNALS displays as the number that was served',
    Number(Number(R).toFixed(2)) === worstCase.served,
    `2*spot*(2*${nHat}/2^40 - 1) = ${R} -> ${Number(Number(R).toFixed(2))}, served ${worstCase.served}`);
  // AND THE BINDING THE CIRCUIT DOES NOT CARRY, done the way a reader would: one squaring.
  const x = Number(publicSignals[4]) / NCDF.ONE;
  const sig = worstCase.atmIvPct / 100, T = worstCase.daysToEvent / 365;
  const resid = Math.abs(4 * x * x - sig * sig * T) / (sig * sig * T);
  record('a reader binds x to sigma and T by squaring, with no logarithm and no circuit',
    resid < 1e-9,
    `4*x^2 vs sigma^2*T: relative residual ${resid.toExponential(2)} — this is NOT in the proof, and the doesNotProve text says so`);
}

// AND THE PROOF THE SERVED RESPONSE ACTUALLY POINTS AT. Everything above proves the encoder's witness;
// this proves the thing a caller is handed a URL for.
console.log('\n   The proof the SERVED response points at, fetched from the store the handler wrote to:');
{
  const env = httpEventVol.run({ spot: 60000, atmIvPct: 55, daysToEvent: 7, snark: true });
  const hash = env.proof.contentHash;
  const sj = await snarkjs();
  let rec = null;
  for (let i = 0; i < 240; i++) {
    rec = await getProof(hash);
    if (rec && rec.status !== 'building') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const ok = rec?.status === 'ready' && await sj.plonk.verify(vk, rec.publicSignals, rec.proof);
  record('the proof a served response points at verifies against the published key', ok === true,
    `/proof/${hash} → status ${rec?.status} · circuit ${rec?.circuit} · straddleFromProofUsd ${rec?.straddleFromProofUsd} · gapToServedUsd ${rec?.gapToServedUsd}`);
  record('the record published beside it names the reconstruction a buyer performs',
    typeof rec?.reconstruct === 'string' && /2\^40/.test(rec.reconstruct) && typeof rec?.envelopeUsd === 'number',
    `envelopeUsd ${rec?.envelopeUsd} · encodingBoundUsd ${rec?.encodingBoundUsd} · twoPointCollapseUlp ${rec?.twoPointCollapseUlp}`);
  globalThis.__served = { contentHash: hash, status: rec?.status, straddleFromProofUsd: rec?.straddleFromProofUsd, gapToServedUsd: rec?.gapToServedUsd, envelopeUsd: rec?.envelopeUsd };
}

// =================================================================================================
// 6. THE POINT — a wrong CDF, on THIS service's slice of the axis
// =================================================================================================
console.log('\n6. THE POINT. gateB7-5 measured a wrong CDF over options-risk\'s d1, which ranges over');
console.log('   the whole axis. event-vol\'s x is sigma*sqrt(T)/2, which is a NARROW slice near zero —');
console.log('   so the question has to be asked again here rather than inherited.\n');

// The circuit's integer evaluator, parsed out of the circuit source. Same method as gateB7-5, and for
// the same reason: build/ncdf-consts.json and the circuit come from one generator run.
const EXP = [];
for (let g = 0; ; g++) {
  const row = [];
  for (let j = 0; j < 16; j++) {
    const m = CSRC.match(new RegExp(`mx\\[${g}\\]\\.c\\[${j}\\] <== (\\d+);`));
    if (!m) break;
    row.push(BigInt(m[1]));
  }
  if (row.length !== 16) break;
  EXP.push(row);
}
const parseHorner = (prefix, sigArr) => {
  const out = [BigInt(CSRC.match(new RegExp(`${sigArr}\\[0\\] <== (\\d+);`))[1])];
  for (let i = 1; ; i++) {
    const m = CSRC.match(new RegExp(`${sigArr}\\[${i}\\] <== ${prefix}\\[${i - 1}\\]\\.out \\+ (\\d+);`));
    if (!m) break;
    out.push(BigInt(m[1]));
  }
  return out;
};
const BC = parseHorner('bm', 'bh'), DC = parseHorner('dm', 'dh');
const Sb = BigInt(NCDF.S), ONEb = BigInt(NCDF.ONE);
const mulS = (a, b) => (a * b) >> Sb;
const absB = (v) => (v < 0n ? -v : v);
function evalFx(zHat) {
  const W = (zHat * zHat) >> (Sb + 1n);
  let e = ONEb;
  for (let g = 0; g < EXP.length; g++) e = mulS(e, EXP[g][Number((W >> (BigInt(g) * 4n)) & 15n)]);
  let b = BC[0]; for (let i = 1; i < BC.length; i++) b = mulS(b, zHat) + BC[i];
  let d = DC[0]; for (let i = 1; i < DC.length; i++) d = mulS(d, zHat) + DC[i];
  return { eHat: e, bHat: b, dHat: d };
}
record('the exp table and both Horner polynomials parse out of the circuit source',
  EXP.length === 12 && BC.length === 7 && DC.length === 8,
  `${EXP.length} groups x 16 = ${EXP.length * 16} constants · b has ${BC.length} coefficients · d has ${DC.length}`);

// The honest engine's headroom inside the circuit's own two relations, on this service's domain.
{
  seed = 555;
  let n = 0, wC = 0, wP = 0;
  const SQRT2PI = BigInt(CSRC.match(/var SQRT2PI\s*=\s*(\d+)/)[1]);
  for (let i = 0; i < 20000; i++) {
    const S = 10 ** (0.5 + rand() * 5.5), sig = (5 + rand() * 295) / 100, T = (0.25 + rand() * 400) / 365;
    const call = black76(S, S, T, sig, 'call', 0);
    if (!call) continue;
    const xMag = BigInt(Math.round(call.d1 * NCDF.ONE));
    if (xMag >= BigInt(circuitParams.ZSPLIT)) continue;
    const nHat = BigInt(Math.round(call.delta * NCDF.ONE));
    const pHat = BigInt(Math.round(call.gamma * S * sig * Math.sqrt(T) * NCDF.ONE));
    const cHat = ONEb - nHat;
    if (cHat > ONEb / 2n) continue;
    const { eHat, bHat, dHat } = evalFx(xMag);
    n++;
    wC = Math.max(wC, Number(absB(cHat * dHat - eHat * bHat)) / (NCDF.TOLC * Number(dHat)));
    wP = Math.max(wP, Number(absB(pHat * SQRT2PI - eHat * ONEb)) / (NCDF.TOLP * Number(SQRT2PI)));
  }
  console.log(`  the honest engine, ${n} legs: CDF residual uses ${(wC * 100).toFixed(2)}% of ${NCDF.TOLC} ulp · density ${(wP * 100).toFixed(2)}% of ${NCDF.TOLP} ulp`);
  record('the honest engine sits inside the circuit\'s own tolerances on this domain', wC < 1 && wP < 1,
    `CDF ${(wC * 100).toFixed(2)}% · density ${(wP * 100).toFixed(2)}% — both used, neither exceeded`);
  globalThis.__honest = { legs: n, usedC: wC, usedP: wP };
}

function absteg(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const c = 0.5 * (1 - y);
  return x <= 0 ? c : 1 - c;
}
const logistic = (x) => 1 / (1 + Math.exp(-1.702 * x));

console.log(`\n  ${'wrong CDF'.padEnd(26)}${'straddle wrong by'.padStart(20)}${'refused'.padStart(12)}${'worst x bound'.padStart(15)}${'proofs accepted'.padStart(17)}`);
const wrongStats = [];
const sj2 = await snarkjs();
const { createRequire } = await import('node:module');
const req2 = createRequire(import.meta.url);
const builder = await req2(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));
for (const [name, Nf] of [['Abramowitz-Stegun 7.1.26', absteg], ['logistic 1.702x', logistic]]) {
  seed = 909090;
  let n = 0, worstRel = 0, meanRel = 0, refused = 0, worstUlp = 0, accepted = 0, tried = 0;
  const under = [];
  for (let i = 0; i < 8000; i++) {
    const S = 10 ** (0.5 + rand() * 5.5), sig = (5 + rand() * 295) / 100, T = (0.25 + rand() * 400) / 365;
    const call = black76(S, S, T, sig, 'call', 0), put = black76(S, S, T, sig, 'put', 0);
    if (!call || !put) continue;
    const trueStraddle = call.price + put.price;
    const wrong = (S * Nf(call.d1) - S * Nf(call.d2)) + (S * Nf(-call.d2) - S * Nf(-call.d1));
    const rel = Math.abs(wrong - trueStraddle) / Math.max(trueStraddle, 1e-300);
    n++; meanRel += rel; worstRel = Math.max(worstRel, rel);
    const xMag = BigInt(Math.round(call.d1 * NCDF.ONE));
    if (xMag >= BigInt(circuitParams.ZSPLIT)) continue;
    const nHat = BigInt(Math.round(Nf(call.d1) * NCDF.ONE));
    const cHat = ONEb - nHat;
    if (cHat > ONEb / 2n || cHat < 0n) { refused++; continue; }
    const { eHat, bHat, dHat } = evalFx(xMag);
    const ulp = Number(absB(cHat * dHat - eHat * bHat)) / Number(dHat);
    worstUlp = Math.max(worstUlp, ulp);
    if (ulp > NCDF.TOLC) refused++;
    else under.push({ nHat, xMag, d1: call.d1, ulp });
  }
  // Prove the ones that slipped under, so the acceptance rate is measured by a verifier and not by
  // this file's arithmetic. A wrong CDF is momentarily right at a zero crossing of its own error.
  for (const c of under.sort((a, b) => b.ulp - a.ulp).slice(0, 3)) {
    tried++;
    const phi = Math.exp(-c.d1 * c.d1 / 2) / Math.sqrt(2 * Math.PI);
    const w = { xSign: '0', xMag: String(c.xMag), nHat: String(c.nHat), pHat: String(BigInt(Math.round(phi * NCDF.ONE))) };
    try {
      const wt = await builder.calculateWTNSBin(w, 0);
      const r = await sj2.plonk.prove(path.join(BUILD, 'ncdf_plonk.zkey'), wt);
      if (await sj2.plonk.verify(vk, r.publicSignals, r.proof)) accepted++;
    } catch { /* a witness the calculator refuses is a refusal */ }
  }
  const denom = refused + under.length;
  wrongStats.push({ name, legs: n, worstRelStraddle: worstRel, meanRelStraddle: meanRel / n, refused, denom, refusalRate: refused / denom, worstUlpOverBound: worstUlp / NCDF.TOLC, underBound: under.length, accepted, tried });
  console.log(`  ${name.padEnd(26)}${`${(worstRel * 100).toFixed(4)}% worst`.padStart(20)}${`${((100 * refused) / denom).toFixed(2)}%`.padStart(12)}${(worstUlp / NCDF.TOLC).toExponential(2).padStart(15)}${`${accepted} of ${tried}`.padStart(17)}`);
}
for (const s of wrongStats) {
  record(`${s.name}: refused on at least 99% of event-vol legs`, s.refusalRate >= 0.99,
    `${s.refused} of ${s.denom} = ${(s.refusalRate * 100).toFixed(2)}%; worst residual ${s.worstUlpOverBound.toExponential(2)}x the ${NCDF.TOLC}-ulp bound. ${s.underBound} slipped under and ${s.accepted} of ${s.tried} of those verified`);
}
// AND THE HONEST INVERSE, which is the uncomfortable half. On options-risk's domain A-S prices a leg
// 19.4% wrong. On event-vol's it does not, because the ATM straddle sits where A-S is accurate — so
// what this proof buys here is that the evaluator is PINNED, not that a buyer is protected from a
// large mispricing. Saying the smaller thing is the whole discipline.
{
  const as = wrongStats.find((s) => s.name.startsWith('Abramowitz'));
  record('the economic size of what this proof catches is reported, not implied',
    as.worstRelStraddle < 0.01,
    `A-S 7.1.26 is refused on ${(as.refusalRate * 100).toFixed(2)}% of legs while pricing the straddle only ${(as.worstRelStraddle * 100).toFixed(4)}% wrong worst and ${(as.meanRelStraddle * 100).toFixed(5)}% mean — on options-risk's wider d1 domain the same surrogate is 19.4% wrong. The circuit is far tighter than the economic significance ON THIS FIELD, and a reader is entitled to know which of those two they are buying`);
  const lg = wrongStats.find((s) => s.name.startsWith('logistic'));
  record('a surrogate that IS economically wrong is also refused', lg.refusalRate >= 0.99 && lg.worstRelStraddle > 0.01,
    `logistic 1.702x prices the straddle ${(lg.worstRelStraddle * 100).toFixed(2)}% wrong worst, ${(lg.meanRelStraddle * 100).toFixed(2)}% mean, and is refused on ${(lg.refusalRate * 100).toFixed(2)}% of legs`);
}

// =================================================================================================
// 7. THE EXPORTED VERIFIER, IN AN EVM
// =================================================================================================
console.log('\n7. THE EXPORTED VERIFIER, inside an in-process EVM. Nothing is deployed.');
const evm = await evmRehearsal('ncdf', proof, publicSignals, { record });

// =================================================================================================
const f = plonkFacts(path.join(BUILD, 'ncdf_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE B7-6: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · domain ${f.domainSize} · ${f.nPublic} public · proved in ${proveMs} ms`);
console.log(`  ${evm.acceptGas} gas to accept, ${evm.rejectGas} to refuse (ONE SAMPLE — see probe-plonk-gas-variance)`);
console.log('');
console.log('  WHAT IS PROVEN: that event-vol\'s published straddleImpliedAbsMoveUsd is 2*S*(2*N(x) - 1)');
console.log(`  for the public point x, with N the Hart normal CDF EVALUATED IN THE CIRCUIT to ${NCDF.TOLC} ulp of`);
console.log(`  2^-40, which is +-${(4 * 60000 * (NCDF.TOLC + 0.5 / Math.sqrt(2 * Math.PI)) * U).toExponential(3)} on a $60,000 spot against a served precision of 0.005.`);
console.log('  WHAT IS NOT: that x is sigma*sqrt(T)/2. That binding is one squaring on the public signals,');
console.log('  which a reader performs and the circuit does not carry. Nor the other five published fields:');
console.log('  probabilityMoveBeyond needs the CDF at six further points, eventIsolation is a variance');
console.log('  difference and a root, and checks[0] is a 501-point quadrature — an agreement claim between');
console.log('  two computations rather than an identity over the inputs.');
console.log('  SERVED: yes, on both surfaces, behind snark:true. DEPLOYED: no.');

writeFileSync(path.join(BUILD, 'gateB7-6-eventvol-straddle.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate,
  circuitParams, serviceParams: { ...NCDF },
  points: globalThis.__points,
  guard: {
    servedLegsCertified: kept, servedLegsRefused: refusedCount,
    worstUsedEncodingBound: worstTight, worstUsedBuyerEnvelope: worstEnv, exceedances,
    ...globalThis.__ceiling,
  },
  honestEngineInsideCircuitTolerance: globalThis.__honest,
  served: globalThis.__served,
  wrongCdf: wrongStats,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize, nPublic: f.nPublic, proveMs,
  evm: { acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), deployedSize: evm.deployedSize, solc: evm.solc },
}, null, 2) + '\n', 'utf8');
await flushProofWrites();
await stopProver();
await shutdown();
process.exit(gate ? 0 : 1);
