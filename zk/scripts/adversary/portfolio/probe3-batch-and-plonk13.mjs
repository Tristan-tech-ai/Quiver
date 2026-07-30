// ADVERSARIAL PROBE 3 — two things the investigator listed as "could not check".
//
// (1) "THE 2^13 BUILD ITSELF. No 4-leg zkey exists... downloading a file requires Tristan's explicit
//     approval" and "(2) PROVING TIME AT DOMAIN 8,192. Not measured and deliberately NOT extrapolated."
//     Both were blocked on a download that was never necessary: `snarkjs powersoftau new bn128 13`
//     produces a valid 2^13 ceremony file offline. Here it is, used for the Plonk setup they refused,
//     with the domain-8,192 prove time measured rather than extrapolated.
//
// (2) The third shape: ONE proof over N legs with the minimum moved OUT (pgbatch.circom). Their
//     per-leg insight applied to the batched circuit rather than to a single leg, at the FULL
//     liquidation.circom bit widths they said three legs could not afford.
import __P from '../paths.mjs';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ZK = __P.ZK;
const SC = __P.WORK;
const PTAU12 = path.join(ZK, 'build', 'hez_final_12.ptau');
// `ptau.mjs make 13` writes into <work>/ptau/. The original probe read it from its own directory, so
// both are accepted and a missing file names the command that produces it rather than dying on ENOENT.
const PTAU13 = [path.join(SC, 'ptau', 'pot13_final.ptau'), path.join(SC, 'pot13_final.ptau')]
  .find((p) => existsSync(p)) ?? (() => {
  console.error('no local 2^13 ceremony file. Produce one, offline, with:');
  console.error('  node zk/scripts/adversary/ptau.mjs make 13');
  process.exit(2);
})();
const CLI = path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
const sjMod = await import('file:///' + path.join(ZK, 'node_modules', 'snarkjs', 'build', 'main.cjs').replace(/\\/g, '/'));
const sj = sjMod.default ?? sjMod;
const solc = (await import('file:///' + path.join(ZK, 'node_modules', 'solc', 'index.js').replace(/\\/g, '/'))).default;
const { EVM } = await import('file:///' + path.join(ZK, 'node_modules', '@ethereumjs', 'evm', 'dist', 'esm', 'index.js').replace(/\\/g, '/'));
const { Common, Chain, Hardfork } = await import('file:///' + path.join(ZK, 'node_modules', '@ethereumjs', 'common', 'dist', 'esm', 'index.js').replace(/\\/g, '/'));
const { keccak256 } = await import('file:///' + path.join(ZK, 'node_modules', 'ethereum-cryptography', 'keccak.js').replace(/\\/g, '/'));
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('file:///' + path.join(ZK, 'node_modules', 'ethereum-cryptography', 'utils.js').replace(/\\/g, '/'));
const { plonkFacts } = await import('file:///' + path.join(ZK, 'scripts', 'lib', 'circuit-facts.mjs').replace(/\\/g, '/')).catch(() => ({}))
  .then((m) => m.plonkFacts ? m : import('file:///' + path.join(ZK, 'scripts', 'circuit-facts.mjs').replace(/\\/g, '/')));

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};
const cli = (args) => {
  try { execFileSync(process.execPath, [CLI, ...args], { cwd: ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 }); return { ok: true }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString() }; }
};
const out = {};

console.log('ADVERSARIAL PROBE 3 — the 2^13 build, its prove time, and the batched shape\n');

// ══ PART 1 — the 2^13 Plonk build, on a ceremony file made locally ═══════════════════════════════
console.log('PART 1 — the build the investigator declined to make\n');
console.log(`  local pot13     ${statSync(PTAU13).size} bytes, produced by \`snarkjs powersoftau new bn128 13\``);
console.log(`  hez_final_13    9,520,280 bytes according to their curl -sIL  — never needed\n`);

const R1CS4 = path.join(SC, 'portfoliogate4.r1cs');
const z4 = path.join(SC, 'pg4_plonk.zkey');
const vk4p = path.join(SC, 'pg4_plonk_vk.json');
const t0 = Date.now();
const setup4 = cli(['plonk', 'setup', R1CS4, PTAU13, z4]);
const setupMs = Date.now() - t0;
record('the 4-leg wide circuit takes a Plonk setup on a locally generated 2^13',
  setup4.ok && existsSync(z4) && statSync(z4).size > 0,
  setup4.ok ? `${statSync(z4).size} byte zkey in ${setupMs} ms` : setup4.out.slice(-400));
if (setup4.ok) {
  const f = plonkFacts(z4);
  console.log(`\n  read back from the zkey header: ${f.nConstraints} Plonk · domain ${f.domainSize} · 2^${f.ptauPower} · nPublic ${f.nPublic}`);
  record('the Plonk gate count matches the 5,295 they measured through the logger',
    f.nConstraints === 5295, `zkey header says ${f.nConstraints}; domain ${f.domainSize}`);
  out.plonk4 = { ...f, setupMs, zkeyBytes: statSync(z4).size };

  cli(['zkey', 'export', 'verificationkey', z4, vk4p]);
  const { makeWideBuilder } = await import('./n4-witness.mjs');
  const { build } = await makeWideBuilder(4);
  const BOOK4 = [
    { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
    { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
    { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
    { venue: 'binance', asset: 'ARB', side: 'long', entryPrice: 0.62, size: 50000, leverage: 4, maintMarginRate: 0.012, markPrice: 0.62 },
  ];
  const b4 = build(BOOK4);
  if (b4.ok) {
    const wc = await require(path.join(SC, 'portfoliogate4_js', 'witness_calculator.js'))(readFileSync(path.join(SC, 'portfoliogate4_js', 'portfoliogate4.wasm')));
    const wtns = await wc.calculateWTNSBin(b4.witness, 0);
    const ts = [];
    let proof, publicSignals;
    for (let k = 0; k < 3; k++) { const t = Date.now(); ({ proof, publicSignals } = await sj.plonk.prove(z4, wtns)); ts.push(Date.now() - t); }
    const vk = JSON.parse(readFileSync(vk4p, 'utf8'));
    const ok = await sj.plonk.verify(vk, publicSignals, proof);
    const med = [...ts].sort((a, b) => a - b)[1];
    record('the 4-leg wide PLONK proof at domain 8,192 verifies', ok === true,
      `prove ${ts.join('/')} ms, median ${med} — MEASURED at domain 8,192, not extrapolated`);
    out.plonk4.proveMs = ts; out.plonk4.medianProveMs = med; out.plonk4.verified = ok;
  } else record('the 4-leg book encodes for the Plonk route', false, b4.why);
}

// ══ PART 2 — the batched shape, minimum moved out, at FULL bit-width parity ═══════════════════════
console.log('\nPART 2 — one proof over N legs with the minimum outside, NB_M 80 / NB_Q 60 / NB_P 60 / NB_TOL 92\n');

const { load } = await import('file:///' + path.join(ZK, 'scripts', 'service-root.mjs').replace(/\\/g, '/'));
const { toScaled } = await import('file:///' + path.join(ZK, 'scripts', 'lib', 'gatekit.mjs').replace(/\\/g, '/'));
const ANCHOR = __P.zkUrl("scripts/x.mjs");
const { portfolioGate } = await load(ANCHOR, 'engine/portfolioGate.js');
const snark = await load(ANCHOR, 'util/snark.js');

// Full liquidation.circom parity — the widths the wide 3-leg circuit had to give up.
const WIDE_BOUNDS = { mHat: 1n << 80n, qHat: 1n << 60n, p0Hat: 1n << 60n, pLiqHat: 1n << 60n, refHat: 1n << 60n, mmrHat: 1n << 30n };

function buildBatch(book, N) {
  const result = portfolioGate({ positions: book });
  if (!result.ok) return { ok: false, why: 'engine refused the book' };
  const legs = [];
  for (let i = 0; i < book.length; i++) {
    const raw = book[i];
    const pos = result.positions.find((p) => p.index === i);
    if (!pos?.liquidation?.price) return { ok: false, why: `leg ${i} solved no liquidation price` };
    const built = snark.witnessFor({ side: pos.side, entryPrice: Number(raw.entryPrice), size: Math.abs(Number(raw.size)),
      maintMarginRate: Number(raw.maintMarginRate), leverage: raw.leverage, margin: raw.margin }, pos.liquidation.price);
    if (!built) return { ok: false, why: `leg ${i} outside the leg circuit's domain` };
    const e = built.encoded;
    const refHat = toScaled(pos.markPrice, 'markPrice');
    for (const [k, v] of [['mHat', e.mHat], ['qHat', e.qHat], ['p0Hat', e.p0Hat], ['pLiqHat', e.pLiqHat], ['refHat', refHat], ['mmrHat', e.mmrHat]]) {
      if (v >= WIDE_BOUNDS[k]) return { ok: false, why: `leg ${i}: ${k} exceeds the WIDE bound`, bound: k };
    }
    const d = BigInt(e.s) * (refHat - e.pLiqHat);
    if (d < 0n) return { ok: false, why: `leg ${i} already past liquidation` };
    if (built.gapToServed > 0.005) return { ok: false, why: `leg ${i} price diverges ${built.gapToServed}` };
    const exactPct = (Number(d) / Number(refHat)) * 100;
    if (Math.abs(exactPct - pos.liquidation.moveToLiqPct) > 0.0005) return { ok: false, why: `leg ${i} pct diverges`, divergedPct: true };
    legs.push({ index: i, ...e, refHat, d, exactPct });
  }
  const padded = [...legs];
  while (padded.length < N) padded.push(padded[padded.length - 1]);
  return { ok: true, legs: padded, realLegs: legs, result, witness: {
    mHat: padded.map((l) => l.mHat.toString()), qHat: padded.map((l) => l.qHat.toString()),
    p0Hat: padded.map((l) => l.p0Hat.toString()), s: padded.map((l) => l.s.toString()),
    mmrHat: padded.map((l) => l.mmrHat.toString()), pLiqHat: padded.map((l) => l.pLiqHat.toString()),
    refHat: padded.map((l) => l.refHat.toString()),
  } };
}

const BOOK6 = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
  { venue: 'binance', asset: 'ARB', side: 'long', entryPrice: 0.62, size: 50000, leverage: 4, maintMarginRate: 0.012, markPrice: 0.62 },
  { venue: 'okx', asset: 'DOGE', side: 'short', entryPrice: 0.147, size: 200000, leverage: 3, maintMarginRate: 0.02, markPrice: 0.147 },
  { venue: 'okx', asset: 'AVAX', side: 'long', entryPrice: 27.4, size: 900, leverage: 6, maintMarginRate: 0.008, markPrice: 27.4 },
];

for (const N of [4, 6]) {
  const base = `pgb${N}`;
  const r1cs = path.join(SC, `${base}.r1cs`);
  if (!existsSync(r1cs)) { record(`${base} compiled`, false, 'missing r1cs'); continue; }
  const i = await sj.r1cs.info(r1cs);
  const budget = i.nConstraints + i.nPubInputs + i.nOutputs;
  const z0 = path.join(SC, `${base}_0.zkey`), z1 = path.join(SC, `${base}_f.zkey`);
  const vkp = path.join(SC, `${base}_vk.json`), solp = path.join(SC, `${base}Verifier.sol`);
  const s = cli(['groth16', 'setup', r1cs, PTAU12, z0]);
  const built = existsSync(z0) && statSync(z0).size > 0;
  console.log(`  ${base}  ${i.nConstraints} R1CS · ${i.nPubInputs} pub in · ${i.nOutputs} out · budget ${budget} · 2^${Math.floor(Math.log2(budget)) + 1}  ->  ${built ? 'BUILDS on the on-disk 2^12' : 'refused'}`);
  if (!built) { record(`${base} groth16 setup on the on-disk 2^12`, false, s.out?.slice(-200)); continue; }
  cli(['zkey', 'contribute', z0, z1, '-n=adv', '-e=' + 'c'.repeat(64)]);
  cli(['zkey', 'export', 'verificationkey', z1, vkp]);
  cli(['zkey', 'export', 'solidityverifier', z1, solp]);

  const b = buildBatch(BOOK6.slice(0, N), N);
  if (!b.ok) { record(`the ${N}-leg book encodes at FULL bit-width parity`, false, b.why); continue; }
  const wc = await require(path.join(SC, `${base}_js`, 'witness_calculator.js'))(readFileSync(path.join(SC, `${base}_js`, `${base}.wasm`)));
  const wtns = await wc.calculateWTNSBin(b.witness, 0);
  const ts = [];
  let proof, publicSignals;
  for (let k = 0; k < 3; k++) { const t = Date.now(); ({ proof, publicSignals } = await sj.groth16.prove(z1, wtns)); ts.push(Date.now() - t); }
  const vk = JSON.parse(readFileSync(vkp, 'utf8'));
  const ok = await sj.groth16.verify(vk, publicSignals, proof);
  let refused = 0;
  for (let k = 0; k < publicSignals.length; k++) {
    const bad = [...publicSignals]; bad[k] = (BigInt(bad[k]) + 1n).toString();
    let acc; try { acc = await sj.groth16.verify(vk, bad, proof); } catch { acc = false; }
    if (acc === false) refused++;
  }
  const bent = JSON.parse(JSON.stringify(proof)); bent.pi_a[0] = (BigInt(bent.pi_a[0]) + 1n).toString();
  let bentAcc; try { bentAcc = await sj.groth16.verify(vk, publicSignals, bent); } catch { bentAcc = false; }

  // FRESH EVM, one per row
  const solName = path.basename(solp);
  const c = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [solName]: { content: readFileSync(solp, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  const cs = c.contracts[solName];
  const key = Object.keys(cs).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(cs)[0];
  const V = cs[key];
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const evm = await EVM.create({ common });
  const caller = hexToBytes('1000000000000000000000000000000000000001');
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
  const addr = dep.createdAddress;
  const raw = await sj.groth16.exportSolidityCallData(proof, publicSignals);
  const [pA, pB, pC, pub] = JSON.parse(`[${raw}]`);
  const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
  const selector = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[${publicSignals.length}])`))).slice(0, 8);
  const words = [pA[0], pA[1], pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC[0], pC[1], ...pub];
  const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data: hexToBytes(selector + words.map(pad).join('')), gasLimit: 8_000_000n });
  const accepted = !res.execResult.exceptionError && BigInt('0x' + (bytesToHex(res.execResult.returnValue) || '0')) === 1n;
  const med = [...ts].sort((a, b) => a - b)[1];

  record(`the ${N}-leg BATCHED proof verifies at FULL bit-width parity, on the on-disk 2^12`,
    ok === true && refused === publicSignals.length && bentAcc === false && accepted,
    `prove ${ts.join('/')} ms (median ${med}) · ${publicSignals.length} public signals · ${refused}/${publicSignals.length} perturbations refused · bent refused · ${res.execResult.executionGasUsed} gas on chain · deployed ${V.evm.deployedBytecode.object.length / 2} B`);
  out[base] = { nConstraints: i.nConstraints, budget, publicSignals: publicSignals.length, proveMs: ts, medianProveMs: med,
    verified: ok, perturbationsRefused: refused, bentAccepted: bentAcc,
    acceptGas: String(res.execResult.executionGasUsed), deployedBytes: V.evm.deployedBytecode.object.length / 2,
    distances: b.realLegs.map((l) => l.exactPct) };
}

writeFileSync(path.join(SC, 'probe3.json'), JSON.stringify({ at: new Date().toISOString(), out, passed: results.every((r) => r.pass) }, null, 2) + '\n', 'utf8');
const bad = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(78)}`);
console.log(`PROBE 3: ${bad.length === 0 ? 'PASSED' : 'FAILED — ' + bad.map((x) => x.name).join('; ')}`);
console.log('  NOTHING DEPLOYED. Nothing downloaded. Nothing in the project tree was written.');
await globalThis.curve_bn128?.terminate();
process.exit(bad.length === 0 ? 0 : 1);
