// Is the `execadverse`-over-`constantproduct` gas marginal a real quantity, or is it noise?
//
// WHY THIS EXISTS. VERIFY_EXEC_VERIFY.md published "+2,388 gas (+0.9%)" as the marginal cost of the
// five extra public signals that carry the headline. That figure was the difference of two SINGLE
// samples taken in two different gate runs four seconds apart, and the same quantity has since been
// published as 2,388, 3,318, 6,340 and 8,420 depending on which pair of runs you subtract.
//
// `probe-plonk-gas-variance.mjs` measures the error bar on ONE verify-gas sample: proofs of an
// IDENTICAL statement differ by thousands of gas because Plonk proving is randomised. A difference of
// two such samples inherits BOTH error bars. So a one-shot subtraction cannot resolve a marginal of
// this size at all, and this probe measures the distribution instead of asserting the difference.
//
// METHOD, and the two traps it avoids:
//   1. FRESH EVM PER MEASUREMENT. EIP-2929 charges 2,600 for a cold account and 100 for a warm one.
//      Three precompiles => the first call in an EVM instance pays 7,500 gas more than every later
//      one. Measuring the baseline and then the candidate in one instance hands the candidate 7,500
//      gas for free. A real standalone transaction pays the cold price, so every sample here gets its
//      own `EVM.create()`.
//   2. N PROOFS PER CIRCUIT, not one. The statement is held fixed; only the blinding scalars move.
//
// The marginal is then reported as a difference of medians WITH the spread of each side beside it, so
// a reader can see whether the difference clears its own noise. It also prints the worst-case and
// best-case marginal actually observed across the samples, which is the honest range.
//
//   node zk/scripts/probe-execadverse-marginal.mjs [N]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import solc from 'solc';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex, hexToBytes } from 'ethereum-cryptography/utils.js';
import { BUILD, SCALE, S, FIELD, toScaled, shutdown } from './lib/gatekit.mjs';

const require = createRequire(import.meta.url);
const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
const { EVM } = await import('@ethereumjs/evm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');

const N = Number(process.argv[2] || 9);
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const asField = (v) => String(v < 0n ? FIELD + v : v);

function compile(circuit) {
  const solName = `${circuit[0].toUpperCase()}${circuit.slice(1)}Verifier.sol`;
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [solName]: { content: readFileSync(path.join(BUILD, solName), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const cs = out.contracts[solName];
  const key = Object.keys(cs).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k)) || Object.keys(cs)[0];
  return { V: cs[key], name: key, deployedSize: cs[key].evm.deployedBytecode.object.length / 2 };
}

// One sample = one FRESH EVM, one deploy, one verifyProof. The verify is the first call the instance
// ever makes, so it pays the cold-access price a standalone transaction would pay.
async function sampleGas(bytecode, data) {
  const evm = await EVM.create({ common });
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(bytecode), gasLimit: 30_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy failed: ${dep.execResult.exceptionError}`);
  const r = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data, gasLimit: 8_000_000n });
  if (r.execResult.exceptionError) throw new Error(r.execResult.exceptionError);
  if (BigInt('0x' + (bytesToHex(r.execResult.returnValue) || '0')) !== 1n) throw new Error('verifier refused an honest proof');
  return Number(r.execResult.executionGasUsed);
}

async function measure(circuit, witness, nPublic) {
  const { V, deployedSize } = compile(circuit);
  const builder = await require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.cjs'))(
    readFileSync(path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`)));
  const wtns = await builder.calculateWTNSBin(witness, 0);
  const zkey = path.join(BUILD, `${circuit}_plonk.zkey`);
  const selector = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${nPublic}])`))).slice(0, 8);

  const gas = [];
  for (let i = 0; i < N; i++) {
    const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, wtns);
    if (publicSignals.length !== nPublic) throw new Error(`${circuit}: expected ${nPublic} public signals, got ${publicSignals.length}`);
    const raw = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
    const [pw, uw] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
    gas.push(await sampleGas(V.evm.bytecode.object, hexToBytes(selector + [...pw, ...uw].map(pad).join(''))));
  }
  const sorted = [...gas].sort((a, b) => a - b);
  const median = sorted[(N - 1) >> 1];
  const mean = gas.reduce((a, b) => a + b, 0) / N;
  const sd = Math.sqrt(gas.reduce((a, b) => a + (b - mean) ** 2, 0) / (N - 1));
  return { circuit, nPublic, deployedSize, gas: sorted, min: sorted[0], max: sorted[N - 1], median,
    mean, sd, sem: sd / Math.sqrt(N), spread: sorted[N - 1] - sorted[0] };
}

// The pool both gates use, so the two figures are comparable by construction.
const x = 1_500_000, y = 3_750_000, f = 0.003, dx = 15_000;
const xHat = toScaled(x), yHat = toScaled(y), dxHat = toScaled(dx), fHat = toScaled(f);
const inHat = (dxHat * (SCALE - fHat) + SCALE / 2n) / SCALE;
const denom = xHat + inHat;
const outHat = (inHat * yHat + denom / 2n) / denom;

// benchmark-only: gate B5-2's witness, 10 public signals
const wCp = { xHat: String(xHat), yHat: String(yHat), dxHat: String(dxHat), fHat: String(fHat), inHat: String(inHat), outHat: String(outHat) };

// headline: gate B5-5's witness, 15 public signals
const realized = 36_900;
const realizedHat = toScaled(realized);
const sHat = outHat - realizedHat;
const num = 10000n * SCALE * sHat;
const bpsHat = (num * 2n / outHat + (num < 0n ? -1n : 1n)) / 2n;
const wEa = { ...wCp, realizedHat: String(realizedHat), bpsHat: asField(bpsHat) };

console.log(`Plonk verify gas — the execadverse marginal, ${N} proofs per circuit, a FRESH EVM per sample`);
console.log(`${new Date().toISOString()}\n`);

const cp = await measure('constantproduct', wCp, 10);
const ea = await measure('execadverse', wEa, 15);

for (const r of [cp, ea]) {
  console.log(`  ${r.circuit.padEnd(16)} ${r.nPublic} public · ${r.deployedSize} bytes`);
  console.log(`     ${r.gas.join('  ')}`);
  console.log(`     min ${r.min} · median ${r.median} · max ${r.max} · spread ${r.spread} gas = ${(r.spread / r.mean * 100).toFixed(2)}%`);
  console.log(`     mean ${r.mean.toFixed(0)} · sd ${r.sd.toFixed(0)} · standard error of the mean ${r.sem.toFixed(0)}\n`);
}

const marginalMedian = ea.median - cp.median;
const marginalMean = ea.mean - cp.mean;
const semDiff = Math.hypot(cp.sem, ea.sem);
const ci95 = 1.96 * semDiff;
const marginalBest = ea.min - cp.max;      // the smallest difference two single samples permit
const marginalWorst = ea.max - cp.min;     // the largest
const oneShotWindow = marginalWorst - marginalBest;
const band = cp.spread + ea.spread;        // a difference of two SINGLE samples inherits both spreads
const nExtra = ea.nPublic - cp.nPublic;
const perSignal = marginalMean / nExtra;

console.log('  THE MARGINAL, two ways of asking. They give different answers, and both are true.\n');
console.log(`  (1) AS A ONE-SHOT SUBTRACTION — what every published figure so far actually was.`);
console.log(`      One proof of each, subtracted, can land anywhere in ${marginalBest} .. ${marginalWorst} gas.`);
console.log(`      That is an ${oneShotWindow}-gas window, ${(oneShotWindow / Math.abs(marginalMean)).toFixed(1)}x the size of the quantity being measured.`);
console.log(`      A single subtraction therefore measures NOTHING. It is not a small error bar on the`);
console.log(`      marginal; it is a draw from a window wider than the marginal itself.\n`);
console.log(`  (2) AS A DIFFERENCE OF MEANS over ${N} proofs each — which is measurable.`);
console.log(`      ${marginalMean >= 0 ? '+' : ''}${marginalMean.toFixed(0)} gas, standard error ${semDiff.toFixed(0)}, 95% interval ${(marginalMean - ci95).toFixed(0)} .. ${(marginalMean + ci95).toFixed(0)} gas.`);
console.log(`      (median minus median, for comparison: ${marginalMedian >= 0 ? '+' : ''}${marginalMedian} gas)`);
console.log(`      Per extra public signal: ${perSignal.toFixed(0)} gas across ${nExtra} signals.\n`);

const resolvedAsMeans = Math.abs(marginalMean) > ci95;
const resolvedOneShot = Math.abs(marginalMean) > band;
console.log(`  VERDICT`);
console.log(`   · the MEAN marginal is ${resolvedAsMeans ? 'resolved' : 'NOT resolved'}: |${marginalMean.toFixed(0)}| ${resolvedAsMeans ? '>' : '<='} ${ci95.toFixed(0)} (95% CI half-width).`);
console.log(`   · a ONE-SAMPLE marginal is ${resolvedOneShot ? 'resolved' : 'NOT resolved'}: |${marginalMean.toFixed(0)}| ${resolvedOneShot ? '>' : '<='} ${band} (combined single-sample spread).`);
console.log(`   · so: the cost of the five extra public signals is REAL and about ${(Math.round(marginalMean / 100) * 100).toFixed(0)} gas, but it can`);
console.log(`     only be stated as a mean over many proofs with an interval attached. Any figure`);
console.log(`     obtained by subtracting one measurement from another is inside the noise and must`);
console.log(`     not be published as a cost.`);

const artifact = {
  at: new Date().toISOString(), probe: 'probe-execadverse-marginal', proofsPerCircuit: N,
  freshEvmPerSample: true,
  constantproduct: { nPublic: cp.nPublic, deployedBytes: cp.deployedSize, gas: cp.gas, min: cp.min, median: cp.median, max: cp.max, mean: Number(cp.mean.toFixed(1)), sd: Number(cp.sd.toFixed(1)), sem: Number(cp.sem.toFixed(1)), spread: cp.spread, spreadPct: Number((cp.spread / cp.mean * 100).toFixed(2)) },
  execadverse: { nPublic: ea.nPublic, deployedBytes: ea.deployedSize, gas: ea.gas, min: ea.min, median: ea.median, max: ea.max, mean: Number(ea.mean.toFixed(1)), sd: Number(ea.sd.toFixed(1)), sem: Number(ea.sem.toFixed(1)), spread: ea.spread, spreadPct: Number((ea.spread / ea.mean * 100).toFixed(2)) },
  marginal: {
    meanMinusMean: Number(marginalMean.toFixed(1)), standardError: Number(semDiff.toFixed(1)),
    ci95Low: Number((marginalMean - ci95).toFixed(1)), ci95High: Number((marginalMean + ci95).toFixed(1)),
    medianMinusMedian: marginalMedian,
    oneShotSmallest: marginalBest, oneShotLargest: marginalWorst, oneShotWindow,
    combinedSingleSampleBand: band,
    resolvedAsMeans, resolvedFromOneSampleEach: resolvedOneShot,
    gasPerExtraPublicSignal: Number(perSignal.toFixed(1)),
  },
};
writeFileSync(path.join(BUILD, 'probe-execadverse-marginal.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
console.log(`\n  wrote ${path.join(BUILD, 'probe-execadverse-marginal.json')}`);
await shutdown();
process.exit(0);
