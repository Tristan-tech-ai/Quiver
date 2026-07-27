# API reference

*Appendices A and B of the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper).*

Base URL: `https://quiver-production-c3a8.up.railway.app`

Every paid route answers an unauthenticated request with the x402 `402` challenge **before any
business logic runs** — never a 404 and never a 400. Inputs go as query parameters on a GET or a JSON
body on a POST.

The nine deterministic risk engines are additionally reachable **free** over `POST /mcp` (Streamable
HTTP JSON-RPC) at a fair-use quota of three hundred tool calls per day per IP. `initialize` and
`tools/list` are unmetered so a client can always discover the surface.

---

## Endpoints

| Endpoint | Principal inputs | Headline outputs |
|---|---|---|
| `POST /api/options-desk` | `currency` (BTC/ETH/SOL), `focus` | `impliedView`, `distribution`, `gex`, `vrpModel`, `crossMarket` |
| `POST /api/calldata-x` | `data`, `to`, `from`, `chain`, or `typedData` | `alert`, `verdict`, `simulation`, `spenderReputation`, `targetContract` |
| `POST /api/chart-press` | `chain`, `address`, `interval`, `chartType`, `indicators`, `drawings` | `hostedUrl`, `imageBase64`, `facts` |
| `POST /api/tape-pulse` | `chain`, `address` | `read`, `microstructure`, `dataWindow` |
| `POST /api/poly-fill` | `market`, `side`, `usd`, `maxSlippagePct` | `fill`, `marketImpact`, `bookDepth`, `bookWalk` |
| `POST /api/poly-desk` | `wallet` | `positions`, `unrealizedPnl`, `movers` |
| `POST /api/updown-pulse` | `coin` (BTC/ETH) | `marketImplied`, `window`, `remainingRisk`, `edgeStance` |
| `POST /api/protocol-pulse` | `protocol` | `tvl`, `trends`, `drawdown`, `riskFlags`, `incidents` |
| `POST /api/macro-sentry` | `hours` | `events`, `nextEvent`, `impliedMove`, `calendarCoverage` |
| `POST /api/event-vol` | `currency`, `spot`, `iv`, `daysToEvent` | `oneSigma`, `straddle`, `probBeyond` |
| `POST /api/loop-digest` | `wallet`, `chain`, `cursor` | `diff`, `cursor`, `historyWindow`, `coverageNote` |
| `POST /api/lp-desk` | pool, range, capital | `fees`, `divergenceLoss`, `verdict`, `window` |
| `POST /api/token-scan` | `chain`, `address` | `washShare`, `evidence`, `confidence`, `dataWindow` |
| `POST /api/wallet-audit` | `chain`, `address` | `grade`, `wilsonInterval`, `sampleSize` |
| `POST /api/perp-gate` | `side`, `entryPrice`, `size`, `leverage` or `margin`, `maintMarginRate` — **or** `symbol` (+ optional `venue`) for a live read | `liquidationPrice`, `moveToLiquidationPct`, `positionStatus`, `funding` |
| `POST /api/portfolio-gate` | `positions[]`, optional `accountEquityUsd`, `betas` | `netExposureByAsset`, `nearestLiquidation`, `concentration`, `correlatedShockStress`, `crossMarginLiquidation` |
| `POST /api/size-gate` | `winProbability`+`netOdds`, or `expectedReturn`+`volatility`; `capitalUsd` | `recommendedFraction`, `riskOfRuin`, `drawdownLevels` |
| `POST /api/exec-verify` | `amountIn`, `amountOutRealized`, pool reserves + `feeBps` — **or** `fairPrice` | `adverseExecutionBps`, `verdict`, `slippageTolerance` |
| `POST /api/options-risk` | `currency`, `spot`, `positions[]` | `netGreeks`, `scenarioMargin`, `worstCase` |
| `POST /api/lp-risk` | `priceRatio`, or `volatility`+`horizonPeriods`; `feeAprPct` | `realizedIL`, `expectedDivergence`, `breakeven` |
| `POST /api/treasury-risk` | `holdings[]`, optional `correlations` | `hhi`, `depegStress`, `riskAdjustedYield` |
| `POST /api/risk-attest` | `items[]` (envelopes) or `contentHashes[]` | `merkleRoot`, `inclusionProofs`, `anchorCalldata`, `proof` |

Free, unmetered: `GET /build` (code identity, the Node version it runs on, and the hashing rule that
produced the identity), `GET /paper` (the technical documentation, typeset), `GET /paper/{1..6}` (the
same text as plain markdown, in six parts each small enough for one fetch), `GET /paper/full` (the
whole document in one response), `GET /`.

---

## Every status, and whether it costs you anything

**One rule matters before the table: a request the engine refuses is never settled.** When a result
carries `ok: false` the payment authorisation is not submitted and the reply carries a
`PAYMENT-RESPONSE` receipt reading `{ success: false, status: "not_charged" }`. You can probe a
service, get a refusal explaining what was missing, and pay nothing.

| Status | Body | Cause | Charged? |
|---|---|---|---|
| `200` | the result with its `proof` or `observation` envelope | Valid payment, valid input | **Yes** — the receipt carries the settlement transaction hash |
| `200` | `ok: false` with a reason and, where relevant, a coverage note | The data does not support an answer: a venue returned nothing, a window held too few observations, a smile could not be fitted. The service refuses rather than interpolating | **No** |
| `400` | `{ error: "bad_input", note: …, parserDetail: … }` | Input fails the schema, or the body is not parseable JSON. The `note` is **self-teaching on both paths**: it names what was missing, or that the body would not parse, then the service, its purpose, and every alternative required-field group, so the request can be fixed from the error alone. The parse case also returns `parserDetail`, the runtime's own message naming the character position — the one thing a caller cannot derive from its own request | **No** |
| `402` | the challenge | No payment header, or a malformed, expired or forged one. An invalid authorisation is re-challenged rather than answered, so a forged header cannot buy a computation | **No** |
| `404` | `{ error: "not_found", note: …, index: "/", docs: "/paper" }` | Unknown service. The reply names the route it did not find | **No** |
| `413` | `{ error: "bad_input", note: … }` | Body over the 16 kb limit, on a route with no payment gate in front of it. On a **paid** route an oversized body gets the 402 instead, because the payment gate is evaluated before the body is read — verified live at 40 kb | **No** |
| `429` | `{ error: "rate_limited", note: "max 60 requests/min per IP" }` | Applied *before* the payment surface, so it costs an abusive caller nothing and costs us nothing | **No** |
| `500` | `{ error: "engine_error", detail: … }` | An unhandled fault inside a service. Distinguished from a refusal on purpose: a refusal is a correct answer about missing data, this is a bug | **No** |
| `502` | `{ error: "facilitator_unreachable", detail: … }` | The payment facilitator did not answer. Reported as an upstream failure rather than folded into a generic 500, because the caller's next action differs: retry, or switch rails | **No** |

Exceeding the free MCP quota returns JSON-RPC error `-32000` whose message names the quota and points
at the paid route with both rails, rather than failing silently or degrading the answer.

---

## Reproducing the figures in the documentation

- **Options distribution and the martingale check.** Call `options-desk` with `currency=BTC` and read
  `impliedView[0].distribution`. `selfCheck.meanVsForwardPct` is the martingale residual and should be
  near zero on any well-formed chain.
- **The probability correction.** `probabilityLadder` reports both the corrected probability and
  `skewCorrectionPts`, the size of the smile-slope term at each level. Independently, fetch the
  Deribit ticker greeks for the same instruments and confirm delta to three or four decimals.
- **Signature and proxy safety.** Call `calldata-x` with an `approve(spender, MAX_UINT)` calldata and
  vary the spender between a known router and a wallet to see the verdict flip.
- **Tape microstructure.** `tape.medianGapSeconds` shows whether the read rests on a dense or a
  sampled feed; Kyle's lambda carries its own R² and confidence label.

A live number cannot be reproduced once the market has moved — read those as representative of the
method. The artifacts that reproduce *exactly* are in [checkable artifacts](checkable-artifacts.md).
