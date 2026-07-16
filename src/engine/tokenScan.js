// Token Volume Authenticity Scan.
// Question answered: what share of this token's recent DEX volume is organic vs manufactured?
// Method: per-wallet aggregation of the recent tape (round-trip churn, machine cadence,
// ping-pong alternation, volume concentration) cross-referenced with OKX holder-cluster
// funding priors. Every verdict ships evidence (tx hashes + wallets) and honest confidence.
import * as data from '../adapters/data.js';
import { hhi, gapCv, clamp01, round } from './stats.js';
import { config } from '../config.js';

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

function aggregateWallets(trades) {
  const wallets = new Map();
  for (const t of trades) {
    const w = t.userAddress;
    if (!w) continue;
    let rec = wallets.get(w);
    if (!rec) {
      rec = { address: w, buyVol: 0, sellVol: 0, buys: 0, sells: 0, times: [], seq: [], txs: [] };
      wallets.set(w, rec);
    }
    const vol = num(t.volume) || 0;
    const time = num(t.time) || 0;
    if (t.type === 'buy') { rec.buyVol += vol; rec.buys += 1; } else { rec.sellVol += vol; rec.sells += 1; }
    rec.times.push(time);
    rec.seq.push(t.type === 'buy' ? 'B' : 'S');
    const hash = t.txHashUrl || t.txHash || null;
    // One on-chain tx can emit several trade rows (multi-hop routing); keep hashes unique.
    if (hash && rec.txs.length < 8 && !rec.txs.includes(hash)) rec.txs.push(hash);
  }
  return [...wallets.values()];
}

function walletSignals(rec) {
  const total = rec.buyVol + rec.sellVol;
  const roundTrip = total > 0 ? Math.min(rec.buyVol, rec.sellVol) / Math.max(rec.buyVol, rec.sellVol, 1e-9) : 0;
  const churner = roundTrip > 0.75 && rec.buys + rec.sells >= 4;
  const cv = gapCv(rec.times);
  const botCadence = cv !== null && cv < 0.35 && rec.times.length >= 6;
  // Ping-pong: alternation rate of the buy/sell sequence (1 = strict B/S/B/S).
  let alternations = 0;
  for (let i = 1; i < rec.seq.length; i++) if (rec.seq[i] !== rec.seq[i - 1]) alternations += 1;
  const alternationRate = rec.seq.length > 1 ? alternations / (rec.seq.length - 1) : 0;
  const pingPong = alternationRate > 0.8 && rec.seq.length >= 6;
  return { ...rec, total, roundTrip, churner, cv, botCadence, alternationRate, pingPong };
}

export async function tokenScan(chain, address) {
  const t0 = Date.now();
  const [tapeRaw, price, cluster, adv] = await Promise.allSettled([
    data.trades(chain, address, config.tapeLimit),
    data.priceInfo(chain, address),
    data.clusterOverview(chain, address),
    data.advancedInfo(chain, address),
  ]);

  const tape = tapeRaw.status === 'fulfilled' ? (Array.isArray(tapeRaw.value) ? tapeRaw.value : tapeRaw.value?.list || []) : [];
  if (!tape.length) {
    return {
      service: 'token-scan', version: config.version, chain, token: address,
      verdict: 'INSUFFICIENT_DATA', riskScore: null, authenticityScore: null, estimatedWashVolumeShare: null, confidence: 0,
      note: 'No recent DEX tape available for this token on this chain.',
      dataWindow: null, signals: [], evidence: [],
    };
  }

  const priceInfo = price.status === 'fulfilled' ? (Array.isArray(price.value) ? price.value[0] : price.value) : {};
  const clusterInfo = cluster.status === 'fulfilled' ? (Array.isArray(cluster.value) ? cluster.value[0] : cluster.value) : {};
  const advInfo = adv.status === 'fulfilled' ? (Array.isArray(adv.value) ? adv.value[0] : adv.value) : {};

  // Not-applicable guard: some tokens are dominated by legitimate two-sided flow that mimics
  // the wash signature — refuse rather than emit a false "X% wash".
  //  (a) tokenized equities / ETFs: regulated market-making, round-trips are real;
  //  (b) CEX-listed / community-recognized majors and >$100M caps: legitimate HFT/arbitrage.
  const marketCap = num(priceInfo.marketCap ?? advInfo.marketCap);
  const stock = advInfo.stockProfile || priceInfo.stockProfile;
  const isTokenizedSecurity = !!(stock && (stock.stockCode || stock.companyName || stock.stockType));
  const communityRecognized = priceInfo.tagList?.communityRecognized === true
    || advInfo.tagList?.communityRecognized === true
    || (Array.isArray(advInfo.tokenTags) && advInfo.tokenTags.includes('communityRecognized'));
  if (isTokenizedSecurity || communityRecognized || (marketCap !== null && marketCap > 100_000_000)) {
    const why = isTokenizedSecurity
      ? `This is a tokenized security (${stock.companyName || stock.stockCode || 'listed equity/ETF'}${stock.stockType ? `, ${stock.stockType}` : ''}). Its two-sided flow is regulated market-making, not manufactured volume, so authenticity scoring does not apply.`
      : 'Deep-liquidity / CEX-listed token: volume is dominated by legitimate market makers and arbitrage, so volume-authenticity scoring does not apply. This scan targets low/mid-cap DEX tokens where manufactured volume is the concern.';
    return {
      service: 'token-scan', version: config.version, chain, token: address,
      tokenSymbol: priceInfo.tokenSymbol || advInfo.tokenSymbol || null,
      verdict: 'NOT_APPLICABLE', riskScore: null, authenticityScore: null, estimatedWashVolumeShare: null, confidence: 0,
      note: why,
      signals: [
        { key: 'tokenizedSecurity', value: isTokenizedSecurity },
        { key: 'marketCapUsd', value: marketCap },
        { key: 'communityRecognized', value: communityRecognized },
      ],
      evidence: [], dataWindow: null,
      limitations: 'Authenticity scoring is calibrated for low/mid-cap DEX tokens, not blue-chips or tokenized securities.',
      notAdvice: 'Informational analysis of public on-chain data. Not financial advice or an accusation against any party.',
    };
  }

  const wallets = aggregateWallets(tape).map(walletSignals).sort((a, b) => b.total - a.total);
  const tapeVolume = wallets.reduce((a, w) => a + w.total, 0);
  const times = tape.map((t) => num(t.time)).filter(Boolean);
  const windowMs = times.length ? Math.max(...times) - Math.min(...times) : 0;

  // D1 concentration: share of tape volume from top-5 wallets + HHI.
  const top5Share = tapeVolume > 0 ? wallets.slice(0, 5).reduce((a, w) => a + w.total, 0) / tapeVolume : 0;
  const concentration = hhi(wallets.map((w) => w.total));

  // D2 churn: volume share from round-trip wallets.
  const churners = wallets.filter((w) => w.churner);
  const churnShare = tapeVolume > 0 ? churners.reduce((a, w) => a + w.total, 0) / tapeVolume : 0;

  // D3 machine cadence share.
  const botWallets = wallets.filter((w) => w.botCadence);
  const botShare = tapeVolume > 0 ? botWallets.reduce((a, w) => a + w.total, 0) / tapeVolume : 0;

  // D4 ping-pong share.
  const pingPongers = wallets.filter((w) => w.pingPong);
  const pingPongShare = tapeVolume > 0 ? pingPongers.reduce((a, w) => a + w.total, 0) / tapeVolume : 0;

  // --- Per-token economic signals (aggregates the caller cannot fake) ---
  const volume24 = num(priceInfo.volume24H ?? priceInfo.volume24h ?? priceInfo.volume);
  const liquidity = num(priceInfo.liquidity);
  const holders = num(priceInfo.holders);
  const txs24 = num(priceInfo.txs24H ?? priceInfo.txs ?? priceInfo.txCount24h);
  const suspiciousPct = num(advInfo.suspiciousHoldingPercent ?? advInfo.suspiciousHoldPercent);
  const bundlePct = num(advInfo.bundleHoldingPercent ?? advInfo.bundleHoldPercent);
  const sniperPct = num(advInfo.sniperHoldingPercent);

  const tpm = windowMs > 0 ? tape.length / (windowMs / 60000) : null;                        // trade velocity
  const turnover = volume24 && liquidity && liquidity > 5000 ? volume24 / liquidity : null;   // volume ÷ liquidity
  const turnoverMc = volume24 && marketCap ? volume24 / marketCap : null;

  // Normalize each signal to 0..1 (higher = more manipulation-like). Honest heuristics: legit
  // active DEX tokens rarely exceed these, but none is dispositive on its own.
  const ramp = (x, lo, hi) => (x == null ? null : clamp01((x - lo) / (hi - lo)));
  const sVelocity = ramp(tpm, 180, 460);
  const sTurnover = ramp(turnover, 40, 200);
  const sTurnoverMc = ramp(turnoverMc, 40, 250);
  const sRoundTrip = clamp01(churnShare * (churners.length >= 10 ? 1 : 0.6));
  const sHolderRisk = clamp01(((suspiciousPct || 0) + (bundlePct || 0) * 0.5 + (sniperPct || 0) * 0.5) / 60);

  const sig = [
    { key: 'tradeVelocityPerMin', value: round(tpm), score: sVelocity, weight: 0.32 },
    { key: 'volumeToLiquidity', value: round(turnover, 1), score: sTurnover, weight: 0.28 },
    { key: 'volumeToMarketCap', value: round(turnoverMc, 1), score: sTurnoverMc, weight: 0.12 },
    { key: 'tapeRoundTripShare', value: round(churnShare), score: sRoundTrip, weight: 0.18, note: `${churners.length} wallets round-tripping in a ${round(windowMs / 60000, 1)}-min window` },
    { key: 'suspiciousHolderShare', value: round(sHolderRisk, 2), score: sHolderRisk, weight: 0.10 },
  ];
  const active = sig.filter((s) => s.score != null);
  const wsum = active.reduce((a, s) => a + s.weight, 0) || 1;
  let risk = active.reduce((a, s) => a + s.score * s.weight, 0) / wsum;
  const elevated = active.filter((s) => s.score >= 0.5).length;

  // Extreme-velocity override: no legitimate token sustains 300+ trades/min of balanced churn.
  const extremeChurn = tpm != null && tpm > 300 && churnShare > 0.8;
  if (extremeChurn) risk = Math.max(risk, 0.75);

  const riskScore = Math.round(clamp01(risk) * 100);
  const authenticityScore = 100 - riskScore;
  const verdict = riskScore >= 65 && (elevated >= 2 || extremeChurn) ? 'HIGH_RISK'
    : riskScore >= 35 ? 'ELEVATED'
    : 'ORGANIC';

  // Only quote a manufactured-volume share on strong, corroborated tape evidence; else null —
  // we will not fabricate a precise percentage the data cannot support.
  const estimatedWashVolumeShare = verdict === 'HIGH_RISK' && extremeChurn ? round(Math.max(churnShare, 0.6)) : null;

  let confidence = 0.35;
  if (volume24 && liquidity) confidence += 0.2;
  if (tape.length >= 400) confidence += 0.15;
  if (elevated >= 2) confidence += 0.15;
  if (active.length <= 1) confidence -= 0.15;
  confidence = round(clamp01(confidence), 2);

  const evidence = [...churners.slice(0, 4), ...pingPongers.filter((w) => !w.churner).slice(0, 2)].slice(0, 5).map((w) => ({
    wallet: w.address,
    pattern: [w.churner ? 'round-trip churn' : null, w.pingPong ? 'buy/sell ping-pong' : null, w.botCadence ? 'machine cadence' : null].filter(Boolean).join(' + ') || 'two-sided',
    buyVolumeUsd: round(w.buyVol), sellVolumeUsd: round(w.sellVol),
    trades: w.buys + w.sells,
    roundTripRatio: round(w.roundTrip),
    sampleTxs: w.txs.filter(Boolean).slice(0, 3),
  }));

  return {
    service: 'token-scan',
    version: config.version,
    chain, token: address,
    tokenSymbol: priceInfo.tokenSymbol || advInfo.tokenSymbol || null,
    verdict,
    riskScore,
    authenticityScore,
    estimatedWashVolumeShare,
    confidence,
    signals: sig.map((s) => ({ key: s.key, value: s.value, elevated: s.score != null && s.score >= 0.5, note: s.note })),
    evidence,
    dataWindow: {
      recentTrades: tape.length,
      uniqueWalletsInWindow: wallets.length,
      windowMinutes: round(windowMs / 60000, 1),
      tapeVolumeUsd: round(tapeVolume),
      volume24hUsd: round(volume24), liquidityUsd: round(liquidity), holders, txs24h: txs24,
    },
    method: 'Blends per-token economic signals (trade velocity, volume-to-liquidity turnover, volume-to-market-cap) with recent-tape forensics (wallets round-tripping balanced buy/sell volume) into a manipulation-risk score; every flagged wallet carries evidence transaction hashes.',
    limitations: 'Scored from the most recent ~500 DEX trades plus 24h aggregate stats: it flags trading PATTERNS consistent with manufactured volume and cannot certify an exact fake-volume percentage without full trader-level history. High-frequency market-making can raise turnover without being manipulative; treat ELEVATED as "inspect the evidence", not proof.',
    notAdvice: 'Informational analysis of public on-chain data. Risk levels describe trading patterns, not a legal determination or an accusation against any identified person.',
    elapsedMs: Date.now() - t0,
  };
}
