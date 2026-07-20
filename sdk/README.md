# Quiver Risk Brain — SDK

The deterministic, self-verifying risk layer for autonomous agents. One import, every risk computation,
each answer carrying a proof you can check without trusting the provider.

## Why

LLM agents cannot do the money-math that keeps them solvent (an agent lost 62% of capital trading perps
autonomously; top financial models drop to ~0% accuracy on multivariate calculation). The risk layer that
exchanges and startups ship enforces *limits* but does not *compute* the numbers those limits are checked
against. Quiver computes them — liquidation, sizing, execution quality, options greeks/margin, LP divergence,
treasury concentration/depeg — and every result is **deterministic**, so it ships a proof: the exact inputs,
the code identity, a content hash, and a self-check against a ground-truth invariant. You re-run it; you
never have to trust us.

## Install & use

```js
import { createRiskBrain } from 'quiver-risk-brain';

const rb = createRiskBrain();                 // local mode: instant, free, no keys

// Don't get surprise-liquidated — pass a Hyperliquid symbol for live mark/funding/leverage:
const perp = await rb.perpGate({ symbol: 'BTC', side: 'long', size: 1, margin: 5000 });
// -> { liquidationPrice, moveToLiquidationPct, funding, proof }

// Don't over-bet — fractional Kelly + risk-of-ruin:
const size = rb.sizeGate({ winProb: 0.55, winLossRatio: 1.2, bankroll: 10000 });

// Options book net risk + SPAN-style margin:
const opt = rb.optionsRisk({ forward: 64000, positions: [
  { type: 'call', strike: 64000, expiryDays: 30, iv: 0.6, quantity: -1 },
  { type: 'put',  strike: 64000, expiryDays: 30, iv: 0.6, quantity: -1 },
]});

// Was I sandwiched? / LP divergence / treasury concentration+depeg:
rb.execVerify({ amountIn: 10, amountOutRealized: 19600, reserveIn: 1000, reserveOut: 2_000_000, feeTier: 0.003 });
rb.lpRisk({ volatility: 0.05, horizonPeriods: 30, feeAprPct: 20 });
rb.treasuryRisk({ positions: [{ asset: 'USDC', amountUsd: 80000 }, { asset: 'DAI', amountUsd: 20000 }] });
```

## Verify anything — no trust required

```js
rb.verify(perp);      // { valid, contentHashOk, selfChecksOk } — recomputes the hash + re-checks self-checks
rb.reproduce(perp);   // { reproduced: true } — RE-RUNS the open engine on the echoed inputs and compares
```

A tampered result changes the content hash and fails `verify()`; a wrong number fails its own self-check.
This is correctness you re-derive, not a signature you trust.

## Attest a batch for audit / liability

```js
const att = rb.attest({ items: [perp, size, opt] });   // one Merkle root + inclusion proofs
// Anchor att.merkleRoot on-chain (your wallet, one tx) to attest all of them at once.
rb.verifyInclusion(leaf, proof, root);                 // anyone checks a computation was in the batch
```

## Modes

- **local** (default) — imports the open engines and computes in-process. Instant, free, deterministic.
- **hosted** — `createRiskBrain({ mode: 'hosted' })` calls the x402-paid endpoints. Endpoints are
  payment-gated, so pass a `fetchImpl` that adds a `PAYMENT-SIGNATURE` header (the SDK never holds keys).

Available over a remote MCP endpoint too — 9 tools (`perp_gate`, `portfolio_gate`, `size_gate`, `exec_verify`,
`options_risk`, `lp_risk`, `treasury_risk`, `risk_attest`, `event_vol`) at
`https://quiver-production-c3a8.up.railway.app/mcp` — so any LangChain / CrewAI / Claude / Cursor agent can
call the risk brain directly.
