// Independent parse of .r1cs + _plonk.zkey headers. No snarkjs, no circuit-facts.mjs.
// r1cs: magic "r1cs" u32ver u32nSections, then (u32 type, u64 size, bytes)
//   section 1 header: u32 n8, prime[n8], u32 nWires, u32 nPubOut, u32 nPubIn, u32 nPrvIn,
//                     u64 nLabels, u32 nConstraints
import __P from './paths.mjs';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const BUILD = process.argv[2];
const names = process.argv.slice(3);

function r1csHeader(p) {
  const b = readFileSync(p);
  if (b.toString('utf8', 0, 4) !== 'r1cs') throw new Error('not r1cs: ' + p);
  const nSections = b.readUInt32LE(8);
  let off = 12;
  let hdr = null;
  const seen = [];
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    seen.push([type, size]);
    if (type === 1 && hdr === null) {
      let q = off + 12;
      const n8 = b.readUInt32LE(q); q += 4 + n8;
      const nWires = b.readUInt32LE(q); q += 4;
      const nPubOut = b.readUInt32LE(q); q += 4;
      const nPubIn = b.readUInt32LE(q); q += 4;
      const nPrvIn = b.readUInt32LE(q); q += 4;
      q += 8; // nLabels
      const nConstraints = b.readUInt32LE(q);
      hdr = { n8, nWires, nPubOut, nPubIn, nPrvIn, nConstraints };
    }
    off += 12 + size;
  }
  return { hdr, sections: seen, bytes: b.length };
}

function zkeyHeader(p) {
  const b = readFileSync(p);
  if (b.toString('utf8', 0, 4) !== 'zkey') throw new Error('not zkey: ' + p);
  const nSections = b.readUInt32LE(8);
  let off = 12;
  const sec = new Map();
  for (let i = 0; i < nSections; i++) {
    const id = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    if (!sec.has(id)) sec.set(id, { start: off + 12, size });
    off += 12 + size;
  }
  const s1 = sec.get(1);
  const protocol = b.readUInt32LE(s1.start);
  const s2 = sec.get(2);
  let q = s2.start;
  const n8q = b.readUInt32LE(q); q += 4 + n8q;
  const n8r = b.readUInt32LE(q); q += 4 + n8r;
  const nVars = b.readUInt32LE(q); q += 4;
  const nPublic = b.readUInt32LE(q); q += 4;
  const domainSize = b.readUInt32LE(q); q += 4;
  const nAdditions = b.readUInt32LE(q); q += 4;
  const nConstraints = b.readUInt32LE(q);
  return { protocol, nVars, nPublic, domainSize, nAdditions, nConstraints, bytes: b.length };
}

for (const n of names) {
  const rp = path.join(BUILD, n + '.r1cs');
  const zp = path.join(BUILD, n + '_plonk.zkey');
  const out = { circuit: n };
  if (existsSync(rp)) out.r1cs = r1csHeader(rp);
  if (existsSync(zp)) out.zkey = zkeyHeader(zp);
  console.log(JSON.stringify(out, null, 1));
}
