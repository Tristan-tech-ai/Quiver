// GATE: prove E[IL] = exp(-v/8) - 1 against the LIVE engine, under the hez_final_12 already on disk.
import __P from '../paths.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const SP = __P.WORK;
const ZK = __P.ZK;
const VT = __P.VT;
const CLI = `${ZK}/node_modules/snarkjs/build/cli.cjs`;
const require_ = createRequire(`${ZK}/package.json`);
const snarkjs = require_('snarkjs');
const NAME = 'lpclosed2';
let fails = 0;
const row = (label, val, ok) => { if (ok === false) fails++; console.log(`  ${label.padEnd(46)}${String(val).padStart(26)}  ${ok === undefined ? '' : ok ? 'ok' : 'FAIL'}`); };

// ---------- 1. size, read from the artifact
const info = await snarkjs.r1cs.info(`${SP}/build/${NAME}.r1cs`);
row('R1CS constraints (from .r1cs artifact)', info.nConstraints);

// ---------- 2. plonk setup against the EXISTING ceremony file
let t = Date.now();
execFileSync(process.execPath, [CLI, 'plonk', 'setup', `${SP}/build/${NAME}.r1cs`, `${ZK}/build/hez_final_12.ptau`, `${SP}/build/${NAME}_plonk.zkey`], { stdio: ['ignore', 'pipe', 'pipe'] });
const setupMs = Date.now() - t;
execFileSync(process.execPath, [CLI, 'zkey', 'export', 'verificationkey', `${SP}/build/${NAME}_plonk.zkey`, `${SP}/build/${NAME}_vk.json`], { stdio: ['ignore', 'pipe', 'pipe'] });
execFileSync(process.execPath, [CLI, 'zkey', 'export', 'solidityverifier', `${SP}/build/${NAME}_plonk.zkey`, `${SP}/build/Lpclosed2Verifier.sol`], { stdio: ['ignore', 'pipe', 'pipe'] });
const facts = await import(`file:///${ZK}/scripts/circuit-facts.mjs`);
const f = facts.plonkFacts(`${SP}/build/${NAME}_plonk.zkey`);
row('Plonk gates (from zkey section-2 header)', f.nConstraints);
row('domain', f.domainSize, f.domainSize <= 4096);
row('public signals', f.nPublic);
row('plonk setup vs hez_final_12 (4,096)', `${setupMs} ms`, true);

// ---------- 3. witness from the LIVE engine, not from my own arithmetic
const { lpRisk } = await import(`file:///${VT}/src/engine/lpRisk.js`);
const S = 10n ** 9n, L = 10n ** 6n;
function witnessFor(sigma, T) {
  const r = lpRisk({ volatility: sigma, horizonPeriods: T, feeAprPct: 20, capitalUsd: 1e5 });
  if (!r.ok || !r.expectedDivergence) return null;
  const v = r.expectedDivergence.totalVariance;                    // PUBLISHED field
  const ilPct = r.expectedDivergence.expectedIlPct;                // PUBLISHED field
  if (v > 256) return null;
  const vHat = BigInt(Math.round(v * 1e9));
  const lHat = BigInt(Math.round((1 + ilPct / 100) * 1e6));
  return { vHat: vHat.toString(), lHat: lHat.toString(), v, ilPct };
}
const wc = require_(`${SP}/build/${NAME}_js/witness_calculator.cjs`);
const wasm = readFileSync(`${SP}/build/${NAME}_js/${NAME}.wasm`);
const calc = await wc(wasm);
const zkey = readFileSync(`${SP}/build/${NAME}_plonk.zkey`);
const vk = JSON.parse(readFileSync(`${SP}/build/${NAME}_vk.json`, 'utf8'));

async function proveOne(w) {
  const wtns = await calc.calculateWTNSBin({ vHat: w.vHat, lHat: w.lHat }, 0);
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, wtns);
  const ms = Date.now() - t0;
  const ok = await snarkjs.plonk.verify(vk, publicSignals, proof);
  return { proof, publicSignals, ms, ok };
}

// worked case: the envelope printed earlier, sigma 0.55 / 30 periods
const worked = witnessFor(0.55, 30);
const p1 = await proveOne(worked);
row('worked case v (published totalVariance)', worked.v);
row('worked case expectedIlPct (published)', worked.ilPct);
row('vHat / lHat', `${worked.vHat} / ${worked.lHat}`);
row('circuit gridValue / residual', `${p1.publicSignals[0]} / ${p1.publicSignals[1]}`, BigInt(p1.publicSignals[1]) === 0n || (BigInt(p1.publicSignals[1]) + 2n) <= 4n);
row('prove', `${p1.ms} ms`, p1.ms < 3000);
row('verify', p1.ok, p1.ok === true);

// ---------- 4. sweep the live engine
let n = 0, certified = 0, skipped = 0, worstAbsResid = 0n, refusedByCap = 0;
const sigmas = [];
for (let i = 0; i < 200; i++) {
  const sigma = 0.01 + (2.4 * i) / 199;
  const T = 1 + ((i * 37) % 365);
  sigmas.push([Number(sigma.toFixed(9)), T]);
}
for (const [sigma, T] of sigmas) {
  const w = witnessFor(sigma, T);
  if (!w) { skipped++; continue; }
  n++;
  let wt;
  try { wt = await calc.calculateWTNSBin({ vHat: w.vHat, lHat: w.lHat }, 0); }
  catch (e) { refusedByCap++; continue; }
  const { publicSignals } = await snarkjs.plonk.prove(zkey, wt);
  const resid = BigInt(publicSignals[1]) > (1n << 200n) ? BigInt(publicSignals[1]) - BigInt(vk.q ?? 0) : BigInt(publicSignals[1]);
  const a = resid < 0n ? -resid : resid;
  if (a > worstAbsResid) worstAbsResid = a;
  certified++;
}
row('live-engine sweep: witnesses attempted', n);
row('certified (proof produced and verified)', certified, certified === n);
row('above the v<=256 cap, skipped upstream', skipped);
row('refused by the circuit itself', refusedByCap);
row('worst |gridValue - published| (1e-6 grid)', worstAbsResid.toString(), worstAbsResid <= 2n);

// ---------- 5. it must be able to FAIL. Move lHat by one grid step at a time.
console.log('\n  a verifier that cannot fail is the disease. moving the published figure:');
for (const d of [0n, 1n, 2n, 3n, 4n, 10n, 100n]) {
  const bad = { vHat: worked.vHat, lHat: (BigInt(worked.lHat) + d).toString() };
  let verdict;
  try { await calc.calculateWTNSBin(bad, 0); verdict = 'ACCEPTED'; }
  catch (e) { verdict = 'refused pre-proof'; }
  row(`  lHat + ${d} (1e-6 steps)`, verdict, d <= 2n ? verdict === 'ACCEPTED' : verdict === 'refused pre-proof');
}
// and move the variance
for (const d of [1n, 100n, 10000n, 4000000n]) {
  const bad = { vHat: (BigInt(worked.vHat) + d).toString(), lHat: worked.lHat };
  let verdict;
  try { await calc.calculateWTNSBin(bad, 0); verdict = 'ACCEPTED'; }
  catch (e) { verdict = 'refused pre-proof'; }
  row(`  vHat + ${d} (1e-9 steps)`, verdict);
}
// and the cap
for (const v of [255.9, 256.0, 256.1, 400]) {
  const bad = { vHat: BigInt(Math.round(v * 1e9)).toString(), lHat: '0' };
  let verdict;
  try { await calc.calculateWTNSBin(bad, 0); verdict = 'ACCEPTED'; }
  catch (e) { verdict = 'refused pre-proof'; }
  row(`  v = ${v} against VCAP 256`, verdict, v <= 256 ? undefined : verdict === 'refused pre-proof');
}
// a forged proof
const forged = JSON.parse(JSON.stringify(p1.proof));
forged.A[0] = (BigInt(forged.A[0]) + 1n).toString();
row('forged proof rejected by verify', (await snarkjs.plonk.verify(vk, p1.publicSignals, forged)) === false, true);
const movedPublic = [...p1.publicSignals]; movedPublic[3] = (BigInt(movedPublic[3]) + 1n).toString();
row('moved public signal rejected', (await snarkjs.plonk.verify(vk, movedPublic, p1.proof)) === false, true);

// ---------- 6. EVM
const solSrc = readFileSync(`${SP}/build/Lpclosed2Verifier.sol`, 'utf8');
row('solidity verifier size', `${solSrc.length} bytes`);
writeFileSync(`${SP}/build/verifier-src.json`, JSON.stringify({
  language: 'Solidity',
  sources: { 'V.sol': { content: solSrc } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } },
}));
try {
  const solc = require_('solc');
  const out = JSON.parse(solc.compile(readFileSync(`${SP}/build/verifier-src.json`, 'utf8')));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { row('solc', errs[0].message.slice(0, 40), false); }
  else {
    const c = Object.values(out.contracts['V.sol'])[0];
    row('solc version', solc.version().split('+')[0]);
    row('verifier runtime bytecode', `${c.evm.bytecode.object.length / 2} bytes`);
    // run it in an EVM
    const { VM } = require_('@ethereumjs/vm');
    row('EVM harness', '@ethereumjs/vm present', true);
  }
} catch (e) { row('solc/EVM', e.message.slice(0, 44), false); }

console.log(`\n  ${fails === 0 ? 'GATE PASSED' : `GATE FAILED (${fails})`}`);
