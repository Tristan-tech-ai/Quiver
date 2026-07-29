// Shared machinery for the HyperEVM workstream (A0–A3).
//
// Nothing here is served, nothing imports from src/engine/, and nothing is deployed by importing it.
// It exists so the four gates below it can all speak to the same chain, the same precompiles and the
// same proof without three copies of a JSON-RPC retry loop drifting apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ZK = path.join(__dirname, '..', '..');
export const BUILD = path.join(ZK, 'build');
export const CONTRACTS = path.join(ZK, 'contracts');
const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Chain 999.
//
// Three public endpoints, all verified to support `eth_call` state overrides. Failures on any one of
// them are rate limits rather than missing capability, so the right response is to rotate and back
// off, not to conclude the mechanism does not work.
export const RPCS = [
  'https://rpc.hyperliquid.xyz/evm',
  'https://rpc.purroofgroup.com',
  'https://rpc.hypurrscan.io',
];
export const CHAIN_ID = 999;

export const PRECOMPILES = {
  markPx: '0x0000000000000000000000000000000000000806',
  oraclePx: '0x0000000000000000000000000000000000000807',
  perpAssetInfo: '0x000000000000000000000000000000000000080a',
};

let turn = 0;
/** One JSON-RPC call, rotating across the three endpoints with backoff. Returns `result`. */
export async function rpc(method, params, { tries = 8, timeoutMs = 25000, rpcs = RPCS } = {}) {
  let last = null;
  for (let t = 0; t < tries; t++) {
    const url = rpcs[turn++ % rpcs.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json();
      if (j.error) { last = JSON.stringify(j.error); }
      else return j.result;
    } catch (e) { last = String(e.message); }
    await new Promise((s) => setTimeout(s, 250 * (t + 1)));
  }
  throw new Error(`${method} failed on all RPCs: ${String(last).slice(0, 200)}`);
}

/** A raw read of a precompile, off chain, for free. This is the number the contract must reproduce. */
export async function precompile(to, arg32) {
  return rpc('eth_call', [{ to, data: '0x' + arg32 }, 'latest']);
}

export const u32 = (n) => BigInt(n).toString(16).padStart(64, '0');
export const word = (hex, i) => BigInt('0x' + hex.replace(/^0x/, '').slice(i * 64, i * 64 + 64));

/** perpAssetInfo(uint32) -> szDecimals, maxLeverage. The layout is an ABI-encoded struct with a string. */
export function decodePerpAssetInfo(hex) {
  const h = hex.replace(/^0x/, '');
  // offset(0) then the struct fields; the adapter reads words 2..5 after a 2-word header.
  const n = (i) => Number(word(h, i));
  const szDecimals = n(3);
  const maxLeverage = n(4);
  if (!(szDecimals >= 0 && szDecimals <= 8)) throw new Error(`implausible szDecimals ${szDecimals}`);
  return { marginTableId: n(2), szDecimals, maxLeverage, onlyIsolated: n(5) === 1 };
}

/**
 * The price grid. HyperCore carries a perp price as an integer of 10^(6 - szDecimals) units.
 *
 * The 1e9 grid the circuit uses is therefore reachable from the precompile integer by MULTIPLICATION
 * ALONE — 1e9 / 10^(6-szDecimals) = 10^(3+szDecimals), an integer for every szDecimals in 0..8. No
 * division, no rounding, no tolerance needed for the units themselves. Every residual left after this
 * conversion is real price movement, which is the whole point of A3.
 */
export const gridMul = (szDecimals) => 10n ** BigInt(3 + szDecimals);
export const priceScale = (szDecimals) => 10 ** (6 - szDecimals);

/** The full perp universe, with index, from the public HTTP API. Used only to NAME assets. */
export async function perpUniverse() {
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }), signal: AbortSignal.timeout(25000),
  });
  const j = await r.json();
  return j.universe.map((u, i) => ({ ...u, perpIndex: i }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Proving.

/** Build a liquidation witness the same way the live service does, from `src/util/scale.cjs`. */
export function scaleLib() {
  return require(path.join(ZK, '..', 'hackathon', 'veritape', 'src', 'util', 'scale.cjs'));
}

/**
 * Prove one liquidation position. `p0Hat` may be supplied directly as a BigInt on the 1e9 grid, which
 * is what the join needs: the entry price must be the precompile's mark to the last digit, and going
 * through a double would lose that.
 */
export async function proveLiquidation({ mHat, qHat, p0Hat, s, mmrHat, pLiqHat }) {
  const scale = scaleLib();
  const enc = { mHat, qHat, p0Hat, s, mmrHat };
  const pl = pLiqHat === undefined ? scale.canonicalLiquidationPrice(enc) : pLiqHat;
  const full = { ...enc, pLiqHat: pl };
  const sj = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const builder = await require(path.join(BUILD, 'liquidation_js', 'witness_calculator.cjs'))(
    fs.readFileSync(path.join(BUILD, 'liquidation_js', 'liquidation.wasm')));
  const wtns = await builder.calculateWTNSBin(scale.toWitnessInput(full), 0);
  const { proof, publicSignals } = await sj.plonk.prove(path.join(BUILD, 'liquidation_plonk.zkey'), wtns);
  const raw = await sj.plonk.exportSolidityCallData(proof, publicSignals);
  const [proofWords, pubWords] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  return { proof, publicSignals, proofWords, pubWords, encoded: full };
}

/** Verify off chain against the published key, so an on-chain refusal can never be blamed on a bad proof. */
export async function verifyOffChain(publicSignals, proof) {
  const sj = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const vk = JSON.parse(fs.readFileSync(path.join(BUILD, 'vk_plonk.json'), 'utf8'));
  return sj.plonk.verify(vk, publicSignals, proof);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Solidity.

export function compile(fileName, contractName, sources) {
  const solc = require('solc');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts[fileName];
  // BY NAME. `Object.keys(c)[0]` once picked the IPlonkVerifier interface, which compiles to empty
  // bytecode, deploys happily and reverts on every call two steps later.
  const picked = c[contractName];
  if (!picked) throw new Error(`${fileName} has no contract ${contractName} — found ${Object.keys(c).join(', ')}`);
  if (!picked.evm.bytecode.object) throw new Error(`${contractName} compiled to empty bytecode — interface or abstract`);
  return { ...picked, solc: solc.version() };
}

export const readSol = (p) => fs.readFileSync(p, 'utf8');

/**
 * Run creation bytecode in an in-process EVM and return the RUNTIME bytecode it produces.
 *
 * Immutables are written into the runtime code by the constructor, so a contract with immutables
 * cannot simply be planted by `eth_call` state override from `evm.deployedBytecode` — that copy still
 * has the placeholder zeroes. This runs the real constructor with the real arguments and hands back
 * the exact bytes a real deployment would leave on chain, which is both what the simulation needs and
 * what makes the eventual deployment a formality rather than a new experiment.
 */
export async function runtimeCodeFor(creationHex, ctorArgsHex = '') {
  const { EVM } = await import('@ethereumjs/evm');
  const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
  const { hexToBytes, bytesToHex } = await import('ethereum-cryptography/utils.js');
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const res = await evm.runCall({
    caller: { bytes: hexToBytes('1000000000000000000000000000000000000001') },
    data: hexToBytes(creationHex.replace(/^0x/, '') + ctorArgsHex.replace(/^0x/, '')),
    gasLimit: 30_000_000n,
  });
  if (res.execResult.exceptionError) throw new Error(`constructor reverted: ${res.execResult.exceptionError}`);
  return { code: '0x' + bytesToHex(res.execResult.returnValue), gasUsed: res.execResult.executionGasUsed };
}

/** ABI-encode a uint256/address argument list into one hex blob of 32-byte words. */
export const abiWords = (...vals) => vals.map((v) => BigInt(v).toString(16).padStart(64, '0')).join('');

/** keccak selector for a signature string. */
export async function selector(sig) {
  const { keccak256 } = await import('ethereum-cryptography/keccak.js');
  const { utf8ToBytes, bytesToHex } = await import('ethereum-cryptography/utils.js');
  return '0x' + bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);
}

/**
 * Call planted code on the REAL chain. Nothing is deployed and nothing is sent; the precompile the
 * planted code reads is HyperCore's own committed state at `blockTag`, not a fixture.
 */
export async function callPlanted({ to, data, overrides, blockTag = 'latest', from = '0x000000000000000000000000000000000000dEaD', gas = '0x1D4C00', rpcs }) {
  return rpc('eth_call', [{ from, to, data, gas }, blockTag, overrides], rpcs ? { rpcs } : {});
}

/** Like callPlanted but returns the error instead of throwing, so a REFUSAL can be inspected. */
export async function callPlantedRaw({ to, data, overrides, blockTag = 'latest', from = '0x000000000000000000000000000000000000dEaD', gas = '0x1D4C00', rpcs = RPCS, tries = 6 }) {
  let last = null;
  for (let t = 0; t < tries; t++) {
    const url = rpcs[turn++ % rpcs.length];
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to, data, gas }, blockTag, overrides] }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json();
      if (j.result !== undefined) return { ok: true, result: j.result, rpc: url };
      // A revert carries its data in `error.data` on some endpoints and only inside `error.message`
      // on others — rpc.hyperliquid.xyz returns `Revert(RevertError { output: Some(0x51cebdb5…) })`
      // with no `data` field at all. Pulling the blob out of the message is what lets a gate name the
      // custom error rather than record "it failed somehow", which is the difference between a
      // refusal that was checked and a refusal that was assumed.
      if (j.error && (j.error.data || /revert/i.test(j.error.message || ''))) {
        const m = /0x[0-9a-fA-F]{8,}/.exec(String(j.error.data ?? '') || String(j.error.message ?? ''));
        return { ok: false, error: j.error, data: j.error.data ?? (m ? m[0] : null), rpc: url };
      }
      last = JSON.stringify(j.error);
    } catch (e) { last = String(e.message); }
    await new Promise((s) => setTimeout(s, 250 * (t + 1)));
  }
  throw new Error(`eth_call failed on all RPCs: ${String(last).slice(0, 200)}`);
}

/** Decode a 4-byte custom-error selector out of revert data, given the error signatures we expect. */
export async function namedRevert(data, sigs) {
  if (!data) return null;
  const sel = String(data).slice(0, 10).toLowerCase();
  for (const s of sigs) if ((await selector(s)).toLowerCase() === sel) return s;
  return sel;
}

/** A pass/fail recorder in the shape every other gate in this repo uses. */
export function checklist() {
  const results = [];
  return {
    results,
    record(name, pass, detail) {
      results.push({ name, pass: !!pass });
      console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
      return !!pass;
    },
    failed: () => results.filter((r) => !r.pass),
  };
}

export async function shutdown() { await globalThis.curve_bn128?.terminate(); }
