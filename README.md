# Quiver

**The verifiable risk brain for autonomous agents.** Quiver is an Agentic Service Provider (ASP) that exposes **twenty-two priced, deterministic computations** over the [x402](https://github.com/coinbase/x402) payment protocol and the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) trustless-agent registry — from cross-venue perpetual liquidation and portfolio risk to options greeks, position sizing, execution-quality, LP / treasury / event risk, plus options analytics, transaction-safety, microstructure, and prediction-market intelligence.

Autonomous trading and wallet agents can pay for a service in-band over HTTP, but little worth paying for exists, and most agent-facing tools return numbers that cannot be verified. Quiver implements the money-math a real trading desk or security team would run — and because the risk engines are deterministic, **every answer carries a re-runnable, self-checked proof**: echoed inputs, a code hash, a content hash, and a ground-truth self-check. An agent can re-derive the number and prove it, rather than trust the provider.

- **Live endpoint:** https://quiver-production-c3a8.up.railway.app
- **Technical documentation:** [read online](https://quiver-production-c3a8.up.railway.app/paper) · [PDF (Google Drive)](https://drive.google.com/file/d/1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW/view?usp=sharing)
- **Remote MCP:** `https://quiver-production-c3a8.up.railway.app/mcp` — Streamable HTTP, 9 risk-brain tools, free (fair-use daily quota); callable by any MCP client (Claude, Cursor, …) — on the [official MCP registry](https://registry.modelcontextprotocol.io) as `quiver-risk-brain`
- **Use it in 5 minutes:** [QUICKSTART.md](QUICKSTART.md) · framework snippets (ElizaOS, LangChain, CrewAI, OpenAI Agents, Vercel AI SDK, Virtuals): [INTEGRATIONS.md](INTEGRATIONS.md)
- **Service status (independent):** [status page](https://cgn9npwmm0.execute-api.us-east-1.amazonaws.com/) — measured from AWS every 2 minutes, deliberately hosted off the service it watches, so the record stays reachable even when the host is not ([JSON](https://cgn9npwmm0.execute-api.us-east-1.amazonaws.com/?format=json))
- **On-chain identity:** ERC-8004 agent `#5152` on X Layer (`eip155:196`)
- **Payment (dual rail):** x402 v2 `exact` — USD₮0 on X Layer (`eip155:196`, OKX facilitator) **and** USDC on Base (`eip155:8453`, Coinbase CDP facilitator); ~0.005–0.05 per call

## The Risk Brain — deterministic, proof-carrying

| Service | What it does | Price |
|---|---|---|
| `perp-gate` | Perp liquidation price, distance-to-liq & funding drag, with a liquidation-invariant self-check (live Hyperliquid / dYdX, notional margin tiers) | 0.01 |
| `portfolio-gate` | Cross-venue **true** net exposure per underlying, the leg that liquidates **first**, concentration (HHI), and a correlated-crash stress | 0.05 |
| `size-gate` | Fractional-Kelly position size + risk-of-ruin, self-checked against the Kelly first-order condition | 0.01 |
| `exec-verify` | Fair-fill / sandwich check — bps lost to adverse execution, with a constant-product self-check | 0.01 |
| `options-risk` | Portfolio greeks (delta/gamma/vega/theta + second-order vanna/volga) + SPAN-style scenario margin — all six greeks verified vs finite differences | 0.02 |
| `lp-risk` | Forward-looking LP impermanent loss / LVR + fee breakeven, self-checked at the token level | 0.01 |
| `treasury-risk` | Stablecoin-treasury concentration (HHI), depeg **and correlated-depeg** stress, risk-adjusted yield | 0.02 |
| `risk-attest` | Merkle-batch proof hashes → one root + inclusion proofs + an EIP-712 (EAS-ready) attestation for a single on-chain anchor | 0.01 |
| `event-vol` | Options-implied expected move around a scheduled event (1σ + straddle E\|ΔS\| + prob-beyond) | 0.01 |

## Options, safety, microstructure & market intelligence

| Service | What it does | Price |
|---|---|---|
| `options-desk` | Arbitrage-free options analytics from Deribit: risk-neutral density, greeks, dealer gamma (GEX), variance risk premium, cross-market | 0.01 |
| `calldata-x` | Transaction & EIP-712 signature safety: simulate a tx or decode a permit → asset/approval effects, spender reputation, proxy detection | 0.005 |
| `lp-desk` | Concentrated-liquidity range reality-check: fees vs divergence loss, replayed on real on-chain swaps | 0.01 |
| `token-scan` · `wallet-audit` | Wash-trading share of DEX volume, with evidence · authenticity grade of a wallet's PnL and win-rate | 0.05 |
| `chart-press` | Server-rendered PNG chart (candles / indicators / drawings, numbers baked in) | 0.02 |
| `tape-pulse` | DEX tape microstructure: Kyle's λ, Amihud illiquidity, VPIN | 0.01 |
| `poly-fill` · `poly-desk` · `updown-pulse` | Polymarket fill simulation · wallet book & PnL · short-window up/down read (no fabricated edge) | 0.01 |
| `protocol-pulse` · `macro-sentry` · `loop-digest` | DeFi protocol risk flags · macro-event lookahead + implied move · wallet diff for agent loops | 0.005–0.01 |

## How a call works (x402)

1. An agent requests a paid route and receives `402 Payment Required` with a challenge (asset, amount, recipient, network) — one entry per rail (X Layer, Base).
2. The agent signs an EIP-3009 authorization and resends the request carrying it.
3. The server verifies and settles through the matching facilitator, then returns the structured result — with its proof envelope.

Every paid route answers an unauthenticated request with the `402` challenge before any business logic runs. Or call the **free MCP** at `/mcp` for the deterministic risk-brain tools — the adoption layer any MCP-speaking agent can use directly.

## The proof envelope

Because the risk engines are deterministic, every result carries `proof = { engine, codeHash, inputs, contentHash, selfChecks[], signature }`, plus two verification primitives:

- **`verify()`** — recompute the content hash + re-check every self-check (cheap; no re-run). A tampered result fails here.
- **`reproduce()`** — re-run the open engine on the echoed inputs and confirm byte-identical output. This is the strong guarantee: correctness you re-derive, not signature trust.

The batch attestation (`risk-attest`) is signed EIP-712 and EAS-ready, so a single on-chain anchor attests many computations at once.

## Running it

```bash
npm install
cp .env.example .env    # fill in OKX dev-portal (+ optional Coinbase CDP for the Base rail) credentials
npm test                # 274 model-free tests (put-call parity, no-lookahead, martingale, greek finite-difference, liquidation invariant, …) + 5 live-archive tests behind an RPC flag
npm start               # serves on the configured port
```

The core suite is self-contained and needs no network access, so the model-free invariants can be verified offline.

## License

MIT — see [LICENSE](LICENSE).
