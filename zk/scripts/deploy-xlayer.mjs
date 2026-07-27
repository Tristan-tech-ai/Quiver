// Deploy the proof registry to X Layer and put two real transactions on it: one accepting a proof
// the live service produced, one rejecting a tampered version of the same proof.
//
// This is the only script in the project that spends money, so it is the only one that asks first.
// Run it with --dry-run to see exactly what it would do, what it would cost, and from which address,
// without sending anything.
//
//   node zk/scripts/deploy-xlayer.mjs --dry-run
//
// Supply the deployer key through a FILE rather than the environment, so it never enters shell
// history — PowerShell writes every command line to ConsoleHost_history.txt verbatim:
//
//   $env:DEPLOYER_KEY_FILE = "$env:TEMP\dk.txt"; node zk/scripts/deploy-xlayer.mjs
//
// It needs OKB for gas on X Layer (chain 196). Nothing else. The key is never written anywhere by
// this script and never logged — only the address it derives.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import solc from 'solc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, '..', 'build');
const CONTRACTS = path.join(__dirname, '..', 'contracts');
const SERVICE = path.join(__dirname, '..', '..', 'hackathon', 'veritape');
const { ethers } = createRequire(path.join(SERVICE, 'package.json'))('ethers');

const DRY = process.argv.includes('--dry-run');
// Defaults to a third-party X Layer endpoint rather than OKX's own. Same chain, same result, but the
// transaction is broadcast without handing OKX's infrastructure a direct association between this
// machine's address and the wallet behind the registered agent. Override with XLAYER_RPC.
const RPC = process.env.XLAYER_RPC || 'https://xlayer.drpc.org';
const CHAIN_ID = 196;
// The key the live service signs public signals with, read from the deployed service itself rather
// than pasted here — a registry constructed with the wrong attestor would silently mark every
// genuine proof "unattested", and nothing on chain could fix it afterwards.
const SERVICE_URL = process.env.QUIVER_URL || 'https://quiver-production-c3a8.up.railway.app';

/**
 * Compile one source file and return ONE named contract from it.
 *
 * `contractName` is not optional politeness. The first version took whatever came out of
 * `Object.keys(contracts)[0]`, which for QuiverProofRegistry.sol is the `IPlonkVerifier` interface
 * declared above it — an artifact with empty bytecode and no constructor. It deployed the verifier
 * fine and then died with "incorrect number of arguments to constructor" on X Layer mainnet, after
 * spending real gas. gate3 had always selected by name; this script did not, and nothing compared
 * the two.
 */
function compile(name, file, contractName) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [name]: { content: fs.readFileSync(file, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts[name];
  const picked = contractName ? c[contractName] : c[Object.keys(c)[0]];
  if (!picked) throw new Error(`${name} has no contract named ${contractName} — found: ${Object.keys(c).join(', ')}`);
  if (!picked.evm.bytecode.object) throw new Error(`${contractName || Object.keys(c)[0]} compiled to empty bytecode — that is an interface or an abstract contract, not something you can deploy`);
  return picked;
}

/** Buy a risk number from the LIVE service and collect the proof it builds for it. */
async function buyAndProve() {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'perp_gate', arguments: { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125, snark: true } },
  };
  const r = await fetch(`${SERVICE_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const outer = await r.json();
  const answer = JSON.parse(outer.result.content[0].text);
  const hash = answer.proof.contentHash;
  console.log(`  bought from the live service: liquidationPrice ${answer.liquidationPrice} · contentHash ${hash}`);

  // 404 is retried for the first few seconds rather than treated as fatal. The proof store is in
  // memory, so a container that restarted between the purchase and the first poll answers "no proof
  // for that hash" — which happened here once, on a fresh deploy, and read like a broken endpoint.
  // Ask again; the buy is idempotent and the second attempt rebuilds it.
  let rebuilt = false;
  for (let i = 0; i < 60; i++) {
    const p = await fetch(`${SERVICE_URL}/proof/${hash}`);
    if (p.status === 200) {
      const rec = await p.json();
      console.log(`  proof retrieved from ${SERVICE_URL}/proof/${hash}`);
      return { answer, rec };
    }
    if (p.status === 404 && i < 6) {
      if (!rebuilt) { rebuilt = true; await fetch(`${SERVICE_URL}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }); }
    } else if (p.status !== 202) {
      throw new Error(`the service will not serve a proof for ${hash}: HTTP ${p.status} ${await p.text()}`);
    }
    await new Promise((s) => setTimeout(s, 1000));
  }
  throw new Error('the service never finished building the proof');
}

/**
 * Read the deployer key, preferring a file over the environment.
 *
 * A private key passed as `$env:DEPLOYER_KEY = "0x..."` is written verbatim into PowerShell's
 * ConsoleHost_history.txt, where it stays until something overwrites it. DEPLOYER_KEY_FILE avoids
 * that: the key sits in one file that can be deleted afterwards and never enters shell history.
 */
function readKey() {
  const file = process.env.DEPLOYER_KEY_FILE;
  const raw = file ? fs.readFileSync(file, 'utf8') : process.env.DEPLOYER_KEY;
  if (!raw) return null;
  const k = String(raw).trim();
  // Checked HERE, before a single network call. The first version validated it implicitly by handing
  // it to ethers — after buying a proof and connecting to the chain — so a mistyped key cost a full
  // round trip to find. Worse, an unsubstituted placeholder looks exactly like a broken RPC.
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    const shown = k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} chars)` : `${k.length} chars`;
    throw new Error(`DEPLOYER_KEY is not a 64-hex private key: ${shown}.`
      + (/[<>…]/.test(k) ? '\n\nThat looks like the placeholder text, pasted literally. Replace it with the actual key.' : ''));
  }
  return k;
}

async function main() {
  console.log(`DEPLOY — Quiver proof registry on X Layer${DRY ? '  (DRY RUN — nothing will be sent)' : ''}\n`);
  const key = DRY && !process.env.DEPLOYER_KEY && !process.env.DEPLOYER_KEY_FILE ? null : readKey();

  const { answer, rec } = await buyAndProve();
  if (rec.status !== 'ready') throw new Error(`proof is ${rec.status}: ${rec.error || ''}`);
  const attestor = rec.signalsAttestation?.signer;
  if (!attestor) throw new Error('the live service is not attesting public signals — deploying a registry with no attestor would be pointless');
  console.log(`  live attestor: ${attestor}\n`);

  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const raw = await snarkjs.plonk.exportSolidityCallData(rec.proof, rec.publicSignals);
  const [proof24, pub8] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);

  const V = compile('PlonkVerifier.sol', path.join(BUILD, 'PlonkVerifier.sol'), 'PlonkVerifier');
  const R = compile('QuiverProofRegistry.sol', path.join(CONTRACTS, 'QuiverProofRegistry.sol'), 'QuiverProofRegistry');
  // Checked before spending anything. The failure this catches deployed a verifier first and only
  // then discovered it was holding an artifact that takes no constructor arguments.
  const ctor = R.abi.find((e) => e.type === 'constructor');
  if (!ctor || ctor.inputs.length !== 2) throw new Error(`QuiverProofRegistry constructor takes ${ctor ? ctor.inputs.length : 0} arguments, expected 2 (verifier, attestor)`);
  console.log(`  solc ${solc.version()}, optimizer 200 runs, evmVersion paris`);

  // batchMaxCount: 1 — ethers batches JSON-RPC calls by default and the free tiers of most public
  // endpoints reject batches over three, with a 500 that reads like the chain is down rather than
  // like a plan limit. One request at a time is slower and works everywhere.
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  const fee = await provider.getFeeData();
  console.log(`  chain ${net.chainId} via ${RPC} · gas price ${ethers.formatUnits(fee.gasPrice || 0n, 'gwei')} gwei`);

  if (!key && !DRY) throw new Error('No deployer key. Set DEPLOYER_KEY_FILE to a file holding it (preferred — keeps it out of shell history), or DEPLOYER_KEY in the environment.');
  const wallet = key ? new ethers.Wallet(key, provider) : null;

  // Measured in the EVM by gate3: verifier 1,455,520 · registry 564,084 · accept 441,179 · reject 7,639
  const est = 1_455_520n + 564_084n + 441_179n + 300_000n;
  const cost = est * (fee.gasPrice || 0n);
  console.log(`  estimated total gas ~${est} → ~${ethers.formatEther(cost)} OKB\n`);

  if (wallet) {
    // Checked BEFORE anything is sent. Running out of gas midway leaves a deployed verifier with no
    // registry pointing at it and a half-finished story to explain — cheap to prevent, tedious to undo.
    const bal = await provider.getBalance(wallet.address);
    console.log(`  deployer ${wallet.address} · balance ${ethers.formatEther(bal)} OKB`);
    if (bal < cost * 3n) {
      console.error(`\nNOT ENOUGH GAS. This wallet holds ${ethers.formatEther(bal)} OKB; the sequence needs about`
        + ` ${ethers.formatEther(cost)} OKB and this check wants 3x that for headroom.\n`
        + `\nNote that OKB is the GAS token on X Layer, so a wallet at zero cannot swap its way out —`
        + ` sending the swap is itself a transaction that needs OKB. Fund this address from a wallet`
        + ` that already holds some, or use the key of one that does.`);
      process.exit(1);
    }
  }

  if (DRY) {
    console.log('  Would deploy:');
    console.log(`    1. PlonkVerifier            (${V.evm.bytecode.object.length / 2} bytes)`);
    console.log(`    2. QuiverProofRegistry(verifier, ${attestor})`);
    console.log('  Then send two transactions:');
    console.log('    3. submit(proof, pubSignals, attestation)      → expect ProofAccepted');
    console.log('    4. submit(proof, TAMPERED signals, attestation) → expect ProofRejected');
    console.log('\n  Dry run complete. Nothing was sent.');
    return;
  }

  // A verifier already on chain is reused rather than duplicated — but only after proving it IS the
  // verifier, by comparing the code at that address against what solc just produced. Trusting an
  // address someone typed would mean a registry pointing at an unknown contract, which is precisely
  // the kind of "checked by assertion" this whole project exists to avoid.
  let verifierAddr = process.env.VERIFIER_ADDRESS || null;
  let verifierTx = null;
  if (verifierAddr) {
    const onChain = (await provider.getCode(verifierAddr)).replace(/^0x/, '').toLowerCase();
    const expected = V.evm.deployedBytecode.object.toLowerCase();
    if (onChain !== expected) {
      throw new Error(`the code at ${verifierAddr} is not this PlonkVerifier `
        + `(${onChain.length / 2} bytes on chain vs ${expected.length / 2} compiled). Unset VERIFIER_ADDRESS to deploy a fresh one.`);
    }
    console.log(`  PlonkVerifier reused: ${verifierAddr}  (bytecode matches this build, ${onChain.length / 2} bytes)`);
  } else {
    const vf = new ethers.ContractFactory(V.abi, V.evm.bytecode.object, wallet);
    const verifier = await vf.deploy();
    await verifier.waitForDeployment();
    verifierAddr = await verifier.getAddress();
    verifierTx = verifier.deploymentTransaction().hash;
    console.log(`  PlonkVerifier deployed: ${verifierAddr}  tx ${verifierTx}`);
  }

  const rf = new ethers.ContractFactory(R.abi, R.evm.bytecode.object, wallet);
  const registry = await rf.deploy(verifierAddr, attestor);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`  QuiverProofRegistry deployed: ${registryAddr}  tx ${registry.deploymentTransaction().hash}\n`);

  const accept = await registry.submit(proof24, pub8, rec.signalsAttestation.signature);
  const acceptRcpt = await accept.wait();
  console.log(`  ACCEPT  tx ${acceptRcpt.hash}  gas ${acceptRcpt.gasUsed}  status ${acceptRcpt.status}`);

  const tampered = [...pub8];
  tampered[7] = '0x' + (BigInt(tampered[7]) + 1n).toString(16);   // one grid step on the liquidation price
  const reject = await registry.submit(proof24, tampered, rec.signalsAttestation.signature);
  const rejectRcpt = await reject.wait();
  console.log(`  REJECT  tx ${rejectRcpt.hash}  gas ${rejectRcpt.gasUsed}  status ${rejectRcpt.status}`);

  const accepted = acceptRcpt.logs.some((l) => l.topics[0] === ethers.id('ProofAccepted(bytes32,address,uint256,bool,bool)'));
  const rejected = rejectRcpt.logs.some((l) => l.topics[0] === ethers.id('ProofRejected(bytes32,address,string)'));

  const digest = rec.signalsAttestation.digest;
  const [whole, nano] = await registry.liquidationPrice(digest);
  console.log(`\n  the chain now holds: liquidation ${whole}.${String(nano).padStart(9, '0')} (sold as ${answer.liquidationPrice})`);
  console.log(`  accepted event: ${accepted} · rejected event: ${rejected}`);

  const out = {
    at: new Date().toISOString(), chainId: Number(net.chainId), rpc: RPC,
    verifier: verifierAddr, registry: registryAddr, attestor,
    deployVerifierTx: verifierTx,
    deployRegistryTx: registry.deploymentTransaction().hash,
    acceptTx: acceptRcpt.hash, acceptGas: String(acceptRcpt.gasUsed),
    rejectTx: rejectRcpt.hash, rejectGas: String(rejectRcpt.gasUsed),
    contentHash: answer.proof.contentHash, signalsDigest: digest,
    liquidationPrice: answer.liquidationPrice,
    explorer: `https://www.okx.com/web3/explorer/xlayer/address/${registryAddr}`,
  };
  fs.writeFileSync(path.join(BUILD, 'xlayer-deployment.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n  written to zk/build/xlayer-deployment.json`);
  console.log(`  explorer: ${out.explorer}`);

  if (!accepted || !rejected) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
