# Quiver

**A quant desk for AI agents.** Quiver is an Agentic Service Provider (ASP) that exposes ten priced
computations over the [x402](https://github.com/coinbase/x402) payment protocol and the
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) trustless-agent registry, spanning options analytics,
transaction-safety analysis, market microstructure, prediction-market execution, and protocol risk.

Autonomous trading and wallet agents can now pay for a service in-band over HTTP, but little worth paying
for exists, and most agent-facing tools return numbers that cannot be verified. Quiver implements the
methods a real trading desk or security team would run, and holds every output to a stated bar: **proven
by test, grounded in live data, and refused rather than faked when a signal cannot be grounded.**

- **Live endpoint:** https://quiver-production-c3a8.up.railway.app
- **Technical documentation:** https://quiver-production-c3a8.up.railway.app/paper
- **On-chain identity:** ERC-8004 agent `#5152` on X Layer (`eip155:196`)
- **Payment:** x402 v2 `exact` scheme, USD₮0 on X Layer, ~0.005–0.02 USDT per call

## Services

| Service | What it does | Price (USDT) |
|---|---|---|
| `options-desk` | Arbitrage-free options analytics from Deribit: risk-neutral distribution, greeks, dealer gamma (GEX), variance risk premium, options↔prediction cross-market | 0.01 |
| `calldata-x` | Transaction & EIP-712 signature safety: simulate a tx or decode a permit → DANGER/CAUTION/SAFE verdict, exact asset/approval effects, spender reputation, proxy detection | 0.005 |
| `chart-press` | Server-rendered PNG chart: candles/Heikin-Ashi/Renko/line/area, indicators, drawings, with the numbers baked into the image | 0.02 |
| `tape-pulse` | Live DEX tape microstructure: Kyle's λ, Amihud illiquidity, VPIN, order-flow imbalance | 0.01 |
| `poly-fill` | Polymarket order-book fill simulation + square-root market-impact model | 0.01 |
| `poly-desk` | A Polymarket wallet's live book: positions, marks, unrealised PnL | 0.01 |
| `updown-pulse` | Short-window BTC/ETH up-or-down market read (no fabricated directional edge, by design) | 0.01 |
| `protocol-pulse` | DeFi protocol risk flags from TVL trend, drawdown, chain concentration, and hack history | 0.01 |
| `macro-sentry` | High-impact US macro events (FOMC/CPI/NFP/PCE) in a lookahead window | 0.005 |
| `loop-digest` | Cursor-based diff of a wallet since the caller's last call — for agent loops | 0.01 |

## How a call works (x402)

1. An agent requests a paid route and receives `402 Payment Required` with a challenge (asset, amount,
   recipient, network).
2. The agent signs an EIP-3009 authorization and resends the request carrying it.
3. The server verifies and settles through a facilitator, then returns the structured result.

Every paid route answers an unauthenticated request with the `402` challenge before any business logic runs.

## Selected methodology

- **Options** are priced with Black-76 on the forward. The smile is fitted per expiry with **arbitrage-free
  raw SVI** (Gatheral; no-arbitrage butterfly and wing conditions enforced inside the objective), and the
  risk-neutral density is recovered by **Breeden–Litzenberger**. The probability ladder corrects the
  textbook `N(d2)` figure by the volatility-slope term (biased up to ~5 points on a skewed smile). The full
  distribution carries a **martingale self-check**: the recovered density's mean reproduces the forward to
  0.001% on live data.
- **Microstructure** computes Kyle's λ, Amihud illiquidity, and VPIN on equal-volume/period blocks — robust
  to the sub-cent dust that breaks a naive per-trade estimator.
- **Transaction safety** simulates via `eth_simulateV1` and, crucially, decodes **EIP-712 permit signatures**
  (Permit2 / EIP-2612) — the drainer vector a transaction simulator structurally cannot see.

Full derivations and 66 references are in the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper).

## Running it

```bash
npm install
cp .env.example .env    # fill in OKX dev-portal credentials for the data/facilitator API
npm test                # 39 model-free math tests (put-call parity, no-lookahead, martingale, …)
npm start               # serves on the configured port
```

The test suite is self-contained and requires no network access, so the model-free invariants can be
verified offline.

## License

MIT — see [LICENSE](LICENSE).
