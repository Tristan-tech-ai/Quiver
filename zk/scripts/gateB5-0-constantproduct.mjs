// GATE B5-0 — the constant-product circuit proves, verifies, and can REFUSE.
//
// Run: node zk/scripts/gateB5-0-constantproduct.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, asInt, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const require = createRequire(import.meta.url);
const { record, failed } = checklist();
console.log(`GATE B5-0 — constant-product circuit, prove / verify / refuse — ${new Date().toISOString()}\n`);

// A zero-fee pool at x = y/2 with a trade equal to the input reserve: the fill is exactly half the
// output reserve and both residuals vanish. Zero fee is chosen ON PURPOSE — it is the only setting
// where the effective input needs no rounding, so a non-zero residual here would be a defect rather
// than a grid artefact. A realistic 30bp pool is what gate B5-2 proves about.
const xHat = toScaled(1000, 'x');
const yHat = toScaled(2000, 'y');
const dxHat = toScaled(1000, 'dx');
const fHat = 0n;
const inHat = toScaled(1000, 'in');
const outHat = toScaled(1000, 'out');

const Rf = inHat * SCALE - dxHat * (SCALE - fHat);
const R = (xHat + inHat) * (yHat - outHat) - xHat * yHat;

console.log('  x=1000  y=2000  dx=1000  fee=0   ->  honest fill = 1000, exactly half the output side');
console.log(`  invariant residual R  = ${R}   (tolerance 2|R|  <= ${xHat + inHat + yHat - outHat})`);
console.log(`  fee residual       Rf = ${Rf}   (tolerance 2|Rf| <= ${SCALE})\n`);
record('the worked case has an exact invariant residual', R === 0n, `R = ${R}`);
record('the worked case has an exact fee residual', Rf === 0n, `Rf = ${Rf}`);

const witness = { xHat: String(xHat), yHat: String(yHat), dxHat: String(dxHat), fHat: String(fHat), inHat: String(inHat), outHat: String(outHat) };
const { publicSignals, proveMs } = await proveVerifyRefuse('constantproduct', witness, { record });

console.log(`\n  publicSignals: [${publicSignals.join(', ')}]`);
console.log('  layout       : [residual, feeResidual, tolerance, feeTolerance, x, y, dx, f, in, out]\n');

const [rSig, rfSig, tSig, ftSig, xS, yS, dxS, fS, inS, outS] = publicSignals;
record('the public signals are the scaled inputs, unchanged',
  BigInt(xS) === xHat && BigInt(yS) === yHat && BigInt(dxS) === dxHat && BigInt(inS) === inHat && BigInt(outS) === outHat,
  `x ${xS} · y ${yS} · out ${outS}`);
record('both residuals and both tolerances are published, not hidden',
  asInt(rSig) === R && asInt(rfSig) === Rf && BigInt(ftSig) === SCALE,
  `R ${asInt(rSig)} · Rf ${asInt(rfSig)} · fee tolerance ${ftSig}`);

// The refusals that matter here are the ones that would let a proof describe a trade that could not
// have happened. A fill larger than the pool holds is the headline case: it is what a fabricated
// benchmark would look like, and it is the thing a caller would be relying on this proof to exclude.
console.log('\nWitnesses the circuit must refuse outright:');
const bads = [
  ['a fill larger than the output reserve', { ...witness, outHat: String(yHat + SCALE) }],
  ['a fill that breaks the invariant', { ...witness, outHat: String(toScaled(1200)) }],
  ['an effective input above the gross input', { ...witness, inHat: String(dxHat + SCALE) }],
  ['a fee of 100%', { ...witness, fHat: String(SCALE) }],
  ['an empty pool', { ...witness, xHat: '0' }],
  ['a trade of nothing', { ...witness, dxHat: '0' }],
];
let refused = 0;
const builder = await require(path.join(BUILD, 'constantproduct_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'constantproduct_js', 'constantproduct.wasm')));
for (const [label, w] of bads) {
  let built = false;
  try { await builder.calculateWTNSBin(w, 0); built = true; } catch { /* rejected, as intended */ }
  if (!built) refused++;
  console.log(`  [${built ? '*** FAIL ***' : 'PASS'}] ${label}`);
}
record('every dishonest witness is refused before a proof exists', refused === bads.length, `${refused} of ${bads.length}`);

const f = plonkFacts(path.join(BUILD, 'constantproduct_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B5-0: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · proved in ${proveMs} ms`);

writeFileSync(path.join(BUILD, 'gateB5-0-constantproduct.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, proveMs,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize,
  publicSignals, residual: String(R), feeResidual: String(Rf),
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
