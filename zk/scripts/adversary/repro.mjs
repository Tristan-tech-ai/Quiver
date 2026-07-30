// Does the repository reproduce the four adversarial refutations?
//
//   node zk/scripts/adversary/repro.mjs                        the whole cheap set (~3 min)
//   ADV_WORK=/tmp/clean node zk/scripts/adversary/repro.mjs     into an empty directory
//   ADV_REPRO_REVERT=<mode> node zk/scripts/adversary/repro.mjs prove this gate can go red
//
// Four adversaries refuted four "cannot" verdicts on 30 July 2026 and every artifact they produced
// lived in a session-scoped temp directory. This is the check that the repository, and nothing else,
// now carries enough to rebuild them. It asserts three different kinds of claim, and the difference
// between the three is the whole point:
//
//   1. SOURCE INTEGRITY — sha256 of every committed circuit and probe. A partial checkout fails here.
//   2. BYTE REPRODUCIBILITY — the artifacts that are a deterministic function of committed inputs
//      (r1cs from circom; Plonk zkeys from r1cs + the on-disk hez_final_12) are pinned to sha256 and
//      must come back identical. This is the strongest claim available and it covers three of the
//      four refutations.
//   3. FIGURE REPRODUCIBILITY — constraint counts, domains, public-signal counts, and the
//      power-of-tau budget arithmetic. Pinned to exact integers.
//
// What is deliberately NOT asserted byte-wise: anything downstream of a LOCALLY GENERATED ceremony
// file. `powersoftau new` mixes fresh entropy, so those bytes differ every run — three independent
// 2^13 files measured in this project are 9,438,629 / 9,438,644 / 9,438,657 bytes. Constraint counts
// and gas over such a file are reproducible; its bytes are not, and pinning a digest to them would be
// a check that always fails. See ptau.mjs.
//
// Gas is not asserted here at all. Plonk verify gas has a measured 1.22-1.26% run-to-run spread, about
// 3,500 gas, plus a 7,500-gas EIP-2929 cold/warm gap. An equality assertion on gas is a gate that goes
// red on noise; the probes print gas, and the findings document states the spread beside every figure.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import P from './paths.mjs';
import { r1csHeader } from './r1cs-probe.mjs';

const { plonkFacts } = await import('../circuit-facts.mjs');

const REVERT = process.env.ADV_REPRO_REVERT || '';
const REVERT_MODES = {
  'source-hash': 'corrupt one committed circuit in memory before hashing it',
  'plonk-bytes': 'hash the wrong zkey, as a stale artifact on disk would',
  'counts': 'assert the constraint count the INVESTIGATORS believed instead of the measured one',
  'ptau-power': 'read the Groth16 power test with Math.ceil, the off-by-one that cost one clean power',
};
if (REVERT && !REVERT_MODES[REVERT]) {
  console.error(`unknown ADV_REPRO_REVERT=${REVERT}. modes:`);
  for (const [k, v] of Object.entries(REVERT_MODES)) console.error(`  ${k.padEnd(14)}${v}`);
  process.exit(2);
}
if (REVERT) console.log(`  !! REVERT MODE ${REVERT}: ${REVERT_MODES[REVERT]}. The gate must FAIL.\n`);

let fails = 0;
const rows = [];
const row = (section, label, value, ok) => {
  if (ok === false) fails++;
  rows.push({ section, label, value: String(value), ok: ok === undefined ? null : !!ok });
  console.log(`  ${label.padEnd(52)}${String(value).padStart(20)}  ${ok === undefined ? '' : ok ? 'ok' : '*** FAIL ***'}`);
};
const head = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);

const sha = (p, corrupt = false) => {
  const b = readFileSync(p);
  return createHash('sha256').update(corrupt ? Buffer.concat([b, Buffer.from('x')]) : b).digest('hex');
};

// =================================================================================================
// 1. SOURCE INTEGRITY
// =================================================================================================
head('1. committed sources');

// fileURLToPath, not `new URL(...).pathname`: the repo path contains a space, so the raw pathname is
// percent-encoded and every existsSync against it silently reads false.
const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'MANIFEST.json');
if (!existsSync(MANIFEST_PATH)) {
  console.error(`  no MANIFEST.json — regenerate it with: node zk/scripts/adversary/repro.mjs --write-manifest`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

// ---- toolchain preflight -------------------------------------------------------------------------
// Two things this reproduction needs that the repository does not carry, and a reader deserves to be
// told which one is missing rather than watching a pinned digest fail for a reason it does not name.
// `zk/circom.exe` is a 12 MB binary; `zk/node_modules` is gitignored. Neither is a defect — but a
// DIFFERENT circom is: the pinned r1cs digests are circom 2.2.3 output, so 2.2.2 or 2.3.0 would fail
// section 3 with no explanation. That check happens here, loudly, before anything is built.
if (!process.argv.includes('--write-manifest')) {
  const gaps = [];
  if (!existsSync(P.CIRCOM)) {
    gaps.push(`  zk/circom.exe is missing. The circuits cannot be compiled without it.\n`
      + `    It is a ${(12039168).toLocaleString('en-US')}-byte binary and is deliberately not committed.\n`
      + `    Obtain circom ${manifest.toolchain.circom} and place it at ${P.CIRCOM}`);
  }
  if (!existsSync(path.join(P.ZK, 'node_modules', 'snarkjs'))) {
    gaps.push(`  zk/node_modules is missing (gitignored, as it should be).\n`
      + `    Run:  npm install --prefix "${P.ZK}"`);
  }
  if (gaps.length) {
    console.error('\nCANNOT REPRODUCE — the toolchain is incomplete:\n');
    for (const g of gaps) console.error(`${g}\n`);
    console.error('Both are recorded in docs/fix-reproducible-artifacts.md §9 as the two things a reader');
    console.error('must supply. Everything else the four refutations need is in the repository.');
    process.exit(2);
  }
  let ver = '';
  try {
    ver = execFileSync(P.CIRCOM, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch { ver = '(circom --version failed)'; }
  const want = manifest.toolchain.circom;
  row('tool', `circom version (pins are ${want} output)`, ver.replace(/^circom compiler /, ''),
    ver.includes(want));
}

if (process.argv.includes('--write-manifest')) {
  // Deliberately a separate, explicit invocation. A manifest that regenerates itself on every run is
  // a manifest that cannot fail.
  const files = {};
  const walk = (dir, pre) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), `${pre}${e.name}/`); continue; }
      if (!/\.(circom|mjs)$/.test(e.name)) continue;
      files[`${pre}${e.name}`] = sha(path.join(dir, e.name));
    }
  };
  walk(P.ADV_CIRCUITS, 'circuits/adv/');
  walk(path.join(P.ZK, 'scripts', 'adversary'), 'scripts/adversary/');
  writeFileSync(MANIFEST_PATH, JSON.stringify({ ...manifest, files }, null, 2) + '\n');
  console.log(`  wrote ${Object.keys(files).length} entries to MANIFEST.json`);
  process.exit(0);
}

let bad = 0;
let missing = 0;
const names = Object.keys(manifest.files);
for (const rel of names) {
  const abs = path.join(P.ZK, rel);
  if (!existsSync(abs)) { missing++; console.log(`    MISSING ${rel}`); continue; }
  const corrupt = REVERT === 'source-hash' && rel === 'circuits/adv/lpclosed2.circom';
  if (sha(abs, corrupt) !== manifest.files[rel]) { bad++; console.log(`    CHANGED ${rel}`); }
}
row('src', 'committed sources present', `${names.length - missing} / ${names.length}`, missing === 0);
row('src', 'committed sources match their pinned sha256', `${names.length - missing - bad} clean, ${bad} changed`, bad === 0);

// =================================================================================================
// 2. THE GENERATOR IS THE TRUST ROOT FOR THE options-risk CIRCUITS
// =================================================================================================
head('2. options-risk: regenerate the CDF circuits from their generator');

const genDir = path.join(P.WORK, 'circuits');
mkdirSync(genDir, { recursive: true });
mkdirSync(path.join(P.WORK, 'build'), { recursive: true });
const GEN = [
  ['ctl', 40, false], ['v24', 24, false], ['v28', 28, false], ['v32', 32, false],
  // lib24/lib40 are the same generator output with the `component main` line removed so they can be
  // INCLUDED as a library. That strip was a hand edit in the original session; it is scripted here.
  ['lib24', 24, true], ['lib40', 40, true],
];
let genOk = 0;
for (const [name, S, strip] of GEN) {
  try {
    execFileSync(process.execPath, [path.join(P.ZK, 'scripts', 'adversary', 'options', 'gen-variant.mjs')], {
      cwd: P.ZK,
      env: { ...process.env, VS: String(S), VNAME: name, VINC: '../../node_modules/circomlib/circuits/', ADV_WORK: P.WORK },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
  } catch (e) {
    console.log(`    generator FAILED for ${name}: ${(e.stderr || '').toString().slice(-300)}`);
    continue;
  }
  let made = readFileSync(path.join(genDir, `${name}.circom`), 'utf8');
  if (strip) made = made.split('\n').filter((l) => !l.startsWith('component main')).join('\n');
  const committed = readFileSync(path.join(P.ADV_CIRCUITS, `${name}.circom`), 'utf8');
  if (made === committed) genOk++;
  else console.log(`    ${name}: regenerated output differs from the committed circuit`);
}
row('opt', 'CDF circuits regenerate byte-for-byte from gen-variant.mjs', `${genOk} / ${GEN.length}`, genOk === GEN.length);

// =================================================================================================
// 3. BUILD + PIN. Everything below uses ONLY build/hez_final_12.ptau, which is in the repository.
// =================================================================================================
head('3. rebuild on the ceremony file already in the repository');

row('ptau', 'build/hez_final_12.ptau sha256', sha(P.PTAU12).slice(0, 16) + '…', sha(P.PTAU12) === manifest.ptau.hez_final_12);
row('ptau', 'bytes', statSync(P.PTAU12).size.toLocaleString('en-US'), statSync(P.PTAU12).size === 4801688);

const build = (names, sub, ptau) => {
  const args = [path.join(P.ZK, 'scripts', 'adversary', 'build-adv.mjs')];
  if (sub) args.push('--into', sub);
  if (ptau) args.push('--ptau', ptau);
  args.push(...names);
  try {
    execFileSync(process.execPath, args, { cwd: P.ZK, env: { ...process.env, ADV_WORK: P.WORK }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 });
    return true;
  } catch (e) {
    console.log(`    build FAILED: ${(e.stdout || '').toString().slice(-800)}${(e.stderr || '').toString().slice(-800)}`);
    return false;
  }
};

// ---- portfolio-gate: the wide and batched shapes, compiled only (no setup needed for the counts) --
const PORT = [
  // name, expected R1CS, expected groth16 budget, expected groth16 power
  ['portfoliogate4', 2736, 2773, 12],
  ['pg5', 3419, 3465, 12],
  ['pg6', 4102, 4157, 13],
  ['pg7', 4785, 4849, 13],
  ['pgb4', 2604, 2644, 12],
  ['pgb6', 3906, 3966, 12],
  ['pgc6', 3906, 3954, 12],
  ['pgc7', 4557, 4613, 13],
];
if (!build(PORT.map((r) => r[0]), '', '')) fails++;
for (const [name, nc, budget, power] of PORT) {
  const h = r1csHeader(path.join(P.WORK, `${name}.r1cs`));
  const want = REVERT === 'counts' && name === 'portfoliogate4' ? 5295 : nc;
  const b = h.nConstraints + h.nPubIn + h.nPubOut;
  // snarkjs main.cjs:4427 — groth16 cirPower = log2(budget) + 1, and its log2 is a bit-position FLOOR.
  // Math.ceil here lands one clean power out; that is exactly the error that put 2^14 in a report.
  const lg = REVERT === 'ptau-power' ? Math.ceil(Math.log2(b)) : Math.floor(Math.log2(b));
  const p = lg + 1;
  row('pg', `${name}: R1CS`, h.nConstraints, h.nConstraints === want);
  row('pg', `${name}: groth16 budget = R1CS + pubIn + pubOut`, b, b === budget);
  row('pg', `${name}: groth16 power = floor(log2(budget)) + 1`, p, p === power);
}
row('pg', 'the wide ceiling on the on-disk 2^12 is FIVE legs, not three', 'pg5 fits, pg6 does not',
  PORT.find((r) => r[0] === 'pg5')[3] === 12 && PORT.find((r) => r[0] === 'pg6')[3] === 13);

// ---- exec-verify + lp-risk: Plonk setup on hez_final_12, pinned to sha256 ------------------------
const PLONK = [
  // name, subdir, R1CS, Plonk, domain, nPublic
  ['xamin', 'advbuild', 929, 1787, 2048, 8],
  ['xapriv', 'advbuild', 929, 1781, 2048, 2],
  ['xacommit', 'advbuild', 1764, 3028, 4096, 2],
  ['lpclosed2', 'build', 1847, 3554, 4096, 4],
];
for (const [name, sub] of PLONK) if (!build([name], sub, P.PTAU12)) fails++;
for (const [name, sub, nc, ng, dom, npub] of PLONK) {
  const d = path.join(P.WORK, sub);
  const h = r1csHeader(path.join(d, `${name}.r1cs`));
  const f = plonkFacts(path.join(d, `${name}_plonk.zkey`));
  row('plonk', `${name}: R1CS`, h.nConstraints, h.nConstraints === nc);
  row('plonk', `${name}: Plonk gates`, f.nConstraints, f.nConstraints === ng);
  row('plonk', `${name}: domain`, f.domainSize, f.domainSize === dom);
  row('plonk', `${name}: public signals`, f.nPublic, f.nPublic === npub);
  const r1 = sha(path.join(d, `${name}.r1cs`));
  const zkeyPath = REVERT === 'plonk-bytes' && name === 'xamin'
    ? path.join(d, 'xapriv_plonk.zkey') : path.join(d, `${name}_plonk.zkey`);
  const z1 = sha(zkeyPath);
  row('bytes', `${name}: .r1cs sha256 matches the pin`, r1.slice(0, 12) + '…', r1 === manifest.artifacts[name].r1cs);
  row('bytes', `${name}: _plonk.zkey sha256 matches the pin`, z1.slice(0, 12) + '…', z1 === manifest.artifacts[name].zkey);
}

// =================================================================================================
// 4. WHAT NEEDS A CEREMONY FILE THAT IS NOT IN THE REPOSITORY
// =================================================================================================
head('4. the two claims that need a bigger ceremony file');

const p13 = [path.join(P.WORK, 'ptau', 'pot13_final.ptau'), path.join(P.WORK, 'pot13_final.ptau')].find(existsSync);
if (!p13) {
  row('13', 'local 2^13 present (run: ptau.mjs make 13, ~31 s offline)', 'absent — SKIPPED', undefined);
} else {
  const { ptauFacts } = await import('./ptau.mjs');
  const f = ptauFacts(p13);
  row('13', 'local 2^13 power', f.power, f.power === 13);
  row('13', 'local 2^13 bytes (NOT byte-reproducible)', f.bytes.toLocaleString('en-US'),
    f.bytes > 9_400_000 && f.bytes < 9_500_000);
  if (build(['price40b'], 'build', p13)) {
    const h = r1csHeader(path.join(P.WORK, 'build', 'price40b.r1cs'));
    const g = plonkFacts(path.join(P.WORK, 'build', 'price40b_plonk.zkey'));
    row('13', 'price40b: R1CS', h.nConstraints, h.nConstraints === 4172);
    row('13', 'price40b: Plonk gates', g.nConstraints, g.nConstraints === 7758);
    row('13', 'price40b: domain (needs 2^13, does not fit 2^12)', g.domainSize, g.domainSize === 8192);
    row('13', 'price40b: public signals', g.nPublic, g.nPublic === 13);
    const r = sha(path.join(P.WORK, 'build', 'price40b.r1cs'));
    row('13', 'price40b .r1cs sha256 matches the pin', r.slice(0, 12) + '…', r === manifest.artifacts.price40b.r1cs);
    row('13', 'price40b .zkey NOT pinned (built on a local ceremony)', 'by design', undefined);
  } else fails++;
}
const p17 = path.join(P.WORK, 'ptau', 'pot17_final.ptau');
row('17', 'local 2^17 present (run: ptau.mjs make 17, ~11 min, ~151 MB)',
  existsSync(p17) ? `${statSync(p17).size.toLocaleString('en-US')} bytes` : 'absent — lpexpectation SKIPPED', undefined);

// =================================================================================================
head('summary');
const bySection = {};
for (const r of rows) {
  if (r.ok === null) continue;
  bySection[r.section] ??= { pass: 0, fail: 0 };
  bySection[r.section][r.ok ? 'pass' : 'fail']++;
}
for (const [s, c] of Object.entries(bySection)) console.log(`  ${s.padEnd(10)}${String(c.pass).padStart(4)} pass  ${String(c.fail).padStart(3)} fail`);

const outFile = path.join(P.BUILD, 'adversary-repro.json');
writeFileSync(outFile, JSON.stringify({
  at: new Date().toISOString(),
  work: P.WORK,
  revert: REVERT || null,
  fails,
  rows,
}, null, 2) + '\n', 'utf8');
console.log(`\n  artifact: ${path.relative(P.ZK, outFile)}`);
console.log(`  ${fails === 0 ? 'ADVERSARY REPRO: PASSED' : `ADVERSARY REPRO: FAILED (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
