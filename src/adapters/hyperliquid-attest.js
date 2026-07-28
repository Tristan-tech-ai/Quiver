// Hyperliquid INPUT ATTESTATION — check what `hyperliquid.js` fetched over unsigned HTTPS against
// Hyperliquid's own consensus state, read through the HyperEVM precompiles on chain 999.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SCOPE. What this covers, and what it does not. Measured 28 July 2026 over the full 232-perp
// universe, not asserted.
//
//   ATTESTABLE — a precompile returns the quantity and it is compared:
//     markPrice            0x…0806 markPx(uint32)          232/232 assets read
//     oraclePrice          0x…0807 oraclePx(uint32)        232/232 assets read
//     maxLeverage          0x…080a perpAssetInfo(uint32)   232/232 agreed EXACTLY, zero disagreements
//     szDecimals           0x…080a  (sets the price grid; needed to compare anything at all)
//     position size        0x…0800 position(address,uint32)
//     position leverage    0x…0800
//     position entry price 0x…0800  DERIVED as entryNtl/|szi| — a quotient, not a stored field
//
//   NOT ATTESTABLE — no precompile returns it, so this module REFUSES rather than guessing:
//     fundingRateHourly    no funding precompile exists. Verified here, not repeated from a doc, and
//                          re-verified independently 28 Jul: swept 0x800–0x8ff (256 addresses x five
//                          calldata shapes = 1,280 pairs, ZERO left unprobed — a chunk that failed
//                          was retried serially rather than dropped). Found 19 live precompiles.
//                          Then took all 709 returned 32-byte words and matched each against the
//                          live hourly funding of 10 assets CHOSEN FOR DISTINCT funding values (a
//                          match against a rate every asset shares would prove nothing), at every
//                          power of ten from 1e-18 to 1e18, in both sign conventions and both
//                          two's-complement readings — 104,932 candidate scalings. Zero matches.
//                          What this sweep adds over §4.1's is CALLDATA SHAPE, not address range:
//                          §4.1 scanned 0x800–0x830, which already contains every live precompile
//                          (nothing above 0x814 answers anything). But 0x800/0x801/0x80f/0x813 only
//                          answer an address+index shape and look DEAD to a scan sending a bare
//                          uint32, so a single-shape scan under-reports what is there. Sweeping to
//                          0x8ff additionally establishes the negative: there is nothing above
//                          0x814 to find.
//     marginTiers          0x…080a returns marginTableId (56 for BTC); NOTHING returns the table it
//                          names. Confirmed by calling every live precompile with the tableId and
//                          searching for the tier bounds. THIS MATTERS: perp-gate PREFERS notional
//                          margin tiers over maxLeverage, and 36 of 232 assets have a tier table with
//                          more than one entry. When the caller used tiers, attesting maxLeverage
//                          attests a quantity the engine did not use, so `attestPerpInputs` reports
//                          `substitutedForUsedQuantity` and never lets that pass silently.
//     openInterest, premium, midPx, impactPxs, dayNtlVlm, prevDayPx, dayBaseVlm — no precompile.
//     venueLiquidationPx   reported by clearinghouseState, not by any precompile.
//     account equity / totalNotional / totalMarginUsed / withdrawable — 0x…080f exists but this
//                          module does not claim it until it is measured against a live book.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT AN AGREEMENT HERE DOES AND DOES NOT MEAN.
//
// It means the number Quiver used is the number HyperCore's own state holds. It does NOT mean the
// number is correct: Hyperliquid's mark is a stake-weighted median of external venues, and a
// manipulated oracle would be attested with full force. Attestation reaches the venue's state and
// stops there.
//
// And read OFF chain — which is how this module runs — both reads are unsigned HTTPS, so one
// adversary at the network edge sees both. That makes this multi-source agreement with a much
// better second source, NOT an attestation. It becomes an attestation only when the same comparison
// runs inside a contract on HyperEVM, where the precompile value comes from consensus rather than
// from a wire.
//
// A contract CAN do this: planted bytecode STATICCALLing 0x…0806 returns byte-identical output to
// the direct read. Cost, measured 28 Jul by differencing eth_estimateGas across N and N-1 copies of
// the same read — which holds the transaction base, the surrounding opcodes and memory expansion
// constant, unlike differencing one call against a hand-written no-op:
//
//     N          1       2       3       4       5       6
//     gas    24,582  27,819  31,057  34,294  37,531  40,769
//     marginal      +3,237  +3,238  +3,237  +3,237  +3,238
//
//   → 3,237 gas per additional read; 3,218 for the STATICCALL and the precompile alone, less the 19
//     gas of PUSHes/GAS/POP around it. Perfectly linear, and the N=1→2 step equals the steady-state
//     step to within 1 gas, which says the precompile is ALREADY WARM on first touch — there is no
//     2,600-gas cold-account surcharge to pay. §4.1's 3,285 and an earlier 3,272 from binary search
//     on the gas cap are both single-shot figures that fold in their own baseline; the binary-search
//     one is additionally inflated by EIP-150's 63/64 rule. The marginal figure is the honest one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE COMPARISON IS BRACKETED RATHER THAN A FLAT TOLERANCE.
//
// `/info` is a SNAPSHOT, not a live read. Measured 28 Jul: 60 polls over 23.0 s produced 59 distinct
// snapshots, turning over every ~388 ms median (min 295, max 853 — and the max is bounded below by
// the ~380 ms poll interval, so it is an upper estimate rather than a tight one). So the residual
// against the precompile is snapshot staleness, and it is a price-movement term — which means a FLAT
// relative bound has to be as wide as the most volatile asset in the universe. Measured honest worst
// over 6,032 full-universe observations: 1.131e-3. A flat bound safe against that is looser than the
// 10.8 bps cross-venue consensus floor this approach is supposed to beat.
//
// So the committed HTTP read is BRACKETED between two consensus reads and the question becomes
// "is this value consistent with consensus somewhere in the window", which adapts to how fast the
// asset is actually moving instead of to the worst asset in the universe.
//
//   pc0  ──gap──  the HTTP value under test  ──  pc1
//   accept iff  claimed ∈ [min(pc0,pc1) − w , max(pc0,pc1) + w]
//
// `w` still has to cover a non-monotone path between the two samples, and it is supplied BY THE
// CALLER. There is no default. A bound belongs to the gate that enforces it, never to the adapter
// that offers it and never to the probe that suggested it.
//
// Nothing here is served, deployed, or on chain, and nothing imports from src/engine/, so the
// published build hash q1-e1fa99d08887d6cc does not move.

const DEFAULT_RPCS = [
  'https://rpc.hyperliquid.xyz/evm',
  'https://rpc.purroofgroup.com',
  'https://rpc.hypurrscan.io',
];
const HTTP_INFO = 'https://api.hyperliquid.xyz/info';

export const PRECOMPILES = {
  position:      '0x0000000000000000000000000000000000000800',
  markPx:        '0x0000000000000000000000000000000000000806',
  oraclePx:      '0x0000000000000000000000000000000000000807',
  l1BlockNumber: '0x0000000000000000000000000000000000000809',
  perpAssetInfo: '0x000000000000000000000000000000000000080a',
  bbo:           '0x000000000000000000000000000000000000080e',
};

/**
 * The attestability register. Every Hyperliquid quantity `hyperliquid.js` can put into a perp-gate or
 * portfolio-gate input appears here EXACTLY ONCE, with a verdict that is either a precompile or a
 * reason there is none. A quantity absent from this table is treated as unattestable, so forgetting
 * to add one fails closed rather than silently passing.
 */
export const ATTESTABILITY = {
  markPrice:         { attestable: true,  via: 'markPx(uint32)' },
  oraclePrice:       { attestable: true,  via: 'oraclePx(uint32)' },
  maxLeverage:       { attestable: true,  via: 'perpAssetInfo(uint32).maxLeverage' },
  szDecimals:        { attestable: true,  via: 'perpAssetInfo(uint32).szDecimals' },
  positionSize:      { attestable: true,  via: 'position(address,uint32).szi' },
  positionLeverage:  { attestable: true,  via: 'position(address,uint32).leverage' },
  positionEntryPrice:{ attestable: true,  via: 'position(address,uint32).entryNtl / |szi| (derived quotient)' },
  fundingRateHourly: { attestable: false, reason: 'no funding precompile: swept 0x800-0x8ff x5 calldata shapes, matched every word against live funding at 1e-18..1e18 in both sign conventions, zero matches' },
  marginTiers:       { attestable: false, reason: 'perpAssetInfo exposes marginTableId but no precompile returns the table; perp-gate PREFERS tiers over maxLeverage, so this is a coverage gap and not a formality' },
  maintMarginRate:   { attestable: false, reason: 'derived from tiers or maxLeverage by the engine; the venue does not publish it and no precompile returns it' },
  openInterest:      { attestable: false, reason: 'no precompile returns open interest' },
  venueLiquidationPx:{ attestable: false, reason: 'reported by clearinghouseState only; no precompile' },
  accountEquityUsd:  { attestable: false, reason: '0x080f accountMarginSummary exists but is unverified against a live book here; claiming it unmeasured is exactly the overreach this module refuses' },
};

export class AttestationError extends Error {}

/* ────────────────────────────── transport ────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (n) => n.toString(16).padStart(64, '0');
const addr32 = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * One eth_call, rotating across independent RPCs and backing off on rate limits.
 * THROWS when it cannot get an answer. It never returns undefined, because a missing read that
 * flows onward as a value is the absence-as-success defect this codebase keeps catching.
 */
export async function ethCall(to, data, { rpcs = DEFAULT_RPCS, timeoutMs = 20000, tries = 6, _state = { i: 0 } } = {}) {
  let delay = 250, lastErr = null;
  for (let t = 0; t < tries; t++) {
    const url = rpcs[_state.i++ % rpcs.length];
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // Explicit gas: two of the five public HyperEVM RPCs answer "out of gas: gas exhausted during
        // precompiled contract exec" without it, which would look like the precompile not existing.
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data, gas: '0x200000' }, 'latest'] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json();
      if (j.error) {
        const m = String(j.error.message || '');
        if (/rate limited|429|too many/i.test(m)) { lastErr = new Error(m); await sleep(delay); delay = Math.min(delay * 2, 4000); continue; }
        throw new AttestationError(`precompile ${to.slice(-4)}: ${m.slice(0, 90)}`);
      }
      if (!j.result || j.result === '0x') throw new AttestationError(`precompile ${to.slice(-4)} returned empty`);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (e instanceof AttestationError && !/rate limited/i.test(e.message)) throw e;
      if (t === tries - 1) break;
      await sleep(delay); delay = Math.min(delay * 2, 4000);
    }
  }
  throw new AttestationError(`precompile ${to.slice(-4)} unreachable after ${tries} tries: ${String(lastErr?.message || '').slice(0, 90)}`);
}

/**
 * Many eth_calls as ONE JSON-RPC batch. Measured: the full 232-asset universe costs 5 batched
 * requests instead of 232 round trips, which is what makes a whole-universe sweep a ~25 s gate
 * rather than a ten-minute one.
 *
 * Fails loudly and completely. A short or partial batch response is an ERROR, never a shorter
 * result set — silently returning the calls that happened to answer would let a sweep report
 * "all assets agreed" while quietly having measured forty of them.
 */
export async function ethCallBatch(calls, { rpcs = DEFAULT_RPCS, timeoutMs = 30000, tries = 8, chunk = 48, _state = { i: 0 } } = {}) {
  const out = new Map();
  for (let i = 0; i < calls.length; i += chunk) {
    const slice = calls.slice(i, i + chunk);
    const reqs = slice.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: c.to, data: c.data, gas: '0x200000' }, 'latest'] }));
    let got = null, delay = 250, lastErr = null;
    for (let t = 0; t < tries; t++) {
      const url = rpcs[_state.i++ % rpcs.length];
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs), signal: AbortSignal.timeout(timeoutMs) });
        const j = await r.json();
        if (Array.isArray(j) && j.length === reqs.length) { got = j; break; }
        lastErr = new Error(Array.isArray(j) ? `short batch ${j.length}/${reqs.length}` : String(j?.error?.message || 'non-array batch reply'));
      } catch (e) { lastErr = e; }
      await sleep(delay); delay = Math.min(delay * 2, 4000);
    }
    if (!got) throw new AttestationError(`batch ${i}..${i + slice.length} failed after ${tries} tries: ${String(lastErr?.message || '').slice(0, 90)}`);
    for (const x of got) {
      const c = slice[x.id];
      if (!c) throw new AttestationError('batch reply carried an id outside the request set');
      if (x.error) throw new AttestationError(`batch call ${c.key}: ${String(x.error.message).slice(0, 90)}`);
      if (!x.result || x.result === '0x') throw new AttestationError(`batch call ${c.key} returned empty`);
      out.set(c.key, x.result);
    }
  }
  if (out.size !== calls.length) throw new AttestationError(`batch returned ${out.size} of ${calls.length} results`);
  return out;
}

/**
 * Read `perpAssetInfo` for many indices at once and CONFIRM each against the HTTP universe's coin
 * name. Returns only indices whose on-chain name matches, plus an explicit `misaligned` list — the
 * caller is told what was dropped rather than handed a quietly shorter map.
 */
export async function readPerpUniverse({ names, indices, opts = {} } = {}) {
  if (!Array.isArray(names)) throw new AttestationError('readPerpUniverse: names[] (HTTP universe order) is required');
  const idxs = indices || names.map((_, i) => i);
  const hexes = await ethCallBatch(idxs.map((i) => ({ key: i, to: PRECOMPILES.perpAssetInfo, data: '0x' + u32(i) })), opts);
  const meta = new Map(), misaligned = [];
  for (const i of idxs) {
    let info;
    try { info = decodePerpAssetInfo(hexes.get(i)); }
    catch (e) { misaligned.push({ perpIndex: i, http: names[i], reason: String(e.message) }); continue; }
    if (String(info.coin).toUpperCase() !== String(names[i] || '').toUpperCase()) {
      misaligned.push({ perpIndex: i, http: names[i], onChain: info.coin, reason: 'coin name mismatch' });
      continue;
    }
    meta.set(i, { ...info, scale: priceScale(info.szDecimals), tick: 1 / priceScale(info.szDecimals) });
  }
  return { meta, misaligned };
}

/** Batched `markPx` for many indices, already scaled by each asset's own price grid. */
export async function readConsensusMarks({ meta, opts = {} } = {}) {
  const idxs = [...meta.keys()];
  const hexes = await ethCallBatch(idxs.map((i) => ({ key: i, to: PRECOMPILES.markPx, data: '0x' + u32(i) })), opts);
  const marks = new Map();
  for (const i of idxs) {
    const raw = BigInt(hexes.get(i));
    if (raw <= 0n) throw new AttestationError(`markPx(${i}) is ${raw} on chain — refusing to compare against a non-positive consensus price`);
    marks.set(i, Number(raw) / meta.get(i).scale);
  }
  return { marks, at: Date.now() };
}

/* ────────────────────────────── decoders ────────────────────────────── */

const wordsOf = (hex) => { const d = hex.slice(2), out = []; for (let i = 0; i * 64 < d.length; i++) out.push(BigInt('0x' + d.slice(i * 64, (i + 1) * 64))); return out; };
const TWO256 = 2n ** 256n;
const signed = (u) => (u >= TWO256 / 2n ? u - TWO256 : u);

/** perpAssetInfo(uint32) -> {coin, marginTableId, szDecimals, maxLeverage, onlyIsolated}. 256 bytes. */
export function decodePerpAssetInfo(hex) {
  const d = hex.slice(2);
  const w = (i) => d.slice(i * 64, (i + 1) * 64);
  const n = (i) => Number(BigInt('0x' + w(i)));
  // The string offset in w1 is relative to the START OF THE STRUCT (w1), not to the start of the
  // returndata. Getting this wrong yields a plausible but wrong coin name, which would silently
  // defeat the index-alignment check below — the one check that makes everything else meaningful.
  const strWord = 1 + n(1) / 32;
  const len = Number(BigInt('0x' + w(strWord)));
  if (!(len > 0) || len > 32) throw new AttestationError(`perpAssetInfo: implausible coin length ${len}`);
  const coin = Buffer.from(d.slice((strWord + 1) * 64, (strWord + 1) * 64 + len * 2), 'hex').toString('utf8');
  const szDecimals = n(3), maxLeverage = n(4);
  if (!(szDecimals >= 0 && szDecimals <= 8)) throw new AttestationError(`perpAssetInfo: implausible szDecimals ${szDecimals}`);
  if (!(maxLeverage > 0 && maxLeverage <= 100)) throw new AttestationError(`perpAssetInfo: implausible maxLeverage ${maxLeverage}`);
  return { coin, marginTableId: n(2), szDecimals, maxLeverage, onlyIsolated: n(5) === 1 };
}

/**
 * position(address,uint32) -> {szi, entryNtl, isolatedRawUsd, leverage, isIsolated}. 160 bytes.
 * `szi` and `isolatedRawUsd` are two's-complement signed; a short leg decodes to a huge unsigned
 * number if that is missed.
 */
export function decodePosition(hex, szDecimals) {
  const w = wordsOf(hex);
  if (w.length < 5) throw new AttestationError(`position: expected 5 words, got ${w.length}`);
  return {
    szi: Number(signed(w[0])) / 10 ** szDecimals,
    entryNtlRaw: w[1],
    isolatedRawUsd: signed(w[2]),
    leverage: Number(w[3]),
    isIsolated: w[4] === 1n,
  };
}

/** The price grid. One tick = 1 / 10^(6 - szDecimals) in price units. */
export const priceScale = (szDecimals) => 10 ** (6 - szDecimals);

/* ────────────────────────────── consensus reads ────────────────────────────── */

/**
 * Read one perp's consensus state. `symbol` is REQUIRED and is checked against the coin name the
 * precompile itself returns.
 *
 * The precompile is indexed by perpIndex, and the only convenient source of "which index is BTC" is
 * the HTTP universe ordering — which is the very thing under test. So the index arrives as an
 * UNTRUSTED HINT and is confirmed against `perpAssetInfo(i).coin`. If they disagree the read is
 * refused rather than reported, because a divergence number computed across two different assets is
 * worse than no number. (Measured: 232/232 agree today, so the check is cheap and currently silent —
 * but it is the check that makes every other number here mean what it says.)
 */
export async function readConsensusPerp({ symbol, perpIndexHint, rpcs, timeoutMs, _state } = {}) {
  if (!symbol) throw new AttestationError('readConsensusPerp: symbol is required');
  if (!Number.isInteger(perpIndexHint) || perpIndexHint < 0) throw new AttestationError(`readConsensusPerp: perpIndexHint must be a non-negative integer, got ${perpIndexHint}`);
  const opt = { rpcs, timeoutMs, _state };
  const [infoHex, markHex, oracleHex, l1Hex] = await Promise.all([
    ethCall(PRECOMPILES.perpAssetInfo, '0x' + u32(perpIndexHint), opt),
    ethCall(PRECOMPILES.markPx, '0x' + u32(perpIndexHint), opt),
    ethCall(PRECOMPILES.oraclePx, '0x' + u32(perpIndexHint), opt),
    ethCall(PRECOMPILES.l1BlockNumber, '0x', opt),
  ]);
  const info = decodePerpAssetInfo(infoHex);
  const want = String(symbol).toUpperCase();
  if (info.coin.toUpperCase() !== want) {
    throw new AttestationError(`index alignment: perpIndex ${perpIndexHint} is "${info.coin}" on chain, not "${want}". Refusing — comparing two different assets would produce a number that looks like agreement.`);
  }
  const scale = priceScale(info.szDecimals);
  const markRaw = BigInt(markHex), oracleRaw = BigInt(oracleHex);
  if (markRaw <= 0n) throw new AttestationError(`markPx(${perpIndexHint}) is ${markRaw} on chain — refusing to compare against a non-positive consensus price`);
  return {
    perpIndex: perpIndexHint,
    coin: info.coin,
    szDecimals: info.szDecimals,
    maxLeverage: info.maxLeverage,
    marginTableId: info.marginTableId,
    onlyIsolated: info.onlyIsolated,
    scale,
    tick: 1 / scale,
    markPx: Number(markRaw) / scale,
    markRaw,
    oraclePx: Number(oracleRaw) / scale,
    l1Block: Number(BigInt(l1Hex)),
    at: Date.now(),
  };
}

/** Read one leg of an address's book from consensus. Requires szDecimals to scale `szi`. */
export async function readConsensusPosition({ user, perpIndex, szDecimals, rpcs, timeoutMs, _state } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(user || ''))) throw new AttestationError(`readConsensusPosition: bad address ${user}`);
  if (!Number.isInteger(szDecimals)) throw new AttestationError('readConsensusPosition: szDecimals required');
  const hex = await ethCall(PRECOMPILES.position, '0x' + addr32(user) + u32(perpIndex), { rpcs, timeoutMs, _state });
  return decodePosition(hex, szDecimals);
}

/* ────────────────────────────── the attestation ────────────────────────────── */

const VERDICT = { AGREE: 'AGREE', DISAGREE: 'DISAGREE', UNATTESTABLE: 'UNATTESTABLE', UNAVAILABLE: 'UNAVAILABLE' };
export { VERDICT };

/**
 * The comparison core, PURE and offline: is `claimed` inside the consensus bracket, once the
 * caller's allowance is added either side?
 *
 *   allow = bound.rel · ref  +  bound.ticks · tick
 *
 * Two terms, because measurement says the residual has two unrelated causes and a one-term bound
 * cannot cover both without being loose. Over 1,856 full-universe observations the worst relative
 * residual was 1.131e-3, on W — and it is EXACTLY ONE TICK. W trades at 0.0088 with a 1e-5 tick, so
 * a single unavoidable step of price-grid quantisation is 1.1e-3 of its price. A purely relative
 * bound therefore has to be ≥1.2e-3 to admit an honest one-tick disagreement on the cheapest asset,
 * which is looser than the cross-venue consensus floor this approach exists to beat. Meanwhile the
 * largest residual in TICKS was 500 (ZEC, whose tick is 1e-4 against a 464 price) at only 1.077e-4
 * relative, so a purely tick-denominated bound has the mirror-image problem. Each term covers the
 * regime the other cannot.
 *
 * Exported separately from the network path so a gate can test the knife-edge — a value 2% past the
 * allowance must be refused while one 2% inside it is accepted — deterministically, with no live
 * price moving underneath the assertion.
 */
export function compareToBracket({ quantity, claimed, lo, hi, ref, tick, bound }) {
  if (!bound || !Number.isFinite(bound.rel) || !Number.isFinite(bound.ticks)) {
    throw new AttestationError('compareToBracket: `bound` {rel, ticks} is required');
  }
  const allowance = bound.rel * ref + bound.ticks * tick;
  const outside = claimed < lo ? lo - claimed : claimed > hi ? claimed - hi : 0;
  const excess = outside > allowance ? outside - allowance : 0;
  return {
    quantity,
    verdict: excess === 0 ? VERDICT.AGREE : VERDICT.DISAGREE,
    claimed, consensusLo: lo, consensusHi: hi,
    outsideBracket: outside, outsideBracketRel: outside / ref,
    outsideBracketTicks: outside / tick,
    allowance, allowanceRel: allowance / ref,
    // How much of the allowance this observation consumed. A gate whose worst honest case uses a
    // few percent of its bound has a generous bound, not evidence.
    usedFraction: allowance > 0 ? outside / allowance : (outside === 0 ? 0 : Infinity),
    excess,
  };
}

/**
 * Bracketed attestation of the perp inputs `hyperliquid.js` supplied.
 *
 * @param o.symbol         asset, e.g. 'BTC' (required)
 * @param o.perpIndexHint  index from the HTTP universe; confirmed against the on-chain coin name
 * @param o.claimed        the values that were fetched over HTTP, e.g. {markPrice, maxLeverage, fundingRateHourly, marginTiers}
 * @param o.fetchClaimed   async () => claimed, invoked BETWEEN the two consensus reads. This is the
 *                         only form in which the adapter can GUARANTEE the bracket straddles the
 *                         claim in time; see `claimWindow` below.
 * @param o.claimedAt      ms timestamp at which a pre-fetched `claimed` was read over HTTP. Lets the
 *                         adapter check the straddle instead of assuming it.
 * @param o.bound          REQUIRED. {rel, ticks} — allowance added either side of the consensus
 *                         bracket. No default: the enforcing gate owns this number.
 * @param o.bracket        read consensus twice around the claim (default true). false = single read,
 *                         which is weaker and is labelled as such in the result.
 * @param o.gapMs          spacing between the two consensus reads. Must exceed the /info snapshot
 *                         turnover (measured max 853 ms over 60 polls / 23.0 s) or the bracket
 *                         cannot contain a stale snapshot and the gate will refuse honest data.
 *
 * @returns {{
 *   ok: boolean,                       every ATTESTABLE claimed quantity agreed
 *   fullyCovered: boolean,             no claimed quantity was unattestable
 *   checks: object[], unattestable: object[], consensus: object, bracketRel: number
 * }}
 *
 * `ok === true && fullyCovered === false` is a PARTIAL attestation. Callers must surface that;
 * reporting it as a clean pass would be a guarantee stated over the general case that holds only
 * over a subset, which is the defect shape this project has repeatedly caught.
 */
export async function attestPerpInputs({ symbol, perpIndexHint, claimed = {}, fetchClaimed, claimedAt, bound, bracket = true, gapMs = 1500, rpcs, timeoutMs } = {}) {
  if (!bound || !Number.isFinite(bound.rel) || !Number.isFinite(bound.ticks)) {
    throw new AttestationError('attestPerpInputs: `bound` {rel, ticks} is required. There is no default tolerance — the gate that enforces a bound owns it.');
  }
  if (bracket && !(gapMs >= 1100)) {
    throw new AttestationError(`attestPerpInputs: gapMs ${gapMs} is below the measured worst /info snapshot turnover (853 ms over 60 polls). A bracket narrower than the snapshot period cannot contain a stale snapshot and would refuse honest data.`);
  }
  const _state = { i: 0 };
  const opt = { rpcs, timeoutMs, _state };

  let a, b, claimAt = claimedAt ?? null, claimSource = fetchClaimed ? 'fetched-inside-window' : (claimedAt != null ? 'pre-fetched-with-timestamp' : 'pre-fetched-untimed');
  try {
    a = await readConsensusPerp({ symbol, perpIndexHint, ...opt });
    if (bracket) {
      // The claim is fetched HERE, between the two consensus reads, when the caller lets us. That is
      // the only arrangement in which "the HTTP value is bracketed by consensus" is a fact rather
      // than a hope: a claim fetched before `a` is older than both reads, and the bracket cannot
      // contain it no matter how wide the allowance.
      const half = Math.floor(gapMs / 2);
      await sleep(half);
      if (fetchClaimed) { claimed = await fetchClaimed(); claimAt = Date.now(); }
      await sleep(gapMs - half);
      b = await readConsensusPerp({ symbol, perpIndexHint, ...opt });
    } else if (fetchClaimed) { claimed = await fetchClaimed(); claimAt = Date.now(); }
  } catch (e) {
    // An unreachable or misaligned consensus read is NOT a pass and NOT a soft warning.
    return {
      ok: false, fullyCovered: false, verdict: VERDICT.UNAVAILABLE,
      error: String(e.message), checks: [], unattestable: [], consensus: null, bracketRel: null,
    };
  }
  const reads = bracket ? [a, b] : [a];
  const mid = reads.reduce((s, r) => s + r.markPx, 0) / reads.length;
  const loMark = Math.min(...reads.map((r) => r.markPx));
  const hiMark = Math.max(...reads.map((r) => r.markPx));
  const bracketRel = (hiMark - loMark) / mid;

  const checks = [], unattestable = [];
  // ONE implementation of the comparison, shared with the gate's offline knife-edge test. A second
  // copy here would be free to drift from the one under test, and a bound proved on a copy is a
  // bound nobody has proved.
  const rangeCheck = (name, claimedVal, lo, hi, ref) =>
    checks.push(compareToBracket({ quantity: name, claimed: claimedVal, lo, hi, ref, tick: a.tick, bound }));

  // ---- markPrice ----
  if (claimed.markPrice != null) {
    const v = Number(claimed.markPrice);
    if (!(v > 0)) checks.push({ quantity: 'markPrice', verdict: VERDICT.DISAGREE, claimed: v, reason: 'claimed mark is not a positive number' });
    else rangeCheck('markPrice', v, loMark, hiMark, mid);
  }
  // ---- oraclePrice ----
  if (claimed.oraclePrice != null) {
    const lo = Math.min(...reads.map((r) => r.oraclePx)), hi = Math.max(...reads.map((r) => r.oraclePx));
    const ref = reads.reduce((s, r) => s + r.oraclePx, 0) / reads.length;
    const v = Number(claimed.oraclePrice);
    if (!(v > 0) || !(ref > 0)) checks.push({ quantity: 'oraclePrice', verdict: VERDICT.DISAGREE, claimed: v, reason: 'non-positive oracle price on one side' });
    else rangeCheck('oraclePrice', v, lo, hi, ref);
  }
  // ---- maxLeverage: an integer, so it is EXACT. No tolerance, and none is offered. ----
  if (claimed.maxLeverage != null) {
    const same = reads.every((r) => r.maxLeverage === a.maxLeverage);
    const agree = same && Number(claimed.maxLeverage) === a.maxLeverage;
    checks.push({
      quantity: 'maxLeverage', verdict: agree ? VERDICT.AGREE : VERDICT.DISAGREE,
      claimed: Number(claimed.maxLeverage), consensus: a.maxLeverage, exact: true,
      ...(same ? {} : { reason: 'maxLeverage changed between the two consensus reads' }),
    });
  }

  // ---- quantities with no precompile: REFUSED, never waved through ----
  for (const [k, v] of Object.entries(claimed)) {
    if (v == null) continue;
    const spec = ATTESTABILITY[k];
    if (!spec) { unattestable.push({ quantity: k, verdict: VERDICT.UNATTESTABLE, reason: `not in the attestability register — unknown quantities fail closed` }); continue; }
    if (!spec.attestable) unattestable.push({ quantity: k, verdict: VERDICT.UNATTESTABLE, reason: spec.reason });
  }

  // ---- the coverage trap the research doc names but does not implement ----
  // perp-gate prefers marginTiers over maxLeverage. If the caller had tiers, then attesting
  // maxLeverage attests a quantity the ENGINE DID NOT USE. Saying "maxLeverage: AGREE" without
  // saying that would be a true statement doing the work of a false one.
  const substituted = (claimed.marginTiers != null && claimed.maxLeverage != null)
    ? { attested: 'maxLeverage', actuallyUsedByEngine: 'marginTiers', note: 'perp-gate prefers notional margin tiers; the attested quantity is a coarser substitute for the one that produced the answer' }
    : null;

  // Did the bracket actually straddle the claim in time? Only answerable when the adapter fetched the
  // claim itself or was told when it was fetched. `null` means UNKNOWN, and unknown is reported as
  // unknown — a bracket asserted over a claim of unknown age is a guarantee with a hole in it, which
  // is the exact defect shape this module exists to refuse.
  const claimWindow = {
    source: claimSource,
    bracketStart: a.at, bracketEnd: bracket ? b.at : a.at, claimAt,
    straddled: !bracket ? null : claimAt == null ? null : (claimAt >= a.at && claimAt <= b.at),
  };
  const bracketValid = bracket ? claimWindow.straddled === true : false;

  const ok = checks.length > 0 && checks.every((c) => c.verdict === VERDICT.AGREE);
  return {
    ok,
    fullyCovered: unattestable.length === 0 && !substituted,
    checks, unattestable,
    substitutedForUsedQuantity: substituted,
    claimWindow,
    bracketValid,
    consensus: {
      coin: a.coin, perpIndex: a.perpIndex, szDecimals: a.szDecimals, tick: a.tick,
      maxLeverage: a.maxLeverage, marginTableId: a.marginTableId,
      markLo: loMark, markHi: hiMark,
      l1Block: reads.map((r) => r.l1Block), windowMs: bracket ? b.at - a.at : 0,
    },
    bracketRel,
    bracketed: bracket,
    bound,
  };
}

/** Resolve symbol -> perpIndex from the HTTP universe. The result is an UNTRUSTED HINT: it comes from
 *  the same source under test, and is only meaningful because readConsensusPerp confirms it on chain. */
export async function fetchPerpIndexHints({ timeoutMs = 15000 } = {}) {
  const r = await fetch(HTTP_INFO, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new AttestationError(`hyperliquid info ${r.status}`);
  const j = await r.json();
  const universe = j?.[0]?.universe, ctxs = j?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs) || universe.length !== ctxs.length) {
    throw new AttestationError('hyperliquid: unexpected metaAndAssetCtxs shape');
  }
  const hints = new Map();
  for (let i = 0; i < universe.length; i++) hints.set(String(universe[i].name).toUpperCase(), i);
  return { hints, universe, ctxs, at: Date.now() };
}
