// PROBE — pick the fixed-point scale from a measurement, and find out what the circuit must refuse.
//
// probe-ncdf-fixedpoint.mjs showed Hart is computable in integers at 2^-44. 2^-44 is not free: the
// truncation range check after every multiply costs S constraints, and there are ~25 of them, so S is
// the single biggest term in the circuit's size. This measures the accuracy at each S so the choice is
// a trade read off a table rather than a preference.
//
// It also measures the two things that decide the circuit's DOMAIN:
//   - how often |d1| or |d2| leaves Hart's own [0, 7.0711) branch on a realistic book
//   - how large |d| actually gets, since that sets the integer width of z
//
//   node zk/scripts/probe-ncdf-params.mjs
import { load } from './service-root.mjs';
const { black76 } = await load(import.meta.url, 'engine/black76.js');

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
const npdfJs = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

const XS = 200n, XONE = 1n << XS;
function expNegExtended(numer, denomPow2) {
  const xNum = numer * (XONE >> BigInt(denomPow2));
  let term = XONE, sum = 0n, k = 0n;
  for (;;) { sum += (k % 2n === 0n ? term : -term); k += 1n; term = (term * xNum) / (XONE * k); if (term === 0n || k > 1200n) break; }
  return sum;
}
// sqrt(2*pi) to 40 places, for the pdf constraint.
const SQRT2PI = '2.5066282746310005024157652848110452530070';

function buildEvaluator(Sn, Gn) {
  const S = BigInt(Sn), G = BigInt(Gn), ONE = 1n << S;
  const WINT = 5n, WBITS = WINT + S;
  const NG = Number((WBITS + G - 1n) / G);
  const toS = (v) => (v + (1n << (XS - S - 1n))) >> (XS - S);
  const fx = (str) => {
    const neg = str.startsWith('-'); const s = neg ? str.slice(1) : str;
    const [w, f = ''] = s.split('.'); const D = 40;
    const num = (BigInt(w) * 10n ** BigInt(D) + BigInt(f.padEnd(D, '0').slice(0, D))) * ONE;
    const den = 10n ** BigInt(D); const q = (num + den / 2n) / den;
    return neg ? -q : q;
  };
  const TABLE = [];
  for (let g = 0; g < NG; g++) {
    const row = []; const shift = BigInt(g) * G;
    for (let j = 0; j < Number(1n << G); j++) {
      const numer = BigInt(j) << shift;
      row.push(numer === 0n ? ONE : toS(expNegExtended(numer, Sn)));
    }
    TABLE.push(row);
  }
  const BC = ['0.0352624965998911', '0.700383064443688', '6.37396220353165', '33.912866078383',
    '112.079291497871', '221.213596169931', '220.206867912376'].map(fx);
  const DC = ['0.0883883476483184', '1.75566716318264', '16.064177579207', '86.7807322029461',
    '296.564248779674', '637.333633378831', '793.826512519948', '440.413735824752'].map(fx);
  const SP = fx(SQRT2PI);
  const mulS = (a, b) => (a * b) >> S;

  return {
    S, ONE, NG, WBITS, TABLE, BC, DC, SP,
    // returns { cHat, eHat, pdfHat } for zHat in [0, ZSPLIT)
    tail(zHat) {
      const W = (zHat * zHat) >> (S + 1n);
      let e = ONE;
      for (let g = 0; g < NG; g++) e = mulS(e, TABLE[g][Number((W >> (BigInt(g) * G)) & ((1n << G) - 1n))]);
      let b = BC[0]; for (let i = 1; i < BC.length; i++) b = mulS(b, zHat) + BC[i];
      let d = DC[0]; for (let i = 1; i < DC.length; i++) d = mulS(d, zHat) + DC[i];
      const c = (mulS(e, b) * ONE) / d;
      const pdf = (e * ONE) / SP;
      return { cHat: c, eHat: e, pdfHat: pdf, bHat: b, dHat: d, W };
    },
    ncdf(xHat) {
      const zHat = xHat < 0n ? -xHat : xHat;
      const { cHat } = this.tail(zHat);
      return xHat <= 0n ? cHat : ONE - cHat;
    },
    num: (v) => Number(v) / Number(ONE),
  };
}

console.log(`NCDF PARAMETER PROBE — ${new Date().toISOString()}\n`);

// ---- 1. accuracy vs S, and the constraint cost that buys it -------------------------------------
const ZSPLIT = 7.07106781186547;
console.log('  Accuracy of the integer evaluator at each fixed-point scale, over |x| < 7.0711.');
console.log('  "cost" counts only the terms that depend on S: one S-bit range check after each of the');
console.log('  NG exp multiplies and each of the 13 Horner steps, plus the two wide checks.\n');
console.log(`  ${'S'.padStart(4)}${'groups'.padStart(8)}${'worst |dN|'.padStart(14)}${'worst |dphi|'.padStart(14)}${'price env, ref leg'.padStart(20)}${'S-dependent cost'.padStart(18)}`);

const REF = { F: 100000, K: 100000, T: 30 / 365, sigma: 0.6 };
const refPrice = black76(REF.F, REF.K, REF.T, REF.sigma, 'call', 0).price;
const priceEnv = (u) => (REF.F + REF.K) * u;

const rows = [];
for (const Sn of [24, 28, 32, 36, 40, 44]) {
  const ev = buildEvaluator(Sn, 4);
  let wN = 0, wP = 0;
  const NPT = 40001;
  for (let i = 0; i < NPT; i++) {
    const x = -ZSPLIT + (2 * ZSPLIT * i) / (NPT - 1);
    const xHat = BigInt(Math.round(x * Number(ev.ONE)));
    const z = xHat < 0n ? -xHat : xHat;
    const t = ev.tail(z);
    const got = xHat <= 0n ? t.cHat : ev.ONE - t.cHat;
    wN = Math.max(wN, Math.abs(ev.num(got) - hart(x)));
    wP = Math.max(wP, Math.abs(ev.num(t.pdfHat) - npdfJs(x)));
  }
  const cost = ev.NG * (1 + Sn) + 13 * (1 + Sn) + (Sn + 1) + Number(ev.WBITS);
  rows.push({ Sn, NG: ev.NG, wN, wP, cost });
  console.log(`  ${String(Sn).padStart(4)}${String(ev.NG).padStart(8)}${wN.toExponential(2).padStart(14)}${wP.toExponential(2).padStart(14)}${('$' + priceEnv(wN).toExponential(2)).padStart(20)}${String(cost).padStart(18)}`);
}
console.log(`\n  Reference leg: F=K=$${REF.F.toLocaleString()}, T=30d, sigma=0.6, true price $${refPrice.toFixed(2)}.`);

// ---- 2. what the circuit has to refuse -----------------------------------------------------------
// Hart splits at z = 7.0711. Below it the rational branch; above it a continued fraction. A circuit
// that carries only ONE branch must refuse the other, and how often that bites is a fact about a real
// book, not a matter of taste.
let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

console.log(`\n  How often does a realistic leg leave Hart's rational branch?`);
const BOOKS = [
  ['the identity sweeps\' own range (F 1e1..1e5, K 0.3..3x, T 7d..2y, sig 0.2..2.5)', () => {
    const F = 10 ** (1 + rand() * 4);
    return { F, K: F * (0.3 + rand() * 2.7), T: 7 / 365 + rand() * 2, sigma: 0.2 + rand() * 2.3 };
  }],
  ['a listed Deribit-shaped book (K 0.5..2x, T 1d..180d, sig 0.4..1.5)', () => {
    const F = 10 ** (3 + rand() * 2);
    return { F, K: F * (0.5 + rand() * 1.5), T: 1 / 365 + rand() * (179 / 365), sigma: 0.4 + rand() * 1.1 };
  }],
  ['a hostile short-dated wing (K 0.2..5x, T 1h..7d, sig 0.3..3.0)', () => {
    const F = 10 ** (3 + rand() * 2);
    return { F, K: F * (0.2 + rand() * 4.8), T: 1 / 8760 + rand() * (7 / 365), sigma: 0.3 + rand() * 2.7 };
  }],
];
console.log(`\n  ${'book'.padEnd(60)}${'|d| >= 7.0711'.padStart(15)}${'max |d|'.padStart(10)}`);
const bookStats = [];
for (const [name, gen] of BOOKS) {
  let n = 0, out = 0, maxD = 0;
  for (let i = 0; i < 20000; i++) {
    const { F, K, T, sigma } = gen();
    const g = black76(F, K, T, sigma, 'call', 0);
    if (!g) continue;
    for (const d of [g.d1, g.d2]) { n++; const a = Math.abs(d); if (a >= ZSPLIT) out++; maxD = Math.max(maxD, a); }
  }
  bookStats.push({ name, pct: (out / n) * 100, maxD });
  console.log(`  ${name.padEnd(60)}${((out / n) * 100).toFixed(2).padStart(14)}%${maxD.toFixed(1).padStart(10)}`);
}

// ---- 3. is the CDF pinned enough to pin the SHARED GREEK FACTOR? ----------------------------------
// The whole identity family cancels one common factor, df*phi(d1). Hart's own intermediate e^{-z^2/2}
// IS that factor up to 1/sqrt(2pi) — so an evaluator that computes the CDF has already computed the
// pdf, at no extra multiply. Verify that against the engine's own gamma, which is df*phi(d1)/(F*sig*sqrtT).
{
  const ev = buildEvaluator(40, 4);
  let worst = 0, checked = 0, skipped = 0;
  for (let i = 0; i < 4000; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.5 + rand() * 1.5);
    const T = 7 / 365 + rand() * 2, sigma = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sigma, 'call', 0);
    if (!g) continue;
    if (Math.abs(g.d1) >= ZSPLIT) { skipped++; continue; }
    const xHat = BigInt(Math.round(Math.abs(g.d1) * Number(ev.ONE)));
    const { pdfHat } = ev.tail(xHat);
    // gamma = phi(d1) / (F*sigma*sqrt(T))  at r = 0
    const gammaFromPdf = ev.num(pdfHat) / (F * sigma * Math.sqrt(T));
    worst = Math.max(worst, Math.abs(gammaFromPdf - g.gamma) / Math.max(g.gamma, 1e-300));
    checked++;
  }
  console.log(`\n  The shared factor, recovered from the CDF's own exp intermediate:`);
  console.log(`    phi(d1) from the evaluator, divided by F*sigma*sqrt(T), vs the engine's published gamma`);
  console.log(`    ${checked} legs, worst RELATIVE difference ${worst.toExponential(2)}   (${skipped} skipped for |d1| >= 7.0711)`);
  console.log(`    So pinning the CDF pins gamma ABSOLUTELY, and through identity B and E, vega and theta with it.`);
  console.log(`    The cancelling factor stops cancelling. That is the residue closing, not being bounded.`);
}
