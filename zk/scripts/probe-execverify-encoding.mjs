// PROBE — where does the certified-vs-served gap on exec-verify's benchmark actually come from?
//
// A blocker was reported against proving exec-verify: "reserves routinely exceed 9e6 where the
// scaled-product encoding is wrong by up to 64 grid steps". Half of that is true and the other half
// points at the wrong file, and the only way to tell which half is which is to compare THREE numbers
// per pool against an exact reference rather than against each other:
//
//   truthHat   exact rational  y·dx(1-f) / (x + dx(1-f))  in BigInt at 1e-24, rounded once onto the grid
//   certHat    what the encoder hands the circuit (the engine's expression, the engine's order)
//   servedHat  the engine's published honestOut — an IEEE double, then round(_, 8)
//
// Splitting the encoder's own arithmetic from the propagation of input snapping needs a fourth: the
// same exact rational evaluated FROM THE SNAPPED INPUTS. Without it, the grid's own quantization is
// charged to the encoder and every magnitude looks equally guilty.
//
// The reference implementations of the two defect shapes are here too, so the numbers the blocker
// quotes can be reproduced rather than argued about: `Math.round(v * 1e9)`, the encoder gatekit's own
// post-mortem describes, and the algebraically-identical rearrangement `y − x·y/(x + in)`.
//
// Run: node zk/scripts/probe-execverify-encoding.mjs
import { SCALE, S, toScaled } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { execVerify } = await load(import.meta.url, 'engine/execVerify.js');

const HP = 10n ** 24n;
const toHP = (v) => { const [w, f = ''] = Number(v).toFixed(24).split('.'); return BigInt(w) * HP + BigInt(f.padEnd(24, '0')); };
const abs = (v) => (v < 0n ? -v : v);
const roundDiv = (n, d) => (n * 2n / d + 1n) / 2n;      // round-half-up, non-negative operands

// The encoder that WAS there. `Math.round(x * 1e9)` forms the product as a double, and above about
// 9e6 that product passes 2^53 and its last digits stop being representable.
const naiveScaled = (x) => BigInt(Math.round(Number(x) * S));

let seed = 20260728;      // the same stream gate B5-1 sweeps, so the two are comparable
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const FEE_TIERS = [0.0001, 0.0005, 0.003, 0.01];

const buckets = [
  ['reserves < 9e6      ', (x, y) => Math.max(x, y) < 9e6],
  ['reserves 9e6 .. 1e8 ', (x, y) => Math.max(x, y) >= 9e6 && Math.max(x, y) < 1e8],
  ['reserves 1e8 .. 1e9 ', (x, y) => Math.max(x, y) >= 1e8 && Math.max(x, y) < 1e9],
  ['reserves >= 1e9     ', (x, y) => Math.max(x, y) >= 1e9],
];
const stat = () => ({ n: 0, pure: 0n, enc: 0n, eng: 0n, tot: 0n, naiveIn: 0n, naiveOut: 0n, alt: 0n, worst: null });
const acc = buckets.map(stat);
const all = stat();
let above9e6 = 0, total = 0, outOfDomain = 0;

const RUNS = 4000;
for (let i = 0; i < RUNS; i++) {
  const x = 10 ** (3 + rand() * 7) * (0.5 + rand());
  const y = x * (0.2 + rand() * 5);
  const f = FEE_TIERS[Math.floor(rand() * FEE_TIERS.length)];
  const dx = x * (10 ** (-6 + rand() * 5));
  if (!(dx > 0)) continue;

  // The benchmark comes from the REAL engine. A recomputation would agree with itself.
  const probe = execVerify({ amountIn: dx, amountOutRealized: dx * (y / x) * 0.99, reserveIn: x, reserveOut: y, feeTier: f });
  if (!probe.ok || probe.mode !== 'constant-product' || !(probe.honestOut > 0)) continue;

  const xHat = toScaled(x), yHat = toScaled(y), dxHat = toScaled(dx), fHat = toScaled(f);
  const inHat = (dxHat * (SCALE - fHat) + SCALE / 2n) / SCALE;
  const denom = xHat + inHat;
  const certHat = (inHat * yHat + denom / 2n) / denom;
  if (certHat <= 0n || certHat >= yHat) continue;
  const LIMIT = 1n << 62n;
  if ([xHat, yHat, dxHat, inHat, certHat].some((v) => v >= LIMIT)) { outOfDomain++; continue; }

  // out = Y·DX·(HP-F) / (HP·(X·HP + DX·(HP-F))), exact
  const X = toHP(x), Y = toHP(y), DX = toHP(dx), F = toHP(f);
  const truthHat = roundDiv(Y * DX * (HP - F) * SCALE, HP * (X * HP + DX * (HP - F)));

  // the same thing FROM THE SNAPPED INPUTS: yHat·dxHat·(S-fHat) / (xHat·S + dxHat·(S-fHat))
  const gi = dxHat * (SCALE - fHat);
  const snappedTruthHat = roundDiv(yHat * gi, xHat * SCALE + gi);

  const servedHat = toScaled(probe.honestOut);          // an 8-dp decimal, so exact on the 1e-9 grid

  const nX = naiveScaled(x), nY = naiveScaled(y), nDx = naiveScaled(dx), nF = naiveScaled(f);
  const nIn = (nDx * (SCALE - nF) + SCALE / 2n) / SCALE;
  const nDen = nX + nIn;
  const nOut = nDen > 0n ? (nIn * nY + nDen / 2n) / nDen : 0n;
  const altHat = yHat - (xHat * yHat + denom / 2n) / denom;    // the rearranged algebra

  const m = {
    pure: abs(certHat - snappedTruthHat),
    enc: abs(certHat - truthHat),
    eng: abs(servedHat - truthHat),
    tot: abs(certHat - servedHat),
    naiveIn: abs(nX - xHat) > abs(nY - yHat) ? abs(nX - xHat) : abs(nY - yHat),
    naiveOut: abs(nOut - truthHat),
    alt: abs(altHat - snappedTruthHat),
  };

  total++;
  if (Math.max(x, y) >= 9e6) above9e6++;
  const push = (a) => {
    a.n++;
    for (const k of Object.keys(m)) if (m[k] > a[k]) a[k] = m[k];
    if (!a.worst || m.enc >= a.enc) a.worst = { x, y, dx, f };
  };
  for (const [bi, [, pred]] of buckets.entries()) if (pred(x, y)) push(acc[bi]);
  push(all);
}

console.log(`PROBE — exec-verify benchmark encoding — ${new Date().toISOString()}\n`);
console.log(`pools priced by the engine : ${total}   (outside the circuit's 2^62 width: ${outOfDomain})`);
console.log(`with max(x,y) >= 9e6       : ${above9e6} = ${(100 * above9e6 / total).toFixed(1)}%  — the magnitude where Math.round(v*1e9) passes 2^53\n`);
console.log('every figure is GRID STEPS of 1e-9 output token, the MAXIMUM over the bucket\n');
console.log('bucket                   n   encoder  +snapping  ENGINE  cert-vs-served  old-encoder-in  old-encoder-out  rearranged');
const row = (label, a) => console.log(
  `${label} ${String(a.n).padStart(5)}  ${String(a.pure).padStart(8)}  ${String(a.enc).padStart(9)}  ${String(a.eng).padStart(6)}  `
  + `${String(a.tot).padStart(14)}  ${String(a.naiveIn).padStart(14)}  ${String(a.naiveOut).padStart(15)}  ${String(a.alt).padStart(10)}`);
for (const [bi, [label]] of buckets.entries()) { if (acc[bi].n) row(label, acc[bi]); }
console.log('');
row('OVERALL             ', all);

console.log(`\nReading the columns:`);
console.log(`  encoder         the encoder's own arithmetic, against the exact rational on the SAME snapped grid`);
console.log(`  +snapping       the same, against the exact rational on the UNSNAPPED inputs — adds the grid's own cost`);
console.log(`  ENGINE          the engine's published round(honestOut, 8) against exact — IEEE double plus display`);
console.log(`  old-encoder-*   BigInt(Math.round(v*1e9)): the input error, and what it does to the fill`);
console.log(`  rearranged      y - x*y/(x+in) instead of y*in/(x+in), in BigInt\n`);
const flat = (k) => acc.every((a) => !a.n || a[k] === all[k]);
console.log(`  the encoder column is magnitude-INDEPENDENT: ${flat('pure') ? 'yes' : 'no'} — a defect that scaled with reserves would not be`);
console.log(`  the ENGINE column is not: ${acc.filter((a) => a.n).map((a) => a.eng).join(' -> ')} grid steps as reserves grow`);
console.log(`  the old encoder reaches ${all.naiveIn} grid steps on an input, ${all.naiveOut} on the fill`);
console.log(`  worst encoder case: x=${all.worst.x.toPrecision(6)} y=${all.worst.y.toPrecision(6)} dx=${all.worst.dx.toPrecision(6)} fee=${all.worst.f}`);
console.log('\nThis probe measures. Gate B5-1 is what REFUSES: it holds the certified fill to a derived');
console.log('allowance against the engine and fails if any pool falls outside it.');
