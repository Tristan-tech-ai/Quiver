// Is my direct checker faithful to the circuit? Test the three tuples it ACCEPTED that gate B5-3
// reports as "refused perturbations": xHat+1, yHat+1, outHat+1. If the circuit proves them, the
// gate's 15/15 "perturbed signal" result is measuring Plonk's binding of a public-input vector to a
// proof, not the strength of this statement.
// Then measure the admissible window on xHat and yHat, which the soundness table omits.
import __P from '../paths.mjs';
import { createRequire } from 'node:module';
const ZK = __P.ZK;
const req = createRequire(`${ZK}/package.json`);
const snarkjs = req('snarkjs');

const WASM = `${ZK}/build/execadverse_js/execadverse.wasm`;
const ZKEY = `${ZK}/build/execadverse_plonk.zkey`;
const VK = JSON.parse(req('fs').readFileSync(`${ZK}/build/execadverse_vk.json`, 'utf8'));

const base = {
  xHat: 1500000000000000n, yHat: 3750000000000000n, dxHat: 15000000000000n, fHat: 3000000n,
  inHat: 14955000000000n, outHat: 37018426289890n, realizedHat: 36900000000000n, bpsHat: 31991173521n,
};
const asInput = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));

async function provable(mut, label) {
  const w = { ...base, ...mut };
  try {
    const { proof, publicSignals } = await snarkjs.plonk.fullProve(asInput(w), WASM, ZKEY);
    const ok = await snarkjs.plonk.verify(VK, publicSignals, proof);
    console.log(`  ${label.padEnd(34)} PROVES and verifies: ${ok}`);
    return ok;
  } catch (e) {
    console.log(`  ${label.padEnd(34)} REFUSED by the constraint system (${String(e.message).slice(0, 60)})`);
    return false;
  }
}

console.log('Tuples the direct checker accepted — does the circuit accept them as witnesses too?');
await provable({ xHat: base.xHat + 1n }, 'xHat + 1 grid step');
await provable({ yHat: base.yHat + 1n }, 'yHat + 1 grid step');
await provable({ outHat: base.outHat + 1n }, 'outHat + 1 grid step');

console.log('\nHow far can the RESERVES move with the fill and the headline held fixed?');
// bisect the largest k with xHat + k still provable
async function widest(key, sign) {
  let lo = 0n, hi = 1n;
  while (await provable({ [key]: base[key] + sign * hi }, `${key} ${sign > 0n ? '+' : '-'}${hi} (probe)`) && hi < 1n << 20n) { lo = hi; hi *= 2n; }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await provable({ [key]: base[key] + sign * mid }, `${key} ${sign > 0n ? '+' : '-'}${mid} (bisect)`)) lo = mid; else hi = mid;
  }
  return lo;
}
const kx = await widest('xHat', 1n);
console.log(`\n  xHat window upward: ${kx} grid steps = ${Number(kx) / 1e9} input tokens, with outHat, bpsHat and every other signal unchanged`);
