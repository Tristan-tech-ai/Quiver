// PROBE — is the "permanent residue" real? Substitute a WRONG normal CDF and measure what breaks.
//
// The claim under test, written into greeksfp.circom, parity.circom and QUIVER_ROADMAP_V2.md:
//
//   "A service with a subtly wrong normal CDF satisfies this and every sibling identity and is
//    still wrong about the absolute price level."
//
// That is an assertion about eight identities. It has never been measured — the identity probe next
// door measures the identities against the CORRECT engine, which is the opposite test. So: re-derive
// black76 with a pluggable CDF, plug in three wrong ones, and report every residual plus the price
// error. If the claim is right, the residuals stay at machine precision while the price moves.
//
// The engine is NOT modified. `black76At` below is a re-derivation, and it is checked against the
// real engine on the real CDF first — if that check fails, nothing after it means anything.
//
//   node zk/scripts/probe-cdf-residue.mjs
import { load } from './service-root.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');

const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// ---- the engine's own CDF, copied so the re-derivation can be checked against the engine ---------
function hart(x) {
  const z = Math.abs(x);
  let c = 0;
  if (z <= 37) {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165; b = b * z + 33.912866078383; b = b * z + 112.079291497871;
      b = b * z + 221.213596169931; b = b * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207; d = d * z + 86.7807322029461; d = d * z + 296.564248779674;
      d = d * z + 637.333633378831; d = d * z + 793.826512519948; d = d * z + 440.413735824752;
      c = e * b / d;
    } else {
      let f = z + 0.65; f = z + 4 / f; f = z + 3 / f; f = z + 2 / f; f = z + 1 / f;
      c = e / (2.506628274631 * f);
    }
  }
  return x <= 0 ? c : 1 - c;
}

// ---- three wrong CDFs ---------------------------------------------------------------------------
// Each one is REFLECTION-SYMMETRIC, f(-x) = 1 - f(x), because that is what a CDF written as a tail
// plus a branch always is — including the engine's. That property is the whole story below.

// 1. Abramowitz–Stegun 7.1.26. A real, published, WRONG-BY-7.5e-8 approximation. The engine's own
//    header says it rejected this one; here it plays the part of a plausible competitor's choice.
function absteg(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const c = 0.5 * (1 - y);          // upper tail
  return x <= 0 ? c : 1 - c;
}

// 2. The logistic surrogate, a textbook "close enough" that is off by ~1e-2. Reflection-symmetric
//    exactly: 1/(1+e^{az}) = 1 - 1/(1+e^{-az}).
const logistic = (x) => 1 / (1 + Math.exp(-1.702 * x));

// 3. A deliberate ODD perturbation of the correct CDF. N_w(x) = N(x) + eps*x*e^{-x^2/4}. Adding an
//    ODD function to N(x) - 1/2 keeps reflection symmetry exactly, so this is the sharpest form of
//    the attack: arbitrarily chosen, monotone for small eps, and structurally undetectable.
const EPS = 3e-3;
const skewed = (x) => hart(x) + EPS * x * Math.exp(-x * x / 4);

// ---- black76, re-derived with a pluggable CDF ----------------------------------------------------
function black76At(N, F, K, T, sigma, type, r = 0) {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const df = Math.exp(-r * T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = npdf(d1);
  const isCall = type === 'call';
  const delta = df * (isCall ? N(d1) : N(d1) - 1);
  const gamma = df * nd1 / (F * sigma * sqrtT);
  const vega = df * F * nd1 * sqrtT / 100;
  const vanna = (-df * nd1 * d2 / sigma) * 0.01;
  const volga = vega * d1 * d2 / sigma * 0.01;
  const price = isCall ? df * (F * N(d1) - K * N(d2)) : df * (K * N(-d2) - F * N(-d1));
  const theta = ((-df * F * nd1 * sigma) / (2 * sqrtT) + r * price) / 365;
  return { delta, gamma, vega, vanna, volga, theta, price, d1, d2 };
}

const rel = (a, b) => { const s = Math.max(Math.abs(a), Math.abs(b), 1e-12); return Math.abs(a - b) / s; };

let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// r = 0 throughout, which is the domain greekssigned and parity actually claim.
const IDS = [
  ['A', 'd1 - d2 = sigma*sqrt(T)',        (c, p, x) => rel(c.d1 - c.d2, x.sigma * Math.sqrt(x.T))],
  ['B', 'vega*100 = gamma*F^2*sigma*T',   (c, p, x) => rel(c.vega * 100, c.gamma * x.F * x.F * x.sigma * x.T)],
  ['C', 'volga*sigma = vega*d1*d2*0.01',  (c, p, x) => rel(c.volga * x.sigma, c.vega * c.d1 * c.d2 * 0.01)],
  ['D', 'vanna*F*(d1-d2) = -vega*d2',     (c, p, x) => rel(c.vanna * x.F * (c.d1 - c.d2), -c.vega * c.d2)],
  ['E', 'theta*730*T = -vega*100*sigma',  (c, p, x) => rel(c.theta * 730 * x.T, -c.vega * 100 * x.sigma)],
  ['F', 'C - P = F - K   (df=1)',         (c, p, x) => rel(c.price - p.price, x.F - x.K)],
  ['G', 'dCall - dPut = 1',               (c, p, x) => rel(c.delta - p.delta, 1)],
  ['H', 'gamma/vega/vanna/volga call==put', (c, p) => Math.max(rel(c.gamma, p.gamma), rel(c.vega, p.vega), rel(c.vanna, p.vanna), rel(c.volga, p.volga))],
];

const CDFS = [
  ['hart (the engine)', hart],
  ['A-S 7.1.26', absteg],
  ['logistic 1.702x', logistic],
  [`hart + ${EPS}*x*e^{-x^2/4}`, skewed],
];

console.log(`CDF-RESIDUE PROBE — ${new Date().toISOString()}\n`);

// ---- 0. the re-derivation must agree with the engine on the engine's own CDF --------------------
let selfWorst = 0;
for (let i = 0; i < 2000; i++) {
  const F = 10 ** (rand() * 5), K = F * (0.3 + rand() * 2.7);
  const T = 7 / 365 + rand() * 2, sigma = 0.2 + rand() * 2.3;
  for (const ty of ['call', 'put']) {
    const a = black76(F, K, T, sigma, ty, 0), b = black76At(hart, F, K, T, sigma, ty, 0);
    for (const k of ['delta', 'gamma', 'vega', 'vanna', 'volga', 'theta', 'price', 'd1', 'd2']) {
      selfWorst = Math.max(selfWorst, rel(a[k], b[k]));
    }
  }
}
console.log(`  re-derivation vs the real engine, on hart: worst relative ${selfWorst.toExponential(2)}`);
if (selfWorst > 1e-15) { console.log('  ABORT — the re-derivation is not the engine. Nothing below is evidence.'); process.exit(1); }
console.log('  identical to double precision, so the substitutions below are the engine with one part swapped.\n');

// ---- 1. every identity, under every CDF ---------------------------------------------------------
const N = 4000;
const table = new Map();
const priceErr = new Map();
for (const [cname] of CDFS) { table.set(cname, new Map()); priceErr.set(cname, { relWorst: 0, absWorst: 0, relSum: 0, n: 0, at: null, deltaWorst: 0 }); }

for (let i = 0; i < N; i++) {
  const F = 10 ** (rand() * 5), K = F * (0.3 + rand() * 2.7);
  const T = 7 / 365 + rand() * 2, sigma = 0.2 + rand() * 2.3;
  const ctx = { F, K, T, sigma, r: 0 };
  const truth = black76(F, K, T, sigma, 'call', 0);
  if (!truth) continue;
  for (const [cname, Nf] of CDFS) {
    const c = black76At(Nf, F, K, T, sigma, 'call', 0);
    const p = black76At(Nf, F, K, T, sigma, 'put', 0);
    if (!c || !p) continue;
    const m = table.get(cname);
    for (const [id, , fn] of IDS) {
      const r = fn(c, p, ctx);
      m.set(id, Math.max(m.get(id) ?? 0, r));
    }
    const pe = priceErr.get(cname);
    const rp = rel(c.price, truth.price), ap = Math.abs(c.price - truth.price);
    if (rp > pe.relWorst) { pe.relWorst = rp; pe.at = { F, K, T, sigma }; }
    pe.absWorst = Math.max(pe.absWorst, ap);
    pe.deltaWorst = Math.max(pe.deltaWorst, Math.abs(c.delta - truth.delta));
    pe.relSum += rp; pe.n++;
  }
}

console.log(`  ${N} surfaces. WORST relative residual of each identity, per CDF:\n`);
const head = `  ${'identity'.padEnd(32)}` + CDFS.map(([n]) => n.padStart(22)).join('');
console.log(head);
console.log('  ' + '-'.repeat(head.length - 2));
for (const [id, name] of IDS) {
  let row = `  ${(id + '  ' + name).padEnd(32)}`;
  for (const [cname] of CDFS) row += table.get(cname).get(id).toExponential(2).padStart(22);
  console.log(row);
}

console.log(`\n  And what the wrong CDF did to the number a buyer pays for:\n`);
console.log(`  ${'CDF'.padEnd(32)}${'worst rel price err'.padStart(22)}${'mean rel'.padStart(12)}${'worst abs delta err'.padStart(22)}`);
for (const [cname] of CDFS) {
  const pe = priceErr.get(cname);
  console.log(`  ${cname.padEnd(32)}${pe.relWorst.toExponential(2).padStart(22)}${(pe.relSum / pe.n).toExponential(2).padStart(12)}${pe.deltaWorst.toExponential(2).padStart(22)}`);
}

// ---- 2. the verdict ------------------------------------------------------------------------------
// A residual is "still exact" if it stays where the correct engine put it. 1e-9 is the same
// threshold the identity probe uses to separate exact algebra from a wrong derivation.
console.log(`\n  VERDICT`);
let allSurvive = true;
for (const [cname] of CDFS) {
  if (cname.startsWith('hart (')) continue;
  const worst = Math.max(...[...table.get(cname).values()]);
  const pe = priceErr.get(cname);
  const survives = worst < 1e-9;
  if (!survives) allSurvive = false;
  console.log(`    ${cname.padEnd(32)} every identity worst ${worst.toExponential(2)} — ${survives ? 'ALL EIGHT STILL HOLD' : 'SOMETHING BREAKS'}; price off by up to ${(pe.relWorst * 100).toFixed(2)}%`);
}
console.log(`\n  ${allSurvive
  ? 'The residue is REAL. Every one of the eight identities is blind to the CDF, including parity.'
  : 'At least one identity detects a wrong CDF — the residue claim as written is too strong.'}`);

console.log(`\n  WHY parity does not help, which is the part the circuit header gets wrong.`);
console.log('    parity.circom says it "ties a call to a put at the same strike, so a price that drifts');
console.log('    on one side and not the other fails here". In Black-76 the put is not an independent');
console.log('    quotation: P = df*(K*N(-d2) - F*N(-d1)). Any N with N(-x) = 1 - N(x) — which every');
console.log('    tail-plus-branch implementation is, the engine included — gives');
console.log('        C - P = df*(F*N(d1) - K*N(d2)) - df*(K - F + F*N(d1) - K*N(d2)) = df*(F - K)');
console.log('    ALGEBRAICALLY, with N cancelling. Parity cannot drift on one side only, so it is not');
console.log('    a weaker check on the price level. It is not a check on the price level at all.');
