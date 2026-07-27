'use strict';

// How tightly does the circuit actually pin P_liq?
//
// negative.js measured a window of +0/-0 grid steps on ONE position. One data
// point is not a property. This sweeps the envelope.
//
// Running the real witness generator on thousands of positions is slow (~50ms
// each), so the sweep uses a pure-BigInt predicate for the acceptance condition
// and then CROSS-CHECKS that predicate against the actual circuit on a random
// subsample. If the predicate and the circuit ever disagree, the sweep is void
// and this script says so rather than reporting the sweep anyway.
//
// Usage: node scripts/pin-sweep.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const snarkjs = require('snarkjs');
const scale = require('../src/scale');

const WASM = path.join(__dirname, '..', 'build', 'liquidation_js', 'liquidation.wasm');
const SCALE = scale.SCALE;
const BOUNDS = scale.BOUNDS;

// The acceptance predicate, restated from the circuit's constraints. Every clause
// here corresponds to a specific line of liquidation.circom; if one is missing the
// cross-check below is what catches it.
function predictAccept(i) {
  if (i.mHat < 0n || i.mHat >= 1n << BOUNDS.mHat) return false;          // Num2Bits(80)
  if (i.qHat < 0n || i.qHat >= 1n << BOUNDS.qHat) return false;          // Num2Bits(60)
  if (i.p0Hat < 0n || i.p0Hat >= 1n << BOUNDS.p0Hat) return false;       // Num2Bits(60)
  if (i.pLiqHat < 0n || i.pLiqHat >= 1n << BOUNDS.pLiqHat) return false; // Num2Bits(60)
  if (i.mmrHat < 0n || i.mmrHat >= 1n << BOUNDS.mmrHat) return false;    // Num2Bits(30)
  if (i.s !== 1 && i.s !== -1) return false;                             // (s-1)(s+1)===0
  if (i.mmrHat >= SCALE) return false;                                   // LessThan
  if (i.qHat === 0n) return false;                                       // IsZero
  const R = scale.residual(i);
  const tol = scale.toleranceBound(i);
  const shifted = 2n * R + tol;
  if (shifted < 0n || shifted >= 1n << 160n) return false;               // Num2Bits(160)
  return shifted <= 2n * tol;                                            // LessEqThan
}

async function circuitAccepts(i) {
  const tmp = path.join(os.tmpdir(), `pin_${Math.random().toString(36).slice(2)}.wtns`);
  try {
    await snarkjs.wtns.calculate(scale.toWitnessInput(i), WASM, tmp);
    fs.unlinkSync(tmp);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

function* positions() {
  const sizes = [0.001, 0.05, 1, 37.5, 1000, 250000];
  const prices = [0.5, 137.25, 2500, 100000, 250000];
  const mmrs = [0.001, 0.005, 0.0125, 0.05, 1 / 3, 1 / 7, 0.0066666666666, 0.5];
  const levs = [1, 2, 10, 25, 100];
  for (const s of [1, -1])
    for (const q of sizes)
      for (const P0 of prices)
        for (const mmr of mmrs)
          for (const lev of levs) {
            const M = (q * P0) / lev;
            yield { M, q, P0, s, mmr };
          }
}

async function main() {
  console.log(`pin-sweep.js — ${new Date().toISOString()}`);

  const cases = [];
  let skipped = 0;
  for (const pos of positions()) {
    let inp;
    try { inp = scale.toCircuitInputs(pos); } catch (e) { skipped++; continue; }
    if (!predictAccept(inp)) { skipped++; continue; }  // honest witness must itself be provable
    cases.push({ pos, inp });
  }
  console.log(`\n${cases.length} provable positions in the envelope (${skipped} outside the encodable range)`);

  // --- cross-check the predicate against the real circuit -------------------
  console.log('\nCross-checking the BigInt predicate against the actual circuit...');
  const sample = [];
  const rng = mulberry(20260727);
  for (let k = 0; k < 60; k++) {
    const c = cases[Math.floor(rng() * cases.length)];
    const d = [0n, 1n, -1n, 2n, -2n, 7n][k % 6];
    sample.push({ ...c.inp, pLiqHat: c.inp.pLiqHat + d });
  }
  let disagree = 0;
  for (const s of sample) {
    const pred = predictAccept(s);
    const real = await circuitAccepts(s);
    if (pred !== real) {
      disagree++;
      console.log(`  DISAGREE: predicate=${pred} circuit=${real} on ${JSON.stringify(scale.toWitnessInput(s))}`);
    }
  }
  console.log(`  ${sample.length} samples, ${disagree} disagreements`);
  if (disagree > 0) {
    console.log('\n  Predicate does not model the circuit. Sweep results below would be');
    console.log('  fiction. Stopping.');
    process.exit(1);
  }

  // --- the sweep -----------------------------------------------------------
  console.log('\nSweeping the accepted P_liq window over every position...');
  const hist = new Map();
  let maxUp = 0n, maxDown = 0n, worst = null;
  let exact = 0;
  for (const { pos, inp } of cases) {
    let up = 0n;
    while (predictAccept({ ...inp, pLiqHat: inp.pLiqHat + up + 1n })) up++;
    let down = 0n;
    while (predictAccept({ ...inp, pLiqHat: inp.pLiqHat - down - 1n })) down++;
    const width = up + down;
    if (width === 0n) exact++;
    hist.set(width.toString(), (hist.get(width.toString()) || 0) + 1);
    if (up > maxUp) maxUp = up;
    if (down > maxDown) maxDown = down;
    if (width >= (worst ? worst.width : -1n)) worst = { pos, width, up, down };
  }

  console.log('\nAccepted window width, in 1e-9 grid steps beyond the canonical value:');
  const keys = [...hist.keys()].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const k of keys) {
    const n = hist.get(k.toString());
    const pct = ((n / cases.length) * 100).toFixed(1);
    console.log(`  extra accepted values = ${k.toString().padStart(2)}   ${String(n).padStart(5)} / ${cases.length}  (${pct}%)`);
  }
  console.log(`\n  positions pinned to exactly one integer: ${exact} / ${cases.length} (${((exact / cases.length) * 100).toFixed(1)}%)`);
  console.log(`  max displacement accepted upward:   +${maxUp} grid step(s)`);
  console.log(`  max displacement accepted downward: -${maxDown} grid step(s)`);
  console.log(`  worst case: ${JSON.stringify(worst.pos)}  (+${worst.up}/-${worst.down})`);

  const bound = maxUp > maxDown ? maxUp : maxDown;
  console.log(`\n  => a verified proof pins P_liq to within ${scale.fromScaled(bound)} quote currency`);
  console.log(`     of the canonical integer answer, over this whole envelope.`);

  console.log(JSON.stringify({
    MEASURED: {
      at: new Date().toISOString(),
      positions: cases.length,
      crossCheckSamples: sample.length,
      crossCheckDisagreements: disagree,
      pinnedExactly: exact,
      pinnedExactlyPct: Number(((exact / cases.length) * 100).toFixed(1)),
      maxUp: maxUp.toString(),
      maxDown: maxDown.toString(),
      maxAbsError: scale.fromScaled(bound),
      worst: worst.pos,
    },
  }));
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
