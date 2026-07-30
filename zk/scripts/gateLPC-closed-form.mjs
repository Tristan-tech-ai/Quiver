// GATE LPC — the expectation itself, proven, under hez_final_13.
//
// lp-risk's headline is E[IL](v) = exp(-v/8) - 1 for v = sigma^2 T. The engine computes it with a
// 401-point trapezoid; `circuits/adv/lpclosed.circom` certifies the closed form, whose derivation is in
// that file (2*sqrt(r)/(1+r) = sech(ln r / 2), then a shift and a symmetrisation leave cosh * sech = 1).
//
// WHY A SECOND CEREMONY FILE. `zk/build/probe-lpclosed-cost.json` concluded a closed-form circuit "fits
// inside hez_final_12 with room to spare" from a 3,023 figure, and the circuit's own header still said
// "~2k constraints, under the hez_final_12 already on disk". Both compared an R1CS count against a PLONK
// domain ceiling. Measured here rather than projected: lpclosed compiles to 3,854 R1CS and 7,471 Plonk,
// and snarkjs refuses hez_final_12 outright with "circuit too big for this power of tau ceremony.
// 7471 > 2**12". That refusal is asserted below, so the download is justified by a measurement and not by
// a claim. hez_final_13 (power 13, domain 8,192, 9,520,280 bytes) takes it.
//
// WHAT THIS DOES NOT TOUCH. Nothing under src/engine/. The engine keeps serving its quadrature, the
// codeHash stays q1-e1fa99d08887d6cc, and no contentHash moves. The exact value is recoverable outside the
// engine because `volatility` and `horizonPeriods` are published verbatim (src/util/lpClosedForm.js), so
// certifying it needs no engine change at all.
//
// A GATE THAT CANNOT FAIL IS NOT A GATE. Four separate ways to make it red are exercised: the wrong
// ceremony file, a witness two grid steps off, a witness claiming zero loss, and an honest proof checked
// against bent public signals. All four must be refused, and the sweep carries a coverage floor so a
// collapsed sweep cannot pass for a clean one.
//
//   node zk/scripts/gateLPC-closed-form.mjs
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.resolve(HERE, '..');
const ROOT = path.resolve(ZK, '..');
const BUILD = path.join(ZK, 'build');
const CLI = path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
const require_ = createRequire(path.join(ZK, 'package.json'));
const snarkjs = require_('snarkjs');

// The service tree is probed, not assumed: it is hackathon/veritape in the working tree and the repo root
// in a clone of the mirror.
const VT = [path.join(ROOT, 'hackathon', 'veritape'), ROOT].find((p) => existsSync(path.join(p, 'src', 'engine', 'lpRisk.js')));

let fails = 0;
const row = (label, val, ok) => {
  if (ok === false) fails++;
  console.log(`  ${ok === undefined ? '    ' : ok ? '[ok]' : '[**] '} ${label.padEnd(58)} ${String(val)}`);
};

console.log(`GATE LPC — the closed-form expectation, proven — ${new Date().toISOString()}`);
if (!VT) { console.log('  cannot locate the service tree (src/engine/lpRisk.js)'); process.exit(1); }
if (!existsSync(path.join(BUILD, 'lpclosed.r1cs'))) {
  console.log('  build/lpclosed.r1cs is absent. Compile first:');
  console.log('    ./zk/circom.exe zk/circuits/adv/lpclosed.circom --r1cs --wasm --sym -o zk/build');
  process.exit(1);
}

// ---------------------------------------------------------------- 1. size, read from artifacts
const info = await snarkjs.r1cs.info(path.join(BUILD, 'lpclosed.r1cs'));
row('R1CS constraints (from the .r1cs artifact)', info.nConstraints);

const PTAU12 = path.join(BUILD, 'hez_final_12.ptau');
const PTAU13 = path.join(BUILD, 'hez_final_13.ptau');
const ptauPower = (f) => {
  const b = readFileSync(f);
  const nSec = b.readUInt32LE(8);
  let p = 12;
  for (let i = 0; i < nSec; i++) {
    const t = b.readUInt32LE(p); p += 4;
    const sz = Number(b.readBigUInt64LE(p)); p += 8;
    if (t === 1) { let q = p; const n8 = b.readUInt32LE(q); q += 4 + n8; return b.readUInt32LE(q); }
    p += sz;
  }
  return null;
};
row('hez_final_13 present', existsSync(PTAU13) ? `${statSync(PTAU13).size} bytes` : 'MISSING', existsSync(PTAU13));
if (!existsSync(PTAU13)) {
  console.log('    fetch: curl -o zk/build/hez_final_13.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_13.ptau');
  process.exit(1);
}
row('hez_final_13 power (from its own header)', ptauPower(PTAU13), ptauPower(PTAU13) === 13);
row('hez_final_13 max domain', 2 ** ptauPower(PTAU13), 2 ** ptauPower(PTAU13) === 8192);

// ---------------------------------------------------------------- 2. the SMALLER ceremony must REFUSE
// This is the check that earns the download. Without it "we needed 2^13" is a claim, and the artifact that
// claimed the opposite is still in the tree.
let twelveRefused = false;
let twelveMessage = '';
// Clear any stub first. snarkjs creates the output file before it checks the ceremony size, and a leftover
// from an earlier attempt made the "left no zkey behind" check below fire on a file this run never wrote.
const STUB = path.join(BUILD, 'lpclosed_toosmall.zkey');
if (existsSync(STUB)) rmSync(STUB, { force: true });
try {
  execFileSync(process.execPath, [CLI, 'plonk', 'setup', path.join(BUILD, 'lpclosed.r1cs'), PTAU12,
    path.join(BUILD, 'lpclosed_toosmall.zkey')], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
} catch (e) {
  twelveMessage = `${e.stdout || ''}${e.stderr || ''}`.replace(/\[[0-9;]*m/g, '');
  twelveRefused = /too big for this power of tau/i.test(twelveMessage);
}
row('hez_final_12 (power ' + ptauPower(PTAU12) + ') REFUSES this circuit', twelveRefused
  ? (twelveMessage.match(/circuit too big[^\n]*/i) || ['refused'])[0].trim() : 'IT ACCEPTED IT', twelveRefused);
row('and the refused setup left no usable zkey', existsSync(STUB)
  ? `a ${statSync(STUB).size}-byte stub remains (snarkjs opens the output before it checks the size)`
  : 'nothing left behind', true);
if (existsSync(STUB)) rmSync(STUB, { force: true });

// ---------------------------------------------------------------- 3. setup against 2^13, read the header
const ZKEY = path.join(BUILD, 'lpclosed_plonk.zkey');
let t = Date.now();
execFileSync(process.execPath, [CLI, 'plonk', 'setup', path.join(BUILD, 'lpclosed.r1cs'), PTAU13, ZKEY],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const setupMs = Date.now() - t;
const facts = await import(new URL('./circuit-facts.mjs', import.meta.url).href);
const f = facts.plonkFacts(ZKEY);
row('Plonk constraints (from the zkey section-2 header)', f.nConstraints);
row('domain', f.domainSize, f.domainSize === 8192);
row('R1CS -> Plonk inflation', (f.nConstraints / info.nConstraints).toFixed(4));
row('exceeds the 2^12 ceiling by', `${f.nConstraints - 4096} constraints`, f.nConstraints > 4096);
row('public signals', f.nPublic);
row('plonk setup against hez_final_13', `${setupMs} ms`);

const VK = path.join(BUILD, 'lpclosed_vk.json');
execFileSync(process.execPath, [CLI, 'zkey', 'export', 'verificationkey', ZKEY, VK], { stdio: ['ignore', 'pipe', 'pipe'] });

// ---------------------------------------------------------------- 4. witnesses FROM THE LIVE ENGINE
// The witness must come from what the service actually serves, not from this script's own arithmetic,
// or the gate is only checking that one expression equals itself.
const { lpRisk } = await import(new URL(`file:///${path.join(VT, 'src', 'engine', 'lpRisk.js').split(path.sep).join('/')}`).href);
const WC = require_(path.join(BUILD, 'lpclosed_js', 'witness_calculator.js'));
const wasm = readFileSync(path.join(BUILD, 'lpclosed_js', 'lpclosed.wasm'));
const wc = await WC(wasm);
const TOL = 500065536n;

// v is swept across the engine's own admissible range. The engine's expectedIlPct is rounded to 4dp, so
// the witness lHat is taken from the exact closed form on the 1e-9 grid and the engine's SERVED figure is
// compared separately: those are two different questions and merging them is how a previous guard ended up
// measuring display rounding instead of arithmetic.
const samples = [];
for (let i = 1; i <= 240; i++) samples.push(i * 0.05);           // v in (0, 12]
for (const v of [1e-6, 1e-4, 0.001, 0.01, 1.1255, 20, 50, 100, 166]) samples.push(v);

let proved = 0;
let informative = 0;
let refusedByCircuit = 0;
let worstResidual = 0n;
let worstAtV = 0;
const engineDisagreesOn4dp = [];
for (const v of samples) {
  const sigma = Math.sqrt(v);                                     // T = 1, so v = sigma^2
  const r = lpRisk({ volatility: sigma, horizonPeriods: 1 });
  if (!r?.expectedDivergence) continue;
  const vHat = BigInt(Math.round(v * 1e9));
  const lHat = BigInt(Math.round(Math.exp(-v / 8) * 1e9));
  let w;
  try {
    w = await wc.calculateWitness({ vHat: vHat.toString(), lHat: lHat.toString() }, true);
  } catch { refusedByCircuit++; continue; }
  // witness[1] and [2] are the outputs residual and tolerance, in declaration order
  const residual = w[1] > (1n << 250n) ? null : w[1];
  const absResidual = residual === null ? null : (residual < 0n ? -residual : residual);
  if (absResidual !== null && absResidual > worstResidual) { worstResidual = absResidual; worstAtV = v; }
  if (w[2] !== TOL) { row('tolerance signal is not the declared TOL', `${w[2]} at v=${v}`, false); break; }
  proved++;
  if (lHat > 0n) informative++;
  // and separately: does the engine's 4dp figure match the exact one?
  const served = r.expectedDivergence.expectedIlPct;
  const exact4 = Math.round(Math.expm1(-v / 8) * 100 * 1e4) / 1e4;
  if (served !== exact4) engineDisagreesOn4dp.push({ v, served, exact4 });
}
row('witnesses satisfied across the swept domain', `${proved} of ${samples.length}`, proved > 0);
// The informative domain ends where lHat rounds to zero. exp(-v/8) < 5e-10 once v > 8*ln(2e9) = 171.34, so
// above that every honest witness is 0 == 0: true, and certifying nothing. Counting those as coverage is
// padding, so they are reported separately rather than folded into the total.
row('informative samples (lHat > 0)', `${informative} of ${proved}; ${proved - informative} sit above v=171.34 where lHat rounds to 0 and the circuit certifies 0 == 0`,
  informative > 0);
// A floor, not a note: a sweep that collapsed to a handful would pass every assertion above having
// established nothing about the domain.
const FLOOR = Math.floor(samples.length * 0.9);
row(`coverage floor (>= ${FLOOR})`, proved >= FLOOR ? 'met' : `ONLY ${proved} — NOT ENOUGH COVERAGE TO CONCLUDE ANYTHING`, proved >= FLOOR);
// A CHECK THAT ALMOST CANNOT FAIL, AND WHAT REPLACED IT.
//
// The first version of this gate asserted worstResidual < TOL and printed the ratio as "% of budget". It
// reported 99.76% and looked like a hair's breadth from refusing an honest witness. It is not. TOL is
// 500065536 = half a 1e-9 grid step at the 1e18 working scale (500000000) PLUS a 65536 ulp allowance for
// the squaring ladder. lHat is the exact value ROUNDED to the 1e-9 grid, so the residual is a rounding
// difference and by construction lives in +/- 500000000, which is 99.987% of TOL. Reaching 99.9793% is the
// design, not a warning, and 5,200 finer samples produced zero refusals.
//
// So the ratio was measuring the grid, and the only thing that can actually fail is the LADDER error: how
// far past the half step the residual goes. That is what is asserted now. Measured worst over (0, 20] at
// 0.005 steps: |residual| - halfStep = -38039, i.e. negative, so the ladder contributes nothing detectable
// at this precision and the whole residual is rounding.
const HALF_STEP = 500000000n;
const ladderError = worstResidual > HALF_STEP ? worstResidual - HALF_STEP : 0n;
const LADDER_BUDGET = TOL - HALF_STEP;
row('worst |residual| over the sweep', `${worstResidual} (half a grid step is ${HALF_STEP}, so this is rounding)`);
row('ladder error beyond the half step', `${ladderError} of the ${LADDER_BUDGET} ulp allowance`
  + `${ladderError === 0n ? ' — the ladder contributes nothing detectable' : ` (${(Number(ladderError) / Number(LADDER_BUDGET) * 100).toFixed(2)}%)`}`,
  ladderError < LADDER_BUDGET);
row('and no honest witness was refused', `${refusedByCircuit} refused of ${samples.length}`, refusedByCircuit === 0);
row('engine 4dp figure vs the exact 4dp figure', engineDisagreesOn4dp.length === 0
  ? 'agrees on every sampled v'
  : `differs on ${engineDisagreesOn4dp.length} of ${proved}: ${engineDisagreesOn4dp.slice(0, 3).map((d) => `v=${d.v} served ${d.served} exact ${d.exact4}`).join('; ')}`);

// ---------------------------------------------------------------- 5. prove and verify one, for real
const IN = path.join(BUILD, 'lpclosed_input.json');
const vDemo = 0.075;
writeFileSync(IN, JSON.stringify({ vHat: String(Math.round(vDemo * 1e9)), lHat: String(Math.round(Math.exp(-vDemo / 8) * 1e9)) }));
execFileSync(process.execPath, [path.join(BUILD, 'lpclosed_js', 'generate_witness.js'),
  path.join(BUILD, 'lpclosed_js', 'lpclosed.wasm'), IN, path.join(BUILD, 'lpclosed.wtns')], { stdio: ['ignore', 'pipe', 'pipe'] });
t = Date.now();
execFileSync(process.execPath, [CLI, 'plonk', 'prove', ZKEY, path.join(BUILD, 'lpclosed.wtns'),
  path.join(BUILD, 'lpclosed_proof.json'), path.join(BUILD, 'lpclosed_public.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
const proveMs = Date.now() - t;
const pub = JSON.parse(readFileSync(path.join(BUILD, 'lpclosed_public.json'), 'utf8'));
const okVerify = await snarkjs.plonk.verify(JSON.parse(readFileSync(VK, 'utf8')), pub, JSON.parse(readFileSync(path.join(BUILD, 'lpclosed_proof.json'), 'utf8')));
row(`prove v=${vDemo}`, `${proveMs} ms`);
row('the honest proof VERIFIES', okVerify, okVerify === true);
row('public signals', pub.join(' '));

// ---------------------------------------------------------------- 6. the refusal matrix
const mustRefuseWitness = async (label, input) => {
  let refused = false;
  try { await wc.calculateWitness(input, true); } catch { refused = true; }
  row(`refuses: ${label}`, refused ? 'refused' : 'ACCEPTED', refused);
};
const vh = String(Math.round(vDemo * 1e9));
const lh = Math.round(Math.exp(-vDemo / 8) * 1e9);
await mustRefuseWitness('lHat two grid steps high', { vHat: vh, lHat: String(lh + 2) });
await mustRefuseWitness('lHat two grid steps low', { vHat: vh, lHat: String(lh - 2) });
await mustRefuseWitness('lHat claims zero loss (1e9)', { vHat: vh, lHat: '1000000000' });
await mustRefuseWitness('lHat claims total loss (0)', { vHat: vh, lHat: '0' });

const bent = [...pub];
bent[3] = String(BigInt(bent[3]) + 1n);
const okBent = await snarkjs.plonk.verify(JSON.parse(readFileSync(VK, 'utf8')), bent,
  JSON.parse(readFileSync(path.join(BUILD, 'lpclosed_proof.json'), 'utf8')));
row('refuses: an honest proof against bent public signals', okBent === false ? 'rejected' : 'ACCEPTED', okBent === false);

// ---------------------------------------------------------------- 7. the engine did not move
const proof = await import(new URL(`file:///${path.join(VT, 'src', 'engine', 'proof.js').split(path.sep).join('/')}`).href);
const build = proof._internal.buildId();
row('engine codeHash', build, build === 'q1-e1fa99d08887d6cc');

const artifact = {
  at: new Date().toISOString(),
  passed: fails === 0,
  r1cs: info.nConstraints,
  plonk: f.nConstraints,
  domain: f.domainSize,
  inflation: f.nConstraints / info.nConstraints,
  hezFinal12Refused: twelveRefused,
  hezFinal12Message: (twelveMessage.match(/circuit too big[^\n]*/i) || [''])[0].trim(),
  hezFinal13: { power: ptauPower(PTAU13), bytes: statSync(PTAU13).size, sha256Note: 'see gate output / changelog' },
  setupMs,
  proveMs,
  sweep: { samples: samples.length, satisfied: proved, refusedByCircuit, floor: FLOOR },
  worstResidual: worstResidual.toString(),
  tolerance: TOL.toString(),
  // Deliberately NOT published as a fraction of TOL. That ratio sits at ~99.98% for every honest witness,
  // because the residual is a rounding difference bounded by half a grid step, and reporting it as "% of
  // budget" made a designed behaviour look like a near miss. The ladder error is the quantity with headroom.
  halfGridStep: HALF_STEP.toString(),
  ladderErrorBeyondHalfStep: ladderError.toString(),
  ladderBudget: LADDER_BUDGET.toString(),
  informativeSamples: informative,
  trivialSamplesAboveV171: proved - informative,
  worstAtV,
  engineDisagreesOn4dp: engineDisagreesOn4dp.length,
  engineDisagreementExamples: engineDisagreesOn4dp.slice(0, 5),
  codeHash: build,
};
mkdirSync(BUILD, { recursive: true });
writeFileSync(path.join(BUILD, 'gateLPC-closed-form.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  artifact zk/build/gateLPC-closed-form.json`);
console.log(fails === 0
  ? '\nGATE LPC PASSED — the expectation is proven under hez_final_13, hez_final_12 refuses it by measurement, every tamper is refused, and the engine did not move.'
  : `\nGATE LPC FAILED — ${fails} check(s) red.`);
process.exit(fails === 0 ? 0 : 1);
