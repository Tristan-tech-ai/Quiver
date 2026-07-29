// Is a Plonk "verify gas" number reproducible at all?
//
// WHY THIS EXISTS. Gate B9-2 compares the gas of a widened proof against separate proofs, and the
// comparison is only meaningful if a single figure is stable. A noise probe inside that gate — the
// same circuit, the same verifier, two different bets — came back 5,518 gas apart, which is 2% and far
// too large to wave away. Either the EVM is not deterministic (it is), or verify gas depends on the
// values in the proof. This finds out which, and by how much, so the comparison can state its own
// error bar instead of implying six significant figures.
//
// Two experiments:
//   A. the SAME calldata, run repeatedly. Any spread here would mean the harness is not deterministic.
//   B. DIFFERENT proofs of the SAME witness. Plonk proving is randomised (blinding scalars), so each
//      proof is a different set of field elements committing to an identical statement. Any spread
//      here is value-dependence in the verifier, not in the statement.
//
//   node zk/scripts/probe-plonk-gas-variance.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from 'ethereum-cryptography/utils.js';

const require = createRequire(import.meta.url);
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));

const RUNS_SAME = 5;
const RUNS_DIFF = 12;

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'K.sol': { content: readFileSync(path.join(BUILD, 'KellyVerifier.sol'), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
})));
const cs = out.contracts['K.sol'];
const V = cs[Object.keys(cs).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k))];

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const evm = await EVM.create({ common });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
const addr = dep.createdAddress;

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = bytesToHex(keccak256(utf8ToBytes('verifyProof(uint256[24],uint256[5])'))).slice(0, 8);
const zkey = path.join(BUILD, 'kelly_plonk.zkey');
const builder = await require(path.join(BUILD, 'kelly_js', 'witness_calculator.cjs'))(
  readFileSync(path.join(BUILD, 'kelly_js', 'kelly.wasm')));
const wtns = await builder.calculateWTNSBin({ pHat: '550000000', bHat: '1200000000', fHat: '175000000' }, 0);

const encode = async (proof, publicSignals) => {
  const raw = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
  const [pw, uw] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  return hexToBytes(sel + [...pw, ...uw].map(pad).join(''));
};
const run = async (data) => {
  const r = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
  if (r.execResult.exceptionError) throw new Error(r.execResult.exceptionError);
  return Number(r.execResult.executionGasUsed);
};

console.log(`Plonk verify gas variance — kelly.circom, 5 public signals — ${new Date().toISOString()}\n`);

const first = await snarkjs.plonk.prove(zkey, wtns);
const data = await encode(first.proof, first.publicSignals);
const same = [];
for (let i = 0; i < RUNS_SAME; i++) same.push(await run(data));
console.log(`  A. the same calldata, ${RUNS_SAME} times`);
console.log(`     ${same.join('  ')}`);
console.log(`     spread ${Math.max(...same) - Math.min(...same)} gas — ${Math.max(...same) === Math.min(...same) ? 'the harness is deterministic' : 'THE HARNESS IS NOT DETERMINISTIC'}\n`);

const diff = [];
for (let i = 0; i < RUNS_DIFF; i++) {
  const r = await snarkjs.plonk.prove(zkey, wtns);
  diff.push(await run(await encode(r.proof, r.publicSignals)));
}
const sorted = [...diff].sort((a, b) => a - b);
const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
const spread = sorted[sorted.length - 1] - sorted[0];
console.log(`  B. ${RUNS_DIFF} different proofs of the SAME witness (identical public signals)`);
console.log(`     ${sorted.join('  ')}`);
console.log(`     min ${sorted[0]} · median ${sorted[RUNS_DIFF >> 1]} · max ${sorted[sorted.length - 1]}`);
console.log(`     spread ${spread} gas = ${(spread / mean * 100).toFixed(2)}% of the mean\n`);

// ---- what A actually caught, which is the more dangerous of the two ------------------------------
const cold = same[0] - same[1];
console.log('  TWO DIFFERENT EFFECTS, and only one of them is noise.\n');
console.log(`  1. THE FIRST CALL COSTS ${cold} GAS MORE than every call after it. That is EIP-2929:`);
console.log(`     a cold account access is 2,600 gas and a warm one is 100, so ${cold / 2500} distinct precompile`);
console.log(`     addresses at 2,500 apiece = ${cold}. \`EVM.runCall\` does not reset the access set between`);
console.log('     calls the way a transaction boundary would, so the SECOND verifier measured in one EVM');
console.log('     instance is charged less than the first for doing identical work.');
console.log('');
console.log('     This is not a curiosity. It is a measurement trap: rehearse a baseline and then a');
console.log('     candidate in the same EVM and the candidate wins by 7,500 gas before it has done');
console.log('     anything. A real standalone transaction pays the cold price, so the FIRST-call figure');
console.log('     is the honest one and every verifier must be measured in a fresh EVM.');
console.log('');
console.log(`  2. Across ${RUNS_DIFF} proofs of an identical statement the spread is ${spread} gas (${(spread / mean * 100).toFixed(2)}%). Plonk`);
console.log('     proving is randomised, so a verify-gas number is a property of the particular proof and');
console.log(`     not of the statement. Quoting one to six figures is false precision; the error bar is`);
console.log(`     about ${Math.ceil(spread / 500) * 500} gas.`);
console.log('');
console.log('  Gate B9-2 answers both: a fresh EVM per verifier, and a median over several proofs.');

await globalThis.curve_bn128?.terminate();
process.exit(0);
