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

// ── Capability metadata (MCP 2025-06-18: title / annotations / outputSchema) ────────────────────────────
// outputSchema property sets mirror the REAL top-level keys each engine returns (captured by running the
// engines, not guessed). Engine-specific values stay description-only + additionalProperties:true, so the
// schema documents without over-constraining — structuredContent always validates.
const CHECKS_SCHEMA = { type: 'array', description: 'Ground-truth self-checks; the result is untrustworthy if any fails.', items: { type: 'object', additionalProperties: true } };
const PROOF_SCHEMA = {
  type: 'object',
  description: 'Verifiability envelope: echoed inputs, engine codeHash, contentHash of this exact result, self-checks, EIP-712 signature (EAS-ready). Re-run the open engine on `inputs` to reproduce the result byte-for-byte.',
  properties: {
    engine: { type: 'string', description: 'engine id' },
    codeHash: { type: 'string', description: 'build hash of the open-source engine sources (equals GET /build codeHash)' },
    contentHash: { type: 'string', description: 'hash of this exact result — recompute it to detect tampering' },
    allSelfChecksPass: { type: 'boolean', description: 'true when every ground-truth self-check passed' },
  },
  additionalProperties: true,
};
const outSchema = (description, props) => ({
  type: 'object',
  description,
  properties: {
    ok: { type: 'boolean', description: 'false when the engine rejected the input' },
    ...props,
    checks: CHECKS_SCHEMA,
    proof: PROOF_SCHEMA,
  },
  additionalProperties: true,
});
// All Quiver tools are pure risk computations: read-only, idempotent, non-destructive. openWorld marks the
// two that MAY fetch live venue data (Hyperliquid/dYdX) when a `symbol` is passed.
const annotate = (title, openWorld) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld });

const TOOLS = [
  {
    name: 'perp_gate',
    title: 'Perp Liquidation Gate',
    annotations: annotate('Perp Liquidation Gate', true),
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
        leverage: { type: 'number', description: 'position leverage (alternative to margin)' },
        maintMarginRate: { type: 'number', description: 'e.g. 0.0125; or pass maxLeverage (mmr = 0.5/maxLeverage)' },
        maxLeverage: { type: 'number', description: 'venue max leverage for the asset' },
        markPrice: { type: 'number', description: 'current mark; distance-to-liq measured from here' },
        fundingRateHourly: { type: 'number', description: 'hourly funding rate (Hyperliquid funds hourly)' },
        horizonHours: { type: 'number', description: 'horizon for the funding-drag estimate, in hours' },
      },
    },
    outputSchema: outSchema('Liquidation risk of one perpetual-futures position.', {
      liquidationPrice: { description: 'exact price at which the position liquidates' },
      moveToLiquidationPct: { description: 'adverse % move (from mark) that triggers liquidation' },
      effectiveLeverage: { description: 'notional / margin actually run' },
      initialMarginRatePct: { description: 'initial margin rate applied (%)' },
      maintenanceMarginRatePct: { description: 'maintenance margin rate applied (%)' },
      marginTier: { description: 'venue margin tier the notional falls into' },
      funding: { description: 'funding drag over the horizon (when a funding rate is given)' },
      model: { description: 'model assumptions used' },
    }),
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
    title: 'Cross-Venue Portfolio Gate',
    annotations: annotate('Cross-Venue Portfolio Gate', true),
    description: 'Cross-venue portfolio risk. Given positions across venues [{venue, asset|symbol, side, size, entryPrice, margin|leverage, maxLeverage|marginTiers}], returns TRUE net exposure per underlying, the leg that liquidates FIRST (the binding constraint), concentration (HHI / effective independent bets), and a correlated-crash stress counting how many legs liquidate SIMULTANEOUSLY when the market moves ±X% (correlation→1, the Oct-10-2025 crash regime). Pass Hyperliquid symbols to auto-fill live mark/leverage/margin-tiers. Self-checked (exposure reconciliation, per-leg liquidation invariant, nearest=min, monotone stress). Call to see whether independently-sized bets are secretly ONE bet that blows up together.',
    inputSchema: {
      type: 'object', required: ['positions'],
      properties: {
        positions: { type: 'array', description: 'legs: {venue, asset|symbol, side long|short, size, entryPrice, markPrice?, margin|leverage, maxLeverage|maintMarginRate|marginTiers}. A Hyperliquid symbol auto-fills live mark/leverage/tiers.' },
        shockScenariosPct: { type: 'array', description: 'correlated market moves (%) to stress; default [5,10,20,30]' },
      },
    },
    outputSchema: outSchema('Portfolio-level risk across venues: net exposure, binding liquidation, concentration, correlated stress.', {
      positionsCount: { description: 'number of legs analyzed' },
      totalGrossNotional: { description: 'sum of |notional| across legs' },
      totalNetNotional: { description: 'net notional after long/short netting' },
      netExposureByAsset: { description: 'TRUE net exposure per underlying (longs netted against shorts)' },
      concentration: { description: 'HHI + effective number of independent bets' },
      nearestLiquidation: { description: 'the leg that liquidates FIRST — the binding constraint' },
      correlatedShockStress: { description: 'per-scenario: how many legs liquidate simultaneously at a correlated ±X% move' },
      positions: { description: 'per-leg breakdown with each liquidation price' },
      model: { description: 'model assumptions used' },
    }),
    run: async (a) => {
      const positions = await enrichPortfolioLegs(a.positions);
      const input = { ...a, positions };
      return proofEnvelope('portfolio-gate', input, portfolioGate(input), config.version);
    },
  },
  {
    name: 'size_gate',
    title: 'Kelly Size Gate',
    annotations: annotate('Kelly Size Gate', false),
    description: 'Deterministic position sizing (fractional Kelly) + risk-of-ruin. Given an edge — discrete {winProb, winLossRatio} or continuous {expectedReturn, volatility} — and a bankroll, returns the fractional-Kelly size and the probability of ever drawing down to 50/75/90%. The direct antidote to over-betting: full Kelly rides thin edges to ruin; this defaults to quarter-Kelly. Call before sizing ANY position.',
    inputSchema: {
      type: 'object',
      properties: {
        winProb: { type: 'number', description: 'discrete mode: win probability in (0,1)' },
        winLossRatio: { type: 'number', description: 'discrete mode: net win/loss odds b' },
        expectedReturn: { type: 'number', description: 'continuous mode: excess return per period (mu)' },
        volatility: { type: 'number', description: 'continuous mode: volatility per period (sigma)' },
        bankroll: { type: 'number', description: 'bankroll in account units — recommended sizes are returned in the same units' },
        kellyFraction: { type: 'number', description: 'fraction of full Kelly to bet (default 0.25)' },
      },
    },
    outputSchema: outSchema('Fractional-Kelly position size with drawdown (risk-of-ruin) probabilities.', {
      hasEdge: { description: 'false when the edge is non-positive (bet nothing)' },
      mode: { description: 'discrete or continuous' },
      fullKellyFraction: { description: 'full-Kelly fraction of bankroll (the ruinous ceiling, not the recommendation)' },
      kellyFractionUsed: { description: 'fraction of full Kelly applied (default 0.25)' },
      recommendedBetFraction: { description: 'recommended bet as a fraction of bankroll' },
      recommendedSize: { description: 'recommended bet size in bankroll units' },
      riskOfRuin: { description: 'probability of ever drawing down to 50/75/90% of bankroll' },
      expectedLogGrowth: { description: 'expected log-growth rate at the recommended size' },
      impliedPortfolioVolPct: { description: 'portfolio volatility implied by the recommended size (%)' },
      leverage: { description: 'implied leverage of the recommended size' },
      note: { description: 'plain-language guidance' },
      model: { description: 'model assumptions used' },
    }),
    run: (a) => proofEnvelope('size-gate', a, sizeGate(a), config.version),
  },
  {
    name: 'exec_verify',
    title: 'Execution-Quality Verifier',
    annotations: annotate('Execution-Quality Verifier', false),
    description: 'Deterministic execution-quality / fair-fill verification. Given a completed swap (amountIn, amountOutRealized) plus either the pre-trade pool reserves+fee (constant-product) or a fair reference price, returns how many basis points the fill lost to ADVERSE execution (sandwich/MEV/stale) beyond the unavoidable fee + own price impact. Proves that a fill "within slippage tolerance" can still have been robbed. Call after a swap to detect being sandwiched.',
    inputSchema: {
      type: 'object', required: ['amountIn', 'amountOutRealized'],
      properties: {
        amountIn: { type: 'number', description: 'input amount actually sent' },
        amountOutRealized: { type: 'number', description: 'output amount actually received' },
        reserveIn: { type: 'number', description: 'pool reserve of input token, pre-trade (constant-product mode)' },
        reserveOut: { type: 'number', description: 'pool reserve of output token, pre-trade' },
        feeTier: { type: 'number', description: 'pool fee as fraction, e.g. 0.003' },
        fairPrice: { type: 'number', description: 'reference mode: fair out-per-in price at submit time' },
        slippageTolerancePct: { type: 'number', description: 'the slippage setting used, to demonstrate within-tolerance-yet-robbed' },
      },
    },
    outputSchema: outSchema('How much of a swap fill was lost to adverse execution (sandwich/MEV/stale), beyond honest costs.', {
      mode: { description: 'constant-product or reference-price mode' },
      midPrice: { description: 'pre-trade mid price' },
      honestFillPrice: { description: 'the fill price an honest execution would have produced' },
      realizedFillPrice: { description: 'the fill price actually received' },
      honestOut: { description: 'output an honest execution would have delivered' },
      unavoidableCostBps: { description: 'fee + own price impact — the honest, unavoidable cost (bps)' },
      adverseExecutionBps: { description: 'bps lost to ADVERSE execution beyond the honest cost' },
      adverseValueOut: { description: 'value lost to adverse execution, in output-token units' },
      verdict: { description: 'plain-language verdict' },
      note: { description: 'interpretation guidance' },
    }),
    run: (a) => proofEnvelope('exec-verify', a, execVerify(a), config.version),
  },
  {
    name: 'options_risk',
    title: 'Options Book Risk (Greeks + SPAN)',
    annotations: annotate('Options Book Risk (Greeks + SPAN)', false),
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
          description: 'option legs of the book',
          items: {
            type: 'object', required: ['type', 'strike', 'iv', 'quantity'],
            properties: {
              type: { type: 'string', description: 'call | put' }, strike: { type: 'number', description: 'strike price' },
              expiryDays: { type: 'number', description: 'days to expiry (or pass T in years)' }, T: { type: 'number', description: 'years (or expiryDays)' },
              iv: { type: 'number', description: 'implied vol decimal, e.g. 0.6' },
              quantity: { type: 'number', description: 'signed: + long, − short' },
              forward: { type: 'number', description: 'per-position forward (else shared)' },
            },
          },
        },
      },
    },
    outputSchema: outSchema('Aggregate greeks and SPAN-style scenario margin for an options book.', {
      positionsCount: { description: 'number of legs priced' },
      portfolioValue: { description: 'mark-to-model value of the book' },
      greeks: { description: 'aggregate delta/gamma/vega/theta/vanna/volga — each verified vs finite differences' },
      pnlPerUnderlyingPctMove: { description: 'first-order P&L per % move of the underlying' },
      spanMargin: { description: 'worst-case loss over the price×vol scenario grid (SPAN-style margin)' },
      positions: { description: 'per-leg pricing breakdown' },
      model: { description: 'Black-76 assumptions used' },
    }),
    run: (a) => proofEnvelope('options-risk', a, optionsRisk(a), config.version),
  },
  {
    name: 'lp_risk',
    title: 'LP Divergence-Loss Gate',
    annotations: annotate('LP Divergence-Loss Gate', false),
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
        capitalUsd: { type: 'number', description: 'position capital in USD — losses are also reported in USD' },
      },
    },
    outputSchema: outSchema('Impermanent loss / LVR vs fee yield for a liquidity position.', {
      concentrationFactor: { description: 'V3 concentration amplifier applied' },
      realizedIL: { description: 'closed-form impermanent loss at the realized price ratio' },
      expectedDivergence: { description: 'expected divergence loss / LVR over the horizon (−σ²T/8 law)' },
      feeVsDivergence: { description: 'net forecast and breakeven volatility vs the fee APR' },
      model: { description: 'model assumptions used' },
    }),
    run: (a) => proofEnvelope('lp-risk', a, lpRisk(a), config.version),
  },
  {
    name: 'treasury_risk',
    title: 'Treasury Depeg & Concentration',
    annotations: annotate('Treasury Depeg & Concentration', false),
    description: 'Stablecoin / on-chain treasury risk. Given a book of positions [{asset, amountUsd, apyPct, venue, chain, pegTarget, depegProbAnnual}], returns concentration (Herfindahl by asset/venue/chain + breaches over a limit), depeg stress (explicit scenarios + a worst-single-depeg scan), weighted and risk-adjusted yield. Self-checked: HHI == Σw², weights sum to 1, depeg-loss identity. Call to size a treasury\'s real risk — issuer/venue/chain concentration and depeg exposure — not just its headline APY.',
    inputSchema: {
      type: 'object', required: ['positions'],
      properties: {
        concentrationLimitPct: { type: 'number', description: 'flag any single exposure above this (default 25)' },
        depegFloor: { type: 'number', description: 'worst-single-depeg stress floor (default 0.90)' },
        depegScenarios: { type: 'array', description: '[{asset, price}] explicit depeg stresses' },
        positions: {
          type: 'array',
          description: 'treasury holdings',
          items: {
            type: 'object', required: ['asset', 'amountUsd'],
            properties: {
              asset: { type: 'string', description: 'stablecoin / asset symbol' }, amountUsd: { type: 'number', description: 'position size in USD' }, apyPct: { type: 'number', description: 'headline APY (%)' },
              venue: { type: 'string', description: 'custodian / protocol holding it' }, chain: { type: 'string', description: 'chain it lives on' }, pegTarget: { type: 'number', description: 'peg price (default 1.0)' }, depegProbAnnual: { type: 'number', description: 'annualized depeg probability estimate' },
            },
          },
        },
      },
    },
    outputSchema: outSchema('Concentration, depeg stress, and risk-adjusted yield of a stablecoin treasury.', {
      totalUsd: { description: 'total treasury size in USD' },
      concentration: { description: 'Herfindahl (HHI) by asset/venue/chain + limit breaches' },
      weightedApyPct: { description: 'holdings-weighted headline APY (%)' },
      depegStress: { description: 'explicit depeg scenarios + worst-single-depeg scan' },
      expectedAnnualDepegLossUsd: { description: 'expected annual loss from depeg probabilities (USD)' },
      riskAdjustedApyPct: { description: 'yield after expected depeg loss (%)' },
      verdict: { description: 'plain-language verdict' },
      model: { description: 'model assumptions used' },
    }),
    run: (a) => proofEnvelope('treasury-risk', a, treasuryRisk(a), config.version),
  },
  {
    name: 'risk_attest',
    title: 'Merkle Batch Attestation',
    annotations: annotate('Merkle Batch Attestation', false),
    description: 'Batch the content-hashes from many Quiver proof envelopes into ONE Merkle root plus per-item inclusion proofs, so a single on-chain anchor (your wallet\'s tx) attests all of them at once. Self-checked for completeness (every item verifies) and soundness (a non-member does not). Use to make a batch of risk computations cheaply and permanently attestable for audit/liability, without a chain write per computation.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', description: 'proof envelopes (uses proof.contentHash) or raw content-hashes (hex)' },
        contentHashes: { type: 'array', description: 'alternatively, raw content-hashes' },
      },
    },
    outputSchema: outSchema('One Merkle root + inclusion proofs attesting a batch of Quiver computations.', {
      merkleRoot: { description: 'the single root that attests every item' },
      leafCount: { description: 'number of items batched' },
      duplicateLeaves: { description: 'duplicate content-hashes detected in the batch' },
      algorithm: { description: 'hash/tree construction used' },
      attestations: { description: 'per-item inclusion proofs' },
      anchor: { description: 'EIP-712 (EAS-ready) attestation payload for the single on-chain anchor' },
      verify: { description: 'how to verify inclusion against the root' },
    }),
    run: (a) => proofEnvelope('risk-attest', a, riskAttest(a), config.version),
  },
  {
    name: 'event_vol',
    title: 'Event Implied-Move',
    annotations: annotate('Event Implied-Move', false),
    description: 'Options-implied expected move around a scheduled event (FOMC/CPI/earnings/etc.). Given spot, ATM implied vol, and days-to-event, returns the 1σ move, the straddle-implied expected ABSOLUTE move (risk-neutral E|ΔS|), and the probability of exceeding move thresholds. Given the vol term structure across the event (ATM IV of the expiry before vs after), it ISOLATES the event\'s own priced-in move (the Wright event-day technique). Self-checked: the straddle equals a numerical integral of |S_T−S₀|. This is the magnitude that macro calendars (which give only date + impact label) leave out.',
    inputSchema: {
      type: 'object', required: ['spot'],
      properties: {
        spot: { type: 'number', description: 'current spot price' }, atmIvPct: { type: 'number', description: 'ATM IV in % (or atmIv decimal)' }, atmIv: { type: 'number', description: 'ATM IV as a decimal (alternative to atmIvPct)' },
        daysToEvent: { type: 'number', description: 'days until the event' }, T: { type: 'number', description: 'years (or daysToEvent)' },
        thresholdsPct: { type: 'array', description: 'move thresholds (%) for probability-of-exceeding' },
        ivBeforePct: { type: 'number', description: 'ATM IV (%) of the expiry just BEFORE the event' }, daysBefore: { type: 'number', description: 'days to the before-event expiry' }, ivAfterPct: { type: 'number', description: 'ATM IV (%) of the expiry just AFTER the event' }, daysAfter: { type: 'number', description: 'days to the after-event expiry' },
      },
    },
    outputSchema: outSchema('Options-implied expected move around a scheduled event.', {
      spot: { description: 'spot the computation is anchored on' },
      atmIvPct: { description: 'ATM IV used (%)' },
      horizonDays: { description: 'horizon in days' },
      expectedMove: { description: '1σ move + straddle-implied expected |ΔS| (risk-neutral)' },
      probabilityMoveBeyond: { description: 'probability of exceeding each move threshold' },
      eventIsolation: { description: 'the event\'s own priced-in move, isolated from the term structure (when before/after IVs are given)' },
      method: { description: 'technique + assumptions used' },
    }),
    run: (a) => proofEnvelope('event-vol', a, eventVol(a), config.version),
  },
];

export const SERVER_INFO = { name: 'quiver-risk-brain', title: 'Quiver Risk Brain', version: config.version, description: 'Verifiable, deterministic risk computation for autonomous agents — cross-venue portfolio & liquidation, position sizing, execution-quality, options greeks/margin, LP/treasury/event risk — each answer carries a re-runnable, self-checked proof.' };

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
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, outputSchema, annotations })) } };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } };
      try {
        const out = await tool.run(params.arguments || {});
        const result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out?.ok === false };
        // MCP 2025-06-18: tools that declare outputSchema SHOULD return structuredContent on success.
        if (out && typeof out === 'object' && out.ok !== false) result.structuredContent = out;
        return { jsonrpc: '2.0', id, result };
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
