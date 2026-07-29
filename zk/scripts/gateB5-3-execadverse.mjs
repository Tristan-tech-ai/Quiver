// GATE B5-3 — the HEADLINE circuit proves, verifies, and can REFUSE.
//
// constantproduct.circom certifies the benchmark. This certifies what the service actually sells:
// `adverseExecutionBps`, together with the realized fill it is computed against and the exact
// output-token shortfall in between.
//
// The worked case is a real sandwich shape — a 30bp pool, a swap worth 1% of the input side, and a
// fill a little worse than the pool honestly implied — because a favorable fill exercises the signed
// path but not the case a buyer pays for.
//
// Run: node zk/scripts/gateB5-3-execadverse.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, SCALE, S, FIELD, toScaled, asInt, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { plonkFacts } from './circuit-facts.mjs';
import { load } from './service-root.mjs';

const { execVerify } = await load(import.meta.url, 'engine/execVerify.js');
const { round } = await load(import.meta.url, 'engine/stats.js');

const require = createRequire(import.meta.url);
const { record, failed } = checklist();
console.log(`GATE B5-3 — the headline circuit, prove / verify / refuse — ${new Date().toISOString()}\n`);

const x = 1_500_000, y = 3_750_000, f = 0.003, dx = 15_000;
const realized = 36_900;            // worse than honest: the case the service exists to name

const served = execVerify({ amountIn: dx, amountOutRealized: realized, reserveIn: x, reserveOut: y, feeTier: f, slippageTolerancePct: 1.0 });
if (!served.ok || served.mode !== 'constant-product') throw new Error('the engine refused the pool this gate is built on');

const xHat = toScaled(x, 'x'), yHat = toScaled(y, 'y'), dxHat = toScaled(dx, 'dx'), fHat = toScaled(f, 'f');
const realizedHat = toScaled(realized, 'realized');
const inHat = (dxHat * (SCALE - fHat) + SCALE / 2n) / SCALE;
const denom = xHat + inHat;
const outHat = (inHat * yHat + denom / 2n) / denom;      // the engine's expression, the engine's order
const sHat = outHat - realizedHat;
// bpsHat is the FULL-PRECISION headline on the grid, not the published two-decimal figure. The tie to
// the published field is asserted separately below, so the circuit gets the tight bound and the buyer
// still gets the number they were shown.
const num = 10000n * SCALE * sHat;
const bpsHat = (num * 2n / outHat + (num < 0n ? -1n : 1n)) / 2n;   // round-half-away-from-zero

const Rf = inHat * SCALE - dxHat * (SCALE - fHat);
const R = (xHat + inHat) * (yHat - outHat) - xHat * yHat;
const Rb = bpsHat * outHat - 10000n * SCALE * sHat;
const abs = (v) => (v < 0n ? -v : v);

console.log(`  pool ${(x / 1e6).toFixed(2)}M / ${(y / 1e6).toFixed(2)}M at ${(f * 1e4).toFixed(0)}bp, swapping ${dx.toLocaleString()} in, filled at ${realized.toLocaleString()}`);
console.log(`  engine: honestOut ${served.honestOut} · adverseExecutionBps ${served.adverseExecutionBps} · adverseValueOut ${served.adverseValueOut}`);
console.log(`  within the caller's ${served.slippageTolerance.toleranceBps} bps tolerance: ${served.slippageTolerance.withinTolerance}\n`);
console.log(`  invariant residual R  = ${R}         (2|R|  <= ${xHat + inHat + yHat - outHat})`);
console.log(`  fee residual       Rf = ${Rf}         (2|Rf| <= ${SCALE})`);
console.log(`  headline residual  Rb = ${Rb}   (2|Rb| <= ${outHat})`);
console.log(`  Rb uses ${(Number(abs(Rb) * 2n) / Number(outHat) * 100).toFixed(1)}% of its bound\n`);

record('the exact shortfall needs no tolerance at all',
  sHat === outHat - realizedHat && round(Number(sHat) / S, 8) === served.adverseValueOut,
  `shortfall ${Number(sHat) / S} output tokens, certified exactly; engine published ${served.adverseValueOut}`);
record('the certified headline rounds to the headline the engine published',
  round(Number(bpsHat) / S, 2) === served.adverseExecutionBps,
  `certified ${Number(bpsHat) / S} bps -> round(_,2) = ${round(Number(bpsHat) / S, 2)} · engine served ${served.adverseExecutionBps}`);
record('the headline is positive, so this is the case a caller pays to detect',
  served.adverseExecutionBps > 5, `${served.adverseExecutionBps} bps against the 5 bps verdict threshold`);

// A negative headline is a favorable fill and is encoded the way the field encodes negatives.
const asField = (v) => String(v < 0n ? FIELD + v : v);
const witness = {
  xHat: String(xHat), yHat: String(yHat), dxHat: String(dxHat), fHat: String(fHat),
  inHat: String(inHat), outHat: String(outHat), realizedHat: String(realizedHat),
  bpsHat: asField(bpsHat),
};
const { publicSignals, proveMs } = await proveVerifyRefuse('execadverse', witness, { record });

console.log(`\n  publicSignals: [${publicSignals.join(', ')}]`);
console.log('  layout       : [residual, feeResidual, bpsResidual, tolerance, feeTolerance, bpsTolerance, shortfall, x, y, dx, f, in, out, realized, bps]\n');

const [rSig, rfSig, rbSig, tSig, ftSig, btSig, sSig, xS, yS, dxS, fS, inS, outS, rzS, bS] = publicSignals;
record('the public signals are the scaled inputs, unchanged',
  BigInt(xS) === xHat && BigInt(yS) === yHat && BigInt(dxS) === dxHat && BigInt(inS) === inHat
  && BigInt(outS) === outHat && BigInt(rzS) === realizedHat && asInt(bS) === bpsHat,
  `x ${xS} · out ${outS} · realized ${rzS} · bps ${asInt(bS)}`);
record('the effective input IS published as a public signal, not left implicit',
  BigInt(inS) === inHat, `signal[11] = ${inS} = dx(1-f) on the grid`);
record('all three residuals and all three tolerances are published, not hidden',
  asInt(rSig) === R && asInt(rfSig) === Rf && asInt(rbSig) === Rb
  && BigInt(ftSig) === SCALE && BigInt(btSig) === outHat,
  `R ${asInt(rSig)} · Rf ${asInt(rfSig)} · Rb ${asInt(rbSig)} · bps tolerance ${btSig}`);
record('the shortfall is published, so a dispute has the output-token loss and not only a ratio',
  asInt(sSig) === sHat, `${asInt(sSig)} = ${Number(sHat) / S} output tokens`);

// ---- Refusals -----------------------------------------------------------------------------------
// The headline refusals are the ones that would let a proof overstate the loss. A fabricated
// benchmark, a fabricated fill, and a bps figure that does not follow from either.
console.log('\nWitnesses the circuit must refuse outright:');
const bads = [
  ['a fill larger than the output reserve', { ...witness, outHat: String(yHat + SCALE) }],
  ['a benchmark that breaks the invariant', { ...witness, outHat: String(toScaled(38000)) }],
  ['an effective input above the gross input', { ...witness, inHat: String(dxHat + SCALE) }],
  ['a fee of 100%', { ...witness, fHat: String(SCALE) }],
  ['an empty pool', { ...witness, xHat: '0' }],
  ['a trade of nothing', { ...witness, dxHat: '0' }],
  ['a fill of nothing', { ...witness, realizedHat: '0' }],
  ['the effective input off by ONE grid step', { ...witness, inHat: String(inHat + 1n) }],
  ['the effective input off by one the other way', { ...witness, inHat: String(inHat - 1n) }],
  ['the headline off by ONE unit of 1e-9 bps', { ...witness, bpsHat: String(bpsHat + 1n) }],
  ['the headline doubled', { ...witness, bpsHat: String(bpsHat * 2n) }],
  ['the headline with its sign flipped', { ...witness, bpsHat: asField(-bpsHat) }],
  ['a headline past the circuit width', { ...witness, bpsHat: String(1n << 51n) }],
];
let refused = 0;
const builder = await require(path.join(BUILD, 'execadverse_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'execadverse_js', 'execadverse.wasm')));
for (const [label, w] of bads) {
  let built = false;
  try { await builder.calculateWTNSBin(w, 0); built = true; } catch { /* rejected, as intended */ }
  if (!built) refused++;
  console.log(`  [${built ? '*** FAIL ***' : 'PASS'}] ${label}`);
}
record('every dishonest witness is refused before a proof exists', refused === bads.length, `${refused} of ${bads.length}`);

// A favorable fill is a real outcome, not an error, and the signed path has to carry it.
const goodFill = 37_500;
const servedGood = execVerify({ amountIn: dx, amountOutRealized: goodFill, reserveIn: x, reserveOut: y, feeTier: f });
const rzGood = toScaled(goodFill), sGood = outHat - rzGood;
const numG = 10000n * SCALE * sGood;
const bpsGood = (numG * 2n / outHat + (numG < 0n ? -1n : 1n)) / 2n;
let signedOk = false;
try {
  await builder.calculateWTNSBin({ ...witness, realizedHat: String(rzGood), bpsHat: asField(bpsGood) }, 0);
  signedOk = true;
} catch { /* */ }
record('a FAVORABLE fill (negative headline) is carried, not refused',
  signedOk && bpsGood < 0n && servedGood.adverseExecutionBps < 0
    && round(Number(bpsGood) / S, 2) === servedGood.adverseExecutionBps,
  `filled at ${goodFill}: engine ${servedGood.adverseExecutionBps} bps, certified ${Number(bpsGood) / S} bps`);

const facts = plonkFacts(path.join(BUILD, 'execadverse_plonk.zkey'));
const base = plonkFacts(path.join(BUILD, 'constantproduct_plonk.zkey'));
record('the headline costs no new ceremony file: the Plonk domain does not move',
  facts.domainSize === base.domainSize,
  `constantproduct ${base.nConstraints} gates / domain ${base.domainSize} · execadverse ${facts.nConstraints} gates / domain ${facts.domainSize}`);

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B5-3: ${gate ? 'PASSED' : `FAILED — ${bad.map((v) => v.name).join('; ')}`}`);
console.log(`  ${facts.nConstraints} Plonk constraints · ${facts.nPublic} public · domain ${facts.domainSize} · proved in ${proveMs} ms`);
console.log(`  the benchmark alone was ${base.nConstraints} gates in the same domain: +${facts.nConstraints - base.nConstraints} buys the headline`);

writeFileSync(path.join(BUILD, 'gateB5-3-execadverse.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, proveMs,
  plonkConstraints: facts.nConstraints, nPublic: facts.nPublic, domainSize: facts.domainSize,
  baselineConstraints: base.nConstraints, baselineDomain: base.domainSize,
  pool: { x, y, fee: f, dx, realized },
  servedHonestOut: served.honestOut, servedAdverseBps: served.adverseExecutionBps,
  servedAdverseValueOut: served.adverseValueOut,
  certifiedBps: Number(bpsHat) / S, certifiedShortfall: Number(sHat) / S,
  residual: String(R), feeResidual: String(Rf), bpsResidual: String(Rb),
  bpsBoundUsed: Number(abs(Rb) * 2n) / Number(outHat),
  publicSignals, refusals: bads.length,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
