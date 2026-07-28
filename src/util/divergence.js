// divergence.js: multi-source divergence DISCLOSURE.
//
// WHAT THIS IS. Several of Quiver's inputs are available from more than one venue. This module fetches
// them, measures how far apart they are, and publishes that number as a sibling field on the envelope.
//
// WHAT THIS IS NOT, and the reason every function below is written defensively: it is not an
// attestation, and a small divergence is not evidence that anybody is telling the truth. Independent
// venues agreeing to a few basis points is the NORMAL state of a liquid market, so an adversary who
// wants to move a mark by less than the honest disagreement band is invisible here by construction.
// PHASE_D_RESEARCH.md §3.5 measured that band once, over four rounds of nine sources, and got a full
// spread of 10.8 bps. This module does not repeat that number: it carries its own calibration, taken
// over hundreds of rounds by `gates/calibrate-divergence.mjs`, which imports THESE readers so the
// floor belongs to the code that enforces it rather than to a probe that suggested it.
//
// Three refusals are load-bearing and each one has a test that can fail:
//   1. fewer than two successful reads          -> REFUSED, and no numbers at all
//   2. fewer than two distinct HOSTS            -> REFUSED. Two fields out of one HTTP response are
//                                                  one source wearing two hats.
//   3. no calibrated floor for this symbol      -> REFUSED. A verdict without a floor is a vibe.
//
// Reporting `spreadBps: 0` for a single source would read as perfect agreement, which is the exact
// overstatement this module exists to prevent. So it reports nothing instead.
//
// Nothing here touches src/engine/. The disclosure is attached BESIDE `proof` / `observation` by
// `attachSibling()` in inputClaims.js, never inside them, so the committed content hash never moves.

const UA = { accept: 'application/json' };
const J = async (url, init = {}, timeoutMs = 12000) => {
  const t0 = Date.now();
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${new URL(url).host} -> HTTP ${r.status}`);
  return { body: await r.json(), ms: Date.now() - t0 };
};

const num = (x) => {
  const v = Number(x);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/* ───────────────────────────── the source register ─────────────────────────────
 *
 * Every source names the host it comes from, because the host is what decides independence, and the
 * basis it quotes, because a USDT-quoted price and a USD-quoted price differ by the stablecoin basis
 * for honest reasons that have nothing to do with anybody lying. `usedByQuiver` separates sources the
 * service already depends on from corroborators added only for this cross-check: adding a host adds a
 * failure mode, and a reader deserves to know which is which.
 */
// `quote` and `quantity` are separate fields, and the first draft conflated them into one `basis`
// string. Comparing that string flagged "USD perp mark vs USD index" as a stablecoin-basis pair,
// which is not what a basis is, and the disclosure's own limits text then described 13 of 15 BTC
// pairs wrongly. Measured consequence of getting it right: okx_index against deribit_index, same
// quote and same quantity, sits at a median 0.26 bps, while okx_spot against okx_index, same host and
// same instant but USDT against USD, sits at 11.1 bps. The basis is the larger effect of the two.
export const SOURCES = {
  hyperliquid_mark:   { host: 'api.hyperliquid.xyz', fetcher: 'hyperliquid', quote: 'USD',  quantity: 'perp mark', usedByQuiver: true,  note: 'the value perp-gate and portfolio-gate consume' },
  hyperliquid_oracle: { host: 'api.hyperliquid.xyz', fetcher: 'hyperliquid', quote: 'USD',  quantity: 'oracle',    usedByQuiver: true,  note: 'same HTTP response as hyperliquid_mark, therefore not independent of it' },
  dydx_oracle:        { host: 'indexer.dydx.trade',  fetcher: 'dydx',        quote: 'USD',  quantity: 'oracle',    usedByQuiver: true,  note: 'the indexer value perp-gate consumes for dYdX symbols' },
  okx_index:          { host: 'www.okx.com',         fetcher: 'okx',         quote: 'USD',  quantity: 'index',     usedByQuiver: true,  note: 'same host as the candles chart-press reads' },
  okx_spot:           { host: 'www.okx.com',         fetcher: 'okx',         quote: 'USDT', quantity: 'spot',      usedByQuiver: true,  note: 'the only USDT-quoted source here; it carries the stablecoin basis against every other one, permanently and honestly' },
  deribit_index:      { host: 'www.deribit.com',     fetcher: 'deribit',     quote: 'USD',  quantity: 'index',     usedByQuiver: true,  note: 'the host options-desk reads' },
  coinbase_spot:      { host: 'api.coinbase.com',    fetcher: 'coinbase',    quote: 'USD',  quantity: 'spot',      usedByQuiver: false, note: 'corroborator only; Quiver does not otherwise contact this host' },
  kraken_spot:        { host: 'api.kraken.com',      fetcher: 'kraken',      quote: 'USD',  quantity: 'spot',      usedByQuiver: false, note: 'corroborator only; Quiver does not otherwise contact this host' },
};

/** Human label, derived so the two facts cannot drift apart. */
export const basisOf = (s) => `${SOURCES[s].quote} ${SOURCES[s].quantity}`;

/** The sources Quiver already depends on. The default, because a disclosure should not invent dependencies. */
export const NATIVE_SOURCES = Object.keys(SOURCES).filter((s) => SOURCES[s].usedByQuiver);
export const ALL_SOURCES = Object.keys(SOURCES);

// Symbol spellings per host. A symbol missing here is REFUSED rather than guessed at: guessing a
// ticker is how you end up measuring the divergence between BTC and something that is not BTC.
const TICKERS = {
  BTC: { hyperliquid: 'BTC', dydx: 'BTC-USD', okxSpot: 'BTC-USDT', okxIndex: 'BTC-USD', deribit: 'btc_usd', coinbase: 'BTC-USD', kraken: 'XBTUSD' },
  ETH: { hyperliquid: 'ETH', dydx: 'ETH-USD', okxSpot: 'ETH-USDT', okxIndex: 'ETH-USD', deribit: 'eth_usd', coinbase: 'ETH-USD', kraken: 'ETHUSD' },
  SOL: { hyperliquid: 'SOL', dydx: 'SOL-USD', okxSpot: 'SOL-USDT', okxIndex: 'SOL-USD', deribit: 'sol_usd', coinbase: 'SOL-USD', kraken: 'SOLUSD' },
};
export const SUPPORTED_SYMBOLS = Object.keys(TICKERS);

/* ───────────────────────────── the readers ─────────────────────────────
 *
 * One fetcher per HOST, not per source, so that two readings taken out of a single response are
 * structurally marked as one fetch. That is not a nicety: hyperliquid_mark and hyperliquid_oracle
 * arriving in the same JSON body is precisely why they must never be counted as two opinions.
 */
export const FETCHERS = {
  async hyperliquid(sym, { timeoutMs } = {}) {
    const { body, ms } = await J('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    }, timeoutMs);
    const [meta, ctxs] = body;
    const i = meta.universe.findIndex((u) => u.name === TICKERS[sym].hyperliquid);
    if (i < 0) throw new Error(`hyperliquid has no perp named ${TICKERS[sym].hyperliquid}`);
    return [
      { source: 'hyperliquid_mark', value: num(ctxs[i].markPx), ms },
      { source: 'hyperliquid_oracle', value: num(ctxs[i].oraclePx), ms },
    ];
  },
  async dydx(sym, { timeoutMs } = {}) {
    const { body, ms } = await J('https://indexer.dydx.trade/v4/perpetualMarkets', {}, timeoutMs);
    const m = body.markets?.[TICKERS[sym].dydx];
    if (!m) throw new Error(`dydx has no market ${TICKERS[sym].dydx}`);
    return [{ source: 'dydx_oracle', value: num(m.oraclePrice), ms }];
  },
  async okx(sym, { timeoutMs } = {}) {
    const t = TICKERS[sym];
    const [spot, index] = await Promise.all([
      J(`https://www.okx.com/api/v5/market/ticker?instId=${t.okxSpot}`, {}, timeoutMs),
      J(`https://www.okx.com/api/v5/market/index-tickers?instId=${t.okxIndex}`, {}, timeoutMs),
    ]);
    if (spot.body.code !== '0') throw new Error(`okx ticker code ${spot.body.code}`);
    if (index.body.code !== '0') throw new Error(`okx index code ${index.body.code}`);
    return [
      { source: 'okx_spot', value: num(spot.body.data?.[0]?.last), ms: spot.ms },
      { source: 'okx_index', value: num(index.body.data?.[0]?.idxPx), ms: index.ms },
    ];
  },
  async deribit(sym, { timeoutMs } = {}) {
    const { body, ms } = await J(`https://www.deribit.com/api/v2/public/get_index_price?index_name=${TICKERS[sym].deribit}`, {}, timeoutMs);
    return [{ source: 'deribit_index', value: num(body.result?.index_price), ms }];
  },
  async coinbase(sym, { timeoutMs } = {}) {
    const { body, ms } = await J(`https://api.coinbase.com/v2/prices/${TICKERS[sym].coinbase}/spot`, {}, timeoutMs);
    return [{ source: 'coinbase_spot', value: num(body.data?.amount), ms }];
  },
  async kraken(sym, { timeoutMs } = {}) {
    const { body, ms } = await J(`https://api.kraken.com/0/public/Ticker?pair=${TICKERS[sym].kraken}`, {}, timeoutMs);
    const k = Object.keys(body.result || {})[0];
    if (!k) throw new Error(`kraken returned no pair for ${TICKERS[sym].kraken}: ${JSON.stringify(body.error || []).slice(0, 80)}`);
    return [{ source: 'kraken_spot', value: num(body.result[k].c?.[0]), ms }];
  },
};

/**
 * Read one quantity from several sources concurrently. Never throws for an unreachable source: a
 * source that is down is DATA, and pretending otherwise would turn an outage into a divergence.
 */
export async function readSources(symbol, { sources = NATIVE_SOURCES, timeoutMs = 12000, fetchers = FETCHERS } = {}) {
  if (!TICKERS[symbol]) return { readings: [], failed: [{ source: '*', error: `no ticker mapping for ${symbol}` }] };
  const wanted = new Set(sources);
  const hosts = [...new Set([...wanted].map((s) => SOURCES[s]?.fetcher).filter(Boolean))];
  const results = await Promise.all(hosts.map(async (h) => {
    try { return { h, out: await fetchers[h](symbol, { timeoutMs }) }; }
    catch (e) { return { h, err: String(e.message || e).slice(0, 160) }; }
  }));
  const readings = [], failed = [];
  for (const r of results) {
    if (r.err) {
      for (const s of wanted) if (SOURCES[s].fetcher === r.h) failed.push({ source: s, error: r.err });
      continue;
    }
    for (const x of r.out) {
      if (!wanted.has(x.source)) continue;
      if (x.value === null) failed.push({ source: x.source, error: 'source returned a non-positive or unparseable value' });
      else readings.push({ ...x, host: SOURCES[x.source].host, quote: SOURCES[x.source].quote, quantity: SOURCES[x.source].quantity, basis: basisOf(x.source) });
    }
  }
  return { readings, failed };
}

/* ───────────────────────────── the arithmetic ───────────────────────────── */

export const bpsBetween = (a, b) => (10000 * Math.abs(a - b)) / ((a + b) / 2);
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Pure. Given readings, produce the pairwise table and the two spreads.
 *
 * `spreadBps` counts every reading, `independentSpreadBps` collapses each host to its own median
 * first. The second is the honest headline: it answers "how much do independent parties disagree",
 * which is not the same question as "how much do these eight numbers vary" when three of the eight
 * came out of two HTTP responses.
 */
export function measure(readings) {
  const vals = readings.map((r) => r.value);
  const med = median(vals);
  const pairs = [];
  for (let i = 0; i < readings.length; i++) {
    for (let k = i + 1; k < readings.length; k++) {
      pairs.push({
        a: readings[i].source, b: readings[k].source,
        bps: bpsBetween(readings[i].value, readings[k].value),
        sameHost: readings[i].host === readings[k].host,
        sameQuote: readings[i].quote === readings[k].quote,
        sameQuantity: readings[i].quantity === readings[k].quantity,
      });
    }
  }
  const byHost = new Map();
  for (const r of readings) { if (!byHost.has(r.host)) byHost.set(r.host, []); byHost.get(r.host).push(r.value); }
  const hostMedians = [...byHost.entries()].map(([host, v]) => ({ host, value: median(v) }));
  const spread = (xs) => (xs.length < 2 ? 0 : (10000 * (Math.max(...xs) - Math.min(...xs))) / median(xs));
  return {
    medianValue: med,
    spreadBps: spread(vals),
    independentSpreadBps: spread(hostMedians.map((h) => h.value)),
    hostMedians,
    hosts: hostMedians.length,
    pairs,
  };
}

/* ───────────────────────────── the calibrated floor ─────────────────────────────
 *
 * A floor is a claim about what honest disagreement looks like, so it is a measurement, never a
 * constant somebody liked. FLOOR is written by `gates/calibrate-divergence.mjs`, which runs the
 * readers above over many rounds and reports the distribution. An uncalibrated symbol is REFUSED.
 *
 * The statistic is the p95 of the independent headline spread. p95 rather than max because a max over
 * a few hundred rounds is one outlier's opinion, and rather than median because a floor that half the
 * honest samples exceed would fire constantly. It is deliberately a FLOOR ON DETECTION, not a
 * threshold for action: below it, a fabrication is invisible; above it, something moved and this
 * method cannot say which source moved or why.
 */
export const FLOOR = {
  _meta: {
    measuredOnUtc: '2026-07-28T13:17:52.207Z',
    script: 'gates/calibrate-divergence.mjs',
    statistic: 'p95 of independentSpreadBps across rounds',
    campaign: '340 rounds at 3.5 s, cycling BTC/BTC/ETH/SOL, so 170 BTC and 85 each of ETH and SOL',
    artifact: 'gates/divergence-calibration.json, and gateDiv-disclosure.mjs asserts these numbers still match it',
    note:
      'floorBps is what honest sources do. The three detection figures are what a LIE has to beat, and '
      + 'they are the numbers that matter: cheapest is the most favourable source for an adversary, '
      + 'hardest is the size at which a fabrication is caught whatever direction it takes, and '
      + 'spreadReducingMaxBps is the largest fabrication measured that left the sources looking MORE '
      + 'agreed than the truth did.',
  },
  // floorBps            p95 of the independent headline spread
  // cheapestDetectionBps  smallest median lie, over sources, that this check could see at all
  // hardestDetectionBps   largest median lie needed, over sources and directions, before it is certain to show
  // spreadReducingMaxBps  largest fabrication observed that did NOT increase the reported spread
  BTC: {
    native: { floorBps: 11.6,  rounds: 170, cheapestDetectionBps: 2.42, hardestDetectionBps: 30.30, spreadReducingMaxBps: 43.50 },
    all:    { floorBps: 15.88, rounds: 170, cheapestDetectionBps: 5.65, hardestDetectionBps: 38.83, spreadReducingMaxBps: 56.25 },
  },
  ETH: {
    native: { floorBps: 11.95, rounds: 85, cheapestDetectionBps: 3.74,  hardestDetectionBps: 29.73, spreadReducingMaxBps: 44.00 },
    all:    { floorBps: 19.63, rounds: 85, cheapestDetectionBps: 11.05, hardestDetectionBps: 45.01, spreadReducingMaxBps: 60.00 },
  },
  SOL: {
    native: { floorBps: 11.25, rounds: 85, cheapestDetectionBps: 3.69, hardestDetectionBps: 27.95, spreadReducingMaxBps: 41.00 },
    all:    { floorBps: 13.23, rounds: 85, cheapestDetectionBps: 5.24, hardestDetectionBps: 31.64, spreadReducingMaxBps: 53.25 },
  },
};

export function floorFor(symbol, sourceSet = 'native') {
  const s = FLOOR[symbol];
  if (!s) return null;
  return s[sourceSet] || null;
}

/* ───────────────────────────── the disclosure ───────────────────────────── */

export const REFUSALS = {
  NO_SOURCES: 'no source returned a usable value, so there is nothing to compare',
  SINGLE_SOURCE: 'only one source returned a value. A spread computed over one number is zero, and publishing zero here would read as agreement. Nothing is reported.',
  SINGLE_HOST: 'every reading came from one host. Two fields out of one HTTP response are one source, and reporting their difference as multi-source agreement would be false.',
  UNCALIBRATED: 'no measured honest-disagreement floor exists for this symbol and source set, so no verdict can be given. A verdict without a floor asserts a detection capability that has not been measured.',
};

// The wording that must never appear next to a divergence number, and the reason this module has a
// test that greps its own output for it. These are the words a reader converts into "the number is
// right", which divergence can never support.
export const FORBIDDEN_CLAIM_WORDS = [
  'attested', 'attestation', 'verified', 'proven', 'proof of correctness',
  'confirms', 'confirmed', 'guarantees', 'guaranteed', 'authentic', 'certified',
];

/**
 * Build the sibling field. Returns a REFUSED object or a DISCLOSED object; never throws for missing
 * data, and never returns a spread it is not entitled to.
 */
export function buildDisclosure({ symbol, quantity = 'USD price', readings = [], failed = [], sourceSet = 'native', calibration = FLOOR, observedAtUtc = new Date().toISOString() }) {
  const base = {
    kind: 'DIVERGENCE_DISCLOSURE',
    isAttestation: false,
    confirmsCorrectness: false,
    symbol, quantity, observedAtUtc,
    sourcesAttempted: readings.length + failed.length,
    sourcesRead: readings.length,
    unavailable: failed,
    provesNothing:
      'Divergence measures how far apart sources are. It does not establish that any of them is right. '
      + 'All of these are unsigned HTTPS reads terminating at Quiver, so a single adversary at that edge sees every one of them.',
  };
  if (readings.length === 0) return { ...base, status: 'REFUSED', reason: REFUSALS.NO_SOURCES };
  if (readings.length === 1) return { ...base, status: 'REFUSED', reason: REFUSALS.SINGLE_SOURCE, sole: readings[0].source };
  const m = measure(readings);
  if (m.hosts < 2) return { ...base, status: 'REFUSED', reason: REFUSALS.SINGLE_HOST, host: readings[0].host };

  const cal = (calibration?.[symbol] || {})[sourceSet] || null;
  if (!cal || !Number.isFinite(cal.floorBps)) {
    return { ...base, status: 'REFUSED', reason: REFUSALS.UNCALIBRATED, sourceSet };
  }

  const headline = m.independentSpreadBps;
  const within = headline <= cal.floorBps;
  return {
    ...base,
    status: 'DISCLOSED',
    sources: readings.map((r) => ({ source: r.source, host: r.host, quote: r.quote, quantity: r.quantity, basis: r.basis, value: r.value, latencyMs: r.ms })),
    independentHosts: m.hosts,
    medianValue: m.medianValue,
    spreadBps: round4(m.spreadBps),
    independentSpreadBps: round4(headline),
    spreadDefinition: 'independentSpreadBps = 10000 x (max - min) / median, taken over ONE median value per host. spreadBps is the same figure over every individual reading, and is the larger of the two only because correlated readings from one host are counted twice.',
    detectionFloorBps: cal.floorBps,
    // The three numbers that stop the floor being read as a detection guarantee. Measured, per source
    // and per direction, by bending one live reading at a time until the headline spread crosses the
    // floor. They are worse than the floor, and the third one is worse than "worse".
    detection: {
      cheapestFabricationBps: cal.cheapestDetectionBps,
      cheapestMeaning: `The most exposed source still needs to lie by about ${cal.cheapestDetectionBps} bps before this check moves at all. Anything smaller, on any source, is invisible.`,
      guaranteedCatchBps: cal.hardestDetectionBps,
      guaranteedMeaning: `An adversary chooses the source and the direction. Across every source and both directions, a fabrication is only certain to show once it reaches about ${cal.hardestDetectionBps} bps, which is ${(cal.hardestDetectionBps / cal.floorBps).toFixed(1)}x the floor.`,
      spreadReducingMaxBps: cal.spreadReducingMaxBps,
      spreadReducingMeaning: `Worse than invisible: a fabrication of up to about ${cal.spreadReducingMaxBps} bps was measured to LOWER the reported spread, so the sources look more agreed after the lie than before it. A small divergence number is therefore not even weak evidence of honesty.`,
    },
    floorProvenance: {
      statistic: calibration._meta.statistic,
      measuredOnUtc: calibration._meta.measuredOnUtc,
      rounds: cal.rounds,
      script: calibration._meta.script,
      meaning: `A fabrication smaller than ${cal.floorBps} bps on any single source is INVISIBLE to this check, because honest sources disagree by about that much anyway.`,
    },
    verdict: within ? 'WITHIN_FLOOR' : 'ABOVE_FLOOR',
    meaning: within
      ? `The sources disagree by ${round4(headline)} bps, at or below the measured honest floor of ${cal.floorBps} bps. This says NOTHING about whether the number is correct: it says only that no disagreement large enough to see was present.`
      : `The sources disagree by ${round4(headline)} bps, above the measured honest floor of ${cal.floorBps} bps. Something moved. This check cannot say which source is wrong, or whether any of them is: a genuine market dislocation looks identical.`,
    pairs: m.pairs.map((p) => ({ ...p, bps: round4(p.bps) })),
    limits: [
      'This is a disclosure, not an attestation. It is not a T1 signature, not a consensus read, and not a state proof.',
      'Every reading is unsigned HTTPS terminating at Quiver. One adversary positioned there sees and can alter all of them together.',
      'Agreement between sources is not correctness. These venues quote overlapping order flow and can be wrong together.',
      'Pairs marked sameHost:true arrived in one response and are not independent evidence of anything.',
      'Pairs marked sameQuote:false compare a USDT-quoted price against a USD-quoted one. The stablecoin basis is an honest, permanent component of that number and it is the LARGEST single term here: measured over 170 rounds, okx_spot against okx_index, same host and same instant, sits at a median 11.1 bps purely because one is USDT and the other USD.',
      'Pairs marked sameQuantity:false compare different constructions (a perp mark against an index against a spot print). Those differ for structural reasons too, and neither difference is evidence of anybody lying.',
      'The floor is historical. In a dislocation, honest divergence exceeds it and this check reports ABOVE_FLOOR for reasons that have nothing to do with fabrication.',
      `A LOW spread is not reassurance. Measured on live data, a fabrication of up to ${cal.spreadReducingMaxBps} bps on a single source made this number SMALLER, not larger.`,
      'Adding more sources widens the floor rather than narrowing it, because the headline is a range over independent opinions. Measured: the six-host set floors at 15.88 bps against 11.6 bps for the four-host set on BTC. More corroboration buys less sensitivity, not more.',
    ],
  };
}

const round4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : x);

/** Convenience: fetch and disclose in one call. */
export async function discloseDivergence({ symbol, quantity, sources = NATIVE_SOURCES, sourceSet = 'native', timeoutMs = 12000, fetchers = FETCHERS, calibration = FLOOR } = {}) {
  const { readings, failed } = await readSources(symbol, { sources, timeoutMs, fetchers });
  return buildDisclosure({ symbol, quantity, readings, failed, sourceSet, calibration });
}
