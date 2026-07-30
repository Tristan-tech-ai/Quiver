// What the closed form actually reaches, and a claim defect it exposes.
import __P from '../paths.mjs';
const VT = __P.VT;
const { lpRisk } = await import(`file:///${VT}/src/engine/lpRisk.js`);

const r = lpRisk({ priceRatio: 1.35, volatility: 0.55, horizonPeriods: 30, feeAprPct: 20, capitalUsd: 100000 });
const numeric = [];
for (const [block, obj] of Object.entries(r)) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, val] of Object.entries(obj)) if (typeof val === 'number') numeric.push(`${block}.${k}`);
  }
}
console.log(`numeric fields in a full envelope: ${numeric.length}`);
console.log(numeric.map((s) => '  ' + s).join('\n'));

// --- the claim defect: expectedIlPct and expectedIlLeadingOrderPct are not "diverging
//     approximations". One is exactly the log of the other, at EVERY v.
const e = r.expectedDivergence;
const L = 1 + e.expectedIlPct / 100;
const lead = e.expectedIlLeadingOrderPct / 100;
console.log(`\nCLAIM DEFECT`);
console.log(`  expectedIlPct               ${e.expectedIlPct}`);
console.log(`  expectedIlLeadingOrderPct   ${e.expectedIlLeadingOrderPct}`);
console.log(`  approximationGapPct         ${e.approximationGapPct}`);
console.log(`  exp(leadingOrder)           ${(Math.exp(lead) * 100 - 100).toFixed(4)}   <- equals expectedIlPct`);
console.log(`  ln(1 + expectedIlPct/100)   ${(Math.log(L) * 100).toFixed(4)}   <- equals expectedIlLeadingOrderPct`);
let worstLink = 0, n = 0;
for (let i = 0; i < 2000; i++) {
  const sigma = 0.01 + (2.5 * i) / 1999, T = 1 + ((i * 41) % 365);
  const q = lpRisk({ volatility: sigma, horizonPeriods: T });
  const d = q.expectedDivergence;
  if (d.expectedIlPct <= -100) continue;
  const lhs = 1 + d.expectedIlPct / 100, rhs = Math.exp(d.expectedIlLeadingOrderPct / 100);
  worstLink = Math.max(worstLink, Math.abs(lhs - rhs)); n++;
}
console.log(`  worst |(1+E/100) - exp(lead/100)| over ${n} live calls: ${worstLink.toExponential(3)}  (rounding of two 4-dp fields)`);
console.log(`  the engine's note says the two "diverge" outside the small-variance regime, and publishes`);
console.log(`  approximationGapPct ${e.approximationGapPct} as an approximation error. It is exp(x)-1-x at x=-v/8:`);
console.log(`  exp(x)-1-x = ${((Math.exp(lead) - 1 - lead) * 100).toFixed(4)}  vs published ${e.approximationGapPct}`);

// --- breakeven ratio is a closed form in the fee fraction alone: (sigma*/sigma_lead)^2 = -ln(1-f)/f
const fv = r.feeVsDivergence;
const f = fv.horizonFeesPct / 100;
console.log(`\nBREAKEVEN, both fields closed form in f = horizonFeesPct/100 = ${f}`);
console.log(`  breakevenVolatility              ${fv.breakevenVolatility}   vs sqrt(-8 ln(1-f)/T) = ${Math.sqrt(-8 * Math.log(1 - f) / 30).toFixed(5)}`);
console.log(`  breakevenVolatilityLeadingOrder  ${fv.breakevenVolatilityLeadingOrder}   vs sqrt(8f/T)         = ${Math.sqrt(8 * f / 30).toFixed(5)}`);
console.log(`  ratio^2 = -ln(1-f)/f = ${(-Math.log(1 - f) / f).toFixed(9)}  (no T, no sigma, no quadrature)`);

// --- MONOTONICITY: they swept 20,001 samples. The closed form proves it.
console.log(`\nMONOTONICITY  dE/dv = -exp(-v/8)/8 < 0 for all v: a one-line proof, not a 20,001-point sweep.`);
console.log(`SATURATION    they measured saturation within 1e-12 of the floor at v=209.4;`);
console.log(`              closed form: exp(-v/8) = 1e-12 at v = ${(-8 * Math.log(1e-12)).toFixed(4)}`);
