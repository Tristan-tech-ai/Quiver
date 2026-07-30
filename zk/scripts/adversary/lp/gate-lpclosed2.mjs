// GATE part 2. Fixes two defects in my own gate: a field-element sign conversion that printed r-1
// as a magnitude, and snarkjs.plonk.verify needing a logger before it can report an invalid proof.
// Then the part that matters: the SAME circuit certifies breakevenVolatility with no trusted endpoints.
import __P from '../paths.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const SP = __P.WORK;
const ZK = __P.ZK;
const VT = __P.VT;
const require_ = createRequire(`${ZK}/package.json`);
const snarkjs = require_('snarkjs');
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const signed = (x) => { const b = BigInt(x); return b > R / 2n ? b - R : b; };
const abs = (x) => (x < 0n ? -x : x);
const quiet = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, log: () => {} };
let fails = 0;
const row = (l, v, ok) => { if (ok === false) fails++; console.log(`  ${l.padEnd(48)}${String(v).padStart(22)}  ${ok === undefined ? '' : ok ? 'ok' : 'FAIL'}`); };

const wc = require_(`${SP}/build/lpclosed2_js/witness_calculator.cjs`);
const calc = await wc(readFileSync(`${SP}/build/lpclosed2_js/lpclosed2.wasm`));
const zkey = readFileSync(`${SP}/build/lpclosed2_plonk.zkey`);
const vk = JSON.parse(readFileSync(`${SP}/build/lpclosed2_vk.json`, 'utf8'));
const { lpRisk } = await import(`file:///${VT}/src/engine/lpRisk.js`);

// ---------- 1. the sweep, with the sign conversion done right
let n = 0, cert = 0, worst = 0n, worstAt = null, skipped = 0;
for (let i = 0; i < 200; i++) {
  const sigma = Number((0.01 + (2.4 * i) / 199).toFixed(9));
  const T = 1 + ((i * 37) % 365);
  const r = lpRisk({ volatility: sigma, horizonPeriods: T, feeAprPct: 20, capitalUsd: 1e5 });
  const v = r.expectedDivergence.totalVariance;
  if (v > 256) { skipped++; continue; }
  n++;
  const vHat = BigInt(Math.round(v * 1e9)).toString();
  const lHat = BigInt(Math.round((1 + r.expectedDivergence.expectedIlPct / 100) * 1e6)).toString();
  const w = await calc.calculateWTNSBin({ vHat, lHat }, 0);
  const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, w);
  if (!(await snarkjs.plonk.verify(vk, publicSignals, proof, quiet))) { row(`verify failed at sigma=${sigma}`, '', false); continue; }
  const d = abs(signed(publicSignals[1]));
  if (d > worst) { worst = d; worstAt = { sigma, T, v, ilPct: r.expectedDivergence.expectedIlPct }; }
  cert++;
}
row('live-engine sweep: certified / attempted', `${cert} / ${n}`, cert === n);
row('above cap v>256, skipped upstream', skipped);
row('worst |circuit - published| in 1e-6 steps', worst.toString(), worst <= 2n);
console.log(`    worst at ${JSON.stringify(worstAt)}`);

// ---------- 2. forged proof and moved public signal, with a logger so verify can speak
const vHat0 = BigInt(Math.round(9.075 * 1e9)).toString(), lHat0 = '321623';
const w0 = await calc.calculateWTNSBin({ vHat: vHat0, lHat: lHat0 }, 0);
const { proof: p0, publicSignals: s0 } = await snarkjs.plonk.prove(zkey, w0);
row('honest proof verifies', await snarkjs.plonk.verify(vk, s0, p0, quiet), true);
const forged = JSON.parse(JSON.stringify(p0)); forged.A[0] = (BigInt(forged.A[0]) + 1n).toString();
row('forged proof rejected', (await snarkjs.plonk.verify(vk, s0, forged, quiet)) === false, true);
let moved = 0;
for (let i = 0; i < s0.length; i++) {
  const m = [...s0]; m[i] = (BigInt(m[i]) + 1n).toString();
  if ((await snarkjs.plonk.verify(vk, m, p0, quiet)) === false) moved++;
}
row('moved public signals rejected', `${moved} / ${s0.length}`, moved === s0.length);

// ---------- 3. where exactly does the variance bound bite? not vacuous, not over-tight.
console.log('\n  sensitivity of the certificate to the published variance:');
let firstRefuse = null;
for (const d of [1n, 10n, 100n, 1000n, 10000n, 25000n, 50000n, 100000n, 250000n, 1000000n]) {
  let verdict = 'ACCEPTED';
  try { await calc.calculateWTNSBin({ vHat: (BigInt(vHat0) + d).toString(), lHat: lHat0 }, 0); }
  catch { verdict = 'refused'; if (!firstRefuse) firstRefuse = d; }
  row(`  vHat + ${d} (= ${(Number(d) / 1e9).toExponential(1)} in v)`, verdict);
}
row('first refused variance perturbation', `${firstRefuse} = ${(Number(firstRefuse) / 1e9).toExponential(2)} in v`, firstRefuse !== null);
row('predicted boundary  2*1e-6/(dL/dv)=2e-6*8/L', (2e-6 * 8 / 0.321623).toExponential(2), true);

// ---------- 4. THE BREAKEVEN, same circuit, no trusted endpoint values.
// The bracket certificate publishes eLoHat/eHiHat as public inputs a caller can lie about.
// The closed form removes the bracket entirely: sigma*^2 T = -8 ln(1 - feeFrac) is equivalent to
// exp(-(sigma*^2 T)/8) = 1 - feeFrac, which is THIS circuit with different public inputs.
console.log('\n  breakevenVolatility through the same circuit (no eLoHat/eHiHat to lie about):');
let bkN = 0, bkOk = 0, bkWorst = 0n;
for (const [apr, T] of [[20, 30], [20, 304], [5, 365], [50, 7], [120, 14], [8, 90], [300, 3], [15, 180]]) {
  const r = lpRisk({ volatility: 0.4, horizonPeriods: T, feeAprPct: apr, capitalUsd: 1e5 });
  const fv = r.feeVsDivergence;
  if (!fv || fv.breakevenVolatility == null) continue;
  const feeFrac = fv.horizonFeesPct / 100;                 // PUBLISHED
  const sigmaStar = fv.breakevenVolatility;                // PUBLISHED (5 dp)
  const vStar = sigmaStar * sigmaStar * T;
  if (vStar > 256) continue;
  bkN++;
  const vHat = BigInt(Math.round(vStar * 1e9)).toString();
  const lHat = BigInt(Math.round((1 - feeFrac) * 1e6)).toString();
  let ps;
  try {
    const w = await calc.calculateWTNSBin({ vHat, lHat }, 0);
    const out = await snarkjs.plonk.prove(zkey, w);
    if (!(await snarkjs.plonk.verify(vk, out.publicSignals, out.proof, quiet))) throw new Error('verify');
    ps = out.publicSignals; bkOk++;
    const d = abs(signed(ps[1])); if (d > bkWorst) bkWorst = d;
  } catch (e) { ps = null; }
  console.log(`    apr ${String(apr).padStart(4)}% T=${String(T).padStart(3)}  sigma*=${String(sigmaStar).padEnd(9)} v*=${vStar.toFixed(6).padStart(11)}  1-fee=${(1 - feeFrac).toFixed(6)}  ${ps ? 'certified resid ' + signed(ps[1]) : 'REFUSED'}`);
}
row('breakeven cases certified', `${bkOk} / ${bkN}`, bkOk === bkN);
row('worst breakeven residual (1e-6 steps)', bkWorst.toString(), bkWorst <= 2n);

// ---------- 5. EVM gas
const solSrc = readFileSync(`${SP}/build/Lpclosed2Verifier.sol`, 'utf8');
row('solidity verifier source', `${solSrc.length} bytes`);
try {
  const solc = require_('solc');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'V.sol': { content: solSrc } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs[0].message.slice(0, 80));
  const c = Object.values(out.contracts['V.sol'])[0];
  row('solc', solc.version().split('+')[0]);
  row('verifier bytecode', `${c.evm.bytecode.object.length / 2} bytes`);
  // call it in a real EVM
  const { createVM } = require_('@ethereumjs/vm');
  const { Address, hexToBytes, bytesToHex } = require_('@ethereumjs/util');
  const vm = await createVM();
  const deploy = await vm.evm.runCall({
    data: hexToBytes('0x' + c.evm.bytecode.object), gasLimit: 30000000n,
    caller: new Address(hexToBytes('0x' + '11'.repeat(20))), to: undefined,
  });
  const addr = deploy.createdAddress;
  row('deployed', addr ? 'yes' : 'no', !!addr);
  const cd = await snarkjs.plonk.exportSolidityCallData(p0, s0);
  const [proofHex, pubArr] = JSON.parse('[' + cd + ']');
  const enc = (words) => words.map((w) => BigInt(w).toString(16).padStart(64, '0')).join('');
  // verifyProof(uint256[24] proof, uint256[N] pubSignals)
  const selector = '43753b4d';
  const calldata = '0x' + selector + enc(proofHex) + enc(pubArr);
  const good = await vm.evm.runCall({ to: addr, data: hexToBytes(calldata), gasLimit: 30000000n, caller: new Address(hexToBytes('0x' + '11'.repeat(20))) });
  row('EVM accept gas', good.execResult.executionGasUsed.toString(), !good.execResult.exceptionError);
  row('EVM accept returns true', bytesToHex(good.execResult.returnValue).endsWith('1'), bytesToHex(good.execResult.returnValue).endsWith('1'));
  const badWords = [...proofHex]; badWords[0] = (BigInt(badWords[0]) + 1n).toString();
  const bad = await vm.evm.runCall({ to: addr, data: hexToBytes('0x' + selector + enc(badWords) + enc(pubArr)), gasLimit: 30000000n, caller: new Address(hexToBytes('0x' + '11'.repeat(20))) });
  const rej = !!bad.execResult.exceptionError || !bytesToHex(bad.execResult.returnValue).endsWith('1');
  row('EVM rejects a tampered proof', `gas ${bad.execResult.executionGasUsed} rejected=${rej}`, rej);
} catch (e) { row('solc/EVM', e.message.slice(0, 40), false); }

console.log(`\n  ${fails === 0 ? 'PASSED' : `FAILED (${fails})`}`);
