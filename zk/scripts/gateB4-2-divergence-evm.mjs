// GATE B4-2 — a contract accepts the divergence proof and refuses a tampered one, in a real EVM.
//
// The ratio comes from the REAL lpRisk engine, so the contract accepts a statement about an answer
// the service would have sold. Nothing is deployed on chain and nothing is served.
//
// Run: node zk/scripts/gateB4-2-divergence-evm.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist, proveVerifyRefuse, evmRehearsal, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { lpRisk } = await load(import.meta.url, 'engine/lpRisk.js');
const { round } = await load(import.meta.url, 'engine/stats.js');

const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };

const { record, failed } = checklist();
console.log(`GATE B4-2 — divergence verifier in an EVM — ${new Date().toISOString()}\n`);

// A 3.4x move, which is an ordinary bad week for an alt pair rather than a contrived number, and well
// inside the range where an LP is losing real money to divergence.
const r = 3.4;
const served = lpRisk({ priceRatio: r, concentrationFactor: 1 });
if (!served.ok || !served.realizedIL) throw new Error('the engine refused the ratio this gate is built on');

const rHat = toScaled(r, 'r');
const target = rHat * SCALE;
let sHat = isqrt(target);
if ((sHat + 1n) * (sHat + 1n) - target < target - sHat * sHat) sHat += 1n;
const lFull = (2 * Number(sHat) / S) / (1 + Number(rHat) / S);
const lHat = BigInt(Math.round(lFull * S));

const servedPct = served.realizedIL.impermanentLossPct;
const certifiedPct = (Number(lHat) / S - 1) * 100;

console.log(`  price ratio ${r}x  ->  engine served IL ${servedPct}% · witness certifies ${certifiedPct.toFixed(6)}%`);
console.log(`  L = V_LP/V_HODL = ${Number(lHat) / S}   √r on the grid = ${Number(sHat) / S}\n`);

record('the certified loss rounds to the loss the engine served',
  round(certifiedPct, 4) === servedPct,
  `round(${certifiedPct.toFixed(8)}, 4) = ${round(certifiedPct, 4)} against served ${servedPct}`);

const witness = { rHat: rHat.toString(), sHat: sHat.toString(), lHat: lHat.toString() };
const { proof, publicSignals, proveMs } = await proveVerifyRefuse('divergence', witness, { record });
const evm = await evmRehearsal('divergence', proof, publicSignals, { record });

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B4-2: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  accept ${evm.acceptGas} gas · reject ${evm.rejectGas} gas · proved in ${proveMs} ms`);
console.log('  NOT deployed on chain, NOT served by the endpoint');

writeFileSync(path.join(BUILD, 'gateB4-2-divergence-evm.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, solc: evm.solc, proveMs,
  acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), verifierBytes: evm.deployedSize,
  priceRatio: r, servedIlPct: servedPct, certifiedIlPct: certifiedPct, publicSignals,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
