// LP RANGE REALITY-CHECK — what a concentrated-liquidity range WOULD have earned, on real swaps.
//
// This service exists to REFUSE a product, and the refusal is the finding. Every "range optimiser" sells
// you an optimal width. We measured whether one exists, on 211k real Uniswap-V3 swaps, and it does not:
//
//   • Narrow ranges are destroyed, and NOT by gas. ETH/USDC 0.05%, ±0.5%, 30 days: LP−HODL −41.7% while
//     gas was only $2,325 of it. The loss is rebalance bleed (LVR). Replicated 18 months earlier: −32.8%.
//   • The shipped competitor hardcodes ±5%. That band was NEGATIVE in both windows (−1.50%, −2.49%).
//   • A perfect ORACLE width beats that band by ~4% of capital per window (4.32% / 4.04%) — but nothing
//     capturable reaches it. Vol-fitting (the whole premise of an "optimiser") beat a constant calibrated
//     once offline by +0.24pp in one window and −1.08pp in the other. And in the 2026 window the DUMB ±5%
//     beat both the calibrated constant (−3.35%) and the vol-adaptive rule (−4.44%) out-of-sample.
//   • Optimal-in-hindsight width is ~“wide enough never to rebalance” (rebalances=0 at the optimum, and
//     LP−HODL ≈ fees there), which is a one-liner, not a fitted model.
//
// So we do not sell an optimiser. We sell the measurement, and we say plainly when the answer is "don't".
//
// HONEST BIASES, both of which FAVOUR narrow ranges — and narrow still loses, so the finding is robust:
//   (a) we re-centre instantly and costlessly on exit, so a narrow position is in-range ~100% of the time;
//   (b) fee share uses myL/(activeL+myL) at small size, which flatters a concentrated position.
// LIMIT: swap logs carry only AGGREGATE active liquidity, not the per-tick book (that needs a Mint/Burn
// replay). So this is exact for RELATIVE strategy ranking at small size; it is NOT absolute LP PnL at size.
import { poolMeta, fetchSwaps } from '../adapters/univ3.js';
import { round } from './stats.js';

const valueOfL = (L, p, pa, pb, d0, d1, px) => {
  const sp = Math.sqrt(Math.min(Math.max(p, pa), pb)), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  return (L * (1 / sp - 1 / spb)) / 10 ** d0 + (L * (sp - spa)) / 10 ** d1 * px;
};
const solveL = (cap, p, pa, pb, d0, d1, px) => { const v = valueOfL(1, p, pa, pb, d0, d1, px); return v > 0 ? cap / v : 0; };

/** Simulate one range strategy over real swaps. widthLog = half-width in log-price. */
function simulate(rows, meta, widthLog, capital, gasUsd) {
  const { d0, d1 } = meta;
  const pOf = (r) => Math.pow(1.0001, r.tick);                  // pool-native token1/token0 (raw)
  // NUMERAIRE = token0. p01 is token1-per-token0, so the value of one token1 in token0 units is 1/p01.
  // Feeding p01 here inverted every valuation (for ETH/USDC that is a factor of ~1830).
  const pxOf = (r) => (r.p01 > 0 ? 1 / r.p01 : 0);              // token0 per token1
  const r0 = rows[0];
  let p = pOf(r0), px = pxOf(r0);
  let pa = p * Math.exp(-widthLog), pb = p * Math.exp(widthLog);
  let L = solveL(capital, p, pa, pb, d0, d1, px);
  const sp0 = Math.sqrt(Math.min(Math.max(p, pa), pb));
  const hodl0 = L * (1 / sp0 - 1 / Math.sqrt(pb)) / 10 ** d0;
  const hodl1 = L * (sp0 - Math.sqrt(pa)) / 10 ** d1;
  let fees = 0, reb = 0, gas = 0, inRange = 0, n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; p = pOf(r); px = pxOf(r); n++;
    if (p >= pa && p <= pb) {
      inRange++;
      const aL = Number(r.liquidity);
      if (aL > 0) {
        const share = L / (aL + L);
        // fee is charged on the INPUT token; convert to the token0 numeraire (token0 fee is already there)
        const feeUsd = r.feeInToken0 ? r.feeAmt : r.feeAmt * px;
        if (Number.isFinite(feeUsd) && feeUsd >= 0) fees += share * feeUsd;
      }
    } else {
      const val = valueOfL(L, p, pa, pb, d0, d1, px);
      gas += gasUsd; reb++;
      pa = p * Math.exp(-widthLog); pb = p * Math.exp(widthLog);
      L = solveL(Math.max(val - gasUsd, 1e-9), p, pa, pb, d0, d1, px);
    }
  }
  const last = rows[rows.length - 1], pE = pOf(last), pxE = pxOf(last);
  const lp = valueOfL(L, pE, pa, pb, d0, d1, pxE) + fees;
  const hodl = hodl0 + hodl1 * pxE;
  return {
    widthPct: round((Math.exp(widthLog) - 1) * 100, 2),
    lpVsHodlPct: round(100 * (lp - hodl) / capital, 3),
    feesUsd: round(fees, 2), rebalances: reb, gasUsd: round(gas, 0),
    timeInRangePct: round(100 * inRange / Math.max(n, 1), 1),
  };
}

export async function lpDesk({ chain = 'ethereum', pool, days = 2, capital = 10000, gasUsd = 3, widthPct } = {}) {
  // Bounded by MEASUREMENT, not by taste: on ETH/USDC 0.05% a 3-day pull is 13,872 swaps and the free node
  // genuinely scans ~22k blocks for it (~43s). 2 days lands ~9.3k swaps in a single un-capped call (~3s),
  // which is a real sample and a sane paid-endpoint latency. Callers may widen deliberately; we do not
  // default into a 40s response for an agent that pays per call.
  days = Math.min(Math.max(Number(days) || 2, 0.25), 7);
  if (!pool) return { ok: false, reason: 'pool address required (e.g. 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 = ETH/USDC 0.05% mainnet)' };
  const t0 = Date.now();
  const meta = await poolMeta(chain, pool);
  if (!meta || meta.__failed) return { ok: false, reason: `pool metadata read failed for ${pool} on ${chain}: ${meta?.reason || 'unknown failure'}` };
  const rows = await fetchSwaps(chain, pool, meta, days);
  if (rows.length < 200) return { ok: false, reason: `only ${rows.length} swaps in the last ${days}d — too few to measure anything; refusing rather than reporting noise`, poolMeta: meta };

  const spanDays = (rows[rows.length - 1].ts - rows[0].ts) / 86400;
  // realised vol from the tick path
  const step = Math.max(1, Math.floor(rows.length / 720));
  const px = []; for (let i = 0; i < rows.length; i += step) px.push(rows[i].p01);
  const rets = []; for (let i = 1; i < px.length; i++) if (px[i] > 0 && px[i - 1] > 0) rets.push(Math.log(px[i] / px[i - 1]));
  const mR = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
  const vR = rets.reduce((s, x) => s + (x - mR) ** 2, 0) / Math.max(rets.length - 1, 1);
  const sigDaily = Math.sqrt(vR) * Math.sqrt(px.length / Math.max(spanDays, 1e-9));

  const grid = [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.10, 0.15, 0.20, 0.30];
  const sweep = grid.map((w) => simulate(rows, meta, Math.log(1 + w), capital, gasUsd));
  const best = sweep.reduce((a, b) => (b.lpVsHodlPct > a.lpVsHodlPct ? b : a));
  const w5 = sweep.find((s) => Math.abs(s.widthPct - 5) < 0.01);
  const asked = widthPct > 0 ? simulate(rows, meta, Math.log(1 + widthPct / 100), capital, gasUsd) : null;
  const spread = Math.max(...sweep.map((s) => s.lpVsHodlPct)) - Math.min(...sweep.map((s) => s.lpVsHodlPct));

  return {
    ok: true, service: 'lp-desk', chain, pool,
    poolMeta: { token0: meta.token0, token1: meta.token1, feeTierPct: meta.feeTierPct, decimals: [meta.d0, meta.d1] },
    window: { swaps: rows.length, days: round(spanDays, 1), realisedVolPctPerDay: round(sigDaily * 100, 2), capitalUsd: capital, gasUsdPerRebalance: gasUsd },
    yourRange: asked ? { ...asked, verdict: asked.lpVsHodlPct < 0 ? 'this range LOST to simply holding the two tokens, over this window' : 'this range beat holding, over this window' } : null,
    sweep,
    oracle: { bestWidthPct: best.widthPct, bestLpVsHodlPct: best.lpVsHodlPct, hardcoded5pctLpVsHodlPct: w5 ? w5.lpVsHodlPct : null, maxGainOverHardcodedPct: w5 ? round(best.lpVsHodlPct - w5.lpVsHodlPct, 3) : null, curveSpreadPct: round(spread, 3) },
    readout:
      'This is a MEASUREMENT, not an optimiser. The "best" width above is HINDSIGHT and is not reachable: on 211k real swaps ' +
      'across two windows 18 months apart, vol-fitted width beat a constant calibrated once offline by +0.24pp in one window ' +
      'and −1.08pp in the other, and in one window a hardcoded ±5% band beat BOTH. Treat the sweep as evidence about this pool ' +
      'and window — not as a recommendation, and not as a claim that an optimal width is predictable.',
    limitations: [
      'Swap logs carry only AGGREGATE active liquidity, not the per-tick book (that needs a Mint/Burn replay), so fee share is correct while your range covers the active tick and OVERSTATES narrow ranges.',
      'Rebalancing is modelled as instant and costless apart from gas, which also FAVOURS narrow ranges. Both biases point the same way, and narrow ranges still lose.',
      'Valid for RELATIVE ranking at small size. It is NOT absolute LP PnL at size: your own liquidity would change the pool, and no backtest gives that counterfactual.',
      'Single window. Out-of-sample transfer of any width choice was measured and FAILED (a 15% width calibrated on one window scored −3.35% on the other, where the oracle was +2.82%).',
    ],
    elapsedMs: Date.now() - t0,
  };
}
