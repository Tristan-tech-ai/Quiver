// Minimal EVM JSON-RPC adapter with transaction simulation via eth_simulateV1
// (returns logs + native/token transfers for a simulated call — no fork process needed).
import { config } from '../config.js';

// Public RPCs per chain. First that answers eth_simulateV1 wins (probed at runtime, cached).
const RPCS = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],
  base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  bsc: ['https://bsc-rpc.publicnode.com', 'https://binance.llamarpc.com'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
};

async function rpc(url, method, params, timeoutMs = 12000) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 140)}`);
  return j.result;
}

const simCapable = new Map(); // url -> bool

// Simulate a single call and return {status, returnData, logs[], gasUsed} — using eth_simulateV1
// (with traceTransfers so native ETH moves surface as synthetic logs too).
export async function simulate(chain, { from, to, data, value = '0x0' }) {
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  const params = [{
    blockStateCalls: [{ calls: [{ from, to, data, value }] }],
    traceTransfers: true,
    validation: false,
    returnFullTransactions: false,
  }, 'latest'];
  let lastErr = null;
  for (const url of urls) {
    if (simCapable.get(url) === false) continue;
    try {
      const res = await rpc(url, 'eth_simulateV1', params);
      simCapable.set(url, true);
      const block = res?.[0];
      const call = block?.calls?.[0];
      if (!call) throw new Error('empty simulate result');
      const bn = block?.number != null ? (typeof block.number === 'string' && block.number.startsWith('0x') ? parseInt(block.number, 16) : Number(block.number)) : null;
      const bh = typeof block?.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(block.hash) ? block.hash : null;
      return { rpc: url, blockNumber: bn, blockHash: bh, status: call.status, returnData: call.returnData, gasUsed: call.gasUsed, error: call.error, logs: call.logs || [] };
    } catch (e) {
      if (/method .*not (found|available|supported)|does not exist|Unsupported method|not supported/i.test(String(e.message))) simCapable.set(url, false);
      lastErr = e;
    }
  }
  throw new Error(`no RPC supported eth_simulateV1 for ${chain}: ${lastErr?.message || 'unknown'}`);
}

// Fallback: plain eth_call to check the tx would not revert (no asset diff).
export async function ethCall(chain, { from, to, data, value = '0x0' }) {
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  let lastErr = null;
  for (const url of urls) {
    try { const r = await rpc(url, 'eth_call', [{ from, to, data, value }, 'latest']); return { rpc: url, ok: true, returnData: r }; }
    catch (e) { lastErr = e; if (/revert/i.test(String(e.message))) return { rpc: url, ok: false, revert: String(e.message).slice(0, 160) }; }
  }
  throw lastErr || new Error('eth_call failed');
}

// eth_getCode for a spender-reputation check (contract vs EOA). Returns the code hex, or null on failure.
const codeCache = new Map();
export async function code(chain, address) {
  const key = `${chain}:${String(address).toLowerCase()}`;
  if (codeCache.has(key)) return codeCache.get(key);
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  for (const url of urls) {
    try { const r = await rpc(url, 'eth_getCode', [address, 'latest'], 8000); codeCache.set(key, r); return r; }
    catch { /* try next */ }
  }
  return null;
}

// Current gas price (wei, as a BigInt) for pricing a simulated tx's fee. Null on failure.
export async function gasPrice(chain) {
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  for (const url of urls) { try { const r = await rpc(url, 'eth_gasPrice', [], 8000); return BigInt(r); } catch { /* next */ } }
  return null;
}

// eth_getBlockByNumber (header only) — pins the state a simulation ran against, for a reproducible
// evidence bundle. Returns { number, hash } or null. tag = 'latest' or a hex/number block.
export async function getBlock(chain, tag = 'latest') {
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  const t = typeof tag === 'number' ? '0x' + tag.toString(16) : tag;
  for (const url of urls) {
    try {
      const b = await rpc(url, 'eth_getBlockByNumber', [t, false], 8000);
      if (b?.hash && b?.number != null) return { number: typeof b.number === 'string' ? parseInt(b.number, 16) : Number(b.number), hash: b.hash };
    } catch { /* next */ }
  }
  return null;
}

// eth_getStorageAt — used to read EIP-1967 proxy slots (implementation/admin/beacon). Null on failure.
export async function storageAt(chain, address, slot) {
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  for (const url of urls) { try { return await rpc(url, 'eth_getStorageAt', [address, slot, 'latest'], 8000); } catch { /* next */ } }
  return null;
}

// eth_getTransactionCount — outbound nonce; a fresh-vs-established activity signal for a spender. Null on failure.
export async function txCount(chain, address) {
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  for (const url of urls) { try { const r = await rpc(url, 'eth_getTransactionCount', [address, 'latest'], 8000); return typeof r === 'string' ? parseInt(r, 16) : Number(r); } catch { /* next */ } }
  return null;
}

// Fetch ERC-20 symbol + decimals for a token via eth_call (best-effort).
const metaCache = new Map();
export async function erc20Meta(chain, token) {
  const key = `${chain}:${token.toLowerCase()}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const urls = RPCS[String(chain).toLowerCase()] || RPCS.ethereum;
  const url = urls[0];
  const out = { symbol: null, decimals: 18 };
  try {
    const [symHex, decHex] = await Promise.all([
      rpc(url, 'eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']).catch(() => null), // symbol()
      rpc(url, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']).catch(() => null), // decimals()
    ]);
    if (decHex && decHex !== '0x') out.decimals = parseInt(decHex, 16);
    if (symHex && symHex.length > 2) {
      // dynamic string ABI-encoded, or a bytes32 symbol
      const hex = symHex.slice(2);
      if (hex.length >= 192) {
        const len = parseInt(hex.slice(64, 128), 16);
        out.symbol = Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '') || null;
      } else {
        out.symbol = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim() || null;
      }
    }
  } catch { /* leave defaults */ }
  metaCache.set(key, out);
  return out;
}

export const chains = () => Object.keys(RPCS);
