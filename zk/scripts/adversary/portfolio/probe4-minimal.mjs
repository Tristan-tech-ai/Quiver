// ADVERSARIAL PROBE 4 — the same 6-leg batched statement with the DIAGNOSTIC outputs unpublished.
//
// residual and tolerance are `signal output` in every one of these circuits, which makes them public
// and makes each of them cost an EC scalar-mul in a Groth16 verifier. They are not load-bearing: the
// circuit already forces 0 <= 2R + tol <= 2*tol with the two NB_TOL decompositions, so publishing R
// and tol proves nothing the proof does not already prove. Dropping them is 2N fewer public signals.
import __P from '../paths.mjs';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ZK = __P.ZK;
const SC = __P.WORK;
const PTAU12 = path.join(ZK, 'build', 'hez_final_12.ptau');
const CLI = path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
const sjMod = await import('file:///' + path.join(ZK, 'node_modules', 'snarkjs', 'build', 'main.cjs').replace(/\\/g, '/'));
const sj = sjMod.default ?? sjMod;
const solc = (await import('file:///' + path.join(ZK, 'node_modules', 'solc', 'index.js').replace(/\\/g, '/'))).default;
const { EVM } = await import('file:///' + path.join(ZK, 'node_modules', '@ethereumjs', 'evm', 'dist', 'esm', 'index.js').replace(/\\/g, '/'));
const { Common, Chain, Hardfork } = await import('file:///' + path.join(ZK, 'node_modules', '@ethereumjs', 'common', 'dist', 'esm', 'index.js').replace(/\\/g, '/'));
const { keccak256 } = await import('file:///' + path.join(ZK, 'node_modules', 'ethereum-cryptography', 'keccak.js').replace(/\\/g, '/'));
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('file:///' + path.join(ZK, 'node_modules', 'ethereum-cryptography', 'utils.js').replace(/\\/g, '/'));
const { load } = await import('file:///' + path.join(ZK, 'scripts', 'service-root.mjs').replace(/\\/g, '/'));
const { toScaled } = await import('file:///' + path.join(ZK, 'scripts', 'lib', 'gatekit.mjs').replace(/\\/g, '/'));
const ANCHOR = __P.zkUrl("scripts/x.mjs");
const { portfolioGate } = await load(ANCHOR, 'engine/portfolioGate.js');
const snark = await load(ANCHOR, 'util/snark.js');

const cli = (args) => { try { execFileSync(process.execPath, [CLI, ...args], { cwd: ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 }); return { ok: true }; } catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString() }; } };
const WIDE = { mHat: 1n << 80n, qHat: 1n << 60n, p0Hat: 1n << 60n, pLiqHat: 1n << 60n, refHat: 1n << 60n, mmrHat: 1n << 30n };
const results = [];
const record = (n, p, d) => { results.push({ name: n, pass: !!p }); console.log(`  [${p ? 'PASS' : '*** FAIL ***'}] ${n}${d ? `\n           ${d}` : ''}`); };

const BOOK = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
  { venue: 'binance', asset: 'ARB', side: 'long', entryPrice: 0.62, size: 50000, leverage: 4, maintMarginRate: 0.012, markPrice: 0.62 },
  { venue: 'okx', asset: 'DOGE', side: 'short', entryPrice: 0.147, size: 200000, leverage: 3, maintMarginRate: 0.02, markPrice: 0.147 },
  { venue: 'okx', asset: 'AVAX', side: 'long', entryPrice: 27.4, size: 900, leverage: 6, maintMarginRate: 0.008, markPrice: 27.4 },
];

function buildBatch(book, N) {
  const result = portfolioGate({ positions: book });
  if (!result.ok) return { ok: false, why: 'engine refused' };
  const legs = [];
  for (let i = 0; i < book.length; i++) {
    const raw = book[i], pos = result.positions.find((p) => p.index === i);
    if (!pos?.liquidation?.price) return { ok: false, why: `leg ${i} no pLiq` };
    const b = snark.witnessFor({ side: pos.side, entryPrice: Number(raw.entryPrice), size: Math.abs(Number(raw.size)),
      maintMarginRate: Number(raw.maintMarginRate), leverage: raw.leverage, margin: raw.margin }, pos.liquidation.price);
    if (!b) return { ok: false, why: `leg ${i} out of domain` };
    const e = b.encoded, refHat = toScaled(pos.markPrice, 'markPrice');
    for (const [k, v] of Object.entries({ mHat: e.mHat, qHat: e.qHat, p0Hat: e.p0Hat, pLiqHat: e.pLiqHat, refHat, mmrHat: e.mmrHat })) {
      if (v >= WIDE[k]) return { ok: false, why: `leg ${i}: ${k} over WIDE bound` };
    }
    const d = BigInt(e.s) * (refHat - e.pLiqHat);
    if (d < 0n) return { ok: false, why: `leg ${i} breached` };
    if (b.gapToServed > 0.005) return { ok: false, why: `leg ${i} price diverges` };
    const pct = (Number(d) / Number(refHat)) * 100;
    if (Math.abs(pct - pos.liquidation.moveToLiqPct) > 0.0005) return { ok: false, why: `leg ${i} pct diverges` };
    legs.push({ index: i, ...e, refHat, d, pct });
  }
  const p = [...legs]; while (p.length < N) p.push(p[p.length - 1]);
  return { ok: true, legs: p, realLegs: legs, result, witness: {
    mHat: p.map((l) => l.mHat.toString()), qHat: p.map((l) => l.qHat.toString()), p0Hat: p.map((l) => l.p0Hat.toString()),
    s: p.map((l) => l.s.toString()), mmrHat: p.map((l) => l.mmrHat.toString()),
    pLiqHat: p.map((l) => l.pLiqHat.toString()), refHat: p.map((l) => l.refHat.toString()) } };
}

console.log('ADVERSARIAL PROBE 4 — 6 legs, one proof, full bit-width parity, diagnostics unpublished\n');
const out = {};
for (const [base, N, note] of [['pgb6', 6, 'residual+tolerance PUBLISHED (10N signals)'], ['pgc6', 6, 'residual+tolerance UNPUBLISHED (8N signals)'], ['pgc7', 7, 'seven legs — expected to be refused']]) {
  const r1cs = path.join(SC, `${base}.r1cs`);
  if (!existsSync(r1cs)) { console.log(`  ${base} — no r1cs`); continue; }
  const i = await sj.r1cs.info(r1cs);
  const budget = i.nConstraints + i.nPubInputs + i.nOutputs;
  const z0 = path.join(SC, `${base}_m0.zkey`), z1 = path.join(SC, `${base}_mf.zkey`);
  const vkp = path.join(SC, `${base}_mvk.json`), solp = path.join(SC, `${base}MVerifier.sol`);
  cli(['groth16', 'setup', r1cs, PTAU12, z0]);
  if (!existsSync(z0) || statSync(z0).size === 0) {
    console.log(`  ${base}  ${i.nConstraints} R1CS · budget ${budget} · 2^${Math.floor(Math.log2(budget)) + 1}  ->  REFUSED on the on-disk 2^12`);
    out[base] = { nConstraints: i.nConstraints, budget, built: false };
    continue;
  }
  cli(['zkey', 'contribute', z0, z1, '-n=adv', '-e=' + 'd'.repeat(64)]);
  cli(['zkey', 'export', 'verificationkey', z1, vkp]);
  cli(['zkey', 'export', 'solidityverifier', z1, solp]);
  const b = buildBatch(BOOK.slice(0, N), N);
  if (!b.ok) { record(`${base} book encodes`, false, b.why); continue; }
  const wc = await require(path.join(SC, `${base}_js`, 'witness_calculator.js'))(readFileSync(path.join(SC, `${base}_js`, `${base}.wasm`)));
  const wtns = await wc.calculateWTNSBin(b.witness, 0);
  const ts = []; let proof, publicSignals;
  for (let k = 0; k < 3; k++) { const t = Date.now(); ({ proof, publicSignals } = await sj.groth16.prove(z1, wtns)); ts.push(Date.now() - t); }
  const vk = JSON.parse(readFileSync(vkp, 'utf8'));
  const ok = await sj.groth16.verify(vk, publicSignals, proof);
  let refused = 0;
  for (let k = 0; k < publicSignals.length; k++) { const bad = [...publicSignals]; bad[k] = (BigInt(bad[k]) + 1n).toString();
    let a; try { a = await sj.groth16.verify(vk, bad, proof); } catch { a = false; } if (a === false) refused++; }
  const bent = JSON.parse(JSON.stringify(proof)); bent.pi_a[0] = (BigInt(bent.pi_a[0]) + 1n).toString();
  let bentAcc; try { bentAcc = await sj.groth16.verify(vk, publicSignals, bent); } catch { bentAcc = false; }

  const solName = path.basename(solp);
  const c = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [solName]: { content: readFileSync(solp, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  const cs = c.contracts[solName];
  const key = Object.keys(cs).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(cs)[0];
  const V = cs[key];
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const caller = hexToBytes('1000000000000000000000000000000000000001');
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
  const raw = await sj.groth16.exportSolidityCallData(proof, publicSignals);
  const [pA, pB, pC, pub] = JSON.parse(`[${raw}]`);
  const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
  const sel = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[${publicSignals.length}])`))).slice(0, 8);
  const words = [pA[0], pA[1], pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC[0], pC[1], ...pub];
  const res = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data: hexToBytes(sel + words.map(pad).join('')), gasLimit: 8_000_000n });
  const accepted = !res.execResult.exceptionError && BigInt('0x' + (bytesToHex(res.execResult.returnValue) || '0')) === 1n;
  const med = [...ts].sort((a, b) => a - b)[1];
  console.log(`  ${base}  ${i.nConstraints} R1CS · budget ${budget} · ${publicSignals.length} public signals · ${note}`);
  record(`${base}: ${N} legs, one proof, verifies on chain`, ok && refused === publicSignals.length && bentAcc === false && accepted,
    `prove median ${med} ms (${ts.join('/')}) · ${refused}/${publicSignals.length} perturbations refused · bent refused · ${res.execResult.executionGasUsed} gas · deployed ${V.evm.deployedBytecode.object.length / 2} B`);
  out[base] = { nConstraints: i.nConstraints, budget, built: true, publicSignals: publicSignals.length,
    proveMs: ts, medianProveMs: med, verified: ok, perturbationsRefused: refused, bentAccepted: bentAcc,
    acceptGas: String(res.execResult.executionGasUsed), deployedBytes: V.evm.deployedBytecode.object.length / 2,
    distances: b.realLegs.map((l) => l.pct) };
}
writeFileSync(path.join(SC, 'probe4.json'), JSON.stringify({ at: new Date().toISOString(), out, passed: results.every((r) => r.pass) }, null, 2) + '\n', 'utf8');
const bad = results.filter((r) => !r.pass);
console.log(`\nPROBE 4: ${bad.length === 0 ? 'PASSED' : 'FAILED — ' + bad.map((x) => x.name).join('; ')}`);
await globalThis.curve_bn128?.terminate();
process.exit(bad.length === 0 ? 0 : 1);
