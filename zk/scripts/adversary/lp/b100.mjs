import __P from '../paths.mjs';
const { lpRisk } = await import(__P.vtUrl("src/engine/lpRisk.js"));
const { buildProof } = await import(__P.vtUrl("src/engine/proof.js")).then(m=>({buildProof:m.buildProof||m.default})).catch(()=>({buildProof:null}));
// bisect on v for the first v where the boundedness check flips to false, at T = 365
const T = 365;
const chk = (v) => {
  const r = lpRisk({ volatility: Math.sqrt(v / T), horizonPeriods: T });
  const c = r.checks.find((x) => x.name.startsWith('boundedness: reported expected'));
  return { pass: c.pass, e: r.expectedDivergence.expectedIlPct, ok: r.ok };
};
let lo = 100, hi = 200;
for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (chk(m).pass) lo = m; else hi = m; }
console.log(`first total variance where the engine's own boundedness check fails, T=${T}: v = ${hi.toPrecision(10)}`);
console.log(`  just below: v=${lo.toPrecision(10)} sigma=${Math.sqrt(lo/T).toPrecision(8)} -> ${JSON.stringify(chk(lo))}`);
console.log(`  just above: v=${hi.toPrecision(10)} sigma=${Math.sqrt(hi/T).toPrecision(8)} -> ${JSON.stringify(chk(hi))}`);
console.log(`  full precision E[IL] just above: ${(chk(hi).e/100).toFixed(15)} — strictly inside (-1, 0], so the VALUE is fine`);
const s = Math.sqrt(hi/T);
const r = lpRisk({ volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000 });
console.log(`\na plausible live call, sigma=0.62 daily over a year (v=${(0.62*0.62*365).toFixed(1)}):`);
console.log(`  ok=${r.ok}  expectedIlPct=${r.expectedDivergence.expectedIlPct}`);
for (const c of r.checks) console.log(`  [${c.pass?'pass':'FAIL'}] ${c.name}  residual=${c.residual}`);
