// Read nConstraints straight out of the .r1cs header. snarkjs r1cs.info takes minutes on this box
// under load; the header is 40-odd bytes and exact.
import __P from '../paths.mjs';
import { readFileSync } from 'node:fs';
export function r1csFacts(p) {
  const b = readFileSync(p);
  if (b.toString('utf8', 0, 4) !== 'r1cs') throw new Error(`${p}: not an r1cs`);
  const nSections = b.readUInt32LE(8);
  let off = 12; let hdr = null;
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    if (type === 1 && hdr === null) hdr = off + 12;
    off += 12 + size;
  }
  if (hdr === null) throw new Error(`${p}: no header section`);
  let q = hdr;
  const n8 = b.readUInt32LE(q); q += 4 + n8;
  const nWires = b.readUInt32LE(q); q += 4;
  const nPubOut = b.readUInt32LE(q); q += 4;
  const nPubIn = b.readUInt32LE(q); q += 4;
  const nPrvIn = b.readUInt32LE(q); q += 4;
  q += 8;  // nLabels
  const nConstraints = b.readUInt32LE(q);
  if (!(nConstraints > 0 && nWires > nConstraints / 4)) {
    throw new Error(`${p}: parsed ${nConstraints} constraints / ${nWires} wires — the offsets are wrong`);
  }
  return { nConstraints, nWires, nPubOut, nPubIn, nPrvIn };
}
if (process.argv[2]) for (const f of process.argv.slice(2)) console.log(f, JSON.stringify(r1csFacts(f)));
