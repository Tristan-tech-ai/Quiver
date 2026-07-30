// Measure R1CS and REAL Plonk constraint counts for the S variants, against the ptau on hand.
// circom prints "non-linear constraints" AND "linear constraints"; neither is the .r1cs count, so
// both numbers here come out of the artifacts (snarkjs r1cs.info, and the zkey section-2 header).
import __P from '../paths.mjs';
import path from 'node:path';
const { snarkjs, shutdown } = await import(__P.zkUrl("scripts/lib/gatekit.mjs"));
const { plonkFacts } = await import(__P.zkUrl("scripts/circuit-facts.mjs"));

const SP = __P.WORK;
const PTAU = __P.PTAU12;
const sj = await snarkjs();

const names = process.argv.slice(2);
for (const n of names) {
  const r1cs = path.join(SP, 'build', `${n}.r1cs`);
  const i = await sj.r1cs.info(r1cs);
  let plonk = null;
  const zkey = path.join(SP, 'build', `${n}_plonk.zkey`);
  try {
    await sj.plonk.setup(r1cs, PTAU, zkey);
    plonk = plonkFacts(zkey);
  } catch (e) { plonk = { error: String(e.message || e).slice(0, 140) }; }
  console.log(`${n}: R1CS ${i.nConstraints}  vars ${i.nVars}  public ${i.nPubInputs + i.nOutputs}  |  Plonk ${plonk.nConstraints ?? plonk.error}  domain ${plonk.domainSize ?? '-'}  ptauPower ${plonk.ptauPower ?? '-'}`);
}
await shutdown();
