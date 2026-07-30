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
const o = gate.onChain, b = gate.derivedBound;

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

// ---- WITHIN: every one of these is downstream of a randomised Plonk proof --------------------------
const num = (s) => Number(String(s).replace(/,/g, ''));
within('plonk base gas', /base \*\*([\d,]+(?:\.\d+)?) gas\*\* at zero signals/, o.plonkBaseGasAtZeroSignals, BAND, 'gateAT.onChain');
within('per-public-signal marginal', /marginal \*\*([\d,]+(?:\.\d+)?) gas per public signal\*\*/, o.perPublicSignalGas, 3 * b.seOfMarginalGasPerSignal, 'gateAT.onChain, tol = 3 SE of the marginal');
within('pairing gas at ceiling', /\| Plonk verify @ 490 public signals \| \*\*([\d,]+)\*\* \|/, o.plonkVerifyTotalGasAtCeiling, BAND, 'gateAT.onChain');
within('central margin', /\| margin \| \*\*([\d,]+)\*\* \|/, b.marginGasCentral, BAND, 'gateAT.derivedBound');
within('worst-case pairing gas', /worst-case pairing check \*\*([\d,]+) gas\*\*/, b.plonkVerifyTotalGasAtCeilingWorstCase, BAND, 'gateAT.derivedBound');
within('worst-case margin', /worst-case margin \*\*([\d,]+) gas\*\*/, b.marginGasWorstCase, BAND, 'gateAT.derivedBound');
within('SE of the marginal', /SE of the marginal is ([\d.]+) gas\/signal/, b.seOfMarginalGasPerSignal, Math.max(8, b.seOfMarginalGasPerSignal), 'gateAT.derivedBound');
within('fraction of margin consumed', /consumes ([\d.]+)% of the central margin/, b.fractionOfCentralMarginConsumedByWorstCase * 100, 12, 'gateAT.derivedBound, tol 12 percentage points');
within('N=64 pairing gas', /costs \*\*[\d.]+x\*\* the direct check \(([\d,]+) vs/, b.atN64.pairingTotalGas, BAND, 'gateAT.derivedBound.atN64');
within('N=64 ratio', /costs \*\*([\d.]+)x\*\* the direct check/, b.atN64.ratio, 0.25, 'gateAT.derivedBound.atN64');
within('ceiling tightness percent', /within \*\*(\d+)%\*\*/, b.marginGasCentral / o.directSetExactTotalGasAtCeiling * 100, 5, 'derived from gateAT.onChain + derivedBound');

// ---- IMPLIED: claims about the measurement, which the artifact must satisfy ------------------------
const worstResidSE = Math.max(...o.linearityResiduals.map((r) => Math.abs(r.seMultiples)));
implied('every linearity residual is inside 2 SE', worstResidSE < 2, `worst |residual| = ${worstResidSE.toFixed(2)} SE`, 'gateAT.onChain.linearityResiduals');
implied('the direct check measured identical gas twice', o.directDeterministic === true, 'gateAT.onChain.directDeterministic', 'gateAT.onChain');
implied('the direct check is cheaper at the ceiling', o.directIsCheaper === true, 'gateAT.onChain.directIsCheaper', 'gateAT.onChain');
implied('the derived bound survives', b.survives === true, `worst-case margin ${g(b.marginGasWorstCase)} gas > 0`, 'gateAT.derivedBound');
implied('every gate check passed', gate.checks.every((c) => c.pass), `${gate.checks.length} checks`, 'gateAT.checks');
implied('the circuit floor is a lower bound', gate.circuitFloor.isLowerBound === true, 'the measured circuit omits the sorted-pair comparator', 'gateAT.circuitFloor');
implied('the direct on-chain curve refused every tamper at every N', need.directOnChain.every((r) => r.setExact.refusedDrop && r.setExact.refusedHidden && r.setExact.refusedSubstitution && r.inclusion.refusedBentSibling), `${need.directOnChain.length} batch sizes`, 'snark-need.directOnChain');
implied('the perfect-tree permutation law was verified by enumeration', commit.permutationClasses.filter((c) => c.predictedClassSize !== null).every((c) => c.agrees), 'N = 2, 4, 8 match 2^(N-1)', 'root-commitment');

console.log(`VERIFY — every figure in WIRE_RISK_ATTEST.md against its artifact — ${new Date().toISOString()}`);
console.log(`  randomised figures are allowed the gate's own 3-SE band: ${g(BAND)} gas\n`);

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
