// ADVERSARIAL RE-MEASUREMENT of the ncdf verdict.
//
// Claim under attack (investigator's "could not check"):
//   (1) "pinning d1 needs ln(F/K) ... NOT BUILT" — an extra exp gadget.
//   (2) "price = F*N(d1) - K*N(d2) needs ncdf twice: 2 x 3740 = 7480 Plonk against a 4096 ceiling,
//        so it does not fit hez_final_12."
//
// Counter-hypothesis: ncdf publishes (xSign, xMag, nHat, pHat) as PUBLIC signals and only CHECKS
// them. So a second instance is a second PROOF of the same zkey, not a bigger circuit. Every
// cross-relation is then arithmetic on public signals:
//   price : df*(F*n1 - K*n2)                            linear
//   spread: x1 - x2 = sigma*sqrt(T)                     linear
//   money : F*phi(d1) = K*phi(d2)                       ONE multiply, NO logarithm
// The third relation is a Black-76 identity that is ABSENT from the 8 they probed.
import __P from '../paths.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ZK = __P.ZK;
const { black76 } = await import(__P.vtUrl("src/engine/black76.js"));

const J = JSON.parse(readFileSync(path.join(ZK, 'build', 'ncdf-consts.json'), 'utf8'));
const S = BigInt(J.S), G = J.G, NG = J.NG, WBITS = J.WBITS;
const ONE = BigInt(J.ONE), SQRT2PI = BigInt(J.SQRT2PI), ZSPLIT = BigInt(J.ZSPLIT);
const CDF_TAIL = BigInt(J.CDF_TAIL), PHI_TAIL = BigInt(J.PHI_TAIL);
const TOLC = BigInt(J.params.TOLC), TOLP = BigInt(J.params.TOLP);
const EXP = J.EXP.map((r) => r.map(BigInt)), BC = J.BC.map(BigInt), DC = J.DC.map(BigInt);
const ulp = 1 / Number(ONE);

// ---- 0. sanity on the imported table (I am reading the generator's JSON, so cross-check it) -------
{
  const e1 = Number(EXP[0][1]) / Number(ONE), t1 = Math.exp(-1 / Number(ONE));
  const sq = Number(SQRT2PI) / Number(ONE), tsq = Math.sqrt(2 * Math.PI);
  const g11 = Number(EXP[11][15]) / Number(ONE), tg = Math.exp(-(15 * 2 ** 44) / Number(ONE));
  console.log('0. TABLE CROSS-CHECK (against Math, independent of the generator)');
  console.log(`   EXP[0][1]   ulp err ${Math.abs(e1 - t1) / ulp}`);
  console.log(`   EXP[11][15] ulp err ${Math.abs(g11 - tg) / ulp}`);
  console.log(`   SQRT2PI     units off ${Math.abs(sq - tsq) / ulp}`);
  console.log(`   192 exp + ${BC.length + DC.length} coeff + 1 SQRT2PI = ${192 + BC.length + DC.length + 1} constants`);
}

// ---- 1. my own fixed-point evaluator, written from the circuit source, not copied from a probe ----
const mulS = (a, b) => (a * b) >> S;
function evalFx(zc) {
  const W = (zc * zc) >> (S + 1n);            // z^2/2 at 2^-S, floor — as the circuit does
  let acc = ONE;
  for (let g = 0; g < NG; g++) {
    const nib = Number((W >> BigInt(g * G)) & 15n);
    acc = mulS(acc, EXP[g][nib]);
  }
  let b = BC[0]; for (let i = 1; i < BC.length; i++) b = mulS(b, zc) + BC[i];
  let d = DC[0]; for (let i = 1; i < DC.length; i++) d = mulS(d, zc) + DC[i];
  return { eHat: acc, bHat: b, dHat: d, W };
}
/** the fixed-point CDF the circuit ACCEPTS at x: cHat = e*b/d (upper tail), n = x<0 ? c : 1-c */
function ncdfFx(x) {
  const neg = x < 0;
  const xMag = BigInt(Math.round(Math.abs(x) * Number(ONE)));
  const onBranch = xMag < ZSPLIT;
  const zc = onBranch ? xMag : ZSPLIT - 1n;
  const { eHat, bHat, dHat } = evalFx(zc);
  const cHat = onBranch ? (eHat * bHat) / dHat : 0n;
  const nHat = neg ? cHat : ONE - cHat;
  const pHat = (eHat * ONE) / SQRT2PI;
  return { xMag, xSign: neg ? 1 : 0, nHat, pHat, eHat, bHat, dHat, onBranch };
}

let seed = 424242;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
// the engine's own CDF, mirrored (Hart) so "true" here is what the service publishes
function hartJs(x) {
  const z = Math.abs(x); let c = 0;
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
      c = e / (2.506628274631 * (z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))))));
    }
  }
  return x <= 0 ? c : 1 - c;
}

// ---- 2. re-measure THEIR load-bearing number: worst |dN| at S=40 ----------------------------------
{
  let worst = 0, worstAt = 0, worstP = 0;
  for (let i = 0; i < 20000; i++) {
    const x = (rand() * 2 - 1) * 7.07;
    const f = ncdfFx(x);
    if (!f.onBranch) continue;
    const dn = Math.abs(Number(f.nHat) / Number(ONE) - hartJs(x));
    const dp = Math.abs(Number(f.pHat) / Number(ONE) - npdf(x));
    if (dn > worst) { worst = dn; worstAt = x; }
    if (dp > worstP) worstP = dp;
  }
  console.log('\n1. RE-MEASUREMENT of the S=40 accuracy claim (their figure: worst |dN| 2.69e-12)');
  console.log(`   worst |dN| ${worst.toExponential(3)} at x=${worstAt.toFixed(4)}  (${(worst / ulp).toFixed(2)} ulp)`);
  console.log(`   worst |dphi| ${worstP.toExponential(3)}  (${(worstP / ulp).toFixed(2)} ulp)   [1 ulp = ${ulp.toExponential(3)}]`);
}

// ---- 3. THE MISSED IDENTITY: F*phi(d1) = K*phi(d2), over real surfaces ----------------------------
{
  let worstRel = 0, n = 0, meanRel = 0, worstCase = null;
  for (let i = 0; i < 5000; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sg, 'call', 0);
    if (!g) continue;
    const nd1 = g.gamma * F * sg * Math.sqrt(T);      // the engine's OWN published gamma, inverted
    const nd2 = npdf(g.d2);
    const lhs = F * nd1, rhs = K * nd2;
    const rel = Math.abs(lhs - rhs) / Math.max(Math.abs(lhs), Math.abs(rhs), 1e-300);
    meanRel += rel; n++;
    if (rel > worstRel) { worstRel = rel; worstCase = { F, K, T, sg, lhs, rhs }; }
  }
  console.log('\n2. THE IDENTITY THEY DID NOT PROBE:  F*phi(d1) == K*phi(d2)');
  console.log(`   ${n} surfaces, worst relative residual ${worstRel.toExponential(3)}, mean ${(meanRel / n).toExponential(3)}`);
  console.log(`   worst at F=${worstCase.F.toFixed(2)} K=${worstCase.K.toFixed(2)} T=${worstCase.T.toFixed(4)} sigma=${worstCase.sg.toFixed(3)}`);
  console.log('   NOTE: this identity uses the DENSITY AT d2, which none of A..H touches. It is the');
  console.log('   moneyness pin: phi(d1)/phi(d2) = e^{-(d1 s - s^2/2)} = K/F with s = d1 - d2.');
}

// ---- 4. THE TWO-PROOF LEG PRICE, in fixed point, against the publication grid ---------------------
{
  console.log('\n3. LEG PRICE FROM TWO ncdf PUBLIC-SIGNAL SETS (no third circuit, no bigger ptau)');
  console.log('   price = df*(F*n1 - K*n2)/2^S, with n1,n2 the two proofs\' nHat.');
  let worstAbs = 0, worstFrac = 0, wc = null, kept = 0, offBranch = 0;
  for (let i = 0; i < 4000; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sg, 'call', 0);
    if (!g) continue;
    const f1 = ncdfFx(g.d1), f2 = ncdfFx(g.d2);
    if (!f1.onBranch || !f2.onBranch) { offBranch++; continue; }
    kept++;
    const price = (F * Number(f1.nHat) - K * Number(f2.nHat)) / Number(ONE);
    const abs = Math.abs(price - g.price);
    const grid = 5e-7;                       // round(value, 6)
    if (abs > worstAbs) { worstAbs = abs; wc = { F, K, T, sg, price, truth: g.price }; }
    if (abs / grid > worstFrac) worstFrac = abs / grid;
  }
  console.log(`   ${kept} legs on-branch (${offBranch} had d1 or d2 past the split)`);
  console.log(`   worst |price error| $${worstAbs.toExponential(3)}  = ${worstFrac.toFixed(2)}x the round(x,6) grid (5e-7)`);
  console.log(`   worst at F=${wc.F.toFixed(2)} K=${wc.K.toFixed(2)} T=${wc.T.toFixed(4)} sg=${wc.sg.toFixed(3)}: got ${wc.price.toFixed(9)} vs ${wc.truth.toFixed(9)}`);
}

// ---- 5. PAIR RELOCATION ATTACK vs their single-proof off-circuit check -----------------------------
{
  console.log('\n4. PAIR RELOCATION ATTACK. Shift BOTH d1,d2 by e (spread preserved, so the linear');
  console.log('   spread check passes) and ask how far e can go before F*p1 == K*p2 fails.');
  console.log('   Their single-proof off-circuit check allowed a worst shift of 9.16e-4.');
  let worstE = 0, wc = null, n = 0;
  for (let i = 0; i < 1500; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sg, 'call', 0);
    if (!g) continue;
    const base = ncdfFx(g.d1), base2 = ncdfFx(g.d2);
    if (!base.onBranch || !base2.onBranch) continue;
    n++;
    // tolerance on the moneyness relation: each pHat is within TOLP ulp of the true density
    const tol = (F + K) * Number(TOLP) * ulp;
    // binary search the largest |e| that still satisfies |F*p1(x1+e) - K*p2(x2+e)| <= tol
    let lo = 0, hi = 1;
    const ok = (e) => {
      const a = ncdfFx(g.d1 + e), b = ncdfFx(g.d2 + e);
      if (!a.onBranch || !b.onBranch) return false;
      return Math.abs(F * Number(a.pHat) / Number(ONE) - K * Number(b.pHat) / Number(ONE)) <= tol;
    };
    if (ok(hi)) { lo = hi; } else {
      for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    }
    if (lo > worstE) { worstE = lo; wc = { F, K, T, sg, s: g.d1 - g.d2, d1: g.d1 }; }
  }
  console.log(`   ${n} legs. WORST admissible shift |e| = ${worstE.toExponential(3)}`);
  console.log(`   worst at F=${wc.F.toFixed(2)} K=${wc.K.toFixed(2)} T=${wc.T.toFixed(5)} sigma=${wc.sg.toFixed(3)} s=${wc.s.toExponential(3)} d1=${wc.d1.toFixed(4)}`);
  console.log(`   predicted scaling: e ~ tol/(F*phi(d1)*s) — degrades as s = sigma*sqrt(T) -> 0.`);
}

// ---- 6. does the PAIR catch Abramowitz-Stegun where parity does not? ------------------------------
{
  const asCdf = (x) => {                      // A-S 7.1.26
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const p = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const v = 1 - npdf(Math.abs(x)) * p * (2 * Math.PI) ** 0 * 1;
    const c = npdf(Math.abs(x)) * p;
    return x >= 0 ? 1 - c : c;
  };
  console.log('\n5. DOES THE PAIR CATCH A-S? (parity cannot: N(-x)=1-N(x) cancels out of C-P)');
  let refused = 0, tot = 0, worstX = 0;
  for (let i = 0; i < 1200; i++) {
    const F = 10 ** (1 + rand() * 4), K = F * (0.3 + rand() * 2.7);
    const T = 7 / 365 + rand() * 2, sg = 0.2 + rand() * 2.3;
    const g = black76(F, K, T, sg, 'call', 0);
    if (!g) continue;
    const f1 = ncdfFx(g.d1), f2 = ncdfFx(g.d2);
    if (!f1.onBranch || !f2.onBranch) continue;
    tot++;
    // an A-S service publishes THIS price; the pair reconstructs the price from pinned CDFs
    const asPrice = F * asCdf(g.d1) - K * asCdf(g.d2);
    const pinned = (F * Number(f1.nHat) - K * Number(f2.nHat)) / Number(ONE);
    const envelope = (F + K) * Number(TOLC) * ulp;   // what the price statement can honestly promise
    const x = Math.abs(asPrice - pinned) / envelope;
    if (x > 1) refused++;
    if (x > worstX) worstX = x;
  }
  console.log(`   ${tot} legs, price-statement envelope (F+K)*TOLC ulp: refused ${refused}/${tot} = ${(refused / tot * 100).toFixed(2)}%`);
  console.log(`   worst overshoot ${worstX.toExponential(3)}x the envelope`);
}
