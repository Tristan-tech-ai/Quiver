// Does Plonk verifier gas depend on constraint count or only on nPublic (+ domain)?
// Reads every *-evm gate artifact on disk and joins it to the zkey header of its circuit.
import __P from './paths.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const BUILD = __P.BUILD;

function zkeyHeader(p) {
  const b = readFileSync(p);
  const nSections = b.readUInt32LE(8);
  let off = 12; const sec = new Map();
  for (let i = 0; i < nSections; i++) {
    const id = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    if (!sec.has(id)) sec.set(id, { start: off + 12, size });
    off += 12 + size;
  }
  let q = sec.get(2).start;
  const n8q = b.readUInt32LE(q); q += 4 + n8q;
  const n8r = b.readUInt32LE(q); q += 4 + n8r;
  const nVars = b.readUInt32LE(q); q += 4;
  const nPublic = b.readUInt32LE(q); q += 4;
  const domainSize = b.readUInt32LE(q); q += 4;
  const nAdditions = b.readUInt32LE(q); q += 4;
  const nConstraints = b.readUInt32LE(q);
  return { nPublic, domainSize, nConstraints };
}

// map gate artifact -> circuit name
const MAP = {
  'gateB2-kelly-evm.json': 'kelly',
  'gateB3-2-concentration-evm.json': 'concentration',
  'gateB4-2-divergence-evm.json': 'divergence',
  'gateB5-2-constantproduct-evm.json': 'constantproduct',
  'gateB5-5-execadverse-evm.json': 'execadverse',
  'gateB8-2-portfolio-evm.json': 'portfoliogate',
  'gateB9-2-widening-evm.json': null,
};

const rows = [];
for (const f of readdirSync(BUILD).filter(n => n.endsWith('.json') && n.includes('evm'))) {
  const j = JSON.parse(readFileSync(path.join(BUILD, f), 'utf8'));
  let name = MAP[f];
  if (name === undefined) name = null;
  const gas = Number(j.acceptGas ?? j.gas ?? j.acceptGasUsed ?? NaN);
  const bytes = j.verifierBytes ?? null;
  let hdr = null;
  if (name && existsSync(path.join(BUILD, `${name}_plonk.zkey`))) hdr = zkeyHeader(path.join(BUILD, `${name}_plonk.zkey`));
  rows.push({ file: f, circuit: name, gas, bytes, ...(hdr ?? {}) });
}
rows.sort((a, b) => (a.nPublic ?? 99) - (b.nPublic ?? 99));
console.log(JSON.stringify(rows, null, 1));

// least squares of gas on nPublic for the rows we could join, plus residual vs constraints
const good = rows.filter(r => Number.isFinite(r.gas) && r.nPublic);
if (good.length >= 2) {
  const n = good.length;
  const sx = good.reduce((a, r) => a + r.nPublic, 0);
  const sy = good.reduce((a, r) => a + r.gas, 0);
  const sxx = good.reduce((a, r) => a + r.nPublic ** 2, 0);
  const sxy = good.reduce((a, r) => a + r.nPublic * r.gas, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  console.log(`\ngas ~ ${intercept.toFixed(0)} + ${slope.toFixed(1)} * nPublic   (n=${n})`);
  for (const r of good) {
    const pred = intercept + slope * r.nPublic;
    console.log(`  ${String(r.circuit).padEnd(16)} nPublic=${String(r.nPublic).padStart(3)} constraints=${String(r.nConstraints).padStart(5)} domain=${r.domainSize} gas=${r.gas} pred=${pred.toFixed(0)} resid=${(r.gas - pred).toFixed(0)}`);
  }
}
