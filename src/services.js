// Service registry — one entry per priced x402 endpoint on this multi-service host.
// Each drives: the paid POST route, the gated /diag/scan tester, and the / index.
import { config } from './config.js';
import { tokenScan } from './engine/tokenScan.js';
import { walletAudit } from './engine/walletAudit.js';
import { tapePulse } from './engine/tapePulse.js';
import { chartPress } from './engine/chartPress.js';
import { looksLikeCexSymbol } from './adapters/okx-market.js';
import { polyFill } from './engine/polyFill.js';
import { polyDesk } from './engine/polyDesk.js';
import { optionsDesk } from './engine/optionsDesk.js';
import { pawCheck } from './engine/pawCheck.js';
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

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
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

export const SERVICES = [
  {
    name: 'tape-pulse', path: '/api/tape-pulse', price: config.prices.tapePulse,
    blurb: 'Live DEX tape microstructure read (buy/sell imbalance, net flow, whale prints) for a token',
    inputSchema: tokenIn, cacheKey: (b) => `tp:${b.chain}:${b.address}`, cacheTtl: 20000,
    validate: vToken, run: async (i) => observationEnvelope('tape-pulse', i, await tapePulse(i.chain, i.address), config.version),
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
        quality: { type: 'string', description: 'fast (default, browserless) | full (high-detail, browser)' },
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
        theme: { type: 'string', description: 'dark | light' },
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
    inputSchema: { type: 'object', required: ['market', 'usd'], properties: { market: { type: 'string', description: 'slug / conditionId / question text' }, side: { type: 'string', description: 'YES|NO' }, action: { type: 'string', description: 'buy|sell' }, usd: { type: 'number' }, maxSlippagePct: { type: 'number' } } },
    validate: (b) => (b?.market && Number(b?.usd) > 0 ? { market: String(b.market), side: b.side, action: b.action, usd: Number(b.usd), maxSlippagePct: b.maxSlippagePct != null ? Number(b.maxSlippagePct) : null } : { error: 'require { market, usd>0 }' }),
    run: async (i) => observationEnvelope('poly-fill', i, await polyFill(i), config.version),
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
    inputSchema: { type: 'object', required: ['currency'], properties: { currency: { type: 'string', description: 'BTC | ETH | SOL' }, focus: { type: 'string', description: 'all | expiries' } } },
    cacheKey: (b) => `od:${String(b.currency).toUpperCase()}`, cacheTtl: 30000,
    // A REQUIRED subject parameter is never silently defaulted. A call whose params were dropped in
    // transit (the marketplace funnel does this) would otherwise receive a confident BTC options
    // dossier for a question it never asked, and be charged for it — indistinguishable, from the
    // caller's seat, from Quiver answering the wrong question. Refuse instead (free, per the billing
    // contract) and name the service the caller most likely wanted, so an agent can self-correct.
    validate: (b) => {
      const raw = b?.currency;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { error: 'currency is required (BTC | ETH | SOL). This endpoint returns crypto OPTIONS analytics only. For a DeFi protocol health check (e.g. aave, lido, gmx) use /api/protocol-pulse; for token safety use /api/token-scan.' };
      }
      const c = String(raw).trim().toUpperCase();
      if (!['BTC', 'ETH', 'SOL'].includes(c)) {
        return { error: `options-desk covers BTC, ETH and SOL only, not "${String(raw).trim().slice(0, 24)}". If you meant a DeFi protocol health check (e.g. aave, lido, gmx), use /api/protocol-pulse.` };
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
  {
    name: 'paw-check', path: '/api/paw-check', price: config.prices.pawCheck, register: false, // built + live but off-theme for Quiver; excluded from the ASP listing
    blurb: 'Is this food safe for a dog or cat? Deterministic vet-grounded safety verdict',
    inputSchema: { type: 'object', required: ['food'], properties: { food: { type: 'string' }, species: { type: 'string', description: 'dog | cat' } } },
    validate: (b) => (b?.food ? { food: String(b.food), species: b.species } : { error: 'require { food }' }),
    run: async (i) => observationEnvelope('paw-check', i, await pawCheck(i), config.version),
  },
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
        venue: { type: 'string', description: 'live-data venue: hyperliquid (default) | dydx' },
        side: { type: 'string', description: 'long | short' }, entryPrice: { type: 'number', description: 'defaults to live mark if a symbol is given' },
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
      const { live, ...compute } = e;                 // provenance is metadata, not a computation input
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
        return observationEnvelope('perp-gate', compute, r, config.version);
      }
      // Caller supplied every input: nothing was fetched, so the answer really is re-runnable.
      return proofEnvelope('perp-gate', compute, r, config.version);
    },
  },
  {
    name: 'portfolio-gate', path: '/api/portfolio-gate', price: config.prices.portfolioGate, register: true,
    blurb: 'Cross-venue portfolio: TRUE net exposure per underlying, the leg that liquidates FIRST, concentration, and a correlated-crash stress — the number no single-instrument tool gives, self-checked. Pass Hyperliquid symbols to auto-fill live mark/leverage/tiers.',
    inputSchema: {
      type: 'object',
      properties: {
        positions: { type: 'array', description: 'legs across venues: {venue, asset|symbol, side, size, entryPrice, markPrice?, margin|leverage, maxLeverage|maintMarginRate|marginTiers}. A Hyperliquid symbol auto-fills live mark/leverage/margin-tiers.' },
        account: { type: 'string', description: 'OR: a Hyperliquid account address (0x…) — the FULL live book (positions, margins, account equity, venue liquidation prices) is pulled keylessly and gated; no manual typing. Explicit positions take precedence.' },
        betaTier: { type: 'string', description: 'beta regime for the factor stress: mild | moderate | severe — cross-event VALIDATED tiers (pre-registered; H1 Spearman 0.657, H2 out-of-sample relative risk 14.3×). Default = the worst-case single-event Oct-10 table. Explicit betas override.' },
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
      if (live) {
        r.live = live;
        r.mathReproducibility = 'The risk MATH is deterministic and re-runnable: run the open portfolio-gate engine on observation.inputs (the frozen book snapshot fetched at observedAtUtc) and every risk number reproduces. The SNAPSHOT itself is a committed live observation — re-fetch Hyperliquid clearinghouseState for this address to independently check what the book looks like now.';
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
              type: { type: 'string', description: 'call | put' }, strike: { type: 'number' },
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

export const byName = Object.fromEntries(SERVICES.map((s) => [s.name, s]));
