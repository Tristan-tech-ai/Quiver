# The three off-chain venues, measured: one is solved, one shrinks by 10x, one was mislabelled

**28 July 2026. Research, repo-only. Nothing here is served, deployed, or on chain. Nothing touches
`src/engine/`, so `q1-e1fa99d08887d6cc` does not move. No adapter file was edited.**

`PHASE_D_RESEARCH.md` §5 groups Deribit, DefiLlama and Polymarket together as "the hard cases" and
says of the first four rows that **no mechanism available today makes the input verifiable**. Three of
those numbers do not survive measurement:

| §5 claim | measured | where it goes wrong |
|---|---|---|
| Deribit chain is "373 KB, 7x past any published zkTLS benchmark" | **37,228 bytes on the wire** with `Accept-Encoding: gzip` | 373 KB is the decoded JSON. TLS encrypts what HTTP hands it, and HTTP hands it the gzip stream |
| DefiLlama `/protocol/aave` is 10.2 MB and TVL is a derived aggregate that can never be checked | 10,173,953 bytes is right. But Aave V3 Ethereum TVL reconstructs from Ethereum state to **1.73 bps**, with token quantities **exact** | TVL is derived, but every input to the derivation is a storage slot, and DefiLlama publishes its own method as code |
| Polymarket's book is "off chain by design" and the `hash` "has no signer" | the hash is `sha1(body with hash:"")`, reproduced on 11 of 12 books. But every resting order is **EIP-712 signed by its maker** | the book is not unsignable. It is signed at origin and the signatures are withheld at publication |

The Polymarket line in §5 is the one that changes character most. It is not a statement about
cryptography, it is a statement about an API surface.

### The verdicts, up front

| venue | service | verdict |
|---|---|---|
| **DefiLlama** | `protocol-pulse`, TVL half | **Solvable with named work.** Reconstruct from chain state. Measured at 1.73 bps on Aave V3 Ethereum and 0.000000% on Lido, with token quantities exact. Named work in §3.10 |
| **DefiLlama** | `protocol-pulse`, incident half | **Structurally impossible.** The `/hacks` registry is a human-curated editorial dataset. No chain state answers "was this exploited" |
| **DefiLlama** | RWA and Bridge categories, 30.1% of tracked TVL | **Structurally impossible.** The asset is in a custodian's account or on another chain's ledger under a custody claim |
| **Polymarket** | resolution, settlement | **Solved.** `payoutNumerators` and `payoutDenominator` are contract storage, verified against the venue's own reported outcome 4 of 4 |
| **Polymarket** | `poly-desk` realised flow | **Solvable with named work.** Size and timestamp exact 8 of 8 from receipts; price exact once the fee leg is separated |
| **Polymarket** | `poly-fill` book depth | **Solvable in principle, blocked on the venue.** Every order is EIP-712 signed at origin. No public endpoint exposes the signature |
| **Deribit** | `options-desk` transport | **Solvable in part.** The payload objection is retracted: 37,228 bytes, not 372,225 |
| **Deribit** | `options-desk` semantics | **Needs novel research.** `mark_iv` is Deribit's own model over Deribit's own book. Open question: is there any second computation that binds it? Cross-venue disagreement is measured at a p90 of 11.8 vol points, so the cheap answer is measured and rejected |

---

## 1. What the services actually consume

Read from the engine, not assumed. `options-desk` touches the Deribit chain in exactly one loop
(`engine/optionsDesk.js:279-292`), and a scan for every field access on a chain row returns five:

| line | field |
|---|---|
| 274 | `underlying_price` |
| 281 | `instrument_name` |
| 283 | `open_interest` |
| 284 | `mark_iv` |
| 291 | `mark_price` |

Five of the twenty fields Deribit returns. The other fifteen (`high`, `low`, `last`, `interest_rate`,
`bid_price`, `ask_price`, `creation_timestamp`, `price_change`, `volume`, `underlying_index`,
`base_currency`, `quote_currency`, `estimated_delivery_price`, `volume_usd`, `mid_price`) are never
read. `protocol-pulse` reads `p.tvl[]`, `p.currentChainTvls`, `p.chains`, `p.name`, `p.category` and
the `/hacks` registry, out of a 28.5 MB record. `poly-fill` reads `bids`, `asks`, `timestamp` out of a
ten-key object.

Every one of the three fetches an order of magnitude more than it uses. That matters differently in
each case, which is the point of this document.

---

## 2. Deribit

### 2.1 Payloads, measured

All figures 28 July 2026, from `m1-deribit.mjs` and `m2-wire.mjs`. "Wire" is bytes counted off the
socket by a raw `node:https` request; "decoded" is `Buffer.byteLength` of the JSON after
decompression.

| endpoint | instruments | decoded | wire, identity | wire, gzip | ratio |
|---|---|---|---|---|---|
| BTC option chain | 834 | 372,225 | 371,378 | **37,228** | 9.98x |
| ETH option chain | 724 | 319,201 | 319,251 | **30,370** | 10.5x |
| DVOL 365d daily | 366 pts | 14,638 | 14,636 | 5,019 | 2.9x |
| last 100 trades | 100 | 32,866 | 32,649 | 4,885 | 6.7x |
| futures book summary | 12 | 4,876 | not measured | not measured | not measured |
| index price | 1 | 163 | 163 | 123 (br) | not measured |
| delivery prices, 10 | 10 | 614 | not measured | not measured | not measured |

**The single number that moves the Deribit verdict is 37,228.** Content-encoding is applied by HTTP
before the TLS record layer, so a zkTLS system that proves a transcript proves the compressed bytes.
The "7x past any published benchmark" figure came from dividing the decoded length by 51 KB. Dividing
the wire length by the same 51 KB gives 0.73x.

Because that one number carries the whole retraction, it was re-measured with a different tool.
`curl -w '%{size_download}'`, which counts bytes it received and has nothing to do with the Node
script:

| encoding | curl `size_download` | curl `size_header` | node raw socket |
|---|---|---|---|
| gzip | **37,561** | 524 | 37,228 |
| identity | **372,300** | 505 | 371,378 |

The few hundred bytes between the two tools is the chain moving between fetches: option marks change
every second. The ratio is 9.9x either way.

### 2.2 Projection helps less than it looks, and here is why

The obvious follow-up is to cut the payload further. It does cut, a lot:

| variant | rows | JSON | gzip | brotli |
|---|---|---|---|---|
| full chain, 20 fields | 834 | 367,487 | 34,666 | 24,893 |
| all rows, the 5 used fields | 834 | 108,708 | 14,493 | 11,088 |
| the 5 fields as bare arrays | 834 | 45,324 | 12,011 | 10,259 |
| first 8 future expiries, 5 fields | 542 | 70,510 | 9,154 | not measured |
| 8 expiries and `oi>0`, 5 fields | 451 | 58,917 | 7,725 | not measured |

And the pruning is close to free in answer terms. `m12-prune.mjs` reruns the real `computeGex`,
`atmForwardIv` and `ivAtDelta` from the engine on each variant:

| variant | netGEX rel | gamma flip | ATM-forward IV | 25d risk reversal |
|---|---|---|---|---|
| full chain | baseline 37,281,913 | 62,384 | 33.243722% | -5.750256454 |
| 5 fields, all rows | **0** | 62,384 | identical | identical |
| first 8 expiries | **0** | 62,384 | identical | identical |
| `oi>0` filter | **-0.027%** | 62,384 | identical | identical |

Two honest caveats on that table. The `oi>0` filter is not exactly lossless even though `computeGex`
itself drops zero-OI rows: the per-expiry forward is a median over **all** rows in the expiry
including the zero-OI ones, so dropping them shifts `F` and moves netGEX by 0.027% and aggregate vega
by 0.0007%. And the 8-expiry cut, while it leaves every number above untouched, truncates the
implied-rate curve from 11 expiries to 8, because `rateCurve` iterates all future expiries and only
`enriched` is sliced to 8.

**But none of this dissolves the zkTLS objection on its own, and it is worth being precise about
why.** A transport proof attests what the *server sent*. The prover cannot ask Deribit to send only
451 rows, because no such endpoint exists: `get_instruments` is larger (695,970 bytes),
`get_book_summary_by_instrument` is 563 bytes but would need 451 separate TLS sessions, and
`get_book_summary_by_currency` ignores any filter you add. Measured: appending `expiry=31JUL26` or
`instrument_name=BTC-31JUL26-60000-C` returns the identical 834 rows and 371,291 bytes as the bare
call, so the parameters are silently dropped rather than honoured. Client-side projection happens after
the bytes arrive, so the MPC still runs over everything the server sent. Projection reduces what the
verifier must re-hash and store; it does not reduce what the prover must prove.

Compression does reduce what the prover must prove, and by an order of magnitude. That is the whole
of the gain, and it carries a cost stated in §2.4.

### 2.3 Signatures: still zero, and the envelope still has no room

Re-measured rather than inherited. Response headers carry nothing matching
`sign|signature|proof|attest|pubkey|certificate|merkle|ecdsa|ed25519|secp|digest|hmac|seal`, and a
recursive body scan finds nothing either. The envelope is exhaustively
`jsonrpc / result / usIn / usOut / usDiff / testnet`. §5 was right about this and nothing has changed.

### 2.4 The compression trade-off, which is the real finding

Gzip cuts the MPC cost 10x and destroys selective disclosure at the same time. DEFLATE emits
back-references into a sliding window, so opening a byte range of the compressed stream reveals a
range that cannot be decoded without the bytes before it. A prover who wants to reveal `mark_iv` for
one instrument and redact the rest cannot do it over a compressed transcript. That is why zkTLS
tutorials tell you to send `Accept-Encoding: identity`.

For a **public, keyless, market-data** endpoint there is nothing to redact. Everything in the response
is already world-readable at the URL. So the trade-off that normally forbids compression costs
Deribit's chain exactly nothing, and the 10x is available for free. This is the specific reason the
Deribit payload objection is weaker than it looked, and it is a property of *this* endpoint class
rather than a general result.

Evidence status: the direction of the trade-off follows from DEFLATE's definition and is not in doubt.
Whether a given zkTLS implementation exposes a compressed-transcript mode, and what each system's
documented ceiling actually is, are implementation questions this document did not close. They are the
one open item in §2 and they are listed as such in §6.

### 2.5 The fallback, and how bad it is

If no attestation exists, the roadmap's cheap answer is multi-source divergence disclosure. For the
option surface, measured, it is close to worthless.

`m15-ivcross.mjs` matched Deribit against OKX on `(expiry, strike, type)`, three rounds:

| run | round | matched | median abs | p90 abs | max abs | median rel | p90 rel |
|---|---|---|---|---|---|---|---|
| A | 1 | 538 | 0.81 vol pts | 10.61 | 74.58 | 1.90% | 17.87% |
| A | 2 | 538 | 0.75 vol pts | 10.61 | 74.32 | 1.83% | 17.47% |
| B | 1 | 538 | 0.81 vol pts | 11.82 | 77.60 | 2.03% | 18.22% |
| B | 2 | 538 | 0.81 vol pts | 11.82 | 77.59 | 2.04% | 18.22% |
| B | 3 | 538 | 0.79 vol pts | 11.82 | 77.54 | 2.01% | 18.20% |

Two independent runs, minutes apart, and the shape is stable.

`util/divergence.js` carries a calibrated floor of about 10.8 bps for spot indices. The median
cross-venue disagreement on option IV is **190 to 204 bps relative**, roughly 18x looser, and the p90
is about **1,750 to 1,820 bps**, roughly 165x looser. A disclosure band that wide tells a caller
almost nothing: an adversary moving a mark IV by five vol points sits comfortably inside the honest
disagreement.

The wide tail is concentrated in deep out-of-the-money strikes (the worst pairs were 105,000 and
110,000 strike against a 63,000 index), which is the same region `TIER3_FINDINGS.md` found for the
gamma grid. The median is the honest headline; the p90 is the honest reason not to lean on it.

### 2.6 Nothing Deribit-derived is in Chainlink

Measured, and worth recording because it is the first place anyone would look. Chainlink's public
reference data directory was fetched and searched for `vol|viv|dvol|implied|option|deribit` across
every field of every feed:

| directory | feeds | matches |
|---|---|---|
| `feeds-mainnet.json` (Ethereum) | 316 | **0** |
| `feeds-ethereum-mainnet-arbitrum-1.json` | 1,216 | **0** |

Zero volatility or option feeds on either chain. This does not survey Volmex, Premia or Derive, which
stay open in §6, but it does close the most obvious door.

### 2.7 Verdict, Deribit

**Solvable in part, and the part is larger than §5 said.**

- The transport-size objection is **retracted**. 37,228 wire bytes, measured. Any zkTLS system that
  can attest a 51 KB response can attest the BTC option chain gzipped, and the index price (163 bytes)
  and delivery prices (614 bytes) were never in question at all.
- What a transport proof would establish is unchanged and remains the ceiling: it proves Deribit's
  server sent those bytes, not that the IV surface is right. Deribit computes `mark_iv` from its own
  model against its own book. There is no second party to check it against, which is exactly what
  §2.5 measures.
- The multi-source fallback is **measured and rejected** for IV. Publishing a divergence band of
  10.6 vol points at p90 would be worse than publishing nothing, because it reads as a bound.
- Open question, and it is a real one: is there any quantity in `options-desk` that a *second*
  independent computation could bind? `mark_price` and `mark_iv` are tied by Black-76 given
  `underlying_price` and time, so a circuit could at least prove the chain is **internally
  consistent**, which is precisely the `TIER3_FINDINGS.md` result applied to a whole surface rather
  than one option. That catches a tampered row. It does not catch a uniformly shifted surface.

---

## 3. DefiLlama

This is the one that came out solved, and the answer was to stop asking DefiLlama.

### 3.1 The endpoint surface, measured

| endpoint | wire, gzip | wire, identity | decoded |
|---|---|---|---|
| `/protocols` | 2,213,653 | 8,467,455 | 8,467,050 |
| `/protocol/aave` | 3,041,472 | 10,173,953 | 10,173,927 |
| `/protocol/aave-v3` | 9,566,382 | not measured | **28,516,714** |
| `/protocol/lido` | 463,464 | 1,992,184 | 1,992,184 |
| `/lite/protocols2` | 1,369,954 | not measured | not measured |
| `/hacks` | 21,741 | not measured | not measured |
| **`/tvl/aave-v3`** | **18** | 18 | 18 |

§5's 10.2 MB is correct for `/protocol/aave`, and `aave-v3` is worse. But `/tvl/{slug}` returns the
bare number in 18 bytes, so payload size was never the binding constraint here either. The binding
constraint is the one §5 identified correctly: **a perfect transport proof proves DefiLlama said it.**

### 3.2 Bypassing the aggregator: the experiment

DefiLlama states its own Aave V3 method in the record it serves:

> Counts the tokens locked in the contracts to be used as collateral to borrow or to earn yield.
> Borrowed coins are not counted towards the TVL, so only the coins actually locked in the contracts
> are counted.

That is `underlying.balanceOf(aToken)` summed over reserves. So the reconstruction is:

1. `Pool.getReservesList()` on each Aave V3 Ethereum instance
2. `PoolAddressesProvider.getPoolDataProvider()` then `getReserveTokensAddresses(asset)` for the aToken
3. `underlying.balanceOf(aToken)` and `underlying.decimals()`
4. price from **Aave's own on-chain oracle**, `AaveOracle.getAssetPrice(asset)`, 8-decimal USD

Step 4 is what makes the result a chain-state statement rather than a chain-plus-price-feed statement:
Aave's oracle is a contract, its answer is in EVM state, and it is the price Aave itself liquidates on.

DefiLlama's last Ethereum point for `aave-v3` is stamped `1785244487`. Ethereum block **25,631,552**
has timestamp exactly `1785244487`, drift **0 seconds**, so the comparison is at the same instant and
not across a moving book. Three Ethereum V3 instances answered (Core 67 reserves, Prime 9, EtherFi 4;
an address guessed for the Horizon RWA instance did not answer and was dropped).

### 3.3 The divergence, honestly

| | reconstructed | DefiLlama | difference |
|---|---|---|---|
| raw, no exclusions | 11,472,988,315.50 | 11,415,019,888 | **+57,968,427, +0.508%** |
| priced with DefiLlama's own implied prices instead | 11,474,972,561.23 | 11,415,019,888 | +0.525% |

A 0.508% divergence is not DefiLlama's number, and the task is to say what causes it rather than to
round it away. Two tokens more than account for the whole gap: they contribute +$59,877,425 against a
total gap of +$57,968,427, and the rest of the book nets slightly negative against them.

| token | reconstructed qty | DefiLlama qty | gap |
|---|---|---|---|
| USDT | 535,979,333.356783 | 481,074,327.50127 | +11.41% |
| USDtb | 5,287,436.6049261 | 260,019.49841 | +1,933% |

A block scan back 7,200 blocks (about 24 hours) ruled out snapshot lag: the USDT balance never
approaches 481M anywhere in that window, and USDtb sits at 5.287M for at least 18 hours.

DefiLlama's adapter source names the reason. `projects/aave-v3/index.js`, 2,745 bytes, carries two
Ethereum exclusions: seven `blacklistedTokens` (all Pendle PT reserves) and a `blacklist_lenders`
list of two Ethena backing wallets, `0xb8734a14fbd4aa2d44e6aa830405ffc861ba313c` and
`0x3feaa7483fcfba130e68b41369dd78ff30465459`. Ethena's own deposits are removed from Aave's TVL so
they are not counted twice, once by Aave and once by Ethena.

Applying those two documented rules to the on-chain reconstruction, and nothing else:

| token | on chain | minus Ethena wallet | DefiLlama | |
|---|---|---|---|---|
| USDT | 535,979,333.356783 | **481,074,327.50127** | 481,074,327.50127 | exact |
| USDtb | 5,287,436.6049261 | **260,019.49840793** | 260,019.49841 | exact |
| USDe | 228,176,047.046633 | **228,176,045.747306** | 228,176,045.74731 | exact |
| USDC | 222,054,552.287617 | 222,054,551.190876 | (matched already) | |

All seven blacklisted PT reserves were present on chain and were dropped, together worth $74,062. Two
symbol aliases account for the apparent unmatched rows: DefiLlama calls EURC "EUROC", and MKR's
`symbol()` returns a bytes32 that a naive string decoder misses. Both carry quantities identical to
DefiLlama's to every published digit once the alias is applied.

**Final divergence, after applying DefiLlama's own two rules:**

| | value |
|---|---|
| reconstructed, Aave oracle prices | **11,413,041,125.36** |
| DefiLlama | **11,415,019,888** |
| absolute | **-1,978,763** |
| relative | **-0.01733%, or -1.73 bps** |
| tokens compared | 57 of 57 |
| median quantity error | **1.5e-9 %** |
| p90 quantity error | 6.2e-7 % |
| worst quantity error | 1.78e-5 % |
| unmatched | 3 dust PT reserves, $1,067 total, which DefiLlama drops |

**The token quantities are exact.** A worst-case relative error of 1.78e-5 percent across 57 tokens is
double-precision print formatting, not disagreement. The entire residual 1.73 bps is **price**:
+$3.88M of positive price differences against -$5.86M of negative ones, netting -$1.98M. The largest
single lines are WBTC (-$2.22M), osETH (+$2.19M), rsETH (+$1.23M) and WETH (-$1.19M): Aave's oracle
uses capped LST exchange-rate feeds where DefiLlama uses market quotes, and they differ by tenths of a
percent on exactly those assets.

So the honest statement is: **the balance half of DefiLlama's TVL is exactly reproducible from
Ethereum state, and the price half is a separate oracle question that reconstruction inherits rather
than solves.** It does not become DefiLlama's number and this document does not claim it does. It
becomes a number with a stated method over verifiable inputs, which is the thing `PHASE_D_RESEARCH.md`
§5 said could not exist.

### 3.4 A second protocol, to check it was not a fluke

Lido is the opposite extreme: one contract, one method. DefiLlama's last Ethereum point for `lido` is
stamped `1785242639` and reports `WETH: 9352130.64906` inside a $17,571,556,671 total. Ethereum block
**25,631,398** has that exact timestamp, drift 0 seconds.

| | value |
|---|---|
| `stETH.getTotalPooledEther()` at that block | **9,352,130.649063373** |
| `stETH.totalSupply()` at that block | 9,352,130.649063373 |
| DefiLlama `tokens.WETH` | 9,352,130.64906 |
| divergence | **0.000000%** |

One `eth_call`, exact to every published digit. The remaining $544,183 of Lido's Ethereum TVL is the
stMATIC leg, which needs the stMATIC-to-MATIC exchange rate as well as the supply; that rate is also a
contract call, so it is more work rather than different work. It is 0.003% of the total.

So the reconstruction is not an Aave-specific trick. It ranges from one call to 160 depending on how
much structure the protocol has, and in both cases the quantities come out exact.

### 3.5 What it costs to run

| | reconstruction | DefiLlama |
|---|---|---|
| round trips | **1** (Multicall3 `aggregate3`, 160 sub-calls) | 1 |
| request bytes | 71,947 | ~500 |
| response bytes | **51,367** | 9,566,382 |
| total wire | **123,314** | 9,566,882 |
| latency | 943 ms | 1,355 ms |
| result | 11,472,988,315.499577 | 11,415,019,888 |
| anchored to | block 25,631,552 | nothing |

**78x less on the wire, in one round trip, pinned to a named block.** The Multicall3 path reproduces
the sequential figure to the last decimal (629 sequential calls, 1,248,432 bytes, same answer).

A second run through an independent code path, `m16-second.mjs`, which drops the seven blacklisted
reserves before building the batch and folds the Ethena subtraction into the same aggregate (292
sub-calls over 73 reserves, 1,016 ms), returns **11,413,041,125.361605** against the sequential
pipeline's **11,413,041,125.361603**. Two implementations, one answer, to the fifteenth digit. The
total Ethena exclusion measures **$59,873,127.95**.

### 3.6 The comparison has to be per-reserve, and this is the measurement that proves it

The temptation is to compare the reconstruction against DefiLlama on the aggregate and call the
difference a gate. That gate cannot fail usefully. Measured against the same snapshot:

| aggregate band | headroom after the honest 1.73 bps | tamper needed on the largest reserve to trip it |
|---|---|---|
| 1 bps | **negative**, the honest reading is already red | n/a |
| 5 bps | $3,728,747 | 16.3 bps on weETH |
| 10 bps | $9,436,257 | **41.2 bps on weETH** |
| 25 bps | $26,558,787 | 116.0 bps on weETH |
| 50 bps | $55,096,337 | 240.6 bps on weETH |

weETH is 20.07% of the total, and it is the most visible reserve there is. Worse, at a 10 bps
aggregate band, **32 of the 57 reserves could be set to zero and the gate would still read green**,
because those 32 together are worth $33,533,833, less than the headroom.

So the honest design conclusion, which is the same lesson `verifier-discipline` records: compare
**per reserve** with a per-reserve band, and use the aggregate only as a headline. An aggregate
comparison is a summary, not a verifier. This document is not building the gate, but any gate built
on top of §3 that compares totals would be a gate that cannot go red.

### 3.7 And it is Merkle-provable, mostly

`m11-proof.mjs` finds each underlying's balance mapping slot by scanning indices 0..59 in both
Solidity and Vyper layouts, then runs the repo's existing `anchorState()` verifier (account proof
against `stateRoot`, `stateRoot` against a recomputed 21-field header hash, storage proof against the
proven `storageHash`).

| token | slot | layout | proof verifies | account proof | storage proof | total |
|---|---|---|---|---|---|---|
| WETH | 3 | solidity | yes | 3,911 | 2,559 | 6,470 |
| WBTC | 0 | solidity | yes | 3,911 | 2,559 | 6,470 |
| USDT | 2 | solidity | yes | 3,732 | 3,315 | 7,047 |
| USDC | 9 | solidity | yes | 3,847 | 3,186 | 7,033 |
| wstETH | 0 | solidity | yes | 3,815 | 2,319 | 6,134 |
| weETH | not found in 0..59 | not measured | not measured | not measured | not measured | not measured |

Five of six, mean **6,679 bytes** per reserve. Extrapolating to 57 reserves gives about **381 KB** of
proof, which is an estimate and probably an overestimate: the top nodes of the account trie are shared
across every token contract at the same block and would deduplicate.

weETH is the honest failure: it uses namespaced (ERC-7201) storage, so the balance mapping does not
live at a small integer index and cannot be found by scanning. Its layout is public in the source, so
this is per-token work rather than an obstacle, but it means slot discovery is not fully automatic.

### 3.8 How far this generalises

Measured from `/lite/protocols2`: 7,774 protocols tracked, 5,631 with positive TVL, $237.08B total.

| top N protocols | share of all TVL |
|---|---|
| 10 | 36.61% |
| 25 | 57.54% |
| 50 | 73.56% |
| 100 | **85.40%** |
| 200 | **92.90%** |
| 500 | 98.36% |

97 of the top 200 are single-chain, so half of them need one chain's state and no cross-chain
aggregation. The reconstruction is per-protocol adapter work, and the adapters already exist and are
open source: the whole Aave V3 config file is 2,745 bytes.

### 3.9 Where it stops, structurally

Two categories cannot be reconstructed from chain state no matter how much adapter work is done, and
together they are **30.1%** of all tracked TVL:

| category | share of TVL | why chain state does not answer it |
|---|---|---|
| Bridge | 18.9% | the number is a custody claim about the source chain, and canonical bridges are a claim about an off-chain operator |
| RWA | 11.2% | the asset is a treasury bill in a custodian's account. No amount of EVM state says it is there |

And `protocol-pulse` needs more than TVL. Its incident record comes from `/hacks`, which is an
editorial dataset assembled by humans. There is no chain-state reconstruction of "was this protocol
exploited". The service already handles a failed fetch correctly (it flags
`INCIDENT_REGISTRY_UNAVAILABLE` rather than reading absence as clean), which is the right shape, but
the registry itself is unverifiable in principle.

Historical series are a cost rather than a barrier: the 7-day, 30-day and 90-day-drawdown numbers need
the same reconstruction at ~90 historical blocks. At 160 sub-calls per block that is roughly 14,400
sub-calls, or 90 Multicall3 round trips, against an archive node. That is an **estimate** scaled from
the measured single-block cost, not a measurement.

### 3.10 Verdict, DefiLlama

**Solvable, with named work, for the TVL half of `protocol-pulse`, and structurally impossible for the
incident half.**

Named work, in order:

1. A `llama-recon` module that, for a named protocol, reads reserve lists and balances from chain and
   prices them from the protocol's own on-chain oracle. Aave V3 Ethereum is done and measured above.
2. Publishing the method next to the number. The reconstruction is only honest if the exclusions are
   stated, because they are the whole 0.5% gap.
3. `eth_getProof` anchoring per reserve, at about 6.7 KB each, using the verifier already in the repo.
4. A gate that goes red when the reconstruction and DefiLlama diverge beyond a calibrated band, with
   the band derived from a long run rather than from the single 1.73 bps reading here.

The methodology objection in `PHASE_D_RESEARCH.md` §5 is answered, but not by defeating it. It is answered by moving the
methodology into the open where a caller can read it, and by making every input to it Merkle-provable.
Two honest methods can still disagree; the difference is that both are now checkable.

---

## 4. Polymarket

### 4.1 The book is small, and the `hash` is now identified

`m9-poly.mjs` across 12 live markets ordered by liquidity:

| | bytes |
|---|---|
| largest book, decoded | 1,989 |
| mean book, decoded | 801 |
| largest book, wire (brotli) | 762 |
| gamma market record | 8,806 (88 fields) |
| `/midpoint` | 17 |
| `/price` | 18 |
| `/spread` | 19 |
| `/last-trade-price` | 31 |
| `/sampling-markets` | 2,441,611 |

A Polymarket book is one to two kilobytes. Payload size has never been the problem here.

The `hash` field is:

```
hash == sha1( JSON.stringify( { ...body, hash: "" } ) )
```

Reproduced on **11 of 12** books. The twelfth is an empty book (0 bids, 0 asks, 59-byte response)
whose serialisation differs. `PHASE_D_RESEARCH.md` §5 called this "the trap case" and it is worse than that description: it
is a keyless self-digest, so it binds the payload only to itself, and it is **SHA-1**, which has had a
public chosen-prefix collision since 2017. As an integrity check against a malicious server it is
inert; as an integrity check against a truncated response it works.

Headers and body carry no signature field. Consistent with §2 of `PHASE_D_RESEARCH.md`.

### 4.2 The orders are signed. That is the finding.

From `Polymarket/ctf-exchange`, `src/exchange/libraries/OrderStructs.sol`:

```
bytes32 constant ORDER_TYPEHASH = keccak256(
    "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,"
    "uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,"
    "uint256 feeRateBps,uint8 side,uint8 signatureType)"
);
```

That is one string in the source, wrapped here for width. The struct carries `bytes signature` as its
last field, with four signature types: EOA ECDSA EIP-712, POLY_PROXY, POLY_GNOSIS_SAFE, and POLY_1271
for contract wallets.

Every resting order in the Polymarket book is an EIP-712 message signed by its maker, held by the CLOB
operator, and validated on chain at match time. The book is therefore **not** an unsigned aggregate
that some venue chose to compute. It is a collection of signed statements that the venue chooses to
publish only in aggregate.

No public endpoint returns them. Measured:

| endpoint | status |
|---|---|
| `/orders` | 405 |
| `/data/orders` | 401, `Unauthorized/Invalid api key` |
| `/trades` | 401 |
| `/order/{hash}` | 404 |
| `/book` | 200, aggregated price levels only |

This converts the Polymarket problem from a cryptography problem into an API problem, which is a much
better class of problem. It also means the fix is not something Quiver can build alone: a
self-authenticating book requires Polymarket to emit `signature`, `maker`, `salt`, `expiration` and
`nonce` per level, and a verifier that recovers the signer and checks the maker's balance and
allowance on chain. Every part of that except the emission already exists.

### 4.3 What is on chain: resolution, exactly

`payoutNumerators(bytes32,uint256)` and `payoutDenominator(bytes32)` are public getters on the
ConditionalTokens contract (`0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`, Polygon), so they are
contract storage and therefore `eth_getProof`-able. Checked against gamma's reported outcome for four
resolved markets:

| market | gamma `outcomePrices` | on chain numerators / denominator | agrees |
|---|---|---|---|
| cs2-invict1-en2 total games 2.5 | `["0","1"]` | 0, 1 / 1 | yes |
| ethereum-above-2275-april-21 | `["1","0"]` | 1, 0 / 1 | yes |
| cs2 map handicap away 1.5 | `["1","0"]` | 1, 0 / 1 | yes |
| spl-ith-qad exact score 1-1 (neg risk) | `["0","1"]` | 0, 1 / 1 | yes |

Four of four. Resolution is fully verifiable with the machinery already in `adapters/ethproof.js`.

Escrowed collateral is also on chain: USDC.e held by the CTF measured at **$180,192,774.90**. Note
that new fills settle in `pUSD` (`0xc011a7e1…`, 6 decimals), so a collateral reconstruction must
follow both tokens.

### 4.4 What is on chain: fills, up to the fee

`m13-fills.mjs` took 8 distinct recent trades from `data-api`, pulled each transaction receipt from
Polygon, and rebuilt the trade from the ERC-1155 `TransferSingle`/`TransferBatch` on the CTF plus the
ERC-20 collateral `Transfer` legs touching the same proxy wallet.

| quantity | reconstructed exactly |
|---|---|
| size, in shares | **8 of 8** |
| timestamp (block timestamp equals reported timestamp) | **8 of 8** |
| price | **3 of 8** |

The five price misses are all the fee. Where the receipt carries two collateral legs (trade plus a
separate fee transfer) the trade leg reproduces the reported price exactly, measured at 0.990000
against 0.99 and 0.870000 against 0.87. Where the fee is netted into a single transfer, the implied
price differs from the reported one by:

| reported | on chain, single leg | difference | side |
|---|---|---|---|
| 0.149999976 | 0.158925 | +0.008925 | BUY |
| 0.85 | 0.858925 | +0.008925 | BUY |
| 0.01 | 0.010693 | +0.000693 | BUY |
| 0.15 | 0.141500 | -0.008500 | SELL |
| 0.13 | 0.122500 | -0.007500 | SELL |
| 0.995 | 0.995000 | 0 | SELL |

Always against the trader. The deviation divided by `min(p, 1-p)` is 0.0595 at p=0.15, 0.0595 at
p=0.85, 0.0693 at p=0.01, 0.0577 at p=0.13 and 0.0485 at p=0.99, so the fee scales with the cheaper
side of the market at roughly 5 to 7 percent of it. That inference is from these six observations
only; Polymarket's published fee formula was not pulled, and the spread between 0.0485 and 0.0693 is
not explained here.

So the fill price is recoverable from chain **up to a fee term that is itself on chain but not always
separable without the venue's fee formula**. Mean receipt size 13,370 bytes.

This is enough to verify `poly-desk`'s realised-flow inputs and any statement about what actually
traded. It is not enough for `poly-fill`, whose entire subject is resting depth that never reaches a
block.

### 4.5 Verdict, Polymarket

**Split three ways, and each part gets a different answer.**

| service | input | verdict |
|---|---|---|
| resolution and settlement (any service) | `payoutNumerators`, `payoutDenominator`, collateral balances | **Solved.** Contract storage, `eth_getProof`-able, verified 4 of 4 |
| `poly-desk` realised flow, `updown-pulse` outcomes | fills | **Solvable with named work.** Size and timestamp exact 8 of 8; price exact once the fee leg is separated, which needs the fee formula |
| `poly-fill` book depth, slippage, impact | resting order book | **Solvable in principle, blocked on the venue.** The orders are EIP-712 signed at origin. Nothing published exposes the signatures. Not a cryptographic limit, a publication choice |

The `poly-fill` row is the one worth restating, because `PHASE_D_RESEARCH.md` §5 files it as "off
chain by design" and that phrasing implies a structural fact. The design signs every order. What is off chain is the
*publication* of those signatures, and that is a request Polymarket could grant without changing a
line of its settlement contracts.

Until then the honest envelope for `poly-fill` says: this is the operator's aggregate of orders it
holds signatures for, we cannot check the aggregation, and here is the sha1 self-digest it shipped,
which proves nothing.

---

## 5. Ranking, cheapest first

| # | work | cost | what it buys |
|---|---|---|---|
| 1 | send `Accept-Encoding: gzip` and restate the Deribit payload figure | one line, already the default | retracts the "7x any benchmark" claim. 37,228 bytes measured |
| 2 | switch `protocol-pulse`'s level read to `/tvl/{slug}` where only the level is needed | trivial | 18 bytes instead of 9.5 MB |
| 3 | `llama-recon` for Aave V3 Ethereum | one module, measured at 123 KB and 943 ms | TVL from chain state, 1.73 bps from DefiLlama, exact in quantities |
| 4 | `eth_getProof` anchor per reserve | reuses `anchorState()` unchanged | ~6.7 KB per reserve, Merkle-proven balances |
| 5 | Polymarket resolution anchor | reuses `anchorState()` unchanged | resolution verified, 4 of 4 |
| 6 | Polymarket fill reconstruction from receipts | one decoder | size and time exact, price up to fee |
| 7 | ask Polymarket to publish per-level order signatures | not code | would make the book self-authenticating |

Number 1 is the single cheapest win and it is a documentation fix, not a build.

One thing that must **not** be built, on top of the list already in `PHASE_D_RESEARCH.md` §6: a gate
that compares the reconstruction against DefiLlama **on the total**. §3.6 measures why. At a 10 bps
aggregate band, 32 of 57 reserves could be zeroed and the gate stays green.

---

## 6. Open, and honestly open

Three things this document did not close, listed so they are not mistaken for settled.

**The zkTLS ceilings themselves.** §2.1 measures Deribit's wire bytes. It does not measure any zkTLS
system's documented maximum, and the 51 KB figure it argues against is inherited from
`PHASE_D_RESEARCH.md` §1 rather than re-verified here. The claim that survives is narrow and it is the
one that matters: **the payload is 37,228 bytes, not 372,225**, so the ratio anybody computes against
any ceiling changes by a factor of ten. Whether a given implementation exposes a compressed-transcript
mode, and what its `max_recv_data` actually is, is unresolved.

**Whether anything Deribit-derived is on chain.** One measured negative: Chainlink's public reference
data directory carries **zero** volatility, implied-volatility or option feeds across 316 Ethereum
mainnet feeds and 1,216 Arbitrum feeds, searched for `vol|viv|dvol|implied|option|deribit`. That is a
real negative for the most obvious source. It is not a survey. Volmex's BVIV and EVIV indices, Premia's
volatility surface oracle, and Derive's on-chain feeds were not verified on chain here, and each would
change the picture for `options-desk` if its surface turned out to live in EVM contract storage rather
than being submitted signed at trade time. That distinction is the whole question and it is open.

**Deribit's index constituents.** The index is a composite of spot venues, so it is in principle the
one Deribit quantity a third party could recompute. The public API does not expose the constituent
list: `get_index_price_names` returns 1,497 bytes of index names only, and `get_index` is gone
(`Method not found`). Recomputing it would need the constituent list and the outlier rule from
Deribit's documentation, which was not pulled. Worth an hour, because a recomputable index is a genuine
second opinion where none exists today.

---

## 7. What none of this proves

**A reconstruction is not DefiLlama's number.** It is -1.73 bps away, the gap is entirely price, and
the two use different price sources for good reasons. Anyone quoting the reconstruction as "DefiLlama's
TVL, verified" would be making exactly the claim this document exists to prevent.

**Chain state does not make an off-chain venue honest.** Everything in §3 works because Aave's
positions are on Ethereum. Nothing in that argument transfers to Deribit, where the option chain is
the venue's own book and there is no second copy anywhere.

**A transport proof over the Deribit chain still proves only transport.** The payload objection is
retracted; the semantic objection `PHASE_D_RESEARCH.md` §5 raises in the same row stands unchanged and
is the more important of the two. Cutting 37,228 bytes of MPC would produce a proof that Deribit's
server sent a surface, on a source where whether the surface is right is the entire question.
`PHASE_D_RESEARCH.md` §6 calls that theatre and the label still fits. Nothing in this document is an
argument for building it; it is an argument that one specific reason given for not building it was
wrong by a factor of ten, which is a different thing.

**The Polymarket book is not verifiable today.** Saying the orders are signed at origin is a statement
about what could be built, not about what exists. Every measurement in §4.2 is a 401 or a 405.

**Thirty percent of DefiLlama's tracked TVL is out of reach by construction**, and the incident
registry is out of reach entirely. A service that verified TVL and left the hack record unflagged
would be more misleading than one that verified nothing.

---

## 8. Files

All in the session scratchpad, `scratchpad/offchain/`. Nothing was written into the repo except this
document.

| | |
|---|---|
| `m1-deribit.mjs` | Deribit payload, field inventory, OI distribution, signature scan |
| `m2-wire.mjs` | raw-socket wire bytes for 10 endpoints, gzip against identity |
| `m3-llama.mjs` | DefiLlama endpoint surface, aave-v3 and lido ground truth |
| `m4-aave.mjs` | the reconstruction: 3 pools, 80 reserves, block 25,631,552 |
| `m5-diff.mjs` | per-token divergence before exclusions |
| `m6-lag.mjs` | rules out snapshot lag as the cause of the USDT gap |
| `m7-formula.mjs` | candidate formulas against DefiLlama's number |
| `m8-ethena.mjs` | applies DefiLlama's own two exclusions, lands on -1.73 bps |
| `m9-poly.mjs` | Polymarket book sizes, `hash` reproduction, CLOB endpoint sizes |
| `m10-polychain.mjs`, `m10b-fill.mjs` | resolution getters, escrowed collateral, receipt decode |
| `m11-proof.mjs` | balance-slot discovery and `eth_getProof` sizes |
| `m12-prune.mjs` | Deribit projection against the real `computeGex` / `atmForwardIv` |
| `m13-fills.mjs` | 8 fills rebuilt from Polygon receipts |
| `m14-multicall.mjs` | the deployable one-round-trip reconstruction |
| `m15-ivcross.mjs` | Deribit against OKX on 538 matched option instruments |
| `m16-second.mjs` | independent second implementation of the reconstruction, plus the red half |
| `llama-aavev3-adapter.js` | DefiLlama's own aave-v3 config, fetched, 2,745 bytes |
| `llama-aavev3-eth-last.json` | DefiLlama's Ethereum token and USD breakdown at ts 1785244487 |
