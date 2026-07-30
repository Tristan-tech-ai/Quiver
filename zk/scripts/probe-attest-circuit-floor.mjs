// If a circuit for risk-attest were built, what would it cost? Measured with real circom, not estimated.
//
// WHY THIS MATTERS TO THE DECISION. probe-attest-snark-need.mjs measured a real crossover: past roughly
// a hundred leaves, one Plonk pairing check is cheaper on chain than rebuilding the root directly. So
// "a SNARK adds nothing" is NOT true on gas alone at large N, and the honest question becomes whether a
// circuit can be built at the N where that crossover lives.
//
// The answer is decided by the hash. risk-attest commits with sha256 over packed bytes, deliberately, so
// that an on-chain verifier is a short loop on precompile 0x02. sha256 is the most expensive thing you
// can put in an arithmetic circuit. This probe compiles the actual tree circuit at N = 2, 4, 8 and reads
// the constraint counts out of the artifacts, then extrapolates to the crossover N from the MEASURED
// marginal rather than from a rule of thumb.
//
// THE CIRCUIT IS GIVEN ITS BEST CASE, on purpose. It omits the 256-bit sorted-pair comparator that
// min(a,b)/max(a,b) requires, taking the pairing order as given. Every count below is therefore a LOWER
// BOUND on the real thing. A lower bound is the right side to err on for a finding that concludes
// against building.
//
// Run: node zk/scripts/probe-attest-circuit-floor.mjs   (writes zk/build/probe-attest-circuit-floor.json)
import { writeFileSync, mkdtempSync, writeFileSync as wf, existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ZK, 'build');
const CIRCOM = path.join(ZK, 'circom.exe');
const CIRCOMLIB = path.join(ZK, 'node_modules', 'circomlib', 'circuits');
if (!existsSync(CIRCOM)) throw new Error(`circom not found at ${CIRCOM} — it is not on PATH in this tree`);
if (!existsSync(path.join(CIRCOMLIB, 'sha256', 'sha256.circom'))) throw new Error('circomlib sha256 not found');

console.log(`PROBE — the constraint floor for a risk-attest circuit — ${new Date().toISOString()}\n`);

// The tree, in circom. Leaves arrive as 256-bit words; leaf = sha256(0x00 || L) is a 264-bit preimage,
// node = sha256(0x01 || A || B) is a 520-bit preimage. Both are the service's real recipe.
const src = (n) => `pragma circom 2.0.0;
include "${path.join(CIRCOMLIB, 'sha256', 'sha256.circom').replace(/\\/g, '/')}";

// leaf = sha256(0x00 || contentHash)
template LeafHash() {
    signal input inBits[256];
    signal output out[256];
    component s = Sha256(264);
    for (var i = 0; i < 8; i++) { s.in[i] <== 0; }             // the 0x00 leaf tag
    for (var i = 0; i < 256; i++) { s.in[8 + i] <== inBits[i]; }
    for (var i = 0; i < 256; i++) { out[i] <== s.out[i]; }
}

// node = sha256(0x01 || a || b).  NO sorted-pair comparator: the order is taken as given, which makes
// every count here a lower bound on the real recipe.
template NodeHash() {
    signal input a[256];
    signal input b[256];
    signal output out[256];
    component s = Sha256(520);
    for (var i = 0; i < 7; i++) { s.in[i] <== 0; }
    s.in[7] <== 1;                                             // the 0x01 node tag
    for (var i = 0; i < 256; i++) { s.in[8 + i] <== a[i]; }
    for (var i = 0; i < 256; i++) { s.in[264 + i] <== b[i]; }
    for (var i = 0; i < 256; i++) { out[i] <== s.out[i]; }
}

// A perfect binary tree over N = ${n} leaves: N leaf hashes and N-1 node hashes.
template MerkleRoot(N) {
    signal input leaves[N][256];
    signal output root[256];
    component lh[N];
    for (var i = 0; i < N; i++) {
        lh[i] = LeafHash();
        for (var j = 0; j < 256; j++) { lh[i].inBits[j] <== leaves[i][j]; }
    }
    var width = N;
    component nh[N];
    var made = 0;
    // layer buffers, flattened: cur[k][bit]
    signal cur[2*N][256];
    for (var i = 0; i < N; i++) { for (var j = 0; j < 256; j++) { cur[i][j] <== lh[i].out[j]; } }
    var base = 0;
    var next = N;
    while (width > 1) {
        var w = 0;
        for (var i = 0; i < width; i += 2) {
            nh[made] = NodeHash();
            for (var j = 0; j < 256; j++) { nh[made].a[j] <== cur[base + i][j]; }
            for (var j = 0; j < 256; j++) { nh[made].b[j] <== cur[base + i + 1][j]; }
            for (var j = 0; j < 256; j++) { cur[next + w][j] <== nh[made].out[j]; }
            made++;
            w++;
        }
        base = next;
        next = next + w;
        width = w;
    }
    for (var j = 0; j < 256; j++) { root[j] <== cur[base][j]; }
}

component main = MerkleRoot(${n});
`;

const dir = mkdtempSync(path.join(tmpdir(), 'attest-floor-'));
const rows = [];
for (const n of [2, 4, 8]) {
  const f = path.join(dir, `tree${n}.circom`);
  wf(f, src(n));
  const t0 = Date.now();
  let out;
  try {
    out = execFileSync(CIRCOM, [f, '--r1cs', '--output', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  } catch (e) {
    console.log((e.stdout || '') + (e.stderr || ''));
    throw new Error(`circom failed at N=${n}`);
  }
  const ms = Date.now() - t0;
  // circom prints both counts, and they are DIFFERENT numbers. A regex for "linear constraints" also
  // matches "non-linear constraints", which is exactly how a wrong count gets published here, so both
  // are captured by anchored patterns and reported separately.
  const nonlinear = Number((out.match(/non-linear constraints:\s*(\d+)/) || [])[1]);
  const linear = Number((out.match(/(?:^|\n)[^\S\n]*linear constraints:\s*(\d+)/) || [])[1]);
  const pubIn = Number((out.match(/public inputs:\s*(\d+)/) || [])[1]);
  const prvIn = Number((out.match(/private inputs:\s*(\d+)/) || [])[1]);
  const wires = Number((out.match(/wires:\s*(\d+)/) || [])[1]);
  if (!Number.isFinite(nonlinear) || !Number.isFinite(linear)) {
    console.log(out);
    throw new Error(`could not read both constraint counts at N=${n} — refusing to publish a half-read number`);
  }
  // The .r1cs count snarkjs would report is the total the proving key is built for.
  const total = nonlinear + linear;
  rows.push({ n, sha256Blocks: null, nonLinearConstraints: nonlinear, linearConstraints: linear, totalConstraints: total, publicInputs: pubIn, privateInputs: prvIn, wires, compileMs: ms });
  console.log(`  N=${String(n).padStart(2)}  non-linear ${String(nonlinear).padStart(9)}  linear ${String(linear).padStart(8)}  total ${String(total).padStart(9)}  wires ${String(wires).padStart(9)}  compiled in ${(ms / 1000).toFixed(1)}s`);
}

// ---- the marginal, and the extrapolation to the crossover ----------------------------------------
// Each doubling of N adds N leaf hashes and N-1 node hashes, so the count is linear in N. Read the
// per-leaf marginal off the last measured interval instead of fitting a curve to three points.
const a = rows[rows.length - 2], b = rows[rows.length - 1];
const perLeaf = (b.totalConstraints - a.totalConstraints) / (b.n - a.n);
const intercept = b.totalConstraints - perLeaf * b.n;
const at = (n) => Math.round(perLeaf * n + intercept);

// The crossover N comes from the gas probe's own artifact, not from a number typed in here.
let crossoverN = null, crossoverBasis = 'zk/build/probe-attest-snark-need.json missing — run that probe first';
const gasArtifact = path.join(BUILD, 'probe-attest-snark-need.json');
if (existsSync(gasArtifact)) {
  const g = JSON.parse(readFileSync(gasArtifact, 'utf8'));
  crossoverN = g.crossover.n;
  crossoverBasis = `read from probe-attest-snark-need.json (measured ${g.crossover.measuredInRange})`;
}

console.log(`\n  measured marginal: ${perLeaf.toFixed(0)} constraints per leaf (from N=${a.n} to N=${b.n})`);
for (const n of [8, 16, 64, 97, 128, 1024]) console.log(`    N=${String(n).padStart(4)}  ~${at(n).toLocaleString()} constraints`);

// Plonk in snarkjs needs a power-of-two domain of at least nConstraints + nPublic, and the setup needs
// a ptau of that power. State the power, and the largest ptau this project has actually used, so the
// gap is a fact about available artifacts rather than an opinion about difficulty.
const powerFor = (c) => Math.ceil(Math.log2(c));
const ptauHere = readdirSync(BUILD).filter((f) => /ptau$/.test(f));

const need = crossoverN ? at(crossoverN) : null;
const artifact = {
  at: new Date().toISOString(),
  passed: true,
  question: 'A real gas crossover exists past ~100 leaves. Can a circuit be built at that N?',
  circuitIsGivenItsBestCase: 'No sorted-pair comparator: min(a,b)/max(a,b) over 256 bits is omitted and the pairing order is taken as given. Every count is a LOWER BOUND on the published recipe.',
  hashIsTheConstraint: 'risk-attest commits with sha256 over packed bytes so that an on-chain verifier is a short loop on precompile 0x02. sha256 is the most expensive primitive to put in an arithmetic circuit; a Poseidon commitment would be ~2 orders of magnitude cheaper in-circuit but has no precompile and would cost far more on chain, which is the trade the engine already made.',
  measured: rows,
  marginal: { constraintsPerLeaf: Math.round(perLeaf), interceptConstraints: Math.round(intercept), fromN: a.n, toN: b.n },
  extrapolated: Object.fromEntries([8, 16, 64, 97, 128, 1024].map((n) => [n, at(n)])),
  crossover: { n: crossoverN, basis: crossoverBasis, constraintsAtCrossover: need, plonkPtauPowerRequired: need ? powerFor(need) : null },
  ptauFilesPresentInBuild: ptauHere,
  note: 'Constraint counts are read from circom stdout with anchored patterns for BOTH "non-linear constraints" and "linear constraints", because a regex for the latter also matches the former and that is how a wrong count gets published. Values beyond N=8 are extrapolations from the measured marginal and are labelled as such.',
};
writeFileSync(path.join(BUILD, 'probe-attest-circuit-floor.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  at the measured crossover N=${crossoverN}: ~${need ? need.toLocaleString() : '?'} constraints, needing a Plonk ptau of 2^${need ? powerFor(need) : '?'}`);
console.log(`  ptau files present in zk/build: ${ptauHere.length ? ptauHere.join(', ') : 'none'}`);
console.log(`\n  artifact zk/build/probe-attest-circuit-floor.json`);
