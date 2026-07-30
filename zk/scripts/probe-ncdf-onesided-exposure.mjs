// PROBE — what the ONE-SIDED ncdf key admitted about a number the service was already serving.
//
// `ncdf.circom` was generated without a Num2Bits on the shifted CDF residual, on the argument that
// LessEqThan's own decomposition would catch a field-wrapped negative shift. It does not: for
// in[0] = p - v the two wraps cancel mod p and the comparator sees an ordinary in-range number. So the
// CDF bound held on ONE SIDE — the upper tail could be driven arbitrarily BELOW the truth, which for
// x > 0 means N(x) arbitrarily close to 1.
//
// While that was true, `event-vol` was wired to it. Its straddle is
//
//     straddleImpliedAbsMoveUsd = 2*S*(2*N(sigma*sqrt(T)/2) - 1)
//
// which is AFFINE and INCREASING in N, with dStraddle/dN = 4*S. So the free direction of the broken
// bound is the direction that INFLATES the published expected move, and the ceiling is N = 1, i.e. a
// straddle of 2*S. This measures that rather than arguing it, and measures the rebuilt key beside it.
//
// It is a PROBE and not a gate on purpose. It reaches into src/util/ncdfWitness.js, which belongs to
// the service and not to this tree, and a gate that breaks when a service-side helper is renamed is a
// gate that will be deleted. gateB7-5 section 0 carries the same finding against the circuit alone.
//
//   node zk/scripts/probe-ncdf-onesided-exposure.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BUILD } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const ZK = path.join(BUILD, '..');
const ONE = 2 ** 40;
const ADV = path.join(BUILD, 'adv', 'ncdfadv');

const { ncdfWitnessFor } = await load(import.meta.url, 'util/ncdfWitness.js');
const { eventVol } = await load(import.meta.url, 'engine/eventVol.js');

if (!existsSync(path.join(ADV, 'ncdfonesided_js', 'ncdfonesided.wasm'))) {
  execFileSync(process.execPath, [path.join(ZK, 'scripts', 'adversary', 'build-adv.mjs'), '--into', 'ncdfadv', 'ncdfonesided'],
    { cwd: ZK, stdio: 'inherit', timeout: 600_000 });
}
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const oldB = await require(path.join(ADV, 'ncdfonesided_js', 'witness_calculator.cjs'))(readFileSync(path.join(ADV, 'ncdfonesided_js', 'ncdfonesided.wasm')));
const newB = await require(path.join(BUILD, 'ncdf_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'ncdf_js', 'ncdf.wasm')));

console.log(`NCDF ONE-SIDED EXPOSURE PROBE — ${new Date().toISOString()}\n`);

const CASES = [
  { spot: 100000, atmIvPct: 60, daysToEvent: 30 },
  { spot: 3000, atmIvPct: 80, daysToEvent: 7 },
  { spot: 1.02, atmIvPct: 15, daysToEvent: 90 },
];

for (const input of CASES) {
  const r = eventVol(input);
  const w = ncdfWitnessFor(input, r);
  if (w.reason) { console.log(`spot ${input.spot}: witness refused — ${w.reason}\n`); continue; }
  const S = w.spot;
  // The buyer's own reconstruction, in the form ncdfWitness.js writes it, so the number below is the
  // number a buyer would compute from the public signals and not a rearrangement of it.
  const straddleFrom = (nHat) => { const n = nHat / ONE; return (S * n - S * (1 - n)) + (S * n - S * (1 - n)); };
  const accepts = async (b, nHat) => {
    try { await b.calculateWTNSBin({ xSign: '0', xMag: String(w.encoded.xMag), nHat: String(nHat), pHat: String(w.encoded.pHat) }, 0); return true; }
    catch { return false; }
  };
  // The widest nHat each key admits, by bisection between the honest value and the circuit's own
  // ceiling of 2^40. Bisection is sound here because the accepted set is an interval in nHat: the
  // constraint is monotone in it.
  const widest = async (b) => {
    if (!(await accepts(b, w.encoded.nHat))) return null;
    if (await accepts(b, ONE)) return ONE;
    let lo = w.encoded.nHat, hi = ONE;
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await accepts(b, m)) lo = m; else hi = m; }
    return lo;
  };
  const wOld = await widest(oldB), wNew = await widest(newB);
  console.log(`  spot ${S} · iv ${input.atmIvPct}% · ${input.daysToEvent}d · x = ${w.point.toPrecision(8)} · served ${w.served}`);
  console.log(`    envelopeUsd the response publishes            : ${w.envelopeUsd.toExponential(4)}`);
  for (const [label, best] of [['ONE-SIDED key', wOld], ['REBUILT key', wNew]]) {
    if (best === null) { console.log(`    ${label.padEnd(46)}: refuses the HONEST witness`); continue; }
    const out = best - w.encoded.nHat;
    const claim = straddleFrom(best);
    console.log(`    ${label.padEnd(46)}: nHat +${out} ulp -> straddle ${claim.toFixed(2)} vs ${w.served} (${(((claim - w.served) / w.served) * 100).toFixed(1)}% high)`);
  }
  console.log('');
}

console.log('  Read the ULP OFFSET, not the percentage, on the rebuilt rows: the straddle is displayed to two');
console.log('  decimals, so at a spot near 1 the last row\'s 1.0% is that rounding and not the band — 5 ulp of');
console.log('  N is worth 1.9e-11 there. The percentage is the honest unit only on the one-sided rows, where');
console.log('  the offset is 5e11 ulp and the inflation is real money.');
console.log('  The rebuilt key admits 6 ulp, which is TOLC/2 and is the band the constraint states.');
console.log('  The one-sided key admitted every value up to N = 1, i.e. a straddle of twice the spot,');
console.log('  because the direction the missing range check left open is the direction that inflates.');
