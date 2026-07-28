// Anchor a Uniswap-V3 pool's state to a block's stateRoot, and say EXACTLY which of lp-desk's
// quantities that does and does not cover.
//
// THE THING THE RESEARCH GOT WRONG, and it changes the shape of the whole answer.
//
// PHASE_D_RESEARCH §4.3 says "`lp-desk` and `calldata-x` read chain state" and concludes eth_getProof
// anchors them. calldata-x does read state (evmrpc.js `storageAt`/`code`/`txCount`) and anchors
// cleanly. **lp-desk does not read state at all.** Every number it replays comes from `eth_getLogs`
// Swap events (univ3.js `fetchSwaps` -> `decodeSwap`): amount0, amount1, sqrtPriceX96, liquidity and
// tick are all decoded out of `log.data`. Event logs are committed to the **receiptsRoot**.
// `eth_getProof` proves the **stateRoot**. They are different tries, and no eth_getProof of any
// depth or size will ever contain a Swap event. The remaining pool metadata (token0/token1/fee) is
// `immutable` in Solidity, which means it lives in the deployed BYTECODE and not in storage either.
// measured here: slots 0-9 of the ETH/USDC pool contain slot0/feeGrowth/protocolFees/liquidity/
// observations and no token addresses at all.
//
// So there IS no direct anchor. What exists is one bridge, and it is narrow but real:
//
//   slot0.sqrtPriceX96 and slot0.tick are written ONLY by swap(). Mint, Burn, Collect and Flash do
//   not touch them. Therefore, at the END of a block, storage slot 0 must equal the post-state that
//   the LAST Swap event in that block emitted. Proving slot 0 at block B therefore proves the last
//   Swap row of block B, not the ones before it.
//
// That invariant is asserted here and MEASURED by the gate, never assumed. Its cost is the coverage
// ceiling, measured on live pools 2026-07-28:
//
//   pool                       swaps/block   rows that are last-in-block
//   ETH/USDC 0.05% mainnet     2.00          49.9% (600 blocks) / 57.1% (7,200 blocks, ~1 day)
//   WETH/USDC Base             1.61          62.1%
//   WETH/USDC Arbitrum         2.71          36.8%
//
// `liquidity` (slot 4) is a WEAKER case on purpose: Mint and Burn DO write it, so a mint or burn
// landing after the last swap in the same block moves storage without moving the log. That is a
// real divergence and not a bug, so liquidity is anchored as a separate, separately-reported claim.
import { anchorState } from './ethproof.js';

// UniswapV3Pool.sol declaration order. Immutables (factory/token0/token1/fee/tickSpacing/
// maxLiquidityPerTick) occupy NO slot, which is why the first storage variable is slot0 at slot 0.
export const V3_SLOTS = {
  slot0: 0,                    // packed: sqrtPriceX96 | tick | observationIndex | cardinality | cardinalityNext | feeProtocol | unlocked
  feeGrowthGlobal0X128: 1,
  feeGrowthGlobal1X128: 2,
  protocolFees: 3,             // packed: uint128 token0 | uint128 token1
  liquidity: 4,
  ticks: 5,                    // mapping base, always zero, entries live at keccak(key . 5)
  tickBitmap: 6,               // mapping base
  positions: 7,                // mapping base
  observations: 8,             // fixed array start
};

/** Decode the packed slot0 word. Bit positions are from the LSB, in Solidity struct order. */
export function decodeSlot0(raw) {
  const v = BigInt(raw);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = (v >> 160n) & 0xffffffn;
  if (tick >= 0x800000n) tick -= 0x1000000n;                 // int24, two's complement
  return {
    sqrtPriceX96,
    tick: Number(tick),
    observationIndex: Number((v >> 184n) & 0xffffn),
    observationCardinality: Number((v >> 200n) & 0xffffn),
    observationCardinalityNext: Number((v >> 216n) & 0xffffn),
    feeProtocol: Number((v >> 232n) & 0xffn),
    unlocked: ((v >> 240n) & 1n) === 1n,
  };
}

const Q96 = 2 ** 96;
/** tick implied by a sqrtPriceX96, in floating point. Used only as a CONSISTENCY test, never as a value. */
export function tickFromSqrtPriceX96(sqrtPriceX96) {
  const x = Number(sqrtPriceX96) / Q96;
  if (!(x > 0) || !Number.isFinite(x)) return null;
  return Math.floor((2 * Math.log(x)) / Math.log(1.0001));
}

/**
 * Is this word plausibly a UniswapV3 slot0?  A random contract's slot 0 will not satisfy the
 * sqrtPrice/tick relation, so this is what stops the adapter confidently decoding an unrelated
 * contract's storage as a pool. Tolerance is 2 ticks: swap() can leave tick = tickNext-1 when the
 * price lands exactly on an initialised boundary, so an exact equality would false-refuse.
 */
export function slot0LooksLikeV3(raw) {
  let s;
  try { s = decodeSlot0(raw); } catch { return { ok: false, reason: 'slot 0 did not decode' }; }
  if (s.sqrtPriceX96 === 0n) return { ok: false, reason: 'slot0.sqrtPriceX96 is zero, pool uninitialised, or this is not a V3 pool' };
  const implied = tickFromSqrtPriceX96(s.sqrtPriceX96);
  if (implied == null) return { ok: false, reason: 'sqrtPriceX96 out of representable range' };
  const d = Math.abs(implied - s.tick);
  if (d > 2) return { ok: false, reason: `slot0 self-consistency failed: sqrtPriceX96 implies tick ${implied} but the word says ${s.tick} (delta ${d}). This storage is not a UniswapV3 slot0, refusing to decode it as one.`, impliedTick: implied, wordTick: s.tick };
  if (s.observationCardinality === 0) return { ok: false, reason: 'observationCardinality is 0, an initialised V3 pool always has at least 1' };
  return { ok: true, decoded: s, impliedTick: implied, tickDelta: d };
}

// Same transport-vs-verification split as ethproof.js: a free node that answers an HTML rate-limit
// page has not told us anything about the storage layout, and calling that "the layout is wrong"
// would report a refusal the chain never earned.
async function ethCall(url, to, data, tag, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, tag] }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); }
      catch { const e = new Error(`HTTP ${r.status}, non-JSON reply (rate limit or gateway page)`); e.transport = true; throw e; }
      if (j.error) {
        const e = new Error(String(j.error.message).slice(0, 90));
        if (/rate limit|too many|archive|historical|personal token|missing trie node/i.test(e.message)) e.transport = true;
        throw e;
      }
      return j.result;
    } catch (e) { if (!e.transport) throw e; last = e; await new Promise((s) => setTimeout(s, 200 * (i + 1) ** 2)); }
  }
  throw last;
}

/**
 * Anchor a pool's slot0 + liquidity at a named block.
 *
 * Two layout defences, because the storage LAYOUT is an assumption about the contract and an
 * assumption is not evidence:
 *   (1) arithmetic, sqrtPriceX96 must imply the tick sitting beside it (adversary-independent);
 *   (2) the contract's own getters, slot0() and liquidity() via eth_call at the same block must
 *       return exactly the proven words. eth_call is UNPROVEN, so this confirms the LAYOUT, never
 *       the value; the value's authority comes from the Merkle proof and from nowhere else.
 * Either failing is a REFUSAL. A V3 fork with a different slot map (Algebra's globalState, say)
 * fails (2) and is refused rather than silently misread.
 */
export async function anchorPoolState({ chain = 'ethereum', pool, block, verifyLayout = true, corroborate = true, endpoint = null } = {}) {
  const a = await anchorState({ chain, address: pool, slots: [V3_SLOTS.slot0, V3_SLOTS.liquidity], block, corroborate, endpoint });
  if (!a.ok) return a;
  if (a.account.isEoa) return { ok: false, reason: `${pool} has no code at block ${block}, not a pool` };

  const s0raw = a.slots['0x0'].value;
  const liquidity = a.slots['0x4'].value;
  const shape = slot0LooksLikeV3(s0raw);
  if (!shape.ok) return { ok: false, reason: `proven slot 0 is not a UniswapV3 slot0: ${shape.reason}`, provenSlot0: '0x' + s0raw.toString(16), block: a.block };

  let layout = { checked: false, note: 'layout confirmed only by the sqrtPrice/tick arithmetic; the contract\'s own getters were not consulted' };
  if (verifyLayout) {
    const tag = '0x' + a.block.number.toString(16);
    try {
      const [s0hex, liqHex] = await Promise.all([
        ethCall(a.endpoint, pool, '0x3850c7bd', tag),          // slot0()
        ethCall(a.endpoint, pool, '0x1a686502', tag),          // liquidity()
      ]);
      if (!s0hex || s0hex.length < 66 * 1) return { ok: false, reason: 'slot0() returned no data, this contract does not expose the V3 getter, so its storage layout is unknown. Refusing.' };
      const w = (i) => s0hex.slice(2 + i * 64, 2 + (i + 1) * 64);
      const getterSqrt = BigInt('0x' + w(0));
      let getterTick = BigInt('0x' + w(1)); if (getterTick >= 1n << 255n) getterTick -= 1n << 256n;
      const getterLiq = BigInt(liqHex);
      const d = shape.decoded;
      const bad = [];
      if (getterSqrt !== d.sqrtPriceX96) bad.push(`slot0().sqrtPriceX96=${getterSqrt} but proven storage decodes to ${d.sqrtPriceX96}`);
      if (Number(getterTick) !== d.tick) bad.push(`slot0().tick=${getterTick} but proven storage decodes to ${d.tick}`);
      if (getterLiq !== liquidity) bad.push(`liquidity()=${getterLiq} but proven slot 4 is ${liquidity}`);
      if (bad.length) return { ok: false, reason: `storage layout does NOT match the contract's own getters (${bad.join('; ')}), this is a V3 fork with a different slot map, or the slot numbering is wrong. Refusing to report an anchored value.`, block: a.block };
      layout = { checked: true, method: 'slot0() + liquidity() eth_call at the same block equal the proven words', proves: 'the SLOT MAP only, eth_call is unproven, so this rules out misdecoding, not a lying node' };
    } catch (e) {
      return { ok: false, transport: !!e.transport, reason: `could not confirm the storage layout against the pool's own getters (${String(e.message).slice(0, 80)}), refusing rather than assuming slot 0 is slot0`, block: a.block };
    }
  }

  return {
    ok: true,
    chain, pool: String(pool).toLowerCase(),
    block: a.block,
    endpoint: a.endpoint, operator: a.operator,
    proven: {
      sqrtPriceX96: shape.decoded.sqrtPriceX96.toString(),
      tick: shape.decoded.tick,
      liquidity: liquidity.toString(),
      observationIndex: shape.decoded.observationIndex,
      observationCardinality: shape.decoded.observationCardinality,
      feeProtocol: shape.decoded.feeProtocol,
      unlocked: shape.decoded.unlocked,
      rawSlot0: '0x' + s0raw.toString(16).padStart(64, '0'),
    },
    layout,
    selfCheck: { impliedTick: shape.impliedTick, tickDelta: shape.tickDelta },
    size: a.size, latencyMs: a.latencyMs, agreement: a.agreement, trustChain: a.trustChain,
  };
}

// ---------------------------------------------------------------------------------------------
// The bridge from lp-desk's LOG rows to the anchored STATE.

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const toSigned = (hexWord, bits) => { let v = BigInt('0x' + hexWord); const m = 1n << BigInt(bits - 1); if (v >= m) v -= 1n << BigInt(bits); return v; };

/** Decode the Swap event post-state exactly as univ3.js decodeSwap does (words 2,3,4). */
export function decodeSwapPostState(log) {
  const d = log.data.slice(2), w = (i) => d.slice(i * 64, (i + 1) * 64);
  return { sqrtPriceX96: BigInt('0x' + w(2)), liquidity: BigInt('0x' + w(3)), tick: Number(toSigned(w(4), 256)), logIndex: parseInt(log.logIndex, 16), block: parseInt(log.blockNumber, 16) };
}

/**
 * Fetch a block's Swap logs for a pool and return the LAST one by logIndex.
 * Determined by MEASURING logIndex, not by trusting array order.
 */
export async function lastSwapInBlock(url, pool, blockNumber) {
  const tag = '0x' + blockNumber.toString(16);
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: pool, topics: [SWAP_TOPIC], fromBlock: tag, toBlock: tag }] }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message).slice(0, 90));
  const logs = j.result || [];
  if (!logs.length) return null;
  let best = null;
  for (const l of logs) { const p = decodeSwapPostState(l); if (!best || p.logIndex > best.logIndex) best = p; }
  return { ...best, swapsInBlock: logs.length };
}

/**
 * Anchor ONE lp-desk row: the row must be the last swap in its block, and the proven slot0 must
 * agree with it. `claimed` is {sqrtPriceX96, tick, liquidity} exactly as lp-desk consumed them.
 *
 * Returns { ok:true, agree:true } only when every anchorable field matches. Any mismatch, any
 * unverifiable proof, and any row that is not last-in-block is a REFUSAL with the reason named.
 * Refusing an intra-block row is not a defect: it is the coverage limit, stated instead of papered
 * over by comparing against a value that has no reason to match.
 */
export async function anchorSwapRow({ chain = 'ethereum', pool, block, claimed, corroborate = false, endpoint = null } = {}) {
  const st = await anchorPoolState({ chain, pool, block, corroborate, endpoint });
  if (!st.ok) return { ok: false, block, transport: !!st.transport, reason: st.reason };

  const last = await lastSwapInBlock(st.endpoint, pool, block).catch((e) => ({ __err: String(e.message).slice(0, 80) }));
  if (last && last.__err) return { ok: false, block, transport: true, reason: `could not read the block's Swap logs to establish which row is last: ${last.__err}` };
  if (!last) return { ok: false, block, reason: `no Swap log in block ${block}, nothing to anchor` };

  const c = { sqrtPriceX96: BigInt(claimed.sqrtPriceX96), tick: Number(claimed.tick), liquidity: BigInt(claimed.liquidity) };
  const isLast = c.sqrtPriceX96 === last.sqrtPriceX96 && c.tick === last.tick && c.liquidity === last.liquidity;
  if (!isLast) {
    return {
      ok: false, anchorable: false, block,
      reason: `the claimed row is not the last Swap in block ${block} (that block has ${last.swapsInBlock} swaps). Only the terminal swap's post-state is written to slot0, so an intra-block row has NO storage counterpart and cannot be anchored. Refusing rather than comparing it to a value it has no reason to equal.`,
    };
  }

  const p = st.proven;
  const sqrtOk = BigInt(p.sqrtPriceX96) === c.sqrtPriceX96;
  const tickOk = p.tick === c.tick;
  const liqOk = BigInt(p.liquidity) === c.liquidity;
  const agree = sqrtOk && tickOk;                                  // liquidity reported separately, see below

  return {
    ok: true, anchorable: true, agree, block,
    swapsInBlock: last.swapsInBlock,
    fields: {
      sqrtPriceX96: { claimed: c.sqrtPriceX96.toString(), proven: p.sqrtPriceX96, match: sqrtOk },
      tick: { claimed: c.tick, proven: p.tick, match: tickOk },
      liquidity: { claimed: c.liquidity.toString(), proven: p.liquidity, match: liqOk, caveat: liqOk ? null : 'slot 4 is also written by Mint/Burn, so a mint or burn after the last swap in this block moves storage without moving the log. A mismatch here is expected sometimes and is NOT evidence the log was wrong.' },
    },
    proofSizeBytes: st.size.totalProofBytes, latencyMs: st.latencyMs,
    endpoint: st.endpoint, stateRoot: st.block.stateRoot, blockHash: st.block.hash,
    agreement: st.agreement, trustChain: st.trustChain,
  };
}

// ---------------------------------------------------------------------------------------------
// The coverage statement. Written as data so the gate can assert on it and so it cannot drift away
// from the code the way a paragraph of prose would.

export const LP_DESK_COVERAGE = [
  { quantity: 'sqrtPriceX96 (per swap)', usedFor: 'p01, the price path, realised vol', source: 'Swap log word 2', anchored: 'PARTIAL', how: 'equals slot0.sqrtPriceX96 at end-of-block, so ONLY the last swap of each block is provable', measuredCoverage: '49.9%-62.1% of rows depending on pool' },
  { quantity: 'tick (per swap)', usedFor: 'pOf(r), the range in/out test that drives every rebalance', source: 'Swap log word 4', anchored: 'PARTIAL', how: 'same terminal-state bridge as sqrtPriceX96', measuredCoverage: 'same' },
  { quantity: 'liquidity (per swap)', usedFor: 'fee share L/(activeL+L)', source: 'Swap log word 3', anchored: 'PARTIAL, WEAKER', how: 'slot 4 matches at end-of-block only when no Mint/Burn follows the last swap in that block', measuredCoverage: 'a subset of the terminal rows; measured by the gate, not assumed' },
  { quantity: 'amount0 / amount1 (per swap)', usedFor: 'feeAmt, the entire fee accrual', source: 'Swap log words 0 and 1', anchored: 'NO', how: 'a trade size is never written to state; it exists only in the receipt. Committed to receiptsRoot, which eth_getProof does not touch.' },
  { quantity: 'feeAmt', usedFor: 'the headline LP-vs-HODL number', source: 'derived from amount0/1 x feePpm', anchored: 'NO', how: 'inherits amount0/1' },
  { quantity: 'block number and timestamp', usedFor: 'window span, realised vol scaling', source: 'log / eth_getBlockByNumber', anchored: 'YES, BY A DIFFERENT MECHANISM', how: 'both are header fields, and the header preimage is keccak-verified against blockHash, no state trie involved' },
  { quantity: 'token0 / token1 / fee / tickSpacing', usedFor: 'decimals alignment, fee tier', source: 'eth_call (Solidity `immutable`)', anchored: 'NO (INDIRECT ONLY)', how: 'immutables live in the deployed bytecode, not in any storage slot, measured: slots 0-9 hold slot0/feeGrowth/protocolFees/liquidity/observations and no addresses. Reachable only via the account codeHash plus a bytecode extraction, which is not built here.' },
  { quantity: 'token decimals (d0, d1)', usedFor: 'every price and every amount', source: 'eth_call decimals() on each token', anchored: 'NO', how: 'the slot differs per token and is often a constant or immutable. Not generically locatable, so this adapter REFUSES rather than guessing a slot number.' },
];

export const CALLDATA_X_COVERAGE = [
  { quantity: 'spender tier (contract vs EOA)', source: 'eth_getCode', anchored: 'YES', how: 'account leaf codeHash; EOA iff codeHash == keccak256(empty)' },
  { quantity: 'activity.outboundTxCount', source: 'eth_getTransactionCount', anchored: 'YES', how: 'account leaf nonce, verbatim' },
  { quantity: 'activity.codeSizeBytes', source: 'eth_getCode length', anchored: 'YES', how: 'keccak256(code) is checked against the proven codeHash, which binds the preimage' },
  { quantity: 'proxy implementation / beacon', source: 'eth_getStorageAt on 3 EIP-1967/zeppelinos slots', anchored: 'YES', how: 'direct storage proofs' },
  { quantity: 'isProxy: false', source: 'the same 3 slots reading zero', anchored: 'YES, VIA EXCLUSION PROOFS', how: 'the empty case needs a verified exclusion proof; an absent proof is not an exclusion proof and is refused' },
  { quantity: 'simulation asset/approval changes', source: 'eth_simulateV1', anchored: 'NO', how: 'a counterfactual execution is not committed state. §4.3 already says this and it is correct.' },
  { quantity: 'gas.gasPriceGwei', source: 'eth_gasPrice', anchored: 'NO', how: 'a node-local estimate, not state' },
  { quantity: 'ERC-20 symbol / decimals', source: 'eth_call', anchored: 'NO', how: 'same per-token slot problem as lp-desk' },
];
