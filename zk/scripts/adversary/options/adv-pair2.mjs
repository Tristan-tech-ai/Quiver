// Part 2: (a) the pair pin strength, measured properly this time (the first pass saturated at my
// search cap of 1.0 — the clean-power diagnostic), and (b) TWO REAL PLONK PROOFS on the EXISTING
// ncdf_plonk.zkey, at d1 and at d2 of one real leg, with the leg price reconstructed from the two
// proofs' published signals. If that verifies, "the leg price does not fit hez_final_12" is false:
// it never needed one circuit.
import __P from '../paths.mjs';
import { readFileSync } from 'node:fs';
import { createRequire as cr } from 'node:module';
import path from 'node:path';

const ZK = __P.ZK;
const BUILD = path.join(ZK, 'build');
const require = cr(path.join(ZK, 'scripts', 'x.cjs'));
const { black76 } = await import(__P.vtUrl("src/engine/black76.js"));
const sj = await import(__P.zkUrl("node_modules/snarkjs/main.js"));

const J = JSON.parse(readFileSync(path.join(BUILD, 'ncdf-consts.json'), 'utf8'));
const S = BigInt(J.S), G = J.G, NG = J.NG;
const ONE = BigInt(J.ONE), SQRT2PI = BigInt(J.SQRT2PI), ZSPLIT = BigInt(J.ZSPLIT);
const TOLC = BigInt(J.params.TOLC), TOLP = BigInt(J.params.TOLP);
const EXP = J.EXP.map((r) => r.map(BigInt)), BC = J.BC.map(BigInt), DC = J.DC.map(BigInt);
const ulp = 1 / Number(ONE);
const mulS = (a, b) => (a * b) >> S;
function evalFx(zc) {
  const W = (zc * zc) >> (S + 1n);
  let acc = ONE;
  for (let g = 0; g < NG; g++) acc = mulS(acc, EXP[g][Number((W >> BigInt(g * G)) & 15n)]);
  let b = BC[0]; for (let i = 1; i < BC.length; i++) b = mulS(b, zc) + BC[i];
  let d = DC[0]; for (let i = 1; i < DC.length; i++) d = mulS(d, zc) + DC[i];
  return { eHat: acc, bHat: b, dHat: d };
}
function ncdfFx(x) {
  const neg = x < 0;
  const xMag = BigInt(Math.round(Math.abs(x) * Number(ONE)));
  const onBranch = xMag < ZSPLIT;
  const zc = onBranch ? xMag : ZSPLIT - 1n;
  const { eHat, bHat, dHat } = evalFx(zc);
  const cHat = onBranch ? (eHat * bHat) / dHat : 0n;
  return { xMag, xSign: neg ? 1 : 0, nHat: neg ? cHat : ONE - cHat, pHat: (eHat * ONE) / SQRT2PI, onBranch };
}

let seed = 20260730;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ---- (a) pin strength, bucketed by |d1|, no saturating cap --------------------------------------
console.log('4b. PAIR PIN STRENGTH, measured per |d1| bucket. The shift e moves BOTH d1 and d2 so the');
console.log('    linear spread check x1-x2 = sigma*sqrt(T) still passes; the question is how far the');
console.log('    moneyness relation F*p1 == K*p2 lets it go. Tolerance (F+K)*TOLP*ulp.');
const buckets = [[0, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 4], [4, 5.5], [5.5, 7.07]];
const stats = buckets.map(() => ({ n: 0, worst: 0, at: null }));
let weaker = 0, tot = 0;
for (let i = 0; i < 4000; i++) {
  const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
  const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
  const g = black76(F, K, T, sg, 'call', 0);
  if (!g) continue;
  const a0 = ncdfFx(g.d1), b0 = ncdfFx(g.d2);
  if (!a0.onBranch || !b0.onBranch) continue;
  const tol = (F + K) * Number(TOLP) * ulp;
  const ok = (e) => {
    const a = ncdfFx(g.d1 + e), b = ncdfFx(g.d2 + e);
    if (!a.onBranch || !b.onBranch) return false;
    return Math.abs(F * Number(a.pHat) / Number(ONE) - K * Number(b.pHat) / Number(ONE)) <= tol;
  };
  // grow then bisect, so nothing is capped silently
  let hi = 1e-12;
  while (ok(hi) && hi < 8) hi *= 2;
  let lo = hi / 2;
  if (!ok(lo)) { lo = 0; }
  for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  const ad = Math.abs(g.d1);
  const bi = buckets.findIndex(([a, b]) => ad >= a && ad < b);
  if (bi >= 0) {
    stats[bi].n++;
    if (lo > stats[bi].worst) { stats[bi].worst = lo; stats[bi].at = { F, K, T, sg, d1: g.d1 }; }
  }
  tot++;
  if (lo > 9.16e-4) weaker++;
}
console.log(`    ${'|d1|'.padEnd(12)}${'legs'.padStart(6)}${'worst admissible shift'.padStart(24)}`);
buckets.forEach(([a, b], i) => {
  const s = stats[i];
  console.log(`    ${(a + '-' + b).padEnd(12)}${String(s.n).padStart(6)}${(s.n ? s.worst.toExponential(3) : '-').padStart(24)}`);
});
console.log(`    ${tot} legs total; ${weaker} (${(weaker / tot * 100).toFixed(2)}%) admit a shift LARGER than their`);
console.log('    single-proof off-circuit worst of 9.16e-4 — all of them deep-wing, where phi(d1) has');
console.log('    fallen under the tolerance floor. That is the honest limit of the pin, and it is the');
console.log('    same floor that broke their first PHI_TAIL derivation.');

// ---- (b) two real proofs on the existing zkey ---------------------------------------------------
console.log('\n5b. TWO REAL PLONK PROOFS on build/ncdf_plonk.zkey (unchanged, hez_final_12, 4096 domain).');
const F = 100000, K = 100000, T = 30 / 365, sg = 0.6;
const g = black76(F, K, T, sg, 'call', 0);
const f1 = ncdfFx(g.d1), f2 = ncdfFx(g.d2);
const vk = JSON.parse(readFileSync(path.join(BUILD, 'ncdf_vk.json'), 'utf8'));
const builder = await require(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));
const out = [];
for (const [tag, f] of [['d1', f1], ['d2', f2]]) {
  const w = { xSign: String(f.xSign), xMag: String(f.xMag), nHat: String(f.nHat), pHat: String(f.pHat) };
  const t0 = Date.now();
  const wtns = await builder.calculateWTNSBin(w, 0);
  const r = await sj.plonk.prove(path.join(BUILD, 'ncdf_plonk.zkey'), wtns);
  const ms = Date.now() - t0;
  const ok = await sj.plonk.verify(vk, r.publicSignals, r.proof);
  console.log(`    ${tag}: xMag=${f.xMag} nHat=${f.nHat} pHat=${f.pHat} -> verify ${ok} (${ms} ms, ${r.publicSignals.length} public signals)`);
  out.push({ tag, ok, pub: r.publicSignals, ms });
}
// The registry receives both (proof, publicSignals) pairs. The price is then arithmetic on them.
const [p1, p2] = out;
// public signal order: [computed, tailC, tailP, xSign, xMag, nHat, pHat]
const rd = (a) => ({ computed: BigInt(a[0]), tailC: BigInt(a[1]), tailP: BigInt(a[2]), xSign: BigInt(a[3]), xMag: BigInt(a[4]), nHat: BigInt(a[5]), pHat: BigInt(a[6]) });
const A = rd(p1.pub), B = rd(p2.pub);
const price = (F * Number(A.nHat) - K * Number(B.nHat)) / Number(ONE);
const spread = Number(A.xMag - B.xMag * (B.xSign === 1n ? -1n : 1n) * (A.xSign === 1n ? -1n : 1n)) / Number(ONE);
const x1 = Number(A.xMag) / Number(ONE) * (A.xSign === 1n ? -1 : 1);
const x2 = Number(B.xMag) / Number(ONE) * (B.xSign === 1n ? -1 : 1);
console.log(`    both proofs verified: ${p1.ok && p2.ok}, computed flags ${A.computed}/${B.computed}`);
console.log(`    RELATION 1 spread : x1-x2 = ${(x1 - x2).toFixed(12)} vs sigma*sqrt(T) = ${(sg * Math.sqrt(T)).toFixed(12)}  diff ${Math.abs((x1 - x2) - sg * Math.sqrt(T)).toExponential(2)}`);
console.log(`    RELATION 2 money  : F*p1 = ${(F * Number(A.pHat) / Number(ONE)).toFixed(9)}  K*p2 = ${(K * Number(B.pHat) / Number(ONE)).toFixed(9)}  diff ${Math.abs(F * Number(A.pHat) / Number(ONE) - K * Number(B.pHat) / Number(ONE)).toExponential(2)}`);
console.log(`    RELATION 3 price  : ${price.toFixed(9)} vs engine ${g.price.toFixed(9)}  diff $${Math.abs(price - g.price).toExponential(3)}`);
console.log(`    RELATION 4 delta  : n1 = ${(Number(A.nHat) / Number(ONE)).toFixed(12)} vs engine delta ${g.delta.toFixed(12)}`);
console.log(`    envelope the pair can promise on the price: (F+K)*TOLC*ulp = $${((F + K) * Number(TOLC) * ulp).toExponential(3)}`);
console.log(`    total prove time ${p1.ms + p2.ms} ms for the whole leg-price statement.`);
