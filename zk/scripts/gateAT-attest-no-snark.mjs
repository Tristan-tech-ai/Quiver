// GATE AT — risk-attest needs no SNARK, and this is the gate that goes red if that stops being true.
//
// WHAT THE FINDING IS. risk-attest publishes a Merkle root, per-item inclusion proofs, AND the complete
// leaf set (`attestations[].contentHash`, indices 0..n-1). An inclusion proof can only ever say "this
// leaf is in the tree", so on its own it cannot say "nothing was dropped" or "nothing was hidden" —
// which is why set-exactness looked like the statement worth a circuit. But because the leaf set is
// published in full, set-exactness is a RECOMPUTATION: 2N-1 sha256 calls either land on the root or they
// do not. There is nothing to hide and nothing to compress, so the two things a SNARK sells — privacy
// and succinctness — are both already spent before a circuit is written.
//
// WHY THIS IS A GATE AND NOT A NOTE. The finding rests on one property of the response that a future
// change could silently remove: that every leaf is published. If `attestations` were ever trimmed to
// save bytes, set-exactness would stop being checkable and a circuit would start being worth something.
// So that property is asserted here, at several batch sizes, together with the tamper matrix that proves
// the recomputation is a real check rather than a function that returns true.
//
// AND THE HONEST CAVEAT, MEASURED RATHER THAN WAVED AWAY. A gas crossover does exist: past a few hundred
// leaves a pairing check would be cheaper on chain than rebuilding the root. This gate pins the crossover
// against the service's OWN measured batch ceiling and against the circuit's measured constraint floor,
// so the conclusion is "unreachable here", with the numbers attached, instead of "small".
//
// Run: node zk/scripts/gateAT-attest-no-snark.mjs        (writes zk/build/gateAT-attest-no-snark.json)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BUILD, snarkjs, shutdown, checklist } from './lib/gatekit.mjs';
import { load, serviceRoot } from './service-root.mjs';

const require = createRequire(import.meta.url);
const { record, failed, results } = checklist();
const { riskAttest } = await load(import.meta.url, 'engine/riskAttest.js');
const { url: SRC, label } = serviceRoot(import.meta.url);

console.log(`GATE AT — risk-attest needs no SNARK — ${new Date().toISOString()}`);
console.log(`  service source: ${label}\n`);

// ---------------------------------------------------------------------------------------------------
// THE COUNTERPARTY'S CHECKER. Nothing is imported from the engine below this line: the question is what
// a party holding one RESPONSE can decide, and such a party does not have the engine. Every constant is
// quoted from the response's own published `algorithm` and `verify` strings.
// ---------------------------------------------------------------------------------------------------
let hashCount = 0;
const sha = (b) => { hashCount++; return createHash('sha256').update(b).digest('hex'); };
const bare = (hex) => String(hex).replace(/^0x/, '').toLowerCase();
const raw = (hex) => Buffer.from(bare(hex), 'hex');
const leafH = (hex) => sha(Buffer.concat([Buffer.from([0x00]), raw(hex)]));
// NORMALISE BEFORE COMPARING. The published recipe sorts the pair "comparing as byte strings", and the
// response prints siblings 0x-prefixed while an intermediate fold is bare hex. Comparing '0x8f...'
// against 'ce...' orders on the prefix, which silently picks the wrong argument order for a subset of
// pairs — the first run of this gate failed exactly here, on every inclusion proof it checked. Both
// arguments are stripped and lowercased first, so the comparison is over the same alphabet on both sides.
const nodeH = (a, b) => {
  const [x, y] = [bare(a), bare(b)];
  const [lo, hi] = x <= y ? [x, y] : [y, x];
  return sha(Buffer.concat([Buffer.from([0x01]), raw(lo), raw(hi)]));
};
function rootOver(list) {
  let layer = list.map(leafH);
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? nodeH(layer[i], layer[i + 1]) : layer[i]);
    layer = next;
  }
  return layer[0];
}
function inclusionHolds(leaf, proof, root) {
  let h = leafH(leaf);
  for (const s of proof) h = nodeH(h, s);
  return h === String(root).replace(/^0x/, '').toLowerCase();
}
// SET-EXACTNESS, from the response and nothing else. Answers "is this root the root over exactly the
// leaves this response lists?" — which is both halves an inclusion proof cannot reach.
export function setExactFromResponse(resp) {
  const list = resp.attestations.slice().sort((a, b) => a.index - b.index).map((a) => a.contentHash);
  if (list.length !== resp.leafCount) return { ok: false, why: 'leafCount disagrees with the published attestation list' };
  if (resp.attestations.some((a, i) => a.index !== i)) return { ok: false, why: 'indices are not 0..n-1' };
  if (list.some((c) => !/^0x[0-9a-f]{64}$/.test(String(c)))) return { ok: false, why: 'a published leaf is not a 32-byte hex word' };
  if (('0x' + rootOver(list)) !== resp.merkleRoot) return { ok: false, why: 'the root is NOT the root of the published leaf set' };
  return { ok: true, why: 'the root is the root over exactly the published leaves' };
}

const h = (s) => createHash('sha256').update(s).digest('hex');
const batch = (n, tag = 'g') => Array.from({ length: n }, (_, i) => h(tag + i));

// ---- 1. the premise: the response publishes its whole leaf set -------------------------------------
// This is the load-bearing property. Assert it across shapes that exercise the odd-promotion path
// (1, 3, 5, 13 are not powers of two) as well as perfect trees.
const SIZES = [1, 2, 3, 5, 8, 13, 64];
let premiseOk = true, rebuildOk = true;
const perN = [];
for (const N of SIZES) {
  const r = riskAttest({ contentHashes: batch(N) });
  if (!r.ok) { premiseOk = false; break; }
  const publishes = r.attestations.length === N && r.leafCount === N && r.attestations.every((a, i) => a.index === i && /^0x[0-9a-f]{64}$/.test(a.contentHash));
  hashCount = 0;
  const se = setExactFromResponse(r);
  const hashes = hashCount;
  const incl = r.attestations.every((a) => inclusionHolds(a.contentHash, a.proof, r.merkleRoot));
  perN.push({ n: N, publishesEveryLeaf: publishes, setExact: se.ok, hashesToDecide: hashes, expectedHashes: 2 * N - 1, allInclusionProofsHold: incl });
  if (!publishes) premiseOk = false;
  if (!se.ok || !incl) rebuildOk = false;
}
record('every response publishes its COMPLETE leaf set (indices 0..n-1, each a 32-byte word)', premiseOk,
  `checked N = ${SIZES.join(', ')}`);
record('set-exactness is decided from the published response alone, in 2N-1 sha256 calls', rebuildOk && perN.every((p) => p.hashesToDecide === p.expectedHashes),
  perN.map((p) => `N=${p.n}:${p.hashesToDecide}`).join(' '));

// ---- 2. the checker must be able to FAIL ----------------------------------------------------------
// A recomputation that returns true is worth nothing, so every way a root can misrepresent its set is
// run through it. The `hidden` case is the important one: it is the property an inclusion proof
// provably cannot establish, and the column showing the served proofs STILL all pass is the evidence.
const N0 = 8;
const eight = batch(N0, 'tamper');
const honest = riskAttest({ contentHashes: eight });
const dropped = riskAttest({ contentHashes: eight.slice(0, N0 - 1) });
const hidden = riskAttest({ contentHashes: [...eight, h('HIDDEN')] });

const tampers = [
  ['a leaf is listed but the root omits it', { ...dropped, leafCount: N0, attestations: [...dropped.attestations, honest.attestations[N0 - 1]] }],
  ['the root covers a leaf the response never lists', { ...hidden, leafCount: N0, attestations: hidden.attestations.slice(0, N0) }],
  ['a listed leaf is substituted', { ...honest, attestations: honest.attestations.map((a, i) => (i === 3 ? { ...a, contentHash: '0x' + h('SUBSTITUTED') } : a)) }],
  ['leafCount is inflated', { ...honest, leafCount: N0 + 1 }],
  ['the root is replaced wholesale', { ...honest, merkleRoot: '0x' + h('OTHER ROOT') }],
];
let refusedAll = true;
const tamperRows = [];
for (const [name, resp] of tampers) {
  const se = setExactFromResponse(resp);
  const inclAll = resp.attestations.every((a) => inclusionHolds(a.contentHash, a.proof, resp.merkleRoot));
  tamperRows.push({ tamper: name, setExactRefused: !se.ok, why: se.why, servedInclusionProofsAllStillPass: inclAll });
  if (se.ok) refusedAll = false;
  console.log(`    ${(!se.ok ? 'refused' : 'ACCEPTED').padEnd(9)} ${name.padEnd(48)} inclusion proofs still all pass: ${inclAll}`);
}
record('the recomputation refuses every way a root can misrepresent its set', refusedAll,
  `${tamperRows.length} tampers, ${tamperRows.filter((t) => t.setExactRefused).length} refused`);
// The hidden-leaf row is the finding's whole point, so it gets its own assertion.
const hiddenRow = tamperRows[1];
record('a hidden extra leaf is invisible to inclusion checking and caught by the recomputation',
  hiddenRow.servedInclusionProofsAllStillPass && hiddenRow.setExactRefused,
  'every served inclusion proof verifies against the 9-leaf root while the recomputation over the 8 published leaves does not');
// And the honest response must still pass the same checker, or the tampers above prove nothing.
record('the honest response still passes the same checker', setExactFromResponse(honest).ok, 'negative control');

// ---- 3. what the root does NOT commit to ----------------------------------------------------------
// Discovered while building the tamper matrix, and worth publishing because it is easy to assume
// otherwise: hashPair SORTS its arguments, so swapping the two leaves of one sibling pair cannot change
// their parent. The root commits to the leaf SET with its pairing structure, not to the published index.
const swap = (a, i, j) => { const c = a.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; };
const withinPair = riskAttest({ contentHashes: swap(eight, 0, 1) }).merkleRoot === honest.merkleRoot;
const acrossPair = riskAttest({ contentHashes: swap(eight, 0, 2) }).merkleRoot !== honest.merkleRoot;
record('the root is invariant under a WITHIN-pair swap and moves under an ACROSS-pair swap', withinPair && acrossPair,
  'so `index` is metadata beside the commitment, not inside it — a circuit would not change this, it is the sorted-pair recipe on-chain verifiers expect');

// ---- 4. the gas head-to-head, at the service's own ceiling ----------------------------------------
const ceilingArtifact = path.join(BUILD, 'probe-attest-service-ceiling.json');
if (!existsSync(ceilingArtifact)) throw new Error('run probe-attest-service-ceiling.mjs first — the ceiling N is measured there, not typed in here');
const ceiling = JSON.parse(readFileSync(ceilingArtifact, 'utf8'));
const NC = ceiling.maxLeavesAccepted;
console.log(`\n  the service's measured batch ceiling is N=${NC} (${ceiling.bytesAtCeiling} bytes; N=${ceiling.firstLeafCountRefused} is refused ${ceiling.statusOverCeiling})`);

const ATTEST_SOL = `
// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.0 <0.9.0;
contract AttestCheck {
    function setExact(bytes32[] calldata leaves, bytes32 root) external view returns (bool) {
        uint256 n = leaves.length;
        if (n == 0) return false;
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i; i < n; ++i) layer[i] = sha256(abi.encodePacked(bytes1(0x00), leaves[i]));
        while (n > 1) {
            uint256 w;
            for (uint256 i; i < n; i += 2) {
                if (i + 1 < n) {
                    bytes32 a = layer[i]; bytes32 b = layer[i + 1];
                    layer[w] = a <= b ? sha256(abi.encodePacked(bytes1(0x01), a, b))
                                      : sha256(abi.encodePacked(bytes1(0x01), b, a));
                } else { layer[w] = layer[i]; }
                ++w;
            }
            n = w;
        }
        return layer[0] == root;
    }
}
`;
const solc = (await import('solc')).default ?? (await import('solc'));
const { EVM } = await import('@ethereumjs/evm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
const { keccak256 } = await import('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('ethereum-cryptography/utils.js');

const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'PlonkVerifier.sol': { content: readFileSync(path.join(BUILD, 'PlonkVerifier.sol'), 'utf8') },
    'PortfoliogateVerifier.sol': { content: readFileSync(path.join(BUILD, 'PortfoliogateVerifier.sol'), 'utf8') },
    'ConcentrationVerifier.sol': { content: readFileSync(path.join(BUILD, 'ConcentrationVerifier.sol'), 'utf8') },
    'AttestCheck.sol': { content: ATTEST_SOL },
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const cerr = (compiled.errors || []).filter((e) => e.severity === 'error');
if (cerr.length) throw new Error(cerr.map((e) => e.formattedMessage).join('\n'));
const pick = (file) => { const k = Object.keys(compiled.contracts[file]).find((x) => /verifier/i.test(x) && !/^I[A-Z]/.test(x)); return compiled.contracts[file][k]; };
const A = compiled.contracts['AttestCheck.sol'].AttestCheck;

const caller = hexToBytes('1000000000000000000000000000000000000001');
async function freshCall(bytecode, calldata) {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(bytecode), gasLimit: 300_000_000n });
  if (dep.execResult.exceptionError) throw new Error(`deploy: ${dep.execResult.exceptionError}`);
  const res = await evm.runCall({ caller: { bytes: caller }, to: dep.createdAddress, data: calldata, gasLimit: 300_000_000n });
  if (res.execResult.exceptionError) throw new Error(`call: ${res.execResult.exceptionError}`);
  return { gas: Number(res.execResult.executionGasUsed), ret: bytesToHex(res.execResult.returnValue) };
}
// EIP-2028 intrinsic calldata gas, on BOTH sides. executionGasUsed excludes it, and at 32 bytes a leaf
// it is the term that decides the large-N answer — leaving it out would flatter the direct check.
const cdGas = (b) => { let g = 0; for (const x of b) g += x === 0 ? 4 : 16; return g; };
const w32 = (hex) => BigInt('0x' + String(hex).replace(/^0x/, '')).toString(16).padStart(64, '0');
const numw = (n) => BigInt(n).toString(16).padStart(64, '0');
const selSet = bytesToHex(keccak256(utf8ToBytes('setExact(bytes32[],bytes32)'))).slice(0, 8);

const rc = riskAttest({ contentHashes: batch(NC, 'ceil') });
if (!rc.ok) throw new Error(`the engine refused a batch at its own ceiling N=${NC}`);
const listC = rc.attestations.slice().sort((a, b) => a.index - b.index).map((a) => a.contentHash);
const setCd = hexToBytes(selSet + numw(0x40) + w32(rc.merkleRoot) + numw(listC.length) + listC.map(w32).join(''));
const directRes = await freshCall(A.evm.bytecode.object, setCd);
if (!/1$/.test(directRes.ret)) throw new Error('the on-chain set-exactness check refused the engine\'s own root');
const directTotal = directRes.gas + cdGas(setCd);
// and it must refuse on chain too, or the gas figure is for checking nothing
const badCd = hexToBytes(selSet + numw(0x40) + w32('0x' + h('WRONG')) + numw(listC.length) + listC.map(w32).join(''));
const directBad = await freshCall(A.evm.bytecode.object, badCd);
record('the on-chain set-exactness check accepts the real root and refuses a wrong one', /1$/.test(directRes.ret) && /0$/.test(directBad.ret),
  `${directTotal} gas total at N=${NC} (${directRes.gas} exec + ${cdGas(setCd)} calldata)`);

// The pairing check, priced for a circuit that must NAME the set: 2 public signals per 32-byte leaf
// (a contentHash does not fit one BN254 scalar) plus 2 for the root. The per-signal marginal is measured
// here from two real circuits 20 signals apart, not quoted.
const sj = await snarkjs();
const { perpGate } = await load(import.meta.url, 'engine/perpGate.js');
const { witnessFor } = await load(import.meta.url, 'util/snark.js');
const { makeBuilder } = await import('./lib/portfolio-witness.mjs');
const POSITION = { side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005 };
const liqW = witnessFor(POSITION, perpGate(POSITION).liquidationPrice);
const { build } = await makeBuilder(import.meta.url);
const pg = build([
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
]);
if (!liqW || !pg.ok) throw new Error('could not build the two reference witnesses');

// A third point, so a 462-signal extrapolation is not run off a straight line through two dots. Four
// equal quarters give H = 1/4 exactly, which is the concentration gate's own worked case.
const CSCALE = 1_000_000_000n;
const cShares = [0.25, 0.25, 0.25, 0.25];
const cW = cShares.map((w) => BigInt(Math.round(w * Number(CSCALE))));
const cPad = [...cW, ...Array(8 - cW.length).fill(0n)];
const cSumSq = cPad.reduce((a, w) => a + w * w, 0n);
const concWitness = { wHat: cPad.map(String), hHat: (((cSumSq + CSCALE / 2n) / CSCALE)).toString() };

const SAMPLES = 12;
async function verifyGas(circuit, vkFile, solFile, witness) {
  const V = pick(solFile);
  const zkey = path.join(BUILD, `${circuit}_plonk.zkey`);
  const wasm = path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`);
  const builder = await require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.cjs'))(readFileSync(wasm));
  const vk = JSON.parse(readFileSync(path.join(BUILD, vkFile), 'utf8'));
  const totals = []; let nSig = null;
  for (let i = 0; i < SAMPLES; i++) {
    const { proof, publicSignals } = await sj.plonk.prove(zkey, await builder.calculateWTNSBin(witness, 0));
    if (!(await sj.plonk.verify(vk, publicSignals, proof))) throw new Error(`${circuit} sample ${i} fails off chain`);
    const r = await sj.plonk.exportSolidityCallData(proof, publicSignals);
    const [pw, sw] = JSON.parse(`[${r.replace(/\]\s*\[/g, '],[')}]`);
    const sel = bytesToHex(keccak256(utf8ToBytes(`verifyProof(uint256[24],uint256[${sw.length}])`))).slice(0, 8);
    const cd = hexToBytes(sel + [...pw, ...sw].map((v) => BigInt(v).toString(16).padStart(64, '0')).join(''));
    const res = await freshCall(V.evm.bytecode.object, cd);
    if (!/1$/.test(res.ret)) throw new Error(`${circuit} sample ${i} fails ON CHAIN`);
    totals.push(res.gas + cdGas(cd)); nSig = sw.length;
  }
  totals.sort((a, b) => a - b);
  const n = totals.length;
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  // Sample sd, then the STANDARD ERROR OF THE MEAN. The first version of this gate used the raw
  // min/max spread as the uncertainty on the marginal, which is the uncertainty on a single DRAW, not
  // on the estimator, and it gets worse as samples are added rather than better. It made the derived
  // bound overturn a conclusion that the data actually supports; the estimator was wrong, not the
  // finding. SE = sd/sqrt(n) is what shrinks with sampling, so that is what the bound is built on.
  const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return {
    circuit, publicSignals: nSig, samples: n,
    mean: Number(mean.toFixed(1)), median: totals[Math.floor(n / 2)], min: totals[0], max: totals.at(-1),
    spread: totals.at(-1) - totals[0], sd: Number(sd.toFixed(1)), se: Number((sd / Math.sqrt(n)).toFixed(1)),
  };
}
const vLo = await verifyGas('liquidation', 'vk_plonk.json', 'PlonkVerifier.sol', liqW.witness);
const vMid = await verifyGas('concentration', 'concentration_vk.json', 'ConcentrationVerifier.sol', concWitness);
const vHi = await verifyGas('portfoliogate', 'portfoliogate_vk.json', 'PortfoliogateVerifier.sol', pg.witness);
const pts = [vLo, vMid, vHi].sort((a, b) => a.publicSignals - b.publicSignals);
for (const p of pts) console.log(`\n  ${p.circuit.padEnd(14)} ${String(p.publicSignals).padStart(2)} signals   mean ${String(p.mean).padStart(9)} gas   sd ${String(p.sd).padStart(7)}   SE ${String(p.se).padStart(6)}   (${p.samples} samples)`);

// Ordinary least squares through the three points, so the extrapolation rests on a line the data was
// actually tested against rather than on two dots joined up.
const sx = pts.reduce((a, p) => a + p.publicSignals, 0) / pts.length;
const sy = pts.reduce((a, p) => a + p.mean, 0) / pts.length;
const perSignal = pts.reduce((a, p) => a + (p.publicSignals - sx) * (p.mean - sy), 0) / pts.reduce((a, p) => a + (p.publicSignals - sx) ** 2, 0);
const plonkBase = sy - perSignal * sx;
const resid = pts.map((p) => ({ circuit: p.circuit, publicSignals: p.publicSignals, mean: p.mean, fitted: Number((plonkBase + perSignal * p.publicSignals).toFixed(1)), residual: Number((p.mean - (plonkBase + perSignal * p.publicSignals)).toFixed(1)), seMultiples: Number(((p.mean - (plonkBase + perSignal * p.publicSignals)) / p.se).toFixed(2)) }));
const worstResid = Math.max(...resid.map((r) => Math.abs(r.residual)));
const worstSE = Math.max(...pts.map((p) => p.se));
console.log(`\n  OLS: ${perSignal.toFixed(1)} gas per public signal, base ${plonkBase.toFixed(0)} gas at zero signals`);
for (const r of resid) console.log(`    ${r.circuit.padEnd(14)} residual ${String(r.residual).padStart(9)} gas (${r.seMultiples} SE)`);
// Linearity is the assumption the whole extrapolation rides on, so it is tested, not assumed. If the
// three points did not sit on a line to within a few standard errors, extrapolating 462 signals past
// the last of them would be indefensible and this gate would say so.
record('a Plonk verify is linear in public inputs across the measured range, to within sampling error', worstResid < 4 * worstSE,
  `worst residual ${worstResid.toFixed(0)} gas against a worst SE of ${worstSE.toFixed(0)} — ${(worstResid / worstSE).toFixed(1)} SE, over ${pts[0].publicSignals}..${pts.at(-1).publicSignals} signals`);

const dSig = pts.at(-1).publicSignals - pts[0].publicSignals;
const snarkAtCeiling = Math.round(plonkBase + perSignal * (2 * NC + 2));

console.log(`\n  at N=${NC}, the service's ceiling:`);
console.log(`    direct set-exactness on chain          ${String(directTotal).padStart(9)} gas`);
console.log(`    Plonk verify @ ${2 * NC + 2} public signals    ${String(snarkAtCeiling).padStart(9)} gas`);
record(`at the service's own ceiling the direct check is cheaper than a set-exactness pairing check`, directTotal < snarkAtCeiling,
  `${directTotal} < ${snarkAtCeiling} gas — and the pairing check would still be proving a WEAKER statement, since it certifies arithmetic over inputs the response already publishes`);

// ---- 4b. THE BOUND, DERIVED HERE RATHER THAN INHERITED --------------------------------------------
// The comparison above is one median against a figure extrapolated 462 signals past the furthest point
// measured. An extrapolation that long carries the sampling error of BOTH endpoints, multiplied. So the
// conclusion is re-run against the most SNARK-FAVOURABLE reading the data admits, which is the only
// direction that can overturn it:
//
//   perSignal as small as the samples allow   -> (cheapest 28-signal verify - dearest 8-signal verify)/20
//   the base as small as that then implies    -> cheapest 8-signal verify - perSignalMin * 8
//
// Underestimating the marginal makes the pairing check look CHEAPER, so this is the worst case for the
// finding. The direct side is deterministic and needs no such treatment, which is asserted rather than
// assumed: identical calldata is run twice and the gas must be identical.
const directAgain = await freshCall(A.evm.bytecode.object, setCd);
record('the direct check is deterministic, so its single sample needs no error bar', directAgain.gas === directRes.gas,
  `${directRes.gas} twice — no proof scalars, and control flow does not depend on any of them`);

// SE of the slope, propagated from the two endpoint means rather than taken from a 3-point OLS, which
// would be estimating a variance from one degree of freedom. Then a ONE-SIDED 3-sigma bound in the only
// direction that can overturn the finding: a smaller marginal makes the pairing check look cheaper. The
// extrapolation is anchored at the measured low point, itself pushed down by 3 SE, so both terms are
// simultaneously at their most SNARK-favourable.
const seSlope = Math.sqrt(pts[0].se ** 2 + pts.at(-1).se ** 2) / dSig;
const K = 3;
const perSignalMin = perSignal - K * seSlope;
const sigsNeeded = 2 * NC + 2;
const snarkWorstCase = Math.round((pts[0].mean - K * pts[0].se) + perSignalMin * (sigsNeeded - pts[0].publicSignals));
const marginCentral = snarkAtCeiling - directTotal;
const marginWorst = snarkWorstCase - directTotal;
const consumed = (snarkAtCeiling - snarkWorstCase) / marginCentral;
console.log(`\n  the derived bound (one-sided ${K} SE, the only direction that can overturn the finding):`);
console.log(`    SE of the marginal                      ${seSlope.toFixed(1)} gas/signal  ->  worst-case marginal ${perSignalMin.toFixed(0)} (central ${perSignal.toFixed(0)})`);
console.log(`    pairing check at N=${NC} (${sigsNeeded} signals)     ${String(snarkWorstCase).padStart(9)} gas worst case, ${snarkAtCeiling} central`);
console.log(`    margin over the direct check            ${String(marginWorst).padStart(9)} gas worst case, ${marginCentral} central`);
console.log(`    the worst honest case consumes          ${(consumed * 100).toFixed(1)}% of the central margin`);
record('the conclusion survives the most SNARK-favourable reading of every measured quantity', marginWorst > 0,
  `worst-case margin ${marginWorst} gas; the sampling error eats ${(consumed * 100).toFixed(1)}% of the ${marginCentral}-gas central margin`);
// AND THE HONEST LIMIT OF THIS LEG. N=244 is the tightest point on the curve — the direct check grows
// with N and the pairing check's public-input term grows twice as fast, so they are closest at the
// ceiling. The gas argument is therefore a WASH at the ceiling and decisive below it, and the finding is
// not allowed to lean on it: the two legs that actually carry it are that the leaves are published and
// that the circuit cannot be built. This is recorded so a reader is not invited to over-read 86,008 gas.
const midRow = JSON.parse(readFileSync(path.join(BUILD, 'probe-attest-snark-need.json'), 'utf8')).directOnChain.find((r) => r.n === 64);
const snarkAt64 = Math.round(plonkBase + perSignal * (2 * 64 + 2));
console.log(`\n    for contrast, at N=64: direct ${midRow.setExact.totalGas} vs pairing ${snarkAt64} gas — a ${(snarkAt64 / midRow.setExact.totalGas).toFixed(2)}x gap`);
record('the gas leg is decisive below the ceiling, not merely at it', snarkAt64 > midRow.setExact.totalGas * 1.5,
  `at N=64 the pairing check costs ${(snarkAt64 / midRow.setExact.totalGas).toFixed(2)}x the direct check; at the N=${NC} ceiling the two are within ${(marginCentral / directTotal * 100).toFixed(0)}%, which is the tightest the comparison ever gets`);

// ---- 5. and the circuit could not be built at that N anyway ---------------------------------------
const floorArtifact = path.join(BUILD, 'probe-attest-circuit-floor.json');
if (!existsSync(floorArtifact)) throw new Error('run probe-attest-circuit-floor.mjs first — the constraint marginal is measured there');
const floor = JSON.parse(readFileSync(floorArtifact, 'utf8'));
const constraintsAtCeiling = Math.round(floor.marginal.constraintsPerLeaf * NC + floor.marginal.interceptConstraints);
const powerNeeded = Math.ceil(Math.log2(constraintsAtCeiling));
const ptauPresent = readdirSync(BUILD).filter((f) => /ptau$/.test(f));
const powersPresent = ptauPresent.map((f) => Number((f.match(/(\d+)\.ptau$/) || [])[1])).filter(Number.isFinite);
const largestPresent = powersPresent.length ? Math.max(...powersPresent) : null;
console.log(`\n  a set-exactness circuit at N=${NC}: ~${constraintsAtCeiling.toLocaleString()} constraints (measured marginal ${floor.marginal.constraintsPerLeaf.toLocaleString()}/leaf, sha256 in-circuit)`);
console.log(`  that needs a Plonk ptau of 2^${powerNeeded}; the largest in zk/build is 2^${largestPresent} (${ptauPresent.join(', ')})`);
record('the circuit that would be needed is beyond the trusted setup this project has', powerNeeded > largestPresent,
  `2^${powerNeeded} required vs 2^${largestPresent} present — and the constraint count is a LOWER bound, since the measured circuit omits the 256-bit sorted-pair comparator`);

// ---- report ---------------------------------------------------------------------------------------
const ok = failed().length === 0;
const artifact = {
  at: new Date().toISOString(),
  passed: ok,
  finding: 'A zk proof adds nothing to risk-attest. The response publishes the complete leaf set, so set-exactness — no item dropped AND no item hidden, the two halves an inclusion proof cannot reach — is decided by recomputing the root in 2N-1 sha256 calls. There is no privacy to buy because every leaf is already public, and no succinctness to buy because the verifier already holds every leaf. At the service\'s own batch ceiling the direct check is also cheaper on chain than a pairing check that would prove a weaker statement, and the circuit needed at that N is beyond this project\'s trusted setup.',
  whatNoCircuitCanFix: 'Whether the submitter submitted its COMPLETE set of computations. The root covers what it was handed; a circuit\'s witness is also what it was handed. That is the input problem, and it is answered by input attestation, not by a circuit.',
  serviceSource: label,
  perBatchSize: perN,
  tamperMatrix: tamperRows,
  rootCommitment: { invariantUnderWithinPairSwap: withinPair, movesUnderAcrossPairSwap: acrossPair, meaning: 'the root commits to the leaf set with its pairing structure, not to the published index' },
  serviceCeiling: { maxLeavesAccepted: NC, bytesAtCeiling: ceiling.bytesAtCeiling, firstRefused: ceiling.firstLeafCountRefused, statusOverCeiling: ceiling.statusOverCeiling },
  onChain: {
    directSetExactTotalGasAtCeiling: directTotal,
    directExecGas: directRes.gas,
    directCalldataGas: cdGas(setCd),
    plonkSamples: pts,
    linearityResiduals: resid,
    perPublicSignalGas: Number(perSignal.toFixed(1)),
    plonkBaseGasAtZeroSignals: Math.round(plonkBase),
    plonkVerifyTotalGasAtCeiling: snarkAtCeiling,
    publicSignalsRequiredAtCeiling: 2 * NC + 2,
    directIsCheaper: directTotal < snarkAtCeiling,
    directDeterministic: directAgain.gas === directRes.gas,
  },
  derivedBound: {
    what: 'the most SNARK-favourable reading the samples admit — the only direction that can overturn the finding',
    perPublicSignalGasMin: Number(perSignalMin.toFixed(1)),
    perPublicSignalGasCentral: Number(perSignal.toFixed(1)),
    plonkVerifyTotalGasAtCeilingWorstCase: snarkWorstCase,
    marginGasCentral: marginCentral,
    marginGasWorstCase: marginWorst,
    sigmaMultiple: K,
    seOfMarginalGasPerSignal: Number(seSlope.toFixed(2)),
    fractionOfCentralMarginConsumedByWorstCase: Number(consumed.toFixed(4)),
    atN64: { directTotalGas: midRow.setExact.totalGas, pairingTotalGas: snarkAt64, ratio: Number((snarkAt64 / midRow.setExact.totalGas).toFixed(2)) },
    tightestPointIsTheCeiling: true,
    survives: marginWorst > 0,
  },
  circuitFloor: { constraintsAtCeiling, ptauPowerRequired: powerNeeded, largestPtauPresent: largestPresent, ptauFilesPresent: ptauPresent, isLowerBound: true },
  checks: results,
  solc: solc.version(),
};
writeFileSync(path.join(BUILD, 'gateAT-attest-no-snark.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  artifact zk/build/gateAT-attest-no-snark.json`);
console.log(ok ? '\nGATE AT PASSED — the finding holds: nothing here is worth a circuit.' : `\nGATE AT FAILED — ${failed().length} check(s) red: ${failed().map((f) => f.name).join('; ')}`);
await shutdown();
process.exit(ok ? 0 : 1);
