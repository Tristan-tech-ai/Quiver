// Service registry — one entry per priced x402 endpoint on this multi-service host.
// Each drives: the paid POST route, the gated /diag/scan tester, and the / index.
import { config } from './config.js';
import { tokenScan } from './engine/tokenScan.js';
import { walletAudit } from './engine/walletAudit.js';
import { tapePulse } from './engine/tapePulse.js';
import { chartPress } from './engine/chartPress.js';
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

export const SERVICES = [
  {
    name: 'tape-pulse', path: '/api/tape-pulse', price: config.prices.tapePulse,
    blurb: 'Live DEX tape microstructure read (buy/sell imbalance, net flow, whale prints) for a token',
    inputSchema: tokenIn, cacheKey: (b) => `tp:${b.chain}:${b.address}`, cacheTtl: 20000,
    validate: vToken, run: (i) => tapePulse(i.chain, i.address),
  },
  {
    name: 'chart-press', path: '/api/chart-press', price: config.prices.chartPress,
    blurb: 'Agent-controlled PNG chart: candles + indicators + drawings, two render tiers, numbers baked in',
    inputSchema: {
      type: 'object', required: ['chain', 'address'],
      properties: {
        chain: { type: 'string' }, address: { type: 'string' },
        interval: { type: 'string', description: '1m|5m|15m|1H|4H|1D' },
        lookback: { type: 'number', description: 'number of candles (10-300)' },
        quality: { type: 'string', description: 'fast (default, browserless) | full (high-detail, browser)' },
        chartType: { type: 'string', description: 'candles (default) | heikin | line | area | renko' },
        logScale: { type: 'boolean', description: 'logarithmic price axis' },
        indicators: { type: 'array', description: 'e.g. [{type:"EMA",period:20},{type:"BOLL"},{type:"RSI"},{type:"VOL"}]', items: { type: 'object' } },
        drawings: { type: 'array', description: 'e.g. [{type:"hline",price,label},{type:"rect",p1:{index,price},p2},{type:"fib",p1,p2,extension?},{type:"trendline",p1,p2},{type:"ray",p1,p2},{type:"channel",p1,p2,width},{type:"measure",p1,p2},{type:"vline",index},{type:"text",index,price,text}]', items: { type: 'object' } },
        annotations: { type: 'array', description: '[{index,price,text}]', items: { type: 'object' } },
        theme: { type: 'string', description: 'dark | light' },
      },
    },
    validate: (b) => { const v = vToken(b); if (v.error) return v; return { ...v, interval: b.interval, lookback: b.lookback, quality: b.quality, chartType: b.chartType, logScale: b.logScale, indicators: b.indicators, drawings: b.drawings, annotations: b.annotations, theme: b.theme }; },
    run: (i, ctx) => chartPress(i.chain, i.address, { interval: i.interval, lookback: i.lookback, quality: i.quality, chartType: i.chartType, logScale: i.logScale, indicators: i.indicators, drawings: i.drawings, annotations: i.annotations, theme: i.theme, brand: 'quiver', host: ctx.host }),
  },
  {
    name: 'poly-fill', path: '/api/poly-fill', price: config.prices.polyFill,
    blurb: 'Pre-trade fill simulation on a Polymarket market: executable avg price + slippage for $X',
    inputSchema: { type: 'object', required: ['market', 'usd'], properties: { market: { type: 'string', description: 'slug / conditionId / question text' }, side: { type: 'string', description: 'YES|NO' }, action: { type: 'string', description: 'buy|sell' }, usd: { type: 'number' }, maxSlippagePct: { type: 'number' } } },
    validate: (b) => (b?.market && Number(b?.usd) > 0 ? { market: String(b.market), side: b.side, action: b.action, usd: Number(b.usd), maxSlippagePct: b.maxSlippagePct != null ? Number(b.maxSlippagePct) : null } : { error: 'require { market, usd>0 }' }),
    run: (i) => polyFill(i),
  },
  {
    name: 'poly-desk', path: '/api/poly-desk', price: config.prices.polyDesk,
    blurb: 'A Polymarket wallet\'s live book: open positions, marks, unrealized PnL, movers',
    inputSchema: { type: 'object', required: ['wallet'], properties: { wallet: { type: 'string', description: 'Polymarket proxy wallet (0x…)' } } },
    validate: (b) => (EVM.test(String(b?.wallet || '').trim()) ? { wallet: String(b.wallet).trim() } : { error: 'wallet must be a 0x… address' }),
    run: (i) => polyDesk(i.wallet),
  },
  {
    name: 'options-desk', path: '/api/options-desk', price: config.prices.optionsDesk,
    blurb: 'Live crypto options intelligence from Deribit: IV term structure, skew, max pain, put/call OI, DVOL regime',
    inputSchema: { type: 'object', required: ['currency'], properties: { currency: { type: 'string', description: 'BTC | ETH | SOL' }, focus: { type: 'string', description: 'all | expiries' } } },
    cacheKey: (b) => `od:${String(b.currency).toUpperCase()}`, cacheTtl: 30000,
    validate: (b) => { const c = String(b?.currency || 'BTC').toUpperCase(); return ['BTC', 'ETH', 'SOL'].includes(c) ? { currency: c, focus: b?.focus } : { error: 'currency must be BTC, ETH, or SOL' }; },
    run: (i) => optionsDesk(i.currency, { focus: i.focus }),
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
    run: (i) => (i.typedData ? signatureX(i) : calldataX(i)),
  },
  {
    name: 'protocol-pulse', path: '/api/protocol-pulse', price: config.prices.protocolPulse,
    blurb: 'DeFi protocol health dossier (TVL trend, drawdown, chain concentration, hack history) + risk grade',
    inputSchema: { type: 'object', required: ['protocol'], properties: { protocol: { type: 'string', description: 'protocol name or slug (e.g. aave, lido, gmx)' } } },
    cacheKey: (b) => `pp:${String(b.protocol).toLowerCase()}`, cacheTtl: 300000,
    validate: (b) => (b?.protocol ? { protocol: String(b.protocol) } : { error: 'require { protocol }' }),
    run: (i) => protocolPulse(i.protocol),
  },
  {
    name: 'paw-check', path: '/api/paw-check', price: config.prices.pawCheck, register: false, // built + live but off-theme for Quiver; excluded from the ASP listing
    blurb: 'Is this food safe for a dog or cat? Deterministic vet-grounded safety verdict',
    inputSchema: { type: 'object', required: ['food'], properties: { food: { type: 'string' }, species: { type: 'string', description: 'dog | cat' } } },
    validate: (b) => (b?.food ? { food: String(b.food), species: b.species } : { error: 'require { food }' }),
    run: (i) => pawCheck(i),
  },
  {
    name: 'macro-sentry', path: '/api/macro-sentry', price: config.prices.macroSentry,
    blurb: 'High-impact US macro events (FOMC/CPI/NFP) in your lookahead window, to de-risk before a print',
    inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'lookahead window in hours (default 72)' } } },
    validate: (b) => ({ hours: b?.hours ? Number(b.hours) : 72 }),
    run: (i) => macroSentry(i),
  },
  {
    name: 'updown-pulse', path: '/api/updown-pulse', price: config.prices.upDownPulse,
    blurb: 'Fair-value edge read on the live Polymarket BTC/ETH up-or-down window vs market odds',
    inputSchema: { type: 'object', required: ['coin'], properties: { coin: { type: 'string', description: 'BTC | ETH' } } },
    validate: (b) => { const c = String(b?.coin || 'BTC').toUpperCase(); return ['BTC', 'ETH'].includes(c) ? { coin: c } : { error: 'coin must be BTC or ETH' }; },
    run: (i) => upDownPulse(i.coin),
  },
  {
    name: 'loop-digest', path: '/api/loop-digest', price: config.prices.loopDigest,
    blurb: 'Compact since-last-call diff of a wallet (new fills + PnL drift), cursor-based, for loop tops',
    inputSchema: { type: 'object', required: ['chain', 'wallet'], properties: { chain: { type: 'string' }, wallet: { type: 'string' }, cursor: { type: 'string', description: 'cursor from your previous call' } } },
    validate: (b) => { const v = vWallet({ chain: b?.chain, address: b?.wallet }); return v.error ? v : { chain: v.chain, wallet: v.address, cursor: b?.cursor || null }; },
    run: (i) => loopDigest(i),
  },
  // Veritape forensics (built + validated earlier; kept live, selective on registration)
  {
    name: 'token-scan', path: '/api/token-scan', price: config.prices.tokenScan, register: false,
    blurb: 'Manipulation-risk assessment for a token (wash/round-trip patterns) with evidence',
    inputSchema: tokenIn, cacheKey: (b) => `ts:${b.chain}:${b.address}`, cacheTtl: config.cacheTtlMs,
    validate: vToken, run: (i) => tokenScan(i.chain, i.address),
  },
  {
    name: 'wallet-audit', path: '/api/wallet-audit', price: config.prices.walletAudit, register: false,
    blurb: 'Track-record authenticity audit for a wallet (win-rate significance + wash cross-check)',
    inputSchema: tokenIn, cacheKey: (b) => `wa:${b.chain}:${b.address}`, cacheTtl: config.cacheTtlMs,
    validate: vWallet, run: (i) => walletAudit(i.chain, i.address),
  },
];

export const byName = Object.fromEntries(SERVICES.map((s) => [s.name, s]));
