// Read a circuit's real size out of its artifacts, instead of writing down what circom printed.
//
// WHY THIS EXISTS. `gateB0-kelly.mjs` recorded `plonkConstraints: 718` as a literal, and the README
// quoted "357 R1CS" — a number that is circom's NON-LINEAR count, not the constraint count in the
// .r1cs file, which snarkjs reports as 372. Neither figure was ever read back from the artifact it
// described. That is the same defect this project keeps finding elsewhere: a number asserted rather
// than measured, which cannot drift loudly because nothing compares it to anything.
//
// So both numbers now come out of the files themselves. The .r1cs count comes from snarkjs. The Plonk
// count is parsed straight from the zkey binary, where `plonk setup` writes it into the section-2
// header, so it is the count the proving key was actually built for.
//
//   node zk/scripts/circuit-facts.mjs              all circuits
//   node zk/scripts/circuit-facts.mjs kelly        one
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');

/**
 * Parse the Plonk zkey header. Format: "zkey" magic, version, nSections, then (id, size, bytes)*.
 * Section 1 is the protocol id; section 2 for Plonk carries nVars / nPublic / domainSize /
 * nAdditions / nConstraints after the two field moduli.
 */
export function plonkFacts(zkeyPath) {
  const b = readFileSync(zkeyPath);
  if (b.toString('utf8', 0, 4) !== 'zkey') throw new Error(`${zkeyPath}: not a zkey`);
  const nSections = b.readUInt32LE(8);

  let off = 12;
  const sections = new Map();
  for (let i = 0; i < nSections; i++) {
    const id = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    // A section id can repeat; the header sections we want are unique, so first-wins is safe.
    if (!sections.has(id)) sections.set(id, { start: off + 12, size });
    off += 12 + size;
  }

  const s1 = sections.get(1);
  if (!s1) throw new Error(`${zkeyPath}: no protocol section`);
  const protocol = b.readUInt32LE(s1.start);
  if (protocol !== 2) throw new Error(`${zkeyPath}: protocol ${protocol} is not Plonk (2)`);

  const s2 = sections.get(2);
  if (!s2) throw new Error(`${zkeyPath}: no Plonk header section`);
  let p = s2.start;
  const n8q = b.readUInt32LE(p); p += 4 + n8q;      // skip q
  const n8r = b.readUInt32LE(p); p += 4 + n8r;      // skip r
  const nVars = b.readUInt32LE(p); p += 4;
  const nPublic = b.readUInt32LE(p); p += 4;
  const domainSize = b.readUInt32LE(p); p += 4;
  const nAdditions = b.readUInt32LE(p); p += 4;
  const nConstraints = b.readUInt32LE(p);

  // Sanity, because a wrong offset would silently return a plausible-looking integer rather than
  // fail. The domain must be a power of two and must be able to hold the constraints.
  if (!(domainSize > 0 && (domainSize & (domainSize - 1)) === 0)) {
    throw new Error(`${zkeyPath}: domainSize ${domainSize} is not a power of two — the header parse is wrong`);
  }
  if (!(nConstraints > 0 && nConstraints <= domainSize)) {
    throw new Error(`${zkeyPath}: nConstraints ${nConstraints} does not fit domainSize ${domainSize} — the header parse is wrong`);
  }
  return { nVars, nPublic, domainSize, nAdditions, nConstraints, ptauPower: Math.log2(domainSize) };
}

export async function factsFor(name) {
  const r1csPath = path.join(BUILD, `${name}.r1cs`);
  const zkeyPath = path.join(BUILD, `${name}_plonk.zkey`);
  const out = { circuit: name };

  if (existsSync(r1csPath)) {
    const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
    const i = await snarkjs.r1cs.info(r1csPath);
    out.r1cs = { constraints: i.nConstraints, vars: i.nVars, public: i.nPubInputs + i.nOutputs };
  }
  if (existsSync(zkeyPath)) {
    out.plonk = plonkFacts(zkeyPath);
    out.zkeyBytes = readFileSync(zkeyPath).length;
  }
  return out;
}

// Only print when run directly. Without this guard, importing `plonkFacts` from a gate makes that
// gate emit this table into the middle of its own verdict, which is how a clean gate output turns
// into something nobody reads carefully.
const runDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (!runDirectly) { /* imported for plonkFacts / factsFor */ } else {

const only = process.argv[2];
const names = only ? [only] : ['liquidation', 'kelly'];

console.log('Circuit sizes, read from the artifacts:\n');
console.log(`  ${'circuit'.padEnd(14)}${'R1CS'.padStart(8)}${'Plonk'.padStart(9)}${'public'.padStart(8)}${'domain'.padStart(9)}${'zkey'.padStart(10)}`);
const all = [];
for (const n of names) {
  const f = await factsFor(n);
  all.push(f);
  if (!f.r1cs && !f.plonk) { console.log(`  ${n.padEnd(14)}  (no artifacts built)`); continue; }
  console.log(`  ${n.padEnd(14)}${String(f.r1cs?.constraints ?? '?').padStart(8)}${String(f.plonk?.nConstraints ?? '?').padStart(9)}${String(f.plonk?.nPublic ?? f.r1cs?.public ?? '?').padStart(8)}${String(f.plonk?.domainSize ?? '?').padStart(9)}${(f.zkeyBytes ? (f.zkeyBytes / 1048576).toFixed(1) + ' MB' : '?').padStart(10)}`);
}

// The ceiling that decides what can be built without a new ceremony file.
const ptau = existsSync(path.join(BUILD, 'hez_final_12.ptau'));
console.log(`\n  powers-of-tau on hand: ${ptau ? 'hez_final_12 → 4,096 constraint ceiling' : 'NONE FOUND'}`);
for (const f of all) {
  if (f.plonk) {
    const head = 4096 / f.plonk.nConstraints;
    console.log(`  ${f.circuit}: uses ${f.plonk.nConstraints} of 4,096 — room for ${Math.floor(head)}x this circuit before a bigger ptau is needed`);
  }
}
console.log(`\n  Every number above was read from build/*.r1cs and build/*_plonk.zkey, not written down.`);

}
