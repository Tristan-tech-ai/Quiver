// What does a proof of the liquidation identity buy a contract, when every input is public?
//
// WHY THIS EXISTS. `liquidation.circom` has `nPrvIn = 0`. So does `kelly`, so does `concentration` —
// the whole live paid path. With nothing private, the statement a proof carries is a closed-form
// predicate over the six numbers the verifier already receives, and a contract can evaluate it
// directly. The claim that a SNARK is what lets "a verifier that cannot run Node" check the
// arithmetic then rests on a comparison nobody in this repository has measured: the pairing check
// against the direct check.
//
// The figure that had been quoted for the direct check (~5,011 gas, "about 55x cheaper") came from a
// review and was explicitly not reproduced — `PHASE_B_VERIFIED.md` §3.1 says so in as many words: "I
// did not myself measure the ~5,011-gas direct Solidity check." A number nobody measured is exactly
// what this project is not allowed to publish, so this probe measures both sides in the same process,
// each in a FRESH EVM instance, against a real proof of a real perp-gate answer.
//
// WHAT THE DIRECT CHECKER IS. `DirectLiquidation.sol` below is not a summary of the circuit; it is a
// line-by-line restatement of every constraint `liquidation.circom` imposes:
//
//     range discipline   mHat < 2^80, qHat < 2^60, p0Hat < 2^60, pLiqHat < 2^60, mmrHat < 2^30
//     side               (s-1)(s+1) == 0
//     proper fraction    mmrHat < SCALE
//     non-degenerate     qHat != 0
//     the identity       R = mHat*SCALE^2 + s*qHat*(pLiqHat - p0Hat)*SCALE - qHat*pLiqHat*mmrHat
//     the bound          2*|R| <= qHat*(SCALE + mmrHat)
//
// It is held to that by construction: the honest witness must be accepted, and the SAME single-grid-
// step perturbation the on-chain registry records as `ProofRejected` must be refused. A checker that
// accepts everything would report a wonderful gas figure for checking nothing.
//
// WHAT THIS PROBE DOES NOT CLAIM. That the direct check is a substitute. It is not: the pairing check
// buys third-party certification that the arithmetic was performed by the published circuit, and it
// composes with a commitment or an attestation later. It buys neither privacy nor succinctness here,
// and this measures the size of that bill rather than arguing about it.
//
// Run: node zk/scripts/probe-direct-vs-snark-gas.mjs      (writes zk/build/probe-direct-vs-snark-gas.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, SCALE, S, asInt, snarkjs, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const require = createRequire(import.meta.url);
const { perpGate } = await load(import.meta.url, 'engine/perpGate.js');
const { witnessFor } = await load(import.meta.url, 'util/snark.js');

console.log(`PROBE — a pairing check against the same predicate in Solidity — ${new Date().toISOString()}\n`);

// ---- 1. a real answer, and the service's own witness ---------------------------------------------
// The position is the one the paper's Appendix C exhibit uses, so the integers here are the integers
// a reader can already see on chain rather than a case invented for a favourable number.
const POSITION = { side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005 };
const out = perpGate(POSITION);
if (!out.ok || !(out.liquidationPrice > 0)) throw new Error('the engine did not price the position');
const built = witnessFor(POSITION, out.liquidationPrice);
if (!built) throw new Error('the service refused to build a witness for its own answer');

const w = built.witness;
console.log(`  position   ${POSITION.side} ${POSITION.size} @ ${POSITION.entryPrice}, ${POSITION.leverage}x, mmr ${POSITION.maintMarginRate}`);
console.log(`  served     liquidationPrice ${out.liquidationPrice}`);
console.log(`  witness    mHat ${w.mHat} qHat ${w.qHat} p0Hat ${w.p0Hat} s ${w.s} mmrHat ${w.mmrHat} pLiqHat ${w.pLiqHat}`);

// ---- 2. prove it, so both sides are measured over the same statement -----------------------------
const sj = await snarkjs();
const zkey = path.join(BUILD, 'liquidation_plonk.zkey');
const wasm = path.join(BUILD, 'liquidation_js', 'liquidation.wasm');
const builder = await require(path.join(BUILD, 'liquidation_js', 'witness_calculator.cjs'))(readFileSync(wasm));
const wtns = await builder.calculateWTNSBin(w, 0);
const t0 = Date.now();
const { proof, publicSignals } = await sj.plonk.prove(zkey, wtns);
const proveMs = Date.now() - t0;
// The liquidation verification key is `vk_plonk.json`, not `liquidation_vk.json`: it was the first
// circuit here and predates the per-circuit naming every later one follows. `preflight.mjs` carries the
// same exception in its own artifact list.
if (!(await sj.plonk.verify(JSON.parse(readFileSync(path.join(BUILD, 'vk_plonk.json'), 'utf8')), publicSignals, proof))) {
  throw new Error('the proof does not verify off chain — nothing below would mean anything');
}
console.log(`\n  proved in ${proveMs} ms · ${publicSignals.length} public signals`);
console.log(`  residual ${asInt(publicSignals[0])} · tolerance ${publicSignals[1]} · 2|R|/tol ${(Number(asInt(publicSignals[0]) < 0n ? -asInt(publicSignals[0]) : asInt(publicSignals[0])) * 2 / Number(publicSignals[1])).toFixed(6)}`);

// ---- 3. the two contracts ------------------------------------------------------------------------
const DIRECT = `
// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.0 <0.9.0;
/// Every constraint liquidation.circom imposes, evaluated directly. Nothing is proven and nothing is
/// trusted: the six numbers arrive in calldata exactly as they arrive in the circuit's public signals.
contract DirectLiquidation {
    uint256 constant SCALE = ${SCALE};
    function check(uint256 mHat, uint256 qHat, uint256 p0Hat, int256 s, uint256 mmrHat, uint256 pLiqHat)
        external pure returns (bool)
    {
        if (mHat   >= (1 << 80)) return false;              // Num2Bits(80)
        if (qHat   >= (1 << 60)) return false;              // Num2Bits(60)
        if (p0Hat  >= (1 << 60)) return false;              // Num2Bits(60)
        if (pLiqHat >= (1 << 60)) return false;             // Num2Bits(60)
        if (mmrHat >= (1 << 30)) return false;              // Num2Bits(30)
        if (s != 1 && s != -1) return false;                // (s-1)*(s+1) === 0
        if (mmrHat >= SCALE) return false;                  // 0 <= mmr < 1
        if (qHat == 0) return false;                        // size non-zero
        int256 R = int256(mHat * SCALE * SCALE)
                 + s * int256(qHat) * (int256(pLiqHat) - int256(p0Hat)) * int256(SCALE)
                 - int256(qHat * pLiqHat * mmrHat);
        uint256 mag = R < 0 ? uint256(-R) : uint256(R);
        return 2 * mag <= qHat * (SCALE + mmrHat);          // 2|R| <= qHat*(SCALE + mmrHat)
    }
}
`;

const solc = (await import('solc')).default ?? (await import('solc'));
const { EVM } = await import('@ethereumjs/evm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
const { keccak256 } = await import('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('ethereum-cryptography/utils.js');

const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'PlonkVerifier.sol': { content: readFileSync(path.join(BUILD, 'PlonkVerifier.sol'), 'utf8') },
    'DirectLiquidation.sol': { content: DIRECT },
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const errs = (compiled.errors || []).filter((e) => e.severity === 'error');
if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));

const vKey = Object.keys(compiled.contracts['PlonkVerifier.sol']).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k));
if (!/plonk/i.test(vKey)) throw new Error(`PlonkVerifier.sol holds ${vKey}, which is not a Plonk verifier`);
const V = compiled.contracts['PlonkVerifier.sol'][vKey];
const D = compiled.contracts['DirectLiquidation.sol'].DirectLiquidation;

// A FRESH EVM PER MEASUREMENT. EIP-2929 charges 2,600 for a cold account and 100 for a warm one, and
// `EVM.runCall` does not reset the access set between calls, so the second contract measured in one
// instance is 7,500 gas cheaper for free. `probe-plonk-gas-variance.mjs` measures that trap directly.
const caller = hexToBytes('1000000000000000000000000000000000000001');
async function freshCall(bytecode, calldata, ctorArgs = '') {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(bytecode + ctorArgs), gasLimit: 30_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy: ${dep.execResult.exceptionError}`);
  const res = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data: calldata, gasLimit: 30_000_000n });
  return { res, gas: res.execResult.executionGasUsed, ret: bytesToHex(res.execResult.returnValue) };
}
const pad = (v) => (BigInt(v) < 0n ? (BigInt(v) + (1n << 256n)) : BigInt(v)).toString(16).padStart(64, '0');
const selDirect = bytesToHex(keccak256(utf8ToBytes('check(uint256,uint256,uint256,int256,uint256,uint256)'))).slice(0, 8);
const directCalldata = (sig) => hexToBytes(selDirect + [sig.mHat, sig.qHat, sig.p0Hat, sig.s, sig.mmrHat, sig.pLiqHat].map(pad).join(''));

// ---- 4. the SNARK side ---------------------------------------------------------------------------
const raw = await sj.plonk.exportSolidityCallData(proof, publicSignals);
const [proofWords, sigWords] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
const selVerify = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${sigWords.length}])`))).slice(0, 8);
const verifyCalldata = (words, sigs) => hexToBytes(selVerify + words.map(pad).join('') + sigs.map(pad).join(''));

const snarkAccept = await freshCall(V.evm.bytecode.object, verifyCalldata(proofWords, sigWords));
const snarkTrue = /1$/.test(snarkAccept.ret);
// The refusal the paper's registry records: the certified price moved a single grid step, one part in 1e9.
const bentSigs = [...sigWords];
bentSigs[7] = (BigInt(bentSigs[7]) + 1n).toString();
const snarkRefuse = await freshCall(V.evm.bytecode.object, verifyCalldata(proofWords, bentSigs));

// ---- 5. the direct side, over the identical integers ---------------------------------------------
const honest = { mHat: w.mHat, qHat: w.qHat, p0Hat: w.p0Hat, s: w.s, mmrHat: w.mmrHat, pLiqHat: w.pLiqHat };
const directAccept = await freshCall(D.evm.bytecode.object, directCalldata(honest));
const directTrue = /1$/.test(directAccept.ret);
const stepped = { ...honest, pLiqHat: (BigInt(honest.pLiqHat) + 1n).toString() };
const directStep = await freshCall(D.evm.bytecode.object, directCalldata(stepped));
const directStepFalse = /0$/.test(directStep.ret);
// And the three guards that are the reason this is not just one multiply: a side that is neither +1
// nor -1, a maintenance rate that is not a proper fraction, and a zero size.
const guards = [];
for (const [name, mut] of [
  ['side 0', { ...honest, s: '0' }],
  ['mmr >= 1', { ...honest, mmrHat: String(SCALE) }],
  ['size 0', { ...honest, qHat: '0' }],
]) {
  const r = await freshCall(D.evm.bytecode.object, directCalldata(mut));
  guards.push({ name, refused: /0$/.test(r.ret), gas: Number(r.gas) });
}

// ---- 5b. and the error bar on the left-hand column -----------------------------------------------
// A single verify-gas sample is not a property of the statement, it is a property of the PROOF: Plonk
// proving is randomised. Publishing 274,317 beside 2,050 invites a reader to take the first figure at
// six significant figures, so the spread is measured here rather than borrowed from a comment. Twelve
// more proofs of the SAME witness, each verified in a fresh EVM.
const SAMPLES = 12;
const spreadGas = [Number(snarkAccept.gas)];
for (let i = 1; i < SAMPLES; i++) {
  const p = await sj.plonk.prove(zkey, await builder.calculateWTNSBin(w, 0));
  const r2 = await sj.plonk.exportSolidityCallData(p.proof, p.publicSignals);
  const [pw, sw] = JSON.parse(`[${r2.replace(/\]\s*\[/g, '],[')}]`);
  const call = await freshCall(V.evm.bytecode.object, verifyCalldata(pw, sw));
  if (!/1$/.test(call.ret)) throw new Error(`sample ${i} did not verify — the spread would be measuring a rejection`);
  spreadGas.push(Number(call.gas));
}
spreadGas.sort((a, b) => a - b);
const spread = {
  samples: SAMPLES,
  min: spreadGas[0],
  median: spreadGas[Math.floor(SAMPLES / 2)],
  max: spreadGas[SAMPLES - 1],
  mean: Number((spreadGas.reduce((a, b) => a + b, 0) / SAMPLES).toFixed(1)),
  gas: spreadGas[SAMPLES - 1] - spreadGas[0],
};
spread.pct = Number((spread.gas / spread.mean * 100).toFixed(2));
// The direct check is deterministic: identical calldata, identical control flow, no precompiles. Shown
// rather than asserted, because "deterministic" is the kind of word that turns out to be false.
const directAgain = await freshCall(D.evm.bytecode.object, directCalldata(honest));
const directDeterministic = Number(directAgain.gas) === Number(directAccept.gas);

// ---- 6. report ----------------------------------------------------------------------------------
const ratio = Number(snarkAccept.gas) / Number(directAccept.gas);
console.log(`\n  ${'what'.padEnd(38)}${'accept gas'.padStart(12)}${'deployed bytes'.padStart(16)}`);
console.log(`  ${'Plonk pairing check (PlonkVerifier)'.padEnd(38)}${String(snarkAccept.gas).padStart(12)}${String(V.evm.deployedBytecode.object.length / 2).padStart(16)}`);
console.log(`  ${'the same predicate, in Solidity'.padEnd(38)}${String(directAccept.gas).padStart(12)}${String(D.evm.deployedBytecode.object.length / 2).padStart(16)}`);
console.log(`\n  ${'the verify sample\'s own spread, 12 proofs'.padEnd(38)}${String(spread.gas).padStart(12)}${`${spread.pct}%`.padStart(16)}`);
console.log(`  ${'the direct check, twice'.padEnd(38)}${(directDeterministic ? 'identical' : 'MOVED').padStart(12)}`);
console.log(`\n  the proof costs ${ratio.toFixed(1)}x the direct check, over identical public inputs`);
console.log(`  both accept the honest answer: snark ${snarkTrue} · direct ${directTrue}`);
console.log(`  both refuse one grid step on pLiqHat: snark ${!/1$/.test(snarkRefuse.ret)} · direct ${directStepFalse}`);
for (const g of guards) console.log(`  direct refuses ${g.name.padEnd(10)} ${g.refused} (${g.gas} gas)`);

const ok = directDeterministic && snarkTrue && directTrue && !/1$/.test(snarkRefuse.ret) && directStepFalse && guards.every((g) => g.refused);
const artifact = {
  at: new Date().toISOString(),
  passed: ok,
  position: POSITION,
  servedLiquidationPrice: out.liquidationPrice,
  publicSignals: sigWords.length,
  privateInputs: 0,
  proveMs,
  snark: {
    verifier: vKey,
    // WHICH OF THE TWELVE THIS IS, said out loud.
    //
    // `acceptGas` is the FIRST sample, and the first sample is also the minimum of the twelve below.
    // Every document that quotes a Plonk gas figure quotes this field, and the headline ratio against the
    // direct Solidity check is built from it: 273,693 / 2,050 = 133.51x, where the same ratio on the
    // median is 133.87x. That is 0.27% in our own favour, which is small, one-directional, and was
    // nowhere stated at the point of use. The number is kept — it is a real measurement of a real call —
    // but it is now labelled, and the median is published beside it so a reader can pick.
    acceptGas: Number(snarkAccept.gas),
    acceptGasEstimator: 'first sample, which is also the minimum of the spread below — see acceptGasMedian',
    acceptGasMedian: spread.median,
    acceptGasMax: spread.max,
    refuseGasOneGridStep: Number(snarkRefuse.gas),
    deployedBytes: V.evm.deployedBytecode.object.length / 2,
    acceptedHonest: snarkTrue,
    refusedOneGridStep: !/1$/.test(snarkRefuse.ret),
  },
  direct: {
    acceptGas: Number(directAccept.gas),
    refuseGasOneGridStep: Number(directStep.gas),
    deployedBytes: D.evm.deployedBytecode.object.length / 2,
    acceptedHonest: directTrue,
    refusedOneGridStep: directStepFalse,
    deterministicAcrossTwoRuns: directDeterministic,
    guards,
  },
  spread,
  ratio,
  solc: solc.version(),
  note: 'Both figures are one sample each, in a fresh EVM. probe-plonk-gas-variance.mjs measures the run-to-run spread of a Plonk verify over proofs of an identical statement; a difference smaller than that spread is noise. The direct check is deterministic — same calldata, same gas — because it touches no precompile and its control flow does not depend on proof scalars.',
};
writeFileSync(path.join(BUILD, 'probe-direct-vs-snark-gas.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  artifact zk/build/probe-direct-vs-snark-gas.json`);
console.log(ok ? '\nPROBE: both checkers accept the honest answer and refuse a single grid step.' : '\nPROBE FAILED — a checker did not behave, so neither gas figure means anything.');
await shutdown();
process.exit(ok ? 0 : 1);
