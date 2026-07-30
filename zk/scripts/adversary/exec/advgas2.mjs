// One circuit per process, progress printed as it goes.
//   node advgas2.mjs <name> <wasm> <zkey> <vkjson> <sol>
import __P from '../paths.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const ZK = __P.ZK;
const req = createRequire(`${ZK}/package.json`);
const [name, wasmP, zkeyP, vkP, solP] = process.argv.slice(2);
const log = (...a) => { console.log(...a); };

const snarkjs = req('snarkjs');
const solc = req('solc');
const { EVM } = req('@ethereumjs/evm');
const { Common, Chain, Hardfork } = req('@ethereumjs/common');
const { keccak256 } = req('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = req('ethereum-cryptography/utils.js');
log('loaded modules');

const INPUT = { xHat: '1500000000000000', yHat: '3750000000000000', dxHat: '15000000000000', fHat: '3000000',
  inHat: '14955000000000', outHat: '37018426289890', realizedHat: '36900000000000', bpsHat: '31991173521' };

const wcDir = wasmP.replace(/\/[^/]+$/, '');
const builder = await req(`${wcDir}/witness_calculator.cjs`)(readFileSync(wasmP));
const wtns = await builder.calculateWTNSBin(INPUT, 0);
log('witness built');
const t0 = Date.now();
const { proof, publicSignals } = await snarkjs.plonk.prove(zkeyP, wtns);
const proveMs = Date.now() - t0;
const vk = JSON.parse(readFileSync(vkP, 'utf8'));
const ok = await snarkjs.plonk.verify(vk, publicSignals, proof);
log(`proved ${proveMs} ms · nPublic ${publicSignals.length} · verify ${ok}`);

const raw = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
const [proofWords, pubWords] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);

const solName = solP.replace(/^.*\//, '');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { [solName]: { content: readFileSync(solP, 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
const cs = out.contracts[solName];
const key = Object.keys(cs).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(cs)[0];
const V = cs[key];
log(`solc ok · ${key} · deployed ${V.evm.deployedBytecode.object.length / 2} bytes`);

const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
if (dep.execResult.exceptionError) throw new Error('deploy ' + dep.execResult.exceptionError);
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${publicSignals.length}])`))).slice(0, 8);
const data = hexToBytes(sel + [...proofWords, ...pubWords].map(pad).join(''));
const res = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data, gasLimit: 8_000_000n });
const accepted = res.execResult.exceptionError ? null : BigInt('0x' + (bytesToHex(res.execResult.returnValue) || '0')) === 1n;
let cd = 0; for (const b of data) cd += b === 0 ? 4 : 16;
const bad = [...pubWords]; bad[bad.length - 1] = (BigInt(bad[bad.length - 1]) + 1n).toString();
const resBad = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data: hexToBytes(sel + [...proofWords, ...bad].map(pad).join('')), gasLimit: 8_000_000n });
const refused = resBad.execResult.exceptionError ? true : BigInt('0x' + (bytesToHex(resBad.execResult.returnValue) || '0')) !== 1n;

console.log('RESULT ' + JSON.stringify({ circuit: name, nPublic: publicSignals.length, proveMs, snarkjsVerify: ok,
  evmAccepted: accepted, execGas: Number(res.execResult.executionGasUsed), calldataGas: cd,
  totalGas: Number(res.execResult.executionGasUsed) + cd,
  deployedBytes: V.evm.deployedBytecode.object.length / 2, tamperRefused: refused }));
process.exit(0);
