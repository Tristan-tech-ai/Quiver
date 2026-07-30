// Independent .r1cs section-1 header parser. No snarkjs, no circuit-facts.mjs.
// Non-vacuity guard: throws on a zero nWires/nConstraints so a row cannot pass green on zeros.
import __P from './paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BUILD = process.argv[2] || __P.BUILD;

export function r1csHeader(file) {
  const b = fs.readFileSync(file);
  const magic = b.toString('ascii', 0, 4);
  if (magic !== 'r1cs') throw new Error(`${file}: not an r1cs (magic ${JSON.stringify(magic)})`);
  const nSections = b.readUInt32LE(8);
  let off = 12;
  let hdr = null;
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(off); off += 4;
    const size = Number(b.readBigUInt64LE(off)); off += 8;
    if (type === 1) {
      let p = off;
      const n8 = b.readUInt32LE(p); p += 4;
      p += n8;                                  // the prime
      const nWires = b.readUInt32LE(p); p += 4;
      const nPubOut = b.readUInt32LE(p); p += 4;
      const nPubIn = b.readUInt32LE(p); p += 4;
      const nPrvIn = b.readUInt32LE(p); p += 4;
      const nLabels = Number(b.readBigUInt64LE(p)); p += 8;
      const nConstraints = b.readUInt32LE(p);
      hdr = { n8, nWires, nPubOut, nPubIn, nPrvIn, nLabels, nConstraints };
    }
    off += size;
  }
  if (!hdr) throw new Error(`${file}: no section 1`);
  if (!(hdr.nWires > 0) || !(hdr.nConstraints > 0)) {
    throw new Error(`${file}: vacuous header nWires=${hdr.nWires} nConstraints=${hdr.nConstraints}`);
  }
  return hdr;
}

// `process.argv[1]` is undefined when this module is imported from `node --input-type=module -e`,
// and the original guard dereferenced it unconditionally — so importing the parser crashed instead of
// exporting it. Guarded here; the parser itself is untouched.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const files = fs.readdirSync(BUILD).filter((f) => f.endsWith('.r1cs')).sort();
  const rows = [];
  for (const f of files) {
    const h = r1csHeader(path.join(BUILD, f));
    rows.push({ circuit: f.replace(/\.r1cs$/, ''), ...h });
  }
  let zero = 0;
  for (const r of rows) {
    if (r.nPrvIn === 0) zero++;
    console.log(
      `${r.circuit.padEnd(18)} R1CS=${String(r.nConstraints).padStart(6)}  pubOut=${String(r.nPubOut).padStart(3)}  pubIn=${String(r.nPubIn).padStart(3)}  prvIn=${String(r.nPrvIn).padStart(4)}  wires=${r.nWires}`
    );
  }
  console.log(`\ncircuits: ${rows.length}`);
  console.log(`nPrvIn == 0: ${zero}`);
  console.log(`nPrvIn > 0 : ${rows.filter((r) => r.nPrvIn > 0).map((r) => `${r.circuit}(${r.nPrvIn})`).join(', ')}`);
}
