// GATE B5-5 — a contract accepts the HEADLINE proof and refuses a tampered one, in a real EVM.
//
// The trade comes from the REAL execVerify engine, so the contract accepts a statement about an answer
// the service would have sold. Nothing is deployed and nothing is served.
//
// The comparison that matters here is against gate B5-2, which did the same for the benchmark alone.
// Plonk's proof is constant-size and its verifier cost moves only with the number of public inputs, so
// the five extra signals that carry the fill, the shortfall and the headline are the whole marginal
// cost of proving the number the service leads with. That delta is measured below, not asserted.
//
// Run: node zk/scripts/gateB5-5-execadverse-evm.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, FIELD, toScaled, checklist, proveVerifyRefuse, evmRehearsal, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { execVerify } = await load(import.meta.url, 'engine/execVerify.js');
const { round } = await load(import.meta.url, 'engine/stats.js');

const { record, failed } = checklist();
console.log(`GATE B5-5 — the headline verifier in an EVM — ${new Date().toISOString()}\n`);

// The same pool gate B5-2 used, so the two gas figures are comparable, and a fill 32 bps worse than
// honest — inside a 1% slippage tolerance and still robbed, which is the case the service exists for.
const x = 1_500_000, y = 3_750_000, f = 0.003, dx = 15_000, realized = 36_900;

const served = execVerify({ amountIn: dx, amountOutRealized: realized, reserveIn: x, reserveOut: y, feeTier: f, slippageTolerancePct: 1.0 });
if (!served.ok || served.mode !== 'constant-product') throw new Error('the engine refused the pool this gate is built on');

const xHat = toScaled(x), yHat = toScaled(y), dxHat = toScaled(dx), fHat = toScaled(f), realizedHat = toScaled(realized);
const inHat = (dxHat * (SCALE - fHat) + SCALE / 2n) / SCALE;
const denom = xHat + inHat;
const outHat = (inHat * yHat + denom / 2n) / denom;
const sHat = outHat - realizedHat;
const num = 10000n * SCALE * sHat;
const bpsHat = (num * 2n / outHat + (num < 0n ? -1n : 1n)) / 2n;
const asField = (v) => String(v < 0n ? FIELD + v : v);

console.log(`  pool ${(x / 1e6).toFixed(2)}M / ${(y / 1e6).toFixed(2)}M at ${(f * 1e4).toFixed(0)}bp, swapping ${dx.toLocaleString()} in, filled at ${realized.toLocaleString()}`);
console.log(`  engine: adverseExecutionBps ${served.adverseExecutionBps} · adverseValueOut ${served.adverseValueOut} · within tolerance ${served.slippageTolerance.withinTolerance}`);
console.log(`  witness certifies ${Number(bpsHat) / S} bps and a shortfall of ${Number(sHat) / S} output tokens\n`);

record('the certified headline rounds to the headline the engine published',
  round(Number(bpsHat) / S, 2) === served.adverseExecutionBps,
  `round(${Number(bpsHat) / S}, 2) = ${round(Number(bpsHat) / S, 2)} · engine ${served.adverseExecutionBps}`);
record('the certified shortfall IS the shortfall the engine published',
  round(Number(sHat) / S, 8) === served.adverseValueOut,
  `${Number(sHat) / S} output tokens · engine ${served.adverseValueOut}`);

const witness = {
  xHat: String(xHat), yHat: String(yHat), dxHat: String(dxHat), fHat: String(fHat),
  inHat: String(inHat), outHat: String(outHat), realizedHat: String(realizedHat), bpsHat: asField(bpsHat),
};
const { proof, publicSignals, proveMs } = await proveVerifyRefuse('execadverse', witness, { record });
const evm = await evmRehearsal('execadverse', proof, publicSignals, { record });

// The marginal cost of the headline, against the benchmark-only verifier — read from B5-2's artifact if
// it is there, rather than copied in as a number.
const b52Path = path.join(BUILD, 'gateB5-2-constantproduct-evm.json');
let delta = null;
if (existsSync(b52Path)) {
  const b52 = JSON.parse(readFileSync(b52Path, 'utf8'));
  delta = {
    benchmarkAcceptGas: Number(b52.acceptGas), headlineAcceptGas: Number(evm.acceptGas),
    gas: Number(evm.acceptGas) - Number(b52.acceptGas),
    benchmarkBytes: b52.verifierBytes, headlineBytes: evm.deployedSize,
    bytes: evm.deployedSize - b52.verifierBytes,
  };
  console.log(`\n  against gate B5-2's benchmark-only verifier: ${delta.benchmarkAcceptGas} -> ${delta.headlineAcceptGas} gas (${delta.gas >= 0 ? '+' : ''}${delta.gas}), ${delta.benchmarkBytes} -> ${delta.headlineBytes} bytes`);
  record('the headline costs a bounded amount of on-chain gas over the benchmark alone',
    delta.gas > 0 && delta.gas < 60000,
    `${delta.gas} gas for five more public signals, on a ${delta.benchmarkAcceptGas}-gas baseline = ${(100 * delta.gas / delta.benchmarkAcceptGas).toFixed(1)}% more`);
} else {
  record('gate B5-2 has been run, so the marginal cost can be measured', false, `${b52Path} not found — run gateB5-2 first`);
}

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B5-5: ${gate ? 'PASSED' : `FAILED — ${bad.map((v) => v.name).join('; ')}`}`);
console.log(`  accept ${evm.acceptGas} gas · reject ${evm.rejectGas} gas · proved in ${proveMs} ms`);
console.log('  NOT deployed on chain, NOT served by the endpoint');

writeFileSync(path.join(BUILD, 'gateB5-5-execadverse-evm.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, solc: evm.solc, proveMs,
  acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), verifierBytes: evm.deployedSize,
  pool: { x, y, fee: f, dx, realized },
  servedAdverseBps: served.adverseExecutionBps, certifiedBps: Number(bpsHat) / S,
  servedAdverseValueOut: served.adverseValueOut, certifiedShortfall: Number(sHat) / S,
  marginalOverBenchmark: delta, publicSignals,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
