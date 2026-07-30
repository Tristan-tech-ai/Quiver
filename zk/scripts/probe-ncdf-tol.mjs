// PROBE — what tolerance must ncdf.circom carry, measured against the engine it will be asked about?
//
// The circuit can be built two ways and the choice decides whether it is useful.
//
//   TIGHT   the tolerance covers only the floor remainders, so the prover must hand in the circuit's
//           OWN fixed-point result. The statement is then "n is the fixed-point Hart evaluation",
//           and the distance to the true N(x) is a separate claim nothing in the proof carries.
//   USEFUL  the tolerance covers the fixed-point error too, so the circuit accepts the number the
//           SERVICE actually publishes — a double, rounded — and the statement becomes "n is within
//           E of the true normal CDF at x", which is what a buyer can act on.
//
// USEFUL needs a constant, and greeksfp's own header records what happens when that constant comes
// from a probe rather than from the gate that enforces it: the first bound was violated at 146.9%.
// So this measures the deviation the gate will see, over the real engine, and the number goes into the
// generator from here.
//
//   node zk/scripts/probe-ncdf-tol.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './service-root.mjs';

const ZK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { black76 } = await load(import.meta.url, 'engine/black76.js');
const K = JSON.parse(readFileSync(path.join(ZK, 'build', 'ncdf-consts.json'), 'utf8'));

const S = BigInt(K.S), ONE = BigInt(K.ONE), G = BigInt(K.G), NG = K.NG;
const ZSPLIT = BigInt(K.ZSPLIT), SQRT2PI = BigInt(K.SQRT2PI);
const EXP = K.EXP.map((r) => r.map(BigInt));
const BC = K.BC.map(BigInt), DC = K.DC.map(BigInt);
const u = 1 / 2 ** K.S;

const mulS = (a, b) => (a * b) >> S;

/** The circuit's exact integer path, mirrored. Returns the values the constraints pin. */
function evalFx(zHat) {
  const W = (zHat * zHat) >> (S + 1n);
  let e = ONE;
  for (let g = 0; g < NG; g++) e = mulS(e, EXP[g][Number((W >> (BigInt(g) * G)) & ((1n << G) - 1n))]);
  let b = BC[0]; for (let i = 1; i < BC.length; i++) b = mulS(b, zHat) + BC[i];
  let d = DC[0]; for (let i = 1; i < DC.length; i++) d = mulS(d, zHat) + DC[i];
  return { eHat: e, bHat: b, dHat: d, W };
}

const absB = (v) => (v < 0n ? -v : v);
let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

console.log(`NCDF TOLERANCE PROBE — ${new Date().toISOString()}\n`);
console.log(`  S=${K.S} (1 ulp = ${u.toExponential(3)}) · ${NG} exp groups · ZSPLIT ${ZSPLIT}\n`);

// ---- the deviation the gate will see -------------------------------------------------------------
// For each real leg at r=0:  call delta = N(d1) exactly, and gamma = phi(d1)/(F*sigma*sqrt(T)).
// So the witness the service can actually supply is round(delta * 2^S) and round(gamma*F*sigma*sqrtT * 2^S),
// and the question is how far each lands from what the circuit computes.
const RUNS = 20000;
let kept = 0, tail = 0;
let worstC = 0, worstP = 0, atC = null;
const hist = new Map();
for (let i = 0; i < RUNS; i++) {
  const F = 10 ** (1 + rand() * 4), Kx = F * (0.3 + rand() * 2.7);
  const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
  const g = black76(F, Kx, T, sg, 'call', 0);
  if (!g) continue;
  const d1 = g.d1;
  const xMag = BigInt(Math.round(Math.abs(d1) * Number(ONE)));
  if (xMag >= ZSPLIT) { tail++; continue; }
  kept++;

  // what the SERVICE publishes, put on the grid
  const nHat = BigInt(Math.round(g.delta * Number(ONE)));
  const phi = g.gamma * F * sg * Math.sqrt(T);
  const pHat = BigInt(Math.round(phi * Number(ONE)));

  // what the CIRCUIT computes
  const { eHat, bHat, dHat } = evalFx(xMag);
  const cHat = d1 <= 0 ? nHat : ONE - nHat;

  // the c relation, in ulp:  |cHat*dHat - eHat*bHat| / dHat
  const devC = Number(absB(cHat * dHat - eHat * bHat)) / Number(dHat);
  // the phi relation, in ulp: |pHat*SQRT2PI - eHat*ONE| / SQRT2PI
  const devP = Number(absB(pHat * SQRT2PI - eHat * ONE)) / Number(SQRT2PI);
  if (devC > worstC) { worstC = devC; atC = { F, K: Kx, T, sg, d1, delta: g.delta }; }
  worstP = Math.max(worstP, devP);
  const bucket = Math.ceil(devC);
  hist.set(bucket, (hist.get(bucket) || 0) + 1);
}

console.log(`  ${kept} legs on the computed branch (${tail} above the split, ${((tail / (kept + tail)) * 100).toFixed(2)}%)`);
console.log(`  worst deviation of the SERVICE's published value from the circuit's evaluation:`);
console.log(`     CDF relation  ${worstC.toFixed(3)} ulp  = ${(worstC * u).toExponential(2)} absolute`);
console.log(`     pdf relation  ${worstP.toFixed(3)} ulp  = ${(worstP * u).toExponential(2)} absolute`);
console.log(`  worst CDF case: F ${atC.F.toPrecision(6)} K ${atC.K.toPrecision(6)} T ${atC.T.toPrecision(4)} sigma ${atC.sg.toPrecision(4)} d1 ${atC.d1.toPrecision(6)}`);
console.log(`\n  distribution of the CDF deviation, in ulp:`);
for (const k of [...hist.keys()].sort((a, b) => a - b)) {
  const n = hist.get(k);
  console.log(`    <= ${String(k).padStart(3)} ulp  ${String(n).padStart(6)}  ${'#'.repeat(Math.max(1, Math.round((n / kept) * 60)))}`);
}

// ---- the DERIVED bound, so the constant is not just the measured worst plus a guess --------------
// Every term is a count of ulp. Evaluated on a grid of z because the Horner amplification and the
// exponential decay pull in opposite directions and the maximum is interior, not at an endpoint.
console.log(`\n  DERIVED bound on |fixed-point c - true c|, in ulp, term by term.`);
console.log(`  Horner amplifies: an error introduced at step k is multiplied by z once per later step,`);
console.log(`  so the b and d terms carry sum_j z^j and are largest at large z, where e is smallest.`);
const NBC = BC.length, NDC = DC.length;
let worstBound = 0, atZ = 0, breakdown = null;
for (let i = 0; i <= 200000; i++) {
  const z = (7.07106781186547 * i) / 200000;
  const e = Math.exp(-z * z / 2);
  // b(z), d(z) at double precision, only to size the bound — not used as a value anywhere.
  let b = 0.0352624965998911;
  for (const c of [0.700383064443688, 6.37396220353165, 33.912866078383, 112.079291497871, 221.213596169931, 220.206867912376]) b = b * z + c;
  let d = 0.0883883476483184;
  for (const c of [1.75566716318264, 16.064177579207, 86.7807322029461, 296.564248779674, 637.333633378831, 793.826512519948, 440.413735824752]) d = d * z + c;
  const geo = (n) => (z === 1 ? n : (z ** n - 1) / (z - 1));
  // e: 1 ulp from quantising W, NG truncations at 1 ulp, NG constant roundings at 0.5 ulp
  const dE = 1 + NG + NG * 0.5;
  // b: (NBC-1) truncations at 1 ulp and NBC coefficient roundings at 0.5, each amplified by z^(later steps)
  const dB = (1 + 0.5) * geo(NBC);
  const dD = (1 + 0.5) * geo(NDC);
  const t1 = dE * (b / d);
  const t2 = (e * dB) / d;
  const t3 = (e * b * dD) / (d * d);
  const t4 = 1 + Number(ONE) / d / Number(ONE);   // the circuit's own c-relation slack, ~1.0023 ulp
  const tot = t1 + t2 + t3 + t4;
  if (tot > worstBound) { worstBound = tot; atZ = z; breakdown = { t1, t2, t3, t4, b, d, e }; }
}
console.log(`    worst at z = ${atZ.toFixed(5)}:`);
console.log(`      from e   (${dEStr()})           ${breakdown.t1.toFixed(3)} ulp`);
console.log(`      from b                          ${breakdown.t2.toExponential(2)} ulp`);
console.log(`      from d                          ${breakdown.t3.toExponential(2)} ulp`);
console.log(`      the c relation's own slack       ${breakdown.t4.toFixed(4)} ulp`);
console.log(`      TOTAL                           ${worstBound.toFixed(3)} ulp = ${(worstBound * u).toExponential(2)} absolute`);
function dEStr() { return `${1 + NG + NG * 0.5} ulp x b/d`; }

const TOLC = Math.ceil(worstBound) + 1;
console.log(`\n  So TOLC = ceil(${worstBound.toFixed(3)}) + 1 = ${TOLC} ulp.`);
console.log(`  Measured worst uses ${((worstC / TOLC) * 100).toFixed(1)}% of it — a bound the sweep tests rather than one nothing reaches.`);
console.log(`  TOLP: pdf slack is one SQRT2PI remainder plus |de|/sqrt(2pi) = ${(1 + (1 + NG * 1.5) / 2.5066).toFixed(3)} ulp;`);
const TOLP = Math.ceil(1 + (1 + NG * 1.5) / 2.5066282746) + 1;
console.log(`  measured worst ${worstP.toFixed(3)} ulp, so TOLP = ${TOLP}.`);

// ---- price terms, which is the only unit that matters to a buyer -------------------------------
const REF = { F: 100000, K: 100000, T: 30 / 365, sigma: 0.6 };
const refPrice = black76(REF.F, REF.K, REF.T, REF.sigma, 'call', 0).price;
console.log(`\n  IN PRICE TERMS. price = F*N(d1) - K*N(d2) at r=0, so an envelope of E on each N gives`);
console.log(`  a price envelope of (F+K)*E. On F=K=$100,000, T=30d, sigma=0.6 (true price $${refPrice.toFixed(2)}):`);
console.log(`     circuit envelope  ${(TOLC * u).toExponential(2)}  ->  $${((REF.F + REF.K) * TOLC * u).toExponential(2)}  (${(((REF.F + REF.K) * TOLC * u) / refPrice * 100).toExponential(2)}% of the price)`);
console.log(`\n  { "TOLC": ${TOLC}, "TOLP": ${TOLP} }   <- paste into gen-ncdf-circom.mjs`);
