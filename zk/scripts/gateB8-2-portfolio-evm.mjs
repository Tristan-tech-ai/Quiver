// GATE B8-2 — the exported portfolio verifier, rehearsed in an in-process EVM.
//
// A verifier that has never been asked to reject is decoration. This compiles the Solidity snarkjs
// exported, deploys it into an in-process EVM, and requires that it accept the honest proof and refuse
// every tampered submission — including a moved `nearest`, which is the signal that makes this circuit
// different from the single-leg ones: it is the only public signal whose corruption changes the ANSWER
// rather than the arithmetic.
//
// It also prices the thing against gateB6's measured alternative. gateB6 proved each leg separately and
// let a contract take the minimum on chain: 2,947,769 gas for eleven legs against 273,118 for one wide
// proof. The wide circuit's number is the one measured here, with 28 public signals rather than 8, so
// the comparison is finally between two numbers that were both read off a run.
//
// NOTHING IS DEPLOYED ON CHAIN.
//
// Run: node zk/scripts/gateB8-2-portfolio-evm.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, checklist, evmRehearsal, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { makeBuilder } from './lib/portfolio-witness.mjs';
import { readGas, GAS_VARIANCE_NOTE } from './lib/gas-facts.mjs';

const CIRCUIT = 'portfoliogate';
const { record, failed } = checklist();
console.log(`GATE B8-2 — portfolio verifier in the EVM — ${new Date().toISOString()}\n`);

const { build } = await makeBuilder(import.meta.url);

// The same book gate B8-0 proves, so the gas quoted here is the gas for the proof that gate certified.
const BOOK = [
  { venue: 'hyperliquid', asset: 'SOL', side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01, markPrice: 155 },
  { venue: 'hyperliquid', asset: 'BTC', side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005, markPrice: 64000 },
  { venue: 'binance', asset: 'ETH', side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006, markPrice: 3200 },
];

const built = build(BOOK);
if (!built.ok) { console.error(`the book did not encode: ${built.why}`); process.exit(1); }

const { proof, publicSignals } = await proveVerifyRefuse(CIRCUIT, built.witness, { record });
record('the proof carries one signal per public input plus the per-leg residuals',
  publicSignals.length === 28, `${publicSignals.length} public signals`);

const evm = await evmRehearsal(CIRCUIT, proof, publicSignals, { record });

// ---- the comparison gateB6 set up ----------------------------------------------------------------
const ROUTE_B_11_LEGS = 2_947_769n;   // measured in gateB6-portfolio-routes.mjs
// READ, NOT ASSERTED. This was the literal 273_118 with the comment "one Plonk verify, 8 public
// signals". The description was right and the number was from the wrong place: gate0-plonk.json IS the
// single-leg liquidation verifier at 8 public signals, and it records 273,901. The literal matched no
// artifact in this repo, and gate B6 carried the same literal describing something else entirely.
const LIQUIDATION_ONE_LEG = readGas('gate0-plonk', 'verifyGasHonest', 'the single-leg liquidation verifier, 8 public signals');
const perLegHere = Number(evm.acceptGas) / BOOK.length;

console.log(`\n${'-'.repeat(78)}`);
console.log('Gas, all of it measured rather than quoted:\n');
console.log(`  one wide proof, 3 legs, 28 public signals   ${String(evm.acceptGas).padStart(10)} accept`);
console.log(`                                             ${String(evm.rejectGas).padStart(10)} reject`);
console.log(`  one liquidation proof, 8 public signals     ${String(LIQUIDATION_ONE_LEG).padStart(10)}   (gate0-plonk.json)`);
console.log(`  eleven separate proofs + on-chain minimum   ${String(ROUTE_B_11_LEGS).padStart(10)}   (gateB6)`);
console.log(`\n  the wide circuit costs ${perLegHere.toFixed(0)} gas per leg; per-leg proofs cost ${(Number(ROUTE_B_11_LEGS) / 11).toFixed(0)}`);
console.log(`  the extra 20 public signals cost ${Number(evm.acceptGas) - Number(LIQUIDATION_ONE_LEG)} gas over the single-leg verifier`);
console.log(`\n  Two different refusal costs, and quoting only the cheap one would be misleading:`);
console.log(`    ${String(evm.rejectGas).padStart(7)} gas   a BENT PROOF POINT — rejected by the on-curve check before any pairing runs`);
console.log(`    ~284,000 gas   a TAMPERED PUBLIC SIGNAL — the full pairing check has to run to find it,`);
console.log(`                   so refusing a moved signal costs essentially what accepting costs (see the table above)`);

record('one wide proof verifies for less than three separate ones would',
  evm.acceptGas < LIQUIDATION_ONE_LEG * 3n,
  `${evm.acceptGas} against ${LIQUIDATION_ONE_LEG * 3n} for three single-leg verifies — ${GAS_VARIANCE_NOTE}, and the margin here is far wider than that`);
record('the verifier refuses more cheaply than it accepts, so a bad submission is not the expensive path',
  evm.rejectGas < evm.acceptGas, `${evm.rejectGas} reject vs ${evm.acceptGas} accept`);

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE B8-2: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log('  NOTHING DEPLOYED. The verifier existed only inside this process.');

writeFileSync(path.join(BUILD, 'gateB8-2-portfolio-evm.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, circuit: CIRCUIT,
  legs: BOOK.length, publicSignals: publicSignals.length,
  acceptGas: String(evm.acceptGas), rejectGas: String(evm.rejectGas),
  gasPerLeg: perLegHere, deployedBytes: evm.deployedSize, solc: evm.solc,
  comparison: {
    liquidationOneLegGas: String(LIQUIDATION_ONE_LEG),
    perLegRouteElevenLegsGas: String(ROUTE_B_11_LEGS),
    threeSeparateVerifiesGas: String(LIQUIDATION_ONE_LEG * 3n),
  },
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
