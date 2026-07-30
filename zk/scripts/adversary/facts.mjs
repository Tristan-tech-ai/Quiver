// Independent artifact reader. No snarkjs, no circuit-facts.mjs.
// r1cs header: magic(4) version(4) nSections(4) then [type(4) size(8) body].
// section 1 body: fieldSize(4) prime(fieldSize) nWires(4) nPubOut(4) nPubIn(4)
//                 nPrvIn(4) nLabels(8) nConstraints(4)
// nWires -> nConstraints is 4+4+4+4+8 = 24 bytes. Getting this 20 cost lp-risk a green-on-zeros row.
import __P from './paths.mjs';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const BUILD = __P.BUILD;

function r1csFacts(p) {
  const b = readFileSync(p);
  if (b.toString('utf8', 0, 4) !== 'r1cs') throw new Error(`${p}: not r1cs`);
  const nSections = b.readUInt32LE(8);
  let o = 12;
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(o); o += 4;
    const size = Number(b.readBigUInt64LE(o)); o += 8;
    if (type === 1) {
      let h = o;
      const fieldSize = b.readUInt32LE(h); h += 4 + fieldSize;
      const nWires = b.readUInt32LE(h); h += 4;
      const nPubOut = b.readUInt32LE(h); h += 4;
      const nPubIn = b.readUInt32LE(h); h += 4;
      const nPrvIn = b.readUInt32LE(h); h += 4;
      const nLabels = Number(b.readBigUInt64LE(h)); h += 8;
      const nConstraints = b.readUInt32LE(h);
      if (!nWires || !nConstraints) throw new Error(`${p}: zero counts, parser is lying`);
      return { nWires, nPubOut, nPubIn, nPrvIn, nLabels, nConstraints };
    }
    o += size;
  }
  throw new Error(`${p}: no header section`);
}

// plonk zkey section 2: n8q(4) q(n8q) n8r(4) r(n8r) nVars(4) nPublic(4) domainSize(4)
//                       nAdditions(4) nConstraints(4)
function plonkFacts(p) {
  const b = readFileSync(p);
  if (b.toString('utf8', 0, 4) !== 'zkey') throw new Error(`${p}: not a zkey`);
  const nSections = b.readUInt32LE(8);
  let o = 12;
  let protocol = null;
  const secs = {};
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(o); o += 4;
    const size = Number(b.readBigUInt64LE(o)); o += 8;
    secs[type] = o;
    o += size;
  }
  if (secs[1] !== undefined) protocol = b.readUInt32LE(secs[1]);
  if (protocol !== 2) return { protocol, note: 'not plonk' };
  let h = secs[2];
  const n8q = b.readUInt32LE(h); h += 4 + n8q;
  const n8r = b.readUInt32LE(h); h += 4 + n8r;
  const nVars = b.readUInt32LE(h); h += 4;
  const nPublic = b.readUInt32LE(h); h += 4;
  const domainSize = b.readUInt32LE(h); h += 4;
  const nAdditions = b.readUInt32LE(h); h += 4;
  const nConstraints = b.readUInt32LE(h);
  return { protocol, nVars, nPublic, domainSize, nAdditions, plonk: nConstraints };
}

const names = process.argv.slice(2);
const list = names.length ? names : [
  'liquidation', 'kelly', 'concentration', 'divergence', 'constantproduct',
  'execadverse', 'greeks', 'greeksfp', 'greekssigned', 'parity', 'ncdf',
  'lpbracket', 'lpexpectation', 'portfoliogate', 'portfoliogate4', 'portfolioleg',
  'kellybatch1', 'kellybatch2', 'kellybatch3', 'kellybatch4', 'padprobe',
];
const rows = [];
for (const n of list) {
  const r1 = path.join(BUILD, `${n}.r1cs`);
  const zk = path.join(BUILD, `${n}_plonk.zkey`);
  const row = { name: n };
  if (existsSync(r1)) Object.assign(row, r1csFacts(r1));
  else row.r1cs = 'ABSENT';
  if (existsSync(zk)) { Object.assign(row, plonkFacts(zk)); row.zkeyBytes = statSync(zk).size; }
  else row.plonk = 'NO ZKEY';
  rows.push(row);
}
console.log(JSON.stringify(rows, null, 1));
for (const r of rows) {
  const pub = r.nPubOut !== undefined ? r.nPubOut + r.nPubIn : '?';
  console.log(
    `${r.name.padEnd(16)} R1CS ${String(r.nConstraints ?? '-').padStart(6)}` +
    `  Plonk ${String(r.plonk ?? '-').padStart(6)}` +
    `  domain ${String(r.domainSize ?? '-').padStart(6)}` +
    `  pub ${String(pub).padStart(3)}  prvIn ${String(r.nPrvIn ?? '-').padStart(3)}`,
  );
}
