// How does proving time grow with the evaluation domain, and what does that mean for a wider circuit?
//
// The question this exists to answer: a bigger powers-of-tau file raises the constraint ceiling, so a
// portfolio circuit could hold more than three legs. Does that actually help, or does it just move the
// wall from "will not fit" to "takes too long"?
//
// Plonk's cost is dominated by FFTs and MSMs over the evaluation domain, not by what the constraints
// say, so a chain of multiplications sized to fill a domain times out the same as a real circuit that
// lands there. `padprobe.circom` is that chain. It is a measuring stick and proves nothing about
// Quiver.
//
// Anything past the ceiling of the ceremony file on hand is EXTRAPOLATED and labelled as such. Three
// measured points are enough to fit an exponent and not enough to be certain three doublings out.
//
//   node zk/scripts/domain-scaling.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plonkFacts } from './circuit-facts.mjs';

const require = createRequire(import.meta.url);
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const LEG = 1301;          // one portfolio leg IS the liquidation circuit, measured
const RUNS = 7;

const CASES = [
  ['kelly', { pHat: '550000000', bHat: '1200000000', fHat: '175000000' }],
  ['constantproduct', { xHat: '1000000000000', yHat: '2000000000000', dxHat: '1000000000000', fHat: '0', inHat: '1000000000000', outHat: '1000000000000' }],
  ['padprobe', { seed: '2' }],
];

const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));

console.log(`Proving time against evaluation domain — ${new Date().toISOString()}\n`);
console.log(`  ${'circuit'.padEnd(18)}${'Plonk'.padStart(6)}${'domain'.padStart(9)}${'warm p50'.padStart(11)}`);

const points = [];
for (const [name, witness] of CASES) {
  const zkey = path.join(BUILD, `${name}_plonk.zkey`);
  const build = await require(path.join(BUILD, `${name}_js`, 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, `${name}_js`, `${name}.wasm`)));
  const wtns = await build.calculateWTNSBin(witness, 0);

  await snarkjs.plonk.prove(zkey, wtns);          // warm the key out of the measurement
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = Date.now();
    await snarkjs.plonk.prove(zkey, wtns);
    times.push(Date.now() - t);
  }
  times.sort((a, b) => a - b);
  const f = plonkFacts(zkey);
  points.push({ name, domain: f.domainSize, ms: times[(RUNS - 1) >> 1] });
  console.log(`  ${name.padEnd(18)}${String(f.nConstraints).padStart(6)}${String(f.domainSize).padStart(9)}${(times[(RUNS - 1) >> 1] + ' ms').padStart(11)}`);
}

const byDomain = [...new Map(points.map((p) => [p.domain, p])).values()].sort((a, b) => a.domain - b.domain);
const lo = byDomain[0], hi = byDomain[byDomain.length - 1];
const k = Math.log(hi.ms / lo.ms) / Math.log(hi.domain / lo.domain);

console.log(`\n  measured: ${lo.domain} -> ${lo.ms} ms and ${hi.domain} -> ${hi.ms} ms, so time grows as domain^${k.toFixed(2)}`);
console.log(`  (Plonk is O(n log n), so an exponent a little above 1 is what theory expects)\n`);

console.log('  What a bigger ceremony file would buy, and cost:\n');
console.log(`  ${'ptau'.padEnd(6)}${'domain'.padStart(8)}${'legs'.padStart(6)}${'est. prove'.padStart(12)}   status`);
for (const p of [12, 13, 14, 15, 16]) {
  const domain = 2 ** p;
  const legs = Math.floor(domain / LEG);
  const est = hi.ms * Math.pow(domain / hi.domain, k);
  const measured = byDomain.some((b) => b.domain === domain);
  const label = est > 3000 ? 'past the roadmap\'s 3 s abandon threshold'
    : est > 500 ? 'over the 500 ms bar, still under 3 s'
    : 'under the 500 ms bar';
  console.log(`  ${('2^' + p).padEnd(6)}${String(domain).padStart(8)}${String(legs).padStart(6)}${((est / 1000).toFixed(1) + ' s').padStart(12)}   ${measured ? '[measured] ' : '[extrapolated] '}${label}`);
}

console.log('\n  Every row past the ceremony file on hand is extrapolation from three points, not a');
console.log('  measurement. Downloading the larger file and rebuilding is what would settle it.');

await globalThis.curve_bn128?.terminate();
