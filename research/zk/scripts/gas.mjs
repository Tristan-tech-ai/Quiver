// On-chain verification gas, MEASURED by actually executing the exported
// Solidity verifier in an EVM. Not estimated, not quoted from a blog post.
//
// The brief's whole case for this artifact is the on-chain verifier: a contract
// cannot run Node, so today it can only check a signature and trust the signer.
// The number that decides whether that trade is worth making is the gas cost,
// so it gets measured rather than asserted.
//
// Usage: node scripts/gas.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from 'ethereum-cryptography/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(__dirname, '..', 'build');
const SOL = path.join(BUILD, 'LiquidationVerifier.sol');

const HARDFORK = 'cancun';

function compile() {
  const source = fs.readFileSync(SOL, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'LiquidationVerifier.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const contracts = out.contracts['LiquidationVerifier.sol'];
  const name = Object.keys(contracts)[0];
  return { name, ...contracts[name], solcVersion: solc.version() };
}

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');

// verifyProof(uint[2],uint[2][2],uint[2],uint[8]) — every argument is a static
// fixed-size type, so the encoding is a flat concatenation with no offsets.
function encodeCall(a, b, c, pub) {
  const sig = 'verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])';
  const selector = bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);
  const words = [
    pad(a[0]), pad(a[1]),
    pad(b[0][0]), pad(b[0][1]), pad(b[1][0]), pad(b[1][1]),
    pad(c[0]), pad(c[1]),
    ...pub.map(pad),
  ];
  return hexToBytes(selector + words.join(''));
}

async function main() {
  console.log(`gas.mjs — ${new Date().toISOString()}`);

  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const proof = JSON.parse(fs.readFileSync(path.join(BUILD, 'proof.json'), 'utf8'));
  const publicSignals = JSON.parse(fs.readFileSync(path.join(BUILD, 'public.json'), 'utf8'));

  // exportSolidityCallData handles the G2 coordinate swap between snarkjs's
  // pi_b ordering and what the Solidity pairing check expects. Doing that by
  // hand is a classic way to get a verifier that rejects valid proofs.
  const raw = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c, pub] = JSON.parse(`[${raw}]`);

  const compiled = compile();
  console.log(`\nsolc ${compiled.solcVersion}, optimizer on (200 runs), EVM ${HARDFORK}`);
  const deployed = compiled.evm.deployedBytecode.object;
  console.log(`contract: ${compiled.name}`);
  console.log(`deployed bytecode: ${deployed.length / 2} bytes`);

  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const evm = await EVM.create({ common });

  const caller = hexToBytes('1000000000000000000000000000000000000001');
  const deployRes = await evm.runCall({
    caller: { bytes: caller },
    data: hexToBytes(compiled.evm.bytecode.object),
    gasLimit: 10_000_000n,
  });
  if (deployRes.execResult.exceptionError) throw new Error(`deploy failed: ${deployRes.execResult.exceptionError}`);
  const addr = deployRes.createdAddress;
  console.log(`deploy gas: ${deployRes.execResult.executionGasUsed}`);

  async function call(label, data, expect, gasLimit = 5_000_000n) {
    const res = await evm.runCall({
      caller: { bytes: caller },
      to: addr,
      data,
      gasLimit,
    });
    const err = res.execResult.exceptionError;
    const ret = bytesToHex(res.execResult.returnValue);
    const value = err ? null : BigInt('0x' + (ret || '0')) === 1n;
    const gas = res.execResult.executionGasUsed;
    const ok = value === expect;
    console.log(`  [${ok ? 'PASS' : '*** FAIL ***'}] ${label.padEnd(30)} returned ${value}  gas ${gas}`);
    if (err) console.log(`          exception: ${err}`);
    return { gas, value, ok };
  }

  console.log('\nCalling verifyProof in the EVM:');
  const good = await call('valid proof', encodeCall(a, b, c, pub), true);

  // The negative case must be run on-chain too. A Solidity verifier that
  // returned true here would make every JS-side rejection irrelevant, because
  // the contract is the thing that actually holds the money.
  const results = [good];
  for (let i = 0; i < pub.length; i++) {
    const t = [...pub];
    t[i] = '0x' + (BigInt(t[i]) + 1n).toString(16);
    results.push(await call(`tampered signal[${i}]`, encodeCall(a, b, c, t), false));
  }
  const bentA = ['0x' + (BigInt(a[0]) + 1n).toString(16), a[1]];
  const bent5m = await call('bent pi_a', encodeCall(bentA, b, c, pub), false);
  results.push(bent5m);

  // A tampered SIGNAL is cheap to reject; a tampered POINT is not. pi_a+1 is a
  // valid field element but not on the curve, so precompile 0x08 fails, and a
  // failed precompile consumes every wei of gas forwarded to it. Vary the limit
  // to establish that the cost really is "whatever you gave it" and not a
  // constant that happened to look large.
  console.log('\nGas-limit sensitivity of the off-curve rejection:');
  const sweep = [];
  for (const limit of [1_000_000n, 2_000_000n, 5_000_000n]) {
    const r = await call(`bent pi_a @ ${limit}`, encodeCall(bentA, b, c, pub), false, limit);
    sweep.push({ limit, gas: r.gas, frac: Number(r.gas) / Number(limit) });
    results.push(r);
  }
  for (const s of sweep) {
    console.log(`    limit ${s.limit} -> used ${s.gas}  (${(s.frac * 100).toFixed(1)}% of limit)`);
  }
  const scales = sweep.every((s) => s.frac > 0.95);
  console.log(`  cost scales with the gas limit: ${scales}`);
  if (scales) {
    console.log('  => a caller that forwards all remaining gas has none left to');
    console.log('     handle the rejection. Cap the gas on the verifyProof call.');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} EVM calls, ${results.length - failed.length} as expected, ${failed.length} not`);

  const sigRejectGas = results.slice(1, 9).map((r) => Number(r.gas));
  const minR = Math.min(...sigRejectGas);
  const maxR = Math.max(...sigRejectGas);

  console.log('\nMEASURED gas:');
  console.log(`  verifyProof, valid proof:            ${good.gas}`);
  console.log(`  verifyProof, wrong public signal:    ${minR}${minR === maxR ? '' : ` .. ${maxR}`}`);
  console.log(`  verifyProof, off-curve proof point:  consumes the full gas forwarded`);
  console.log(`  deployment:                          ${deployRes.execResult.executionGasUsed}`);
  console.log(`  calldata: 4 + 512 = 516 bytes`);

  console.log(JSON.stringify({
    MEASURED: {
      at: new Date().toISOString(),
      hardfork: HARDFORK,
      solc: compiled.solcVersion,
      verifyGasValid: Number(good.gas),
      verifyGasWrongSignal: minR,
      offCurveConsumesAllGas: scales,
      offCurveSweep: sweep.map((s) => ({ limit: Number(s.limit), used: Number(s.gas) })),
      deployGas: Number(deployRes.execResult.executionGasUsed),
      deployedBytecodeBytes: deployed.length / 2,
      calls: results.length,
      unexpected: failed.length,
    },
  }));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
