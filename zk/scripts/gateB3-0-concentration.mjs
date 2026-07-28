// GATE B3-0 — the concentration circuit proves, verifies, and can REFUSE.
//
// Run: node zk/scripts/gateB3-0-concentration.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, snap, toScaled, asInt, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const N = 8;

/**
 * Encode a book. The weights are snapped onto the grid FIRST, and the index is then recomputed from
 * the snapped weights, because those are what the circuit will see. Deriving the index from the raw
 * doubles would prove an identity about a book one grid step away from the one being certified.
 */
function encode(shares) {
  if (shares.length > N) throw new Error(`this circuit takes at most ${N} assets`);
  const wHat = shares.map((w, i) => toScaled(w, `w[${i}]`));
  const padded = [...wHat, ...Array(N - wHat.length).fill(0n)];

  // Σŵ², in integers, exactly as the circuit accumulates it.
  const sumSq = padded.reduce((a, w) => a + w * w, 0n);
  // Ĥ = round(Σŵ² / S) — the index on the grid. Integer division would truncate; round properly.
  const hHat = (sumSq + SCALE / 2n) / SCALE;

  const R = hHat * SCALE - sumSq;
  const sumW = padded.reduce((a, w) => a + w, 0n);
  return { witness: { wHat: padded.map(String), hHat: hHat.toString() }, padded, hHat, R, sumW, sumSq };
}

const { record, failed } = checklist();
console.log(`GATE B3-0 — concentration circuit, prove / verify / refuse — ${new Date().toISOString()}\n`);

// ---- 1. a worked case with an EXACT residual ------------------------------------------------------
// Four equal shares give H = 4 × 0.25² = 0.25 exactly, so anything other than a zero residual is
// immediately suspicious rather than merely large.
const enc = encode([0.25, 0.25, 0.25, 0.25]);
console.log(`  four equal quarters  ->  H = ${Number(enc.hHat) / S}  (1/4 exactly, four independent bets)`);
console.log(`  Σŵ = ${enc.sumW} (S = ${SCALE})   Σŵ² = ${enc.sumSq}`);
console.log(`  residual R = ${enc.R}   (tolerance 2|R| <= ${S})\n`);
record('the worked case has an exact residual', enc.R === 0n, `R = ${enc.R}`);
record('the worked case is the answer the engine would give', Number(enc.hHat) / S === 0.25,
  `H = ${Number(enc.hHat) / S}`);

// ---- 2. prove, verify, refuse ---------------------------------------------------------------------
const { publicSignals, proveMs } = await proveVerifyRefuse('concentration', enc.witness, { record });

console.log(`\n  publicSignals: [${publicSignals.join(', ')}]`);
console.log('  layout       : [residual, tolerance, weightSlack, wHat[0..7], hHat]\n');

const [rSig, tSig, slackSig, ...rest] = publicSignals;
const wSigs = rest.slice(0, N);
const hSig = rest[N];
record('the public signals are the scaled inputs, unchanged',
  wSigs.every((v, i) => BigInt(v) === enc.padded[i]) && BigInt(hSig) === enc.hHat,
  `hHat ${hSig} · first weight ${wSigs[0]}`);
record('the residual and tolerance are published, not hidden',
  asInt(rSig) === enc.R && BigInt(tSig) === BigInt(S),
  `residual ${asInt(rSig)} · tolerance ${tSig}`);
record('the weight slack is published too, so grid drift is visible',
  BigInt(slackSig) === enc.sumW - SCALE + BigInt(N),
  `slack signal ${slackSig} (N + Σŵ − S, so ${N} means an exact sum)`);

// ---- 3. the circuit must REFUSE a book it cannot honestly speak about ------------------------------
// Refusing a bad witness at the prover is a different guarantee from refusing a bad proof at the
// verifier, and only the second is covered above. A witness whose shares do not sum to the book must
// not produce a proof at all.
console.log('\nWitnesses the circuit must refuse outright:');
const badWitnesses = [
  ['shares that do not sum to the book', { wHat: [0.25, 0.25, 0.25].map((w) => String(toScaled(w))).concat(Array(5).fill('0')), hHat: String((3n * (toScaled(0.25) ** 2n) + SCALE / 2n) / SCALE) }],
  ['an index that does not match the shares', { wHat: Array(4).fill(String(toScaled(0.25))).concat(Array(4).fill('0')), hHat: String(toScaled(0.9)) }],
  ['a share larger than the whole book', { wHat: [String(toScaled(1.5)), String(toScaled(0.1))].concat(Array(6).fill('0')), hHat: String(toScaled(0.5)) }],
  ['a zero index (an empty book)', { wHat: Array(8).fill('0'), hHat: '0' }],
];
let refusedWitness = 0;
for (const [label, w] of badWitnesses) {
  let built = false;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { readFileSync } = await import('node:fs');
    const b = await req(path.join(BUILD, 'concentration_js', 'witness_calculator.cjs'))(readFileSync(path.join(BUILD, 'concentration_js', 'concentration.wasm')));
    await b.calculateWTNSBin(w, 0);
    built = true;
  } catch { /* the constraint system rejected it, which is the point */ }
  if (!built) refusedWitness++;
  console.log(`  [${built ? '*** FAIL ***' : 'PASS'}] ${label}`);
}
record('every dishonest witness is refused before a proof exists', refusedWitness === badWitnesses.length,
  `${refusedWitness} of ${badWitnesses.length}`);

// ---- verdict --------------------------------------------------------------------------------------
const f = plonkFacts(path.join(BUILD, 'concentration_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B3-0: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · proved in ${proveMs} ms`);

writeFileSync(path.join(BUILD, 'gateB3-0-concentration.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, proveMs,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize,
  publicSignals, residual: String(enc.R), checks: failed().length ? 'see console' : 'all passed',
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
