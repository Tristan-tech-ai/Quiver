// TWO REAL PLONK PROOFS on the EXISTING build/ncdf_plonk.zkey — one at d1, one at d2 of the same
// leg — then the leg price, the spread and the moneyness relation reconstructed from nothing but the
// two proofs' PUBLIC SIGNALS. Nothing is rebuilt: same circuit, same zkey, same hez_final_12.
import __P from '../paths.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const { snarkjs, shutdown, BUILD } = await import(__P.zkUrl("scripts/lib/gatekit.mjs"));
import { createRequire } from 'node:module';
const require = createRequire(__P.zkUrl("scripts/lib/gatekit.mjs"));
const { black76 } = await import(__P.vtUrl("src/engine/black76.js"));

const J = JSON.parse(readFileSync(path.join(BUILD, 'ncdf-consts.json'), 'utf8'));
const S = BigInt(J.S), G = J.G, NG = J.NG;
const ONE = BigInt(J.ONE), SQRT2PI = BigInt(J.SQRT2PI), ZSPLIT = BigInt(J.ZSPLIT);
const TOLC = BigInt(J.params.TOLC), TOLP = BigInt(J.params.TOLP);
const EXP = J.EXP.map((r) => r.map(BigInt)), BC = J.BC.map(BigInt), DC = J.DC.map(BigInt);
const ulp = 1 / Number(ONE);
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
  return { xMag, xSign: neg ? 1 : 0, nHat: neg ? cHat : ONE - cHat, pHat: (acc * ONE) / SQRT2PI, onBranch };
}

const sj = await snarkjs();
const vk = JSON.parse(readFileSync(path.join(BUILD, 'ncdf_vk.json'), 'utf8'));
const builder = await require(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));
const zkey = path.join(BUILD, 'ncdf_plonk.zkey');

const F = 100000, K = 100000, T = 30 / 365, sg = 0.6;
const g = black76(F, K, T, sg, 'call', 0);
console.log(`LEG  F=${F} K=${K} T=${T.toFixed(6)} sigma=${sg}  engine price $${g.price.toFixed(9)}`);
console.log(`     d1=${g.d1.toFixed(12)}  d2=${g.d2.toFixed(12)}  delta=${g.delta.toFixed(12)}\n`);

const out = [];
for (const [tag, x] of [['d1', g.d1], ['d2', g.d2]]) {
  const f = ncdfFx(x);
  const w = { xSign: String(f.xSign), xMag: String(f.xMag), nHat: String(f.nHat), pHat: String(f.pHat) };
  const wtns = await builder.calculateWTNSBin(w, 0);
  const t0 = Date.now();
  const r = await sj.plonk.prove(zkey, wtns);
  const ms = Date.now() - t0;
  const ok = await sj.plonk.verify(vk, r.publicSignals, r.proof);
  // and refuse a moved signal, so this is not a verifier that cannot fail
  const bad = [...r.publicSignals]; bad[5] = (BigInt(bad[5]) + 1n).toString();
  const badOk = await sj.plonk.verify(vk, bad, r.proof);
  console.log(`PROOF at ${tag}: verify=${ok}  nHat+1 refused=${badOk === false}  ${ms} ms  public=[${r.publicSignals.join(', ')}]`);
  out.push({ tag, ok, pub: r.publicSignals, ms, badOk });
}

const rd = (a) => ({ computed: BigInt(a[0]), tailC: BigInt(a[1]), tailP: BigInt(a[2]), xSign: BigInt(a[3]), xMag: BigInt(a[4]), nHat: BigInt(a[5]), pHat: BigInt(a[6]) });
const A = rd(out[0].pub), B = rd(out[1].pub);
const sgn = (o) => (o.xSign === 1n ? -1 : 1);
const x1 = Number(o1(A)), x2 = Number(o1(B));
function o1(o) { return sgn(o) * Number(o.xMag) / Number(ONE); }
const price = (F * Number(A.nHat) - K * Number(B.nHat)) / Number(ONE);
const money = Math.abs(F * Number(A.pHat) / Number(ONE) - K * Number(B.pHat) / Number(ONE));
console.log(`\nARITHMETIC ON THE TWO PROOFS' PUBLIC SIGNALS — no third circuit, no recursion:`);
console.log(`  R1 spread   x1-x2 = ${(x1 - x2).toFixed(12)}   sigma*sqrt(T) = ${(sg * Math.sqrt(T)).toFixed(12)}   |diff| ${Math.abs((x1 - x2) - sg * Math.sqrt(T)).toExponential(3)}`);
console.log(`  R2 money    F*p1 = ${(F * Number(A.pHat) / Number(ONE)).toFixed(9)}   K*p2 = ${(K * Number(B.pHat) / Number(ONE)).toFixed(9)}   |diff| ${money.toExponential(3)}  (tol ${((F + K) * Number(TOLP) * ulp).toExponential(3)})`);
console.log(`  R3 price    ${price.toFixed(9)}   engine ${g.price.toFixed(9)}   |diff| $${Math.abs(price - g.price).toExponential(3)}   envelope $${((F + K) * Number(TOLC) * ulp).toExponential(3)}`);
console.log(`  R4 delta    n1 = ${(Number(A.nHat) / Number(ONE)).toFixed(12)}   engine delta ${g.delta.toFixed(12)}   |diff| ${Math.abs(Number(A.nHat) / Number(ONE) - g.delta).toExponential(3)}`);
console.log(`  both verified: ${out[0].ok && out[1].ok};  both refuse a moved nHat: ${out[0].badOk === false && out[1].badOk === false}`);
console.log(`  total prove ${out[0].ms + out[1].ms} ms; on-chain cost is 2 verifier calls to the SAME 7080-byte contract.`);
await shutdown();
