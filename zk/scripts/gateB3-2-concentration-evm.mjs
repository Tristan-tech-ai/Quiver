// GATE B3-2 — a contract accepts the concentration proof and refuses a tampered one, in a real EVM.
//
// Nothing is deployed on chain and nothing is served. Same rehearsal the liquidation verifier went
// through before it reached X Layer: compile the exported Solidity, run it in an in-process EVM, and
// confirm it can both accept and REFUSE.
//
// The book here comes from the REAL treasury-risk engine rather than from a hand-built witness, so
// what the contract accepts is a statement about an answer the service would actually have sold.
//
// Run: node zk/scripts/gateB3-2-concentration-evm.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist, proveVerifyRefuse, evmRehearsal, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { treasuryRisk } = await load(import.meta.url, 'engine/treasuryRisk.js');
const N = 8;

const { record, failed } = checklist();
console.log(`GATE B3-2 — concentration verifier in an EVM — ${new Date().toISOString()}\n`);

// A deliberately lopsided book: one issuer at roughly two thirds is exactly the concentration this
// service exists to flag, so the proof is about a case a caller would care about.
const positions = [
  { asset: 'USDC', amountUsd: 6_400_000, apyPct: 4.1, venue: 'aave', chain: 'base' },
  { asset: 'USDT', amountUsd: 2_100_000, apyPct: 3.7, venue: 'aave', chain: 'base' },
  { asset: 'DAI', amountUsd: 1_050_000, apyPct: 5.2, venue: 'spark', chain: 'ethereum' },
  { asset: 'PYUSD', amountUsd: 450_000, apyPct: 4.8, venue: 'curve', chain: 'ethereum' },
];
const served = treasuryRisk({ positions });
if (!served.ok) throw new Error('the engine refused the book this gate is built on');

const total = positions.reduce((s, p) => s + p.amountUsd, 0);
const wHat = positions.map((p) => toScaled(p.amountUsd / total));
const padded = [...wHat, ...Array(N - wHat.length).fill(0n)];
const sumSq = padded.reduce((a, w) => a + w * w, 0n);
const hHat = (sumSq + SCALE / 2n) / SCALE;
const certified = Number(hHat) / S;
const publishedHhi = served.concentration.byAsset.hhi;

console.log(`  book: ${positions.length} issuers, $${(total / 1e6).toFixed(2)}M, top share ${served.concentration.byAsset.top.sharePct}%`);
console.log(`  engine served HHI ${publishedHhi} · witness certifies ${certified}`);
console.log(`  gap to served     ${Math.abs(certified - publishedHhi).toExponential(2)} (published at 4dp)`);
console.log(`  verdict           ${served.verdict.slice(0, 96)}...\n`);

record('the certified index matches the one the engine served, at the precision it was served',
  Math.abs(certified - publishedHhi) <= 5e-5,
  `${Math.abs(certified - publishedHhi).toExponential(2)} against a 5e-5 guard`);

const witness = { wHat: padded.map(String), hHat: hHat.toString() };
const { proof, publicSignals, proveMs } = await proveVerifyRefuse('concentration', witness, { record });

const evm = await evmRehearsal('concentration', proof, publicSignals, { record });

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B3-2: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  accept ${evm.acceptGas} gas · reject ${evm.rejectGas} gas · proved in ${proveMs} ms`);
console.log('  NOT deployed on chain, NOT served by the endpoint');

writeFileSync(path.join(BUILD, 'gateB3-2-concentration-evm.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, solc: evm.solc, proveMs,
  acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas), verifierBytes: evm.deployedSize,
  servedHhi: publishedHhi, certifiedHhi: certified, publicSignals,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
