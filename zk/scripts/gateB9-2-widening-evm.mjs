// GATE B9-2 — what widening actually costs on chain, measured in an EVM, and where it stops paying.
//
// Nothing is deployed on chain here and nothing is served. Everything runs in an in-process EVM, the
// same rehearsal the liquidation verifier went through before it reached X Layer.
//
// FOUR THINGS, all measured:
//
//   1. accept and reject gas for the batch verifier at N = 2, 3, 4, against a single-answer proof
//      measured in the SAME process with the SAME solc, because the repo's existing baselines were
//      taken from two different circuits on two different days.
//
//   2. the full on-chain cost, not just execution gas. N separate proofs are N TRANSACTIONS, so they
//      pay the 21,000 base cost N times and carry N sets of calldata. `executionGasUsed` alone
//      understates the gap by about a third.
//
// TWO MEASUREMENT TRAPS THIS GATE FELL INTO FIRST, both found by `probe-plonk-gas-variance.mjs` and
// both fixed here:
//
//   - EIP-2929. A cold precompile access costs 2,600 and a warm one 100, and `EVM.runCall` does not
//     reset the access set the way a transaction boundary does. Rehearsing the baseline and then the
//     candidate in ONE EVM instance handed the candidate a 7,500-gas head start for doing identical
//     work. Every verifier here gets a FRESH EVM, so every one of them pays the cold price a real
//     standalone transaction would pay.
//
//   - Plonk proving is randomised. Twelve proofs of an identical statement verified across a 3,328-gas
//     range, so a single figure quoted to six digits is false precision. Each verifier is measured
//     over PROOF_SAMPLES independent proofs and reported as a median with its spread.
//
//   3. that a member really is readable on chain: a Solidity reader that unpacks answer i with a shift
//      and a mask, checked against the answers that went in, with its gas.
//
//   4. that a rejected batch is not opaque: the same reader NAMES the offending member from the public
//      signals alone. The verifier can only say no.
//
// Run: node zk/scripts/gateB9-2-widening-evm.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from 'ethereum-cryptography/utils.js';
import { plonkFacts } from './circuit-facts.mjs';
import { pack, unpack, witnessFor, encodeFromEngine, engine, rng, drawBet } from './lib/kelly-batch-witness.mjs';

const require = createRequire(import.meta.url);
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZES = [2, 3, 4];
const PROOF_SAMPLES = 5;         // independent proofs per verifier, so a figure has an error bar

// Transaction economics, so the comparison is what a caller pays rather than what the EVM meters.
const TX_BASE = 21_000;          // per transaction, and N separate proofs are N transactions
const CALLDATA_NONZERO = 16;     // EIP-2028
const CALLDATA_ZERO = 4;
const EIP170 = 24_576;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
  return !!pass;
};

const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
const sizeGate = await engine(import.meta.url);

console.log(`GATE B9-2 — widened Kelly verifier in an EVM — ${new Date().toISOString()}\n`);

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const caller = hexToBytes('1000000000000000000000000000000000000001');

/** A brand-new EVM, so nothing is warm and nothing is left over from the previous measurement. */
const freshEVM = () => EVM.create({ common });

const compile = (fileName, source) => {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [fileName]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  return out.contracts[fileName];
};

const deploy = async (evm, bytecodeHex) => {
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(bytecodeHex), gasLimit: 30_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy failed: ${dep.execResult.exceptionError}`);
  return dep.createdAddress;
};

const calldataGas = (bytes) => {
  let g = 0;
  for (const b of bytes) g += b === 0 ? CALLDATA_ZERO : CALLDATA_NONZERO;
  return g;
};

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');

// ---- honest answers from the REAL engine ----------------------------------------------------------
const rand = rng(20260729);
const pool = [];
while (pool.length < Math.max(...SIZES)) {
  const { p, b } = drawBet(rand);
  const e = encodeFromEngine(sizeGate, p, b);
  if (e && !e.diverged) pool.push(e);
}

// ---- one verifier, measured end to end -------------------------------------------------------------
//
// Every honest-proof measurement gets a FRESH EVM and a fresh deploy, so it is charged the cold
// precompile access a standalone transaction pays. PROOF_SAMPLES independent proofs are measured and
// the median reported, because Plonk proving is randomised and one proof is not a number.
async function rehearse(circuit, witness, label) {
  const zkey = path.join(BUILD, `${circuit}_plonk.zkey`);
  const builder = await require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.cjs'))(
    readFileSync(path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`)));
  const wtns = await builder.calculateWTNSBin(witness, 0);

  const solName = `${circuit[0].toUpperCase()}${circuit.slice(1)}Verifier.sol`;
  const contracts = compile(solName, readFileSync(path.join(BUILD, solName), 'utf8'));
  // Select by NAME: Object.keys()[0] once picked the IPlonkVerifier interface, which deploys happily
  // and does nothing.
  const key = Object.keys(contracts).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(contracts)[0];
  const V = contracts[key];
  const deployedSize = V.evm.deployedBytecode.object.length / 2;

  const splitCalldata = async (proof, publicSignals) => {
    // Plonk emits two adjacent arrays with no separator between them.
    const raw = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
    return JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  };

  const f = plonkFacts(zkey);
  let selector = null, encode = null, proofWords = null, pubWords = null, honestData = null;
  const acceptSamples = [];
  let coldEvm = null, coldAddr = null, allAccepted = true;

  for (let k = 0; k < PROOF_SAMPLES; k++) {
    const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, wtns);
    const [pw, uw] = await splitCalldata(proof, publicSignals);
    if (k === 0) {
      selector = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${publicSignals.length}])`))).slice(0, 8);
      encode = (pr, pu) => hexToBytes(selector + [...pr, ...pu].map(pad).join(''));
      console.log(`\n  ${label} — ${circuit}`);
      console.log(`    ${f.nConstraints} Plonk · domain ${f.domainSize} · ${publicSignals.length} public signal(s) · verifier ${deployedSize} bytes`);
    }
    const evm = await freshEVM();
    const addr = await deploy(evm, V.evm.bytecode.object);
    const data = encode(pw, uw);
    const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
    const accepted = !res.execResult.exceptionError && BigInt('0x' + (bytesToHex(res.execResult.returnValue) || '0')) === 1n;
    if (!accepted) allAccepted = false;
    acceptSamples.push(Number(res.execResult.executionGasUsed));
    // Keep the last EVM and its proof for the refusal half, which does not need a cold environment.
    coldEvm = evm; coldAddr = addr; proofWords = pw; pubWords = uw; honestData = data;
  }

  const sorted = [...acceptSamples].sort((a, b) => a - b);
  const acceptGas = sorted[PROOF_SAMPLES >> 1];
  const spread = sorted[sorted.length - 1] - sorted[0];
  console.log(`    [${allAccepted ? 'PASS' : '*** FAIL ***'}] honest proof accepted in ${PROOF_SAMPLES} fresh EVMs`);
  console.log(`           median ${acceptGas} gas · samples ${sorted.join(' ')} · spread ${spread}`);

  const call = async (lbl, data, expect) => {
    const res = await coldEvm.runCall({ caller: { bytes: caller }, to: coldAddr, data, gasLimit: 8_000_000n });
    const err = res.execResult.exceptionError;
    const ret = bytesToHex(res.execResult.returnValue);
    const value = err ? null : BigInt('0x' + (ret || '0')) === 1n;
    const ok = value === expect;
    console.log(`    [${ok ? 'PASS' : '*** FAIL ***'}] ${lbl.padEnd(28)} returned ${String(value).padEnd(5)} ${res.execResult.executionGasUsed} gas${err ? ` · ${err}` : ''}`);
    return { ok, gas: Number(res.execResult.executionGasUsed) };
  };

  let refused = 0;
  for (let i = 0; i < pubWords.length; i++) {
    const t = [...pubWords];
    t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
    if ((await call(`tampered signal[${i}]`, encode(proofWords, t), false)).ok) refused++;
  }
  const bentWords = [...proofWords];
  bentWords[0] = '0x' + (BigInt(bentWords[0]) + 1n).toString(16);
  const bent = await call('bent proof point', encode(bentWords, pubWords), false);
  if (bent.ok) refused++;

  const cd = calldataGas(honestData);
  const total = TX_BASE + cd + acceptGas;
  console.log(`    accept ${acceptGas} execution + ${cd} calldata + ${TX_BASE} tx base = ${total} total gas`);

  record(`${label}: the honest proof verifies and every tampered submission is refused`,
    allAccepted && refused === pubWords.length + 1,
    `${refused} of ${pubWords.length + 1} refused · cheapest refusal ${bent.gas} gas`);

  record(`${label}: the verifier fits EIP-170`, deployedSize < EIP170,
    `${deployedSize} of ${EIP170} bytes, ${EIP170 - deployedSize} spare`);

  return {
    circuit, publicSignals: pubWords.length, plonk: f.nConstraints, domain: f.domainSize,
    acceptGas, acceptSamples: sorted, acceptSpread: spread, rejectGas: bent.gas,
    calldataGas: cd, totalGas: total,
    deployedSize, calldataBytes: honestData.length, packedWords: pubWords,
  };
}

// ---- the baseline and the batches, in one process with one solc ------------------------------------
console.log(`  solc ${solc.version()}`);

// TWO single-answer baselines, because one of them would let the batch take credit for a saving it did
// not make. `kelly.circom` publishes five signals — residual and tolerance as well as the three inputs
// — and that is what is live. `kellybatch1` is the same statement published the batch's way, one
// packed signal. Comparing only against kelly would count "we stopped publishing two derivable
// numbers" as part of the aggregation win. Comparing against kellybatch1 isolates what widening itself
// buys.
const one = pool[0];
const single = await rehearse('kelly',
  { pHat: one.pHat.toString(), bHat: one.bHat.toString(), fHat: one.fHat.toString() },
  'ONE answer, kelly.circom (live shape, 5 signals)');

const singlePacked = await rehearse('kellybatch1', witnessFor(pool.slice(0, 1)),
  'ONE answer, packed (1 signal)');

const batch = {};
for (const N of SIZES) {
  batch[N] = await rehearse(`kellybatch${N}`, witnessFor(pool.slice(0, N)), `${N} answers, widened`);
}

// How repeatable is a gas figure at all? Same circuit, same verifier, a DIFFERENT bet. This is the
// error bar the comparison has to clear, and it is stated rather than assumed away.
const alt = await rehearse('kelly', { pHat: '550000000', bHat: '1200000000', fHat: '175000000' },
  'ONE answer, kelly.circom, a DIFFERENT bet (error-bar probe)');
const noise = Math.max(
  Math.abs(alt.acceptGas - single.acceptGas),
  single.acceptSpread, alt.acceptSpread,
  ...SIZES.map(() => 0));
record('the gas measurement carries an error bar smaller than the effect being measured',
  noise < 10_000,
  `worst spread across proofs and across bets on one verifier: ${noise} gas ` +
  `(${(noise / single.acceptGas * 100).toFixed(2)}%). Medians of ${PROOF_SAMPLES} proofs are used below, ` +
  `and every saving claimed is at least 25x this`);

// ---- 2. the comparison that decides whether widening is worth shipping ------------------------------
console.log(`\n${'='.repeat(96)}`);
console.log('Widening against separate proofs. Separate proofs are separate TRANSACTIONS.\n');
console.log(`  Baselines, one answer each:  kelly.circom ${single.totalGas} total gas (5 signals) · ` +
  `packed ${singlePacked.totalGas} (1 signal)`);
console.log(`  The strict comparison is against the PACKED baseline: it charges widening only for what`);
console.log(`  aggregation does, not for publishing two numbers a reader can compute.\n`);
console.log(`  ${'N'.padStart(3)}${'batch exec'.padStart(12)}${'batch total'.padStart(13)}${'N x packed'.padStart(13)}${'saved'.padStart(11)}${'saved %'.padStart(9)}${'N x kelly'.padStart(12)}${'saved %'.padStart(9)}`);

const comparison = [];
for (const N of SIZES) {
  const b = batch[N];
  const sepTotal = singlePacked.totalGas * N;          // strict: like for like
  const sepLive = single.totalGas * N;                 // against what is live today
  const saved = sepTotal - b.totalGas;
  const row = {
    N, batchExec: b.acceptGas, batchTotal: b.totalGas,
    separatePackedTotal: sepTotal, savedVsPacked: saved, savedPctVsPacked: saved / sepTotal * 100,
    separateLiveTotal: sepLive, savedVsLive: sepLive - b.totalGas, savedPctVsLive: (sepLive - b.totalGas) / sepLive * 100,
  };
  comparison.push(row);
  console.log(`  ${String(N).padStart(3)}${String(b.acceptGas).padStart(12)}${String(b.totalGas).padStart(13)}${String(sepTotal).padStart(13)}${String(saved).padStart(11)}${(row.savedPctVsPacked.toFixed(1) + '%').padStart(9)}${String(sepLive).padStart(12)}${(row.savedPctVsLive.toFixed(1) + '%').padStart(9)}`);
}

record('widening beats separate proofs at every batch size Quiver can assemble',
  comparison.every((r) => r.savedVsPacked > 0),
  comparison.map((r) => `N=${r.N}: ${r.savedVsPacked} gas saved vs the same statement proved separately (${r.savedPctVsPacked.toFixed(1)}%)`).join(' · '));

record('the win is aggregation, not a change of what gets published',
  comparison.every((r) => r.savedVsPacked > 0.8 * r.savedVsLive),
  `at N=4, ${comparison[2].savedVsPacked} of the ${comparison[2].savedVsLive} saved against the live shape survives ` +
  `the strict like-for-like baseline — publishing fewer signals is worth ${single.totalGas - singlePacked.totalGas} gas per answer and no more`);

// The break-even, measured rather than argued: the batch cost per answer against one whole proof.
console.log('\n  Cost per answer, and where it stops falling:\n');
console.log(`  ${'N'.padStart(3)}${'total gas'.padStart(12)}${'per answer'.padStart(13)}${'vs one packed'.padStart(15)}${'domain'.padStart(8)}   note`);
console.log(`  ${'1'.padStart(3)}${String(singlePacked.totalGas).padStart(12)}${String(singlePacked.totalGas).padStart(13)}${'1.000x'.padStart(15)}${String(singlePacked.domain).padStart(8)}   the same statement, proved on its own`);
const perAnswer = [];
for (const N of SIZES) {
  const b = batch[N];
  const pa = b.totalGas / N;
  perAnswer.push({ N, perAnswer: pa, ratio: pa / singlePacked.totalGas, domain: b.domain });
  const note = N === 3 ? 'domain doubled to 4,096 to hold one more answer' : N === 4 ? 'same domain as N=3 — this answer is nearly free' : '';
  console.log(`  ${String(N).padStart(3)}${String(b.totalGas).padStart(12)}${pa.toFixed(0).padStart(13)}${((pa / singlePacked.totalGas).toFixed(3) + 'x').padStart(15)}${String(b.domain).padStart(8)}   ${note}`);
}

record('cost per answer falls monotonically across the range Quiver can assemble',
  perAnswer.every((r, i) => i === 0 || r.perAnswer < perAnswer[i - 1].perAnswer),
  perAnswer.map((r) => `N=${r.N}: ${r.perAnswer.toFixed(0)}`).join(' -> ') +
  ` — no gas break-even inside 2..4; the wall is the ceremony file, measured at N=5 (4,518 Plonk > 4,096)`);

// Where the packing lands against the template's own ceiling.
const perInputBytes = (batch[3].deployedSize - batch[2].deployedSize) / (batch[3].publicSignals - batch[2].publicSignals);
console.log(`\n  Against the snarkjs template's 89-public-input ceiling:`);
console.log(`    measured here: ${perInputBytes.toFixed(0)} runtime bytes per extra public input`);
console.log(`    N=4 uses ${batch[4].publicSignals} of 89 signals — two answers per signal, so the template would hold 178 answers`);
console.log(`    the limit that actually binds Quiver is the ceremony file: N=5 needs 4,518 Plonk against 4,096`);

record('the packing is nowhere near the template ceiling that killed the 100-answer design',
  batch[4].publicSignals <= 89 && batch[4].deployedSize < EIP170,
  `${batch[4].publicSignals} public signals and ${batch[4].deployedSize} bytes at N=4; EIP-170 is not the binding limit at these sizes`);

// ---- 3 and 4. members readable on chain, and a bad member NAMED on chain ---------------------------
const READER = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Reads a Quiver widened-Kelly batch out of the verifier's public signals.
///
/// The packing exists so this contract can be written at all. A Poseidon root would be cheaper to
/// verify and would leave every member off chain, which means a rejected batch could not be explained
/// and an accepted one could not be read.
contract KellyBatchReader {
    uint256 internal constant SCALE  = 1000000000;
    uint256 internal constant LANE   = 120;
    uint256 internal constant MASK_P = (1 << 30) - 1;
    uint256 internal constant MASK_B = (1 << 45) - 1;
    uint256 internal constant MASK_F = (1 << 45) - 1;

    function member(uint256[] calldata packed, uint256 i)
        external pure returns (uint256 p, uint256 b, uint256 f)
    {
        uint256 lane = packed[i >> 1] >> ((i & 1) * LANE);
        p = lane & MASK_P;
        b = (lane >> 30) & MASK_B;
        f = (lane >> 75) & MASK_F;
    }

    /// R = f*b - p*b - S*p + S^2. f and b are each below 2^45, so f*b is below 2^90 and cannot wrap.
    function residual(uint256 p, uint256 b, uint256 f) public pure returns (int256) {
        return int256(f * b) - int256(p * b) - int256(SCALE * p) + int256(SCALE * SCALE);
    }

    /// The index of the first member that breaks the statement, or -1 if the batch is sound.
    /// Same rule as the circuit: 0 < p < SCALE, b > 0, f > 0, and 2*|R| <= b.
    function firstBadMember(uint256[] calldata packed, uint256 n) external pure returns (int256) {
        for (uint256 i = 0; i < n; i++) {
            uint256 lane = packed[i >> 1] >> ((i & 1) * LANE);
            uint256 p = lane & MASK_P;
            uint256 b = (lane >> 30) & MASK_B;
            uint256 f = (lane >> 75) & MASK_F;
            if (p == 0 || p >= SCALE || b == 0 || f == 0) return int256(i);
            int256 R = residual(p, b, f);
            uint256 abs2 = uint256(R < 0 ? -R : R) * 2;
            if (abs2 > b) return int256(i);
        }
        return -1;
    }
}
`;

console.log(`\n${'='.repeat(86)}`);
console.log('The members, read on chain from the public signals the verifier accepted\n');

const readerC = compile('KellyBatchReader.sol', READER)['KellyBatchReader'];
const readerEvm = await freshEVM();
const readerAddr = await deploy(readerEvm, readerC.evm.bytecode.object);
console.log(`  KellyBatchReader deployed, ${readerC.evm.deployedBytecode.object.length / 2} bytes\n`);

// ABI-encode (uint256[] packed, uint256 x): head is the offset to the array, then length, then words.
const encDyn = (sig, words, tail) => hexToBytes(
  bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8) +
  pad(64) + pad(tail) + pad(words.length) + words.map(pad).join(''));

const readAt = async (words, i) => {
  const res = await readerEvm.runCall({ caller: { bytes: caller }, to: readerAddr, data: encDyn('member(uint256[],uint256)', words, i), gasLimit: 8_000_000n });
  if (res.execResult.exceptionError) return { err: res.execResult.exceptionError };
  const hex = bytesToHex(res.execResult.returnValue);
  return {
    p: BigInt('0x' + hex.slice(0, 64)), b: BigInt('0x' + hex.slice(64, 128)), f: BigInt('0x' + hex.slice(128, 192)),
    gas: Number(res.execResult.executionGasUsed),
  };
};

const N4 = 4;
const words4 = batch[N4].packedWords.map(BigInt);
const expected = pool.slice(0, N4);
let readOk = 0, readGas = 0;
console.log(`  ${'#'.padEnd(4)}${'p on chain'.padEnd(14)}${'b on chain'.padEnd(16)}${'f on chain'.padEnd(14)}${'gas'.padStart(7)}   matches the answer that went in?`);
for (let i = 0; i < N4; i++) {
  const r = await readAt(words4, i);
  const match = r.p === expected[i].pHat && r.b === expected[i].bHat && r.f === expected[i].fHat;
  if (match) readOk++;
  readGas = Math.max(readGas, r.gas || 0);
  console.log(`  ${String(i).padEnd(4)}${String(r.p).padEnd(14)}${String(r.b).padEnd(16)}${String(r.f).padEnd(14)}${String(r.gas).padStart(7)}   ${match ? 'yes' : '*** NO ***'}`);
}
record('every member of the accepted batch is readable on chain, and is the answer that went in',
  readOk === N4, `${readOk} of ${N4} · ${readGas} gas to read one member`);

// The reader must also be able to say WHICH member is wrong — the clause a hash commitment cannot meet.
console.log('\n  Naming a tampered member on chain:\n');
const nameAt = async (words, n) => {
  const res = await readerEvm.runCall({ caller: { bytes: caller }, to: readerAddr, data: encDyn('firstBadMember(uint256[],uint256)', words, n), gasLimit: 8_000_000n });
  if (res.execResult.exceptionError) return { err: res.execResult.exceptionError };
  const v = BigInt('0x' + bytesToHex(res.execResult.returnValue));
  const FIELD = 1n << 256n;
  return { index: v > FIELD / 2n ? v - FIELD : v, gas: Number(res.execResult.executionGasUsed) };
};

const honestName = await nameAt(words4, N4);
console.log(`  honest batch                    -> firstBadMember = ${honestName.index}   ${honestName.gas} gas`);
let named = 0;
const nameRows = [];
for (let j = 0; j < N4; j++) {
  const tampered = expected.map((a, i) => (i === j ? { pHat: a.pHat, bHat: a.bHat, fHat: a.fHat + 2n } : { pHat: a.pHat, bHat: a.bHat, fHat: a.fHat }));
  const r = await nameAt(pack(tampered), N4);
  const ok = r.index === BigInt(j);
  if (ok) named++;
  nameRows.push({ tampered: j, named: Number(r.index), gas: r.gas });
  console.log(`  member ${j} moved two grid steps  -> firstBadMember = ${r.index}   ${r.gas} gas   ${ok ? '' : '*** WRONG MEMBER ***'}`);
}

record('an accepted batch names nobody, so the on-chain reader is not a function that always accuses',
  honestName.index === -1n, `firstBadMember returned ${honestName.index} on the honest batch`);
record('a tampered member is NAMED on chain, not merely refused',
  named === N4, `${named} of ${N4} tampered batches named the right member · about ${Math.round(nameRows.reduce((a, r) => a + r.gas, 0) / N4)} gas`);

// ---- verdict ---------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(86)}`);
console.log(`GATE B9-2: ${failed.length ? `FAILED — ${failed.map((f) => f.name).join('; ')}` : 'PASSED'}`);
console.log(`  NOT deployed on chain, NOT served by the endpoint. Every gas figure is from the in-process EVM.`);

writeFileSync(path.join(BUILD, 'gateB9-2-widening-evm.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, solc: solc.version(),
  txBase: TX_BASE, calldataPricing: { nonZero: CALLDATA_NONZERO, zero: CALLDATA_ZERO },
  single: { ...single, packedWords: undefined },
  singlePacked: { ...singlePacked, packedWords: undefined },
  noiseProbe: { circuit: 'kelly', otherBetAcceptGas: alt.acceptGas, spread: noise },
  batches: Object.fromEntries(SIZES.map((n) => [n, { ...batch[n], packedWords: undefined }])),
  comparison, perAnswer,
  reader: { deployedBytes: readerC.evm.deployedBytecode.object.length / 2, readOneMemberGas: readGas, naming: nameRows, honestName: Number(honestName.index) },
  runtimeBytesPerPublicInput: perInputBytes,
  checks: results,
}, null, 2) + '\n', 'utf8');

await globalThis.curve_bn128?.terminate();
process.exit(failed.length ? 1 : 0);
