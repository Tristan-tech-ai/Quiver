// Service registry — one entry per priced x402 endpoint on this multi-service host.
// Each drives: the paid POST route, the gated /diag/scan tester, and the / index.
import { config } from './config.js';
import { gridSnapFields } from './util/grid.js';
import { buildInBackground } from './util/snark.js';
import { tokenScan } from './engine/tokenScan.js';
import { walletAudit } from './engine/walletAudit.js';
import { tapePulse } from './engine/tapePulse.js';
import { chartPress } from './engine/chartPress.js';
import { looksLikeCexSymbol } from './adapters/okx-market.js';
import { polyFill } from './engine/polyFill.js';
import { polyDesk } from './engine/polyDesk.js';
import { optionsDesk } from './engine/optionsDesk.js';

import { protocolPulse } from './engine/protocolPulse.js';
import { calldataX } from './engine/calldataX.js';
import { signatureX } from './engine/signatureX.js';
import { upDownPulse } from './engine/upDownPulse.js';
import { loopDigest } from './engine/loopDigest.js';
import { macroSentry } from './engine/macroSentry.js';
import { lpDesk } from './engine/lpDesk.js';
import { perpGate } from './engine/perpGate.js';
import { sizeGate } from './engine/sizeGate.js';
import { execVerify } from './engine/execVerify.js';
import { optionsRisk } from './engine/optionsRisk.js';
import { lpRisk } from './engine/lpRisk.js';
import { treasuryRisk } from './engine/treasuryRisk.js';
import { riskAttest } from './engine/riskAttest.js';
import { eventVol } from './engine/eventVol.js';
import { proofEnvelope, observationEnvelope } from './engine/proof.js';
import { portfolioGate } from './engine/portfolioGate.js';
import { enrichPerpInputs, enrichPortfolioLegs, fetchHlAccount } from './adapters/hyperliquid.js';
// The other half of the enum contract: repair.js resolves a value to a declared alternative where it
// can, and reports the ones it cannot so this file can refuse them. See the wrapper below `SERVICES`.
import { enumViolations, enumRefusal } from './util/repair.js';
// Every response carries its own timing — see the wrapper at the foot of this file, and
// src/util/timing.js for why the field lives in the envelope and not at the top level.
import { timedRun } from './util/timing.js';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Which per-leg fields `enrichPortfolioLegs` actually FETCHED, measured by diffing the legs the
// caller sent against the legs that came back — never by asking the adapter to self-report.
//
// WHY THIS EXISTS. portfolio-gate in explicit-positions mode calls the same live Hyperliquid context
// perp-gate's symbol mode does: a leg naming an asset but no `markPrice` has one filled in from the
// venue. That value then travelled into `proof.inputs` inside an envelope marked `deterministic: true`
// with no `observedAtUtc` and no provenance of any kind, so a caller comparing their request against
// the echoed inputs found a number they never sent, from nowhere, sealed as re-runnable. §11.5 of the
// paper records finding and fixing exactly this on perp-gate symbol mode; this is the branch next
// door, which is where this codebase's defects keep living. The rule the fix restores is the one
// `proofEnvelope` already enforces — a result carrying live provenance is not a proof — and the only
// thing missing was the provenance itself, so attaching it routes the answer to the honest envelope
// without a second pattern being invented for it.
//
// Measured, not declared: a self-reporting adapter is a claim, and a diff of what went in against
// what came out is evidence. Fields listed explicitly because they are the ones the enricher can
// fill; a new one that is not in this list would go undisclosed, so the list is asserted against the
// enricher's own behaviour in gates/gateP-paid-teaching.mjs.
const ENRICHABLE_LEG_FIELDS = ['markPrice', 'entryPrice', 'maintMarginRate', 'maxLeverage', 'marginTiers'];
export function legsFetchedLive(sent, enriched) {
  const filled = [];
  const before = Array.isArray(sent) ? sent : [];
  const after = Array.isArray(enriched) ? enriched : [];
  for (const [idx, leg] of after.entries()) {
    const was = before[idx] || {};
    const fields = {};
    for (const k of ENRICHABLE_LEG_FIELDS) {
      // `== null` on purpose: a leg that arrived with `markPrice: null` did not supply one either, and
      // the enricher fills it. Treating a null as "supplied" would let a fetched value ride inside a
      // path the caller technically sent, which is the one way this disclosure could be evaded.
      if (was[k] == null && leg && leg[k] != null) fields[k] = k === 'marginTiers' ? `${leg[k].length} notional tiers` : leg[k];
    }
    if (Object.keys(fields).length) {
      filled.push({ leg: idx, asset: String(leg.asset || leg.symbol || '').toUpperCase() || undefined, venue: String(leg.venue || 'hyperliquid').toLowerCase(), fetched: fields });
    }
  }
  return filled;
}
const CHAINS = new Set(['ethereum', 'solana', 'base', 'bsc', 'xlayer', 'polygon', 'arbitrum']);

const tokenIn = {
  type: 'object', required: ['chain', 'address'],
  properties: { chain: { type: 'string', description: 'ethereum | solana | base | bsc | polygon | arbitrum' }, address: { type: 'string', description: 'token contract address' } },
};
function vToken(b) {
  const chain = String(b?.chain || '').toLowerCase().trim();
  const address = String(b?.address || '').trim();
  if (!CHAINS.has(chain)) return { error: `unsupported chain "${chain}"` };
  if (!EVM.test(address) && !SOL.test(address)) return { error: 'address must be a 0x… or base58 token address' };
  return { chain, address };
}
function vWallet(b) { return vToken(b); }

const EVM_CHAINS = ['ethereum', 'base', 'bsc', 'xlayer', 'polygon', 'arbitrum'];

// Does the address belong to a DIFFERENT chain family than the one named? `vToken` validates the two
// fields independently, so `{chain:"solana", address:"0x…"}` passes it: each half is well-formed, and
// only the PAIR is wrong. Returns the diagnosis plus the chain the address itself implies, so a
// refusal can hand back a body that would work instead of a complaint.
export function chainAddressMismatch(chain, address) {
  const isEvmChain = EVM_CHAINS.includes(chain);
  if (isEvmChain && SOL.test(address)) {
    return { diagnosis: `chain "${chain}" is an EVM chain but "${address}" is a base58 (Solana) address — the pair cannot exist`, chain: 'solana', suggested: ['solana'] };
  }
  if (chain === 'solana' && EVM.test(address)) {
    return { diagnosis: `chain "solana" was given a 0x… EVM address ("${address}") — the pair cannot exist`, chain: 'ethereum', suggested: EVM_CHAINS };
  }
  return null;
}

// A refusal must TEACH. A caller that reached the wrong service, or whose params were dropped in
// transit (the marketplace funnel does this), can only self-correct if the rejection says what this
// service IS and what it expects. Derived from the service's own published inputSchema + blurb, so
// the hint can never drift from the listing — and so every service gets one without hand-editing 22
// error strings. Applied only when the validator's own message doesn't already name the service.
export function inputHint(s) {
  const sc = s?.inputSchema || {};
  const props = sc.properties || {};
  const bits = [];
  const req = Array.isArray(sc.required) ? sc.required.filter((k) => props[k]) : [];
  if (req.length) {
    bits.push(`requires { ${req.map((k) => `"${k}": <${props[k].description || props[k].type || 'value'}>`).join(', ')} }`);
  }
  const orKeys = (g) => (Array.isArray(g.anyOf) ? g.anyOf.map((o) => (o.required || []).join('+')).filter(Boolean).join(' OR ') : '');
  const groups = [...(Array.isArray(sc.allOf) ? sc.allOf : []), ...(sc.anyOf ? [sc] : [])]
    .map((g) => g.description || orKeys(g)).filter(Boolean);
  if (groups.length) bits.push(groups.join('; '));
  if (!bits.length) {
    const keys = Object.keys(props).slice(0, 6);
    if (keys.length) bits.push(`accepts { ${keys.join(', ')} }`);
  }
  return `${s.name} — ${s.blurb}${bits.length ? '. ' + bits.join(' | ') : ''}`.slice(0, 400);
}

// The one place that turns a validator's verdict into the message a caller actually reads.
export function refusalDetail(s, err) {
  return String(err).includes(s.name) ? String(err) : `${err} | ${inputHint(s)}`;
}

// A CALLER MISTAKE THAT ONLY THE UPSTREAM COULD DETECT.
//
// The schema-refusal path above catches everything knowable from the body alone. Two mistakes are not:
// a Polymarket slug that is well-formed but names no live market, and a token address that is
// well-formed for the WRONG chain. Both used to escape as `HTTP 500 engine_error` — one reporting a
// caller's typo as a server fault, the other pasting OKX's own `{"code":"51000","msg":"...param is
// error"}` verbatim into the answer, which reads to a caller as "the service is down". Neither is a
// fault and neither is billable.
//
// So they come back in the shape every other refusal here uses: `ok:false` with `errors` and a
// `howToFix` carrying a body that would work. `ok:false` is load-bearing beyond politeness — it is
// the exact condition `x402.isChargeable()` reads to SKIP settlement, so this refusal is free on the
// paid path, served as 200 with `PAYMENT-RESPONSE: not_charged`, in a way a 500 never was (a 500
// after verify but before settle also left the caller unbilled, but told them nothing and looked like
// an outage). `refusalDetail`/`redirectLine` are the sibling shape used when the body alone is enough
// to refuse; this one exists because these two need an upstream answer first.
//
// It deliberately does NOT swallow genuine upstream failure. Each call site matches one narrow,
// enumerated symptom of caller error; anything else rethrows and stays a 500, because an outage
// reported as a caller mistake is the same defect in the other direction.
export function callerMistake(serviceName, diagnosis, correctedBody, extra = {}) {
  const s = byName[serviceName];
  return {
    ok: false,
    errors: [diagnosis],
    refusalDetail: refusalDetail(s, diagnosis),
    howToFix: {
      missing: [],
      send: { method: 'POST', url: s.path, body: correctedBody },
      note: `This is a problem with the request, not with the service — nothing was computed and you were not charged. Send the body above to ${s.path}.`,
    },
    ...extra,
  };
}

export const SERVICES = [
  {
    name: 'tape-pulse', path: '/api/tape-pulse', price: config.prices.tapePulse,
    blurb: 'Live DEX tape microstructure read (buy/sell imbalance, net flow, whale prints) for a token',
    inputSchema: tokenIn, cacheKey: (b) => `tp:${b.chain}:${b.address}`, cacheTtl: 20000,
    validate: vToken,
    // `vToken` checks the chain and the address SEPARATELY — both were individually well-formed for
    // `{chain:"solana", address:"0xc02a…"}`, so the pair went upstream and came back as
    // `HTTP 500 engine_error, detail: okx GET /api/v6/dex/market/trades -> 400 {"code":"51000",…}`.
    // The mismatch is knowable here without asking anyone, so it is answered here.
    //
    // WHY ONLY THIS SERVICE. `vToken` is shared with token-scan, wallet-audit and chart-press, and the
    // same mismatch is measured returning an honest `INSUFFICIENT_DATA` observation (HTTP 200) on
    // token-scan and wallet-audit rather than a 500. Moving the check into the shared validator would
    // have turned two answers that already work into refusals, and moved their contentHashes.
    run: async (i) => {
      const mism = chainAddressMismatch(i.chain, i.address);
      if (mism) return callerMistake('tape-pulse', mism.diagnosis, { chain: mism.chain, address: i.address }, { suggestedChains: mism.suggested });
      try {
        return observationEnvelope('tape-pulse', i, await tapePulse(i.chain, i.address), config.version);
      } catch (e) {
        // Backstop for any OTHER shape of "this token does not exist on this chain" the pre-check
        // cannot see (a well-formed EVM address that is not a token, a chain the index maps oddly).
        // Narrow on purpose: only OKX's own parameter rejection, and the raw upstream string is
        // reported as `upstreamDetail` rather than as the answer. Anything else rethrows and is a 500.
        if (/tokenContractAddress param is error|"code":"51000"/.test(String(e.message || ''))) {
          return callerMistake('tape-pulse',
            `the DEX market index has no token at address "${i.address}" on chain "${i.chain}" — the upstream rejected the pair as a bad parameter`,
            { chain: i.chain, address: '<a token contract address that exists on ' + i.chain + '>' },
            { upstreamDetail: String(e.message).slice(0, 200) });
        }
        throw e;
      }
    },
  },
  {
    name: 'chart-press', path: '/api/chart-press', price: config.prices.chartPress,
    blurb: 'Agent-controlled PNG/SVG chart: candles + indicators + drawings, DEX token OR CEX symbol, numbers baked in',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'DEX chain (with address); OR omit and pass symbol for a CEX pair' }, address: { type: 'string', description: 'DEX token contract address' },
        symbol: { type: 'string', description: 'CEX pair, e.g. BTC-USDT or just BTC (defaults quote USDT) — routes to OKX public candles instead of the DEX feed' },
        interval: { type: 'string', description: '1m|5m|15m|1H|4H|1D' },
        lookback: { type: 'number', description: 'number of candles (10-300)' },
        // `quality` and `theme` are compared raw (chartPress.js:115 and :41) and fall through to the
        // cheaper/darker default, so `"FULL"` silently bought the fast tier and `"LIGHT"` returned a dark
        // chart. `chartType`, `format` and `interval` are NOT listed on purpose: each is already read
        // through a lowercasing consumer (chartPress.js:43, :48, okx-market.js:13 mapBar), so a declared
        // enum would recase the echoed input without changing a single served pixel — a moved
        // contentHash bought with no correction. The rule is "declare where miscasing changes the
        // ANSWER", and it is applied here in both directions.
        quality: { type: 'string', enum: ['fast', 'full'], description: 'fast (default, browserless) | full (high-detail, browser)' },
        chartType: { type: 'string', description: 'candles (default) | heikin | line | area | renko' },
        logScale: { type: 'boolean', description: 'logarithmic price axis' },
        format: { type: 'string', description: 'png (default) | svg (vector, fast tier only)' },
        width: { type: 'number', description: 'image width px (600-2400, default 1200)' },
        height: { type: 'number', description: 'image height px (400-1600, default 675)' },
        scale: { type: 'number', description: 'resolution multiplier 1-3 (png): 1200px * 3 = 3600px output' },
        timezone: { type: 'string', description: 'IANA timezone for axis labels (e.g. Asia/Jakarta); default UTC' },
        indicators: { type: 'array', description: 'e.g. [{type:"EMA",period:20},{type:"BOLL"},{type:"RSI"},{type:"VOL"},{type:"ICHIMOKU"}]', items: { type: 'object' } },
        drawings: { type: 'array', description: 'e.g. [{type:"hline",price,label},{type:"rect",p1:{index,price},p2},{type:"fib",p1,p2,extension?},{type:"trendline",p1,p2},{type:"ray",p1,p2},{type:"channel",p1,p2,width},{type:"measure",p1,p2},{type:"vline",index},{type:"text",index,price,text},{type:"longshort",side,entry,stop,target,entryIndex?,exitIndex?},{type:"orderline",side,price,label?}]', items: { type: 'object' } },
        annotations: { type: 'array', description: '[{index,price,text}]', items: { type: 'object' } },
        theme: { type: 'string', enum: ['dark', 'light'], description: 'dark | light' },
      },
    },
    validate: (b) => {
      const common = { interval: b.interval, lookback: b.lookback, quality: b.quality, chartType: b.chartType, logScale: b.logScale, format: b.format, width: b.width, height: b.height, scale: b.scale, timezone: b.timezone, indicators: b.indicators, drawings: b.drawings, annotations: b.annotations, theme: b.theme };
      // CEX-symbol path: accept `symbol` (or a symbol placed in `address`/`chain`) with no DEX token needed.
      if (b.symbol && looksLikeCexSymbol(b.symbol)) return { cex: true, symbol: b.symbol, ...common };
      if (!b.address && looksLikeCexSymbol(b.chain)) return { cex: true, symbol: b.chain, ...common };
      const v = vToken(b); if (v.error) return v; return { ...v, ...common };
    },
    run: async (i, ctx) => observationEnvelope('chart-press', i, await (i.cex
      ? chartPress(null, null, { symbol: i.symbol, interval: i.interval, lookback: i.lookback, quality: i.quality, chartType: i.chartType, logScale: i.logScale, format: i.format, width: i.width, height: i.height, scale: i.scale, timezone: i.timezone, indicators: i.indicators, drawings: i.drawings, annotations: i.annotations, theme: i.theme, brand: 'quiver', host: ctx.host })
      : chartPress(i.chain, i.address, { interval: i.interval, lookback: i.lookback, quality: i.quality, chartType: i.chartType, logScale: i.logScale, format: i.format, width: i.width, height: i.height, scale: i.scale, timezone: i.timezone, indicators: i.indicators, drawings: i.drawings, annotations: i.annotations, theme: i.theme, brand: 'quiver', host: ctx.host })), config.version),
  },
  {
    name: 'poly-fill', path: '/api/poly-fill', price: config.prices.polyFill,
    blurb: 'Pre-trade fill simulation on a Polymarket market: executable avg price + slippage for $X',
    // `action` carries an enum and `side` deliberately does not, and the difference is measured rather
    // than stylistic: polyFill.js:33 reads side through `String(side).toUpperCase()`, so `"no"` already
    // resolves to the NO book and declaring an enum there would only recase the echoed input — moving a
    // contentHash for a request that was already answered correctly. `action` is compared raw
    // (polyFill.js:44/47), so `"SELL"` walked the ASK book: measured on a 40/60 book, a seller was
    // quoted 60c and 166.7 shares instead of 40c and 250 — the buy side of the market, priced as theirs.
    inputSchema: { type: 'object', required: ['market', 'usd'], properties: { market: { type: 'string', description: 'slug / conditionId / question text' }, side: { type: 'string', description: 'YES|NO' }, action: { type: 'string', enum: ['buy', 'sell'], description: 'buy|sell' }, usd: { type: 'number' }, maxSlippagePct: { type: 'number' } } },
    validate: (b) => (b?.market && Number(b?.usd) > 0 ? { market: String(b.market), side: b.side, action: b.action, usd: Number(b.usd), maxSlippagePct: b.maxSlippagePct != null ? Number(b.maxSlippagePct) : null } : { error: 'require { market, usd>0 }' }),
    // A slug that is well-formed but names no live market is a caller's typo, not a server fault.
    // It used to surface as `HTTP 500 engine_error, detail: no active Polymarket market matched "…"` —
    // a sentence that correctly diagnoses the caller and then files it under the wrong party. The
    // diagnosis is kept; only its status, its shape and its billability change. The match is narrow so
    // that a Polymarket outage (a fetch failure, a 5xx from Gamma) still rethrows as a genuine 500.
    run: async (i) => {
      try {
        return observationEnvelope('poly-fill', i, await polyFill(i), config.version);
      } catch (e) {
        if (/no active Polymarket market matched/.test(String(e.message || ''))) {
          return callerMistake('poly-fill',
            `no active Polymarket market matched "${i.market}" — it is resolved, it never existed, or the slug is misspelt`,
            { market: '<an ACTIVE market slug, conditionId, or the question text>', usd: i.usd },
            { searched: i.market, findASlug: 'Slugs are the last path segment of a Polymarket event URL, e.g. https://polymarket.com/event/<slug>. A conditionId (0x…) or the full question text also resolves.' });
        }
        throw e;
      }
    },
  },
  {
    name: 'poly-desk', path: '/api/poly-desk', price: config.prices.polyDesk,
    blurb: 'A Polymarket wallet\'s live book: open positions, marks, unrealized PnL, movers',
    inputSchema: { type: 'object', required: ['wallet'], properties: { wallet: { type: 'string', description: 'Polymarket proxy wallet (0x…)' } } },
    validate: (b) => (EVM.test(String(b?.wallet || '').trim()) ? { wallet: String(b.wallet).trim() } : { error: 'wallet must be a 0x… address' }),
    run: async (i) => observationEnvelope('poly-desk', i, await polyDesk(i.wallet), config.version),
  },
  {
    name: 'options-desk', path: '/api/options-desk', price: config.prices.optionsDesk,
    blurb: 'Live crypto options intelligence from Deribit: IV term structure, skew, max pain, put/call OI, DVOL regime',
    // `currency` needs no enum — validate() below uppercases it and refuses anything outside BTC/ETH/SOL,
    // so case never reaches the engine. `focus` does: optionsDesk.js compares it raw (`focus === 'all'`,
    // `focus === 'expiries'`, `focus === 'greeks'`, `focus === 'headline'`), so `"ALL"` matched no branch
    // and returned STRICTLY LESS than sending nothing at all — greeksSurface dropped and expiries
    // truncated to three, under the word "all". The enum lists the four values the engine actually
    // distinguishes, which is two more than the old description admitted to.
    inputSchema: { type: 'object', required: ['currency'], properties: { currency: { type: 'string', description: 'BTC | ETH | SOL' }, focus: { type: 'string', enum: ['all', 'expiries', 'greeks', 'headline'], description: 'all (default) | expiries | greeks | headline' } } },
    cacheKey: (b) => `od:${String(b.currency).toUpperCase()}`, cacheTtl: 30000,
    // A REQUIRED subject parameter is never silently defaulted. A call whose params were dropped in
    // transit (the marketplace funnel does this) would otherwise receive a confident BTC options
    // dossier for a question it never asked, and be charged for it — indistinguishable, from the
    // caller's seat, from Quiver answering the wrong question. Refuse instead (free, per the billing
    // contract) and name the service the caller most likely wanted, so an agent can self-correct.
    validate: (b) => {
      const raw = b?.currency;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { error: 'currency is required (BTC | ETH | SOL). This endpoint returns crypto OPTIONS analytics only, and it cannot answer a protocol health question at any price. For a DeFi protocol health check (e.g. aave, lido, gmx) the call you want is: POST /api/protocol-pulse with {"protocol":"aave"}. For token safety: POST /api/token-scan with {"chain":"ethereum","address":"0x..."}. This refusal is free — you were not charged.' };
      }
      const c = String(raw).trim().toUpperCase();
      if (!['BTC', 'ETH', 'SOL'].includes(c)) {
        return { error: `options-desk covers BTC, ETH and SOL only, not "${String(raw).trim().slice(0, 24)}" — and no parameter makes it answer a protocol health question. If that is what you wanted, the call is: POST /api/protocol-pulse with {"protocol":"${String(raw).trim().slice(0,24).toLowerCase()}"}. This refusal is free — you were not charged.` };
      }
      return { currency: c, focus: b?.focus };
    },
    run: async (i) => observationEnvelope('options-desk', i, await optionsDesk(i.currency, { focus: i.focus }), config.version),
  },
  {
    name: 'lp-desk', path: '/api/lp-desk', price: config.prices.lpDesk,
    blurb: 'LP range reality-check: what a Uniswap-V3 range WOULD have earned (fees - IL - gas) on REAL swaps, measured, not optimised',
    inputSchema: { type: 'object', required: ['pool'], properties: { pool: { type: 'string', description: 'Uniswap-V3 pool address' }, chain: { type: 'string', description: 'ethereum | base | arbitrum' }, days: { type: 'number', description: '0.25-7 (default 2)' }, widthPct: { type: 'number', description: 'your proposed +/- range width in %, e.g. 5' }, capital: { type: 'number' } } },
    cacheKey: (b) => 'lp:' + String(b.chain||'ethereum') + ':' + String(b.pool).toLowerCase() + ':' + (b.days||2) + ':' + (b.widthPct||''), cacheTtl: 120000,
    validate: (b) => { const chain=String(b?.chain||'ethereum').toLowerCase(); const pool=String(b?.pool||'').trim();
      if(!['ethereum','base','arbitrum'].includes(chain)) return { error: 'chain must be ethereum, base, or arbitrum' };
      if(!EVM.test(pool)) return { error: 'pool must be a 0x-prefixed EVM address' };
      return { chain, pool, days: b?.days, widthPct: b?.widthPct, capital: b?.capital }; },
    run: async (i) => observationEnvelope('lp-desk', i, await lpDesk(i), config.version),
  },

  {
    name: 'calldata-x', path: '/api/calldata-x', price: config.prices.calldata,
    blurb: 'Decode + SIMULATE an unsigned tx, OR analyse an EIP-712 permit signature request: exact asset/approval changes, risk flags',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: '0x… calldata hex (for an unsigned transaction)' },
        to: { type: 'string', description: 'target contract (enables simulation)' },
        from: { type: 'string', description: 'signer address (enables simulation)' },
        value: { type: 'string', description: 'native value in wei' },
        typedData: { type: 'object', description: 'ALTERNATIVE to data: the EIP-712 typed-data object from eth_signTypedData_v4 (Permit2 PermitSingle/PermitBatch/PermitTransferFrom or EIP-2612 Permit). Signature drainers never send a transaction — pass the signing request here and it is analysed instead.' },
        chain: { type: 'string', description: 'ethereum | base | bsc | arbitrum | polygon | optimism' },
      },
    },
    validate: (b) => {
      // Signature-request path: an off-chain permit is NOT a transaction, so there is no calldata to decode.
      if (b?.typedData) {
        const td = b.typedData;
        if (typeof td !== 'object' && typeof td !== 'string') return { error: 'typedData must be the EIP-712 object (or its JSON string)' };
        return { typedData: td, chain: (b.chain || 'ethereum').toLowerCase() };
      }
      if (!/^0x[0-9a-fA-F]{8,}$/.test(String(b?.data || '').trim())) return { error: 'provide either data (0x… calldata hex) or typedData (an EIP-712 signing request)' };
      const evmA = /^0x[0-9a-fA-F]{40}$/;
      const out = { data: String(b.data).trim(), value: b.value || '0', chain: (b.chain || 'ethereum').toLowerCase() };
      if (b.to && evmA.test(String(b.to))) out.to = String(b.to);
      if (b.from && evmA.test(String(b.from))) out.from = String(b.from);
      return out;
    },
    run: async (i) => observationEnvelope('calldata-x', i, await (i.typedData ? signatureX(i) : calldataX(i)), config.version),
  },
  {
    name: 'protocol-pulse', path: '/api/protocol-pulse', price: config.prices.protocolPulse,
    blurb: 'DeFi protocol health dossier (TVL trend, drawdown, chain concentration, hack history) + risk grade',
    inputSchema: { type: 'object', required: ['protocol'], properties: { protocol: { type: 'string', description: 'protocol name or slug (e.g. aave, lido, gmx)' } } },
    cacheKey: (b) => `pp:${String(b.protocol).toLowerCase()}`, cacheTtl: 300000,
    validate: (b) => (b?.protocol ? { protocol: String(b.protocol) } : { error: 'require { protocol }' }),
    run: async (i) => observationEnvelope('protocol-pulse', i, await protocolPulse(i.protocol), config.version),
  },
  // `paw-check` (pet-food safety) was built here and served live, off-theme and deliberately left out
  // of the ASP listing. It is now unmounted as well: an undocumented twenty-third priced route on a
  // service whose whole claim is "twenty-two, catalogued in Table 1" is a contradiction a reader is
  // entitled to hold against the count, and it was never worth defending. Unlisted means no registry
  // change is involved. The engine file stays in src/engine/ until the next batch that moves the build
  // hash for other reasons, so removing it costs no documentation sweep of its own.
  {
    name: 'macro-sentry', path: '/api/macro-sentry', price: config.prices.macroSentry,
    blurb: 'High-impact US macro events (FOMC/CPI/NFP) ahead + the options-implied expected move to the next one — the market\'s priced-in magnitude, not just a date',
    inputSchema: { type: 'object', properties: {
      hours: { type: 'number', description: 'lookahead window in hours (default 72)' },
      spot: { type: 'number', description: 'coin spot — with atmIvPct, computes the expected move to the next event' },
      atmIvPct: { type: 'number', description: 'ATM implied vol in % (e.g. 60)' },
    } },
    validate: (b) => ({ hours: b?.hours ? Number(b.hours) : 72, spot: Number(b?.spot) > 0 ? Number(b.spot) : null, atmIvPct: Number(b?.atmIvPct) > 0 ? Number(b.atmIvPct) : null }),
    // Observation, not proof: the event set is filtered against "now" (which events are still ahead), so the
    // same inputs yield a different answer at a different time — it is NOT re-runnable to the identical
    // result, exactly the property `proof` claims. A signed, timestamped observation is the honest envelope.
    run: (i) => observationEnvelope('macro-sentry', i, macroSentry(i), config.version),
  },
  {
    name: 'updown-pulse', path: '/api/updown-pulse', price: config.prices.upDownPulse,
    blurb: 'Fair-value edge read on the live Polymarket BTC/ETH up-or-down window vs market odds',
    inputSchema: { type: 'object', required: ['coin'], properties: { coin: { type: 'string', description: 'BTC | ETH' } } },
    validate: (b) => { // same no-silent-default rule as options-desk (see its validate)
      const raw = b?.coin;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { error: 'coin is required (BTC | ETH). This endpoint reads the live Polymarket up-or-down window for BTC/ETH only. For perp liquidation risk use /api/perp-gate; for a DeFi protocol health check use /api/protocol-pulse.' };
      }
      const c = String(raw).trim().toUpperCase();
      if (!['BTC', 'ETH'].includes(c)) {
        return { error: `updown-pulse covers BTC and ETH only, not "${String(raw).trim().slice(0, 24)}". For perp liquidation risk use /api/perp-gate; for a DeFi protocol health check (e.g. aave) use /api/protocol-pulse.` };
      }
      return { coin: c };
    },
    run: async (i) => observationEnvelope('updown-pulse', i, await upDownPulse(i.coin), config.version),
  },
  {
    name: 'loop-digest', path: '/api/loop-digest', price: config.prices.loopDigest,
    blurb: 'Compact since-last-call diff of a wallet (new fills + PnL drift), cursor-based, for loop tops',
    inputSchema: { type: 'object', required: ['chain', 'wallet'], properties: { chain: { type: 'string' }, wallet: { type: 'string' }, cursor: { type: 'string', description: 'cursor from your previous call' } } },
    validate: (b) => { const v = vWallet({ chain: b?.chain, address: b?.wallet }); return v.error ? v : { chain: v.chain, wallet: v.address, cursor: b?.cursor || null }; },
    run: async (i) => observationEnvelope('loop-digest', i, await loopDigest(i), config.version),
  },
  // Veritape forensics (built + validated earlier) — RE-LISTED (on-theme authenticity forensics).
  {
    name: 'token-scan', path: '/api/token-scan', price: config.prices.tokenScan, register: true, // token-scan ships a manipulation-risk read (clean wash% not API-reachable) — disclosed, not hidden
    blurb: 'Manipulation-risk assessment for a token (wash/round-trip patterns) with evidence',
    inputSchema: tokenIn, cacheKey: (b) => `ts:${b.chain}:${b.address}`, cacheTtl: config.cacheTtlMs,
    validate: vToken, run: async (i) => observationEnvelope('token-scan', i, await tokenScan(i.chain, i.address), config.version),
  },
  {
    name: 'wallet-audit', path: '/api/wallet-audit', price: config.prices.walletAudit, register: true,
    blurb: 'Track-record authenticity audit for a wallet (win-rate significance + wash cross-check)',
    inputSchema: tokenIn, cacheKey: (b) => `wa:${b.chain}:${b.address}`, cacheTtl: config.cacheTtlMs,
    validate: vWallet, run: async (i) => observationEnvelope('wallet-audit', i, await walletAudit(i.chain, i.address), config.version),
  },
  // ── Risk Brain (Q1) — deterministic, self-verifying risk computation the agent risk layer needs as INPUT.
  //    Each wraps its engine in a T0 proof envelope (re-runnable + self-checked + content-hashed).
  {
    name: 'perp-gate', path: '/api/perp-gate', price: config.prices.perpGate, register: true,
    blurb: 'Perp liquidation price, distance-to-liq & funding drag — deterministic, with a self-check that proves it correct. Pass a Hyperliquid or dYdX symbol (+ optional venue) for live mark/funding/margin.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'perp symbol (e.g. BTC) — auto-fills live markPrice, fundingRateHourly, and the margin source (Hyperliquid notional tiers, or dYdX maintenance rate)' },
        // THE ENUMS ARE LOAD-BEARING, NOT DECORATION. `src/util/repair.js` step 6 case-corrects a value
        // against its declared `enum`, and only against a declared one. Without the array below, a caller
        // who wrote `side: "SHORT"` fell through perpGate's `s === 'short' || s === 'sell' ? -1 : 1` to
        // LONG and was served the liquidation price of the opposite position, self-checked and signed.
        // `buy`/`sell` are listed because the engine has always honoured them (perpGate.js:29) — leaving
        // them out would have left `"SELL"` reading as long, which is the same wrong answer wearing a
        // different word. Declared HERE rather than only in src/mcp.js because repairBody is handed the
        // SERVICES entry on both surfaces, so an enum declared only on the MCP tool is advertised and
        // never applied. See hackathon/CASE_SENSITIVITY_FIX.md.
        //
        // `-1` IS IN THE LIST FOR THE SAME REASON `sell` IS. Now that a value matching no declared
        // alternative is REFUSED rather than served as long (see the wrapper at the foot of this file),
        // the enum stopped being only a repair target and became the definition of what this key
        // accepts. `perpGate.js:29` honours the string "-1" as short — measured, 108,641.98, the
        // correct answer — so omitting it would have turned a request that answers CORRECTLY today
        // into a refusal, which is a worse defect than the one being fixed. The NUMBER -1 is honoured
        // too and needs no declaration: the guard, like repair.js, only ever looks at strings.
        // The escape hatch moved INTO the schema when the enum started being enforced. It used to be
        // reachable only from the adapter's own refusal (`hyperliquid.js:99`), which a caller now
        // never sees because `venue: "okx"` is refused at validation, before any venue is resolved.
        // The sentence is worth more than the code path: the liquidation MATH is venue-agnostic, so a
        // caller on an unsupported venue is one field away from the number they wanted, and a refusal
        // that only says "no" would be strictly less useful than the one it replaced.
        venue: { type: 'string', enum: ['hyperliquid', 'dydx'], description: 'live-data venue: hyperliquid (default) | dydx. The maths is venue-agnostic — for any other venue omit this and pass maxLeverage/markPrice/fundingRateHourly yourself.' },
        side: { type: 'string', enum: ['long', 'short', 'buy', 'sell', '-1'], description: 'long | short (buy | sell are accepted synonyms, as is -1 for short); default long' },
        entryPrice: { type: 'number', description: 'defaults to live mark if a symbol is given' },
        size: { type: 'number', description: 'position size in base units' }, notional: { type: 'number' },
        margin: { type: 'number', description: 'isolated margin (or pass leverage)' }, leverage: { type: 'number' },
        maintMarginRate: { type: 'number', description: 'e.g. 0.0125 (or pass maxLeverage/symbol; mmr=0.5/maxLev)' }, maxLeverage: { type: 'number' },
        markPrice: { type: 'number' }, fundingRateHourly: { type: 'number' }, horizonHours: { type: 'number' },
      },
      // Runtime constraints made machine-checkable (were enforced only in validate(), invisible to a buyer's
      // schema validator): a price source, a size, collateral, and a maintenance-margin source are each
      // required — any one option in each group satisfies it.
      allOf: [
        { anyOf: [{ required: ['entryPrice'] }, { required: ['symbol'] }], description: 'price: entryPrice OR symbol (defaults to live mark)' },
        { anyOf: [{ required: ['size'] }, { required: ['notional'] }], description: 'size: size (base units) OR notional' },
        { anyOf: [{ required: ['margin'] }, { required: ['leverage'] }], description: 'collateral: margin OR leverage' },
        { anyOf: [{ required: ['maintMarginRate'] }, { required: ['maxLeverage'] }, { required: ['symbol'] }], description: 'maintenance: maintMarginRate OR maxLeverage OR symbol' },
      ],
    },
    validate: (b) => {
      const hasSym = typeof b?.symbol === 'string' && b.symbol.trim().length > 0;
      if (!(Number(b?.entryPrice) > 0) && !hasSym) return { error: 'require entryPrice > 0 (or a symbol to default it to live mark)' };
      if (!(Number(b?.size) > 0) && !(Number(b?.notional) > 0)) return { error: 'require size (base units) or notional' };
      if (!(Number(b?.margin) > 0) && !(Number(b?.leverage) > 0)) return { error: 'require margin or leverage' };
      if (!(Number(b?.maintMarginRate) > 0) && !(Number(b?.maxLeverage) > 0) && !hasSym) return { error: 'require maintMarginRate, maxLeverage, or a symbol' };
      return b;
    },
    run: async (i) => {
      const e = await enrichPerpInputs(i);
      // `snark` is a delivery preference, not a term in the identity. Leaving it in `compute` would
      // put it inside proof.inputs and therefore inside the content hash, so the same position would
      // hash differently depending on whether a proof was requested — and the published worked proof
      // would stop reproducing for anyone who asked for one.
      const { live, snark: wantSnark, ...raw } = e;   // provenance and preferences are not inputs
      // Snap onto the 1e-9 grid the succinct-proof circuit works over, so the identity a proof
      // certifies is the identity this answer was computed from rather than one 3.5e-6 away. Measured
      // over 3,000 positions: worst divergence falls from 3.53e-6 to 5.53e-10, none above 1e-9.
      // Leverage is included because the engine derives margin from it, and the derived value lands
      // off-grid otherwise. Inputs already on the grid — including every value in the worked proof
      // this documentation publishes — are returned unchanged, so no content hash moves.
      const compute = gridSnapFields(raw, ['entryPrice', 'size', 'notional', 'margin', 'leverage', 'maintMarginRate', 'maxLeverage', 'markPrice']);
      // Same refusal as the MCP handler: an unresolvable venue is a caller error, and serving the
      // maths with the complaint welded into the signed result is neither a refusal nor a usable
      // answer. Refused here means ok:false, which the billing contract already makes free.
      if (live?.unsupportedVenue) {
        return { ok: false, errors: [live.error], supportedVenues: live.supported };
      }
      const r = perpGate(compute);
      if (live) {
        // A symbol was resolved against a venue, so this answer is an OBSERVATION, not a re-runnable
        // proof, and it must say so. It previously attached `live` to the result and then sealed it
        // in a deterministic proof envelope — which put a key inside the content hash that re-running
        // the engine on proof.inputs can never produce. A caller following proof.reproduce got a
        // mismatch, and the same envelope told them a mismatch means tampering: the verification
        // instruction at the centre of this service accused an honest response. portfolio-gate two
        // handlers below already branched this way; perp-gate now matches it.
        r.live = live;
        r.mathReproducibility = 'The liquidation MATH is deterministic and re-runnable: run the open perp-gate engine on observation.inputs (the venue values frozen at observedAtUtc) and every number reproduces exactly. What is NOT re-runnable is the venue read itself — mark price, funding and margin tiers move — so this ships as a committed observation rather than as a proof that claims to reproduce from scratch.';
        const obs = observationEnvelope('perp-gate', compute, r, config.version);
        // A succinct proof on THIS branch too, when asked for — and the reason it took a document to
        // justify four lines is that the two halves of the on-chain story were sitting on opposite
        // sides of this `if`. The Plonk proof was built only below, where the caller supplied the
        // entry price, so the number bound into the proof was a private fact about the caller's
        // position that no chain can corroborate. The entry price that CAN be corroborated — the one
        // HyperCore's own precompiles return — is filled in here, on the branch that was returning no
        // proof at all. The join built against chain 999 was therefore correct and unreachable.
        //
        // WHAT IS AND IS NOT SEALED. The hard rule of this codebase is that a result carrying live
        // provenance is never sealed as a deterministic proof, and it is enforced inside
        // proofEnvelope rather than trusted to call sites. Nothing here weakens it: this stays an
        // OBSERVATION envelope, `deterministic` stays false, and the snark is attached as a SIBLING
        // of `observation`, exactly as it is a sibling of `proof` below. The contentHash was already
        // taken, over `{engine, codeHash, observedAtUtc, inputs, result}`, so attaching this moves
        // nothing; and `snark` was destructured out of the request above, so it never entered
        // `compute` and cannot enter the hash. The two claims are different sizes and must not be
        // confused: the SNARK proves the arithmetic over five pinned integers and is deterministic;
        // the ENVELOPE commits a live read and is not. `doesNotProve` below says so in the response
        // rather than only here, because the reader who needs it is holding the JSON, not the source.
        if (wantSnark === true || wantSnark === 'true') {
          // The maintenance rate is the reason this is not the one-line change it looks like.
          // Hyperliquid symbol mode fills `marginTiers` and NO `maintMarginRate` — the engine picks
          // the tier by notional and derives mmr = 0.5/maxLeverage itself — so a witness built from
          // the echoed inputs alone comes back null and the proof is refused as "outside the circuit
          // domain". Measured: HL symbol mode null, dYdX symbol mode fine, which is exactly backwards,
          // because HyperCore attests Hyperliquid marks and holds nothing about dYdX. So the derived
          // rate is supplied from `r.inputs.maintMarginRate`, which is the engine's own `mmr` at full
          // precision — NOT one of the display-rounded echoes beside it (`size` is round(q,8) and
          // `margin` is round(M,2); certifying either would prove a neighbouring position). It is
          // published below as `maintenanceRateProven` so a reader can check it against public signal
          // 6 without re-deriving it, and re-derive it from `observation.inputs.marginTiers` if they
          // want to check us rather than take it.
          const witnessInputs = obs.observation.inputs.maintMarginRate != null
            ? obs.observation.inputs
            : { ...obs.observation.inputs, maintMarginRate: r.inputs?.maintMarginRate };
          // A position already at or below maintenance has no future liquidation threshold, so there
          // is nothing for a proof to be about. Saying that costs one field; letting it through makes
          // the store record "witness diverges from the served price by NaN", which is true and useless.
          const provable = Number.isFinite(r.liquidationPrice);
          const defaultedToMark = live.filled?._entryDefaultedToMark === true;
          const hyperCoreHoldsThis = live.venue === 'hyperliquid' && defaultedToMark;
          // Stored ON the proof, not only in this response. /proof/<hash> is free and is meant to be
          // fetched by somebody who never saw this answer — that is a stated feature — and at that
          // endpoint a proof whose entry price was read off a venue is indistinguishable from one the
          // caller typed. So the distinction travels with the proof.
          if (provable) {
            buildInBackground(obs.observation.contentHash, witnessInputs, r.liquidationPrice, {
              inputsWereFetchedLive: true,
              entryPriceSource: defaultedToMark ? 'live-mark' : 'caller-supplied',
              entryPriceVenue: live.venue,
              observedAtUtc: obs.observation.observedAtUtc,
              doesNotProve: 'This proof covers the arithmetic over the integers in publicSignals and nothing else. Public signal 4 — the entry price — was FETCHED from a venue rather than supplied by the caller, and the circuit has no term for a mark, a venue, an asset or a clock, so a verifying proof says nothing about whether that number was current or honest. Covering it is a separate on-chain step against the venue\'s own state; see the perp-gate response this hash came from.',
            });
          }
          obs.snark = {
            protocol: 'plonk',
            status: provable ? 'building' : 'unavailable',
            ...(provable
              ? { retrieveAt: `/proof/${obs.observation.contentHash}`, verificationKey: '/proof/vk' }
              : { reason: 'this answer carries no liquidation price to certify — the position is already at or below maintenance, so the threshold is behind it rather than ahead of it' }),
            // The discriminator, machine-readable, because the distinction this whole field exists to
            // preserve must not depend on a caller reading prose. True whenever the envelope is an
            // observation: at least one number in the proven statement was FETCHED, not supplied.
            inputsWereFetchedLive: true,
            entryPriceSource: defaultedToMark ? 'live-mark' : 'caller-supplied',
            entryPriceVenue: live.venue,
            entryPriceProven: obs.observation.inputs.entryPrice,
            maintenanceRateProven: witnessInputs.maintMarginRate,
            observedAtUtc: obs.observation.observedAtUtc,
            proves: 'The liquidation identity over the five integers pinned in the proof\'s public signals — margin, size, entry price, side and maintenance rate give this liquidation price on a 1e-9 grid, inside a tolerance the circuit publishes as a signal of its own. That statement is deterministic and checkable offline against /proof/vk, and it is the whole of what the SNARK says.',
            doesNotProve: 'That the entry price it pins is the venue\'s mark, or that the venue\'s mark is right. The entry price here was FETCHED rather than supplied, and the circuit carries no mark, no venue, no asset and no clock — so nothing inside this proof attests where the number came from, and a proof that verifies says nothing about whether the input was current or honest. Covering the input is a separate step that has to happen on chain, against the venue\'s own state, inside a bounded staleness window; see markAttestation. Until that step runs, treat the entry price as a live read this service made and published, with observedAtUtc as its timestamp.',
            markAttestation: {
              appliesToThisAnswer: hyperCoreHoldsThis,
              deployed: false,
              mechanism: 'QuiverPerpVerifier.verifyPerpGate(proof, pubSignals, asset) on HyperEVM (chain 999) re-reads the mark from the HyperCore precompiles INSIDE the transaction and rejects the proof unless the chain\'s own mark is within max(4055 ppm, 1 tick) of public signal 4 — the entry price. The arithmetic and the input are then refused separately and namedly: ProofRejected against a bent proof, MarkMismatch against a stale one.',
              window: '4055 ppm, the p99.9 of 30-second mark drift measured over the live perp universe; the 1-tick floor exists because on the coarsest-grid assets one tick is wider than that, and a window finer than the smallest representable move is unsatisfiable rather than strict.',
              note: hyperCoreHoldsThis
                ? 'The contract is written and gated against a real chain-999 node, and it is NOT deployed: it has no address and nothing here has been attested on chain. This field describes what would cover the input, not something that has happened.'
                : live.venue === 'hyperliquid'
                  ? 'Not applicable to this answer: the entry price is the caller\'s own, not the live mark, so there is nothing for HyperCore to corroborate. Omit entryPrice to have it default to the mark.'
                  : `Not applicable to this answer: the mark came from ${live.venue}, and the HyperCore precompiles hold no ${live.venue} state. The attestation reaches Hyperliquid marks only.`,
            },
          };
        }
        return obs;
      }
      // Caller supplied every input: nothing was fetched, so the answer really is re-runnable.
      const env = proofEnvelope('perp-gate', compute, r, config.version);
      // A succinct proof, when asked for. Attached as a SIBLING of `proof`, never inside `result`,
      // so the content hash covers exactly what it covered before and the published worked proof
      // keeps reproducing. Built off the request path — see util/snark.js for why 703 ms of Plonk
      // proving does not belong in a response the caller is waiting on.
      if (wantSnark === true || wantSnark === 'true') {
        // Only the request is handed over, deliberately. The engine echoes a `margin` in `r.inputs`
        // and passing that through looks like the careful thing to do — it is the engine's own
        // number, after all — but it is `round(M, 2)`, rounded for display. Certifying it would
        // prove a position 0.0019 away from the one that was priced, and the divergence guard would
        // not have caught it: the resulting shift in liquidation price is 0.00015, well inside the
        // half-cent the guard allows. The witness recomputes margin at full precision instead.
        buildInBackground(env.proof.contentHash, env.proof.inputs, r.liquidationPrice);
        env.snark = {
          protocol: 'plonk',
          status: 'building',
          retrieveAt: `/proof/${env.proof.contentHash}`,
          verificationKey: '/proof/vk',
          note: 'A succinct proof of the liquidation identity for exactly these inputs, over the public Hermez reference string. Proving takes about 0.7s, so it is built off this request rather than inside it — fetch it at the URL above, free. It certifies the identity on a 1e-9 grid; the inputs echoed here are already snapped to that grid, so the proof and this answer describe the same position.',
        };
      }
      return env;
    },
  },
  {
    name: 'portfolio-gate', path: '/api/portfolio-gate', price: config.prices.portfolioGate, register: true,
    blurb: 'Cross-venue portfolio: TRUE net exposure per underlying, the leg that liquidates FIRST, concentration, and a correlated-crash stress — the number no single-instrument tool gives, self-checked. Pass Hyperliquid symbols to auto-fill live mark/leverage/tiers.',
    inputSchema: {
      type: 'object',
      properties: {
        positions: {
          type: 'array',
          description: 'legs across venues: {venue, asset|symbol, side, size, entryPrice, markPrice?, margin|leverage, maxLeverage|maintMarginRate|marginTiers}. A Hyperliquid symbol auto-fills live mark/leverage/margin-tiers.',
          // A PARTIAL item schema, deliberately. The full leg shape is documented on the array above and
          // stays there; what is declared here is the one leg field whose VALUE is constrained, because
          // `enum` is the only thing repair.js can act on. `side: "SHORT"` on a leg used to read as LONG
          // (portfolioGate.js:30, the same fall-through as perpGate.js:29), which turned a perfectly
          // hedged book — one long, one short — into a doubled-up 200,000 directional bet, with every
          // self-check passing. No `additionalProperties: false`: a leg carrying the other documented
          // fields is still valid against this schema, exactly as before.
          items: {
            type: 'object',
            description: 'one leg; see the array description for the full field list',
            properties: {
              side: { type: 'string', enum: ['long', 'short', 'buy', 'sell'], description: 'long | short (buy | sell are accepted synonyms); a negative size also reads as short' },
            },
          },
        },
        account: { type: 'string', description: 'OR: a Hyperliquid account address (0x…) — the FULL live book (positions, margins, account equity, venue liquidation prices) is pulled keylessly and gated; no manual typing. Explicit positions take precedence.' },
        // Unlisted, `betaTier: "SEVERE"` failed the `['mild','moderate','severe'].includes(...)` test at
        // portfolioGate.js:127 and silently fell back to the default Oct-10 table — a DIFFERENT stress
        // number returned under the tier the caller asked for, with nothing in the response saying so.
        betaTier: { type: 'string', enum: ['mild', 'moderate', 'severe'], description: 'beta regime for the factor stress: mild | moderate | severe — cross-event VALIDATED tiers (pre-registered; H1 Spearman 0.657, H2 out-of-sample relative risk 14.3×). Default = the worst-case single-event Oct-10 table. Explicit betas override.' },
        shockScenariosPct: { type: 'array', description: 'correlated market moves (%) to stress; default [5,10,20,30]' },
      },
      // Exactly one book source is required: an explicit `positions` array OR an `account` address to pull
      // the live book from. (`positions` wins if both are sent.)
      anyOf: [{ required: ['positions'] }, { required: ['account'] }],
    },
    validate: (b) => {
      const hasPositions = Array.isArray(b?.positions) && b.positions.length > 0;
      const account = typeof b?.account === 'string' ? b.account.trim() : '';
      if (!hasPositions && !account) return { error: 'require positions (a non-empty array of legs) OR account (a Hyperliquid 0x… address to pull the live book from)' };
      if (!hasPositions && !EVM.test(account)) return { error: `account "${account}" is not a valid EVM address (0x + 40 hex)` };
      return hasPositions ? b : { ...b, account };
    },
    run: async (i) => {
      let live = null, base = i;
      if (!Array.isArray(i.positions) || !i.positions.length) {
        // Account mode: pull the address's full live Hyperliquid book — positions, per-leg margins/modes,
        // the venue's own liquidation prices (cross-checked in the engine), and the account equity that
        // powers the cross-margin view. Because the answer embeds a live fetch, account mode ships the
        // OBSERVATION envelope (adversarial review caught the earlier proof envelope overclaiming
        // "reproduce this result exactly" over wall-clock data) — with the frozen book echoed in
        // observation.inputs and the math-is-re-runnable property stated explicitly.
        const acct = await fetchHlAccount(i.account);
        if (!acct.positions.length) {
          return observationEnvelope('portfolio-gate', { account: i.account }, {
            ok: false, errors: ['no open perp positions on this Hyperliquid account'],
            accountEquityUsd: acct.accountEquityUsd, withdrawableUsd: acct.withdrawableUsd,
          }, config.version);
        }
        base = { ...i, positions: acct.positions, accountEquityUsd: acct.accountEquityUsd };
        live = { source: 'hyperliquid clearinghouseState (keyless public API)', address: i.account, fetchedAtUtc: new Date().toISOString(), positionsFound: acct.positions.length, accountEquityUsd: acct.accountEquityUsd, totalMarginUsedUsd: acct.totalMarginUsedUsd, withdrawableUsd: acct.withdrawableUsd };
      }
      const positions = await enrichPortfolioLegs(base.positions);   // fill live mark/leverage/tiers per leg (one cached fetch)
      const input = { ...base, positions };
      const r = portfolioGate(input);
      // EXPLICIT-POSITIONS MODE, and the defect this branch used to carry. A leg that named an asset
      // but no mark had one FETCHED from the venue and sealed into `proof.inputs` under
      // `deterministic: true`, with no observedAtUtc and no source — the same defect §11.5 records
      // fixing on perp-gate symbol mode, one handler up. Disclosed the same way it is disclosed
      // there: a `live` block on the result, which routes this to the observation envelope that can
      // carry a wall-clock read honestly. A call whose legs were all supplied fills nothing, gets no
      // `live` block, and stays a deterministic proof with its contentHash exactly where it was.
      let legFills = null;
      if (!live) {
        const fetchedLegs = legsFetchedLive(base.positions, positions);
        if (fetchedLegs.length) {
          legFills = fetchedLegs;
          live = {
            source: 'hyperliquid live perp context (keyless public API) — per-leg mark, margin tiers and max leverage',
            venues: [...new Set(fetchedLegs.map((f) => f.venue))],
            legsEnriched: fetchedLegs.length,
            ofLegs: positions.length,
            filled: fetchedLegs,
            note: 'These per-leg values were READ FROM THE VENUE, not supplied by the caller. They are frozen into observation.inputs so the maths re-runs, and the envelope is an OBSERVATION rather than a proof because the read itself is not re-runnable. Supply markPrice and a maintenance-margin source on every leg to get a deterministic proof envelope back.',
          };
        }
      }
      if (live) {
        r.live = live;
        r.mathReproducibility = legFills
          ? 'The risk MATH is deterministic and re-runnable: run the open portfolio-gate engine on observation.inputs (the legs as they stood at observedAtUtc, including the venue values listed in live.filled) and every risk number reproduces exactly. What is NOT re-runnable is the venue read — the marks and margin tiers listed in live.filled move — so this ships as a committed observation rather than as a proof that claims to reproduce from scratch.'
          : 'The risk MATH is deterministic and re-runnable: run the open portfolio-gate engine on observation.inputs (the frozen book snapshot fetched at observedAtUtc) and every risk number reproduces. The SNAPSHOT itself is a committed live observation — re-fetch Hyperliquid clearinghouseState for this address to independently check what the book looks like now.';
        return observationEnvelope('portfolio-gate', input, r, config.version);
      }
      return proofEnvelope('portfolio-gate', input, r, config.version);
    },
  },
  {
    name: 'size-gate', path: '/api/size-gate', price: config.prices.sizeGate, register: true,
    blurb: 'Fractional-Kelly position size + risk-of-ruin — the deterministic antidote to over-betting and blowups',
    inputSchema: {
      type: 'object',
      properties: {
        winProb: { type: 'number', description: 'discrete: win probability (0,1)' }, winLossRatio: { type: 'number', description: 'discrete: net win/loss odds' },
        expectedReturn: { type: 'number', description: 'continuous: excess return per period' }, volatility: { type: 'number', description: 'continuous: vol per period' },
        bankroll: { type: 'number' }, kellyFraction: { type: 'number', description: 'fraction of full Kelly (default 0.25)' }, drawdownLevels: { type: 'array' },
      },
    },
    validate: (b) => {
      const disc = Number(b?.winProb) > 0 && Number(b?.winLossRatio) > 0;
      const cont = b?.expectedReturn != null && Number(b?.volatility) > 0;
      if (!disc && !cont) return { error: 'require {winProb, winLossRatio} or {expectedReturn, volatility}' };
      return b;
    },
    run: (i) => proofEnvelope('size-gate', i, sizeGate(i), config.version),
  },
  {
    name: 'exec-verify', path: '/api/exec-verify', price: config.prices.execVerify, register: true,
    blurb: 'Fair-fill / sandwich check — proves how many bps a swap lost to adverse execution its slippage tolerance hid',
    inputSchema: {
      type: 'object', required: ['amountIn', 'amountOutRealized'],
      properties: {
        amountIn: { type: 'number' }, amountOutRealized: { type: 'number' },
        reserveIn: { type: 'number', description: 'pool reserve in, pre-trade (constant-product mode)' }, reserveOut: { type: 'number' }, feeTier: { type: 'number', description: 'fraction e.g. 0.003' },
        fairPrice: { type: 'number', description: 'reference mode: out-per-in fair price at submit' }, slippageTolerancePct: { type: 'number' },
      },
    },
    validate: (b) => {
      if (!(Number(b?.amountIn) > 0) || !(Number(b?.amountOutRealized) > 0)) return { error: 'require amountIn and amountOutRealized > 0' };
      const cp = Number(b?.reserveIn) > 0 && Number(b?.reserveOut) > 0 && b?.feeTier != null;
      const ref = Number(b?.fairPrice) > 0;
      if (!cp && !ref) return { error: 'require {reserveIn, reserveOut, feeTier} or fairPrice' };
      return b;
    },
    run: (i) => proofEnvelope('exec-verify', i, execVerify(i), config.version),
  },
  {
    name: 'options-risk', path: '/api/options-risk', price: config.prices.optionsRisk, register: true,
    blurb: 'Portfolio greeks (delta/gamma/vega/theta) + SPAN-style scenario margin for an options book — self-checked against finite-difference derivatives',
    inputSchema: {
      type: 'object', required: ['positions'],
      properties: {
        forward: { type: 'number', description: 'shared forward (or set forward per position)' },
        r: { type: 'number', description: 'discount rate (default 0, Deribit convention)' },
        scanRangePct: { type: 'number', description: 'SPAN price scan range (default 0.15)' },
        volShiftVolPts: { type: 'number', description: 'SPAN vol shift in vol-points (default 10)' },
        positions: {
          type: 'array', description: 'options legs',
          items: {
            type: 'object', required: ['type', 'strike', 'iv', 'quantity'],
            properties: {
              // Every `type` that was not the literal "put" was priced as a CALL (optionsRisk.js:32), so
              // `"PUT"` flipped portfolio delta from −0.680134 to +0.319866 and the mark-to-model by
              // 10,000 on a single leg — while all six finite-difference greek checks passed, because
              // they verify the book the engine chose, not the book the caller described.
              type: { type: 'string', enum: ['call', 'put'], description: 'call | put' }, strike: { type: 'number' },
              expiryDays: { type: 'number' }, T: { type: 'number', description: 'years to expiry (or use expiryDays)' },
              iv: { type: 'number', description: 'implied vol, decimal e.g. 0.6' }, quantity: { type: 'number', description: 'signed: + long, − short' },
              forward: { type: 'number', description: 'per-position forward (else shared)' },
            },
          },
        },
      },
    },
    validate: (b) => (Array.isArray(b?.positions) && b.positions.length ? b : { error: 'require positions: [{type, strike, iv, quantity, expiryDays|T}] and a forward (shared or per-position)' }),
    run: (i) => proofEnvelope('options-risk', i, optionsRisk(i), config.version),
  },
  {
    name: 'lp-risk', path: '/api/lp-risk', price: config.prices.lpRisk, register: true,
    blurb: 'Forward-looking LP impermanent loss / divergence (LVR) + fee breakeven — closed-form, self-checked at the token level',
    inputSchema: {
      type: 'object',
      properties: {
        priceRatio: { type: 'number', description: 'realized price ratio P1/P0 for realized IL' },
        volatility: { type: 'number', description: 'per-period vol (decimal) for expected divergence' },
        horizonPeriods: { type: 'number', description: 'number of periods (default 1)' },
        feeAprPct: { type: 'number', description: 'annualized fee yield estimate, for net + breakeven' },
        periodsPerYear: { type: 'number', description: 'periods per year for the APR conversion (default 365)' },
        concentrationFactor: { type: 'number', description: 'V3 capital-efficiency amplifier ≥1 (default 1 = full range)' },
        capitalUsd: { type: 'number' },
      },
    },
    validate: (b) => ((Number(b?.priceRatio) > 0 || Number(b?.volatility) > 0) ? b : { error: 'require priceRatio (realized IL) and/or volatility (+ horizonPeriods) for expected divergence' }),
    run: (i) => proofEnvelope('lp-risk', i, lpRisk(i), config.version),
  },
  {
    name: 'treasury-risk', path: '/api/treasury-risk', price: config.prices.treasuryRisk, register: true,
    blurb: 'Stablecoin treasury risk: concentration (HHI by asset/venue/chain), depeg stress, risk-adjusted yield — self-checked',
    inputSchema: {
      type: 'object', required: ['positions'],
      properties: {
        concentrationLimitPct: { type: 'number', description: 'flag any single exposure above this (default 25)' },
        depegFloor: { type: 'number', description: 'worst-single-depeg stress floor (default 0.90)' },
        depegScenarios: { type: 'array', description: '[{asset, price}] explicit depeg stresses' },
        positions: {
          type: 'array',
          items: {
            type: 'object', required: ['asset', 'amountUsd'],
            properties: {
              asset: { type: 'string', description: 'stablecoin symbol, e.g. USDC' }, amountUsd: { type: 'number' },
              apyPct: { type: 'number' }, venue: { type: 'string' }, chain: { type: 'string' },
              pegTarget: { type: 'number', description: 'default 1' }, depegProbAnnual: { type: 'number', description: 'for risk-adjusted yield' },
            },
          },
        },
      },
    },
    validate: (b) => (Array.isArray(b?.positions) && b.positions.length ? b : { error: 'require positions: [{asset, amountUsd, apyPct?, venue?, chain?}]' }),
    run: (i) => proofEnvelope('treasury-risk', i, treasuryRisk(i), config.version),
  },
  {
    name: 'risk-attest', path: '/api/risk-attest', price: config.prices.riskAttest, register: true,
    blurb: 'Batch proof content-hashes into one Merkle root + inclusion proofs, so a single on-chain anchor attests many computations',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', description: 'array of proof envelopes (uses proof.contentHash) or raw content-hashes (hex)' },
        contentHashes: { type: 'array', description: 'alternatively, raw content-hashes (hex strings)' },
      },
    },
    validate: (b) => ((Array.isArray(b?.items) && b.items.length) || (Array.isArray(b?.contentHashes) && b.contentHashes.length) ? b : { error: 'require items or contentHashes: a non-empty array of proof envelopes or content-hashes' }),
    run: (i) => proofEnvelope('risk-attest', i, riskAttest(i), config.version),
  },
  {
    name: 'event-vol', path: '/api/event-vol', price: config.prices.eventVol, register: true,
    blurb: 'Options-implied expected move around an event (1σ + straddle E|ΔS| + prob-beyond) and event-isolation from the vol term structure — the number macro calendars don\'t give',
    inputSchema: {
      type: 'object', required: ['spot'],
      properties: {
        spot: { type: 'number' },
        atmIvPct: { type: 'number', description: 'ATM implied vol in % (or atmIv as decimal)' }, atmIv: { type: 'number' },
        daysToEvent: { type: 'number', description: 'days to the event/expiry (or T in years)' }, T: { type: 'number' },
        thresholdsPct: { type: 'array', description: 'move thresholds for prob-beyond (default [1,2,5])' },
        ivBeforePct: { type: 'number', description: 'event isolation: ATM IV of the expiry BEFORE the event' }, daysBefore: { type: 'number' },
        ivAfterPct: { type: 'number', description: 'event isolation: ATM IV of the expiry AFTER the event' }, daysAfter: { type: 'number' },
      },
    },
    validate: (b) => (Number(b?.spot) > 0 && (Number(b?.atmIvPct) > 0 || Number(b?.atmIv) > 0) && (Number(b?.daysToEvent) > 0 || Number(b?.T) > 0) ? b : { error: 'require spot>0, atmIv/atmIvPct, and daysToEvent/T' }),
    run: (i) => proofEnvelope('event-vol', i, eventVol(i), config.version),
  },
];

// ── AN UNRECOGNISED ENUM VALUE IS REFUSED, NOT SERVED ────────────────────────────────────────────
//
// The half the case-sensitivity work explicitly did NOT close. `side: "SHORT"` is repaired to `short`;
// `side: "banana"` matched no declared alternative, was passed through exactly as written, and
// `perpGate.js:29` read it as LONG. Same shape at `portfolioGate.js:30` (→ long) and
// `optionsRisk.js:32` (anything not `"put"` → call). The caller got a confident, self-checked, signed,
// billable answer about the OPPOSITE position, and every self-check passed, because a self-check
// verifies the book the engine chose rather than the book the caller described.
//
// WHY THIS IS A WRAPPER AND NOT NINE EDITS. Each service's own `validate` is about the fields that
// service reasons about; the enum rule is about every field ANY service declares, including ones added
// tomorrow. Written into each validator it would be nine places to forget; written here it is derived
// from `inputSchema` and cannot fall behind a schema it reads. Three of the four call sites that reach
// an engine on this host go through `s.validate` — the paid `/api/*` route (app.js:548) and both
// gated diag testers (app.js:410, app.js:425) — so all three close from this one line. The FOURTH is
// `handleRpc` in mcp.js, which never calls `validate()` at all; it carries the same guard explicitly,
// because a fix that covered three of four sites is the miss this repository has now made repeatedly.
//
// ORDER IS DELIBERATE: the service's own verdict FIRST. Only a body that validates today can be
// refused by this, so not one refusal message that a caller reads today changes wording — the blast
// radius is exactly the set of requests that were being answered wrongly.
//
// AND IT IS FREE. `err.status = 400` on the paid path is thrown from inside the x402 handler, which
// returns before `/settle` is ever called (x402.js:255-264) — the same path every other `bad_input`
// refusal takes. Verified rather than assumed, in gateU test 6.
for (const s of SERVICES) {
  const inner = s.validate;
  s.validate = (b) => {
    const v = inner(b);
    if (v && v.error) return v;
    const violations = enumViolations(s, b);
    return violations.length ? { error: enumRefusal(violations) } : v;
  };
}

// ── EVERY RESPONSE CARRIES ITS OWN TIMING ────────────────────────────────────────────────────────
//
// §2.3 of the paper promises `elapsedMs` on every response so a caller can hold the service to its
// own timing, and before this loop the nine services a caller most wants to time carried no such
// field on either surface. A wrapper for the same reason the enum guard above is one: all three call
// sites that reach an engine over HTTP — the paid `/api/*` route and both gated diag testers — go
// through `s.run`, so one line covers them and cannot fall behind a service added tomorrow. The
// fourth site, `handleRpc` in src/mcp.js, shares nothing with this file and carries the stamp
// explicitly.
//
// The value lands in the response's `proof`/`observation` block, never as a new top-level key.
// src/util/timing.js records why in full: the content hash is taken over the engine's result and the
// published recipe tells a caller to recompute over "this response WITHOUT its `proof` key", so a new
// top-level sibling would leave every published proof failing its own verification instruction. The
// stamp is taken around `s.run`, so a cached answer keeps the timing of the computation that produced
// it rather than reporting the cache lookup as if it were the work.
//
// AND IT STAYS VISIBLE TO THE GUARDS THAT READ IT. `gates/preflight.mjs` decides which handlers build
// a zk proof by stringifying `s.run` and matching on the source. Replacing the function with a closure
// made all twenty-two HTTP handlers stringify to this wrapper, so the grid guard silently stopped
// seeing any of them — measured: preflight's proof-emitting set collapsed from two entries to
// `[mcp:perp_gate]` alone, and its own "the proof-emitting set is the one that has been checked" line
// went red. That is a wrapper blinding a guard, which is this repository's most repeated defect, and it
// was caught only because that check exists. The original handler is therefore published on the
// wrapper so a source-reading check can see through it, and preflight reads BOTH bodies rather than
// swapping one for the other — a future wrapper that forgets to expose its inner function still
// collapses the set and still goes red.
for (const s of SERVICES) {
  const inner = s.run;
  s.run = (i, ctx) => timedRun(() => inner(i, ctx));
  s.run.unwrapped = inner;
}

export const byName = Object.fromEntries(SERVICES.map((s) => [s.name, s]));
