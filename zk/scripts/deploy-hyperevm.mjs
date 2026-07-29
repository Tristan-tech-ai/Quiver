// Deploy the join to HyperEVM (chain 999): the liquidation Plonk verifier, and `QuiverPerpVerifier`
// pointed at it with the window gate A3 measured.
//
// This is the only script in the HyperEVM workstream that spends anything, so it is the only one that
// asks first. `--dry-run` prints exactly what it would send, from which address, and what it would
// cost, without sending.
//
//   node zk/scripts/deploy-hyperevm.mjs --dry-run
//
// Supply the deployer key through a FILE, not the environment — PowerShell writes every command line
// into ConsoleHost_history.txt verbatim:
//
//   $env:DEPLOYER_KEY_FILE = "$env:TEMP\dk.txt"; node zk/scripts/deploy-hyperevm.mjs
//
// It needs HYPE for gas on chain 999 and nothing else. The key is never written or logged; only the
// address derived from it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BUILD, CONTRACTS, RPCS, rpc, compile, readSol, selector, proveLiquidation, verifyOffChain, scaleLib, shutdown, perpUniverse, u32, callPlantedRaw, runtimeCodeFor, abiWords } from './lib/perpkit.mjs';

const DRY = process.argv.includes('--dry-run');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RPC = process.env.HYPEREVM_RPC || RPCS[0];
const CHAIN_ID = 999;
const require = createRequire(path.join(BUILD, '..', '..', 'hackathon', 'veritape', 'package.json'));
const { ethers } = require('ethers');

// The window is not invented here either.
let windowPpm = arg('--window', null);
let windowTicks = arg('--window-ticks', null);
if (windowPpm == null || windowTicks == null) {
  const f = path.join(BUILD, 'gateA3-staleness.json');
  if (!fs.existsSync(f)) { console.error('No measured window: run gateA3-staleness.mjs, or pass --window <ppm> --window-ticks <n>.'); process.exit(2); }
  const a3 = JSON.parse(fs.readFileSync(f, 'utf8'));
  windowPpm = windowPpm ?? a3.recommendWindowPpm;
  windowTicks = windowTicks ?? a3.recommendWindowTicks ?? 1;
}
windowPpm = BigInt(windowPpm);
windowTicks = BigInt(windowTicks);

function readKey() {
  const file = process.env.DEPLOYER_KEY_FILE;
  const raw = file ? fs.readFileSync(file, 'utf8') : process.env.DEPLOYER_KEY;
  if (!raw) return null;
  const k = String(raw).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    const shown = k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} chars)` : `${k.length} chars`;
    throw new Error(`DEPLOYER_KEY is not a 64-hex private key: ${shown}.`);
  }
  return k;
}

async function main() {
  console.log(`DEPLOY — the join on HyperEVM${DRY ? '  (DRY RUN — nothing will be sent)' : ''}\n`);
  const key = DRY && !process.env.DEPLOYER_KEY && !process.env.DEPLOYER_KEY_FILE ? null : readKey();

  const V = compile('PlonkVerifier.sol', 'PlonkVerifier', { 'PlonkVerifier.sol': { content: readSol(path.join(BUILD, 'PlonkVerifier.sol')) } });
  const Q = compile('QuiverPerpVerifier.sol', 'QuiverPerpVerifier', { 'QuiverPerpVerifier.sol': { content: readSol(path.join(CONTRACTS, 'QuiverPerpVerifier.sol')) } });
  const ctor = Q.abi.find((e) => e.type === 'constructor');
  if (!ctor || ctor.inputs.length !== 3) throw new Error(`QuiverPerpVerifier constructor takes ${ctor ? ctor.inputs.length : 0} arguments, expected 3 (verifier, windowPpm, windowTicks)`);
  console.log(`  solc ${V.solc}, optimizer 200 runs, evmVersion paris`);
  console.log(`  PlonkVerifier      ${V.evm.deployedBytecode.object.length / 2} bytes deployed`);
  console.log(`  QuiverPerpVerifier ${Q.evm.deployedBytecode.object.length / 2} bytes deployed · windowPpm ${windowPpm}`);

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice || 0n;
  console.log(`  chain ${net.chainId} via ${RPC} · gas price ${ethers.formatUnits(gp, 'gwei')} gwei`);

  // Estimated against the REAL chain, not against 200 gas/byte.
  const gasV = BigInt(await rpc('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', data: '0x' + V.evm.bytecode.object }]));
  const ctorArgs = abiWords('0x00000000000000000000000000000000000000ff', windowPpm, windowTicks);
  const gasQ = BigInt(await rpc('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', data: '0x' + Q.evm.bytecode.object + ctorArgs }]));
  const est = gasV + gasQ;
  const cost = est * gp;
  console.log(`  deployment gas, measured on chain: verifier ${gasV} + join ${gasQ} = ${est}`);
  console.log(`  → ${ethers.formatEther(cost)} HYPE at the current gas price\n`);

  if (key) {
    const wallet = new ethers.Wallet(key, provider);
    const bal = await provider.getBalance(wallet.address);
    console.log(`  deployer ${wallet.address} · balance ${ethers.formatEther(bal)} HYPE`);
    if (bal < cost * 3n) {
      console.error(`\nNOT ENOUGH GAS. This wallet holds ${ethers.formatEther(bal)} HYPE; the sequence needs about`
        + ` ${ethers.formatEther(cost)} HYPE and this check wants 3x that for headroom.`
        + `\nHYPE is the gas token on chain 999, so a wallet at zero cannot swap its way out — the swap is`
        + ` itself a transaction that needs HYPE. Fund ${wallet.address} on HyperEVM.`);
      if (!DRY) process.exit(1);
    }
  }

  if (DRY) {
    console.log('  Would deploy:');
    console.log(`    1. PlonkVerifier`);
    console.log(`    2. QuiverPerpVerifier(verifier, ${windowPpm}, ${windowTicks})`);
    console.log('  Then, as free eth_calls against the deployed addresses:');
    console.log('    3. verifyPerpGate(honest proof, live mark, right asset)  → expect true');
    console.log('    4. verifyPerpGate(same proof, wrong asset)               → expect MarkMismatch');
    console.log('    5. verifyPerpGate(bent proof, right price)               → expect ProofRejected');
    console.log('\n  Dry run complete. Nothing was sent.');
    return;
  }

  const wallet = new ethers.Wallet(key, provider);
  const vf = new ethers.ContractFactory(V.abi, V.evm.bytecode.object, wallet);
  const verifier = await vf.deploy();
  await verifier.waitForDeployment();
  const vRcpt = await verifier.deploymentTransaction().wait();
  const verifierAddr = await verifier.getAddress();
  console.log(`  PlonkVerifier deployed: ${verifierAddr}  tx ${vRcpt.hash}  ${vRcpt.gasUsed} gas  ${ethers.formatEther(vRcpt.gasUsed * vRcpt.gasPrice)} HYPE`);

  const qf = new ethers.ContractFactory(Q.abi, Q.evm.bytecode.object, wallet);
  const join = await qf.deploy(verifierAddr, windowPpm, windowTicks);
  await join.waitForDeployment();
  const qRcpt = await join.deploymentTransaction().wait();
  const joinAddr = await join.getAddress();
  console.log(`  QuiverPerpVerifier deployed: ${joinAddr}  tx ${qRcpt.hash}  ${qRcpt.gasUsed} gas  ${ethers.formatEther(qRcpt.gasUsed * qRcpt.gasPrice)} HYPE\n`);

  // Prove against the DEPLOYED contract. These are eth_calls: free, and they are what the deployment
  // exists to make possible, so they run here rather than in a separate script that might not.
  const universe = await perpUniverse();
  const BTC = universe.find((u) => u.name === 'BTC').perpIndex;
  const ETH = universe.find((u) => u.name === 'ETH').perpIndex;
  const scale = scaleLib();
  const markNow = await join.markPxHat(BTC);
  const p0 = BigInt(markNow);
  const { proofWords, pubWords } = await proveLiquidation({ mHat: p0 / 10n, qHat: 10n ** 9n, p0Hat: p0, s: 1, mmrHat: scale.toScaled(0.0125, 'mmr') });
  const asNum = (a) => a.map((x) => BigInt(x));

  const results = {};
  try { results.honest = await join.verifyPerpGate(asNum(proofWords), asNum(pubWords), BTC); }
  catch (e) { results.honest = `REVERT ${e.shortMessage || e.message}`.slice(0, 120); }
  try { results.wrongAsset = await join.verifyPerpGate(asNum(proofWords), asNum(pubWords), ETH); }
  catch (e) { results.wrongAsset = `REVERT ${(e.revert?.name) || e.shortMessage || e.message}`.slice(0, 120); }
  const bent = asNum(proofWords); bent[0] += 1n;
  try { results.bent = await join.verifyPerpGate(bent, asNum(pubWords), BTC); }
  catch (e) { results.bent = `REVERT ${(e.revert?.name) || e.shortMessage || e.message}`.slice(0, 120); }
  console.log(`  against the DEPLOYED contract: honest ${results.honest} · wrong asset ${results.wrongAsset} · bent ${results.bent}`);

  const out = {
    at: new Date().toISOString(), chainId: Number(net.chainId), rpc: RPC,
    verifier: verifierAddr, join: joinAddr, windowPpm: String(windowPpm),
    deployVerifierTx: vRcpt.hash, deployVerifierGas: String(vRcpt.gasUsed), deployVerifierGasPriceWei: String(vRcpt.gasPrice),
    deployJoinTx: qRcpt.hash, deployJoinGas: String(qRcpt.gasUsed), deployJoinGasPriceWei: String(qRcpt.gasPrice),
    totalCostHype: ethers.formatEther(vRcpt.gasUsed * vRcpt.gasPrice + qRcpt.gasUsed * qRcpt.gasPrice),
    deployer: wallet.address, btcMarkHat: String(markNow), liveResults: results,
    explorer: `https://hyperevmscan.io/address/${joinAddr}`,
  };
  fs.writeFileSync(path.join(BUILD, 'hyperevm-deployment.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n  written to zk/build/hyperevm-deployment.json`);
  console.log(`  total spent: ${out.totalCostHype} HYPE`);
}

main().then(async () => { await shutdown(); process.exit(0); }).catch(async (e) => { console.error(`\nFAILED: ${e.message}`); await shutdown(); process.exit(1); });
