// Compile one or more circuits from zk/circuits/adv/ into the work directory.
//
//   node zk/scripts/adversary/build-adv.mjs pg5 pg6 pg7
//   node zk/scripts/adversary/build-adv.mjs --into build lpclosed2
//   ADV_WORK=/tmp/clean node zk/scripts/adversary/build-adv.mjs pgb4
//
// This is NOT build-circuit.mjs. That script hardcodes hez_final_12, refuses anything over 4,096, and
// renames witness_calculator.js to .cjs — all three correct for the shipped circuits and all three
// wrong here. The rescued probes were written against raw circom output (`witness_calculator.js`) and
// several of them exist precisely to measure what happens ABOVE the 4,096 ceiling, so a builder that
// refuses at 4,096 cannot reproduce them.
//
// Nothing is written into the repository. Every artifact lands under ADV_WORK (default zk/build/adv).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import P from './paths.mjs';

const args = process.argv.slice(2);
let sub = '';
let ptau = '';
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--into') { sub = args[++i]; continue; }
  // --setup            also run plonk setup + vk + solidity verifier, against hez_final_12
  // --ptau <file>      use that ceremony file instead (implies --setup)
  // A bare --setup takes NO value: an optional positional after a flag silently ate the first circuit
  // name the first time this was written, and snarkjs then reported a missing file called `xamin`.
  if (args[i] === '--setup') { ptau = ptau || P.PTAU12; continue; }
  if (args[i] === '--ptau') { ptau = args[++i]; continue; }
  names.push(args[i]);
}
if (!names.length) {
  console.error('usage: build-adv.mjs [--into <subdir>] [--setup [<ptau>]] <circuit> [<circuit> ...]');
  process.exit(2);
}

const outDir = sub ? path.join(P.WORK, sub) : P.WORK;
mkdirSync(outDir, { recursive: true });

let fails = 0;
for (const name of names) {
  // A circuit may live in zk/circuits/adv (rescued) or zk/circuits (shipped, e.g. portfoliogate4),
  // and the probes need both in the same work directory.
  const cand = [path.join(P.ADV_CIRCUITS, `${name}.circom`), path.join(P.CIRCUITS, `${name}.circom`)];
  const src = cand.find(existsSync);
  if (!src) {
    console.error(`  ${name.padEnd(18)}NO SOURCE — looked in circuits/adv/ and circuits/`);
    fails++;
    continue;
  }
  process.stdout.write(`  ${name.padEnd(18)}`);
  const t = Date.now();
  try {
    execFileSync(P.CIRCOM, [src, '--r1cs', '--wasm', '--sym', '-o', outDir],
      { cwd: P.ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 });
  } catch (e) {
    console.log('circom FAILED');
    console.error(`${(e.stdout || '').toString().slice(-2500)}\n${(e.stderr || '').toString().slice(-2500)}`);
    fails++;
    continue;
  }
  // Some probes load witness_calculator.cjs, others witness_calculator.js. circom writes .js; keep it
  // and add the .cjs alias, so neither convention breaks.
  const js = path.join(outDir, `${name}_js`, 'witness_calculator.js');
  if (existsSync(js)) copyFileSync(js, path.join(outDir, `${name}_js`, 'witness_calculator.cjs'));
  console.log(`ok  ${Date.now() - t} ms   ${path.relative(P.ZK, path.join(outDir, `${name}.r1cs`))}`);

  if (!ptau) continue;
  // Plonk setup is a deterministic function of (r1cs, ptau) — no contribution, no entropy — so a
  // reader who rebuilds on the SAME ptau gets byte-identical zkeys and byte-identical verifier
  // bytecode. On a locally generated ptau the ptau itself is not byte-reproducible, so the zkey is
  // not either; the constraint counts, domain and gas figures still are.
  const r1cs = path.join(outDir, `${name}.r1cs`);
  const zkey = path.join(outDir, `${name}_plonk.zkey`);
  const vk = path.join(outDir, `${name}_vk.json`);
  const sol = path.join(outDir, `${name[0].toUpperCase()}${name.slice(1)}Verifier.sol`);
  const step = (a, label) => {
    process.stdout.write(`    ${label.padEnd(30)}`);
    const t0 = Date.now();
    try {
      execFileSync(process.execPath, ['--max-old-space-size=8192', P.CLI, ...a],
        { cwd: P.ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 });
      console.log(`ok  ${Date.now() - t0} ms`);
      return true;
    } catch (e) {
      console.log('FAILED');
      console.error(`${(e.stdout || '').toString().slice(-2000)}\n${(e.stderr || '').toString().slice(-2000)}`);
      return false;
    }
  };
  if (!step(['plonk', 'setup', r1cs, ptau, zkey], `plonk setup vs ${path.basename(ptau)}`)) { fails++; continue; }
  // snarkjs's JS plonk.setup has returned WITHOUT throwing on a circuit too big for the ptau, leaving
  // a 12-byte zkey that a later step reads as success. That is the shared-infrastructure defect two
  // agents hit independently in one session, so the size is checked here rather than assumed.
  const zs = existsSync(zkey) ? (await import('node:fs')).statSync(zkey).size : 0;
  if (zs < 100_000) {
    console.error(`    REFUSING: ${path.basename(zkey)} is ${zs} bytes — plonk setup did not produce a zkey.`);
    fails++;
    continue;
  }
  if (!step(['zkey', 'export', 'verificationkey', zkey, vk], 'export verification key')) { fails++; continue; }
  if (!step(['zkey', 'export', 'solidityverifier', zkey, sol], 'export solidity verifier')) { fails++; continue; }
}

if (fails) { console.error(`\n  ${fails} circuit(s) failed`); process.exit(1); }
