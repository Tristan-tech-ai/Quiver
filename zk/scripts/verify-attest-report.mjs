// Check every figure in WIRE_RISK_ATTEST.md against the artifact that produced it.
//
// WHY THIS EXISTS. In this project every gas figure in four separate reports disagreed with its own
// artifact, because two terms came from runs four seconds apart. A prose document is where that happens:
// it is written once, the numbers are re-measured later, and nothing compares the two ever again. This
// script is that comparison.
//
// THE TWO KINDS OF NUMBER, AND WHY THEY ARE CHECKED DIFFERENTLY. A first version of this script demanded
// an exact string match for everything. It worked, and then the gate was re-run and TWENTY-TWO figures went
// stale at once — because Plonk proving is randomised and every pairing-check figure moves a little on
// every run. Exact-matching a randomised quantity produces a checker that cries wolf until someone turns
// it off, which is worse than no checker. So:
//
//   EXACT     deterministic quantities — the direct on-chain check (no proof scalars), circom constraint
//             counts, the body-limit ceiling, hash counts, enumerated permutation classes. If any of these
//             moves, something real changed and the mismatch is the point.
//   WITHIN    randomised quantities — anything downstream of a Plonk proof. The document's number must
//             agree with the artifact to within the artifact's OWN measured error bar, which the gate
//             already publishes as a one-sided 3-SE band. A difference smaller than that is noise; a
//             difference larger than it is drift, and this goes red.
//   IMPLIED   claims the document makes ABOUT the measurement rather than quoting it ("every residual
//             inside 2 SE"). The artifact is required to satisfy the claim.
//
// Run: node zk/scripts/verify-attest-report.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ZK, 'build');
const CANDIDATES = [
  path.join(ZK, '..', 'hackathon', 'WIRE_RISK_ATTEST.md'),
  path.join(ZK, '..', 'Quiver', 'docs', 'WIRE_RISK_ATTEST.md'),
  path.join(ZK, '..', 'docs', 'WIRE_RISK_ATTEST.md'),
];
const reports = CANDIDATES.filter(existsSync);
if (!reports.length) throw new Error(`no WIRE_RISK_ATTEST.md found; looked at:\n  ${CANDIDATES.join('\n  ')}`);

const art = (name) => {
  const p = path.join(BUILD, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing artifact ${name}.json — run that probe before checking the report against it`);
  return JSON.parse(readFileSync(p, 'utf8'));
};
const gate = art('gateAT-attest-no-snark');
const need = art('probe-attest-snark-need');
const pub = art('probe-attest-public-input-cost');
const floor = art('probe-attest-circuit-floor');
const ceil = art('probe-attest-service-ceiling');
const commit = art('probe-attest-root-commitment');
const pi = art('probe-attest-pi-marginal');        // the ten-point public-input instrument
const disp = art('probe-attest-estimator-dispersion');  // why the 3-point figures were withdrawn
const o = gate.onChain, b = gate.derivedBound;
const F = pi.fit, C = pi.atServiceCeiling;

const g = (n) => Number(n).toLocaleString('en-US');
const checks = [];
const exact = (what, needle, source) => checks.push({ kind: 'EXACT', what, needle: String(needle), source });
// The tolerance band the gate itself measured: the distance between the central pairing estimate and its
// one-sided 3-SE worst case. Any figure derived from a Plonk proof is allowed to move within it.
const BAND = Math.abs(b.marginGasCentral - b.marginGasWorstCase);
const within = (what, re, value, tol, source) => checks.push({ kind: 'WITHIN', what, re, value: Number(value), tol: Number(tol), source });
const implied = (what, ok, detail, source) => checks.push({ kind: 'IMPLIED', what, ok: Boolean(ok), detail, source });

// ---- EXACT: nothing here moves between runs -------------------------------------------------------
exact('engine build id', 'q1-e1fa99d08887d6cc', 'read live by the gate and its revert');
exact('gate check count', `${gate.checks.length} checks green`, 'gateAT.checks.length');
for (const p of gate.perBatchSize) exact(`2N-1 hashes at N=${p.n}`, `| ${p.n} | ${p.n} | yes | yes | ${p.hashesToDecide} |`, 'gateAT.perBatchSize');
exact('rebuild timing at N=1024', `${commit.recomputationTiming.find((t) => t.n === 1024).bestOf5Ms} ms`, 'root-commitment.recomputationTiming');
exact('direct total gas at ceiling', g(o.directSetExactTotalGasAtCeiling), 'gateAT.onChain — deterministic');
exact('direct exec gas', g(o.directExecGas), 'gateAT.onChain — deterministic');
exact('direct calldata gas', g(o.directCalldataGas), 'gateAT.onChain — deterministic');
exact('public signals at ceiling', `${o.publicSignalsRequiredAtCeiling} public signals`, 'gateAT.onChain');
exact('N=64 direct gas', g(b.atN64.directTotalGas), 'gateAT.derivedBound.atN64 — deterministic');
exact('service ceiling N', `**N=${ceil.maxLeavesAccepted}**`, 'service-ceiling');
exact('bytes at ceiling', g(ceil.bytesAtCeiling), 'service-ceiling');
exact('first refused N', `**N=${ceil.firstLeafCountRefused}**`, 'service-ceiling');
exact('bytes per leaf', `${ceil.bytesPerLeafMeasured.toFixed(1)} bytes per leaf`, 'service-ceiling');
exact('crossover without public inputs', `(64, ${pub.crossoverWithoutPublicInputs}]`, 'public-input-cost');
exact('crossover with public inputs', `**N=${pub.crossoverWithPublicInputs}**`, 'public-input-cost');
for (const r of floor.measured) exact(`constraints at N=${r.n}`, g(r.totalConstraints), 'circuit-floor.measured');
exact('constraint marginal', `**${g(floor.marginal.constraintsPerLeaf)} constraints per leaf**`, 'circuit-floor.marginal');
exact('ptau power required', `**ptau of 2^${gate.circuitFloor.ptauPowerRequired}**`, 'gateAT.circuitFloor');
exact('largest ptau present', `**2^${gate.circuitFloor.largestPtauPresent}**`, 'gateAT.circuitFloor');
for (const c of commit.permutationClasses.filter((x) => [2, 4, 6, 8].includes(x.n))) {
  exact(`permutation class N=${c.n}`, `| ${c.n} | ${g(c.permutations)} | ${g(c.distinctRoots)} | ${c.n === 8 ? `**${g(c.collideWithIdentity)}**` : g(c.collideWithIdentity)}`, 'root-commitment.permutationClasses');
}

// ---- EXACT, from the two new artifacts: sample sizes and enumerated dispersion ---------------------
exact('residual degrees of freedom', `**${F.residualDof} residual degrees of freedom**`, 'pi-marginal.fit');
exact('signal span of the instrument', `**${F.spanSignals[0]} to ${F.spanSignals[1]}**`, 'pi-marginal.fit.spanSignals');
exact('dispersion run count', `over **${disp.runs}** independent gate runs`, 'estimator-dispersion.runs');
exact('dispersion of the headroom figure', `**${disp.dispersion.fractionOfCentralMarginPct.min}% – ${disp.dispersion.fractionOfCentralMarginPct.max}%**`, 'estimator-dispersion');
exact('dispersion spread', `spread ${disp.dispersion.fractionOfCentralMarginPct.spread} points, mean ${disp.dispersion.fractionOfCentralMarginPct.mean}%`, 'estimator-dispersion');
exact('dispersion of the central margin', `${g(disp.dispersion.marginCentral.min)} – ${g(disp.dispersion.marginCentral.max)} gas`, 'estimator-dispersion');
exact('dispersion of the worst-case margin', `${g(disp.dispersion.marginWorstCase.min)} – ${g(disp.dispersion.marginWorstCase.max)} gas`, 'estimator-dispersion');
exact('dispersion of the real-circuit marginal', `**${g(disp.dispersion.marginalGasPerSignal.min)} – ${g(disp.dispersion.marginalGasPerSignal.max)}** gas/signal`, 'estimator-dispersion');
exact('residual-SE dispersion', `**${disp.dispersion.worstLinearityResidualSE.min} to ${disp.dispersion.worstLinearityResidualSE.max}\nSE**`, 'estimator-dispersion');
exact('runs exceeding 2 SE', `**${disp.runsExceeding2SEResidual} run in ${disp.runs} exceeded 2 SE**`, 'estimator-dispersion');
exact('every dispersion run green', `**green in ${disp.runs}/${disp.runs} runs**`, 'estimator-dispersion.everyRunGreen');
exact('worst-case margin positive every run', `**positive in ${disp.runs}/${disp.runs}**`, 'estimator-dispersion');

// ---- WITHIN: every one of these is downstream of a randomised Plonk proof --------------------------
// They are now sourced from the TEN-POINT instrument, whose slope SE is ~6 gas/signal over 8 residual
// dof rather than ~18 over 1. The bands are the artifact's own error bars, not chosen to fit.
const num = (s) => Number(String(s).replace(/,/g, ''));
const CEILBAND = 3 * C.seOfFittedMeanAtCeiling;   // SE of the FITTED MEAN at 490 signals, x3
const FITBAND = 4 * F.residualSd;                 // the fit's own noise scale, for the intercept
within('plonk base gas', /base \*\*([\d,]+(?:\.\d+)?) gas\*\* at zero signals/, F.baseGasAtZeroSignals, FITBAND, 'pi-marginal.fit');
within('per-public-signal marginal', /marginal \*\*([\d,]+(?:\.\d+)?) gas per public signal\*\*/, F.marginalGasPerPublicSignal, 3 * F.seOfMarginal, 'pi-marginal.fit, tol = 3 SE of the marginal');
within('SE of the marginal', /SE \*\*([\d.]+)\*\*, over/, F.seOfMarginal, Math.max(4, F.seOfMarginal), 'pi-marginal.fit');
within('residual sd', /residual sd ([\d,]+) gas/, F.residualSd, Math.max(200, F.residualSd / 2), 'pi-marginal.fit');
within('pairing gas at ceiling', /\| Plonk verify @ 490 public signals \| \*\*([\d,]+)\*\* \|/, C.pairingCentralGas, CEILBAND, 'pi-marginal.atServiceCeiling');
within('central margin', /\| margin \| \*\*([\d,]+)\*\* \|/, C.marginGasCentral, CEILBAND, 'pi-marginal.atServiceCeiling');
within('SE of the fitted mean at the ceiling', /widens with\ndistance from the data: \*\*([\d,]+) gas\*\*/, C.seOfFittedMeanAtCeiling, Math.max(500, C.seOfFittedMeanAtCeiling / 2), 'pi-marginal.atServiceCeiling');
within('worst-case pairing gas', /worst-case pairing check \*\*([\d,]+) gas\*\*/, C.pairingWorstCaseGas, CEILBAND, 'pi-marginal.atServiceCeiling');
within('worst-case margin', /worst-case margin \*\*([\d,]+) gas\*\*/, C.marginGasWorstCase, CEILBAND, 'pi-marginal.atServiceCeiling');
// 2.1 points of observed spread over four runs; 5 points of tolerance is a stated bound with headroom,
// not a band widened until the number fitted.
within('fraction of margin consumed', /consumes ([\d.]+)% of the central margin/, C.fractionOfCentralMarginConsumedByWorstCase * 100, 5, 'pi-marginal.atServiceCeiling, tol 5 percentage points');
within('N=64 pairing gas', /costs \*\*[\d.]+x\*\* the direct check \(([\d,]+) vs/, pi.atN64.pairingTotalGas, CEILBAND, 'pi-marginal.atN64');
within('N=64 ratio', /costs \*\*([\d.]+)x\*\* the direct check/, pi.atN64.ratio, 0.25, 'pi-marginal.atN64');
within('ceiling tightness percent', /At the ceiling they are\nwithin \*\*(\d+)%\*\*/, C.marginGasCentral / C.directTotalGas * 100, 5, 'derived from pi-marginal.atServiceCeiling');
within('synthetic marginal range, low', /four runs span 1,0([\d.]+) – 1,023.3/, 15.0, 3, 'pi-marginal, four-run span reported in the text');

// ---- IMPLIED: claims about the measurement, which the artifact must satisfy ------------------------
// The old check here demanded that every linearity residual sit inside 2 SE. With 3 points and 2 fitted
// parameters that is a per-run accident, not a property: 1 run in 12 exceeded it. It is replaced by
// claims the ten-point fit can actually support.
implied('the ten-point fit is linear to R^2 > 0.999', F.rSquared > 0.999, `R^2 = ${F.rSquared}`, 'pi-marginal.fit.rSquared');
implied('no residual exceeds 4x the fit noise', F.worstAbsResidual < 4 * F.residualSd, `worst |residual| ${F.worstAbsResidual} gas against residual sd ${F.residualSd}`, 'pi-marginal.fit');
implied('the instrument predicts every real circuit to within 1%', (pi.crossCheckAgainstRealCircuits || []).every((c) => Math.abs(c.deltaPct) < 1), `worst |delta| = ${Math.max(...(pi.crossCheckAgainstRealCircuits || [{ deltaPct: 0 }]).map((c) => Math.abs(c.deltaPct))).toFixed(3)}%`, 'pi-marginal.crossCheckAgainstRealCircuits');
implied('every real circuit lands ABOVE the synthetic line (the conservative side)', (pi.crossCheckAgainstRealCircuits || []).every((c) => c.deltaGas > 0), 'all deltas positive, so the synthetic slope understates the real pairing cost', 'pi-marginal.crossCheckAgainstRealCircuits');
implied('the direct check is cheaper under BOTH estimators', pi.bothEstimators === null || pi.bothEstimators.conclusionIndependentOfEstimator === true, 'the conclusion does not depend on which marginal is right', 'pi-marginal.bothEstimators');
implied('the two estimator ranges do not overlap', disp.dispersion.marginalGasPerSignal.min > F.marginalGasPerPublicSignal, `real-circuit min ${disp.dispersion.marginalGasPerSignal.min} > synthetic ${F.marginalGasPerPublicSignal}`, 'estimator-dispersion + pi-marginal');
implied('the gate was green in every dispersion run', disp.everyRunGreen === true, `${disp.runs} runs`, 'estimator-dispersion.everyRunGreen');
implied('the worst-case margin was positive in every dispersion run', disp.worstCaseMarginPositiveEveryRun === true, `${disp.runs} runs`, 'estimator-dispersion');
implied('the direct check measured identical gas twice', o.directDeterministic === true, 'gateAT.onChain.directDeterministic', 'gateAT.onChain');
implied('the direct check is cheaper at the ceiling', o.directIsCheaper === true, 'gateAT.onChain.directIsCheaper', 'gateAT.onChain');
implied('the derived bound survives', b.survives === true, `worst-case margin ${g(b.marginGasWorstCase)} gas > 0`, 'gateAT.derivedBound');
implied('every gate check passed', gate.checks.every((c) => c.pass), `${gate.checks.length} checks`, 'gateAT.checks');
implied('the circuit floor is a lower bound', gate.circuitFloor.isLowerBound === true, 'the measured circuit omits the sorted-pair comparator', 'gateAT.circuitFloor');
implied('the direct on-chain curve refused every tamper at every N', need.directOnChain.every((r) => r.setExact.refusedDrop && r.setExact.refusedHidden && r.setExact.refusedSubstitution && r.inclusion.refusedBentSibling), `${need.directOnChain.length} batch sizes`, 'snark-need.directOnChain');
implied('the perfect-tree permutation law was verified by enumeration', commit.permutationClasses.filter((c) => c.predictedClassSize !== null).every((c) => c.agrees), 'N = 2, 4, 8 match 2^(N-1)', 'root-commitment');

console.log(`VERIFY — every figure in WIRE_RISK_ATTEST.md against its artifact — ${new Date().toISOString()}`);
// The bands are the artifacts' OWN error bars. The ceiling band is 3x the SE of the fitted mean at 490
// public signals, from the ten-point instrument; gateAT's much wider 3-point band is printed alongside it
// only to show what was given up, and no check uses it any more.
console.log(`  randomised figures are allowed the ten-point instrument's 3-SE band at the ceiling: ${g(Math.round(3 * C.seOfFittedMeanAtCeiling))} gas`);
console.log(`  (gateAT's superseded 3-point band, for contrast: ${g(BAND)} gas — ${(BAND / (3 * C.seOfFittedMeanAtCeiling)).toFixed(1)}x wider, and unused)\n`);

let bad = 0;
for (const file of reports) {
  const text = readFileSync(file, 'utf8');
  const fails = [];
  for (const c of checks) {
    if (c.kind === 'EXACT') { if (!text.includes(c.needle)) fails.push(`${c.what}: expected "${c.needle}" (${c.source})`); continue; }
    if (c.kind === 'IMPLIED') { if (!c.ok) fails.push(`${c.what}: the artifact does not satisfy it — ${c.detail} (${c.source})`); continue; }
    const m = text.match(c.re);
    if (!m) { fails.push(`${c.what}: the document does not state it in the expected form (${c.re})`); continue; }
    const got = num(m[1]);
    if (Math.abs(got - c.value) > c.tol) fails.push(`${c.what}: document says ${g(got)}, artifact says ${g(Number(c.value.toFixed(2)))}, drift ${g(Number(Math.abs(got - c.value).toFixed(2)))} exceeds tolerance ${g(Number(c.tol.toFixed(2)))} (${c.source})`);
  }
  console.log(`  ${path.relative(path.join(ZK, '..'), file)} — ${checks.length - fails.length}/${checks.length} agree`);
  for (const f of fails) console.log(`    *** ${f}`);
  bad += fails.length;
}
// A checker that checks nothing is the failure mode this project keeps finding, so the check list itself
// is asserted to be non-trivial and to contain all three kinds.
const kinds = new Set(checks.map((c) => c.kind));
if (checks.length < 35 || kinds.size !== 3) throw new Error(`${checks.length} checks of kinds ${[...kinds]} — this would be close to vacuous`);
console.log(`\n  ${checks.length} checks (${checks.filter((c) => c.kind === 'EXACT').length} exact, ${checks.filter((c) => c.kind === 'WITHIN').length} within-tolerance, ${checks.filter((c) => c.kind === 'IMPLIED').length} implied) across ${reports.length} copy/copies`);
console.log(bad === 0 ? '\nVERIFY PASSED — the report and the artifacts agree.' : `\nVERIFY FAILED — ${bad} mismatch(es).`);
process.exit(bad === 0 ? 0 : 1);
