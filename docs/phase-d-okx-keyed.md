# The keyed OKX five, measured: the premise was wrong, and four of five can be freed

**28 July 2026. Research, repo-only. Nothing here is served, deployed, or on chain. Nothing under
`src/engine/` was touched, so `q1-e1fa99d08887d6cc` does not move. No adapter was edited. No payment
was made.**

`PHASE_D_RESEARCH.md` §5 puts these five in the worst row of the hard-cases table:

> **OKX Web3 DEX (keyed)** | `tape-pulse`, `token-scan`, `wallet-audit`, `loop-digest`, `chart-press` |
> Worst case. Unsigned, **and** the buyer cannot re-fetch without their own HMAC credentials, so even
> the weak "go look yourself" fallback is unavailable.

The first clause is true and this work reconfirmed it. **The second clause is false**, and it is false for six
of the eight endpoints involved. It was never measured; it was inferred from the fact that Quiver
holds keys. The adapter that holds them says so in its own header comment, and the comment was read
past rather than tested:

> `src/adapters/okx-rest.js`: "OK-ACCESS auth **bypasses the endpoints' x402 pay-gate**."

If auth bypasses a pay-gate, then a caller without auth meets the pay-gate rather than a wall. That is
exactly what happens.

---

## 1. What the five actually read

Enumerated from `src/engine/*.js` and confirmed against live responses through the deployed service's
gated read-only REST proxy. Field names are measured, not paraphrased.

| service | keyed call | quantities consumed |
|---|---|---|
| `tape-pulse` | `market/trades` (500 rows) | `type`, `volume` (USD), `time`, `price`, `userAddress`, `txHashUrl`, `dexName`, `isFiltered`, `changedTokenInfo[].tokenSymbol` |
| | `market/price-info` | `price`, `priceChange1H`, `priceChange24H`, `volume24H`, `liquidity`, `holders` |
| `token-scan` | `market/trades` (500 rows) | `userAddress`, `volume`, `time`, `type`, `txHashUrl` |
| | `market/price-info` | `volume24H`, `liquidity`, `holders`, `txs24H`, `marketCap`, `tokenSymbol`, `tagList.communityRecognized` |
| | `token/advanced-info` | `suspiciousHoldingPercent`, `bundleHoldingPercent`, `sniperHoldingPercent`, `marketCap`, `stockProfile`, `tokenTags` |
| | `market/cluster-overview` | **nothing. 404 at v6, and the adapter stubs it to `{}`** |
| `wallet-audit` | `portfolio/overview` x2 (1M, 7D) | `winRate`, `buyTxCount`, `sellTxCount`, `buyTxVolume`, `sellTxVolume`, `realizedPnlUsd`, `top3PnlTokenPercent`, `tokenCountByPnlPercent{over500Percent, zeroTo500Percent, zeroToMinus50Percent, overMinus50Percent}`, `topPnlTokenList[].tokenContractAddress/tokenSymbol/tokenPnLUsd` |
| | (plus a full `token-scan` per top-3 token) | everything in the two `token-scan` rows above |
| `loop-digest` | `portfolio/dex-history` | `cursor`, `transactionList[].{amount, pnlUsd, price, time, tokenContractAddress, tokenSymbol, type, valueUsd, marketCap}` |
| `chart-press` (DEX) | `market/candles` | `[ts, o, h, l, c, vol, volUsd, confirm]` |
| | `market/price-info` | `price`, `priceChange24H`, `volume24H`, `liquidity`, `holders` |
| | `market/trades` (2 rows) | `changedTokenInfo[].tokenSymbol`, for symbol resolution only |
| `chart-press` (CEX) | `okx.com/api/v5/market/candles` | **already public and unkeyed** |

Two things fall out of the enumeration before any network call. `cluster-overview` is a 404 at v6 and
the adapter returns `{}`, so `token-scan`'s holder-funding prior is **always absent in production**,
not sometimes absent. And `loop-digest`'s row shape has no transaction hash in it, which turns out to
matter more than anything else about it (§7).

---

## 2. Six of eight endpoints answer an uncredentialed caller

`probe-unkeyed.mjs` called every endpoint with no `OK-ACCESS-*` headers at all. this work hold no OKX
credentials on this machine, so this is literally the buyer's position, not a simulation of it.

| endpoint | unkeyed status | x402 price | used by |
|---|---|---|---|
| `market/trades` | **402 + x402 v2 envelope** | `100` atomic = **$0.0001** | tape-pulse, token-scan, chart-press |
| `market/price-info` (POST) | **402** | `200` = **$0.0002** | tape-pulse, token-scan, chart-press |
| `token/advanced-info` | **402** | `200` = **$0.0002** | token-scan |
| `market/candles` | **402** | `100` = **$0.0001** | chart-press |
| `portfolio/overview` | **402** | `200` = **$0.0002** | wallet-audit |
| `portfolio/recent-pnl` | **402** | `200` = **$0.0002** | none of the five |
| `portfolio/dex-history` | **401, code `50103`** | **not payable** | **loop-digest** |
| `market/holders` | **404** | n/a | none of the five |

The 402 body is a complete x402 v2 payment requirement, not a marketing redirect:

```
scheme "exact", network "eip155:196" (X Layer), maxTimeoutSeconds 86400,
payTo 0x0dedc3c5e15bee45166924ea5b02f54a35b1f9c6,
assets USDG 0x4ae46a509f6b1d9056937ba4500cb143933d2dc8 and USD₮0 0x779ded0c9e1022225f8e0630b35a9b54be713736,
extra.transferMethod "eip3009",
billing.payPerUse.available true, "You can continue paying per request via x402."
```

Both assets return `decimals = 6` from `eth_call 0x313ce567` on X Layer (measured), so `100` atomic is
one ten-thousandth of a dollar. OKX's own documentation corroborates the mechanism: "No registration
or OAuth required, pay directly via API using tokens."

**What this costs a buyer who wants to re-fetch a whole answer.** Quiver's own list prices are from
`src/config.js`.

| service | endpoints to re-fetch | x402 cost | Quiver price | cost as share of price |
|---|---|---|---|---|
| `chart-press` (CEX) | none, the source is public | **$0** | $0.02 | **0%** |
| `tape-pulse` | trades + price-info | **$0.0003** | $0.01 | 3.0% |
| `chart-press` (DEX) | candles + price-info + trades | **$0.0004** | $0.02 | 2.0% |
| `token-scan` | trades + price-info + advanced-info | **$0.0005** | $0.05 | 1.0% |
| `wallet-audit` | overview x2 + up to 3 token-scans | **$0.0019** | $0.05 | 3.8% |
| `loop-digest` | dex-history | **not purchasable at any price** | $0.01 | n/a |

The weak fallback §5 declared unavailable costs between one and four percent of the answer's price for
four of the five services, and nothing at all for the CEX half of the fifth. It is unavailable for
exactly one service, `loop-digest`, and §9 says why that one is genuinely stuck.

**This is a re-fetch, not a verification.** Paying x402 gets a fresh read from the same party, taken at
a later instant. It proves nothing about the bytes the service saw. It is worth this much space only
because §5 claimed it was impossible and priced the whole row as hopeless on that basis.

---

## 3. OKX signs nothing, and the retired oracle is still retired

Every unkeyed response was scanned for headers and body keys matching
`sign|signature|proof|attest|pubkey|certificate|merkle|ecdsa|ed25519|secp|digest|hmac|seal`.

| surface | signature headers | signature fields in body |
|---|---|---|
| all eight v6 DEX endpoints, unkeyed 402/401/404 | **none** | **none** |
| all six keyed 200 responses, full top-level field enumeration | n/a (see below) | **none** |
| `okx.com/api/v5/market/candles`, public 200 | **none** | **none** |
| `okx.com/api/v5/market/ticker`, public 200 | **none** | **none** |

The retired oracle stays retired, and the discriminating control from §2 of the earlier research
reproduces exactly:

| route | status |
|---|---|
| `/api/v5/market/open-oracle` | **404** |
| `/api/v5/market/oracle` | **404** |
| `/api/v5/market/this-route-does-not-exist` (control) | **404**, byte-identical shape |
| `/api/v6/dex/market/this-route-does-not-exist` (control) | **404** |
| `/api/v6/dex/market/portfolio/dex-history`, no key | **401 `50103`**, the gated shape |

A removed route and a gated route are distinguishable, and the oracle routes are in the removed class.

**One gap this work could not close, stated rather than papered over.** The instrument available to me returns
the keyed response *body* but not its *headers*, so "no signature header on a keyed 200" is inference
from the same gateway's unkeyed 402s and public 200s, not direct measurement. The body claim is
measured: this work enumerated every top-level field of all six keyed 200s and none matches the pattern.
Closing the header gap needs either an x402 payment or an echo route, and this work did neither.

**OKX's only cryptographic attestation product is Proof of Reserves**, a zk-STARK over exchange
account balances. It publishes nothing about a DEX tape, a candle, a wallet's PnL, or a holder count.
It is not a near miss for this problem; it is a different problem.

---

## 4. The HMAC is evidence of a request, and can never be evidence of a response

`src/okxsign.js` computes the whole of it:

```js
const prehash = timestamp + method.toUpperCase() + requestPath + body;
const sign = crypto.createHmac('sha256', config.okxSecretKey).update(prehash).digest('base64');
```

Three properties settle the question, and none of them is about implementation quality.

**The signed message does not contain the response.** The prehash is timestamp, method, path and
request body. The response has not been produced when the signature is computed. No construction over
this signature can bind bytes that did not exist when it was made.

**The key is symmetric, and Quiver holds it.** HMAC-SHA256 with a shared secret proves only that
someone holding the secret produced the tag. OKX can produce it and so can Quiver. A third party
handed the tag learns that one of two parties made it, and Quiver is the party with the motive. A
signature that the claimant could have forged is not evidence about the claimant.

**Nothing signs in the return direction.** §3 measured this: zero signature material on any response.

So the transcript is `Quiver asks -> OKX answers`, where the ask is authenticated to a secret Quiver
also knows and the answer is authenticated by nothing. **There is no construction that makes a request
signature third-party meaningful about a response**, because the response is outside the signed
message and the key is not exclusive to the party being trusted. This is not a limit of effort. It is
what a symmetric tag over a request means.

The only mechanisms that would change it are the ones the earlier research already surveyed and
costed: a TEE attesting the transport, or zkTLS over the session. Both prove OKX said it. Neither
proves it is true, and for derived quantities like `winRate` that distinction is the entire question.

---

## 5. What a free public source reproduces, measured

The lead worth attacking hardest was that most of this is derived from public chain state. It largely
holds, and it fails in specific places that are worth naming exactly.

**OKX has no public unkeyed DEX surface of its own.** `api/v5/dex/*` returns `50103`, and the
`priapi` web paths 404 from a server-side fetch. So a substitute must come from a third party or from
the chain, and it will be a *different measurement of the same market*, never the same bytes.

### 5.1 Price agrees. Everything aggregated does not.

Near-simultaneous reads, keyed OKX `price-info` against GeckoTerminal and DexScreener, both free and
unkeyed.

| quantity | worst divergence measured | verdict |
|---|---|---|
| **spot price** | GeckoTerminal **0.540%**, DexScreener **0.599%** (6 tokens) | **replaceable** |
| market cap | ~2% typical, with a trap: DexScreener's `fdv` fallback read 2x OKX on AERO | replaceable with care |
| **volume 24h** | GeckoTerminal **+47.0%**, DexScreener **-22.5%** | **not the same quantity** |
| **liquidity** | GeckoTerminal **-48.8%**, DexScreener **-69.8%** | **not the same quantity** |
| **holders** | neither source publishes it | **no free API substitute** |

Liquidity and 24h volume are venue-scope and methodology decisions (which pools, which side, which
dust filter), not observations. The divergence is not noise to be tightened; two honest indexers
legitimately differ. This is the same class of problem the earlier research identified for DefiLlama's
TVL.

### 5.2 Candles agree on price and disagree on volume

Keyed OKX token-level hourly candles against GeckoTerminal's free pool-level OHLCV, aligned by
timestamp. 39 aligned bars over 4 tokens.

| token | top pool share of volume | aligned bars | close, median diff | close, worst diff | bar volume, median diff |
|---|---|---|---|---|---|
| PEPE | 0.546 | 9 | 0.0154% | 0.274% | -20.8% |
| BRETT | 0.871 | 10 | 0.0192% | -0.602% | -13.7% |
| CAKE | 0.448 | 10 | -0.0159% | -0.111% | -55.2% |
| BONK | 0.733 | 10 | 0.251% | -0.778% | **+1370%** |

**Worst close divergence across all 39 bars is 0.778%.** The drawn series, which is what `chart-press`
actually renders and what `facts.high` / `facts.low` are computed from, is reproducible from a free
source to well under one percent.

Bar volume is not, and BONK's `+1370%` is not a scale artifact. It is the keyed source being wrong,
which §8 returns to.

### 5.3 The tape reproduces the verdict, not the dollar magnitudes

`tape-pulse` run against the full keyed 500-trade tape, versus the same estimators recomputed on
GeckoTerminal's free pool tape restricted to the same wall-clock window.

| token | OKX window | public window | OKX buyImbalance | public buyImbalance | abs diff | verdict match |
|---|---|---|---|---|---|---|
| PEPE | 753.6 min / 454 trades | 753.0 min / 276 trades | 0.426 | 0.434 | **0.0080** | both BALANCED |
| BRETT | 632.8 min / 447 trades | 624.0 min / 241 trades | 0.521 | 0.504 | **0.017** | both BALANCED |
| CAKE | 32.4 min / 479 trades | 28.0 min / 48 trades | 0.530 | 0.558 | **0.028** | both BALANCED |
| BONK | 5599 min / 500 trades | 63.3 min / 300 trades | 0.446 | 0.456 | **0.0095** | both BALANCED |

**The published verdict matched 4 of 4, and buy imbalance agreed to within 0.028 absolute.**

Two honest caveats. Dollar magnitudes did **not** track: `netFlowUsd` was -40,191 against -29,945 on
PEPE and -36,677 against -939 on BONK, because the public tape covers one pool and the keyed tape
covers the token. And the BONK row is **not window-matched**: GeckoTerminal's 300-trade cap reaches
back 63 minutes against OKX's 5,599, so that particular agreement is partly luck and should not be
quoted as if the two measured the same interval.

---

## 6. The chain itself, and what reading it costs

### 6.1 Most free public RPCs will not serve the window

Measured across 22 endpoints, probing an `eth_getLogs` 800 blocks deep into a 12-hour lookback.

| chain | endpoints tried | served the deep window |
|---|---|---|
| Ethereum | 11 | **2** (`eth.drpc.org`, `rpc.mevblocker.io`) |
| Base | 6 | **1** (`base.drpc.org`) |
| BSC | 5 | **0** |

The rest refuse with `Archive requests require a personal token`, `limited to 0 - 50 blocks range`,
`up to a 10 block range`, or a rate-limit page. The project's own `evmrpc.js` list is three-for-three
in the refusing group on Ethereum. "Just read the chain" is true and is not frictionless: it works on
a minority of endpoints and the working set has to be discovered by measurement.

### 6.2 Where it works, the reconstruction agrees

PEPE/WETH Uniswap V2 pool, 753-minute window, Swap events decoded from raw logs on a free public RPC
with no key of any kind.

| source | trades | buy imbalance (USD) | tape volume USD | credentials |
|---|---|---|---|---|
| **raw chain logs** | **274** | **0.4377** | **226,428** | **none** |
| GeckoTerminal free API | 276 | 0.434 | 226,760 | none |
| OKX keyed, all pools | 454 | 0.426 | 272,480 | HMAC |

Chain logs against GeckoTerminal: **0.7%** on trade count, **0.15%** on volume, **0.0037** absolute on
imbalance. GeckoTerminal is a faithful index of that pool, and the chain confirms it independently.

**Cost: 7 RPC calls, 221.7 KB, 7.7 seconds**, for one pool over 12.5 hours.

### 6.3 Holder count is the one that is genuinely expensive

`holders` has no free API substitute (§5.1) and is reconstructible only by replaying every `Transfer`
since deployment. Measured density over a 201-block sample was 0.8 logs/block and 0.5 KB/block.
**Extrapolated** across PEPE's 8,585,576-block history:

| | extrapolated |
|---|---|
| Transfer logs | ~6,450,000 |
| bytes | ~3.9 GB |
| `eth_getLogs` calls at 800 blocks each | ~10,700 |
| wall clock at the measured 7.7s/3,765-block rate | **~4.9 hours** |

Information-theoretically available. Operationally not something a buyer does to check one answer.
Label it an estimate; only the 201-block sample and the 7.7-second rate are measured.

---

## 7. The cheapest win is already sitting in the responses

Every `trades` row carries `txHashUrl`, an on-chain transaction hash, and `tape-pulse` already
publishes three of them in `read.whalePrints[].tx` alongside the side, USD size and wallet it claims
for each. `token-scan` publishes the same hashes in `evidence[].sampleTxs`.

**That makes the delivered answer checkable without re-fetching anything from OKX.** Not a fresh read
of a moving market: the exact rows the buyer paid for.

`verify-rows3.mjs` took the three whale prints from a live `tape-pulse` answer, pulled each receipt
from a free public RPC, matched the swap legs per pool, and priced the counter-leg with the free
unkeyed OKX v5 history-candles at the trade's own block timestamp.

| published claim | tx succeeded | sender matches | side matches | USD divergence |
|---|---|---|---|---|
| sell $10,607.33, Uniswap V2 | yes | yes | yes | **-0.23%** |
| sell $7,826.28, Uniswap V2 | yes | yes | yes | **+0.04%** |
| sell $7,385.78, routed over 4 pools | yes | yes | yes | **-0.03%** |

**3 of 3 reconcile. Worst USD divergence 0.23%. Total cost 6 RPC calls, no credentials, no OKX
access.** About two calls per verified row.

**The verifier had to be fixed twice before it could fail correctly, and that is the part worth
recording.** Version one matched ERC-20 transfers against the sending EOA and reported
`sideMatches=false, usdDiff=-100%` on all three, because routed swaps move tokens through a router and
never touch the EOA. The side field was a defaulted branch, not a measurement, so the check was
incapable of being right. Version two matched per-transaction rather than per-pool and mixed WETH with
USDT units on the 4-hop route, producing a confident `-72.64%`. Only version three, keyed on the pool
as the invariant, produced numbers that mean anything. Two rounds of a verifier returning decisive
wrong answers about correct data, which is precisely the failure mode `VERIFIER_DISCIPLINE` describes.
Had this work stopped at version one, this document would have accused OKX of fabricating trade sides.

---

## 8. The cross-read is not just a substitute, it is a detector

The measurements caught three places where the **keyed** source is the one that is wrong. This is the
strongest argument for the public path, and it is an argument the "OKX is authoritative" framing hides.

**BONK volume is broken.** Keyed `price-info` returned `volume24H = 0.00` for BONK while GeckoTerminal
reported $670,382 and DexScreener $1,285,880. Keyed hourly candles reported $130 to $2,206 of USD
volume per bar on a pool that carries 73.3% of the token's volume and that GeckoTerminal measured at
$9,614 to $25,456 over the same bars.

**`portfolio/overview` reports zero trades for wallets OKX itself says are trading.** Three wallets
appeared as `userAddress` on `chainIndex: "1"` in trade rows **OKX's own keyed `trades` endpoint
returned**. this work verified all three on chain: transaction succeeded, sender equals the named wallet, swap
executed against the PEPE pool, within the last 12.5 hours.

| wallet | `portfolio/overview` chainIndex 1 | `dex-history` rows |
|---|---|---|
| `0x5b5871bfae9e0fa8ca8a6dddf844e5b09c2e0819` | **0 buys / 0 sells, winRate 0** | 0 |
| `0xeefa4e269c6dd0ee1f1fb04bfa4159c2d76f1516` | **0 buys / 0 sells, winRate 0** | 0 |
| `0x5b43453fce04b92e190f391a83136bfbecedefd1` | **0 buys / 0 sells, winRate 0** | 2 |

**OKX contradicts itself here**, on the same chain index, within minutes. No external source is even
needed to establish it.

This lands directly on `wallet-audit`, which refuses on `txs === 0` with:

> "The fetch succeeded but this wallet has zero DEX trades in the window, there is no track record to
> grade (not a failure, just an empty history)."

For these three wallets **that sentence is measurably false**. They have DEX trades in the window. The
code already guards the outage case (`DATA_UNAVAILABLE` when the fetch rejects) and correctly refuses
absence-as-success at that level. The same failure recurs one level down: an **index gap** is being
reported as a **genuine empty history**. A single free RPC scan for recent swaps by that address
distinguishes the two, and the honest note is "OKX's portfolio index returned no trades for this
wallet, which can mean no activity or a wallet this index does not cover".

---

## 9. Verdicts

**`chart-press`: freed.** The CEX path was never keyed. It reads `okx.com/api/v5/market/candles`
unauthenticated and already ships an executable recheck URL that a buyer can paste into a browser.
The DEX path re-fetches for $0.0004 and its drawn series reproduces from a free source to a **worst
0.778%** on close. `facts.high` and `facts.low` are computed from that same drawn series, so they
inherit the bound.

**`tape-pulse`: freed, with magnitudes qualified.** The verdict and `buyImbalance` reproduce from a
free public source (**worst 0.028 absolute, 4 of 4 verdicts matched**) and from raw chain logs
(**0.0037 absolute** against GeckoTerminal on the three-way check). Every whale print reconciles to
chain within **0.23%** for about two RPC calls. `netFlowUsd` and `tapeVolumeUsd` do **not** reproduce
from a single-pool public tape and must not be claimed to.

**`token-scan`: partially, and the gap is `advanced-info`.** Trades and `price-info` are replaceable or
purchasable. `suspiciousHoldingPercent`, `bundleHoldingPercent` and `sniperHoldingPercent` are OKX
proprietary classifier outputs. No public source publishes them, no methodology is documented, and
they cannot be recomputed from chain state without reimplementing an undisclosed classifier. They
carry 0.10 of the risk weight, so the other 0.90 is on reproducible ground. Separately,
`cluster-overview` is a 404 and contributes nothing in production, which should be said rather than
implied by an empty object.

**`wallet-audit`: partially, and the gap is not the credential.** `portfolio/overview` is x402-payable,
so re-fetching costs $0.0019. But `winRate`, `realizedPnlUsd` and `top3PnlTokenPercent` are **derived
PnL accounting**: they depend on cost-basis convention, on what counts as a position, and on which
fills the index saw. No free source publishes wallet PnL. Reconstructing it means choosing an
accounting method, and a different honest method gives a different honest number. This is the
DefiLlama-TVL problem with a wallet instead of a protocol. And per §8 the inputs are measurably wrong
for active Ethereum wallets, which is the more urgent finding.

**`loop-digest`: not replaceable. This is the real worst case, and it is one service, not five.**
`portfolio/dex-history` is the only one of the eight that refuses an uncredentialed caller outright
(**401, `50103`**) instead of quoting a price. There is no x402 path, so the buyer cannot re-fetch at
any price. And the row shape carries **no transaction hash**, so the fills cannot be spot-checked
against chain the way `tape-pulse`'s can. Both locks would have to open, and only one of them is
Quiver's to influence. The `pnlUsd` per row is derived accounting on top of that.

**Four of five can be freed from credentials to a useful degree. One cannot.**

---

## 10. The honest disclosure, per quantity

Where a quantity cannot be made verifiable, the defensible move is to say which one and why, not to
attach a blanket disclaimer that is equally true of everything. Proposed text, per quantity rather
than per service.

| quantity | disclosure |
|---|---|
| tape rows, whale prints, evidence txs | "Each row carries its on-chain transaction hash. Fetch the receipt from any public RPC and the trade's existence, direction, counterparty and size are checkable without OKX access and without our word for it." |
| `buyImbalance`, verdict | "Reproducible from public sources. Measured against an independent free index on 4 tokens, buy-share agreed within 0.028 absolute and the verdict matched in all 4." |
| `netFlowUsd`, `tapeVolumeUsd` | "Token-level across all venues OKX indexes. A single-pool public reconstruction will report a smaller figure; the direction agrees, the magnitude is venue-scope dependent and is not independently confirmable." |
| candle OHLC, `facts.high`, `facts.low` | "Reproducible. Measured against an independent free OHLCV source over 39 hourly bars, worst close divergence 0.778%." |
| candle `volUsd` | "Venue-scope dependent and **not** independently confirmed. One measured token (BONK) diverged by more than an order of magnitude, and the divergence was on OKX's side." |
| `volume24H`, `liquidity` | "A methodology-dependent aggregate, not an observation. Independent indexers legitimately differ; measured spread against two free sources was up to 47% on volume and 69% on liquidity. Treat as one venue's estimate." |
| `holders` | "Sourced from OKX and **not independently verified**. No free API publishes it. Reconstructing it from chain requires replaying every token transfer since deployment, roughly 6.4M log entries and about 5 hours per token on a public RPC." |
| `suspiciousHoldingPercent`, `bundleHoldingPercent`, `sniperHoldingPercent` | "OKX proprietary classifier output. The methodology is not published and no independent source reproduces it. It carries 0.10 of the risk weight; the remaining 0.90 rests on quantities you can check yourself." |
| cluster / holder-funding prior | "Not available. The upstream endpoint has been withdrawn, so this prior contributes nothing to the score." |
| `winRate`, `realizedPnlUsd`, `top3PnlTokenPercent` | "Derived PnL accounting computed by OKX under an unpublished cost-basis convention. It is **not** independently verifiable, and a different honest accounting method would produce a different honest number. It is also incomplete on some chains: wallets with confirmed on-chain DEX activity have been observed returning zero." |
| `wallet-audit` `INSUFFICIENT_DATA` | Replace "this wallet has zero DEX trades in the window" with "OKX's portfolio index returned no trades for this wallet, which can mean no DEX activity **or** a wallet/chain this index does not cover. These are indistinguishable from the index alone." |
| `loop-digest` fills and `pnlUsd` | "Sourced from a credentialed OKX endpoint that has no public or pay-per-use equivalent, and the rows carry no transaction hash. This is the one Quiver service whose input you cannot check by any means available to you. It is priced accordingly, and an empty read is already free." |

---

## What none of this would ever prove

Everything in §5 through §7 is a **cross-read**, not an attestation. Agreement between OKX and
GeckoTerminal and a public RPC bounds how far a fabricated answer could stray before something else
contradicts it. It does not prove any of the three is right, and an adversary sitting at Quiver's
network edge sees every one of those reads.

The three-way tape check in §6.2 is the closest thing here to real ground truth, because raw logs come
from consensus rather than from a vendor. Even there, the log decode happened on this machine over a
wire, so it is an off-chain comparison, and the same objection the earlier research raised about
Hyperliquid applies unchanged: the trustworthy version runs the comparison inside a verifier that
consumes consensus directly.

The x402 finding in §2 changes what is **available**, not what is **proven**. A buyer who pays
$0.0003 and gets a matching answer has learned that OKX told two parties the same thing at two
different instants. That is worth having, it is much better than the nothing §5 described, and it is
not verification.

And §4 stands on its own regardless of any of it: the HMAC will never be third-party evidence, because
the response is not in the signed message and the key is not exclusive to OKX.

---

## Instruments

All in the session scratchpad, none in the repo.

| | |
|---|---|
| `probe-unkeyed.mjs` | the eight endpoints with no credentials; the 402/401/404 split and the x402 envelopes |
| `probe-public.mjs` | 10 candidate public surfaces; establishes OKX has no unkeyed DEX path of its own |
| `keyed.mjs` | keyed ground truth through the deployed service's gated read-only REST proxy |
| `cmp-priceinfo.mjs` | price / volume / liquidity / mcap / holders against GeckoTerminal and DexScreener, 6 tokens |
| `cmp-candles.mjs` | 39 aligned hourly bars, keyed OKX against free OHLCV |
| `cmp-tape.mjs` | tape-pulse's estimators recomputed on a free public tape, window-matched |
| `rpc-survey.mjs` | 22 public RPCs, which serve a deep `eth_getLogs` |
| `rpc-tape.mjs` | the PEPE tape rebuilt from raw Swap logs; the three-way agreement |
| `verify-rows3.mjs` | published whale prints reconciled to chain; **versions 1 and 2 failed wrongly and are the finding in §7** |

Nothing here is wired into any service. No envelope currently carries any of the §10 disclosure text,
and no verifier for any of it exists on chain.
