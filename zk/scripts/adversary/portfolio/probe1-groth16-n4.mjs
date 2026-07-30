// ADVERSARIAL PROBE 1 — is the 4-leg WIDE portfolio circuit really "NOT BUILDABLE on disk"?
//
// The investigator measured 5,295 PLONK gates → domain 8,192 → 2^13 → a 9,520,280-byte download that
// they declined to make, and recorded "N=4 NOT BUILDABLE on disk / ceiling 3 legs".
//
// snarkjs applies a DIFFERENT power test per proving system:
//   plonk   : cirPower = log2(plonkConstraints - 1) + 1                     (main.cjs:6452)
//   groth16 : cirPower = log2(nConstraints + nPubInputs + nOutputs) + 1     (main.cjs:4427)
// So the question is whether the 4-leg circuit fits the ON-DISK hez_final_12 under Groth16.
//
// Everything below is run, not inferred: setup, phase-2 contribution, vkey export, witness, prove,
// verify, then every public signal perturbed and the proof point bent.
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

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
};

const run = (args, label) => {
  process.stdout.write(`  ${label.padEnd(40)}`);
  const t = Date.now();
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd: ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 });
    console.log(`ok  ${Date.now() - t} ms`);
    return true;
  } catch (e) {
    console.log('FAILED');
    console.error((e.stdout || '').toString().slice(-2000), (e.stderr || '').toString().slice(-2000));
    return false;
  }
};

console.log(`ADVERSARIAL PROBE 1 — 4-leg wide circuit, Groth16, on the ptau already on disk\n`);
console.log(`  ptau            ${PTAU}`);
console.log(`  ptau bytes      ${statSync(PTAU).size}   (the file the investigator called a 3-leg ceiling)\n`);

const R1CS = path.join(SC, 'portfoliogate4.r1cs');
const info = await sj.r1cs.info(R1CS);
const budget = info.nConstraints + info.nPubInputs + info.nOutputs;
console.log(`  portfoliogate4  ${info.nConstraints} R1CS · ${info.nPubInputs} pub in · ${info.nOutputs} out · ${info.nPrvInputs} private`);
console.log(`  groth16 power   log2(${budget}) + 1 = ${Math.floor(Math.log2(budget)) + 1}    (ptau carries 12)\n`);

// ---- 1. setup, contribute, export ---------------------------------------------------------------
const z0 = path.join(SC, 'pg4_g16_0000.zkey');
const z1 = path.join(SC, 'pg4_g16_final.zkey');
const vkp = path.join(SC, 'pg4_g16_vk.json');
if (!run(['groth16', 'setup', R1CS, PTAU, z0], 'groth16 setup')) process.exit(1);
if (!run(['zkey', 'contribute', z0, z1, '-n=adversarial-review', '-e=' + 'a'.repeat(64)], 'phase-2 contribution')) process.exit(1);
if (!run(['zkey', 'export', 'verificationkey', z1, vkp], 'export verification key')) process.exit(1);
if (!run(['zkey', 'export', 'solidityverifier', z1, path.join(SC, 'Pg4G16Verifier.sol')], 'export solidity verifier')) process.exit(1);
record('a 4-leg wide zkey exists, built only from the on-disk 2^12 ceremony file',
  existsSync(z1), `${statSync(z1).size} bytes · zero bytes downloaded`);

// ---- 2. a real 4-leg book through the service's own encoder --------------------------------------
const { makeWideBuilder } = await import('./n4-witness.mjs');
const { build } = await makeWideBuilder(4);

// gateB8-2's three legs plus a fourth. Nothing special about the fourth; it is a normal perp leg.
const BOOK = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
  { venue: 'binance', asset: 'ARB', side: 'long', entryPrice: 0.62, size: 50000, leverage: 4, maintMarginRate: 0.012, markPrice: 0.62 },
];
const built = build(BOOK);
record('the 4-leg book encodes through the service encoder', built.ok, built.ok
  ? `engine names leg ${built.nearest} · distances ${built.realLegs.map((l) => l.exactPct.toFixed(4) + '%').join(', ')}`
  : built.why);
if (!built.ok) process.exit(1);

const wasm = path.join(SC, 'portfoliogate4_js', 'portfoliogate4.wasm');
const wcPath = path.join(SC, 'portfoliogate4_js', 'witness_calculator.js');
const builder = await require(wcPath)(readFileSync(wasm));
const wtns = await builder.calculateWTNSBin(built.witness, 0);
const wtnsPath = path.join(SC, 'pg4.wtns');
writeFileSync(wtnsPath, Buffer.from(wtns));

// ---- 3. prove and verify -------------------------------------------------------------------------
const vk = JSON.parse(readFileSync(vkp, 'utf8'));
const t0 = Date.now();
const { proof, publicSignals } = await sj.groth16.prove(z1, wtns);
const proveMs = Date.now() - t0;
const ok = await sj.groth16.verify(vk, publicSignals, proof);
record('the honest 4-leg wide proof verifies against the published key', ok === true,
  `proved in ${proveMs} ms · ${publicSignals.length} public signals · nPublic ${vk.nPublic}`);

console.log('\nRefusals — each public signal moved by one, on its own:');
let refused = 0;
for (let i = 0; i < publicSignals.length; i++) {
  const bad = [...publicSignals];
  bad[i] = (BigInt(bad[i]) + 1n).toString();
  let accepted;
  try { accepted = await sj.groth16.verify(vk, bad, proof); } catch { accepted = false; }
  if (accepted === false) refused++;
  process.stdout.write(accepted === false ? '.' : `\n  *** FAIL *** signal[${i}] accepted\n`);
}
console.log('');
record('every perturbed public signal is rejected', refused === publicSignals.length, `${refused} of ${publicSignals.length}`);

const bent = JSON.parse(JSON.stringify(proof));
bent.pi_a[0] = (BigInt(bent.pi_a[0]) + 1n).toString();
let bentAccepted;
try { bentAccepted = await sj.groth16.verify(vk, publicSignals, bent); } catch { bentAccepted = false; }
record('a bent proof point is rejected', bentAccepted === false, `returned ${bentAccepted}`);

// the attack that matters for this circuit: move `nearest` to a leg that is NOT the minimum
const nearestIdxInSignals = publicSignals.length - 1; // determined below by search instead
let movedNearestRefused = null;
{
  // find which public signal equals the nearest index and is not a price-like magnitude
  const target = String(built.nearest);
  const cand = publicSignals.map((v, i) => ({ v, i })).filter((x) => x.v === target);
  if (cand.length) {
    const bad = [...publicSignals];
    bad[cand[cand.length - 1].i] = String((built.nearest + 1) % 4);
    try { movedNearestRefused = (await sj.groth16.verify(vk, bad, proof)) === false; } catch { movedNearestRefused = true; }
    record('a moved `nearest` — the signal that changes the ANSWER — is rejected', movedNearestRefused,
      `signal[${cand[cand.length - 1].i}] ${target} -> ${(built.nearest + 1) % 4}`);
  }
}

writeFileSync(path.join(SC, 'probe1.json'), JSON.stringify({
  at: new Date().toISOString(),
  ptauBytes: statSync(PTAU).size, ptauPower: 12, bytesDownloaded: 0,
  r1cs: { nConstraints: info.nConstraints, nPubInputs: info.nPubInputs, nOutputs: info.nOutputs, nPrvInputs: info.nPrvInputs },
  groth16Power: Math.floor(Math.log2(budget)) + 1,
  zkeyBytes: statSync(z1).size,
  proveMs, publicSignals: publicSignals.length, verified: ok,
  nearest: built.nearest,
  distances: built.realLegs.map((l) => l.exactPct),
  passed: results.every((r) => r.pass),
}, null, 2) + '\n', 'utf8');

const bad = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(78)}`);
console.log(`PROBE 1: ${bad.length === 0 ? 'the 4-leg wide circuit IS buildable on the on-disk ptau' : 'FAILED — ' + bad.map((x) => x.name).join('; ')}`);
console.log('  NOTHING DEPLOYED. Nothing downloaded. Nothing in the project tree was written.');
await globalThis.curve_bn128?.terminate();
process.exit(bad.length === 0 ? 0 : 1);
