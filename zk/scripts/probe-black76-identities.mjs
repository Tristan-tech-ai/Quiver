// RESEARCH PROBE — how much of Black-76 is provable with no transcendental at all?
//
// The claim I wrote into the plan was: options-risk imports black76, which uses Math.exp, Math.log and
// a normal-CDF approximation, therefore it is blocked until erf can be proven in a circuit. That claim
// is about COMPUTING an option price. It may be wrong about PROVING one.
//
// Kelly could not be proven as f = (p(b+1)−1)/b, a division; it could be proven as f·b = p·b + p − 1,
// which is the same statement with nothing to divide. The question here is the same one asked a level
// up: does Black-76 have relations among the numbers it already publishes that are POLYNOMIAL, so a
// circuit can hold them without ever evaluating N() or exp()?
//
// Derived candidates, all in terms of what black76 already returns:
//
//   A  d1 − d2 = σ·√T                            with √T a witness pinned by s² = T
//   B  vega·100 = gamma·F²·σ·T                   gamma and vega share df·nd1, which cancels
//   C  volga·σ = vega·d1·d2·0.01                 volga is defined from vega
//   D  vanna·F·(d1 − d2) = −vega·d2              vanna via vega, with σ√T rewritten as d1 − d2
//   E  theta·365·2·T = −vega·100·σ + 2·T·r·price
//   F  C − P = df·(F − K)                        put-call parity, df a witness
//   G  Δcall − Δput = df
//   H  gamma, vega, vanna, volga identical for a call and a put at the same strike
//
// EVERY ONE OF THESE IS A DERIVATION AND THEREFORE A GUESS. The engine applies its own scaling — vega
// per vol-point, theta per calendar day, vanna and volga times 0.01 — and a derivation that ignores a
// convention is wrong in a way that reads as correct. So this measures each one against the real
// black76 over thousands of random surfaces and reports the residual. Only what survives measurement
// is worth putting in a circuit.
//
//   node zk/scripts/probe-black76-identities.mjs
import { load } from './service-root.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');

let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// Relative residual, so a 1e-6 absolute error on a quantity of size 1e6 is not mistaken for a defect.
const rel = (lhs, rhs) => {
  const scale = Math.max(Math.abs(lhs), Math.abs(rhs), 1e-12);
  return Math.abs(lhs - rhs) / scale;
};

const IDENTITIES = [
  {
    id: 'A', name: 'd1 − d2 = σ·√T',
    holds: (g, { sigma, T }) => rel(g.d1 - g.d2, sigma * Math.sqrt(T)),
    polynomial: 'given s with s² = T: (d1 − d2) = σ·s',
  },
  {
    id: 'B', name: 'vega·100 = gamma·F²·σ·T',
    holds: (g, { F, sigma, T }) => rel(g.vega * 100, g.gamma * F * F * sigma * T),
    polynomial: 'direct, no witness needed',
  },
  {
    id: 'C', name: 'volga·σ = vega·d1·d2·0.01',
    holds: (g, { sigma }) => rel(g.volga * sigma, g.vega * g.d1 * g.d2 * 0.01),
    polynomial: 'direct',
  },
  {
    id: 'D', name: 'vanna·F·(d1 − d2) = −vega·d2',
    holds: (g, { F }) => rel(g.vanna * F * (g.d1 - g.d2), -g.vega * g.d2),
    polynomial: 'direct — note σ√T never appears, it is rewritten as d1 − d2',
  },
  {
    id: 'E', name: 'theta·365·2·T = −vega·100·σ + 2·T·r·price',
    holds: (g, { sigma, T, r }) => rel(g.theta * 365 * 2 * T, -g.vega * 100 * sigma + 2 * T * r * g.price),
    polynomial: 'direct',
  },
];

// Parity needs a call AND a put at the same strike, so it is measured separately.
const PARITY = [
  {
    id: 'F', name: 'C − P = df·(F − K)',
    holds: (c, p, { F, K, T, r }) => rel(c.price - p.price, Math.exp(-r * T) * (F - K)),
    polynomial: 'given df as a witness: (C − P) = df·(F − K)',
  },
  {
    id: 'G', name: 'Δcall − Δput = df',
    holds: (c, p, { T, r }) => rel(c.delta - p.delta, Math.exp(-r * T)),
    polynomial: 'given the same df witness',
  },
  {
    id: 'H', name: 'gamma/vega/vanna/volga identical for call and put',
    holds: (c, p) => Math.max(rel(c.gamma, p.gamma), rel(c.vega, p.vega), rel(c.vanna, p.vanna), rel(c.volga, p.volga)),
    polynomial: 'equality, the cheapest constraint there is',
  },
];

console.log(`Black-76 identity probe — ${new Date().toISOString()}\n`);
console.log('  Which relations among the PUBLISHED greeks are polynomial, and do they actually hold?\n');

const N = 5000;
const stats = new Map();
const record = (id, r) => {
  const s = stats.get(id) || { worst: 0, sum: 0, n: 0, at: null };
  if (r > s.worst) s.worst = r;
  s.sum += r; s.n++;
  stats.set(id, s);
};

let sampled = 0;
for (let i = 0; i < N; i++) {
  // A realistic crypto surface: forwards from $1 to $100k, strikes 0.3x to 3x, a week to two years,
  // vol from 20% to 250%, and a rate that is usually zero because crypto futures options mostly are.
  const F = 10 ** (rand() * 5);
  const K = F * (0.3 + rand() * 2.7);
  const T = 7 / 365 + rand() * 2;
  const sigma = 0.2 + rand() * 2.3;
  const r = rand() < 0.7 ? 0 : rand() * 0.1;

  const call = black76(F, K, T, sigma, 'call', r);
  const put = black76(F, K, T, sigma, 'put', r);
  if (!call || !put) continue;
  sampled++;

  const ctx = { F, K, T, sigma, r };
  for (const idn of IDENTITIES) record(idn.id, idn.holds(call, ctx));
  for (const idn of PARITY) record(idn.id, idn.holds(call, put, ctx));
}

console.log(`  ${sampled} surfaces sampled\n`);
console.log(`  ${'id'.padEnd(4)}${'identity'.padEnd(44)}${'worst rel'.padStart(12)}${'mean rel'.padStart(12)}   verdict`);
const all = [...IDENTITIES, ...PARITY];
const survivors = [];
for (const idn of all) {
  const s = stats.get(idn.id);
  const worst = s.worst, mean = s.sum / s.n;
  // A relation that holds to double precision is exact algebra, not an approximation. 1e-9 is far
  // looser than the 1e-13 a clean identity gives and far tighter than anything a wrong derivation
  // would reach, so it separates the two without needing judgement.
  const exact = worst < 1e-9;
  if (exact) survivors.push(idn);
  console.log(`  ${idn.id.padEnd(4)}${idn.name.padEnd(44)}${worst.toExponential(2).padStart(12)}${mean.toExponential(2).padStart(12)}   ${exact ? 'EXACT — provable' : 'FAILS — my derivation was wrong'}`);
}

console.log(`\n  ${survivors.length} of ${all.length} survive measurement.\n`);
for (const s of survivors) console.log(`    ${s.id}: ${s.polynomial}`);

// The honest limit, stated whatever the result.
console.log(`\n  WHAT THIS WOULD AND WOULD NOT PROVE`);
console.log('    Proven: the greeks are mutually consistent with Black-76 for the (F, K, T, σ) given,');
console.log('    and, through parity, that a call and a put at one strike are priced against each other.');
console.log('    NOT proven: that N(d2) was evaluated correctly. Nothing here evaluates it, so a service');
console.log('    with a subtly wrong normal CDF would satisfy every one of these and still be wrong');
console.log('    about the absolute price level. That is the residue, and it is the honest thing to say.');

const failed = all.length - survivors.length;
process.exit(survivors.length >= 4 ? 0 : 1);
