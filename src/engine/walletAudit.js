// Wallet Track Record Audit.
// Question answered: is this wallet's visible PnL / win rate genuine skill, or
// statistically hollow / manufactured? Native OKX endpoints report the numbers;
// this audit grades their authenticity and shows its work.
import * as data from '../adapters/data.js';
import { tokenScan } from './tokenScan.js';
import { wilsonInterval, clamp01, round } from './stats.js';
import { config } from '../config.js';

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

export async function walletAudit(chain, address, deps = data) {
  const t0 = Date.now();
  const [ovRaw, ov7Raw] = await Promise.allSettled([
    deps.portfolioOverview(chain, address, 4), // 1M
    deps.portfolioOverview(chain, address, 3), // 7D
  ]);
  // A REJECTED overview fetch is an outage, not an empty track record — reporting "no trading history"
  // when the data source is down would grade a busy wallet as blank (absence-as-success).
  if (ovRaw.status === 'rejected') {
    return {
      service: 'wallet-audit', version: config.version, chain, wallet: address,
      grade: null, verdict: 'DATA_UNAVAILABLE', confidence: 0,
      note: 'The portfolio-overview fetch FAILED — this wallet\'s track record is UNKNOWN for this call, not empty. Retry.',
      components: [], evidence: [],
    };
  }
  const ov = ovRaw.value;
  if (!ov || (num(ov.buyTxCount) === null && num(ov.winRate) === null)) {
    return {
      service: 'wallet-audit', version: config.version, chain, wallet: address,
      grade: null, verdict: 'INSUFFICIENT_DATA', confidence: 0,
      note: 'The fetch succeeded and returned no usable trading history for this wallet on this chain in the last month — genuinely thin/absent record.',
      components: [], evidence: [],
    };
  }
  const ov7 = ov7Raw.status === 'fulfilled' ? ov7Raw.value : null;

  const winRate = num(ov.winRate); // percent
  const buys = num(ov.buyTxCount) || 0;
  const sells = num(ov.sellTxCount) || 0;
  const txs = buys + sells;
  // Zero real trades (the OKX overview returns 0s, not null, for an unused wallet — so the earlier
  // null-guard doesn't catch it): there is NO track record to grade. Refuse rather than emit a graded
  // UNPROVEN, which reads as "we assessed a record" when there is none.
  if (txs === 0) {
    return {
      service: 'wallet-audit', version: config.version, chain, wallet: address,
      grade: null, verdict: 'INSUFFICIENT_DATA', confidence: 0,
      note: 'The fetch succeeded but this wallet has zero DEX trades in the window — there is no track record to grade (not a failure, just an empty history).',
      components: [], evidence: [], txCount: 0,
    };
  }
  const buyVol = num(ov.buyTxVolume) || 0;
  const sellVol = num(ov.sellTxVolume) || 0;
  const pnlUsd = num(ov.realizedPnlUsd) || 0;
  const top3Pct = num(ov.top3PnlTokenPercent); // top-3 tokens' share of PnL, percent
  const byPnl = ov.tokenCountByPnlPercent || {};
  const tokenCount = ['over500Percent', 'zeroTo500Percent', 'zeroToMinus50Percent', 'overMinus50Percent']
    .reduce((a, k) => a + (num(byPnl[k]) || 0), 0);

  // --- Signal 1: statistical substance of the win rate.
  // Win rate is measured per *token position* (profitable tokens / tokens traded), so the
  // honest sample size is the number of tokens — NOT the trade count. Many txs on a handful
  // of tokens must not masquerade as a large, significant sample.
  const n = tokenCount > 0 ? tokenCount : Math.min(buys, sells);
  let winRateSignificant = null;
  let winRateInterval = null;
  if (winRate !== null && n > 0) {
    const wins = Math.round((winRate / 100) * n);
    const ci = wilsonInterval(wins, n);
    winRateInterval = { lo: round(ci.lo * 100, 1), hi: round(ci.hi * 100, 1), n };
    // The lower bound must clear a luck baseline AND rest on enough positions to mean anything.
    // A 90% win rate over 9 tokens is not skill — the interval is too wide. Memecoin outcomes are
    // also regime-correlated, so this is a luck-consistency screen, not a hard significance claim.
    winRateSignificant = ci.lo > 0.60 && n >= 12;
  }

  // --- Signal 2: churn symmetry (volume in ≈ volume out with high counts = wash-style turnover).
  const volSym = buyVol > 0 && sellVol > 0 ? Math.min(buyVol, sellVol) / Math.max(buyVol, sellVol) : 0;
  const churnFlag = volSym > 0.985 && txs >= 60;

  // --- Signal 3: PnL efficiency (profit per dollar turned over).
  const turnover = buyVol + sellVol;
  const pnlEfficiency = turnover > 0 ? pnlUsd / turnover : null; // ~0 => treadmill

  // --- Signal 4: PnL concentration (one moonshot vs consistent edge).
  const concentrationFlag = top3Pct !== null && top3Pct > 80 && tokenCount > 5;

  // --- Signal 5: consistency across windows.
  const winRate7 = ov7 ? num(ov7.winRate) : null;
  const consistency = winRate !== null && winRate7 !== null ? 1 - Math.abs(winRate - winRate7) / 100 : null;

  // --- Signal 6: is the track record BUILT ON wash-traded tokens? Cross-reference the wallet's biggest
  // winners against the manipulation scan, and — the sharp part — measure what SHARE OF ACTUAL PROFIT came
  // from tokens showing manufactured-volume patterns. Profit concentrated in wash-tokens is an unrepeatable,
  // manufactured-looking record even if the win-rate math passes. (Bounded to the top-3 winners.)
  const topTokens = (ov.topPnlTokenList || []).slice(0, 3);
  const tokenChecks = [];
  for (const t of topTokens) {
    try {
      const scan = await tokenScan(chain, t.tokenContractAddress);
      tokenChecks.push({
        token: t.tokenContractAddress, symbol: t.tokenSymbol,
        pnlUsd: round(num(t.tokenPnLUsd)),
        tokenVerdict: scan.verdict, tokenRiskScore: scan.riskScore,
      });
    } catch { /* skip on upstream failure; reflected in confidence */ }
  }
  const washy = (c) => c.tokenVerdict === 'HIGH_RISK' || c.tokenVerdict === 'ELEVATED';
  const winsOnWashTokens = tokenChecks.filter((c) => c.tokenVerdict === 'HIGH_RISK').length;
  const washProfitUsd = tokenChecks.filter(washy).reduce((a, c) => a + Math.max(0, c.pnlUsd || 0), 0);
  const topWinnersProfitUsd = tokenChecks.reduce((a, c) => a + Math.max(0, c.pnlUsd || 0), 0);
  // Share of realized profit that traces to manipulation-flagged tokens (vs total realized PnL, floored by
  // the top-winners sum so it stays meaningful when overall PnL is small/negative).
  const profitBase = Math.max(pnlUsd, topWinnersProfitUsd, 1);
  const washProfitShare = clamp01(washProfitUsd / profitBase);

  // --- Compose authenticity score (0..100, higher = more genuine).
  let score = 50;
  if (winRateSignificant === true) score += 15;
  if (winRateSignificant === false) score -= 15;
  if (churnFlag) score -= 20;
  if (pnlEfficiency !== null) score += Math.max(-15, Math.min(15, pnlEfficiency * 300)); // ±5% efficiency saturates
  if (concentrationFlag) score -= 10;
  if (consistency !== null) score += (consistency - 0.7) * 20;
  score -= winsOnWashTokens * 10;
  score -= Math.round(washProfitShare * 20); // profit sourced from manipulated tokens
  score = Math.round(Math.max(0, Math.min(100, score)));

  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  // Red flags dominate the verdict; a "genuine edge" claim requires BOTH a passing score and a
  // statistically meaningful sample, so thin records land UNPROVEN rather than overclaiming.
  const verdict =
    churnFlag || winsOnWashTokens > 0 || washProfitShare > 0.5 ? 'MANUFACTURED_SIGNS'
    : winRateSignificant === true && score >= 68 ? 'GENUINE_EDGE_LIKELY'
    : score >= 45 ? 'UNPROVEN'
    : 'STATISTICALLY_HOLLOW';

  let confidence = 0.45;
  if (txs >= 60) confidence += 0.2;
  if (tokenCount >= 5) confidence += 0.15;
  if (tokenChecks.length) confidence += 0.1;
  confidence = round(clamp01(confidence), 2);

  return {
    service: 'wallet-audit',
    version: config.version,
    chain, wallet: address,
    grade, authenticityScore: score, verdict, confidence,
    headline: {
      claimedWinRatePercent: winRate,
      winRate95ci: winRateInterval,
      realizedPnlUsd: round(pnlUsd),
      turnoverUsd: round(turnover),
      pnlPerDollarTurned: round(pnlEfficiency, 4),
      profitShareOnManufacturedTokensPct: round(washProfitShare * 100, 1),
    },
    components: [
      { key: 'winRateStatisticallySignificant', value: winRateSignificant, note: winRateInterval ? `95% CI [${winRateInterval.lo}%, ${winRateInterval.hi}%] over n=${winRateInterval.n} positions` : 'insufficient n' },
      { key: 'volumeChurnSymmetry', value: round(volSym, 3), flag: churnFlag, note: churnFlag ? `buy $${round(buyVol)} vs sell $${round(sellVol)} across ${txs} txs — treadmill pattern` : null },
      { key: 'pnlConcentrationTop3Percent', value: top3Pct, flag: concentrationFlag || null },
      { key: 'winRateConsistency7dVs30d', value: round(consistency, 2) },
      { key: 'profitShareOnManufacturedTokensPct', value: round(washProfitShare * 100, 1), flag: washProfitShare > 0.5 || null, note: `$${round(washProfitUsd)} of the wallet's top-winner profit traces to tokens flagged for manufactured volume` },
      { key: 'topWinsOnManufacturedTokens', value: winsOnWashTokens, detail: tokenChecks },
    ],
    evidence: tokenChecks,
    method: 'luck-consistency of claimed win rate (Wilson interval over token positions); volume-churn symmetry; PnL efficiency & concentration; cross-window consistency; and — the authenticity cross-check — the SHARE of realized profit that traces to tokens flagged for manufactured volume (top winners run through the wash-scan)',
    limitations: 'Based on the last 90 days of DEX portfolio data (the deepest window available per query). Win-rate is judged over token positions, and memecoin outcomes are regime-correlated, so this is a luck-consistency screen, not a hard significance claim. Exit-flow attribution is limited to what recent tape covers.',
    notAdvice: 'Informational analysis of public on-chain data. A low grade means the visible track record is not statistically substantiated or overlaps manufactured-volume tokens — not an accusation against any identified person. Not financial advice.',
    elapsedMs: Date.now() - t0,
  };
}
