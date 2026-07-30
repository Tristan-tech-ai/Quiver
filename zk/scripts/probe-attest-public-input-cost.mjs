// The crossover measured in probe-attest-snark-need.mjs compares the direct check against a Plonk
// verify carrying EIGHT public signals. That is the wrong verify to compare against, and this probe
// measures the right one.
//
// WHY. A set-exactness statement is "root R is the root over exactly this list of leaves". The list has
// to be NAMED, or the statement is about an unspecified set and decides nothing. So the leaves are public
// inputs to any such circuit. A 32-byte contentHash does not fit one BN254 scalar (the field is about
// 2^254 and a contentHash is a full 2^256 range), so each leaf costs TWO public signals; the root costs
// two more. A Plonk verify is constant in circuit SIZE and linear in PUBLIC INPUTS, and that second term
// is the one the earlier crossover left out.
//
// WHAT IS MEASURED. Real proofs from two circuits already in this repo with very different public-signal
// counts — liquidation at 8 and portfoliogate at 28 — each sampled repeatedly in a FRESH EVM, so the
// per-signal marginal comes off a 20-signal span that is far wider than the ~1% sampling spread. Then
// the crossover is recomputed against a verify priced for 2N+2 signals.
//
// Run: node zk/scripts/probe-attest-public-input-cost.mjs   (writes zk/build/probe-attest-public-input-cost.json)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, snarkjs, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { makeBuilder } from './lib/portfolio-witness.mjs';

const require = createRequire(import.meta.url);
console.log(`PROBE — what a public input costs a Plonk verify — ${new Date().toISOString()}\n`);

const solc = (await import('solc')).default ?? (await import('solc'));
const { EVM } = await import('@ethereumjs/evm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
const { keccak256 } = await import('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('ethereum-cryptography/utils.js');
const caller = hexToBytes('1000000000000000000000000000000000000001');
async function freshCall(bytecode, calldata) {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(bytecode), gasLimit: 300_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy: ${dep.execResult.exceptionError}`);
  const res = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data: calldata, gasLimit: 300_000_000n });
  if (res.execResult.exceptionError) throw new Error(`call: ${res.execResult.exceptionError}`);
  return { gas: Number(res.execResult.executionGasUsed), ret: bytesToHex(res.execResult.returnValue) };
}
const calldataGas = (bytes) => { let g = 0; for (const b of bytes) g += b === 0 ? 4 : 16; return g; };

const sj = await snarkjs();
const SAMPLES = 8;

// ---- the two statements, both real -----------------------------------------------------------------
const { perpGate } = await load(import.meta.url, 'engine/perpGate.js');
const { witnessFor } = await load(import.meta.url, 'util/snark.js');
const POSITION = { side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005 };
const liqOut = perpGate(POSITION);
const liqBuilt = witnessFor(POSITION, liqOut.liquidationPrice);
if (!liqBuilt) throw new Error('the service refused to build a liquidation witness for its own answer');

const { build } = await makeBuilder(import.meta.url);
const BOOK = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
];
const pgBuilt = build(BOOK);
if (!pgBuilt.ok) throw new Error(`the portfolio book did not encode: ${pgBuilt.why}`);

const CASES = [
  { circuit: 'liquidation', vkFile: 'vk_plonk.json', solFile: 'PlonkVerifier.sol', witness: liqBuilt.witness },
  { circuit: 'portfoliogate', vkFile: 'portfoliogate_vk.json', solFile: 'PortfoliogateVerifier.sol', witness: pgBuilt.witness },
];

const measured = [];
for (const c of CASES) {
  const sol = readFileSync(path.join(BUILD, c.solFile), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { [c.solFile]: { content: sol } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  })));
  const errs = (compiled.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const key = Object.keys(compiled.contracts[c.solFile]).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k));
  const V = compiled.contracts[c.solFile][key];

  const zkey = path.join(BUILD, `${c.circuit}_plonk.zkey`);
  const wasm = path.join(BUILD, `${c.circuit}_js`, `${c.circuit}.wasm`);
  const builder = await require(path.join(BUILD, `${c.circuit}_js`, 'witness_calculator.cjs'))(readFileSync(wasm));
  const vk = JSON.parse(readFileSync(path.join(BUILD, c.vkFile), 'utf8'));

  const totals = [], execs = [];
  let nSig = null, cdGas = null;
  for (let i = 0; i < SAMPLES; i++) {
    const wtns = await builder.calculateWTNSBin(c.witness, 0);
    const { proof, publicSignals } = await sj.plonk.prove(zkey, wtns);
    if (!(await sj.plonk.verify(vk, publicSignals, proof))) throw new Error(`${c.circuit} sample ${i} does not verify off chain`);
    const raw = await sj.plonk.exportSolidityCallData(proof, publicSignals);
    const [pw, sw] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
    const sel = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${sw.length}])`))).slice(0, 8);
    const cd = hexToBytes(sel + [...pw, ...sw].map((v) => BigInt(v).toString(16).padStart(64, '0')).join(''));
    const res = await freshCall(V.evm.bytecode.object, cd);
    if (!/1$/.test(res.ret)) throw new Error(`${c.circuit} sample ${i} did not verify ON CHAIN — a spread over rejections is meaningless`);
    execs.push(res.gas); totals.push(res.gas + calldataGas(cd));
    nSig = sw.length; cdGas = calldataGas(cd);
  }
  totals.sort((a, b) => a - b); execs.sort((a, b) => a - b);
  const med = totals[Math.floor(SAMPLES / 2)];
  const mean = totals.reduce((a, b) => a + b, 0) / SAMPLES;
  const row = {
    circuit: c.circuit, verifier: key, publicSignals: nSig, samples: SAMPLES,
    execGasMedian: execs[Math.floor(SAMPLES / 2)], calldataGas: cdGas,
    totalGasMin: totals[0], totalGasMedian: med, totalGasMax: totals.at(-1),
    spreadGas: totals.at(-1) - totals[0], spreadPct: Number(((totals.at(-1) - totals[0]) / mean * 100).toFixed(2)),
  };
  measured.push(row);
  console.log(`  ${c.circuit.padEnd(14)} ${String(nSig).padStart(2)} public signals   total gas median ${String(med).padStart(7)}   spread ${row.spreadGas} (${row.spreadPct}%)   exec median ${row.execGasMedian}`);
}

// ---- the marginal ---------------------------------------------------------------------------------
const [lo, hi] = measured[0].publicSignals < measured[1].publicSignals ? measured : [measured[1], measured[0]];
const dSig = hi.publicSignals - lo.publicSignals;
const perSignalTotal = (hi.totalGasMedian - lo.totalGasMedian) / dSig;
const perSignalExec = (hi.execGasMedian - lo.execGasMedian) / dSig;
const spreadFloor = Math.max(lo.spreadGas, hi.spreadGas);
const gap = hi.totalGasMedian - lo.totalGasMedian;
console.log(`\n  span ${dSig} public signals, gap ${gap} gas  (sampling spread floor ${spreadFloor} gas — the gap is ${(gap / spreadFloor).toFixed(1)}x it)`);
console.log(`  marginal ${perSignalTotal.toFixed(0)} total gas per public signal (${perSignalExec.toFixed(0)} execution + ${(perSignalTotal - perSignalExec).toFixed(0)} calldata)`);
if (gap < spreadFloor * 3) throw new Error('the two-point gap is not comfortably above the sampling spread — this marginal would be noise');

// base cost at zero public signals, from the low point
const base = lo.totalGasMedian - perSignalTotal * lo.publicSignals;
// A set-exactness circuit over N leaves: 2 signals per 32-byte leaf (a contentHash does not fit one
// BN254 scalar) plus 2 for the root.
const snarkAtN = (n) => Math.round(base + perSignalTotal * (2 * n + 2));

// ---- the corrected crossover ----------------------------------------------------------------------
const gasArtifact = path.join(BUILD, 'probe-attest-snark-need.json');
if (!existsSync(gasArtifact)) throw new Error('run probe-attest-snark-need.mjs first — its measured direct-check curve is the other half of this');
const g = JSON.parse(readFileSync(gasArtifact, 'utf8'));
console.log(`\n     N   direct setExact   Plonk verify @ 2N+2 signals   cheaper`);
const table = [];
for (const r of g.directOnChain) {
  const s = snarkAtN(r.n);
  const d = r.setExact.totalGas;
  table.push({ n: r.n, directTotalGas: d, snarkTotalGasAt2Nplus2: s, publicSignals: 2 * r.n + 2, cheaper: d < s ? 'direct' : 'snark' });
  console.log(`  ${String(r.n).padStart(4)}   ${String(d).padStart(15)}   ${String(s).padStart(27)}   ${d < s ? 'direct' : 'SNARK'}`);
}
const flip = table.find((t) => t.cheaper === 'snark');
console.log(flip
  ? `\n  a set-exactness SNARK first becomes gas-cheaper at N=${flip.n}`
  : `\n  a set-exactness SNARK is NOT cheaper at any N measured up to ${table.at(-1).n}: pricing the leaves as public inputs removes the crossover entirely.`);

const artifact = {
  at: new Date().toISOString(),
  passed: true,
  question: 'Does the gas crossover survive once the circuit has to NAME the set it claims the root covers?',
  whyPublicInputs: 'A set-exactness statement must name the list, or it decides nothing about which set the root covers. Each 32-byte contentHash needs two BN254 public signals; the root needs two more. So the verify is priced at 2N+2 signals, not at the 8 the earlier crossover used.',
  measured,
  marginal: { perPublicSignalTotalGas: Number(perSignalTotal.toFixed(1)), perPublicSignalExecGas: Number(perSignalExec.toFixed(1)), spanSignals: dSig, gapGas: gap, samplingSpreadFloorGas: spreadFloor, gapOverSpread: Number((gap / spreadFloor).toFixed(1)) },
  baseGasAtZeroSignals: Math.round(base),
  comparison: table,
  crossoverWithPublicInputs: flip ? flip.n : null,
  crossoverWithoutPublicInputs: g.crossover.n,
  note: 'Both columns include EIP-2028 calldata gas. The direct column is measured; the SNARK column is the measured base plus the measured per-signal marginal, extrapolated in the number of signals. The marginal is required to exceed 3x the worst sampling spread before it is used, so it cannot be noise.',
};
writeFileSync(path.join(BUILD, 'probe-attest-public-input-cost.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  artifact zk/build/probe-attest-public-input-cost.json`);
await shutdown();
