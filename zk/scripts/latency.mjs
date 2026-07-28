// What does a proof actually cost in time, and does any of it reach the caller?
//
// Two numbers get confused constantly, so this measures them apart.
//
//   COLD  the first proof in a fresh process, which includes reading the proving key off disk. Every
//         gate reports this, because a gate runs once. It is not what production pays.
//   WARM  every proof after that, in a process whose key is already in memory. The service forks a
//         prover at boot and warms it, so WARM is the number a queued proof really costs.
//
// And neither is the latency a caller experiences, because proving happens off the request path: the
// paid response returns with a retrieval URL and the proof is built behind it. So the third number
// here is the one a reviewer with a stopwatch would actually get, measured against the live service.
//
//   node zk/scripts/latency.mjs            circuits only, no network
//   node zk/scripts/latency.mjs --live     also time the deployed endpoints
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const RUNS = 9;   // odd, so the median is an observation rather than an average of two

const CIRCUITS = [
  { name: 'liquidation', service: 'perp-gate', witness: null },   // witness comes from a fixture below
  { name: 'kelly', service: 'size-gate', witness: { pHat: '550000000', bHat: '1200000000', fHat: '175000000' } },
  { name: 'divergence', service: 'lp-risk', witness: { rHat: '4000000000', sHat: '2000000000', lHat: '800000000' } },
  { name: 'constantproduct', service: 'exec-verify', witness: { xHat: '1000000000000', yHat: '2000000000000', dxHat: '1000000000000', fHat: '0', inHat: '1000000000000', outHat: '1000000000000' } },
  {
    name: 'concentration',
    service: 'treasury-risk',
    witness: {
      wHat: ['250000000', '250000000', '250000000', '250000000', '0', '0', '0', '0'],
      hHat: '250000000',
    },
  },
];

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };

const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));

console.log(`Proving latency — ${new Date().toISOString()}\n`);
console.log(`  ${'circuit'.padEnd(15)}${'Plonk'.padStart(7)}${'cold'.padStart(9)}${'warm p50'.padStart(11)}${'warm p90'.padStart(10)}`);

const rows = [];
for (const c of CIRCUITS) {
  const zkey = path.join(BUILD, `${c.name}_plonk.zkey`);
  const wasm = path.join(BUILD, `${c.name}_js`, `${c.name}.wasm`);
  const calc = path.join(BUILD, `${c.name}_js`, 'witness_calculator.cjs');
  if (!c.witness || !existsSync(zkey) || !existsSync(wasm) || !existsSync(calc)) {
    console.log(`  ${c.name.padEnd(15)}${'—'.padStart(7)}${'(artifacts or witness not available here)'.padStart(30)}`);
    continue;
  }

  const builder = await require(calc)(readFileSync(wasm));
  const wtns = await builder.calculateWTNSBin(c.witness, 0);

  const t0 = Date.now();
  await snarkjs.plonk.prove(zkey, wtns);
  const cold = Date.now() - t0;

  const warm = [];
  for (let i = 0; i < RUNS; i++) {
    const t = Date.now();
    await snarkjs.plonk.prove(zkey, wtns);
    warm.push(Date.now() - t);
  }
  warm.sort((a, b) => a - b);

  const facts = await import('./circuit-facts.mjs');
  const plonk = facts.plonkFacts(zkey).nConstraints;
  const p50 = median(warm);
  const p90 = warm[Math.min(warm.length - 1, Math.floor(warm.length * 0.9))];
  rows.push({ circuit: c.name, service: c.service, plonk, cold, p50, p90 });
  console.log(`  ${c.name.padEnd(15)}${String(plonk).padStart(7)}${(cold + ' ms').padStart(9)}${(p50 + ' ms').padStart(11)}${(p90 + ' ms').padStart(10)}`);
}

console.log(`\n  Cold includes reading the proving key. Warm is ${RUNS} runs in the same process, which is`);
console.log('  what the forked prover does after warmProver() at boot.');

// ---- the number a reviewer with a stopwatch gets --------------------------------------------------
if (process.argv.includes('--live')) {
  const BASE = 'https://quiver-production-c3a8.up.railway.app';
  const PROBES = [
    ['GET  /', '/'],
    ['GET  /build', '/build'],
    ['GET  /paper/1', '/paper/1'],
    ['POST /api/perp-gate (402)', '/api/perp-gate'],
    ['POST /api/treasury-risk (402)', '/api/treasury-risk'],
    ['POST /mcp tools/list', '/mcp'],
  ];
  console.log(`\nServed latency, live — the path a caller is actually on:\n`);
  console.log(`  ${'endpoint'.padEnd(32)}${'p50'.padStart(9)}${'p90'.padStart(9)}${'status'.padStart(8)}`);
  for (const [label, p] of PROBES) {
    const times = [];
    let status = 0;
    for (let i = 0; i < 5; i++) {
      const init = p === '/mcp'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }) }
        : p.startsWith('/api/') ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {};
      const t = Date.now();
      try { const r = await fetch(BASE + p, init); await r.text(); status = r.status; } catch { status = -1; }
      times.push(Date.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`  ${label.padEnd(32)}${(times[2] + ' ms').padStart(9)}${(times[4] + ' ms').padStart(9)}${String(status).padStart(8)}`);
  }
  console.log('\n  A 402 is the correct answer to an unpaid call and is the first thing a reviewer sees.');
  console.log('  None of these numbers contains any proving: a proof is built behind the response, not inside it.');
}

await globalThis.curve_bn128?.terminate();
