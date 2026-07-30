// The 2^17 half of the lp-risk row: what `lpexpectation.circom` (36,613 R1CS) actually costs.
//
//   node zk/scripts/adversary/ptau.mjs make 17            ~11 min, offline, once
//   node zk/scripts/adversary/lp/expsetup.mjs             ~10 s once the ceremony file exists
//
// This reproduces the three figures PHASE_B_VERIFIED item 41 recorded: the Plonk gate count, the zkey
// size and the verifier size. It does NOT measure prove time or gas, and does not pretend to: those
// need a witness for a circuit with 246 private inputs and no encoder was ever written for it. Item 41
// says they were never measured; after this script they are still never measured, and that is the
// honest state rather than a number produced by a guess.
//
// Cost warning, stated because the artifact is large: the ceremony file is ~151 MB and the zkey is
// ~242 MB. Neither is committed. Both land under ADV_WORK.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import P from '../paths.mjs';
import { ptauFacts } from '../ptau.mjs';

const R1CS = path.join(P.BUILD, 'lpexpectation.r1cs');
if (!existsSync(R1CS)) {
  console.error(`missing ${R1CS} — build it with: node zk/scripts/build-circuit.mjs lpexpectation`);
  process.exit(2);
}
const PTAU = path.join(P.WORK, 'ptau', 'pot17_final.ptau');
if (!existsSync(PTAU)) {
  console.error('no local 2^17 ceremony file. Produce one, offline, with:');
  console.error('  node zk/scripts/adversary/ptau.mjs make 17          (~11 minutes, ~151 MB)');
  process.exit(2);
}

const out = path.join(P.WORK, 'build');
const zkey = path.join(out, 'lpexpectation_plonk.zkey');
const vk = path.join(out, 'lpexpectation_vk.json');
const sol = path.join(out, 'LpexpectationVerifier.sol');

const step = (args, label) => {
  process.stdout.write(`  ${label.padEnd(40)}`);
  const t = Date.now();
  try {
    execFileSync(process.execPath, ['--max-old-space-size=8192', P.CLI, ...args],
      { cwd: P.ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 });
    console.log(`ok  ${((Date.now() - t) / 1000).toFixed(1)} s`);
  } catch (e) {
    console.log('FAILED');
    console.error(`${(e.stdout || '').toString().slice(-3000)}\n${(e.stderr || '').toString().slice(-3000)}`);
    process.exit(1);
  }
};

const f = ptauFacts(PTAU);
console.log(`  ceremony file   power ${f.power}, domain ${f.domain}, ${f.bytes.toLocaleString('en-US')} bytes (locally generated)\n`);

step(['plonk', 'setup', R1CS, PTAU, zkey], 'plonk setup lpexpectation');
step(['zkey', 'export', 'verificationkey', zkey, vk], 'export verification key');
step(['zkey', 'export', 'solidityverifier', zkey, sol], 'export solidity verifier');

const { plonkFacts } = await import('../../circuit-facts.mjs');
const pf = plonkFacts(zkey);
const { r1csHeader } = await import('../r1cs-probe.mjs');
const rh = r1csHeader(R1CS);

let fails = 0;
const row = (label, val, ok) => {
  if (ok === false) fails++;
  console.log(`  ${label.padEnd(40)}${String(val).padStart(22)}  ${ok === undefined ? '' : ok ? 'ok' : 'FAIL'}`);
};
console.log('');
row('R1CS constraints', rh.nConstraints.toLocaleString('en-US'), rh.nConstraints === 36613);
row('private inputs', rh.nPrvIn, rh.nPrvIn === 246);
row('Plonk gates (zkey section-2 header)', pf.nConstraints.toLocaleString('en-US'), pf.nConstraints === 71364);
row('domain', pf.domainSize.toLocaleString('en-US'), pf.domainSize === 131072);
row('zkey bytes', statSync(zkey).size.toLocaleString('en-US'), statSync(zkey).size === 242434916);
// NOT asserted, and the first version of this script wrongly did. The exported verifier embeds the
// verification key as DECIMAL LITERALS, and those come from the ceremony file — so on a locally
// generated ptau its source length varies by the digit counts of a handful of field elements. Measured:
// 33,253 bytes on the adversary's 2^17, 33,249 on this one. Four characters, from a different ceremony.
// The zkey size above IS stable, because it is structural. Pinning the .sol length would be a check
// that goes red on entropy.
row('verifier source bytes (ceremony-dependent, NOT pinned)', statSync(sol).size.toLocaleString('en-US'));
row('verifier source within 64 B of the recorded 33,253', Math.abs(statSync(sol).size - 33253),
  Math.abs(statSync(sol).size - 33253) <= 64);
console.log('\n  prove time and gas: STILL UNMEASURED — no witness encoder exists for 246 private inputs.');
console.log(`  ${fails === 0 ? 'EXPSETUP REPRODUCES' : `EXPSETUP FAILED (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
