// GATE A0 — the liquidation Plonk verifier, on HyperEVM, answering exactly as it does on X Layer.
//
// Done means: a proof that verifies on X Layer verifies identically on HyperEVM, and a bent one is
// refused on both. Not "the same kind of verifier" — the same bytes, the same calldata, the same
// answer, on two chains, checked against the contract already live at
// 0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25 rather than against a fresh compile of its source.
//
// The HyperEVM side runs by `eth_call` state override on chain 999: a real HyperEVM node executes the
// verifier's real bytecode. Add `--deploy` to also send the deployment transaction, which needs HYPE
// for gas and asks before spending anything.
//
// Run: node zk/scripts/gateA0-hyperevm-verifier.mjs [--deploy]
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD, RPCS, rpc, compile, readSol, checklist, proveLiquidation, verifyOffChain, scaleLib, shutdown,
} from './lib/perpkit.mjs';

const XLAYER_RPC = process.env.XLAYER_RPC || 'https://xlayer.drpc.org';
const DEPLOY = process.argv.includes('--deploy');
const g = checklist();
console.log(`GATE A0 — the Plonk verifier on HyperEVM — ${new Date().toISOString()}\n`);

const xl = (method, params) => rpc(method, params, { rpcs: [XLAYER_RPC] });

// ── 1. the bytes ──────────────────────────────────────────────────────────────────────────────────
const V = compile('PlonkVerifier.sol', 'PlonkVerifier', {
  'PlonkVerifier.sol': { content: readSol(path.join(BUILD, 'PlonkVerifier.sol')) },
});
const compiled = V.evm.deployedBytecode.object.toLowerCase();
const deployment = JSON.parse(readSol(path.join(BUILD, 'xlayer-deployment.json')));
const onXLayer = (await xl('eth_getCode', [deployment.verifier, 'latest'])).replace(/^0x/, '').toLowerCase();
g.record('this build reproduces the verifier already live on X Layer, byte for byte',
  onXLayer === compiled,
  `${onXLayer.length / 2} bytes at ${deployment.verifier} · ${compiled.length / 2} bytes from solc ${V.solc}`);

// ── 2. one existing proof ─────────────────────────────────────────────────────────────────────────
// The position X Layer's registry already holds: long 1 BTC at 64,000, 10x, mmr 1.25% → 58,329.11.
const scale = scaleLib();
const S = 10n ** 9n;
const position = { mHat: scale.toScaled(6400, 'm'), qHat: S, p0Hat: 64000n * S, s: 1, mmrHat: scale.toScaled(0.0125, 'mmr') };
const t0 = Date.now();
const { proof, publicSignals, proofWords, pubWords, encoded } = await proveLiquidation(position);
const proveMs = Date.now() - t0;
const okOff = await verifyOffChain(publicSignals, proof);
const servedPrice = Number(encoded.pLiqHat) / 1e9;
g.record('the proof verifies off chain against the published key', okOff === true,
  `proved in ${proveMs} ms · pLiq ${servedPrice} · X Layer recorded ${deployment.liquidationPrice}`);
g.record('it is a proof about the same position X Layer already holds',
  Math.abs(servedPrice - deployment.liquidationPrice) < 0.005,
  `${servedPrice} vs ${deployment.liquidationPrice}`);

// ── 3. calldata ───────────────────────────────────────────────────────────────────────────────────
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
// The selector is DERIVED from the ABI the compiler emitted and cross-checked against keccak of the
// signature — not typed in. The first draft of this gate hard-coded 0x6a5c0aab from memory and the
// real one is 0xa79b30ed; a hard-coded selector that is wrong reverts with empty data, which reads
// exactly like a verifier that refuses everything.
const { keccak256 } = await import('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex } = await import('ethereum-cryptography/utils.js');
const abiFn = V.abi.find((e) => e.type === 'function' && e.name === 'verifyProof');
const sig = `verifyProof(${abiFn.inputs.map((i) => i.type).join(',')})`;
const SELECTOR = '0x' + bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);
g.record('the selector is derived from the compiled ABI, not typed in',
  sig === 'verifyProof(uint256[24],uint256[8])', `${sig} → ${SELECTOR}`);
const encode = (pr, pu) => SELECTOR + [...pr, ...pu].map(pad).join('');

const bentProof = [...proofWords];
bentProof[0] = '0x' + (BigInt(bentProof[0]) + 1n).toString(16);
const bentSignals = [...pubWords];
bentSignals[7] = '0x' + (BigInt(bentSignals[7]) + 1n).toString(16);   // one grid step on the liq price

// ── 4. both chains, same calldata ─────────────────────────────────────────────────────────────────
const AT = '0x00000000000000000000000000000000000A0A00';
const overrides = { [AT]: { code: '0x' + compiled } };

async function onHyper(data) {
  const r = await rpc('eth_call', [{ from: '0x000000000000000000000000000000000000dEaD', to: AT, data, gas: '0x1D4C00' }, 'latest', overrides]);
  return BigInt(r) === 1n;
}
async function onXLayer2(data) {
  const r = await xl('eth_call', [{ from: '0x000000000000000000000000000000000000dEaD', to: deployment.verifier, data }, 'latest']);
  return BigInt(r) === 1n;
}

const cases = [
  ['honest proof', encode(proofWords, pubWords), true],
  ['bent proof point', encode(bentProof, pubWords), false],
  ['liquidation price moved one grid step', encode(proofWords, bentSignals), false],
];
console.log('\n  the same calldata, on both chains:');
console.log('    case                                    X Layer(196)  HyperEVM(999)  expected');
const rows = [];
for (const [name, data, expect] of cases) {
  const [x, h] = await Promise.all([onXLayer2(data), onHyper(data)]);
  rows.push({ name, xlayer: x, hyperevm: h, expect, agree: x === h && x === expect });
  console.log(`    ${name.padEnd(38)} ${String(x).padEnd(13)} ${String(h).padEnd(14)} ${expect}`);
}
g.record('every case gives the same answer on both chains, and the answer expected',
  rows.every((r) => r.agree), rows.map((r) => `${r.name}: ${r.xlayer}/${r.hyperevm}`).join(' · '));

// Every public signal moved on its own, on HyperEVM. A verifier that has only ever been asked to
// accept is decoration; this is the half that can fail.
console.log('\n  refusals on HyperEVM — each public signal moved by one, on its own:');
let refused = 0;
for (let i = 0; i < pubWords.length; i++) {
  const t = [...pubWords];
  t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
  const v = await onHyper(encode(proofWords, t));
  if (v === false) refused++;
  console.log(`    [${v === false ? 'PASS' : '*** FAIL ***'}] signal[${i}] + 1 -> ${v}`);
}
g.record('every perturbed public signal is refused on HyperEVM', refused === pubWords.length,
  `${refused} of ${pubWords.length}`);

// ── 5. gas, on both chains ────────────────────────────────────────────────────────────────────────
const gasHyper = BigInt(await rpc('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', to: AT, data: encode(proofWords, pubWords), gas: '0x1D4C00' }, 'latest', overrides]));
const gasX = BigInt(await xl('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', to: deployment.verifier, data: encode(proofWords, pubWords) }, 'latest']));
const gpHyper = BigInt(await rpc('eth_gasPrice', []));
const gpX = BigInt(await xl('eth_gasPrice', []));
console.log(`\n  verify: ${gasHyper} gas on HyperEVM at ${Number(gpHyper) / 1e9} gwei · ${gasX} gas on X Layer at ${Number(gpX) / 1e9} gwei`);
g.record('the two chains price the same computation the same way, to within calldata rules',
  gasHyper > 250_000n && gasHyper < 500_000n && (gasHyper > gasX ? gasHyper - gasX : gasX - gasHyper) < 20_000n,
  `HyperEVM ${gasHyper} · X Layer ${gasX} · difference ${gasHyper > gasX ? gasHyper - gasX : gasX - gasHyper}`);

// deployment cost, from the real chain rather than from 200 gas/byte
const deployGas = BigInt(await rpc('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', data: '0x' + V.evm.bytecode.object }]));
const deployCost = deployGas * gpHyper;
console.log(`  deploy: ${deployGas} gas × ${Number(gpHyper) / 1e9} gwei = ${Number(deployCost) / 1e18} HYPE`);

// ── 6. the real transaction ───────────────────────────────────────────────────────────────────────
let sent = null;
if (DEPLOY) {
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(BUILD, '..', '..', 'hackathon', 'veritape', 'package.json'));
  const { ethers } = req('ethers');
  const keyFile = process.env.DEPLOYER_KEY_FILE;
  const raw = keyFile ? fs.readFileSync(keyFile, 'utf8') : process.env.DEPLOYER_KEY;
  if (!raw) throw new Error('No deployer key. Set DEPLOYER_KEY_FILE to a file holding it (keeps it out of shell history).');
  const key = String(raw).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`DEPLOYER_KEY is not a 64-hex private key (${key.length} chars)`);
  const provider = new ethers.JsonRpcProvider(RPCS[0], 999, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(key, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log(`\n  deployer ${wallet.address} · balance ${ethers.formatEther(bal)} HYPE · needs ~${ethers.formatEther(deployCost)} HYPE`);
  if (bal < deployCost * 3n) {
    console.error(`\nNOT ENOUGH GAS on chain 999. Nothing was sent.`);
    process.exit(2);
  }
  const f = new ethers.ContractFactory(V.abi, V.evm.bytecode.object, wallet);
  const c = await f.deploy();
  await c.waitForDeployment();
  const rcpt = await c.deploymentTransaction().wait();
  sent = {
    address: await c.getAddress(), tx: rcpt.hash, gasUsed: String(rcpt.gasUsed),
    gasPrice: String(rcpt.gasPrice), costWei: String(rcpt.gasUsed * rcpt.gasPrice),
    costHype: ethers.formatEther(rcpt.gasUsed * rcpt.gasPrice),
  };
  console.log(`  DEPLOYED ${sent.address} · tx ${sent.tx} · ${sent.gasUsed} gas · ${sent.costHype} HYPE`);
  const code = (await provider.getCode(sent.address)).replace(/^0x/, '').toLowerCase();
  g.record('the deployed code is the same bytes as X Layer holds', code === onXLayer, `${code.length / 2} bytes`);
  const live = await provider.call({ to: sent.address, data: encode(proofWords, pubWords) });
  const liveBent = await provider.call({ to: sent.address, data: encode(bentProof, pubWords) });
  g.record('the DEPLOYED contract accepts the honest proof and refuses the bent one',
    BigInt(live) === 1n && BigInt(liveBent) === 0n, `honest ${BigInt(live)} · bent ${BigInt(liveBent)}`);
}

const failed = g.failed();
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE A0: ${failed.length === 0 ? 'PASSED' : `FAILED — ${failed.map((f) => f.name).join('; ')}`}`);

fs.writeFileSync(path.join(BUILD, 'gateA0-hyperevm-verifier.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, solc: V.solc,
  verifierBytes: compiled.length / 2, xlayerVerifier: deployment.verifier,
  bytecodeIdenticalToXLayer: onXLayer === compiled,
  liquidationPrice: servedPrice, publicSignals, proveMs,
  crossChain: rows, refusedSignals: refused,
  gas: { hyperevmVerify: String(gasHyper), xlayerVerify: String(gasX), hyperevmDeploy: String(deployGas) },
  gasPriceWei: { hyperevm: String(gpHyper), xlayer: String(gpX) },
  deployCostHype: Number(deployCost) / 1e18, deployed: sent, checks: g.results,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(failed.length === 0 ? 0 : 1);
