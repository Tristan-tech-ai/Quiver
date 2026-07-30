// GATE part 3: the closed-form verifier in a real EVM. Same harness shape as zk/scripts/lib/gatekit.mjs
// (@ethereumjs/evm, not @ethereumjs/vm -- my earlier probe reached for a module this repo does not carry).
import __P from '../paths.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const SP = __P.WORK;
const ZK = __P.ZK;
const require_ = createRequire(`${ZK}/package.json`);
const snarkjs = require_('snarkjs');
const solc = require_('solc');
const { EVM } = require_('@ethereumjs/evm');
const { Common, Chain, Hardfork } = require_('@ethereumjs/common');
const { keccak256 } = require_('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = require_('ethereum-cryptography/utils.js');

const wc = require_(`${SP}/build/lpclosed2_js/witness_calculator.cjs`);
const calc = await wc(readFileSync(`${SP}/build/lpclosed2_js/lpclosed2.wasm`));
const zkey = readFileSync(`${SP}/build/lpclosed2_plonk.zkey`);
const w = await calc.calculateWTNSBin({ vHat: '9075000000', lHat: '321623' }, 0);
const t0 = Date.now();
const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, w);
console.log(`  prove                             ${Date.now() - t0} ms`);
console.log(`  public signals                    ${JSON.stringify(publicSignals)}`);

const solName = 'Lpclosed2Verifier.sol';
const source = readFileSync(`${SP}/build/${solName}`, 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { [solName]: { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) throw new Error(errs[0].formattedMessage);
const contracts = out.contracts[solName];
const key = Object.keys(contracts).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(contracts)[0];
const V = contracts[key];
console.log(`  solc ${solc.version()} contract ${key}`);
console.log(`  deployed bytecode                 ${V.evm.deployedBytecode.object.length / 2} bytes`);

const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
if (dep.execResult.exceptionError) throw new Error(String(dep.execResult.exceptionError));
const addr = dep.createdAddress;

const raw = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
const [proofWords, pubWords] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const selector = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${publicSignals.length}])`))).slice(0, 8);
const encode = (pr, pu) => hexToBytes(selector + [...pr, ...pu].map(pad).join(''));
const call = async (label, data) => {
  const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
  const err = res.execResult.exceptionError;
  const ret = bytesToHex(res.execResult.returnValue);
  const value = err ? null : BigInt('0x' + (ret || '0')) === 1n;
  console.log(`  ${label.padEnd(34)}returned ${String(value).padEnd(6)}${res.execResult.executionGasUsed} gas${err ? ' · ' + err : ''}`);
  return { value, gas: res.execResult.executionGasUsed };
};
console.log(`  proof words ${proofWords.length} · public signals ${pubWords.length}`);
const good = await call('honest proof', encode(proofWords, pubWords));
let refused = 0;
for (let i = 0; i < pubWords.length; i++) {
  const t = [...pubWords]; t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
  if ((await call(`tampered signal[${i}]`, encode(proofWords, t))).value !== true) refused++;
}
const bent = [...proofWords]; bent[0] = '0x' + (BigInt(bent[0]) + 1n).toString(16);
const bentRes = await call('bent proof point', encode(bent, pubWords));
if (bentRes.value !== true) refused++;
console.log(`\n  accept ${good.gas} gas · cheapest refusal ${bentRes.gas} gas · ${refused} of ${pubWords.length + 1} tampered submissions refused`);
console.log(`  ${good.value === true && refused === pubWords.length + 1 ? 'EVM HALF PASSED' : 'EVM HALF FAILED'}`);
process.exit(0);
