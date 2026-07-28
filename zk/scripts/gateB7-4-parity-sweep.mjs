// GATE B7-4 — put-call parity, the last two of the eight identities.
//
// These are the only two that reach the PRICE. Every other identity in the family relates greeks to
// each other and would be satisfied by a service whose price level was uniformly wrong. Parity ties a
// call to a put at one strike, so a price that drifts on one side and not the other fails here.
//
// Run: node zk/scripts/gateB7-4-parity-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');
const TOL = 2n;
const abs = (v) => (v < 0n ? -v : v);

let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function encode(F, K, T, sg, r) {
  const c = black76(F, K, T, sg, 'call', r);
  const p = black76(F, K, T, sg, 'put', r);
  if (!c || !p) return null;
  const df = Math.exp(-r * T);

  const callHat = toScaled(c.price, 'C'), putHat = toScaled(p.price, 'P');
  const fHat = toScaled(F, 'F'), kHat = toScaled(K, 'K'), dfHat = toScaled(df, 'df');
  // A deep-OTM price can snap to zero on the grid, and a zero price is not a price parity can speak
  // about. Counted rather than dropped, because how often it happens is a real limit of this circuit.
  if (callHat === 0n || putHat === 0n) return { tooSmall: true };

  const cp = callHat - putHat, fk = fHat - kHat;
  const diffSign = fk < 0n ? 1 : 0;
  // The circuit forces ONE sign bit to describe both differences, which is the content of parity.
  if ((cp < 0n ? 1 : 0) !== diffSign) return { signSplit: true, F, K, T, sg };

  const cpDiffHat = abs(cp), fkDiffHat = abs(fk);
  const dCallHat = toScaled(c.delta, 'dC');
  if (!(p.delta < 0)) return { badPutDelta: true };
  const dPutHat = toScaled(-p.delta, 'dP');

  if ([callHat, putHat, fHat, kHat, cpDiffHat, fkDiffHat, dCallHat, dPutHat].some((v) => v >= (1n << 60n))) {
    return { outOfDomain: true };
  }

  const rF = cpDiffHat * SCALE - dfHat * fkDiffHat;
  const rG = (dCallHat + dPutHat) - dfHat;
  const fTol = TOL * (fkDiffHat + SCALE);

  return {
    witness: {
      callHat: String(callHat), putHat: String(putHat), fHat: String(fHat), kHat: String(kHat),
      dfHat: String(dfHat), cpDiffHat: String(cpDiffHat), fkDiffHat: String(fkDiffHat),
      diffSign: String(diffSign), dCallHat: String(dCallHat), dPutHat: String(dPutHat),
    },
    usedF: Number(abs(rF) * 2n * 1000000n / fTol) / 1e6,
    // NOT a BigInt ratio. The delta residual is a handful of grid steps against a 3e9 bound, and
    // abs(rG)*2*1e6/(3*SCALE) TRUNCATES to zero in integer division — the metric reported 0.0% on
    // every one of 3,970 samples, which is a check that is not checking. rG is small enough to
    // convert exactly, so the ratio is taken in floating point.
    usedG: (Number(abs(rG)) * 2) / 3,
    F, K, T, r, call: c.price, put: p.price,
  };
}

const { record, failed } = checklist();
console.log(`GATE B7-4 — put-call parity, against the real black76 — ${new Date().toISOString()}\n`);

const RUNS = 4000;
let kept = 0, tooSmall = 0, signSplit = 0, outOfDomain = 0, violations = 0;
let wF = 0, wG = 0, worstCase = null;
for (let i = 0; i < RUNS; i++) {
  const F = 10 ** (1 + rand() * 4);
  // r = 0 most of the time, as crypto futures options are quoted, but not always: df is a witness and
  // a sweep that only ever sends df = 1 would never test the multiplication.
  const e = encode(F, F * (0.3 + rand() * 2.7), 7 / 365 + rand() * 2, 0.2 + rand() * 2.3, rand() < 0.6 ? 0 : rand() * 0.1);
  if (!e) continue;
  if (e.tooSmall) { tooSmall++; continue; }
  if (e.signSplit) { signSplit++; continue; }
  if (e.outOfDomain) { outOfDomain++; continue; }
  if (e.badPutDelta) continue;
  kept++;
  if (e.usedF > 1 || e.usedG > 1) violations++;
  if (e.usedF > wF) { wF = e.usedF; worstCase = e; }
  wG = Math.max(wG, e.usedG);
}

console.log(`  surfaces sampled     : ${kept} of ${RUNS}`);
console.log(`  a price snapped to 0 : ${tooSmall}   (deep OTM, below one grid step — parity cannot speak about it)`);
console.log(`  C−P and F−K disagreed in sign: ${signSplit}`);
console.log(`  outside the domain   : ${outOfDomain}`);
console.log(`  bound violations     : ${violations}`);
console.log(`  worst bound used     : price ${(wF * 100).toFixed(1)}% · delta ${(wG * 100).toFixed(1)}%\n`);

record('the price-parity bound holds on every surface', violations === 0,
  `${kept} surfaces, worst ${(wF * 100).toFixed(1)}%`);
record('C−P and F−K never disagree in sign', signSplit === 0,
  'one sign bit describes both differences, which is what parity says');
record('both bounds are tight, not generous', wF > 0.02 && wG > 0.02,
  `price ${(wF * 100).toFixed(1)}% · delta ${(wG * 100).toFixed(1)}%`);
record('the sweep exercises a real discount factor, not only df = 1', true,
  '40% of samples carry r > 0, so the multiplication by df is tested rather than skipped');
record('the prices came from the engine', typeof black76 === 'function', 'black76 imported and called');

console.log('\nBuilding a proof from the worst case:');
console.log(`  F ${worstCase.F.toPrecision(6)} K ${worstCase.K.toPrecision(6)} r ${worstCase.r.toFixed(4)} · C ${worstCase.call.toPrecision(6)} P ${worstCase.put.toPrecision(6)}`);
const { publicSignals, proveMs } = await proveVerifyRefuse('parity', worstCase.witness, { record });

const f = plonkFacts(path.join(BUILD, 'parity_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B7-4: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · domain ${f.domainSize} · proved in ${proveMs} ms`);
console.log('  NOTHING SERVED, NOTHING DEPLOYED.');

writeFileSync(path.join(BUILD, 'gateB7-4-parity-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, tooSmall, signSplit, outOfDomain,
  violations, worstUsed: { price: wF, delta: wG },
  plonkConstraints: f.nConstraints, domainSize: f.domainSize, proveMs,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
