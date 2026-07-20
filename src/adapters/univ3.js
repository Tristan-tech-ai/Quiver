// Uniswap-V3 swap history from FREE, keyless public RPCs. No API key, no paid provider, full archive.
//
// Verified 2026-07-17 by direct measurement (not assumption):
//   • rpc.mevblocker.io  — free, keyless, FULL ARCHIVE, no block-range cap (only a 10k-RESULT cap, and its
//     error names the retry range), returns blockTimestamp inline. eth.api.onfinality.io/public returned
//     byte-identical results on the same range (mutual corroboration, not a single source of truth).
//   • The Graph is dead for this: hosted service is a 301, decentralised gateway demands an auth header.
//     Dune/Bitquery 401. Ankr/publicnode want a token. Paid providers buy convenience, not access.
//
// FOUR TRAPS, each hit for real and each of which silently corrupts a backtest:
//   1. Pool metadata must be READ ON-CHAIN. A "canonical" address from a doc was the 0.05% WBTC/WETH pool,
//      not the 0.3% one — fee() returned 500. Never trust a hardcoded address; call fee() and check.
//   2. `tick` must decode as int256. The ABI SIGN-EXTENDS int24 across the full 32-byte word, so decoding
//      with bits=24 silently yields ~1.16e77 for negative ticks. Mainnet USDC/WETH hides this (positive
//      ticks); Base/Arbitrum WETH/USDC exposes it immediately.
//   3. Arbitrum returns blockTimestamp = "0x0" — PRESENT AND TRUTHY, so a `!l.blockTimestamp` guard passes
//      and every row silently decodes to 1970-01-01. Must test the parsed value, not the field's existence.
//   4. Token order flips across chains (mainnet token0=USDC; Base/Arb token0=WETH), so any hardcoded
//      decimal adjustment inverts the price. Read decimals() per token; derive, never assume.
import { round } from '../engine/stats.js';

const CHAINS = {
  ethereum: { rpcs: ['https://rpc.mevblocker.io', 'https://eth.api.onfinality.io/public'], blockSec: 12 },
  base: { rpcs: ['https://mainnet.base.org'], blockSec: 2 },
  arbitrum: { rpcs: ['https://arb1.arbitrum.io/rpc'], blockSec: 0.25 },
};
// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const Q192 = 2n ** 192n, SCALE = 10n ** 18n;
const SEL = { token0: '0x0dfe1681', token1: '0xd21220a7', fee: '0xddca3f43', decimals: '0x313ce567' };

let rpcIdx = 0;
/**
 * A result-cap error is NOT a failure — it is the server telling us the answer is too big and, crucially,
 * WHICH RANGE TO ASK FOR INSTEAD. Retrying it is pure waste: measured, a blind bisect burned 3 retries x 2
 * URLs = 6 full round-trips per node, each making the node actually scan 36k blocks, and the fetch appeared
 * to hang and return "0 swaps". Surface the cap error immediately, with its hint parsed, and use it.
 */
function capHint(err) {
  const to = err?.data?.to ?? (String(err?.message || '').match(/\[\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\]/)?.[2]);
  return to ? parseInt(to, 16) : null;
}
async function rpc(chain, method, params, { retries = 3 } = {}) {
  const urls = CHAINS[chain].rpcs;
  let lastErr = null;
  for (let a = 0; a < retries * urls.length; a++) {
    const url = urls[rpcIdx++ % urls.length];
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      if (j.error) {
        const hint = capHint(j.error);
        if (hint) { const e = new Error(j.error.message); e.capTo = hint; throw e; }   // do NOT retry a cap
        lastErr = new Error(j.error.message); continue;
      }
      return j.result;
    } catch (e) { if (e.capTo) throw e; lastErr = e; }
  }
  throw lastErr || new Error('rpc failed');
}

/** two's-complement signed decode of a 32-byte word */
function toSigned(hexWord, bits) {
  let v = BigInt('0x' + hexWord);
  const max = 1n << BigInt(bits - 1);
  if (v >= max) v -= 1n << BigInt(bits);
  return v;
}

/** Pool metadata READ FROM CHAIN — never trusted from a constant. Trap 1. */
export async function poolMeta(chain, pool) {
  const call = (data) => rpc(chain, 'eth_call', [{ to: pool, data }, 'latest']);
  const [t0, t1, feeHex] = await Promise.all([call(SEL.token0), call(SEL.token1), call(SEL.fee)]);
  // "0x" IS TRUTHY. eth_call against a non-contract (or a contract without this selector) returns empty
  // data, not an error — so a `!t0` guard passes and we slice garbage out of an empty string and report a
  // confident, fabricated pool. Same shape as Arbitrum's blockTimestamp="0x0": test the PARSED VALUE, never
  // the field's existence. A word is 32 bytes => 66 chars with the 0x prefix.
  const word = (h) => (typeof h === 'string' && h.length >= 66 ? h : null);
  if (!word(t0) || !word(t1) || !word(feeHex)) return null;
  const a0 = '0x' + t0.slice(26, 66), a1 = '0x' + t1.slice(26, 66);
  if (!/^0x[0-9a-fA-F]{40}$/.test(a0) || !/^0x[0-9a-fA-F]{40}$/.test(a1)) return null;
  const feeRaw = parseInt(feeHex, 16);
  if (!Number.isFinite(feeRaw) || feeRaw <= 0 || feeRaw > 100000) return null;   // real tiers: 100/500/3000/10000
  const [d0h, d1h] = await Promise.all([
    rpc(chain, 'eth_call', [{ to: a0, data: SEL.decimals }, 'latest']),
    rpc(chain, 'eth_call', [{ to: a1, data: SEL.decimals }, 'latest']),
  ]);
  if (!word(d0h) || !word(d1h)) return null;
  const dec0 = parseInt(d0h, 16), dec1 = parseInt(d1h, 16);
  if (!(dec0 >= 0 && dec0 <= 36) || !(dec1 >= 0 && dec1 <= 36)) return null;
  return {
    pool, chain, token0: a0, token1: a1,
    d0: dec0, d1: dec1,                                     // trap 4: derived, never assumed
    // fee() ALREADY returns hundredths of a bip (1e-6): 500 => 0.05%. Multiplying by 100 made every fee
    // 100x too large — and it paired with an inverted USD conversion to produce a plausible -99.9%, not a
    // crash. Verified: fee()=500 on ETH/USDC 0.05%, and 500/1e6 = 0.0005 = 0.05%.
    feePpm: feeRaw,
    feeTierPct: feeRaw / 10000,
  };
}

const missingTs = (l) => !l.blockTimestamp || parseInt(l.blockTimestamp, 16) === 0;   // trap 3

async function fillTimestamps(chain, logs) {
  const need = [...new Set(logs.filter(missingTs).map((l) => l.blockNumber))];
  const cache = new Map();
  for (let i = 0; i < need.length; i += 20) {
    const batch = need.slice(i, i + 20);
    const got = await Promise.all(batch.map((b) => rpc(chain, 'eth_getBlockByNumber', [b, false])));
    got.forEach((blk, j) => { if (blk?.timestamp) cache.set(batch[j], blk.timestamp); });
  }
  for (const l of logs) if (missingTs(l)) l.blockTimestamp = cache.get(l.blockNumber);
  return logs.filter((l) => !missingTs(l));
}

function decodeSwap(log, meta) {
  const d = log.data.slice(2), w = (i) => d.slice(i * 64, (i + 1) * 64);
  const amount0 = toSigned(w(0), 256), amount1 = toSigned(w(1), 256);
  const sqrtPriceX96 = BigInt('0x' + w(2)), liquidity = BigInt('0x' + w(3));
  const tick = Number(toSigned(w(4), 256));                 // trap 2: int256, NOT int24
  const { d0, d1 } = meta;
  const p01 = Number((sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(d0) * SCALE) / (Q192 * 10n ** BigInt(d1))) / Number(SCALE);
  const a0 = Number(amount0) / 10 ** d0, a1 = Number(amount1) / 10 ** d1;
  const feeAmt = (amount0 > 0n ? Math.abs(a0) : Math.abs(a1)) * (meta.feePpm / 1e6);
  return {
    block: parseInt(log.blockNumber, 16), ts: parseInt(log.blockTimestamp, 16),
    amount0: a0, amount1: a1, sqrtPriceX96: sqrtPriceX96.toString(), liquidity: liquidity.toString(),
    tick, p01, feeInToken0: amount0 > 0n, feeAmt,
  };
}

/** Fetch swaps over the last `days`. Splits on the 10k-result cap the RPC reports itself. */
export async function fetchSwaps(chain, pool, meta, days = 14, { maxLogs = 60000 } = {}) {
  const headHex = await rpc(chain, 'eth_blockNumber', []);
  const head = parseInt(headHex, 16);
  const span = Math.floor((days * 86400) / CHAINS[chain].blockSec);
  const from = Math.max(head - span, 1);
  // FORWARD SCAN using the server's own cap hint — linear, no wasted round-trips, no blind bisection.
  const out = [];
  let lo = from, guard = 0;
  while (lo <= head && out.length < maxLogs && guard++ < 400) {
    try {
      const logs = await rpc(chain, 'eth_getLogs', [{ address: pool, topics: [SWAP_TOPIC], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + head.toString(16) }]);
      if (Array.isArray(logs)) { for (const l of logs) out.push(l); }
      break;                                        // whole remaining span fit under the cap: done
    } catch (e) {
      if (!e.capTo || e.capTo <= lo) throw e;        // not a cap error (or no progress possible) -> real failure
      const logs = await rpc(chain, 'eth_getLogs', [{ address: pool, topics: [SWAP_TOPIC], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + e.capTo.toString(16) }]);
      if (Array.isArray(logs)) { for (const l of logs) out.push(l); }
      lo = e.capTo + 1;                              // advance exactly to where the node told us to resume
    }
  }
  const withTs = await fillTimestamps(chain, out);
  return withTs.map((l) => decodeSwap(l, meta)).sort((a, b) => a.ts - b.ts || a.block - b.block);
}

export const supportedChains = () => Object.keys(CHAINS);
export { round };
