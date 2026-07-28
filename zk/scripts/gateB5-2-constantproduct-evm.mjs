// GATE B5-2 — a contract accepts the constant-product proof and refuses a tampered one, in a real EVM.
//
// The pool comes from the REAL execVerify engine at a realistic 30bp fee, so the contract accepts a
// statement about an answer the service would have sold. Nothing is deployed and nothing is served.
//
// Run: node zk/scripts/gateB5-2-constantproduct-evm.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist, proveVerifyRefuse, evmRehearsal, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { execVerify } = await load(import.meta.url, 'engine/execVerify.js');

const { record, failed } = checklist();
console.log(`GATE B5-2 — constant-product verifier in an EVM — ${new Date().toISOString()}\n`);

// A 30bp pool and a trade worth about 1% of the input side: an ordinary swap that pays real price
// impact, which is the case a caller actually wants a benchmark for.
const x = 1_500_000, y = 3_750_000, f = 0.003, dx = 15_000;
const realized = 37_150;    // a fill a little worse than honest, so the adverse figure is non-zero

const served = execVerify({ amountIn: dx, amountOutRealized: realized, reserveIn: x, reserveOut: y, feeTier: f });
if (!served.ok || served.mode !== 'constant-product') throw new Error('the engine refused the pool this gate is built on');

const xHat = toScaled(x), yHat = toScaled(y), dxHat = toScaled(dx), fHat = toScaled(f);
const inHat = (dxHat * (SCALE - fHat) + SCALE / 2n) / SCALE;
const denom = xHat + inHat;
const outHat = (inHat * yHat + denom / 2n) / denom;   // the engine's own expression, its own order
const certified = Number(outHat) / S;

console.log(`  pool ${(x / 1e6).toFixed(2)}M / ${(y / 1e6).toFixed(2)}M at ${(f * 1e4).toFixed(0)}bp, swapping ${dx.toLocaleString()} in`);
console.log(`  engine served honestOut ${served.honestOut} · witness certifies ${certified}`);
console.log(`  adverse execution ${served.adverseExecutionBps} bps against an honest fill\n`);

const allowed = 0.5e-8 + (1 + 2 * (y / x)) / S + Math.abs(served.honestOut) * 1e-14;
record('the certified fill is the fill the engine served, within the published precision',
  Math.abs(certified - served.honestOut) <= allowed,
  `gap ${Math.abs(certified - served.honestOut).toExponential(2)} against an allowance of ${allowed.toExponential(2)}`);

const witness = { xHat: String(xHat), yHat: String(yHat), dxHat: String(dxHat), fHat: String(fHat), inHat: String(inHat), outHat: String(outHat) };
const { proof, publicSignals, proveMs } = await proveVerifyRefuse('constantproduct', witness, { record });
const evm = await evmRehearsal('constantproduct', proof, publicSignals, { record });

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B5-2: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  accept ${evm.acceptGas} gas · reject ${evm.rejectGas} gas · proved in ${proveMs} ms`);
console.log('  NOT deployed on chain, NOT served by the endpoint');

writeFileSync(path.join(BUILD, 'gateB5-2-constantproduct-evm.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, solc: evm.solc, proveMs,
  acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), verifierBytes: evm.deployedSize,
  pool: { x, y, fee: f, dx }, servedHonestOut: served.honestOut, certifiedHonestOut: certified, publicSignals,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
