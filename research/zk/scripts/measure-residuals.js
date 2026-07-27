'use strict';

// Picks the tolerance from data instead of from reasoning, and separately measures
// the encoding gap between the engine's float pipeline and the canonical integer
// one. Two different numbers that must not be conflated.

const {
  SCALE, abs, residual, toleranceBound, toCircuitInputs,
  engineLiquidationPrice, toScaled,
} = require('../src/scale.js');

const sides = [1, -1];
// deliberately includes rates that do NOT land on the 1/SCALE grid
const mmrs = [0.004, 0.005, 0.01, 0.025, 0.05, 1 / 3, 0.0066666666666, 1 / 7];
const prices = [0.00001234, 1.5, 68000.25, 3120.789, 250000];
const sizes = [0.001, 1, 37.5, 1000, 250000];
const leverages = [2, 5, 25, 100];

const rows = [];
const failures = [];

for (const s of sides) {
  for (const mmr of mmrs) {
    for (const P0 of prices) {
      for (const q of sizes) {
        for (const lev of leverages) {
          const M = (q * P0) / lev;
          let inputs;
          try {
            inputs = toCircuitInputs({ M, q, P0, s, mmr });
          } catch (e) {
            failures.push({ M, q, P0, s, mmr, lev, err: e.message });
            continue;
          }
          const R = residual(inputs);
          const bound = toleranceBound(inputs);

          // encoding gap (term A): engine's float answer vs the canonical integer one
          const enginePLiq = engineLiquidationPrice({ M, q, P0, s, mmr });
          let engineHat = null;
          let ulpGap = null;
          if (Number.isFinite(enginePLiq) && Math.abs(enginePLiq) < 1e18) {
            try {
              engineHat = toScaled(enginePLiq, 'engineP');
              ulpGap = abs(engineHat - inputs.pLiqHat);
            } catch { /* out of representable range; counted separately */ }
          }

          rows.push({
            M, q, P0, s, mmr, lev,
            R, absR: abs(R), bound,
            slack: bound - 2n * abs(R),
            ulpGap,
          });
        }
      }
    }
  }
}

const usd = (R) => Number(R) / Number(SCALE ** 3n);

console.log(`scenarios evaluated: ${rows.length}`);
console.log(`rejected by range/domain discipline before proving: ${failures.length}`);
console.log('');

// ---- the claim the circuit makes: 2*|R| <= qHat*(SCALE + mmrHat) ----
const violations = rows.filter((r) => r.slack < 0n);
console.log(`=== circuit claim: 2*|R| <= qHat*(SCALE + mmrHat) ===`);
console.log(`violations: ${violations.length} / ${rows.length}`);
if (violations.length) {
  for (const v of violations.slice(0, 5)) {
    console.log(`  VIOLATION q=${v.q} P0=${v.P0} mmr=${v.mmr} s=${v.s} lev=${v.lev}`);
    console.log(`    2|R| = ${2n * v.absR}`);
    console.log(`    bound= ${v.bound}`);
  }
}

// how tight is the bound? ratio of 2|R| to the bound, worst case
let worst = null;
for (const r of rows) {
  if (r.bound === 0n) continue;
  const ratio = Number(2n * r.absR) / Number(r.bound);
  if (!worst || ratio > worst.ratio) worst = { ratio, r };
}
console.log(`tightest observed: 2|R| / bound = ${worst ? worst.ratio.toFixed(6) : 'n/a'}` +
  (worst ? `  (q=${worst.r.q} P0=${worst.r.P0} mmr=${worst.r.mmr} s=${worst.r.s})` : ''));

const maxAbs = rows.reduce((m, r) => (r.absR > m ? r.absR : m), 0n);
console.log(`max |R| observed: ${maxAbs} = ${usd(maxAbs).toExponential(3)} quote currency`);
console.log('');

// ---- residual vs size, to confirm the bound has the right shape ----
console.log('=== residual vs position size ===');
const byQ = new Map();
for (const r of rows) {
  const cur = byQ.get(r.q);
  if (!cur || r.absR > cur) byQ.set(r.q, r.absR);
}
for (const q of sizes) {
  const m = byQ.get(q);
  if (m !== undefined) {
    console.log(`  q=${String(q).padStart(8)}  max|R| = ${usd(m).toExponential(3)} quote`);
  }
}
console.log('');

// ---- term (A): the encoding gap, which the circuit does NOT prove ----
console.log('=== encoding gap: engine float P_liq vs canonical integer P_liq ===');
const gaps = rows.filter((r) => r.ulpGap !== null).map((r) => r.ulpGap);
const gapMax = gaps.reduce((m, g) => (g > m ? g : m), 0n);
const exact = gaps.filter((g) => g === 0n).length;
const within1 = gaps.filter((g) => g <= 1n).length;
console.log(`  comparable scenarios: ${gaps.length}`);
console.log(`  identical to the last 1e-9 digit: ${exact} (${((100 * exact) / gaps.length).toFixed(1)}%)`);
console.log(`  within 1 grid step:               ${within1} (${((100 * within1) / gaps.length).toFixed(1)}%)`);
console.log(`  max divergence: ${gapMax} grid steps = ${Number(gapMax) / 1e9} quote currency`);

const worstGap = rows.filter((r) => r.ulpGap === gapMax)[0];
if (worstGap && gapMax > 0n) {
  console.log(`  worst case: q=${worstGap.q} P0=${worstGap.P0} mmr=${worstGap.mmr} s=${worstGap.s} lev=${worstGap.lev}`);
}

if (failures.length) {
  console.log('');
  console.log('=== rejected before proving (first 8) ===');
  for (const f of failures.slice(0, 8)) {
    console.log(`  q=${f.q} P0=${f.P0} mmr=${f.mmr} lev=${f.lev}: ${f.err}`);
  }
}
