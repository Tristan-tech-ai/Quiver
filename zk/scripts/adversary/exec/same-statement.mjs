// Is the 8-public-signal variant the SAME statement? Run gate B5-3's own 13 dishonest witnesses
// against xamin / xapriv / xacommit and against the shipped circuit, and require identical verdicts.
import __P from '../paths.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const ZK = __P.ZK;
const SP = __P.WORK;
const req = createRequire(`${ZK}/package.json`);

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SCALE = 1000000000n;
const asField = (v) => String(v < 0n ? FIELD + v : v);

const xHat = 1500000000000000n, yHat = 3750000000000000n, dxHat = 15000000000000n, fHat = 3000000n;
const inHat = 14955000000000n, outHat = 37018426289890n, realizedHat = 36900000000000n, bpsHat = 31991173521n;
const W = { xHat: String(xHat), yHat: String(yHat), dxHat: String(dxHat), fHat: String(fHat),
  inHat: String(inHat), outHat: String(outHat), realizedHat: String(realizedHat), bpsHat: String(bpsHat) };

// verbatim from zk/scripts/gateB5-3-execadverse.mjs
const bads = [
  ['a fill larger than the output reserve', { ...W, outHat: String(yHat + SCALE) }],
  ['a benchmark that breaks the invariant', { ...W, outHat: String(38000n * SCALE) }],
  ['an effective input above the gross input', { ...W, inHat: String(dxHat + SCALE) }],
  ['a fee of 100%', { ...W, fHat: String(SCALE) }],
  ['an empty pool', { ...W, xHat: '0' }],
  ['a trade of nothing', { ...W, dxHat: '0' }],
  ['a fill of nothing', { ...W, realizedHat: '0' }],
  ['the effective input off by ONE grid step', { ...W, inHat: String(inHat + 1n) }],
  ['the effective input off by one the other way', { ...W, inHat: String(inHat - 1n) }],
  ['the headline off by ONE unit of 1e-9 bps', { ...W, bpsHat: String(bpsHat + 1n) }],
  ['the headline doubled', { ...W, bpsHat: String(bpsHat * 2n) }],
  ['the headline with its sign flipped', { ...W, bpsHat: asField(-bpsHat) }],
  ['a headline past the circuit width', { ...W, bpsHat: String(1n << 51n) }],
];

const CIRCUITS = [
  ['execadverse (shipped, 15 public)', `${ZK}/build/execadverse_js`, 'execadverse'],
  ['xamin (8 public)', `${SP}/advbuild/xamin_js`, 'xamin'],
  ['xapriv (2 public)', `${SP}/advbuild/xapriv_js`, 'xapriv'],
  ['xacommit (2 public + commitment)', `${SP}/advbuild/xacommit_js`, 'xacommit'],
];

const table = [];
for (const [label, dir, name] of CIRCUITS) {
  const builder = await req(`${dir}/witness_calculator.cjs`)(readFileSync(`${dir}/${name}.wasm`));
  let honest = false;
  try { await builder.calculateWTNSBin(W, 0); honest = true; } catch { /* */ }
  const verdicts = [];
  for (const [, w] of bads) {
    let built = false;
    try { await builder.calculateWTNSBin(w, 0); built = true; } catch { /* */ }
    verdicts.push(built ? 'ACCEPTED' : 'refused');
  }
  // a favorable (negative) headline must still be carried
  const rzGood = 37500n * SCALE, sGood = outHat - rzGood;
  const numG = 10000n * SCALE * sGood;
  const bpsGood = (numG * 2n / outHat + (numG < 0n ? -1n : 1n)) / 2n;
  let signedOk = false;
  try { await builder.calculateWTNSBin({ ...W, realizedHat: String(rzGood), bpsHat: asField(bpsGood) }, 0); signedOk = true; } catch { /* */ }
  table.push({ label, honest, refused: verdicts.filter((v) => v === 'refused').length, of: bads.length, favorableCarried: signedOk, verdicts });
  console.log(`${label.padEnd(34)} honest=${honest} refused ${verdicts.filter((v) => v === 'refused').length}/${bads.length} favorable=${signedOk}`);
}
const ref = table[0].verdicts.join('|');
console.log(`\nall four circuits give the identical verdict on all ${bads.length} dishonest witnesses: ${table.every((t) => t.verdicts.join('|') === ref)}`);
for (let i = 0; i < bads.length; i++) {
  const row = table.map((t) => t.verdicts[i]);
  if (new Set(row).size !== 1) console.log(`  DIVERGES on "${bads[i][0]}": ${row.join(' / ')}`);
}
