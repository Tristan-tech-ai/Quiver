// Compile, set up, and export one circuit. The same recipe for every circuit, so a third one cannot
// quietly differ from the first two.
//
//   node zk/scripts/build-circuit.mjs concentration
//
// Emits into build/:  <name>.r1cs · <name>_js/ · <name>_plonk.zkey · <name>_vk.json · <Name>Verifier.sol
//
// Two things this does that a hand-run sequence forgets. It renames circom's `witness_calculator.js`
// to `.cjs`, because the file is CommonJS and every package here is `type: module`, so the original
// name fails to load at exactly the moment a gate needs it. And it REFUSES to continue if the circuit
// does not fit the powers-of-tau on hand, with the numbers in the message, rather than letting snarkjs
// fail deeper down with something about a domain size.
import { execFileSync } from 'node:child_process';
import { renameSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ZK, 'build');
const PTAU = path.join(BUILD, 'hez_final_12.ptau');
const PTAU_CEILING = 4096;   // 2^12

const name = process.argv[2];
if (!name) { console.error('usage: node zk/scripts/build-circuit.mjs <circuit-name>'); process.exit(2); }

const src = path.join(ZK, 'circuits', `${name}.circom`);
if (!existsSync(src)) { console.error(`no such circuit: ${src}`); process.exit(2); }
if (!existsSync(PTAU)) { console.error(`missing ${PTAU} — the ceremony file the setup reads`); process.exit(2); }

const run = (cmd, args, label) => {
  process.stdout.write(`  ${label.padEnd(34)}`);
  const t = Date.now();
  try {
    execFileSync(cmd, args, { cwd: ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 });
    console.log(`ok  ${Date.now() - t} ms`);
  } catch (e) {
    console.log('FAILED');
    console.error(`\n${(e.stdout || '').toString()}\n${(e.stderr || '').toString()}`);
    process.exit(1);
  }
};

console.log(`Building ${name}\n`);

// 1. compile
run(path.join(ZK, 'circom.exe'), [`circuits/${name}.circom`, '--r1cs', '--wasm', '--sym', '-o', 'build'], 'circom compile');

// 2. does it fit? Checked BEFORE the setup, which is the expensive step and the confusing failure.
const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
const info = await snarkjs.r1cs.info(path.join(BUILD, `${name}.r1cs`));
console.log(`  ${'r1cs constraints'.padEnd(34)}${info.nConstraints}`);
// Plonk needs roughly (constraints + public) rounded up to a power of two, and each R1CS constraint
// can expand into more than one Plonk gate, so compare against the R1CS count with headroom rather
// than pretending the two are the same number.
// The R1CS-to-Plonk expansion is not a fixed factor. It is close to 2x for a comparator-heavy circuit
// and close to 1x for a chain of multiplications, and both shapes exist here. So refuse only what
// cannot fit under ANY expansion, and warn in the band between. The 2x guess turned away a probe
// circuit that fitted comfortably, which is a guard being wrong in the expensive direction.
if (info.nConstraints > PTAU_CEILING) {
  console.error(`\nREFUSING: ${info.nConstraints} R1CS constraints cannot fit hez_final_12's ${PTAU_CEILING} however they expand.`);
  console.error('Shrink the circuit or fetch a larger powers-of-tau file deliberately, not as a side effect of a build.');
  process.exit(1);
}
if (info.nConstraints * 2 > PTAU_CEILING) {
  console.log(`  ${'note'.padEnd(34)}may not fit: expands to between ${info.nConstraints} and ${info.nConstraints * 2} Plonk against a ${PTAU_CEILING} ceiling`);
}

// 3. plonk setup + exports
run(process.execPath, [path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs'), 'plonk', 'setup',
  `build/${name}.r1cs`, 'build/hez_final_12.ptau', `build/${name}_plonk.zkey`], 'plonk setup');
run(process.execPath, [path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs'), 'zkey', 'export', 'verificationkey',
  `build/${name}_plonk.zkey`, `build/${name}_vk.json`], 'export verification key');

const solName = `${name[0].toUpperCase()}${name.slice(1)}Verifier.sol`;
run(process.execPath, [path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs'), 'zkey', 'export', 'solidityverifier',
  `build/${name}_plonk.zkey`, `build/${solName}`], 'export solidity verifier');

// 4. the rename that is forgotten every single time
const jsDir = path.join(BUILD, `${name}_js`);
const wc = path.join(jsDir, 'witness_calculator.js');
if (existsSync(wc)) {
  renameSync(wc, path.join(jsDir, 'witness_calculator.cjs'));
  console.log(`  ${'witness_calculator.js → .cjs'.padEnd(34)}ok`);
}

const facts = await import('./circuit-facts.mjs');
const f = facts.plonkFacts(path.join(BUILD, `${name}_plonk.zkey`));
console.log(`\n  ${name}: ${info.nConstraints} R1CS · ${f.nConstraints} Plonk · ${f.nPublic} public · domain ${f.domainSize}`);
console.log(`  uses ${f.nConstraints} of ${PTAU_CEILING} available constraints`);
console.log(`  verifier: build/${solName} (${(readFileSync(path.join(BUILD, solName), 'utf8').length / 1024).toFixed(1)} kB of source)`);
