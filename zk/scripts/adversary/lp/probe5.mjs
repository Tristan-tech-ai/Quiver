// PROBE 5 — does the ROOT-FREE form of the identity actually hold against the real engine?
// A constraint count for a circuit whose bound is violated is worth nothing, so the 446-constraint
// squared restatement gets the same sweep the witnessed-root form gets.
//   witnessed root:  L̂·(S + r̂) = 2·S·ŝ   with   ŝ² = r̂·S        two residuals, 463 R1CS
//   root eliminated: L̂²·(S + r̂)² = 4·r̂·S³                        one residual, 446 R1CS
import __P from '../paths.mjs';
const ENGINE = __P.vtUrl("src/engine/lpRisk.js");
const { lpRisk } = await import(ENGINE);
const { round } = await import(__P.vtUrl("src/engine/stats.js"));

const SCALE = 1000000000n, S = 1e9;
const toScaled = (x) => { const [w, f = ''] = Number(x).toFixed(9).split('.'); return BigInt(w) * SCALE + BigInt(f.padEnd(9, '0')); };
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const abs = (x) => (x < 0n ? -x : x);

let seed = 20260730;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const TOL_ID = 4n, TOL_ROOT = 1n, TOL_SQ = 1n;
let kept = 0, refused = 0;
let worstId = 0, worstRoot = 0, worstSq = 0, wIdAt = 0, wRootAt = 0, wSqAt = 0;
let sqViolations = 0, idViolations = 0, rootViolations = 0, sqNaiveViolations = 0, worstSqNaive = 0;

for (let i = 0; i < 4000; i++) {
  const r = Math.exp((rand() * 2 - 1) * Math.log(100));
  const res = lpRisk({ priceRatio: r, concentrationFactor: 1 });
  if (!res.ok || !res.realizedIL) continue;
  const servedPct = res.realizedIL.impermanentLossPct;
  const rHat = toScaled(r);
  if (rHat <= 0n) continue;

  const target = rHat * SCALE;
  let sHat = isqrt(target);
  if ((sHat + 1n) * (sHat + 1n) - target < target - sHat * sHat) sHat += 1n;
  const lFull = (2 * Number(sHat) / S) / (1 + Number(rHat) / S);
  const lHat = BigInt(Math.round(lFull * S));
  if (lHat <= 0n) continue;
  const certifiedPct = (Number(lHat) / S - 1) * 100;
  if (round(certifiedPct, 4) !== servedPct) { refused++; continue; }
  kept++;

  // witnessed-root form
  const Rs = sHat * sHat - rHat * SCALE;
  const R = lHat * (SCALE + rHat) - 2n * SCALE * sHat;
  const idTol = rHat + TOL_ID * SCALE;
  const rootTol = 2n * sHat + TOL_ROOT * SCALE;
  if (abs(R) * 2n > idTol) idViolations++;
  if (abs(Rs) * 2n > rootTol) rootViolations++;
  worstId = Math.max(worstId, Number(abs(R) * 2n) / Number(idTol));
  worstRoot = Math.max(worstRoot, Number(abs(Rs) * 2n) / Number(rootTol));

  // root-eliminated form: L̂²(S+r̂)² − 4 r̂ S³, bound 2·L̂·(S+r̂)² + TOL_SQ·S³
  const opr = SCALE + rHat, opr2 = opr * opr;
  const Rq = lHat * lHat * opr2 - 4n * rHat * SCALE * SCALE * SCALE;
  // NAIVE bound, the one I wrote first: 2·L̂·(S+r̂)² + S³.
  const sqTolNaive = 2n * lHat * opr2 + TOL_SQ * SCALE * SCALE * SCALE;
  // DERIVED bound. With L̂ = L·S + e and r̂ = r·S + f, |e|,|f| <= 1/2, expanding
  //   L̂²(S+r̂)² − 4r̂S³  around the exact identity L²(1+r)² = 4r  leaves three terms:
  //     2·L·S·e·(S+r̂)²          <=  L̂·(S+r̂)²        the L half-step, through a square
  //     (L·S)²·2·(S+r·S)·f      <=  L̂²·(S+r̂)        the r half-step, through the other square
  //     4·S³·f                  <=  2·S³            the right-hand side's own half-step
  // The naive bound kept only the first and doubled it, and the SECOND term is the same order —
  // which is why the sweep exceeded it by 1.82, a near-2.0 shape.
  // THIRD derivation. Two things the second one missed:
  //  (a) the published convention is 2|R| <= TOL, so TOL is twice the residual bound, not equal to it;
  //  (b) L̂ is not round(L·S) for the exact L — it is computed FROM the rounded root ŝ, so its own
  //      half-step is 1/2 + 2·(1/2)/(1+r̂/S) grid steps, not 1/2. That extra term is the 2·L̂·S·(S+r̂).
  const sqTolDerived = 2n * (lHat * opr2 + 2n * lHat * SCALE * opr + lHat * lHat * opr + 2n * SCALE * SCALE * SCALE);
  const ratioNaive = Number(abs(Rq) * 2n) / Number(sqTolNaive);
  const ratio = Number(abs(Rq) * 2n) / Number(sqTolDerived);
  if (ratioNaive > 1) sqNaiveViolations++;
  if (ratio > 1) sqViolations++;
  if (ratio > worstSq) { worstSq = ratio; wSqAt = r; }
  if (ratioNaive > worstSqNaive) worstSqNaive = ratioNaive;
}

console.log(`ratios certified            : ${kept}   refused by the served-figure guard: ${refused}`);
console.log(`witnessed-root  identity    : ${idViolations} violations, worst 2|R|/TOL  = ${worstId.toExponential(3)}`);
console.log(`witnessed-root  root        : ${rootViolations} violations, worst 2|Rs|/TOL = ${worstRoot.toExponential(3)}`);
console.log(`root-ELIMINATED, NAIVE bound   : ${sqNaiveViolations} violations, worst ${worstSqNaive.toExponential(3)}  <- my first derivation, EXCEEDED`);
console.log(`root-ELIMINATED, DERIVED bound : ${sqViolations} violations, worst 2|Rq|/TOL = ${worstSq.toExponential(3)} at r=${wSqAt.toPrecision(6)}`);
console.log(`  worst case uses 1/${(1 / worstSq).toFixed(2)} of the squared bound`);
console.log('\nbit width the squared residual needs:');
const rMax = 2n ** 44n - 1n;
const oprMax = SCALE + rMax;
const worstMag = 2n * SCALE * oprMax * oprMax + SCALE ** 3n;
console.log(`  at the circuit's declared ceiling r̂ = 2^44−1: 2·tolerance = ${(2n * worstMag).toString(2).length} bits`);
console.log(`  the witnessed-root residual at the same ceiling: ${(2n * (2n * (2n ** 38n) + SCALE)).toString(2).length} bits`);
