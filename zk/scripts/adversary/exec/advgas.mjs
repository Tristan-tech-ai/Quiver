// Adversarial-review measurement: prove + verify + measure in-EVM gas for the shipped
// execadverse circuit and three scratch variants that make the SAME statement with fewer
// public signals. Control first: reproduce gate B5-5's own accept-gas number.
import __P from '../paths.mjs';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ZK = __P.ZK;
const SP = __P.WORK;

const { createRequire } = await import('node:module');
const req = createRequire(`${ZK}/package.json`);
const snarkjs = req('snarkjs');
const solc = req('solc');
const { EVM } = req('@ethereumjs/evm');
const { Common, Chain, Hardfork } = req('@ethereumjs/common');
const { keccak256 } = req('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = req('ethereum-cryptography/utils.js');
const { execFileSync } = req('child_process');

// The exact witness gate B5-3 / B5-5 recorded, verified digit-for-digit against the artifact.
const INPUT = {
  xHat: '1500000000000000',
  yHat: '3750000000000000',
  dxHat: '15000000000000',
  fHat: '3000000',
  inHat: '14955000000000',
  outHat: '37018426289890',
  realizedHat: '36900000000000',
  bpsHat: '31991173521',
};

const CASES = [
  { name: 'execadverse', label: 'SHIPPED (theirs)', wasm: `${ZK}/build/execadverse_js/execadverse.wasm`, zkey: `${ZK}/build/execadverse_plonk.zkey`, sol: `${ZK}/build/ExecadverseVerifier.sol` },
  { name: 'xamin', label: 'same statement, 7 redundant outputs dropped', wasm: `${SP}/advbuild/xamin_js/xamin.wasm`, zkey: `${SP}/advbuild/xamin_plonk.zkey`, sol: `${SP}/advbuild/XaminVerifier.sol` },
  { name: 'xapriv', label: 'inputs private, only outHat+bpsHat public', wasm: `${SP}/advbuild/xapriv_js/xapriv.wasm`, zkey: `${SP}/advbuild/xapriv_plonk.zkey`, sol: `${SP}/advbuild/XaprivVerifier.sol` },
  { name: 'xacommit', label: 'private + Poseidon(5) trade commitment', wasm: `${SP}/advbuild/xacommit_js/xacommit.wasm`, zkey: `${SP}/advbuild/xacommit_plonk.zkey`, sol: `${SP}/advbuild/XacommitVerifier.sol` },
];

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');

const rows = [];
for (const c of CASES) {
  if (!existsSync(c.wasm) || !existsSync(c.zkey) || !existsSync(c.sol)) { console.log(`SKIP ${c.name}: missing artifact`); continue; }

  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.plonk.fullProve(INPUT, c.wasm, c.zkey);
  const proveMs = Date.now() - t0;

  const vk = JSON.parse(execFileSync(process.execPath,
    [`${ZK}/node_modules/snarkjs/build/cli.cjs`, 'zkey', 'export', 'verificationkey', c.zkey, `${SP}/advbuild/${c.name}_vk.json`],
    { stdio: ['ignore', 'pipe', 'pipe'] }) && readFileSync(`${SP}/advbuild/${c.name}_vk.json`, 'utf8'));
  const ok = await snarkjs.plonk.verify(vk, publicSignals, proof);

  // compile + deploy the exported verifier
  const solName = path.basename(c.sol);
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [solName]: { content: readFileSync(c.sol, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const contracts = out.contracts[solName];
  const key = Object.keys(contracts).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(contracts)[0];
  const V = contracts[key];
  const deployedBytes = V.evm.deployedBytecode.object.length / 2;

  const evm = await EVM.create({ common });
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy failed: ${dep.execResult.exceptionError}`);
  const addr = dep.createdAddress;

  const raw = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
  const [proofWords, pubWords] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  const selector = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${publicSignals.length}])`))).slice(0, 8);
  const data = hexToBytes(selector + [...proofWords, ...pubWords].map(pad).join(''));

  const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
  const accepted = res.execResult.exceptionError ? null : BigInt('0x' + (bytesToHex(res.execResult.returnValue) || '0')) === 1n;
  const execGas = Number(res.execResult.executionGasUsed);

  // calldata gas, EIP-2028: 4 per zero byte, 16 per non-zero
  let cd = 0;
  for (const b of data) cd += b === 0 ? 4 : 16;

  // one tampered public signal must be refused
  const bad = [...pubWords]; bad[bad.length - 1] = (BigInt(bad[bad.length - 1]) + 1n).toString();
  const resBad = await evm.runCall({ caller: { bytes: caller }, to: addr, data: hexToBytes(selector + [...proofWords, ...bad].map(pad).join('')), gasLimit: 8_000_000n });
  const refused = resBad.execResult.exceptionError ? true : BigInt('0x' + (bytesToHex(resBad.execResult.returnValue) || '0')) !== 1n;

  rows.push({ circuit: c.name, label: c.label, nPublic: publicSignals.length, proveMs, snarkjsVerify: ok,
    evmAccepted: accepted, execGas, calldataGas: cd, totalGas: execGas + cd, deployedBytes, tamperRefused: refused });
  console.log(`${c.name.padEnd(12)} nPublic=${String(publicSignals.length).padStart(2)} prove=${String(proveMs).padStart(5)}ms verify=${ok} evm=${accepted} execGas=${execGas} calldata=${cd} total=${execGas + cd} bytes=${deployedBytes} tamperRefused=${refused}`);
}

console.log('\n' + JSON.stringify(rows, null, 1));
const shipped = rows.find((r) => r.circuit === 'execadverse');
for (const r of rows) {
  if (!shipped || r === shipped) continue;
  console.log(`${r.circuit}: execGas ${r.execGas - shipped.execGas} vs shipped, total ${r.totalGas - shipped.totalGas}, per-public-signal exec ≈ ${((shipped.execGas - r.execGas) / (shipped.nPublic - r.nPublic)).toFixed(0)}`);
}
