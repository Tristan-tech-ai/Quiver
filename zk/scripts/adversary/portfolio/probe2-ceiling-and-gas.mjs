// ADVERSARIAL PROBE 2 — where is the WIDE circuit's real ceiling on the ptau already on disk, and
// what does its verifier cost on chain?
//
// The investigator's ceiling ("3 legs") and download requirement ("hez_final_13, 9,520,280 B") are
// both Plonk-specific. Under Groth16 the same hez_final_12 carries more legs. This measures how many,
// end to end, and prices the verifier in a FRESH EVM per row so EIP-2929 warming cannot flatter a
// later row.
import __P from '../paths.mjs';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ZK = __P.ZK;
const SC = __P.WORK;
const PTAU = path.join(ZK, 'build', 'hez_final_12.ptau');
const CLI = path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
const sjMod = await import('file:///' + path.join(ZK, 'node_modules', 'snarkjs', 'build', 'main.cjs').replace(/\\/g, '/'));
const sj = sjMod.default ?? sjMod;
const solc = (await import('file:///' + path.join(ZK, 'node_modules', 'solc', 'index.js').replace(/\\/g, '/'))).default;
const { EVM } = await import('file:///' + path.join(ZK, 'node_modules', '@ethereumjs', 'evm', 'dist', 'esm', 'index.js').replace(/\\/g, '/'));
const { Common, Chain, Hardfork } = await import('file:///' + path.join(ZK, 'node_modules', '@ethereumjs', 'common', 'dist', 'esm', 'index.js').replace(/\\/g, '/'));
const { keccak256 } = await import('file:///' + path.join(ZK, 'node_modules', 'ethereum-cryptography', 'keccak.js').replace(/\\/g, '/'));
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('file:///' + path.join(ZK, 'node_modules', 'ethereum-cryptography', 'utils.js').replace(/\\/g, '/'));

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};
const cli = (args) => {
  try { execFileSync(process.execPath, [CLI, ...args], { cwd: ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 }); return { ok: true }; }
  catch (e) { return { ok: false, out: (e.stdout || '').toString() + (e.stderr || '').toString() }; }
};

console.log('ADVERSARIAL PROBE 2 — the real wide-circuit ceiling on hez_final_12, and its gas\n');

// ---- 1. the ceiling, measured by SETUP SUCCEEDING or FAILING, not by arithmetic ------------------
// snarkjs groth16: cirPower = log2(nConstraints + nPubInputs + nOutputs) + 1, must be <= 12.
// A zkey of zero bytes counts as a failure however the CLI exits — the trap the investigator hit on
// the Plonk side (setup returns -1 and does not throw) has a Groth16 twin.
const rows = [];
for (const [label, r1cs] of [
  ['portfoliogate  N=3', path.join(ZK, 'build', 'portfoliogate.r1cs')],
  ['portfoliogate4 N=4', path.join(SC, 'portfoliogate4.r1cs')],
  ['pg5            N=5', path.join(SC, 'pg5.r1cs')],
  ['pg6            N=6', path.join(SC, 'pg6.r1cs')],
  ['pg7            N=7', path.join(SC, 'pg7.r1cs')],
]) {
  if (!existsSync(r1cs)) { console.log(`  ${label} — r1cs missing, skipped`); continue; }
  const i = await sj.r1cs.info(r1cs);
  const budget = i.nConstraints + i.nPubInputs + i.nOutputs;
  const zk = path.join(SC, `ceil_${path.basename(r1cs, '.r1cs')}.zkey`);
  const r = cli(['groth16', 'setup', r1cs, PTAU, zk]);
  const built = existsSync(zk) && statSync(zk).size > 0;
  rows.push({ label, nConstraints: i.nConstraints, nPub: i.nPubInputs, nOut: i.nOutputs, budget,
    power: Math.floor(Math.log2(budget)) + 1, built, zkeyBytes: built ? statSync(zk).size : 0 });
  console.log(`  ${label}  ${String(i.nConstraints).padStart(5)} R1CS · budget ${String(budget).padStart(5)} · groth16 power 2^${Math.floor(Math.log2(budget)) + 1}  ->  ${built ? 'BUILDS on the on-disk 2^12' : 'refused'}`);
}
const highestBuilt = rows.filter((r) => r.built).pop();
record('the wide circuit exceeds three legs on the ceremony file already on disk',
  highestBuilt && highestBuilt.nConstraints > 2100,
  `highest that builds: ${highestBuilt?.label.trim()} · ${highestBuilt?.nConstraints} R1CS · ${highestBuilt?.zkeyBytes} byte zkey`);
const firstRefused = rows.find((r) => !r.built);
record('the ceiling is a real ceiling — the next size up is refused, so this bound can fail',
  !!firstRefused, firstRefused ? `${firstRefused.label.trim()} refused: budget ${firstRefused.budget} needs 2^${firstRefused.power}` : 'NOTHING WAS REFUSED — the bound is vacuous');

// ---- 2. a real 5-leg book, proved --------------------------------------------------------------
const { makeWideBuilder } = await import('./n4-witness.mjs');
const BOOKS = {
  4: [
    { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
    { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
    { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
    { venue: 'binance', asset: 'ARB', side: 'long', entryPrice: 0.62, size: 50000, leverage: 4, maintMarginRate: 0.012, markPrice: 0.62 },
  ],
  5: [
    { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
    { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
    { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
    { venue: 'binance', asset: 'ARB', side: 'long', entryPrice: 0.62, size: 50000, leverage: 4, maintMarginRate: 0.012, markPrice: 0.62 },
    { venue: 'okx', asset: 'DOGE', side: 'short', entryPrice: 0.147, size: 200000, leverage: 3, maintMarginRate: 0.02, markPrice: 0.147 },
  ],
};

/** Compile+deploy the exported Groth16 verifier in a FRESH EVM and return accept/reject gas. */
async function priceInFreshEvm(solPath, proof, publicSignals, tag) {
  const solName = path.basename(solPath);
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { [solName]: { content: readFileSync(solPath, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const contracts = out.contracts[solName];
  const key = Object.keys(contracts).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(contracts)[0];
  const V = contracts[key];
  const deployedSize = V.evm.deployedBytecode.object.length / 2;

  // FRESH EVM per row. Sharing one makes every later row ~7,500 gas cheaper for free under EIP-2929 —
  // the investigator's own stated discipline, applied to their comparison rather than only to mine.
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const evm = await EVM.create({ common });
  const caller = hexToBytes('1000000000000000000000000000000000000001');
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy failed: ${dep.execResult.exceptionError}`);
  const addr = dep.createdAddress;

  const raw = await sj.groth16.exportSolidityCallData(proof, publicSignals);
  const parsed = JSON.parse(`[${raw}]`);
  const [pA, pB, pC, pub] = parsed;
  const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
  const sig = `verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[${publicSignals.length}])`;
  const selector = bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);
  const words = [pA[0], pA[1], pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC[0], pC[1], ...pub];
  const data = hexToBytes(selector + words.map(pad).join(''));
  const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
  const ret = bytesToHex(res.execResult.returnValue);
  const accepted = !res.execResult.exceptionError && BigInt('0x' + (ret || '0')) === 1n;

  // and a bent point, in the SAME fresh instance (a refusal is allowed to be warm; the accept is not)
  const bentWords = [...words]; bentWords[0] = (BigInt(bentWords[0]) + 1n).toString();
  const bres = await evm.runCall({ caller: { bytes: caller }, to: addr, data: hexToBytes(selector + bentWords.map(pad).join('')), gasLimit: 8_000_000n });
  const bret = bytesToHex(bres.execResult.returnValue);
  const bentAccepted = !bres.execResult.exceptionError && BigInt('0x' + (bret || '0')) === 1n;

  console.log(`  ${tag.padEnd(30)} accept ${String(res.execResult.executionGasUsed).padStart(9)} gas · ${publicSignals.length} public signals · deployed ${deployedSize} B · bent ${bentAccepted ? '*** ACCEPTED ***' : 'refused'} ${bres.execResult.executionGasUsed} gas`);
  return { acceptGas: res.execResult.executionGasUsed, rejectGas: bres.execResult.executionGasUsed, accepted, bentAccepted, deployedSize, contract: key };
}

const measured = {};
console.log('\nWide Groth16 proofs, in-process EVM, FRESH instance per row:\n');
for (const N of [4, 5]) {
  const base = N === 4 ? 'portfoliogate4' : `pg${N}`;
  const r1cs = N === 4 ? path.join(SC, 'portfoliogate4.r1cs') : path.join(SC, `pg${N}.r1cs`);
  const z0 = path.join(SC, `${base}_setup.zkey`), z1 = path.join(SC, `${base}_final.zkey`);
  const vkp = path.join(SC, `${base}_vk.json`), solp = path.join(SC, `${base}Verifier.sol`);
  if (!cli(['groth16', 'setup', r1cs, PTAU, z0]).ok) { record(`N=${N} setup`, false, 'setup failed'); continue; }
  cli(['zkey', 'contribute', z0, z1, '-n=adv', '-e=' + 'b'.repeat(64)]);
  cli(['zkey', 'export', 'verificationkey', z1, vkp]);
  cli(['zkey', 'export', 'solidityverifier', z1, solp]);

  const { build } = await makeWideBuilder(N);
  const built = build(BOOKS[N]);
  if (!built.ok) { record(`the ${N}-leg book encodes`, false, built.why); continue; }
  const wasmDir = N === 4 ? path.join(SC, 'portfoliogate4_js') : path.join(SC, `pg${N}_js`);
  const wasmFile = N === 4 ? 'portfoliogate4.wasm' : `pg${N}.wasm`;
  const wcalc = await require(path.join(wasmDir, 'witness_calculator.js'))(readFileSync(path.join(wasmDir, wasmFile)));
  const wtns = await wcalc.calculateWTNSBin(built.witness, 0);

  const times = [];
  let proof, publicSignals;
  for (let k = 0; k < 3; k++) {
    const t = Date.now();
    ({ proof, publicSignals } = await sj.groth16.prove(z1, wtns));
    times.push(Date.now() - t);
  }
  const vk = JSON.parse(readFileSync(vkp, 'utf8'));
  const ok = await sj.groth16.verify(vk, publicSignals, proof);
  const gas = await priceInFreshEvm(solp, proof, publicSignals, `N=${N} wide groth16`);
  measured[N] = { proveMs: times, medianProveMs: times.sort((a, b) => a - b)[1], verified: ok,
    publicSignals: publicSignals.length, nearest: built.nearest,
    distances: built.realLegs.map((l) => l.exactPct), ...gas,
    acceptGas: String(gas.acceptGas), rejectGas: String(gas.rejectGas) };
  record(`the ${N}-leg wide proof verifies and its verifier accepts on chain`, ok === true && gas.accepted && !gas.bentAccepted,
    `prove ${times.join('/')} ms (median ${measured[N].medianProveMs}) · engine names leg ${built.nearest} · ${gas.acceptGas} gas`);
}

writeFileSync(path.join(SC, 'probe2.json'), JSON.stringify({ at: new Date().toISOString(), rows, measured,
  passed: results.every((r) => r.pass) }, null, 2) + '\n', 'utf8');

const bad = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(78)}`);
console.log(`PROBE 2: ${bad.length === 0 ? 'PASSED' : 'FAILED — ' + bad.map((x) => x.name).join('; ')}`);
console.log('  NOTHING DEPLOYED. Nothing downloaded. Nothing in the project tree was written.');
await globalThis.curve_bn128?.terminate();
process.exit(bad.length === 0 ? 0 : 1);
