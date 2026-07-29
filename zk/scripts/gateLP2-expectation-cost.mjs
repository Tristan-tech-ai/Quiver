// GATE LP2 — the expectation is reducible to closed form, and what stops it is the ceremony file.
//
// This gate exists to keep two claims from being opinions.
//
// FIRST, that lp-risk's 401-point quadrature has a closed-form restatement. The engine's nodes are
// z_i = −6 + 0.03·i, which makes √r_i geometric in i, so 802 exponentials collapse to two seeds and a
// multiply chain, and the Gaussian weights collapse to compile-time constants. This gate measures the
// agreement against the engine's own pass, and measures how coarse a sub-grid still reproduces the
// figure the service publishes.
//
// SECOND, that what blocks the circuit is not the transcendentals and not the absence of an identity,
// but the size of the powers-of-tau on hand. `circuits/lpexpectation.circom` is compiled and its
// constraint count is READ FROM THE ARTIFACT. Not from circom's console summary: circom prints both
// "linear constraints" and "non-linear constraints", and a regex for the first matches the second —
// that exact bug double-counted a constraint total in this project by 2x.
//
// Run: node zk/scripts/gateLP2-expectation-cost.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BUILD, checklist } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { expectedIlNumerical, validateQuadratureCopy } from './lib/lpbracket-encode.mjs';

const { lpRisk } = await load(import.meta.url, 'engine/lpRisk.js');
const { round } = await load(import.meta.url, 'engine/stats.js');

const PTAU_CEILING = 4096;   // hez_final_12, the ceremony file this repo carries

/** nConstraints straight out of the .r1cs header. Validated below against a circuit whose count is
 *  independently recorded by another gate, so a wrong offset cannot pass as a plausible integer. */
function r1csConstraints(p) {
  const b = readFileSync(p);
  if (b.toString('utf8', 0, 4) !== 'r1cs') throw new Error(`${p}: not an r1cs`);
  const nSections = b.readUInt32LE(8);
  let off = 12, hdr = null;
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    if (type === 1 && hdr === null) hdr = off + 12;
    off += 12 + size;
  }
  let q = hdr;
  const n8 = b.readUInt32LE(q); q += 4 + n8;
  // From nWires to nConstraints is 24 bytes, not 20: nWires(4) nPubOut(4) nPubIn(4) nPrvIn(4)
  // nLabels(8). The first version of this line skipped 20 and read a zero out of the middle of
  // nLabels — and the cross-check below is the only reason that did not ship as "0 constraints,
  // comfortably under the ceiling", which is a check passing because it could not fail.
  const nWires = b.readUInt32LE(q); q += 24;
  return { nConstraints: b.readUInt32LE(q), nWires };
}

const { record, failed } = checklist();
console.log(`GATE LP2 — the expectation's closed form and its real cost — ${new Date().toISOString()}\n`);

const vc = validateQuadratureCopy(lpRisk, round, { volatility: 0.05, horizonPeriods: 30 });
record('the quadrature reproduced here is the engine\'s', vc.ok,
  `served ${vc.served}% · copy ${vc.mine.toFixed(8)}%`);

// ---- 1. the geometric restatement: 802 exponentials -> 2 ------------------------------------------
const N = 400, LO = -6, H = 12 / N;
const PDF = Array.from({ length: N + 1 }, (_, i) => Math.exp(-0.5 * (LO + H * i) ** 2));
const W = PDF.reduce((a, b) => a + b, 0);
function geomQuad(v) {
  const sd = Math.sqrt(v);
  let s = Math.exp(-v / 4 + (LO / 2) * sd);      // seed 1: exp(−v/4 − 3√v)
  const p = Math.exp((H / 2) * sd);              // seed 2: exp(0.015√v)
  let sum = 0;
  for (let i = 0; i <= N; i++) { sum += PDF[i] * ((2 * s) / (1 + s * s) - 1); if (i < N) s *= p; }
  return sum / W;
}
let worstGeom = 0, worstGeomV = 0, nGeom = 0;
for (let k = 1; k <= 4000; k++) {
  const v = Math.exp(Math.log(1e-6) + (k / 4000) * (Math.log(200) - Math.log(1e-6)));
  const g = Math.abs(expectedIlNumerical(v) - geomQuad(v));
  if (g > worstGeom) { worstGeom = g; worstGeomV = v; }
  nGeom++;
}
console.log(`  geometric chain vs the engine's 401-point pass: worst |gap| ${worstGeom.toExponential(3)} at v=${worstGeomV.toPrecision(6)}`);
console.log(`  exponentials per pass: 2 (the two seeds) against ${2 * (N + 1)} the engine performs\n`);
record('the 401-point quadrature restates as two exponentials and a multiply chain',
  worstGeom < 1e-13, `${nGeom} log-spaced v in [1e-6, 200], worst |gap| ${worstGeom.toExponential(3)}`);

// ---- 2. how coarse a sub-grid still reproduces the SERVED figure ----------------------------------
function subQuad(v, stride) {
  let sum = 0, w = 0;
  for (let i = 0; i <= N; i += stride) {
    const z = LO + H * i, pdf = Math.exp(-0.5 * z * z);
    const r = Math.exp(-0.5 * v + Math.sqrt(v) * z);
    sum += pdf * ((2 * Math.sqrt(r)) / (1 + r) - 1); w += pdf;
  }
  return sum / w;
}
console.log('  stride  nodes   worst |gap| to the full sum     rounded figures that differ');
const table = [];
for (const stride of [1, 2, 4, 5, 8, 10, 16, 20]) {
  let worst = 0, misses = 0, n = 0;
  for (let k = 1; k <= 3000; k++) {
    const v = Math.exp(Math.log(1e-6) + (k / 3000) * (Math.log(250) - Math.log(1e-6)));
    const a = expectedIlNumerical(v), b = subQuad(v, stride);
    worst = Math.max(worst, Math.abs(a - b));
    if (round(b * 100, 4) !== round(a * 100, 4)) misses++;
    n++;
  }
  const nodes = Math.floor(N / stride) + 1;
  table.push({ stride, nodes, worstGap: worst, mismatches: misses, of: n });
  console.log(`  ${String(stride).padEnd(7)} ${String(nodes).padEnd(7)} ${worst.toExponential(3).padEnd(30)} ${misses} of ${n}`);
}
const five = table.find((t) => t.stride === 5);
const eight = table.find((t) => t.stride === 8);
console.log('');
record('81 of the engine\'s own 401 nodes reproduce the published figure exactly',
  five.mismatches === 0, `stride 5, ${five.nodes} nodes, worst gap ${five.worstGap.toExponential(3)} against a 5e-7 half-step`);
record('a gap under half a published step is NOT the same claim as rounding to the same figure',
  eight.worstGap < 5e-7 && eight.mismatches > 0,
  `stride 8 (${eight.nodes} nodes) has worst gap ${eight.worstGap.toExponential(3)}, comfortably under 5e-7, and still `
  + `${eight.mismatches} of ${eight.of} rounded figures differ — so the guard must compare rounded values, not gaps`);

// ---- 3. what it actually costs, read from the artifact --------------------------------------------
const expPath = path.join(BUILD, 'lpexpectation.r1cs');
const divPath = path.join(BUILD, 'divergence.r1cs');
const brkPath = path.join(BUILD, 'lpbracket.r1cs');
if (!existsSync(expPath)) {
  console.log('  build/lpexpectation.r1cs is missing. Compile it (it deliberately exceeds the ceremony file,');
  console.log('  so build-circuit.mjs will refuse the setup — compile only):');
  console.log('    zk/circom.exe circuits/lpexpectation.circom --r1cs -o build');
  record('the expectation circuit is compiled so its cost can be read', false, 'artifact missing');
} else {
  // Cross-check the parser against a circuit whose count another gate records independently.
  const div = r1csConstraints(divPath);
  record('the r1cs header parser is right, checked against a circuit another gate already counted',
    div.nConstraints === 463, `divergence.r1cs reads ${div.nConstraints}; gateB4-0 records 887 Plonk over 463 R1CS`);

  const exp = r1csConstraints(expPath);
  const brk = r1csConstraints(brkPath);
  const over = exp.nConstraints / PTAU_CEILING;
  const powerAt1x = Math.ceil(Math.log2(exp.nConstraints));
  const powerAt2x = Math.ceil(Math.log2(exp.nConstraints * 2));
  console.log(`\n  divergence      (realizedIL identity)  : ${div.nConstraints} R1CS`);
  console.log(`  lpbracket       (the bisection's bracket): ${brk.nConstraints} R1CS`);
  console.log(`  lpexpectation   (81-node quadrature)    : ${exp.nConstraints} R1CS`);
  console.log(`  hez_final_12 ceiling                    : ${PTAU_CEILING}`);
  console.log(`  the expectation is ${over.toFixed(2)}x over it, and needs powers-of-tau 2^${powerAt1x}..2^${powerAt2x}`);
  console.log(`  (Plonk expands R1CS by between 1x and 2x depending on comparator density; both bounds given)\n`);
  record('the two provable statements fit the ceremony file this repo carries',
    div.nConstraints > 0 && brk.nConstraints > 0 && div.nConstraints <= PTAU_CEILING && brk.nConstraints <= PTAU_CEILING,
    `divergence ${div.nConstraints} and lpbracket ${brk.nConstraints}, both nonzero and both under ${PTAU_CEILING}`);
  record('the expectation does NOT fit, and the shortfall is a ceremony file rather than a missing identity',
    exp.nConstraints > PTAU_CEILING,
    `${exp.nConstraints} R1CS is ${over.toFixed(2)}x hez_final_12 — the binding cost is the per-node division `
    + 'bound, one signed range check per node at the width the tails require. This is a decision about a '
    + 'download, not a research problem.');

  writeFileSync(path.join(BUILD, 'gateLP2-expectation-cost.json'), JSON.stringify({
    at: new Date().toISOString(), passed: failed().length === 0,
    geometricRestatement: { samples: nGeom, worstGap: worstGeom, atV: worstGeomV, exponentialsPerPass: 2, engineExponentialsPerPass: 2 * (N + 1) },
    subGrid: table,
    constraints: { divergence: div.nConstraints, lpbracket: brk.nConstraints, lpexpectation: exp.nConstraints },
    ptauCeiling: PTAU_CEILING, timesOver: over, ptauPowerNeeded: [powerAt1x, powerAt2x],
  }, null, 2) + '\n', 'utf8');
}

const bad = failed();
const gate = bad.length === 0;
console.log(`${'='.repeat(70)}`);
console.log(`GATE LP2: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
process.exit(gate ? 0 : 1);
