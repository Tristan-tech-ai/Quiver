// MEASURE, do not infer. Count the transcendental evaluations lp-risk actually performs,
// per published block, by instrumenting Math rather than reading the loop bounds.
import __P from '../paths.mjs';
const ENGINE = __P.vtUrl("src/engine/lpRisk.js");

const realExp = Math.exp, realSqrt = Math.sqrt, realLog = Math.log, realPow = Math.pow;
let c = { exp: 0, sqrt: 0, log: 0, pow: 0 };
const reset = () => { c = { exp: 0, sqrt: 0, log: 0, pow: 0 }; };
Math.exp = (x) => { c.exp++; return realExp(x); };
Math.sqrt = (x) => { c.sqrt++; return realSqrt(x); };
Math.log = (x) => { c.log++; return realLog(x); };
Math.pow = (x, y) => { c.pow++; return realPow(x, y); };

const { lpRisk } = await import(ENGINE);

const runs = [
  ['realizedIL only              ', { priceRatio: 2, concentrationFactor: 1 }],
  ['expectedDivergence only      ', { volatility: 0.05, horizonPeriods: 30 }],
  ['all three blocks             ', { priceRatio: 2, volatility: 0.05, horizonPeriods: 30, feeAprPct: 20, capitalUsd: 100000 }],
  ['all three, fees > 100%       ', { priceRatio: 2, volatility: 0.05, horizonPeriods: 30, feeAprPct: 5000, capitalUsd: 100000 }],
  ['all three, tiny fees         ', { priceRatio: 2, volatility: 0.05, horizonPeriods: 30, feeAprPct: 0.001, capitalUsd: 100000 }],
  ['all three, huge vol          ', { priceRatio: 2, volatility: 2.0, horizonPeriods: 365, feeAprPct: 200, capitalUsd: 100000 }],
];

console.log('=== A. transcendental call counts, per lpRisk() call, MEASURED ===\n');
for (const [label, input] of runs) {
  reset();
  const res = lpRisk(input);
  const m = { ...c };
  console.log(`${label} exp=${String(m.exp).padStart(7)}  sqrt=${String(m.sqrt).padStart(7)}  log=${m.log}  pow=${m.pow}   total=${m.exp + m.sqrt + m.log + m.pow}`);
  if (res.feeVsDivergence) console.log(`${' '.repeat(31)}breakevenVolatility=${res.feeVsDivergence.breakevenVolatility}  expectedIlPct=${res.expectedDivergence.expectedIlPct}`);
}

console.log('\n=== B. differencing, to attribute the cost to a block ===\n');
reset(); lpRisk({ priceRatio: 2, concentrationFactor: 1 });
const ilOnly = c.exp + c.sqrt + c.log + c.pow;
reset(); lpRisk({ volatility: 0.05, horizonPeriods: 30 });
const divOnly = c.exp + c.sqrt + c.log + c.pow;
reset(); lpRisk({ priceRatio: 2, volatility: 0.05, horizonPeriods: 30, feeAprPct: 20 });
const all = c.exp + c.sqrt + c.log + c.pow;
reset(); lpRisk({ priceRatio: 2, volatility: 0.05, horizonPeriods: 30 });
const ilPlusDiv = c.exp + c.sqrt + c.log + c.pow;

console.log(`realizedIL alone             : ${ilOnly}`);
console.log(`expectedDivergence alone     : ${divOnly}`);
console.log(`realizedIL + expectedDiv     : ${ilPlusDiv}`);
console.log(`+ feeVsDivergence            : ${all}    delta = ${all - ilPlusDiv}  <- the bisection + its self-check`);
