# The five hard cases, measured: four were mis-stated, and one of them is already solved

**28 July 2026. Research, repo-only. Nothing here is served, deployed, or on chain. Nothing touches
`src/engine/` or any adapter, so `q1-e1fa99d08887d6cc` does not move.**

`PHASE_D_RESEARCH.md` §5 lists five sources as having no answer. All five were measured rather than
inheriting the claims. **Four of the five statements are wrong on a load-bearing detail**, and one of
those four is not merely unblocked but already reconstructible today, exactly, from a proof the repo
can already verify.

| source | §5 says | measured verdict |
|---|---|---|
| **dYdX funding** | "not located in dYdX's stores" | **wrong.** It is in the store under a different key. Reconstructed exactly, 5 snapshots. **Unblocked by tooling that exists** |
| **OKX Web3 DEX, keyed** | "the buyer cannot re-fetch without their own HMAC credentials" | **wrong for 6 of 8 endpoints.** They serve x402 pay-per-use at $0.0001. **Unblocked by tooling that exists** |
| **DefiLlama** | "`/protocol/aave` is 10.2 MB" | size right, relevance wrong. 98.8% of it is never read. And the number is recomputable from chain state to 0.10%. **Unblocked by tooling that exists** |
| **Deribit** | "373 KB, seven times any published zkTLS benchmark" | size right, cost model wrong. The payload is 37% of a TLSNotary session; the 25 MB floor is the other 63%. **Unblocked if Deribit signs, and defensible with a TEE today** |
| **Polymarket** | "the `hash` field has no signer" | **right, and confirmed.** Fills and resolution are provable on Polygon today; the resting book is not. **Split verdict** |
| **Hyperliquid funding** | "not on chain, `0x800`-`0x830` scanned" | right, and confirmed with a wider and stricter test. **Unblocked if Hyperliquid adds one precompile** |

None of the five is structurally impossible. Nothing here is an information-theoretic or
proven-hardness limit.

---

## 0. What was measured, and with what

Every number below was produced by running a script against a live endpoint on 28 July 2026 from this
host. Scripts live in the scratchpad, never in the repo. Sizes are decompressed bytes on the wire.

| | |
|---|---|
| `p1-sizes.mjs` | 17 payloads across all five sources |
| `p2-okx-unkeyed.mjs`, `p13-okx-detail.mjs` | every OKX endpoint the five keyed services call, probed with no credentials; x402 price in dollars |
| `p3-poly.mjs`, `p14-poly-sig.mjs`, `p15.mjs` | Polymarket `hash` reproduction, signature scan over 6 endpoints, exchange contract probes |
| `p4`-`p8` (dYdX) | ABCI store queries, non-existence-proof neighbour walk, premium-sample decode, 5-snapshot confirmation |
| `p9b-hl.mjs` | HyperEVM precompile sweep 0x800-0x83f, funding/premium/impact-price hunt |
| `p10-llama-deribit.mjs` | DefiLlama endpoint hunt and payload anatomy; Deribit subset sizing |
| `p11`, `p12` | Pyth catalogue scan, Polygon settlement, Aave TVL recomputed from chain state |
| `p17.mjs` | dYdX indexer staleness control |

---

## 1. Sizes, re-measured

| call | §5 / §1 claim | **measured** | delta |
|---|---|---|---|
| Deribit BTC option chain | 372,855 | **372,312** and **372,124** (two reads) | confirmed |
| DefiLlama `/protocol/aave` | 10,173,927 | **10,173,934** and **10,173,953** | confirmed |
| DefiLlama `/protocols` | 8,467,050 | **8,467,455** | confirmed |
| Polymarket gamma `limit=150` | 806,614 | **811,502** | confirmed |

The published sizes hold. Three sizes nobody had measured change what they mean:

| call | measured bytes |
|---|---|
| Deribit ETH option chain | 319,146 |
| Deribit **USDC** option chain (the SOL/alt path `optionChain()` takes) | **1,266,401** |
| Deribit single-instrument book summary | **563** |
| Deribit single-instrument ticker with greeks | **777** |
| DefiLlama `/tvl/aave` (current TVL scalar) | **16** |
| DefiLlama `/updatedProtocol/aave` | **2,599,376** |
| Polymarket `/book` | 3,269 to 3,445 |

Two corrections that belong in the record. The alt-currency Deribit path is **3.4x larger than the
BTC chain**, not smaller, so `options-desk` on SOL is the heaviest single fetch in the service, not
the lightest. And `gamma?limit=150` returns **100 items**: the API caps at 100, so the 807 KB is a
`limit=100` response and asking for more buys nothing.

---

## 2. Deribit

### The stated obstacle, checked

**Signatures: confirmed absent.** Four public endpoints re-probed independently (`get_index_price`,
`get_delivery_prices`, `status`, `get_time`). Zero signature-shaped response headers, zero
signature-shaped body fields. The envelope is exhaustively `jsonrpc / result / usIn / usOut / usDiff
/ testnet`, as §2 states.

**Size: confirmed, but it is not the binding constraint.** Apply TLSNotary's own published cost model
(25 MB fixed per session, ~40 KB per 1 KB of response) to the measured payloads:

| what is proved | measured bytes | implied session cost | share that is the payload |
|---|---|---|---|
| full BTC chain | 372,312 | ~39.9 MB | 63% |
| front expiry only (42 instruments) | **18,544** | ~25.7 MB | 2.9% |
| front expiry, only the fields `options-desk` reads | **3,204** | ~25.1 MB | 0.5% |
| one instrument | 563 | ~25.0 MB | 0.09% |

**The 25 MB session floor is 63% of the cost of proving the entire 373 KB chain.** Cutting the
payload by 20x cuts the session by 36%. So "seven times any published benchmark" is a statement about
what has been *benchmarked*, not about a cost cliff, and it should be written that way. What is true
and unchanged: nobody has published a measurement past 51 KB, so the 373 KB figure is extrapolated
from a model, and the model is in tension with the published latency curve (§3.3 already flags this).

### The thing §5 and §6 get structurally wrong

§6 says a TEE-attested fetch for Deribit "must not be built" because it "says nothing about whether
the IV surface is right", and puts Deribit in the same sentence as DefiLlama TVL. **These two are not
alike, and the difference decides the verdict.**

`mark_iv` is not an estimate of an external fact. It *is* Deribit's mark, by definition. It is the
number Deribit margins positions against and settles P&L on. A consumer of `options-desk` cares about
it precisely because it is what Deribit says. So for this quantity, **provenance is the entire
quantity**, and "Deribit's server returned mark_iv = X at time T" is a complete proof of the thing
being claimed, not a proxy for it.

DefiLlama TVL has an external referent (the assets actually locked) that its number approximates.
Deribit's mark IV does not. Lumping them together imports DefiLlama's problem into a case that does
not have it.

### What would unblock it

| lever | who | realistic? |
|---|---|---|
| Deribit signs public market-data responses (detached header, any curve) | **Deribit** | Plausible. They already run signing infrastructure for inbound auth, and §2 records that Coinbase and OKX both operated signed public price oracles until Jan 2025, so the pattern is not exotic, only retired |
| Deribit adds an expiry filter to `get_book_summary_by_currency` | Deribit | Small ask, worth ~20x on payload, worth 36% on a zkTLS session |
| TEE-attested fetch (Phala TDX, ~$0.06/hr, on-chain verify 4-5M gas via Automata) | Quiver | Available today. Attests transport, which for `mark_iv` is the quantity |

**Partial answer, measured.** A claim scoped to the front expiry rests on 18,544 bytes, which is
under the 51 KB ceiling of every published zkTLS benchmark. `options-desk`'s headline block
(`frontAtmIvPct`, `frontMaxPain`, `frontSkew25dRR`, `frontAtmGreeks`) is computed from that slice
alone. GEX, the SSVI surface and the 8-expiry term structure are what need the full chain, and they
can be disclosed as unattested while the headline is attested.

**No signed substitute exists.** Pyth's catalogue re-scanned: **3,056 feeds, zero crypto
implied-volatility feeds** (the eight "volatility" hits are US equity ETFs: UVXY, VXX, SVIX, UVIX,
VIXY, SVXY, LVHI, and a redemption rate). Zero TVL feeds. One funding feed, `Rates.OBFR`, which is
the US Overnight Bank Funding Rate and has nothing to do with perp funding. §3.4's conclusion holds
under a fresh count.

> **Verdict: unblocked if a named party does a named thing (Deribit signs), and defensible with
> tooling that exists today (TEE) because provenance is the whole quantity for a venue-defined mark.**
> Not a research problem. The current §6 instruction to never build this rests on a false analogy
> with DefiLlama.

---

## 3. DefiLlama

### 98.8% of the 10.2 MB is payload `protocol-pulse` never reads

Anatomy of `/protocol/aave`, measured by serialising each top-level key:

| key | bytes | does `protocolPulse.js` read it? |
|---|---|---|
| `tokensInUsd` | 3,796,891 | no |
| `tokens` | 3,661,249 | no |
| `chainTvls` | 2,595,209 | no |
| `tvl` | 116,444 | **yes** |
| `currentChainTvls` | 1,137 | **yes** |
| everything else | ~2,900 | `name`, `category`, `chains` only |
| total | 10,173,953 | |

| framing | bytes | vs 51 KB ceiling |
|---|---|---|
| what the adapter fetches | 10,173,953 | 199x over |
| **what `protocol-pulse` actually consumes** | **117,635** | 2.3x over |
| same content, minimally encoded | **56,561** | 1.1x over |
| **last 400 days of series only** (covers 7d, 30d, 90d drawdown) | **11,166** | **under** |
| `/updatedProtocol/aave`, a drop-in with the same keys | 2,599,376 | 3.9x smaller than the current call |

The 400-day cut loses only `ageDays`, which `protocol-pulse` computes from the first series point.
That one field is the sole reason the full 2,262-point history is fetched, and it is a constant per
protocol that could be pinned once.

### The stronger answer: skip the aggregator

**Measured, Aave v3 on Ethereum, recomputed purely from chain state:** read `getReservesList()` from
the Pool, then per reserve the aToken and variable-debt token supplies and the Aave oracle price.
67 of 67 reserves priced.

| | value |
|---|---|
| aToken supply x oracle price (supplied) | **$20.062B** |
| variable debt x oracle price | **$8.636B** |
| supplied minus borrowed (DefiLlama's TVL convention) | **$11.427B** |
| DefiLlama `aave-v3` `currentChainTvls.Ethereum` | **$11.415B** |
| **ratio** | **1.0010** |

**0.10% apart.** The residual is snapshot timing and price source, not methodology divergence. Every
input to the left-hand column is EVM storage that `eth_getProof` already proves on the free public
RPCs `lp-desk` and `calldata-x` already use (§4.3 measured ~6 KB per pool slot).

This retires the "derived, methodology-dependent aggregate" objection as stated. TVL is
methodology-dependent, but **DefiLlama's methodology is published open-source adapter code**, so the
derivation from chain state to TVL is a public deterministic function. That makes the quantity
*reproducible*, which is strictly stronger than proving transport of DefiLlama's answer. The
remaining gap is agreement on which convention counts, and that is a specification problem, not a
cryptography problem.

**The honest limit.** This does not generalise for free. DefiLlama lists **7,938 protocols**
(measured), and each needs its own adapter to recompute. Aave is one of the easiest. The work is
engineering volume, and it is exactly the volume DefiLlama itself has already done in public.

> **Verdict: unblocked by tooling that exists, two independent ways.** Reduce the fetch to the ~11 KB
> that is actually read and it fits under every published zkTLS benchmark. Or bypass DefiLlama and
> prove the chain state its number is derived from, which measured 0.10% from their answer.

---

## 4. Polymarket

### The `hash` field: confirmed worthless, with the test written down

Measured on a live `/book`:

- `hash = bf3a961b09862dc93de67311d686c1d553b52234`. **40 hex characters, 20 bytes**, SHA-1 shaped.
- **Not reproducible** from any of 12 constructions tried (JSON with and without the hash field,
  `market ‖ asset_id ‖ timestamp`, bids-and-asks only; each under SHA-1, SHA-256 and MD5).
- Six endpoints scanned recursively for signature-shaped keys (`/book`, `/midpoint`, `/price`,
  `/markets`, `/prices-history`, data-api `/trades`) plus the gamma market object: **zero signature
  fields, zero signature headers, on every one.**

So it binds the data to nothing and identifies no signer. §5 is right and this is now measured rather
than asserted.

### What IS provable, today

Polymarket settlement is on Polygon and reachable with no credential:

| | measured |
|---|---|
| data-api `/trades` rows carry `transactionHash` | yes, a field on every row |
| those receipts resolve on Polygon | yes, e.g. block 91,026,673, status `0x1`, **20 logs across 5 emitters** |
| emitters per fill | CTF `0xc011a7e1…`, USDC.e `0x2791bca1…`, CTF Exchange `0x4d97dcd9…`, NegRisk exchange `0xe1111800…`, Polygon gas `0x…1010` |
| `eth_getProof` on Polygon | **works**: account proof 9 nodes / 3,911 B, storage proof 3,920 B, ~7.8 KB total |

`poly-desk` reads wallet positions and activity. Those are token balances and transfers in the
Conditional Tokens contract, which is EVM storage the proof above reaches. **`poly-desk` is not a
hard case; it is `lp-desk` with a different contract address.**

### What is not provable, and the one thing that would fix it

`poly-fill` walks resting `book.bids` / `book.asks` for a slippage estimate. Resting orders never
touch a chain, exactly as dYdX documents for its own book (§4.2).

The specific unblock: **every resting Polymarket order carries a maker signature already**, because
the CTF Exchange fills orders on chain and must verify one. Both exchange contracts are live and
substantial (CTF Exchange 15,007 bytes of bytecode, NegRisk exchange 21,037 bytes, measured). If
`/book` returned each level's maker signature alongside price and size, the book would be
self-authenticating for order existence, and Polymarket would be serving something it already holds.

**Evidence quality, stated plainly.** The claim that those orders are EIP-712 signed comes from
Polymarket's published CLOB documentation, not from anything measured here. The endpoint called
`DOMAIN_SEPARATOR()` and `domainSeparator()` on both exchange contracts and **both reverted**, so I
could not confirm a public domain-separator getter. The inference is strong (an on-chain fill
requires a verifiable maker authorisation) but it is an inference.

Even served, signatures prove an order *existed*, not that it is *still resting*: cancellation is an
operator-side fact. A depth claim would remain an upper bound.

> **Verdict, split. Fills, positions and resolution: unblocked by tooling that exists** (Polygon
> state proofs, measured working at ~7.8 KB). **Resting book depth: unblocked if Polymarket serves
> the maker signatures it already holds**, and even then only as an upper bound on depth. Not
> impossible; not research.

---

## 5. OKX Web3 DEX, keyed: the claim is wrong

§5 calls this the "worst case" because "the buyer cannot re-fetch without their own HMAC
credentials". **Measured, with no credentials of any kind:**

| service | endpoint | unkeyed status | can a credential-less buyer re-fetch? |
|---|---|---|---|
| `tape-pulse`, `chart-press` | `market/trades` | **402 x402** | **yes**, $0.0001 |
| `chart-press` | `market/candles` | **402 x402** | **yes**, $0.0001 |
| `chart-press` | `market/price-info` (POST) | **402 x402** | **yes** |
| `token-scan` | `token/advanced-info` | **402 x402** | **yes**, $0.0002 |
| `wallet-audit` | `portfolio/overview` | **402 x402** | **yes**, $0.0002 |
| `wallet-audit` | `portfolio/recent-pnl` | **402 x402** | **yes**, $0.0002 |
| `loop-digest` | `portfolio/dex-history` | **401** `50103` | **no** |
| `token-scan` | `market/holders` | **404** | endpoint does not exist |

Every 402 carries a well-formed x402 v2 body with
`billing.payPerUse.available = true` and the description "You can continue paying per request via
x402", quoting `eip155:196` (X Layer) in USDG `0x4ae46a…` or USD₮0 `0x779ded…`. **I read both token
contracts on X Layer directly: 6 decimals each**, so `amount: "100"` is **$0.0001** and `"200"` is
**$0.0002**. No dev-portal account, no HMAC key, no subscription.

I did not execute a payment, and nothing here should.

Two more facts that finish the case:

- **`chart-press`'s CEX branch is already keyless.** `www.okx.com/api/v5/market/candles` returned
  200 / 1,188 B with no credential, and the service already prints that exact re-check URL in its
  own `provenance` block.
- **The ground truth under the DEX endpoints is public chain state.** OKX's `trades` and `candles`
  for an EVM token are aggregations of Swap events. Measured: a keyless public Ethereum RPC returned
  **17 Uniswap v3 USDC/WETH Swap logs in the last 20 blocks**. An independent verifier can recompute
  rather than re-fetch.

So the honest ranking is inverted. This is not the worst-provisioned of the five for the "go look
yourself" fallback; **at $0.0001 per call it is the best-provisioned.** Exactly one endpoint, feeding
exactly one service (`loop-digest`), is genuinely credential-locked.

None of this makes the response *signed*. It is still unsigned JSON, and per §2 of the research a
re-fetch is a concurrent check rather than an audit. What changes is that the fallback exists at all,
and §5's stated reason for calling this the worst case does not survive contact with the endpoint.

> **Verdict: unblocked by tooling that exists, and it is the single cheapest win in this document.**
> The fix is a documentation change plus a one-line disclosure per response, not engineering. The
> residual is one endpoint (`portfolio/dex-history`); the named ask is that OKX put it behind the
> same x402 gate as the other six.

---

## 6. Funding rates: the two venues are not alike, and one is already solved

### 6.1 dYdX: it was a key-name error, not an absence

§4.2 and §5 both say funding "was not located in either store". **It is in the store.** The prior
probe used the Go constant names; the wire prefixes are abbreviated.

| §4.2 used | **actual key, recovered by neighbour-walking the store** |
|---|---|
| `Perpetual:` | **`Perp:`** |
| `PremiumSamples` | **`PremSamples`** |
| `PremiumVotes` | **`PremVotes`** |

Full enumeration of the `perpetuals` store, measured by walking non-existence proofs:
`LiqTier:0..7`, `NextPerpetualID`, `Params`, `Perp:0..N`, `PremSamples`, `PremVotes`.

**`Perp:` + be4(0) exists**, 30 bytes, ICS-23 proof 790 B, 2 ops. Decoded against the indexer:

| field | store | indexer | |
|---|---|---|---|
| ticker | `BTC-USD` | `BTC-USD` | exact |
| atomicResolution | -10 | -10 | exact |
| defaultFundingPpm | 0 | `defaultFundingRate1H: "0"` | exact |
| openInterest | 2,984,734,000,000 base units → **298.4734** | **298.4734** | **exact** |
| fundingIndex | 2,228,696 | not exposed | |

The `atomicResolution` decode is the tell that fixed everything: it only reads -10 under **zigzag**
(`sint32`) decoding. dYdX uses zigzag throughout, and reading the premium samples as plain varints is
what made an earlier pass look like nonsense.

### The funding rate is reconstructible exactly

`PremSamples` holds, in one value, both the per-market premium samples for the current funding hour
and the sample count. Solving `nextFundingRate = SUM / D / 1e6` for `D`:

| snapshot | `numPremiums` | **D solved** | 8 x numPremiums | markets reconstructed exactly |
|---|---|---|---|---|
| 1 | 21 | 168.000 | 168 | **17 / 17** |
| 2 | 22 | 176.000 | 176 | **17 / 17** |
| 3 | 23 | 184.000 | 184 | **17 / 17** |
| 4 | 24 | 192.000 | 192 | **17 / 17** |
| 5 | 36 | 288.000 | 288 | **19 / 19** |

Identical across every market in every snapshot, both signs, to the last digit
(`SOL-USD: predicted -0.00003551190476190476, actual -0.00003551190476190476`). So:

```
nextFundingRate_1h  =  mean(premium samples, sint32 ppm)  /  8  /  1e6
```

which is the documented dYdX formula: the premium is an 8-hour rate, funding is charged hourly.
A single snapshot could not tell a constant divisor from `8 x numPremiums`; five snapshots at five
different counts can, and did.

**Cost:** `PremSamples` value 401 to 445 bytes, **ICS-23 proof 1,108 to 1,152 bytes, 2 ops
(`ics23:iavl` then `ics23:simple`)**, rooting into `app_hash`. That is the same proof shape §4.2
already verified for oracle price and maintenance margin, and `src/adapters/ics23.js` and
`dydx-attest.js` already exist to check it.

### A separate finding that matters more for correctness than for attestation

`dydx.js` maps `fundingHourly = nextFundingRate` straight from the indexer. Measured control: over
130 seconds,

- **19 of 19** markets present in `PremSamples` had their `nextFundingRate` change;
- **0 of 277** markets absent from `PremSamples` changed at all.

At any instant only 17 to 19 of 296 markets carry live premium samples, while **201 of 296 report a
nonzero `nextFundingRate`**. Measured behaviour: the indexer serves an unchanging value for markets
it is not currently sampling. Interpretation, labelled as inference and not verified across a funding
tick: those are carried from the last epoch that sampled the market, while the chain's own
`PremSamples` says the current epoch's sum is zero. **`perp-gate` on a mid-cap dYdX symbol is very
likely consuming a stale funding rate**, and that is a data-quality defect independent of anything in
Phase D.

One operational note for whoever builds the gate: the reconstruction is exact only when the store
read and the indexer read fall in the same sample epoch. A run that straddled a tick scored 0 of 19;
the immediately-successive reads scored 17 of 17 and 19 of 19.

> **Verdict: unblocked by tooling that exists, today.** The value is in a Merkle-proven store, the
> reconstruction is exact, the proof is ~1.1 KB, and the verifier is already in the repo. This should
> move out of §5 and into §7(a).

### 6.2 Hyperliquid: confirmed absent, and the reason is time-averaging

Independent sweep of **0x800 through 0x83f** with three calldata shapes. **16 live precompiles**
found: 0x800, 0x801, 0x803-0x80e, 0x812, 0x813.

Then a stricter hunt than the original. Instead of matching only the funding rate, I matched every
returned 32-byte word, for 4 assets, against **five** live quantities at every power of ten from 1e0
to 1e18, both signs: `funding`, `premium`, `impactPxs[0]`, `impactPxs[1]`, `midPx`.

**No match.** (One collision surfaced, XRP at 0x806 equalling `impactBid x 1e6`; 0x806 is `markPx`,
and XRP's mark and impact bid sat 2e-4 apart at that moment, so it is coincidence rather than a
find.) §5's claim is confirmed and strengthened: not only funding, but **its constituents are absent
too.**

**What funding is computed from, measured.** `metaAndAssetCtxs` exposes `premium` and `impactPxs`
directly, alongside `funding`, `oraclePx`, `markPx`, `midPx`. Sampled live:

| | BTC | ETH | SOL | XRP |
|---|---|---|---|---|
| `funding` (hourly) | 0.0000125 | -0.000000862 | -0.0000094226 | -0.0000260847 |
| `premium` (instantaneous) | -0.0004192 | -0.0005026 | -0.0005733 | -0.0009933 |
| `impactPxs` | 63423.0 / 63424.0 | 1888.99 / 1889.10 | 73.222 / 73.223 | 1.0539 / 1.054002 |
| `oraclePx` | 63450.6 | 1890.05 | 73.265 | 1.05505 |

So funding is a function of `(impactPxs, oraclePx)`, hourly-averaged, with a fixed interest term. Note
BTC's funding sits at exactly 1.25e-5, which is the 0.01%-per-8h interest floor with the premium term
contributing nothing.

**Of those constituents, `oraclePx` is on chain (0x807, measured returning 634016 for BTC). The
impact prices are not.** The nearest precompile, 0x80e, returns best bid and best offer only
(measured 633800 / 633810 for BTC), which is the top of book, not the average execution price to
absorb the impact notional.

**And even adding an impact-price precompile would not be enough.** `funding` is a time-average over
the hour of samples taken every few seconds. A precompile read is a point-in-time snapshot. A
verifier contract reading `impactPxs` once cannot reconstruct an hourly mean without accumulating
every sample itself. This is exactly the structural difference from dYdX, where `PremSamples` puts
the whole epoch's samples in a single provable value.

So the minimum ask is specific: **a funding read precompile returning the current hourly rate**, not
an impact-price precompile. The value is already in HyperCore consensus state, since it is charged
against every account every hour. The ask is realistic: the precompile set has grown since launch
(0x812 and 0x813 are live and post-date the originally documented range), so this is a normal feature
request to a team that ships them, not a protocol change.

> **Verdict, split. dYdX: unblocked by tooling that exists, today. Hyperliquid: unblocked if
> Hyperliquid exposes one read precompile for the hourly funding rate.** Neither is a research
> problem. §7(c)'s framing, that somebody would have to "prove the funding computation from its
> constituent on-chain inputs", is right for Hyperliquid and unnecessary for dYdX.

---

## 7. What this changes upstream

**§5's table needs four rows rewritten**, and the sentence "for the first four rows the honest
position is that no mechanism available today makes the input verifiable" is no longer supportable
as written.

**§6's gate D4 would encode a falsehood as a test.** It proposes a negative gate asserting that
`options-desk`, `protocol-pulse`, `poly-*` and the keyed OKX five do not claim an attestation path.
Built as specified, D4 would go green while `poly-desk` has a working Polygon state-proof path and
the OKX five have a $0.0001 re-fetch fallback, and it would go **red** on a correct future edit that
attaches either. D4 is still the highest-leverage gate in the document; its allowlist has to be
rebuilt from this table first.

**§7's ranking moves.** dYdX funding belongs in (a), not (c). DefiLlama's "arguably not a
cryptography problem at all" is right for the wrong reason: it is not a cryptography problem because
the derivation is already public code over provable chain state, not because the quantity is
unknowable.

**Ordered by cost to close:**

| # | work | who | scale |
|---|---|---|---|
| 1 | Disclose the OKX x402 re-fetch path in the envelope | Quiver | hours |
| 2 | dYdX funding attestation via `PremSamples` + ICS-23 | Quiver | days, on top of `dydx-attest.js` |
| 3 | Fix the stale-`nextFundingRate` consumption in `perp-gate` | Quiver | days, and it is a correctness bug not an attestation feature |
| 4 | Narrow the DefiLlama fetch to the ~11 KB actually read | Quiver | days |
| 5 | Polygon state proofs for `poly-desk` positions | Quiver | weeks, same shape as `lp-desk` |
| 6 | Aave-style on-chain TVL recomputation per protocol | Quiver | weeks per protocol, unbounded across 7,938 |
| 7 | Hyperliquid funding precompile | **Hyperliquid** | one feature request |
| 8 | Polymarket serves maker signatures on `/book` | **Polymarket** | one API field |
| 9 | Deribit signs public market data | **Deribit** | a product decision, and the largest ask here |

---

## What none of this would prove

**Nothing above closes the oracle problem, and §7(d) is still correct.** Proving that dYdX's own
state holds a funding rate of -2.69e-5 does not make -2.69e-5 a true statement about the world. It
makes it dYdX's committed statement, which is the strongest thing recoverable and is not the same
thing.

**The dYdX reconstruction covers 17 to 19 of 296 markets at any instant.** Every market carrying
premium samples in the current epoch reconstructed exactly, five times. The other ~277 were not
tested, and the measured evidence says the indexer is serving them a carried value that the current
store does not support. Extending the claim to them would be extending it past the measurement.

**The Aave recomputation is one protocol on one chain.** 0.10% agreement on Aave v3 Ethereum says
nothing about the other 7,937 protocols, and says nothing about protocols whose TVL depends on
off-chain assets, oracle-priced illiquids, or cross-chain accounting where DefiLlama's convention is
genuinely contestable.

**Every "unblocked if a named party does a named thing" verdict is a request, not a plan.** Deribit,
Polymarket and Hyperliquid owe Quiver nothing. The verdict says the obstacle is a decision somebody
could make, not that they will. What it rules out is the claim that these are dead ends.

**And the OKX finding does not make the OKX data trustworthy.** It makes it re-fetchable for a
hundredth of a cent. Re-fetching is a concurrent check, and §2 of the research already measured that
ordinary drift exceeds any useful attestation bound inside a minute. The five keyed services remain
unsigned. What changed is only that the reason given for calling them the worst case was false.
