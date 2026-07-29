// GATE LP0 — the bracket circuit proves, verifies, REFUSES, and refuses in the EVM.
//
// The claim under test: lp-risk's 200-iteration bisection over a 401-point quadrature is not
// unprovable, because a bisection result is certified by its BRACKET rather than by replaying the
// search. This gate builds a bracket for a real service call, proves it, verifies it, and then makes
// the verifier say no — to every moved public signal, to a bent proof point, and to four dishonest
// witnesses that a bracket certificate must not accept.
//
// Run: node zk/scripts/gateLP0-bracket.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, SCALE, S, asInt, checklist, proveVerifyRefuse, evmRehearsal, shutdown } from './lib/gatekit.mjs';
import { plonkFacts } from './circuit-facts.mjs';
import { load } from './service-root.mjs';
import { expectedIlNumerical, validateQuadratureCopy, narrowestBracket, encodeBracket } from './lib/lpbracket-encode.mjs';

const { lpRisk } = await load(import.meta.url, 'engine/lpRisk.js');
const { round } = await load(import.meta.url, 'engine/stats.js');

const { record, failed } = checklist();
console.log(`GATE LP0 — lp-risk bracket certificate, prove / verify / refuse — ${new Date().toISOString()}\n`);

// ---- 0. the quadrature copy must be the engine's, or nothing below means anything ----------------
const vc = validateQuadratureCopy(lpRisk, round, { volatility: 0.05, horizonPeriods: 30 });
record('the encoder\'s quadrature is the engine\'s, checked against a served figure',
  vc.ok, `service published ${vc.served}% at totalVariance ${vc.v}; the copy gives ${vc.mine.toFixed(8)}%`);

// ---- 1. a real service call, and the bracket that certifies its breakeven ------------------------
const CALL = { volatility: 0.05, horizonPeriods: 30, feeAprPct: 20, periodsPerYear: 365, capitalUsd: 100000 };
const res = lpRisk(CALL);
const served = res.feeVsDivergence.breakevenVolatility;
const feeFracNoConc = (CALL.feeAprPct / 100) * (CALL.horizonPeriods / CALL.periodsPerYear);

console.log(`  service call         : ${JSON.stringify(CALL)}`);
console.log(`  served breakeven σ   : ${served}   (per period)`);
console.log(`  horizon fees         : ${(feeFracNoConc * 100).toFixed(6)}% of capital\n`);

const br = narrowestBracket(feeFracNoConc, CALL.horizonPeriods, served, round);
if (!br) throw new Error('no bracket found for the worked case');
const enc = encodeBracket({ feeFrac: feeFracNoConc, T: CALL.horizonPeriods, bracket: br, servedSigma: served });
if (enc.refused) throw new Error(`the worked case was refused: ${enc.refused}`);

console.log(`  bracket              : [${br.lo}, ${br.hi}]`);
console.log(`  halvings used        : ${br.halvings}   (the engine runs 200; after 200 the bracket is ~3e-17 wide`);
console.log(`                         and both ends land on the SAME 1e-9 integer, so lo < hi is not expressible)`);
console.log(`  doublings used       : ${br.doublings}`);
console.log(`  v* (midpoint)        : ${br.vStar}`);
console.log(`  σ certified          : ${enc.certifiedSigma}   served ${served}   round to 5dp: ${round(enc.certifiedSigma, 5)}`);
console.log(`  midpoint residual    : ${enc.mid}   (must be 0 or 1)`);
console.log(`  width slack          : ${enc.widthSlack} grid steps of a ${enc.widthHat}-step policy bound`);
console.log(`  root residual        : ${enc.Rs}   tolerance ${enc.sigTol}   2|Rs|/TOL = ${enc.sigRatio.toExponential(3)}\n`);

record('the certified breakeven is the figure the service served, at the precision it served it',
  round(enc.certifiedSigma, 5) === served, `certified ${enc.certifiedSigma} -> ${round(enc.certifiedSigma, 5)} · served ${served}`);
record('the bracket straddles: g(lo) > 0 and g(hi) <= 0, in the integers the circuit compares',
  enc.eLoHat + enc.feeHat > SCALE && enc.eHiHat + enc.feeHat <= SCALE,
  `L̂(lo)+f̂ = ${enc.eLoHat + enc.feeHat} > ${SCALE} >= ${enc.eHiHat + enc.feeHat} = L̂(hi)+f̂`);
record('the returned root is the bracket midpoint to one grid step', enc.mid === 0n || enc.mid === 1n,
  `2v̂* − l̂o − ĥi = ${enc.mid}`);
record('the root bound holds on the worked case', enc.sigRatio <= 1,
  `2|Rs| / TOL = ${enc.sigRatio.toExponential(3)}, worst case uses 1/${(1 / enc.sigRatio).toFixed(2)} of it`);
record('the certificate is two evaluations of the quadrature wide, not two hundred',
  br.halvings < 200, `${br.halvings} halvings located the bracket; the CIRCUIT evaluates the quadrature zero times`);

// ---- 2. prove, verify, refuse --------------------------------------------------------------------
const { proof, publicSignals, proveMs } = await proveVerifyRefuse('lpbracket', enc.witness, { record });

console.log(`\n  publicSignals: [${publicSignals.join(', ')}]`);
console.log('  layout       : [midResidual, widthSlack, sigResidual, sigTolerance, feeHat, loHat, hiHat, vStarHat, eLoHat, eHiHat, sigHat, horizonT, widthHat]\n');

const [midSig, wSig, rSig, tSig, ...ins] = publicSignals;
record('the residuals and the bound are published, not hidden',
  asInt(midSig) === enc.mid && BigInt(wSig) === enc.widthSlack && asInt(rSig) === enc.Rs && BigInt(tSig) === enc.sigTol,
  `mid ${asInt(midSig)} · slack ${wSig} · root ${asInt(rSig)} · tolerance ${tSig}`);
record('the two ASSUMED expectation values are public, so no reader can miss what was not proven',
  BigInt(ins[4]) === enc.eLoHat && BigInt(ins[5]) === enc.eHiHat,
  `eLoHat ${ins[4]} · eHiHat ${ins[5]} — these are the 401-point quadrature, supplied and NOT proven here`);

// ---- 3. witnesses a bracket certificate must refuse outright -------------------------------------
console.log('\nWitnesses the circuit must refuse outright:');
const req = createRequire(import.meta.url);
const wasm = readFileSync(path.join(BUILD, 'lpbracket_js', 'lpbracket.wasm'));
const tryWitness = async (w) => {
  try {
    const b = await req(path.join(BUILD, 'lpbracket_js', 'witness_calculator.cjs'))(wasm);
    await b.calculateWTNSBin(w, 0);
    return true;
  } catch { return false; }
};
const bad = [
  ['a bracket that does not straddle (both ends above the fee level)',
    { ...enc.witness, eHiHat: enc.eLoHat.toString() === enc.witness.eLoHat ? String(SCALE - enc.feeHat + 1n) : enc.witness.eHiHat }],
  ['a reversed bracket (hi below lo)', { ...enc.witness, loHat: enc.witness.hiHat, hiHat: enc.witness.loHat }],
  ['a root that is not the bracket midpoint', { ...enc.witness, vStarHat: String(enc.vStarHat + 1000n) }],
  ['a volatility that is not the square root of the midpoint', { ...enc.witness, sigHat: String(enc.sigHat + 100000n) }],
  ['a width bound narrower than the bracket', { ...enc.witness, widthHat: String((enc.hiHat - enc.loHat) - 1n) }],
  ['fees at 100% of capital, where no breakeven exists', { ...enc.witness, feeHat: String(SCALE) }],
  ['endpoint expectations in increasing order', { ...enc.witness, eLoHat: enc.witness.eHiHat, eHiHat: enc.witness.eLoHat }],
  ['a zero horizon', { ...enc.witness, horizonT: '0' }],
];
let refusedWitness = 0;
for (const [label, w] of bad) {
  const built = await tryWitness(w);
  if (!built) refusedWitness++;
  console.log(`  [${built ? '*** FAIL ***' : 'PASS'}] ${label}`);
}
record('every dishonest witness is refused before a proof exists', refusedWitness === bad.length,
  `${refusedWitness} of ${bad.length}`);

// ---- 4. the same refusals in the EVM -------------------------------------------------------------
const evm = await evmRehearsal('lpbracket', proof, publicSignals, { record });

// ---- verdict -------------------------------------------------------------------------------------
const f = plonkFacts(path.join(BUILD, 'lpbracket_plonk.zkey'));
const failures = failed();
const gate = failures.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE LP0: ${gate ? 'PASSED' : `FAILED — ${failures.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints of the 4,096 hez_final_12 allows · domain ${f.domainSize} · proved in ${proveMs} ms`);
console.log('\n  WHAT THIS DOES NOT PROVE. eLoHat and eHiHat are the 401-point quadrature. They arrive as');
console.log('  public inputs and are not certified by anything. A caller who supplies two wrong values');
console.log('  that happen to straddle gets a valid proof of a false breakeven. Nor is monotonicity of');
console.log('  E[IL] proven here — it is what makes the straddled root UNIQUE, and it is established by');
console.log('  sweep (gateLP1) rather than by this circuit.');

writeFileSync(path.join(BUILD, 'gateLP0-bracket.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, proveMs,
  plonkConstraints: f.nConstraints, r1csPublic: f.nPublic, domainSize: f.domainSize,
  call: CALL, servedBreakevenSigma: served, certifiedSigma: enc.certifiedSigma,
  bracket: { lo: br.lo, hi: br.hi, halvings: br.halvings, doublings: br.doublings, vStar: br.vStar },
  midResidual: String(enc.mid), widthSlack: String(enc.widthSlack),
  rootResidual: String(enc.Rs), rootTolerance: String(enc.sigTol), rootBoundUsed: enc.sigRatio,
  acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), verifierBytes: evm.deployedSize, solc: evm.solc,
  publicSignals,
  doesNotProve: [
    'eLoHat and eHiHat are the 401-point quadrature, supplied as public inputs and not certified here',
    'monotonicity of E[IL] in v, which is what makes the straddled root unique',
    'the fee arithmetic, the concentration factor, or the verdict string',
  ],
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
