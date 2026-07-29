// Read a gas figure out of the artifact that measured it, instead of writing the number down.
//
// WHY THIS EXISTS. `273118` was hardcoded in two gates and described three different ways: "a Plonk
// verify is constant, whatever the circuit size" in gate B6, "one Plonk verify, 8 public signals" in
// gate B8-2, and attributed to the kelly verifier at 5 public signals in PHASE_C_RESEARCH_OPUS.md.
// Those three cannot all be true, and by the time anyone checked, the literal matched NO artifact in
// the repo: gateB2-kelly-evm.json records 271,136 and gate0-plonk.json records 273,901. It had also
// propagated into two published JSON files, one of them as three times the wrong number.
//
// Exactly the defect `circuit-facts.mjs` was written to kill for constraint counts: a number asserted
// rather than measured cannot drift loudly, because nothing compares it to anything.
//
// WHAT A SINGLE GAS FIGURE IS AND IS NOT. Plonk verify gas is NOT deterministic.
// `probe-plonk-gas-variance.mjs` measures a 3,328-gas spread, 1.26%, across 12 proofs of an IDENTICAL
// statement, because the scalars in a proof vary and the EVM charges for the bytes and the arithmetic.
// It also measures a 7,500-gas EIP-2929 cold/warm gap between the first call in an EVM instance and
// every later one. So any figure read through here is one sample, and a comparison built on it should
// leave room well beyond 1.26% rather than treating it as exact. Where a gate compares two of these,
// it must measure both in FRESH EVM instances or the second one is 7,500 gas cheaper for free.
//
// Verify gas is independent of circuit SIZE. It is not independent of the number of PUBLIC INPUTS,
// which cost about 822 gas each. Conflating those two is what made the original comment wrong: the
// 3-leg portfolio verifier carries 28 public signals and the single-leg liquidation verifier carries
// 8, and the ~19k gas between them is exactly that.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BUILD } from './gatekit.mjs';

/**
 * Read one measured gas figure from a gate's own JSON artifact.
 *
 * Throws rather than defaulting. A gate that silently substitutes a fallback when its input is missing
 * reports a comparison it did not make, which is the failure this whole module exists to stop.
 *
 * @param {string} file   artifact basename under zk/build, without `.json`
 * @param {string} field  dotted path to the figure, e.g. `verifyGasHonest` or `comparison.acceptGas`
 * @param {string} what   plain-English description of what the number IS, used in the error
 * @returns {bigint}
 */
export function readGas(file, field, what) {
  const p = path.join(BUILD, `${file}.json`);
  if (!existsSync(p)) {
    throw new Error(
      `gas-facts: ${p} is not in this checkout, so "${what}" cannot be read and must not be guessed.\n`
      + `  Run the gate that produces it first. This is a refusal to report a comparison, not a failure of the comparison.`);
  }
  let json;
  try { json = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`gas-facts: ${p} is not readable JSON (${e.message})`); }

  const value = field.split('.').reduce((o, k) => (o == null ? o : o[k]), json);
  if (value === undefined || value === null) {
    throw new Error(
      `gas-facts: ${file}.json has no "${field}", so "${what}" cannot be read.\n`
      + `  Present at top level: ${Object.keys(json).join(', ')}`);
  }
  const n = BigInt(value);
  if (n <= 0n) throw new Error(`gas-facts: ${file}.json ${field} is ${value}, which is not a gas figure`);
  return n;
}

/** The spread `probe-plonk-gas-variance.mjs` measured, for gates that quote a single figure. */
export const GAS_VARIANCE_NOTE =
  'one sample; probe-plonk-gas-variance.mjs measures a 1.26% spread across identical statements';
