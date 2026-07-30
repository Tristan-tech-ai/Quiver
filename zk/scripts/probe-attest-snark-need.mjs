// What would a SNARK add to risk-attest? Measured, before anything is built.
//
// WHY THIS EXISTS. risk-attest is deterministic and serves no proof, so it reads like the next circuit
// to wire. The brief for that work named the statement worth proving: an inclusion proof shows a leaf is
// IN the tree and can never show that nothing was left OUT, so "the root was built over exactly the
// claimed set" is the property a caller supposedly cannot check alone. If that were true it would be a
// good circuit. This probe tests whether it is true of the response risk-attest actually publishes,
// and prices the alternative, rather than assuming the gap and building for it.
//
// THE STRUCTURAL FACT THAT DECIDES IT. `attestations` carries EVERY leaf — the full contentHash list,
// in index order. So a party holding one response holds the whole leaf set, and set-exactness is a
// recomputation: 2N-1 sha256 calls land on the root or they do not. Nothing is hidden, so there is no
// succinctness to buy and no privacy to buy. The two things a SNARK sells are both already spent.
//
// WHAT IS MEASURED HERE.
//   1. the direct set-exactness check on chain, in a real EVM, at N = 2..1024 — execution gas AND the
//      EIP-2028 calldata gas, because 32 bytes per leaf is the term that would make a small-N answer
//      generalise wrongly;
//   2. one inclusion proof on chain, the recipe the service publishes verbatim;
//   3. a Plonk pairing check in a FRESH EVM over a real proof, with its own 12-sample spread, so the
//      comparison has an error bar instead of six false significant figures;
//   4. the crossover N at which the direct check would finally cost more than the pairing check.
//
// The comparison is only honest if the direct checker can FAIL, so every case below is run against a
// tampered batch too, and the probe exits non-zero if a tamper is accepted.
//
// Run: node zk/scripts/probe-attest-snark-need.mjs      (writes zk/build/probe-attest-snark-need.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BUILD, snarkjs, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const require = createRequire(import.meta.url);
const { riskAttest } = await load(import.meta.url, 'engine/riskAttest.js');

console.log(`PROBE — what a SNARK would add to risk-attest — ${new Date().toISOString()}\n`);

// ---- 0. the service's own answers, from the real engine -------------------------------------------
const h = (s) => createHash('sha256').update(s).digest('hex');
const batch = (n, tag = 'x') => Array.from({ length: n }, (_, i) => h(tag + i));

// ---- 1. the on-chain checkers --------------------------------------------------------------------
// Neither contract is a summary. `inclusion` is the Solidity the service prints in its own `verify`
// field, character for character in structure; `setExact` is the same two hash functions run over the
// published leaf list, which is the statement the circuit was supposed to be for.
const ATTEST = `
// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.0 <0.9.0;
contract AttestCheck {
    // The published recipe: leaf = sha256(0x00 || L), node = sha256(0x01 || min || max).
    function inclusion(bytes32 leaf, bytes32[] calldata p, bytes32 root) external view returns (bool) {
        bytes32 hh = sha256(abi.encodePacked(bytes1(0x00), leaf));
        for (uint256 i; i < p.length; ++i) {
            hh = hh <= p[i] ? sha256(abi.encodePacked(bytes1(0x01), hh, p[i]))
                            : sha256(abi.encodePacked(bytes1(0x01), p[i], hh));
        }
        return hh == root;
    }
    // SET-EXACTNESS. Rebuild the root over exactly the leaves supplied, pair-adjacent with the odd one
    // promoted, and compare. True iff root is the root of THIS list and nothing else -- which is both
    // "no item was dropped" and "no item was hidden", the two halves an inclusion proof cannot reach.
    function setExact(bytes32[] calldata leaves, bytes32 root) external view returns (bool) {
        uint256 n = leaves.length;
        if (n == 0) return false;
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i; i < n; ++i) layer[i] = sha256(abi.encodePacked(bytes1(0x00), leaves[i]));
        while (n > 1) {
            uint256 w;
            for (uint256 i; i < n; i += 2) {
                if (i + 1 < n) {
                    bytes32 a = layer[i]; bytes32 b = layer[i + 1];
                    layer[w] = a <= b ? sha256(abi.encodePacked(bytes1(0x01), a, b))
                                      : sha256(abi.encodePacked(bytes1(0x01), b, a));
                } else {
                    layer[w] = layer[i];
                }
                ++w;
            }
            n = w;
        }
        return layer[0] == root;
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
    'AttestCheck.sol': { content: ATTEST },
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const cerrs = (compiled.errors || []).filter((e) => e.severity === 'error');
if (cerrs.length) throw new Error(cerrs.map((e) => e.formattedMessage).join('\n'));
const vKey = Object.keys(compiled.contracts['PlonkVerifier.sol']).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k));
if (!/plonk/i.test(vKey)) throw new Error(`PlonkVerifier.sol holds ${vKey}, which is not a Plonk verifier`);
const V = compiled.contracts['PlonkVerifier.sol'][vKey];
const A = compiled.contracts['AttestCheck.sol'].AttestCheck;

// A FRESH EVM PER MEASUREMENT. EIP-2929 charges 2,600 for a cold account and 100 warm, and runCall does
// not reset the access set, so a second measurement in one instance is thousands of gas cheaper for free.
// The sha256 precompile is an account too, so this matters more here than for a pure-arithmetic checker.
const caller = hexToBytes('1000000000000000000000000000000000000001');
async function freshCall(bytecode, calldata) {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(bytecode), gasLimit: 300_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy: ${dep.execResult.exceptionError}`);
  const res = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data: calldata, gasLimit: 300_000_000n });
  if (res.execResult.exceptionError) throw new Error(`call: ${res.execResult.exceptionError}`);
  return { gas: Number(res.execResult.executionGasUsed), ret: bytesToHex(res.execResult.returnValue) };
}
// EIP-2028 intrinsic calldata gas: 16 per non-zero byte, 4 per zero byte. NOT included in
// executionGasUsed, and at 32 bytes a leaf it is the term that decides the large-N answer. Leaving it
// out would have flattered the direct check by hundreds of thousands of gas at N=1024.
const calldataGas = (bytes) => { let g = 0; for (const b of bytes) g += b === 0 ? 4 : 16; return g; };

const word = (hex) => BigInt('0x' + hex.replace(/^0x/, '')).toString(16).padStart(64, '0');
const selInc = bytesToHex(keccak256(utf8ToBytes('inclusion(bytes32,bytes32[],bytes32)'))).slice(0, 8);
const selSet = bytesToHex(keccak256(utf8ToBytes('setExact(bytes32[],bytes32)'))).slice(0, 8);
const num = (n) => BigInt(n).toString(16).padStart(64, '0');
// inclusion(bytes32 leaf, bytes32[] p, bytes32 root): head is leaf, offset-to-array, root; then array.
const incCalldata = (leaf, proof, root) => hexToBytes(selInc + word(leaf) + num(0x60) + word(root) + num(proof.length) + proof.map(word).join(''));
// setExact(bytes32[] leaves, bytes32 root): head is offset-to-array, root; then array.
const setCalldata = (leaves, root) => hexToBytes(selSet + num(0x40) + word(root) + num(leaves.length) + leaves.map(word).join(''));

// ---- 2. the direct checks, and the tampers that must be refused ----------------------------------
const rows = [];
const SIZES = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
let tamperFailures = 0;
for (const N of SIZES) {
  const leaves = batch(N);
  const r = riskAttest({ contentHashes: leaves });
  if (!r.ok) throw new Error(`engine refused N=${N}: ${r.errors}`);
  const published = r.attestations.slice().sort((a, b) => a.index - b.index).map((a) => a.contentHash);
  if (published.length !== N) throw new Error(`N=${N}: the response did not publish every leaf`);

  const setCd = setCalldata(published, r.merkleRoot);
  const setRes = await freshCall(A.evm.bytecode.object, setCd);
  if (!/1$/.test(setRes.ret)) throw new Error(`N=${N}: the honest set-exactness check REFUSED the engine's own root`);

  // TAMPER 1 — one leaf dropped from the root, still listed in the response (the brief's case).
  const shortRoot = riskAttest({ contentHashes: leaves.slice(0, N - 1) }).merkleRoot;
  const t1 = await freshCall(A.evm.bytecode.object, setCalldata(published, shortRoot));
  // TAMPER 2 — the root covers a leaf the list does not mention (a hidden extra item).
  const longRoot = riskAttest({ contentHashes: [...leaves, h('HIDDEN')] }).merkleRoot;
  const t2 = await freshCall(A.evm.bytecode.object, setCalldata(published, longRoot));
  // TAMPER 3 — one listed leaf substituted, root untouched.
  const sub = published.slice(); sub[N - 1] = '0x' + h('SUBSTITUTED');
  const t3 = await freshCall(A.evm.bytecode.object, setCalldata(sub, r.merkleRoot));
  const refusedAll = /0$/.test(t1.ret) && /0$/.test(t2.ret) && /0$/.test(t3.ret);
  if (!refusedAll) { tamperFailures++; console.log(`  N=${N} A TAMPER WAS ACCEPTED — this checker proves nothing`); }

  // one inclusion proof, deepest path in the batch, for the other column
  const deepest = r.attestations.reduce((a, b) => (b.proof.length > a.proof.length ? b : a));
  const incCd = incCalldata(deepest.contentHash, deepest.proof, r.merkleRoot);
  const incRes = await freshCall(A.evm.bytecode.object, incCd);
  if (!/1$/.test(incRes.ret)) throw new Error(`N=${N}: an honest inclusion proof was refused`);
  // and a bent one: flip the last bit of the first sibling.
  const bent = deepest.proof.slice();
  bent[0] = '0x' + (BigInt(bent[0]) ^ 1n).toString(16).padStart(64, '0');
  const incBent = await freshCall(A.evm.bytecode.object, incCalldata(deepest.contentHash, bent, r.merkleRoot));
  if (/1$/.test(incBent.ret)) { tamperFailures++; console.log(`  N=${N} A BENT INCLUSION PROOF WAS ACCEPTED`); }

  rows.push({
    n: N,
    setExact: { execGas: setRes.gas, calldataGas: calldataGas(setCd), totalGas: setRes.gas + calldataGas(setCd), calldataBytes: setCd.length, refusedDrop: /0$/.test(t1.ret), refusedHidden: /0$/.test(t2.ret), refusedSubstitution: /0$/.test(t3.ret) },
    inclusion: { pathLength: deepest.proof.length, execGas: incRes.gas, calldataGas: calldataGas(incCd), totalGas: incRes.gas + calldataGas(incCd), refusedBentSibling: !/1$/.test(incBent.ret) },
  });
  console.log(`  N=${String(N).padStart(4)}  setExact ${String(rows.at(-1).setExact.totalGas).padStart(9)} gas total (${String(setRes.gas).padStart(9)} exec + ${String(calldataGas(setCd)).padStart(7)} calldata)   1 inclusion ${String(rows.at(-1).inclusion.totalGas).padStart(6)} gas, path ${deepest.proof.length}   tampers refused ${refusedAll}`);
}

// ---- 3. the pairing check, measured here rather than quoted ---------------------------------------
// Any figure for Plonk verify gas is a property of the PROOF, not of the statement: proving is
// randomised. So it is sampled 12 times over proofs of one identical witness, each in a fresh EVM, and
// the spread is published beside the median. A gap smaller than that spread is not a gap.
const sj = await snarkjs();
const { perpGate } = await load(import.meta.url, 'engine/perpGate.js');
const { witnessFor } = await load(import.meta.url, 'util/snark.js');
const POSITION = { side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005 };
const out = perpGate(POSITION);
const built = witnessFor(POSITION, out.liquidationPrice);
if (!built) throw new Error('the service refused to build a witness for its own answer');
const zkey = path.join(BUILD, 'liquidation_plonk.zkey');
const wasm = path.join(BUILD, 'liquidation_js', 'liquidation.wasm');
const builder = await require(path.join(BUILD, 'liquidation_js', 'witness_calculator.cjs'))(readFileSync(wasm));
const vk = JSON.parse(readFileSync(path.join(BUILD, 'vk_plonk.json'), 'utf8'));

const SAMPLES = 12;
const plonkTotals = [];
let plonkExec0 = null, plonkCd0 = null, plonkSigs = null;
for (let i = 0; i < SAMPLES; i++) {
  const wtns = await builder.calculateWTNSBin(built.witness, 0);
  const { proof, publicSignals } = await sj.plonk.prove(zkey, wtns);
  if (!(await sj.plonk.verify(vk, publicSignals, proof))) throw new Error(`sample ${i} does not verify off chain`);
  const raw = await sj.plonk.exportSolidityCallData(proof, publicSignals);
  const [pw, sw] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  const sel = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${sw.length}])`))).slice(0, 8);
  const cd = hexToBytes(sel + [...pw, ...sw].map((v) => BigInt(v).toString(16).padStart(64, '0')).join(''));
  const res = await freshCall(V.evm.bytecode.object, cd);
  if (!/1$/.test(res.ret)) throw new Error(`sample ${i} did not verify on chain — the spread would be measuring a rejection`);
  plonkTotals.push(res.gas + calldataGas(cd));
  if (i === 0) { plonkExec0 = res.gas; plonkCd0 = calldataGas(cd); plonkSigs = sw.length; }
}
plonkTotals.sort((a, b) => a - b);
const pMed = plonkTotals[Math.floor(SAMPLES / 2)];
const pMean = plonkTotals.reduce((a, b) => a + b, 0) / SAMPLES;
const plonk = {
  verifier: vKey, publicSignals: plonkSigs, samples: SAMPLES,
  execGasFirstSample: plonkExec0, calldataGas: plonkCd0,
  totalGasMin: plonkTotals[0], totalGasMedian: pMed, totalGasMax: plonkTotals.at(-1),
  totalGasMean: Number(pMean.toFixed(1)),
  spreadGas: plonkTotals.at(-1) - plonkTotals[0],
  spreadPct: Number(((plonkTotals.at(-1) - plonkTotals[0]) / pMean * 100).toFixed(2)),
  deployedBytes: V.evm.deployedBytecode.object.length / 2,
};
console.log(`\n  Plonk verify, ${SAMPLES} proofs of one identical witness, fresh EVM each:`);
console.log(`    total gas  min ${plonk.totalGasMin}  median ${plonk.totalGasMedian}  max ${plonk.totalGasMax}   spread ${plonk.spreadGas} (${plonk.spreadPct}%)`);
console.log(`    of which calldata ${plonk.calldataGas} (24 proof words + ${plonkSigs} public signals)`);

// ---- 4. the crossover ----------------------------------------------------------------------------
// Fit is not needed: the direct check is measured at each N, so read the crossover off the measurements
// and, beyond the last one, extrapolate from the measured per-leaf marginal instead of a formula.
const marg = [];
for (let i = 1; i < rows.length; i++) marg.push((rows[i].setExact.totalGas - rows[i - 1].setExact.totalGas) / (rows[i].n - rows[i - 1].n));
const perLeaf = marg.at(-1);
const crossedAt = rows.find((r) => r.setExact.totalGas > plonk.totalGasMedian);
const last = rows.at(-1);
const crossoverN = crossedAt ? crossedAt.n : Math.round(last.n + (plonk.totalGasMedian - last.setExact.totalGas) / perLeaf);
console.log(`\n  direct set-exactness marginal, last interval: ${perLeaf.toFixed(1)} gas per leaf`);
console.log(`  crossover: the direct check first costs more than the median pairing check at N ~ ${crossoverN}`);
console.log(`  ${crossedAt ? '(measured — inside the range above)' : `(extrapolated past N=${last.n} at the measured marginal)`}`);

const ok = tamperFailures === 0;
const artifact = {
  at: new Date().toISOString(),
  passed: ok,
  question: 'What does a zk proof add over the Merkle root and inclusion proofs risk-attest already publishes?',
  structuralFact: 'The response publishes every leaf: attestations[].contentHash is the complete leaf set in index order. A holder of one response can therefore recompute the root in 2N-1 sha256 calls, which decides set-exactness — no item dropped AND no item hidden — with no circuit, no trusted setup and no proving key.',
  directOnChain: rows,
  plonk,
  crossover: { n: crossoverN, measuredInRange: Boolean(crossedAt), perLeafMarginalGas: Number(perLeaf.toFixed(1)), basis: 'execution gas + EIP-2028 calldata gas on both sides, fresh EVM per measurement' },
  tamperFailures,
  solc: solc.version(),
  note: 'Plonk figures are a 12-sample distribution because proving is randomised; the direct figures are single samples because the direct checker touches no proof scalars. Both columns include EIP-2028 calldata gas, which executionGasUsed excludes and which dominates the direct check at large N.',
};
writeFileSync(path.join(BUILD, 'probe-attest-snark-need.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  artifact zk/build/probe-attest-snark-need.json`);
console.log(ok ? '\nPROBE: the direct checker accepted every honest root and refused every tamper, so both columns mean something.' : '\nPROBE FAILED — a tamper was accepted, so no gas figure here means anything.');
await shutdown();
process.exit(ok ? 0 : 1);
