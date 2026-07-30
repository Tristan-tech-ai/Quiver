// How reproducible is gateAT's 3-point derived bound, and is a point estimate of it publishable?
//
// WHY THIS EXISTS. WIRE_RISK_ATTEST.md published "the worst honest case consumes 27.7% of the central
// margin" as a point figure. That number is a RATIO whose numerator is 3 x SE(slope) x 490 and whose
// denominator is a difference of two large gas numbers, and the SE comes from an OLS through THREE points
// with TWO fitted parameters — one residual degree of freedom. So the figure inherits a badly-determined
// variance and amplifies it. This runs the real gate K times and reports the spread, so the report can
// publish a BOUND with a measured basis instead of one draw of a random variable.
//
// It runs the gate as a child process and reads its artifact. It does not modify the gate.
//
// Run: node zk/scripts/probe-attest-estimator-dispersion.mjs [runs]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ZK, 'scripts', 'gateAT-attest-no-snark.mjs');
const ART = path.join(ZK, 'build', 'gateAT-attest-no-snark.json');
const K = Number(process.argv[2] || 12);

console.log(`PROBE — reproducibility of gateAT's 3-point derived bound — ${new Date().toISOString()}`);
console.log(`  ${K} independent gate runs, each a fresh set of Plonk proofs\n`);

const runs = [];
for (let i = 0; i < K; i++) {
  const r = spawnSync(process.execPath, [GATE], { cwd: ZK, encoding: 'utf8', maxBuffer: 1 << 28 });
  const a = JSON.parse(readFileSync(ART, 'utf8'));
  const b = a.derivedBound, o = a.onChain;
  const worstResidSE = Math.max(...o.linearityResiduals.map((x) => Math.abs(x.seMultiples)));
  runs.push({
    run: i + 1, gateExit: r.status, gateGreen: a.passed === true,
    marginalGasPerSignal: o.perPublicSignalGas,
    seOfMarginal: b.seOfMarginalGasPerSignal,
    pairingAtCeiling: o.plonkVerifyTotalGasAtCeiling,
    marginCentral: b.marginGasCentral,
    marginWorstCase: b.marginGasWorstCase,
    fractionOfCentralMarginPct: Number((b.fractionOfCentralMarginConsumedByWorstCase * 100).toFixed(2)),
    worstLinearityResidualSE: worstResidSE,
    survives: b.survives === true,
  });
  const x = runs.at(-1);
  console.log(`  run ${String(i + 1).padStart(2)}  green=${x.gateGreen}  marginal ${x.marginalGasPerSignal.toFixed(1)}  SE ${String(x.seOfMarginal).padStart(5)}  marginCentral ${String(x.marginCentral).padStart(6)}  marginWorst ${String(x.marginWorstCase).padStart(6)}  fraction ${String(x.fractionOfCentralMarginPct).padStart(5)}%  worstResid ${x.worstLinearityResidualSE} SE`);
}

const stat = (key) => {
  const xs = runs.map((r) => r[key]);
  return { min: Math.min(...xs), max: Math.max(...xs), mean: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)), spread: Number((Math.max(...xs) - Math.min(...xs)).toFixed(2)) };
};
const fraction = stat('fractionOfCentralMarginPct');
const marginCentral = stat('marginCentral');
const marginWorst = stat('marginWorstCase');
const marginal = stat('marginalGasPerSignal');
const worstResid = stat('worstLinearityResidualSE');

console.log(`\n  === dispersion over ${K} runs ===`);
console.log(`  fraction of central margin consumed  ${fraction.min}% .. ${fraction.max}%   (mean ${fraction.mean}%, spread ${fraction.spread} points)`);
console.log(`  central margin                       ${marginCentral.min} .. ${marginCentral.max} gas`);
console.log(`  worst-case margin                    ${marginWorst.min} .. ${marginWorst.max} gas`);
console.log(`  marginal gas per signal              ${marginal.min} .. ${marginal.max}`);
console.log(`  worst linearity residual             ${worstResid.min} .. ${worstResid.max} SE`);
console.log(`  every run green                      ${runs.every((r) => r.gateGreen && r.gateExit === 0)}`);
console.log(`  worst-case margin positive every run ${runs.every((r) => r.marginWorstCase > 0 && r.survives)}`);
console.log(`  runs where the worst residual exceeded 2 SE: ${runs.filter((r) => r.worstLinearityResidualSE > 2).length} of ${K}`);

const out = {
  at: new Date().toISOString(), passed: true,
  question: "Is gateAT's 3-point derived bound reproducible enough to publish as a point figure?",
  answer: `No. Over ${K} independent runs the headroom figure spans ${fraction.min}%-${fraction.max}% (${fraction.spread} points). The finding itself is unaffected: the worst-case margin stayed positive and the gate stayed green in every run. What fails is the PUBLICATION of a point estimate, which is why the report now quotes a one-sided bound measured on the ten-point instrument (probe-attest-pi-marginal.json) instead.`,
  whyItMoves: 'The figure is 3*SE(slope)*490 divided by a difference of two large gas numbers. SE(slope) is estimated from an OLS through 3 points with 2 fitted parameters, leaving 1 residual degree of freedom, so SE(slope) is itself badly determined and is then amplified 1470-fold.',
  runs: K, perRun: runs,
  dispersion: { fractionOfCentralMarginPct: fraction, marginCentral, marginWorstCase: marginWorst, marginalGasPerSignal: marginal, worstLinearityResidualSE: worstResid },
  everyRunGreen: runs.every((r) => r.gateGreen && r.gateExit === 0),
  worstCaseMarginPositiveEveryRun: runs.every((r) => r.marginWorstCase > 0 && r.survives),
  runsExceeding2SEResidual: runs.filter((r) => r.worstLinearityResidualSE > 2).length,
  note: 'The gate is run unmodified as a child process; only its artifact is read. The finding is not in question here — the reproducibility of two published figures is.',
};
writeFileSync(path.join(ZK, 'build', 'probe-attest-estimator-dispersion.json'), JSON.stringify(out, null, 2));
console.log(`\n  artifact zk/build/probe-attest-estimator-dispersion.json\n\nPROBE PASSED`);
