// GATE B0 — the Kelly circuit proves, verifies, and can REFUSE.
//
// A verifier that cannot reject is not a verifier, so this does not stop at "the honest proof
// verifies". Every public signal is perturbed by one, on its own, and each perturbation must be
// rejected. That is the half of the gate that can actually fail.
//
// Run: node zk/scripts/gateB0-kelly.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, '..', 'build');
const require = createRequire(import.meta.url);

const SCALE = 1_000_000_000n;
const S = Number(SCALE);

// Same snap the service uses for the liquidation circuit: round the DECIMAL value, never the scaled
// product. `Math.round(x * 1e9)` is wrong above ~9e6 where the product passes 2^53.
const snap = (x) => Number(x.toFixed(9));
const toScaled = (x, name) => {
  const v = snap(x);
  if (!Number.isFinite(v)) throw new Error(`${name}: not finite`);
  const scaled = BigInt(Math.round(v * S));
  if (scaled < 0n) throw new Error(`${name}: negative`);
  return scaled;
};

/** The engine's own identity, in integers. Returns the witness plus the residual for inspection. */
function encode(p, b) {
  const pHat = toScaled(p, 'p');
  const bHat = toScaled(b, 'b');
  // f* is derived from the SNAPPED inputs, because those are what the circuit will see. Deriving it
  // from the raw doubles would prove an identity about a bet one grid step away from the one sized.
  const f = (Number(pHat) / S * (Number(bHat) / S + 1) - 1) / (Number(bHat) / S);
  if (!(f > 0)) return null;                       // positive edge only, as the circuit demands
  const fHat = toScaled(f, 'f');
  if (fHat === 0n) return null;
  const R = fHat * bHat - pHat * bHat - SCALE * pHat + SCALE * SCALE;
  return { witness: { pHat: pHat.toString(), bHat: bHat.toString(), fHat: fHat.toString() }, pHat, bHat, fHat, R, f };
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};

const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));

console.log(`GATE B0 — Kelly circuit, prove / verify / refuse — ${new Date().toISOString()}\n`);

// ---- 1. the worked case -----------------------------------------------------------------------
// p = 0.55, b = 1.2 gives f* = 0.175 exactly, which the live engine also returns. A case where the
// arithmetic is exact makes a residual of anything other than zero immediately suspicious.
const enc = encode(0.55, 1.2);
if (!enc) throw new Error('the worked case was refused by the encoder');
console.log(`  p 0.55  b 1.2  ->  f* ${enc.f}`);
console.log(`  scaled: pHat ${enc.pHat}  bHat ${enc.bHat}  fHat ${enc.fHat}`);
console.log(`  residual R = ${enc.R}  (tolerance 2|R| <= ${enc.bHat})\n`);
record('the worked case has an exact residual', enc.R === 0n, `R = ${enc.R}`);

// Sizes read from the artifacts, so the record below describes the circuit that was actually proved.
const snarkjsInfo = (await import('snarkjs')).default ?? (await import('snarkjs'));
enc.r1cs = (await snarkjsInfo.r1cs.info(path.join(BUILD, 'kelly.r1cs'))).nConstraints;

// ---- 2. prove and verify ----------------------------------------------------------------------
const wasm = path.join(BUILD, 'kelly_js', 'kelly.wasm');
const zkey = path.join(BUILD, 'kelly_plonk.zkey');
const calc = require(path.join(BUILD, 'kelly_js', 'witness_calculator.cjs'));
const builder = await calc(readFileSync(wasm));
const wtns = await builder.calculateWTNSBin(enc.witness, 0);

const t0 = Date.now();
const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, wtns);
const proveMs = Date.now() - t0;

const vk = JSON.parse(readFileSync(path.join(BUILD, 'kelly_vk.json'), 'utf8'));
const ok = await snarkjs.plonk.verify(vk, publicSignals, proof);
record('the honest proof verifies against the published key', ok === true,
  `proved in ${proveMs}ms · ${publicSignals.length} public signals · nPublic ${vk.nPublic}`);

console.log(`\n  publicSignals: [${publicSignals.join(', ')}]`);
console.log('  layout       : [residual, tolerance, pHat, bHat, fHat]\n');

// The signals must be the scaled inputs, or the proof is about a different bet.
const [rSig, tSig, pSig, bSig, fSig] = publicSignals;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const asInt = (x) => { const v = BigInt(x); return v > FIELD / 2n ? v - FIELD : v; };
record('the public signals are the scaled inputs, unchanged',
  BigInt(pSig) === enc.pHat && BigInt(bSig) === enc.bHat && BigInt(fSig) === enc.fHat,
  `pHat ${pSig} · bHat ${bSig} · fHat ${fSig}`);
record('the residual and tolerance are published, not hidden',
  asInt(rSig) === enc.R && BigInt(tSig) === enc.bHat,
  `residual ${asInt(rSig)} · tolerance ${tSig}`);

// ---- 3. THE HALF THAT CAN FAIL: every perturbed signal must be refused -------------------------
console.log('\nRefusals — each public signal moved by one, on its own:');
let refused = 0;
for (let i = 0; i < publicSignals.length; i++) {
  const bad = [...publicSignals];
  bad[i] = (BigInt(bad[i]) + 1n).toString();
  const accepted = await snarkjs.plonk.verify(vk, bad, proof);
  const good = accepted === false;
  if (good) refused++;
  console.log(`  [${good ? 'PASS' : '*** FAIL ***'}] signal[${i}] + 1 -> ${accepted}`);
}
record('every perturbed public signal is rejected', refused === publicSignals.length,
  `${refused} of ${publicSignals.length}`);

// A bent proof point, the other way a verifier can be asked to fail.
const bentProof = JSON.parse(JSON.stringify(proof));
bentProof.A[0] = (BigInt(bentProof.A[0]) + 1n).toString();
let bentAccepted;
try { bentAccepted = await snarkjs.plonk.verify(vk, publicSignals, bentProof); }
catch { bentAccepted = false; }
record('a bent proof point is rejected', bentAccepted === false, `returned ${bentAccepted}`);

// ---- verdict ------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
const gate = failed.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B0: ${gate ? 'PASSED' : `FAILED — ${failed.map((f) => f.name).join('; ')}`}`);
writeFileSync(path.join(BUILD, 'gateB0-kelly.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, proveMs,
  // Read from the zkey, not written down. This line used to be the literal `718`. The literal
  // happened to be right, but nothing compared it to the artifact, so it could have gone stale on
  // the first edit to the circuit and the gate would still have reported it with a straight face.
  ...(await import('./circuit-facts.mjs').then((m) => {
    const f = m.plonkFacts(zkey);
    return { plonkConstraints: f.nConstraints, r1csConstraints: enc.r1cs, domainSize: f.domainSize };
  })),
  publicSignals, residual: String(enc.R), checks: results,
}, null, 2) + '\n', 'utf8');
await globalThis.curve_bn128?.terminate();
process.exit(gate ? 0 : 1);
