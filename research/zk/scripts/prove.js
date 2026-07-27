'use strict';

// Honest-path prover: engine inputs -> scaled integers -> witness -> Groth16 proof
// -> verification. Every number this prints is measured at run time.
//
// Usage: node scripts/prove.js [--out build/proof]

const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const scale = require('../src/scale');

const BUILD = path.join(__dirname, '..', 'build');
const WASM = path.join(BUILD, 'liquidation_js', 'liquidation.wasm');
const ZKEY = path.join(BUILD, 'liquidation_final.zkey');
const VKEY = path.join(BUILD, 'verification_key.json');

// The reference position. Realistic BTC-ish perp, 10x long.
const POSITION = { M: 5000, q: 0.5, P0: 100000, s: 1, mmr: 0.005 };

async function main() {
  const t = (label, ms) => console.log(`  ${label.padEnd(34)} ${ms.toFixed(1)} ms`);

  console.log('Position (engine floats):');
  console.log(' ', JSON.stringify(POSITION));

  const inputs = scale.toCircuitInputs(POSITION);
  const witnessInput = scale.toWitnessInput(inputs);

  const R = scale.residual(inputs);
  const TOL = scale.toleranceBound(inputs);
  console.log('\nScaled integers handed to the circuit:');
  for (const [k, v] of Object.entries(witnessInput)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log(`\n  residual R            ${R}`);
  console.log(`  tolerance qHat*(S+mmr) ${TOL}`);
  console.log(`  2|R| / tolerance       ${Number(2n * (R < 0n ? -R : R)) / Number(TOL)}`);

  // Cross-check the integer path against the engine's float path. This is the
  // encoding gap, measured on this specific position rather than assumed.
  const enginePLiq = scale.engineLiquidationPrice(POSITION);
  const canonicalPLiq = scale.fromScaled(inputs.pLiqHat);
  console.log('\nEncoding gap on this position:');
  console.log(`  engine float P_liq     ${enginePLiq}`);
  console.log(`  canonical integer P_liq ${canonicalPLiq}`);
  console.log(`  |difference|           ${Math.abs(enginePLiq - canonicalPLiq)}`);

  console.log('\nProving:');
  let t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witnessInput, WASM, ZKEY);
  const proveMs = Date.now() - t0;
  t('witness + proof', proveMs);

  const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf8'));
  t0 = Date.now();
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  const verifyMs = Date.now() - t0;
  t('verify', verifyMs);

  console.log(`\n  verified: ${ok}`);
  if (!ok) throw new Error('honest proof failed to verify — stop and investigate');

  fs.writeFileSync(path.join(BUILD, 'proof.json'), JSON.stringify(proof, null, 2));
  fs.writeFileSync(path.join(BUILD, 'public.json'), JSON.stringify(publicSignals, null, 2));

  const proofBytes = fs.statSync(path.join(BUILD, 'proof.json')).size;
  const vkeyBytes = fs.statSync(VKEY).size;
  const zkeyBytes = fs.statSync(ZKEY).size;

  console.log('\nPublic signals, in the order snarkjs emits them:');
  publicSignals.forEach((v, i) => console.log(`  [${i}] ${v}`));

  console.log('\nArtifact sizes:');
  console.log(`  proof.json            ${proofBytes} bytes`);
  console.log(`  verification_key.json ${vkeyBytes} bytes`);
  console.log(`  proving key (.zkey)   ${zkeyBytes} bytes  (prover only, never shipped to a verifier)`);

  console.log(JSON.stringify({ MEASURED: { proveMs, verifyMs, proofBytes, vkeyBytes, zkeyBytes } }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
