// Prove the SINGLE-CIRCUIT two-CDF leg price. 7758 Plonk constraints, against a power-13 ptau
// generated locally in about five minutes. If this verifies, the leg price was never blocked by
// mathematics — it was blocked by a 9 MB file nobody had made.
import __P from '../paths.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { snarkjs, shutdown } = await import(__P.zkUrl("scripts/lib/gatekit.mjs"));
const require = createRequire(__P.zkUrl("scripts/lib/gatekit.mjs"));
const { black76 } = await import(__P.vtUrl("src/engine/black76.js"));

const SP = __P.WORK;
const J = JSON.parse(readFileSync(path.join(__P.BUILD, "ncdf-consts.json"), 'utf8'));
const S = BigInt(J.S), G = J.G, NG = J.NG;
const ONE = BigInt(J.ONE), SQRT2PI = BigInt(J.SQRT2PI), ZSPLIT = BigInt(J.ZSPLIT);
const EXP = J.EXP.map((r) => r.map(BigInt)), BC = J.BC.map(BigInt), DC = J.DC.map(BigInt);
const mulS = (a, b) => (a * b) >> S;
function ncdfFx(x) {
  const neg = x < 0;
  const xMag = BigInt(Math.round(Math.abs(x) * Number(ONE)));
  const onBranch = xMag < ZSPLIT;
  const zc = onBranch ? xMag : ZSPLIT - 1n;
  const W = (zc * zc) >> (S + 1n);
  let acc = ONE;
  for (let g = 0; g < NG; g++) acc = mulS(acc, EXP[g][Number((W >> BigInt(g * G)) & 15n)]);
  let b = BC[0]; for (let i = 1; i < BC.length; i++) b = mulS(b, zc) + BC[i];
  let d = DC[0]; for (let i = 1; i < DC.length; i++) d = mulS(d, zc) + DC[i];
  const cHat = onBranch ? (acc * b) / d : 0n;
  return { xMag, xSign: neg ? 1n : 0n, nHat: neg ? cHat : ONE - cHat, pHat: (acc * ONE) / SQRT2PI, onBranch };
}

const F = 100000, K = 120000, T = 30 / 365, sg = 0.6;
const g = black76(F, K, T, sg, 'call', 0);
const f1 = ncdfFx(g.d1), f2 = ncdfFx(g.d2);
const Fhat = BigInt(F) * ONE, Khat = BigInt(K) * ONE;
const sx1 = f1.xSign === 1n ? -f1.xMag : f1.xMag;
const sx2 = f2.xSign === 1n ? -f2.xMag : f2.xMag;
const sHat = sx1 - sx2;
const sTrue = BigInt(Math.round(sg * Math.sqrt(T) * Number(ONE)));
const fn = Fhat * f1.nHat, kn = Khat * f2.nHat;
const priceHat = (fn - kn) / ONE;

const w = {
  xSign1: String(f1.xSign), xMag1: String(f1.xMag), nHat1: String(f1.nHat), pHat1: String(f1.pHat),
  xSign2: String(f2.xSign), xMag2: String(f2.xMag), nHat2: String(f2.nHat), pHat2: String(f2.pHat),
  Fhat: String(Fhat), Khat: String(Khat), sHat: String(sHat), priceHat: String(priceHat),
};
console.log(`LEG F=${F} K=${K} T=${(T).toFixed(6)} sigma=${sg}   engine price $${g.price.toFixed(9)}`);
console.log(`  d1=${g.d1.toFixed(12)} d2=${g.d2.toFixed(12)}  on-branch ${f1.onBranch}/${f2.onBranch}`);
console.log(`  sHat from the two x's = ${sHat}, round(sigma*sqrt(T)*2^40) = ${sTrue}, differ by ${sHat - sTrue}`);
console.log(`  moneyness residual |F*p1 - K*p2| = ${(Math.abs(F * Number(f1.pHat) - K * Number(f2.pHat)) / Number(ONE)).toExponential(3)}  (tol ${((F + K) * 10 / Number(ONE)).toExponential(3)})`);
console.log(`  price from the circuit's own pinned CDFs: $${(Number(priceHat) / Number(ONE)).toFixed(9)}  vs engine $${g.price.toFixed(9)}  diff $${Math.abs(Number(priceHat) / Number(ONE) - g.price).toExponential(3)}`);

const sj = await snarkjs();
const builder = await require(path.join(SP, 'build', 'price40b_js', 'witness_calculator.cjs'))(readFileSync(path.join(SP, 'build', 'price40b_js', 'price40b.wasm')));
const wtns = await builder.calculateWTNSBin(w, 0);
const zkey = path.join(SP, 'build', 'price40b_plonk.zkey');
const vkey = await sj.zKey.exportVerificationKey(zkey);
const t0 = Date.now();
const r = await sj.plonk.prove(zkey, wtns);
const ms = Date.now() - t0;
const ok = await sj.plonk.verify(vkey, r.publicSignals, r.proof);
console.log(`\nSINGLE-CIRCUIT LEG PRICE: verify = ${ok}   ${ms} ms   ${r.publicSignals.length} public signals`);

// A verifier that cannot fail is the disease. Move each public signal by one and require refusal.
let refused = 0;
for (let i = 0; i < r.publicSignals.length; i++) {
  const bad = [...r.publicSignals];
  bad[i] = (BigInt(bad[i]) + 1n).toString();
  if ((await sj.plonk.verify(vkey, bad, r.proof)) === false) refused++;
}
console.log(`  every public signal +1 refused: ${refused}/${r.publicSignals.length}`);

// and a wrong CDF must be refused by witness generation itself
const asCdf = (x) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const c = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI) * p;
  return x >= 0 ? 1 - c : c;
};
const wAS = { ...w, nHat1: String(BigInt(Math.round(asCdf(g.d1) * Number(ONE)))), nHat2: String(BigInt(Math.round(asCdf(g.d2) * Number(ONE)))) };
wAS.priceHat = String((Fhat * BigInt(wAS.nHat1) - Khat * BigInt(wAS.nHat2)) / ONE);
let asRefused = false;
try { await builder.calculateWTNSBin(wAS, 0); } catch { asRefused = true; }
console.log(`  an Abramowitz-Stegun priced leg is refused by the same circuit: ${asRefused}`);
await shutdown();
