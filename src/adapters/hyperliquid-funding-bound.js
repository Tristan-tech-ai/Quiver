// Hyperliquid funding, attested from a BOUND on the premium rather than from the premium itself.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY A BOUND IS ENOUGH, SOMETIMES.
//
// The venue's hourly rate is an exact function of one published number, the hourly premium P:
//
//     funding_hourly = ( P + clamp(1e-4 - P, -5e-4, +5e-4) ) / 8
//
// re-verified here on 50,976 of 50,976 live asset-hours (232 coins x 12 days, exact BigInt, fixed
// 5e-11 tolerance) — see T10_HL_PREMIUM_BOUND.md §2. The clamp is applied AFTER the hour's premium
// is averaged, not per sample, so the composition is: average first, then clamp once.
//
// That ordering is the whole opening. Where the clamp saturates the rate is EXACTLY 1.25e-5 no
// matter what P was, so on those hours a verifier does not need P's value — a BOUND on P that
// stays inside the no-clamp band pins the rate exactly. The band is asymmetric:
//
//     P in [-4e-4, +6e-4]   ->   funding_hourly = 1.25e-5 exactly
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHERE THE BOUND COMES FROM. Two HyperEVM precompiles, both measured, not assumed:
//
//     0x…0807  oraclePx(uint32)   == the venue's published oraclePx on 2,104/2,104 sandwich-stable
//                                  reads across the full 232-perp universe, worst relative error 0.
//     0x…080E  bbo(uint32)        == the venue's top of book (bid, ask) on 65/66 sandwich-stable
//                                  reads against l2Book, and (bid+ask)/2 reproduces the published
//                                  midPx. It returns 64 bytes — two prices, NO SIZES. There is no
//                                  depth on chain, which is exactly why this is a bound and not a
//                                  computation.
//
// The venue's per-sample premium is built from IMPACT prices, which are depth-weighted:
//
//     p(t) = ( max(impact_bid - oracle, 0) - max(oracle - impact_ask, 0) ) / oracle
//
// Impact prices are VWAPs walking away from the touch, so they bracket the top of book from the
// OUTSIDE: impact_bid <= best_bid and impact_ask >= best_ask. Substituting the touch therefore
// bounds the premium from the inside:
//
//     LB(t) = -max(oracle - best_ask, 0) / oracle   <=   p(t)   <=   max(best_bid - oracle, 0) / oracle = UB(t)
//
// Both are readable on chain. Note LB(t) <= 0 <= UB(t) and at most one is non-zero, because
// best_bid < best_ask. When the oracle sits INSIDE the top of book both are zero and the bound is
// not a bound at all — it pins p(t) = 0 exactly.
//
// Because the clamp comes after the averaging, the bound composes by linearity for free:
//
//     mean(LB) <= P <= mean(UB)          and the rate is pinned iff
//     mean(LB) >= -4e-4  AND  mean(UB) <= +6e-4
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES NOT DO, STATED UP FRONT.
//
//   * It does not recover the premium. On an hour the bound fails to pin, this module returns
//     UNATTESTABLE. It never approximates, never interpolates, and never falls back to the venue's
//     own number and calls the result attested.
//   * The structural inequality is measured, not proved. On a point-in-time read it holds on
//     ~97-98% of asset-samples; a short lookback envelope raises that to ~99%; reading EVERY
//     HyperEVM block (1s) instead of every 5s does NOT close the rest (measured: 98.10% vs 97.24%).
//     The residual is a real property — published impact prices are rounded to the price grid, and
//     HyperCore's book moves between the states the EVM exposes — so it is carried as a MEASURED
//     margin (see calibration), never as an assumption.
//   * Read off chain, as this module runs by default, both reads are unsigned HTTPS. It becomes an
//     attestation only when the same comparison runs inside a contract on HyperEVM, where the
//     precompile value comes from consensus rather than from a wire. Same boundary
//     `hyperliquid-attest.js` draws.
//   * It reaches the venue's state and stops there. A manipulated oracle is bounded with full force.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export class FundingBoundError extends Error {}

// ── fixed point ────────────────────────────────────────────────────────────────────────────────
// Everything is BigInt at 1e18. Prices from the precompiles are integers on a per-asset grid of
// 10^(6-szDecimals); the grid CANCELS in every ratio below, so it never has to be applied.
export const E = 18n;
export const ONE = 10n ** E;

export const INTEREST_8H = ONE / 10_000n;        //  1e-4
export const CLAMP_8H = 5n * ONE / 10_000n;      //  5e-4
export const BAND_LO = INTEREST_8H - CLAMP_8H;   // -4e-4   lower edge of the no-clamp band for P
export const BAND_HI = INTEREST_8H + CLAMP_8H;   // +6e-4   upper edge
export const PINNED_RATE_STR = '0.0000125';      //  the rate on every non-clamped hour
export const PINNED_RATE = ONE / 80_000n;        //  1.25e-5

export const PRECOMPILES = {
  oraclePx: '0x0000000000000000000000000000000000000807',
  bbo: '0x000000000000000000000000000000000000080e',
};

/** Half-ULP of the venue's 10-decimal printed premium. Not a tolerance we chose; it is the
 *  finest distinction the venue's own printing can express. */
export const PRINT_HALF_ULP = ONE / 20_000_000_000n;   // 5e-11

const ceilDiv = (a, b) => (a + b - 1n) / b;            // a >= 0, b > 0

/** Parse a decimal string to BigInt at 1e18, exactly. No floating point anywhere. */
export function parseDecimal(s) {
  if (typeof s === 'bigint') return s;
  let str = String(s).trim();
  // at least one digit, no exponent: `1e-4` must be refused rather than silently mis-read
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(str)) throw new FundingBoundError(`not a plain decimal: ${JSON.stringify(s)}`);
  const neg = str.startsWith('-');
  if (neg || str.startsWith('+')) str = str.slice(1);
  const [a = '0', b = ''] = str.split('.');
  // keep exactness: refuse rather than silently truncate a number we were asked to verify.
  // (`/0*$/` would match the empty string and so never fire — the anchor on both ends is load-bearing.)
  if (b.length > 18 && !/^0*$/.test(b.slice(18))) throw new FundingBoundError(`more than 18 significant decimals: ${s}`);
  const frac = (b + '0'.repeat(18)).slice(0, 18);
  const v = BigInt(a || '0') * ONE + BigInt(frac || '0');
  return neg ? -v : v;
}
export const formatFixed = (v, dp = 10) => {
  const neg = v < 0n; const x = neg ? -v : v;
  const i = x / ONE, f = (x % ONE).toString().padStart(18, '0').slice(0, dp);
  return `${neg ? '-' : ''}${i}${dp ? '.' + f : ''}`;
};

// ── the per-sample bound ───────────────────────────────────────────────────────────────────────
/**
 * One 5-second sample. `oracle`, `bid`, `ask` are the raw precompile integers for ONE asset, all on
 * the same price grid. Returns the bound on that sample's premium at 1e18.
 *
 * Directed rounding: `ub` rounds AWAY from the premium (up), `lb` rounds AWAY from the premium
 * (down). A bound that rounded inward would be unsound by up to one ULP per sample, and there are
 * 720 samples in an hour.
 */
export function sampleBound({ oracle, bid, ask }) {
  const o = BigInt(oracle), X = BigInt(bid), Y = BigInt(ask);
  if (o <= 0n) throw new FundingBoundError('oracle price is zero or negative');
  if (X <= 0n || Y <= 0n) return null;             // no book on this side: not a usable sample
  if (X > Y) throw new FundingBoundError(`crossed book: bid ${X} > ask ${Y}`);
  return {
    ub: X > o ? ceilDiv((X - o) * ONE, o) : 0n,
    lb: o > Y ? -ceilDiv((o - Y) * ONE, o) : 0n,
    oracleInsideBook: X <= o && o <= Y,
  };
}

/**
 * Accumulate an hour. `samples` is an array of {oracle,bid,ask} in time order.
 * Directed rounding again: the mean of the upper terms rounds up, the mean of the lower terms
 * rounds down.
 */
export function accumulate(samples) {
  let sUB = 0n, sLB = 0n, n = 0, inside = 0, skipped = 0;
  for (const s of samples) {
    let b;
    try { b = sampleBound(s); } catch { skipped++; continue; }
    if (!b) { skipped++; continue; }
    sUB += b.ub; sLB += b.lb; n++;
    if (b.oracleInsideBook) inside++;
  }
  if (n === 0) throw new FundingBoundError('no usable samples');
  const N = BigInt(n);
  return {
    n, skipped, oracleInsideBook: inside,
    meanUB: ceilDiv(sUB, N),                    // >= 0, rounded up
    meanLB: -ceilDiv(-sLB, N),                  // <= 0, rounded down
  };
}

// ── the decision ───────────────────────────────────────────────────────────────────────────────
/**
 * Does the bound pin the hour's funding rate?
 *
 * `margin` widens the bound on BOTH sides and is the measured allowance for the residual described
 * at the top of this file. It only ever makes pinning HARDER. A negative margin is refused: that
 * would narrow a bound to manufacture a verdict.
 *
 * `minCoverage` is a coverage assertion, and it is not decoration. A verifier that accepts whatever
 * samples it was handed can be defeated by handing it only the quiet ones: mean(UB) and mean(LB)
 * are means of NON-NEGATIVE excursions, so dropping the loud samples shrinks the bound and
 * manufactures a pin. This is the same defect gateF-tvl-reconstruct.mjs §F8 found in an
 * intersection-only comparison, and it is refused the same way.
 */
export function pinFundingRate({ meanUB, meanLB, margin = 0n, n, expectedSamples = 720, minCoverage = 0.9 }) {
  if (margin < 0n) throw new FundingBoundError('negative margin would narrow the bound');
  const coverage = expectedSamples > 0 ? n / expectedSamples : 1;
  if (coverage < minCoverage) {
    return {
      attestable: false, fundingRate: null, reason: 'INSUFFICIENT_COVERAGE',
      detail: `${n}/${expectedSamples} samples = ${(100 * coverage).toFixed(1)}%, need ${(100 * minCoverage).toFixed(0)}%`,
      coverage, loUsed: null, hiUsed: null,
    };
  }
  const lo = meanLB - margin, hi = meanUB + margin;      // widened, never narrowed
  const okLo = lo >= BAND_LO, okHi = hi <= BAND_HI;
  // how much of the room to each band edge the bound consumes; >1 means it does not fit
  const loUsed = Number(-lo) / Number(-BAND_LO);
  const hiUsed = Number(hi) / Number(BAND_HI);
  if (okLo && okHi) {
    return {
      attestable: true, fundingRate: PINNED_RATE_STR, fundingRateFixed: PINNED_RATE,
      reason: 'PINNED_BY_BOUND', coverage,
      bound: { lo, hi }, loUsed, hiUsed,
    };
  }
  return {
    attestable: false, fundingRate: null, coverage,
    reason: !okLo && !okHi ? 'BOUND_EXCEEDS_BOTH_EDGES' : (!okLo ? 'BOUND_EXCEEDS_LOW_EDGE' : 'BOUND_EXCEEDS_HIGH_EDGE'),
    detail: `bound [${formatFixed(lo, 12)}, ${formatFixed(hi, 12)}] not inside [-0.0004, 0.0006]`,
    bound: { lo, hi }, loUsed, hiUsed,
  };
}

/**
 * The half that can fail. A premium the caller claims must lie inside the bound; a fabricated one
 * must be REFUSED. This is the check that makes the module a verifier rather than a calculator,
 * and it runs whether or not the hour turned out to be pinnable.
 */
export function checkClaimedPremium({ claimedPremium, meanUB, meanLB, margin = 0n }) {
  if (margin < 0n) throw new FundingBoundError('negative margin would narrow the bound');
  const P = parseDecimal(claimedPremium);
  const lo = meanLB - margin - PRINT_HALF_ULP;
  const hi = meanUB + margin + PRINT_HALF_ULP;
  if (P < lo) return { ok: false, reason: 'CLAIM_BELOW_BOUND', by: lo - P, claimed: P, lo, hi };
  if (P > hi) return { ok: false, reason: 'CLAIM_ABOVE_BOUND', by: P - hi, claimed: P, lo, hi };
  return { ok: true, reason: 'CLAIM_INSIDE_BOUND', claimed: P, lo, hi, slackBelow: P - lo, slackAbove: hi - P };
}

/**
 * End to end for one asset-hour. Returns an ATTESTATION, or a refusal that names which half failed.
 * `claimedFundingRate` / `claimedPremium` are optional; when supplied they are checked and a
 * disagreement is a refusal, never a warning.
 */
export function verifyFundingHour({
  samples, accumulated, margin = 0n, expectedSamples = 720, minCoverage = 0.9,
  claimedFundingRate = null, claimedPremium = null, coin = null, hourStartMs = null,
}) {
  const acc = accumulated ?? accumulate(samples ?? []);
  const pin = pinFundingRate({ ...acc, margin, expectedSamples, minCoverage });
  const out = {
    coin, hourStartMs, samples: acc.n, skipped: acc.skipped,
    oracleInsideBookFrac: acc.n ? acc.oracleInsideBook / acc.n : 0,
    meanUB: acc.meanUB, meanLB: acc.meanLB, margin,
    boundWidth: (acc.meanUB + margin) - (acc.meanLB - margin),
    ...pin, refusals: [],
  };
  if (claimedPremium != null) {
    const c = checkClaimedPremium({ claimedPremium, meanUB: acc.meanUB, meanLB: acc.meanLB, margin });
    out.premiumCheck = c;
    if (!c.ok) { out.refusals.push(c.reason); out.attestable = false; out.fundingRate = null; }
  }
  if (claimedFundingRate != null && out.attestable) {
    const claimed = parseDecimal(claimedFundingRate);
    if (claimed !== PINNED_RATE) {
      out.refusals.push('RATE_DISAGREES_WITH_PINNED_VALUE');
      out.attestable = false; out.fundingRate = null;
      out.rateDisagreement = { claimed, pinned: PINNED_RATE };
    }
  }
  if (!out.attestable && out.refusals.length === 0) out.refusals.push(out.reason);
  return out;
}

// ── chain reads ────────────────────────────────────────────────────────────────────────────────
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const wordsOf = (hex) => { const b = (hex || '0x').slice(2); const o = []; for (let k = 0; k + 64 <= b.length; k += 64) o.push(BigInt('0x' + b.slice(k, k + 64))); return o; };

export function encodeAggregate3(calls) {
  const tuples = calls.map((c) => {
    const cd = c.data.slice(2);
    return w(BigInt(c.to)) + w(1) + w(96) + w(cd.length / 2) + cd + '0'.repeat((64 - (cd.length % 64)) % 64);
  });
  let off = 32 * calls.length, offs = '';
  for (const t of tuples) { offs += w(off); off += t.length / 2; }
  return '0x82ad56cb' + w(32) + w(calls.length) + offs + tuples.join('');
}
export function decodeAggregate3(hex) {
  const b = hex.slice(2), W = (k) => b.slice(k * 64, (k + 1) * 64);
  const n = Number(BigInt('0x' + W(1))), out = [];
  for (let i = 0; i < n; i++) {
    const tOff = 2 + Number(BigInt('0x' + W(2 + i))) / 32;
    const dOff = tOff + Number(BigInt('0x' + W(tOff + 1))) / 32;
    const len = Number(BigInt('0x' + W(dOff)));
    out.push({ success: BigInt('0x' + W(tOff)) === 1n, data: '0x' + b.slice((dOff + 1) * 64, (dOff + 1) * 64 + len * 2) });
  }
  return out;
}

/**
 * One consistent chain snapshot: oracle + top of book for `indices`, all read AT THE SAME BLOCK.
 * Pinning the block matters — reads spread across blocks would mix book states and the bound would
 * be a bound on nothing in particular.
 */
export async function readSnapshot({ indices, rpc = 'https://rpc.hyperliquid.xyz/evm', blockTag, timeoutMs = 20000, fetchImpl = fetch }) {
  const call = async (method, params) => {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl });
    const j = await r.json();
    if (j.error) throw new FundingBoundError(`${method}: ${j.error.message}`);
    return j.result;
  };
  const tag = blockTag ?? await call('eth_blockNumber', []);
  const calls = [];
  for (const i of indices) calls.push({ to: PRECOMPILES.oraclePx, data: '0x' + w(i) });
  for (const i of indices) calls.push({ to: PRECOMPILES.bbo, data: '0x' + w(i) });
  const raw = await call('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, tag]);
  const dec = decodeAggregate3(raw);
  const out = new Map();
  indices.forEach((idx, k) => {
    const o = dec[k], b = dec[indices.length + k];
    const ow = o?.success ? wordsOf(o.data) : [], bw = b?.success ? wordsOf(b.data) : [];
    out.set(idx, {
      oracle: ow.length >= 1 ? ow[0] : null,
      bid: bw.length >= 2 ? bw[0] : null,
      ask: bw.length >= 2 ? bw[1] : null,
    });
  });
  return { blockTag: tag, blockNumber: Number(tag), values: out };
}

export const _internal = { ceilDiv, wordsOf, w };
