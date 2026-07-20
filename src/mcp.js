#!/usr/bin/env node
// Quiver Risk Brain — MCP server. Exposes the deterministic risk engines (perp-gate, size-gate, exec-verify)
// as MCP tools so ANY MCP-compatible agent (Claude, LangChain, CrewAI, OpenAI Agents SDK) can call Quiver's
// verifiable risk computation directly. MCP is the standard tool protocol in 2026; this is the distribution
// unlock beyond OKX/X-Layer — the risk brain reaches the whole agent world through one server.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport). Zero new dependencies —
// in keeping with the codebase. Every tool returns the engine result + the T0 proof envelope (re-runnable,
// self-checked, content-hashed). Compute is deterministic and local: instant, no upstream data, and the
// self-checks mean the caller never has to trust us. stdout carries ONLY JSON-RPC; logs go to stderr.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { perpGate } from './engine/perpGate.js';
import { sizeGate } from './engine/sizeGate.js';
import { execVerify } from './engine/execVerify.js';
import { optionsRisk } from './engine/optionsRisk.js';
import { lpRisk } from './engine/lpRisk.js';
import { treasuryRisk } from './engine/treasuryRisk.js';
import { riskAttest } from './engine/riskAttest.js';
import { eventVol } from './engine/eventVol.js';
import { portfolioGate } from './engine/portfolioGate.js';
import { proofEnvelope } from './engine/proof.js';
import { enrichPerpInputs, enrichPortfolioLegs } from './adapters/hyperliquid.js';
import { config } from './config.js';

const TOOLS = [
  {
    name: 'perp_gate',
    description: 'Deterministic perpetual-futures risk. Given a position (entry, size, margin/leverage, maint-margin/maxLeverage), returns the exact liquidation price, the % adverse move to liquidation, effective leverage, and (if a funding rate is given) the funding drag. Pass a Hyperliquid `symbol` (e.g. BTC) to auto-fill live mark price, funding, and max leverage. Includes a self-check proving the liquidation invariant. Call this BEFORE opening or sizing any leveraged perp position — an agent that knows its true liquidation distance does not get surprise-liquidated.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'perp symbol (e.g. BTC) — auto-fills live markPrice, fundingRateHourly, and the margin source (Hyperliquid notional tiers or dYdX maintenance rate); also defaults entryPrice to the live mark' },
        venue: { type: 'string', enum: ['hyperliquid', 'dydx'], description: 'live-data venue (default hyperliquid)' },
        side: { type: 'string', enum: ['long', 'short'], description: 'default long' },
        entryPrice: { type: 'number', description: 'defaults to live mark if a symbol is given' },
        size: { type: 'number', description: 'position size in base units (or pass notional)' },
        notional: { type: 'number', description: 'position notional in quote/USD' },
        margin: { type: 'number', description: 'isolated margin posted (or pass leverage)' },
        leverage: { type: 'number' },
        maintMarginRate: { type: 'number', description: 'e.g. 0.0125; or pass maxLeverage (mmr = 0.5/maxLeverage)' },
        maxLeverage: { type: 'number', description: 'venue max leverage for the asset' },
        markPrice: { type: 'number', description: 'current mark; distance-to-liq measured from here' },
        fundingRateHourly: { type: 'number', description: 'hourly funding rate (Hyperliquid funds hourly)' },
        horizonHours: { type: 'number' },
      },
    },
    run: async (a) => {
      const e = await enrichPerpInputs(a);
      const { live, ...compute } = e;
      const r = perpGate(compute);
      if (live) r.live = live;
      return proofEnvelope('perp-gate', compute, r, config.version);
    },
  },
  {
    name: 'portfolio_gate',
    description: 'Cross-venue portfolio risk. Given positions across venues [{venue, asset|symbol, side, size, entryPrice, margin|leverage, maxLeverage|marginTiers}], returns TRUE net exposure per underlying, the leg that liquidates FIRST (the binding constraint), concentration (HHI / effective independent bets), and a correlated-crash stress counting how many legs liquidate SIMULTANEOUSLY when the market moves ±X% (correlation→1, the Oct-10-2025 crash regime). Pass Hyperliquid symbols to auto-fill live mark/leverage/margin-tiers. Self-checked (exposure reconciliation, per-leg liquidation invariant, nearest=min, monotone stress). Call to see whether independently-sized bets are secretly ONE bet that blows up together.',
    inputSchema: {
      type: 'object', required: ['positions'],
      properties: {
        positions: { type: 'array', description: 'legs: {venue, asset|symbol, side long|short, size, entryPrice, markPrice?, margin|leverage, maxLeverage|maintMarginRate|marginTiers}. A Hyperliquid symbol auto-fills live mark/leverage/tiers.' },
        shockScenariosPct: { type: 'array', description: 'correlated market moves (%) to stress; default [5,10,20,30]' },
      },
    },
    run: async (a) => {
      const positions = await enrichPortfolioLegs(a.positions);
      const input = { ...a, positions };
      return proofEnvelope('portfolio-gate', input, portfolioGate(input), config.version);
    },
  },
  {
    name: 'size_gate',
    description: 'Deterministic position sizing (fractional Kelly) + risk-of-ruin. Given an edge — discrete {winProb, winLossRatio} or continuous {expectedReturn, volatility} — and a bankroll, returns the fractional-Kelly size and the probability of ever drawing down to 50/75/90%. The direct antidote to over-betting: full Kelly rides thin edges to ruin; this defaults to quarter-Kelly. Call before sizing ANY position.',
    inputSchema: {
      type: 'object',
      properties: {
        winProb: { type: 'number', description: 'discrete mode: win probability in (0,1)' },
        winLossRatio: { type: 'number', description: 'discrete mode: net win/loss odds b' },
        expectedReturn: { type: 'number', description: 'continuous mode: excess return per period (mu)' },
        volatility: { type: 'number', description: 'continuous mode: volatility per period (sigma)' },
        bankroll: { type: 'number' },
        kellyFraction: { type: 'number', description: 'fraction of full Kelly to bet (default 0.25)' },
      },
    },
    run: (a) => proofEnvelope('size-gate', a, sizeGate(a), config.version),
  },
  {
    name: 'exec_verify',
    description: 'Deterministic execution-quality / fair-fill verification. Given a completed swap (amountIn, amountOutRealized) plus either the pre-trade pool reserves+fee (constant-product) or a fair reference price, returns how many basis points the fill lost to ADVERSE execution (sandwich/MEV/stale) beyond the unavoidable fee + own price impact. Proves that a fill "within slippage tolerance" can still have been robbed. Call after a swap to detect being sandwiched.',
    inputSchema: {
      type: 'object', required: ['amountIn', 'amountOutRealized'],
      properties: {
        amountIn: { type: 'number' },
        amountOutRealized: { type: 'number' },
        reserveIn: { type: 'number', description: 'pool reserve of input token, pre-trade (constant-product mode)' },
        reserveOut: { type: 'number', description: 'pool reserve of output token, pre-trade' },
        feeTier: { type: 'number', description: 'pool fee as fraction, e.g. 0.003' },
        fairPrice: { type: 'number', description: 'reference mode: fair out-per-in price at submit time' },
        slippageTolerancePct: { type: 'number', description: 'the slippage setting used, to demonstrate within-tolerance-yet-robbed' },
      },
    },
    run: (a) => proofEnvelope('exec-verify', a, execVerify(a), config.version),
  },
  {
    name: 'options_risk',
    description: 'Portfolio greeks (delta/gamma/vega/theta/vanna/volga) + SPAN-style scenario margin for an options book on Black-76. Given a list of legs {type, strike, expiryDays, iv, quantity(signed)} and a forward, returns aggregate greeks, first-order P&L per underlying move, and the worst-case loss over a price×vol grid. Self-checked: analytic greeks are verified against finite-difference derivatives of the repriced book. Call to size an options book\'s true net risk and margin — not the sum of per-leg notionals.',
    inputSchema: {
      type: 'object', required: ['positions'],
      properties: {
        forward: { type: 'number', description: 'shared forward price (or set per position)' },
        r: { type: 'number', description: 'discount rate, default 0' },
        scanRangePct: { type: 'number', description: 'SPAN price scan range, default 0.15' },
        volShiftVolPts: { type: 'number', description: 'SPAN vol shift in vol-points, default 10' },
        positions: {
          type: 'array',
          items: {
            type: 'object', required: ['type', 'strike', 'iv', 'quantity'],
            properties: {
              type: { type: 'string', description: 'call | put' }, strike: { type: 'number' },
              expiryDays: { type: 'number' }, T: { type: 'number', description: 'years (or expiryDays)' },
              iv: { type: 'number', description: 'implied vol decimal, e.g. 0.6' },
              quantity: { type: 'number', description: 'signed: + long, − short' },
              forward: { type: 'number', description: 'per-position forward (else shared)' },
            },
          },
        },
      },
    },
    run: (a) => proofEnvelope('options-risk', a, optionsRisk(a), config.version),
  },
  {
    name: 'lp_risk',
    description: 'Forward-looking liquidity-provision risk. Given a realized price ratio (for impermanent loss) and/or a volatility + horizon (for expected divergence / LVR), returns the closed-form IL, the expected −σ²T/8 divergence, and — with a fee APR — the net forecast and breakeven volatility (the vol above which fees no longer cover the bleed). Self-checked: the IL closed form is verified at the token level against explicit constant-product amounts. Call before providing liquidity to see whether the fee yield can plausibly beat the divergence loss.',
    inputSchema: {
      type: 'object',
      properties: {
        priceRatio: { type: 'number', description: 'realized P1/P0 for realized IL' },
        volatility: { type: 'number', description: 'per-period vol (decimal) for expected divergence' },
        horizonPeriods: { type: 'number', description: 'periods (default 1)' },
        feeAprPct: { type: 'number', description: 'annualized fee yield estimate' },
        periodsPerYear: { type: 'number', description: 'default 365' },
        concentrationFactor: { type: 'number', description: 'V3 amplifier ≥1 (default 1)' },
        capitalUsd: { type: 'number' },
      },
    },
    run: (a) => proofEnvelope('lp-risk', a, lpRisk(a), config.version),
  },
  {
    name: 'treasury_risk',
    description: 'Stablecoin / on-chain treasury risk. Given a book of positions [{asset, amountUsd, apyPct, venue, chain, pegTarget, depegProbAnnual}], returns concentration (Herfindahl by asset/venue/chain + breaches over a limit), depeg stress (explicit scenarios + a worst-single-depeg scan), weighted and risk-adjusted yield. Self-checked: HHI == Σw², weights sum to 1, depeg-loss identity. Call to size a treasury\'s real risk — issuer/venue/chain concentration and depeg exposure — not just its headline APY.',
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
              asset: { type: 'string' }, amountUsd: { type: 'number' }, apyPct: { type: 'number' },
              venue: { type: 'string' }, chain: { type: 'string' }, pegTarget: { type: 'number' }, depegProbAnnual: { type: 'number' },
            },
          },
        },
      },
    },
    run: (a) => proofEnvelope('treasury-risk', a, treasuryRisk(a), config.version),
  },
  {
    name: 'risk_attest',
    description: 'Batch the content-hashes from many Quiver proof envelopes into ONE Merkle root plus per-item inclusion proofs, so a single on-chain anchor (your wallet\'s tx) attests all of them at once. Self-checked for completeness (every item verifies) and soundness (a non-member does not). Use to make a batch of risk computations cheaply and permanently attestable for audit/liability, without a chain write per computation.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', description: 'proof envelopes (uses proof.contentHash) or raw content-hashes (hex)' },
        contentHashes: { type: 'array', description: 'alternatively, raw content-hashes' },
      },
    },
    run: (a) => proofEnvelope('risk-attest', a, riskAttest(a), config.version),
  },
  {
    name: 'event_vol',
    description: 'Options-implied expected move around a scheduled event (FOMC/CPI/earnings/etc.). Given spot, ATM implied vol, and days-to-event, returns the 1σ move, the straddle-implied expected ABSOLUTE move (risk-neutral E|ΔS|), and the probability of exceeding move thresholds. Given the vol term structure across the event (ATM IV of the expiry before vs after), it ISOLATES the event\'s own priced-in move (the Wright event-day technique). Self-checked: the straddle equals a numerical integral of |S_T−S₀|. This is the magnitude that macro calendars (which give only date + impact label) leave out.',
    inputSchema: {
      type: 'object', required: ['spot'],
      properties: {
        spot: { type: 'number' }, atmIvPct: { type: 'number', description: 'ATM IV in % (or atmIv decimal)' }, atmIv: { type: 'number' },
        daysToEvent: { type: 'number' }, T: { type: 'number', description: 'years (or daysToEvent)' },
        thresholdsPct: { type: 'array' },
        ivBeforePct: { type: 'number' }, daysBefore: { type: 'number' }, ivAfterPct: { type: 'number' }, daysAfter: { type: 'number' },
      },
    },
    run: (a) => proofEnvelope('event-vol', a, eventVol(a), config.version),
  },
];

export const SERVER_INFO = { name: 'quiver-risk-brain', version: config.version, description: 'Verifiable, deterministic risk computation for autonomous agents — cross-venue portfolio & liquidation, position sizing, execution-quality, options greeks/margin, LP/treasury/event risk — each answer carries a re-runnable, self-checked proof.' };

// Pure JSON-RPC 2.0 handler — returns the response object for a request, or undefined for a notification.
// Shared by BOTH transports: the stdio loop below (npm run mcp) and the remote Streamable-HTTP endpoint
// (app.js POST /mcp), so any MCP agent can reach Quiver locally OR by URL with identical behaviour.
export async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
    case 'notifications/initialized':
    case 'initialized':
      return undefined; // notification: no response
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } };
      try {
        const out = await tool.run(params.arguments || {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out?.ok === false } };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } };
      }
    }
    default:
      if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
      return undefined;
  }
}

export { TOOLS };

// stdio transport — runs ONLY when this file is the entrypoint (`npm run mcp`), never when app.js imports it.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    try { const resp = await handleRpc(msg); if (resp) process.stdout.write(JSON.stringify(resp) + '\n'); }
    catch (e) { if (msg?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }) + '\n'); }
  });
  process.stderr.write('quiver-risk-brain MCP server ready (stdio) — tools: perp_gate, portfolio_gate, size_gate, exec_verify, options_risk, lp_risk, treasury_risk, risk_attest, event_vol\n');
}
