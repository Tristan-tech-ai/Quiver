// ADVERSARIAL PROBE 5 — "BIT WIDTHS regained: ... full parity with liquidation.circom, which three
// legs in one domain could not afford."
//
// That claim is about a circuit that ALSO takes the argmin inside. The investigator's own per-leg work
// showed the argmin can live outside. Drop the argmin from the batched circuit and the question
// becomes: do three legs at FULL parity (NB_M 80, NB_Q 60, NB_P 60, NB_TOL 92) fit one Plonk domain on
// the ceremony file already on disk?
import __P from '../paths.mjs';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ZK = __P.ZK;
const SC = __P.WORK;
const CLI = path.join(ZK, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
const sjMod = await import('file:///' + path.join(ZK, 'node_modules', 'snarkjs', 'build', 'main.cjs').replace(/\\/g, '/'));
const sj = sjMod.default ?? sjMod;
const { plonkFacts } = await import('file:///' + path.join(ZK, 'scripts', 'circuit-facts.mjs').replace(/\\/g, '/'));

console.log('ADVERSARIAL PROBE 5 — full bit-width parity under PLONK on hez_final_12\n');
console.log('  reference points, read from the artifacts already in build/:');
for (const n of ['liquidation', 'portfolioleg', 'portfoliogate']) {
  const z = path.join(ZK, 'build', `${n}_plonk.zkey`);
  if (!existsSync(z)) { console.log(`    ${n.padEnd(16)} no zkey`); continue; }
  const f = plonkFacts(z);
  const r = await sj.r1cs.info(path.join(ZK, 'build', `${n}.r1cs`));
  console.log(`    ${n.padEnd(16)}${String(r.nConstraints).padStart(6)} R1CS · ${String(f.nConstraints).padStart(6)} Plonk · domain ${f.domainSize} · nPublic ${f.nPublic}`);
}

console.log('\n  the batched shape (argmin outside), FULL parity, PLONK, on-disk 2^12:');
const out = [];
for (const N of [2, 3, 4]) {
  const r1cs = path.join(SC, `pgd${N}.r1cs`);
  if (!existsSync(r1cs)) { console.log(`    N=${N} no r1cs`); continue; }
  const i = await sj.r1cs.info(r1cs);
  const z = path.join(SC, `pgd${N}_plonk.zkey`);
  let err = '';
  try {
    execFileSync(process.execPath, [CLI, 'plonk', 'setup', r1cs, path.join(ZK, 'build', 'hez_final_12.ptau'), z],
      { cwd: ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 });
  } catch (e) { err = ((e.stdout || '') + (e.stderr || '')).toString(); }
  const built = existsSync(z) && statSync(z).size > 0;
  const f = built ? plonkFacts(z) : null;
  console.log(`    N=${N}${String(i.nConstraints).padStart(15)} R1CS · ${built ? `${String(f.nConstraints).padStart(6)} Plonk · domain ${f.domainSize} · nPublic ${f.nPublic} · BUILDS` : `REFUSED — ${(err.match(/too big[^\r\n]*/) || [''])[0]}`}`);
  out.push({ N, r1cs: i.nConstraints, built, plonk: f?.nConstraints ?? null, domain: f?.domainSize ?? null, nPublic: f?.nPublic ?? null });
}
const three = out.find((o) => o.N === 3);
console.log(`\n  [${three?.built ? 'REFUTED' : 'stands'}] "three legs in one domain could not afford full parity"`);
if (three?.built) console.log(`           three legs at NB_M 80 / NB_Q 60 / NB_P 60 / NB_TOL 92: ${three.plonk} Plonk in a ${three.domain} domain, on hez_final_12`);
const four = out.find((o) => o.N === 4);
if (four) console.log(`  [${four.built ? 'and four legs too' : 'four legs is the ceiling breach'}] N=4: ${four.built ? `${four.plonk} Plonk, domain ${four.domain}` : 'refused — the bound can fail'}`);
writeFileSync(path.join(SC, 'probe5.json'), JSON.stringify({ at: new Date().toISOString(), out }, null, 2) + '\n', 'utf8');
await globalThis.curve_bn128?.terminate();
