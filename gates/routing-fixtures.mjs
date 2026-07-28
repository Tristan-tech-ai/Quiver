// A genuine request body for every service, and the ordered-pair sweep that uses them.
//
// WHY A FIXTURE FILE RATHER THAN GENERATED BODIES. Both existing silence sweeps synthesise a body
// from `inputSchema.required` — `{chain: 'x', address: 'x'}` and so on. That is fine for the fourteen
// services which state their requirements that way, and it is silently EMPTY for the eight which
// accept alternative forms and therefore declare `required: []`. Both sweeps then skip those eight
// with `if (!req.length) continue`, so a third of the catalogue had never been measured at all — and
// three of them were flagging their own correct calls. A generated body cannot cover a service whose
// requirements are not generatable, so the bodies are written down here instead.
//
// THE PROPERTY THAT KEEPS THIS HONEST: every body below is run through the service's OWN validate()
// before any sweep result is believed. A fixture that has drifted from the schema fails loudly rather
// than quietly measuring nonsense — which is how a coverage number becomes a fiction.
//
// One entry per accepted INPUT FORM, not one per service, because "reachable" has to mean reachable
// the way a caller would really write the call.
import { SERVICES } from '../src/services.js';
import { suggestService } from '../src/util/routing.js';

const EVM = '0x1111111111111111111111111111111111111111';

export const GENUINE = {
  'tape-pulse':     [{ chain: 'ethereum', address: EVM }],
  'chart-press':    [{ symbol: 'BTC-USDT', interval: '1H' }, { chain: 'ethereum', address: EVM, interval: '15m' }],
  'poly-fill':      [{ market: 'will-btc-hit-100k', usd: 500 }],
  'poly-desk':      [{ wallet: EVM }],
  'options-desk':   [{ currency: 'BTC' }],
  'lp-desk':        [{ pool: EVM, chain: 'ethereum', days: 2 }],
  'calldata-x':     [{ data: '0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111' }, { typedData: { domain: { name: 'Permit2' }, types: {}, message: {} }, chain: 'ethereum' }],
  'protocol-pulse': [{ protocol: 'aave' }],
  'macro-sentry':   [{ hours: 72 }, { hours: 48, spot: 60000, atmIvPct: 55 }],
  'updown-pulse':   [{ coin: 'BTC' }],
  'loop-digest':    [{ chain: 'ethereum', wallet: EVM }],
  'token-scan':     [{ chain: 'ethereum', address: EVM }],
  'wallet-audit':   [{ chain: 'ethereum', address: EVM }],
  'perp-gate':      [{ entryPrice: 60000, size: 1, margin: 6000, maintMarginRate: 0.0125 }, { symbol: 'BTC', notional: 60000, leverage: 10 }],
  'portfolio-gate': [{ positions: [{ venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 60000, leverage: 10, maxLeverage: 40 }] }, { account: EVM }],
  'size-gate':      [{ winProb: 0.55, winLossRatio: 1.2, bankroll: 10000 }, { expectedReturn: 0.02, volatility: 0.1, bankroll: 10000 }],
  'exec-verify':    [{ amountIn: 1000, amountOutRealized: 990, reserveIn: 500000, reserveOut: 500000, feeTier: 0.003 }, { amountIn: 1000, amountOutRealized: 990, fairPrice: 1.0 }],
  'options-risk':   [{ forward: 60000, positions: [{ type: 'call', strike: 62000, iv: 0.6, quantity: 1, expiryDays: 30 }] }],
  'lp-risk':        [{ priceRatio: 1.4, feeAprPct: 20 }, { volatility: 0.5, horizonPeriods: 30 }],
  'treasury-risk':  [{ positions: [{ asset: 'USDC', amountUsd: 1000000, apyPct: 4.5 }] }],
  'risk-attest':    [{ items: ['a1b2c3', 'd4e5f6'] }, { contentHashes: ['a1b2c3', 'd4e5f6'] }],
  'event-vol':      [{ spot: 60000, atmIvPct: 55, daysToEvent: 7 }],
};

// The services a body cannot single out, with the measured reason. Asserted as an EQUALITY rather
// than a floor, so this list going stale — in either direction — is itself a gate failure.
//
//   macro-sentry   validate() never refuses: every field defaults, so an empty body is a complete
//                  call and there is no required set to match. Declaring one would be a fiction.
//   token-scan     shares the `tokenIn` schema OBJECT with tape-pulse and wallet-audit: all three
//   wallet-audit   require exactly {chain, address}. A body carrying those two has genuinely not
//                  said which of the three questions it is asking, and the signpost must not invent
//                  an answer. It names tape-pulse, which is at least the right neighbourhood.
export const UNREACHABLE_BY_SHAPE = ['macro-sentry', 'token-scan', 'wallet-audit'];

/** Every fixture body, checked against the validator of the service it claims to be a call to. */
export function invalidFixtures() {
  const bad = [];
  for (const s of SERVICES) {
    const forms = GENUINE[s.name];
    if (!forms || !forms.length) { bad.push(`${s.name}: no fixture — an unmeasured service reads as a passing one`); continue; }
    for (const body of forms) {
      let v;
      try { v = s.validate(body); } catch (e) { bad.push(`${s.name}: validate threw on ${JSON.stringify(body)} — ${e.message}`); continue; }
      if (v && v.error) bad.push(`${s.name}: ${JSON.stringify(body)} -> ${v.error}`);
    }
  }
  return bad;
}

/** Send every service's genuine body to every OTHER service, and record what the signpost said. */
export function sweepOrderedPairs() {
  const rows = [];
  for (const called of SERVICES) {
    for (const meant of SERVICES) {
      if (called.name === meant.name) continue;
      for (const [form, body] of GENUINE[meant.name].entries()) {
        const hit = suggestService(called, body, SERVICES);
        rows.push({ called: called.name, meant: meant.name, form, said: hit ? hit.service : null });
      }
    }
  }
  return rows;
}

/** Which services the signpost is able to NAME at all. */
export function reachableTargets(rows = sweepOrderedPairs()) {
  return new Set(rows.filter((r) => r.said === r.meant).map((r) => r.meant));
}

/**
 * A correct call that got a signpost. The worst failure this component has, because it makes a right
 * answer look wrong — and unlike a missed redirect it is visible in every paid response.
 */
export function noisyOnCorrectCalls() {
  const noisy = [];
  for (const s of SERVICES) {
    for (const [form, body] of GENUINE[s.name].entries()) {
      const hit = suggestService(s, body, SERVICES);
      if (hit) noisy.push(`${s.name} form ${form} ${JSON.stringify(body).slice(0, 60)} -> ${hit.service}`);
    }
  }
  return noisy;
}

export function coverageSummary() {
  const rows = sweepOrderedPairs();
  const reachable = reachableTargets(rows);
  return {
    rows,
    reachable,
    total: SERVICES.length,
    correct: rows.filter((r) => r.said === r.meant).length,
    misdirected: rows.filter((r) => r.said && r.said !== r.meant).length,
    silent: rows.filter((r) => !r.said).length,
  };
}
