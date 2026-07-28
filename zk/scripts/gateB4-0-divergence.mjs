// GATE B4-0 — the divergence circuit proves, verifies, and can REFUSE.
//
// Run: node zk/scripts/gateB4-0-divergence.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, asInt, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const require = createRequire(import.meta.url);
const TOL_ID = 4n, TOL_ROOT = 1n;

const { record, failed } = checklist();
console.log(`GATE B4-0 — divergence circuit, prove / verify / refuse — ${new Date().toISOString()}\n`);

// ---- 1. a worked case where BOTH residuals are exactly zero ----------------------------------------
// r = 4 makes √r = 2 and IL = 2·2/(1+4) − 1 = −0.2 exactly, so the price ratio, its root and the loss
// are all representable on the grid with nothing left over. Anything but a zero residual here is a
// defect rather than rounding, which is the point of choosing it.
const rHat = toScaled(4, 'r');
const sHat = toScaled(2, 's');
const lHat = toScaled(0.8, 'L');

const Rs = sHat * sHat - rHat * SCALE;
const R = lHat * (SCALE + rHat) - 2n * SCALE * sHat;

console.log(`  r = 4  ->  √r = 2,  L = V_LP/V_HODL = 0.8,  IL = −20%`);
console.log(`  identity residual R  = ${R}   (tolerance 2|R|  <= ${rHat + TOL_ID * SCALE})`);
console.log(`  root residual     Rs = ${Rs}   (tolerance 2|Rs| <= ${2n * sHat + TOL_ROOT * SCALE})\n`);
record('the worked case has an exact identity residual', R === 0n, `R = ${R}`);
record('the worked case has an exact root residual', Rs === 0n, `Rs = ${Rs}`);

// ---- 2. prove, verify, refuse ---------------------------------------------------------------------
const witness = { rHat: rHat.toString(), sHat: sHat.toString(), lHat: lHat.toString() };
const { publicSignals, proveMs } = await proveVerifyRefuse('divergence', witness, { record });

console.log(`\n  publicSignals: [${publicSignals.join(', ')}]`);
console.log('  layout       : [residual, rootResidual, tolerance, rootTolerance, rHat, sHat, lHat]\n');

const [rSig, rsSig, tSig, rtSig, rIn, sIn, lIn] = publicSignals;
record('the public signals are the scaled inputs, unchanged',
  BigInt(rIn) === rHat && BigInt(sIn) === sHat && BigInt(lIn) === lHat,
  `rHat ${rIn} · sHat ${sIn} · lHat ${lIn}`);
record('both residuals and both tolerances are published, not hidden',
  asInt(rSig) === R && asInt(rsSig) === Rs
  && BigInt(tSig) === rHat + TOL_ID * SCALE && BigInt(rtSig) === 2n * sHat + TOL_ROOT * SCALE,
  `R ${asInt(rSig)} · Rs ${asInt(rsSig)} · tolerances ${tSig} / ${rtSig}`);

// ---- 3. witnesses the circuit must refuse outright -------------------------------------------------
// The root is the interesting one. ŝ arrives as a witness rather than being computed, so the ONLY
// thing stopping a prover from claiming any root they like is the ŝ² = r̂·S constraint. If that ever
// stopped biting, every proof this circuit makes would become worthless in a way nothing else here
// would catch.
console.log('\nWitnesses the circuit must refuse outright:');
const bads = [
  ['a root that is not the root of this ratio', { rHat: String(rHat), sHat: String(toScaled(3)), lHat: String(lHat) }],
  ['the NEGATIVE root, offered as a field element', { rHat: String(rHat), sHat: String(SCALE * SCALE - sHat), lHat: String(lHat) }],
  ['a loss that does not follow from the ratio', { rHat: String(rHat), sHat: String(sHat), lHat: String(toScaled(0.5)) }],
  ['L above 1, an LP claiming to beat HODL', { rHat: String(toScaled(1)), sHat: String(toScaled(1)), lHat: String(toScaled(1.2)) }],
  ['a zero ratio, where the identity degenerates', { rHat: '0', sHat: '0', lHat: String(toScaled(0.5)) }],
];
let refused = 0;
const builder = await require(path.join(BUILD, 'divergence_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'divergence_js', 'divergence.wasm')));
for (const [label, w] of bads) {
  let built = false;
  try { await builder.calculateWTNSBin(w, 0); built = true; } catch { /* rejected, as intended */ }
  if (!built) refused++;
  console.log(`  [${built ? '*** FAIL ***' : 'PASS'}] ${label}`);
}
record('every dishonest witness is refused before a proof exists', refused === bads.length,
  `${refused} of ${bads.length}`);

const f = plonkFacts(path.join(BUILD, 'divergence_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B4-0: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · proved in ${proveMs} ms`);

writeFileSync(path.join(BUILD, 'gateB4-0-divergence.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, proveMs,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize,
  publicSignals, residual: String(R), rootResidual: String(Rs),
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
