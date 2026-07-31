# Funding, measured: dYdX is verifiable today, Hyperliquid is one number short

**28 July 2026. Research, repo-only. Nothing here is served, deployed, or on chain. Nothing touches
`src/engine/`, so the published build hash does not move. Every script lives in scratchpad.**

`PHASE_D_RESEARCH.md` puts funding rates in the "needs novel research" bucket for both venues:

> not on chain at Hyperliquid (scanned `0x800`-`0x830`, no match), not located in dYdX's stores

I redid that scan, widened it, and attacked the dYdX store directly. **Half of that claim is wrong.**
dYdX's funding rate is not stored, but it is *exactly recomputable* from state that carries an ICS-23
proof, and I recomputed it. 144 of 144 funding ticks, integer-exact. The Hyperliquid half survives,
and I can now name precisely which single quantity is missing and why.

---

## 1. The scan, redone

My first attempt at this returned **zero** responders over a range where `0x806` demonstrably works.
The bug is worth recording because it inverts the answer, and because a scanner that has it reports
a clean "nothing here" rather than failing loudly. I have not read the original scan's code and do
not claim it had this defect.

On HyperEVM, an address with no precompile behind it returns **success with empty data** (`0x`).
A real precompile handed input it cannot parse returns **`EVM error: PrecompileError`**. So the
error *is* the existence signal, and any scanner that discards errors and keeps successes is reading
the map backwards. Detection here counts both non-empty success and `PrecompileError` as existence.

Measured, HyperEVM mainnet, `https://rpc.hyperliquid.xyz/evm`:

| range | addresses | calldata shapes | responders |
|---|---|---|---|
| `0x000`-`0x7ef` | 2,032 | 1 | `0x2 0x3 0x4 0x6 0x7 0x8 0x9 0xa` (standard EVM) |
| `0x7f0`-`0x8ff` | 272 | 6 | `0x800`-`0x814`, 21 consecutive |
| `0x900`-`0x9ff` | 256 | 6 | none |

**2,560 addresses covered, zero transport errors.** The HyperCore read surface is exactly
`0x800`-`0x814` and nothing above `0x814` exists. The `0x000`-`0x7ef` sweep used a single calldata
shape, so it under-detects there (`0x1` ecrecover needs 128 bytes and was missed); that range holds
no HyperCore precompile and the omission does not bear on funding.

The original range `0x800`-`0x830` did cover `0x811`-`0x814`, which are undocumented. So the widened
range does not overturn the conclusion. **The "no funding precompile" finding stands, on a wider
range and a corrected detector.**

### Word identification without guessing the scale

Rather than test funding against six hand-picked scale factors, I solved for the scale: for each
(precompile, word position) compute `word / funding` across many assets and require the ratio to be
*constant*. A coincidence does not survive 32 assets with 19 distinct funding values.

No word in `0x806`, `0x807`, `0x808`, `0x80a`, `0x80e` or `0x814` is the funding rate at any scale.
Best constancy achieved was a relative deviation of 8.4, where a match needs under 1e-9. One
"perfect" hit in the first pass was an all-zero column dividing into itself; zero columns are now
excluded, which is the second reason the first pass lied.

Perp prices in these precompiles are scaled by `10^(6 - szDecimals)`, confirmed exactly on 6 of 12
assets read (the other 6 differ by 2.6e-4 to 5.6e-4 relative, consistent with the price moving
between the precompile read and the API snapshot, not with a scale error).

---

## 2. Hyperliquid: the formula, and a correction to how the docs read

The documentation gives two statements that must be composed, and composing them wrongly fails
silently on the majority of hours. Written as one hourly expression it is:

```
funding_hourly = ( P + clamp(1e-4 - P, -5e-4, +5e-4) ) / 8
```

`P` is the venue's published hourly `premium` field, which is an **8-hour-scale** premium index.
`1e-4` is the interest rate over 8 hours (0.01% per 8h). The clamp is at 8-hour scale. The division
by 8 is the last step, not folded into the interest term.

Reading it the natural way, with the hourly interest rate `1.25e-5` inside the clamp and no division
by 8, reproduces **0 of 655** clamp-binding hours in a 10-coin subset. It still matches every hour
where the clamp does not bind, which is exactly why the error survives casual checking: it is correct
on the majority of rows and wrong on every row that carries information. Composed correctly:

| | measured |
|---|---|
| sample | 10,752 asset-hours, 40 coins, 14 days |
| exact (abs err < 1e-10) | **10,752 / 10,752** |
| of which clamp not binding | 7,083 / 7,083 |
| of which clamp binding | 3,669 / 3,669 |
| worst absolute error | 5.0e-11 |

5.0e-11 is exactly the half-ulp of the published 10-decimal rate string, so the residual is the
venue's own printing, not the formula. Rows where the market is inactive (`premium == 0` and
`funding == 0`) are excluded; including them the formula "fails" on a market that simply has no
funding.

**A structural consequence worth having.** When `|P - 1e-4| <= 5e-4` the clamp is not binding and
funding is *exactly* the constant `1.25e-5`, whatever the premium happens to be. Measured, that is
**7,083 of 10,752 asset-hours, 65.9%**. In those hours a *bound* on the premium is sufficient; the
premium's value is never needed. The band a bound must beat is `|P| < 4e-4` (measured p99 of `|P|`
in non-binding hours: 3.97e-4).

### Where the premium comes from

```
premium = ( max(impact_bid - oracle, 0) - max(oracle - impact_ask, 0) ) / oracle
```

Reconciles against the venue's own published `impactPxs` and `oraclePx` on **39 of 39 assets, worst
absolute error 4.9e-11**. So the premium is fully determined by three numbers: oracle price, impact
bid, impact ask.

`impact_bid` and `impact_ask` are the average execution prices for a fixed notional. I confirmed that
definition by recomputing them: walking the live L2 book to a candidate notional reproduces the
published `impactPxs` to between 7.1e-6 and 1.6e-4 relative on 5 coins, exactly on BTC. The residual
is the gap between the two fetches. **An impact price is a book walk.**

### Which constituents are actually on chain

| quantity | on HyperEVM | precompile | measured |
|---|---|---|---|
| oracle price | **yes** | `0x807` | exact at `10^(6-szDecimals)` |
| mark price | **yes** | `0x806` | exact |
| best bid / best offer | **yes** | `0x80e` | equals top of book on 10/12 assets |
| **impact bid / impact ask** | **no** | none | `0x80e` equals `impactPxs` on **0 of 12** |
| premium | no | none | derived, needs impact prices |
| funding rate | no | none | no constant-ratio match on any word |

`0x80e` is the touch, not the impact price. That is the whole gap. The two differ by a **mean of
3.98 bps and a worst of 8.67 bps** across 11 assets, against premium magnitudes of order 1e-3, so BBO
is not a usable substitute: the substitution error is the same size as the quantity.

### The bound that BBO does give, and why it is not enough today

Because an impact price is a book walk, `impact_bid <= best_bid` and `impact_ask >= best_ask` hold
**by arithmetic**, not by assumption. That yields a two-sided bound computable from `0x807` and
`0x80e` alone:

```
-max(oracle - best_ask, 0)/oracle  <=  premium  <=  max(best_bid - oracle, 0)/oracle
```

and in particular, if `best_bid <= oracle <= best_ask` then **premium is exactly zero**.

How often that fires was measured, with both precompiles read **at the same pinned block** so there is
no timing gap at all (block 41,674,042, 24 assets):

| | measured |
|---|---|
| oracle inside the spread | 1 / 24 (4.2%) |
| oracle above the ask | 23 / 24 |
| when outside, distance beyond the touch | median 11.12 bps, p90 15.51 bps |

So in the regime measured the bound is real but **too wide**: a median half-width of 11 bps against a
band that needs 4 bps. The bound is valid; it does not currently pin the rate. This is one block in
one regime, with the whole perp complex trading below spot, and it is not a constant.

An earlier version of this test reported the bound *violated* on 30 of 39 assets. That was my error:
the API snapshot was minutes stale by the time the precompile reads ran. Pinning the block removed it.

---

## 3. dYdX: the funding rate is not stored, and is exactly recomputable anyway

The prior finding that `nextFundingRate` is not a key in the store is correct. It is also not the
interesting question, because every input to it is a key in the store.

From `x/perpetuals/keeper/perpetual.go`, `MaybeProcessNewFundingTickEpoch`, transcribed:

```
premiumPpm = AvgInt32( pad0( PremSamples[perp], max(NumPremiums, tickDur/sampleDur) ) )
fundingPpm = clamp( premiumPpm + DefaultFundingPpm,
                    +/- FundingRateClampFactorPpm/1e6 * (InitialMarginPpm - MaintenanceMarginPpm) )
```

`RemovedTailSampleRatioPpm` is the constant `0`, so the documented tail-trimming is a no-op and the
combine is a plain average. `AvgInt32` is Go integer division, truncating toward zero. No floats.

Every input is a provable key. Measured against dYdX mainnet with `prove=true`, all returning
**existence** proofs (`ics23:iavl` then `ics23:simple`):

| key | store | value | proof |
|---|---|---|---|
| `PremSamples` | `perpetuals` | 550-915 B | 1,257-1,795 B |
| `PremVotes` | `perpetuals` | 967-1,443 B | 1,679-2,146 B |
| `Perp:` + be4(id) | `perpetuals` | 30 B | 746-794 B |
| `LiqTier:` + be4(t) | `perpetuals` | 25 B | 794 B |
| `Params` | `perpetuals` | 12 B | 768 B |
| `Info:funding-tick` | `epochs` | 36 B | 464 B |
| `Info:funding-sample` | `epochs` | 37 B | 420 B |

Decoded from those bytes rather than from genesis constants: `FundingRateClampFactorPpm` 6,000,000,
`PremiumVoteClampFactorPpm` 60,000,000, `MinNumVotesPerSample` 15, funding-tick duration 3,600 s,
funding-sample duration 60 s. For BTC (`Large-Cap`, IM 20,000 ppm, MF 600,000 ppm) the clamp bound
works out to **+/- 48,000 ppm per hour**, which never binds in practice.

The indexer publishes the hourly rate as `fundingPpm / 8e6`; dYdX quotes funding on an 8-hour
convention. Every published rate in my sample is an exact multiple of 1/8 ppm, which is what
confirms the divisor.

### The measurement

The indexer's `historicalFunding` gives `effectiveAtHeight`, the exact block at which each tick
executed. Reading `PremSamples` at `effectiveAtHeight - 1` gives the completed epoch's samples,
before the tick clears them. Recompute, compare to the rate the venue published for that hour:

| | measured |
|---|---|
| funding ticks tested | 12 heights x 12 markets = **144** |
| **exact integer match** | **144 / 144** |
| of which nonzero funding | 55 (the rest are markets with no premium activity) |
| largest rate recomputed | 485 ppm |
| repeat on a second independent archive (kingnodes) | **30 / 30** |

The second provider matters: it rules out reading a number back out of one operator's own bookkeeping.
Two independently operated archives return byte-identical store values and both recompute to the rate
the indexer published.

The `nextFundingRate` field that `perp-gate` actually consumes is the running prediction over the
partial epoch, not the tick output. It is reproducible from the same bytes, with float division
instead of integer division:

```
nextFundingRate = sum(PremSamples[perp]) / NumPremiums / 8e6
```

**18 of 18 markets, worst relative error 2.7e-14.** So both the realized rate and the predicted rate
`perp-gate` reads are recoverable from proven state.

### The decode trap that made this look impossible

My first recomputation returned `+737` where the venue published `-369`, on every market. A constant
factor of two with a flipped sign is not noise, and it is not a modelling error. `premiums` is
declared `repeated sint32` with `zigzag32` encoding. Decoded as a plain `int32` varint, every value
comes back as roughly `-2x` its true value. That single wrong wire type is the entire difference
between "dYdX funding is unverifiable" and 144 of 144.

I flag it because the prior conclusion was reached by looking for a stored rate and not finding one.
The rate is not stored. The inputs are, and they decode to the answer.

### End to end, against a signed header

Reusing the already-built ICS-23 verifier and CometBFT light client read-only, with an anchor
constructed at the historical tick height:

| tick height | validators | precommits verified | voting power | 2nd provider app_hash | result |
|---|---|---|---|---|---|
| 99,343,635 | 31 | 28, 0 invalid | 90.93% | match | 3/3 exact |
| 99,337,694 | 31 | 25, 0 invalid | 85.01% | match | 3/3 exact |
| 99,331,840 | 31 | 25, 0 invalid | 85.84% | match | 3/3 exact |

**9 of 9.** Chain: signed header, to verified ICS-23 proof, to recomputed funding rate.

### The check can fail, and this was executed

| control | result |
|---|---|
| perturb one premium sample by +60 ppm | funding -369 becomes -368, **detected** |
| drop the last sample of the hour | -369 becomes -366, **detected** |
| decode premiums as `int32` not `sint32` | -369 becomes +737, **detected** |
| present a proof taken at another height | **rejected** (roots to a different app_hash) |
| ask for the absent key `FundingRate` | **rejected**, not silently zero |

5 of 5.

### One stage below, and honestly incomplete

Samples are themselves the median of validator votes: `sample = MustGetMedian(pad0(PremVotes,
max(NumPremiums, MinNumVotesPerSample)))`, run at each 60 s funding-sample boundary. `PremVotes` is
provable too, so this stage should reproduce as well. It reproduced on **8 of 22** markets tested
across 5 sample-epoch boundaries, with misses small (1 to 15 ppm).

The cause is identified, not mysterious: votes arriving in block `H` are applied before the
end-of-block sample computation, so `PremVotes` read at `H-1` is missing exactly one block's votes.
Recovering it needs the block's own `MsgAddPremiumVotes` from the block data, which is committed
under the header's `data_hash` and therefore provable. **I did not do that.** It is named, bounded
work, not an obstacle.

### Historical state is not universally available

`dydx-rpc.publicnode.com` prunes application state and returns
`proof is unexpectedly empty; ensure height has not been pruned` for a height ~4,000 blocks back,
even though it reports 3M blocks of history. `dydx-dao-rpc.polkachu.com` (earliest 0) and
`dydx-ops-rpc.kingnodes.com` both serve historical proofs. Any verifier for a *past* tick needs an
archive provider, and block retention is not state retention.

---

## 4. Is funding recoverable from settlement?

**dYdX: yes, and it is the on-chain consumer.** `GetSettlementPpmWithPerpetual` in
`x/perpetuals/lib/lib.go` settles a position as `-(fundingIndex - positionIndex) * quantums`, reading
`perpetual.FundingIndex` straight out of the `Perpetual` object, which is the provable `Perp:` key.
So the funding index is both stored and read by settlement.

Measured, ETH-USD across three ticks:

| tick | funding_index | delta | published rate | implied rate | rel err |
|---|---|---|---|---|---|
| 99,343,635 | 1117649 -> 1117562 | -87 | -0.000046125 | -4.5999e-5 | 2.7e-3 |
| 99,337,694 | 1117750 -> 1117649 | -101 | -0.00005425 | | |
| 99,331,840 | 1117858 -> 1117750 | -108 | -0.00005775 | | |

The index delta recovers the rate as `delta / (price * 1000)`, consistent on 3 of 3. **The factor
1000 is fitted, not read**: the file defining `GetFundingIndexDelta` was not at any path I tried, so
I have not confirmed the quantum arithmetic from source. The precision is limited by the index being
an integer: about 0.3% relative for ETH, and worse for lower-priced assets, where a delta of a few
units carries the whole rate. **This path is strictly worse than recomputing from `PremSamples`,**
which is integer-exact. It is worth having only as an independent cross-check.

**Hyperliquid: the arithmetic is documented, the isolation is the problem.**

*Documented* (Hyperliquid docs, quoted): a funding payment is
`position_size * oracle_price * funding_rate`, and the docs are explicit that the **spot oracle price
is used to convert position size to notional, not the mark price**. Both factors are on chain:
`0x800` returns position size, `0x807` returns the oracle price. So a payment plus those two would
yield the rate by division.

*Measured*: none of the asset-indexed precompiles (`0x806`, `0x807`, `0x808`, `0x80a`, `0x80e`,
`0x814`) returns the funding rate at any constant scale, across 40 assets with 19 distinct funding
values. `0x800` returns exactly five words, matching the documented
(`szi`, `entryNtl`, `isolatedRawUsd`, `leverage`, `isIsolated`).

*Not tested*: I did **not** probe the account-shaped precompiles (`0x800`, `0x803`, `0x80f`, and the
unidentified `0x802`, `0x811`, `0x813`) against the per-position `cumFunding` figure the HTTP API
exposes. So "no cumulative funding on chain" is **not found rather than not there**, and that probe
is the cheapest remaining test on this venue.

*Argued, not measured*: the readable account aggregates (`0x803` withdrawable, `0x80f` account margin
summary) move for trades, fees and unrealised PnL as well as funding, so an hourly delta should be
confounded for any account that is not quiescent, and quiescence is not a property you can prove about
someone else's account. **I did not run the cross-boundary delta experiment**, so this is reasoning
from what the fields are, not a measurement. A self-owned quiescent probe position would sidestep it,
at the cost of capital, and it would measure the rate rather than prove the venue's.

---

## 5. What none of this proves

dYdX's premium comes from `k.MemClob.GetPricePremium`. The memclob is each validator's **in-memory
orderbook**, and dYdX documents that the book is never written to application state. Block proposers
sample their local book, submit `MsgAddPremiumVotes`, and the chain takes a median across the
proposers of that minute.

So what the 144 of 144 establishes is that **the chain applied its own rule correctly to its own
committed inputs**. It does not establish that those inputs describe a real orderbook. A validator
set that collectively misreported the book would produce a funding rate that verifies perfectly.
That is the same boundary the rest of this project already draws: attestation is provenance, not
truth. It is a strong result because the failure mode it catches, an indexer or an adapter
misreporting a number nobody recomputes, is the likely one.

For Hyperliquid the boundary is harder still, because the missing quantity is not merely unproven,
it is unpublished on chain in any form.

---

## 5b. Thin evidence, said plainly

The dYdX recomputation covers **12 consecutive hours on one day**, 12 markets, and 55 of the 144 rows
carry a nonzero rate; the 89 zero rows confirm the padding path and little else. The end-to-end
signed-header chain was executed at **3** of those heights, not all 144. The clamp has never been
observed binding on dYdX, so the clamp branch is transcribed from source and **not exercised by any
measurement here**. The vote-to-sample stage is at 8 of 22 with a known cause and no fix applied.
The funding-index quantum factor is fitted from 3 points.

On Hyperliquid the formula rests on 10,752 asset-hours, which is the strongest number in this
document, but the premium bound rests on **one pinned block in one market regime** where the entire
perp complex traded below spot. The impact-price recomputation is 5 coins. None of the Hyperliquid
work establishes a capability; it establishes a formula and a gap.

## 6. Verdicts

**dYdX v4: verifiable today.**
The rate is not stored and does not need to be. `PremSamples`, `Perp:`, `LiqTier:`, `Params` and the
two `Info:` epoch keys all carry ICS-23 existence proofs rooting into an app_hash in a header signed
by more than two thirds of the validator set. The published aggregation over them reproduces the
realized rate integer-exactly (144/144) and the predicted rate to 2.7e-14 (18/18). Remaining work is
engineering, not research: one archive provider, the `sint32` decode, roughly 5 KB of proofs per
market per tick, and the vote-to-sample stage if the layer below is wanted.

**Hyperliquid: needs novel research, and the open question is now specific.**
Not "funding is not on chain". The formula is exact and verified on 10,752 asset-hours. The oracle
price is on chain. The premium is a closed-form function of oracle price and two impact prices, and
the impact prices are book walks to a fixed notional. **The single missing quantity is order book
depth beyond the touch.** `0x80e` gives the top of book and nothing behind it, and no precompile in
`0x800`-`0x814` returns depth. The named open question is:

> Can the hourly average premium be bounded within +/- 4e-4 using only quantities readable from
> HyperEVM, given that best bid and best offer bound each instantaneous impact price by arithmetic?

If yes, funding is pinned *exactly* to `1.25e-5` in the 65.9% of asset-hours where the clamp does not
bind, with no premium value needed. Measured at one pinned block the BBO bound is about 11 bps wide
against a 4 bps requirement, so the answer today is no, but that is one regime on one block and the
bound is valid, not broken. A second obstacle sits behind it: funding uses the hourly average of
5-second samples, so even a perfect instantaneous bound needs 720 accumulated readings per asset per
hour, which a contract can only obtain by being called that often.

**Hyperliquid, structurally impossible variant: no.** Nothing here is an information-theoretic limit
or a hardness result. Depth is data Hyperliquid holds and does not expose. That is a specification,
not a barrier.

---

## 7. Files

All in scratchpad, none in the repo.

| | |
|---|---|
| `scan2.mjs`, `scan3.mjs` | precompile existence scan, `PrecompileError`-aware; 2,560 addresses |
| `match2.mjs` | word identification by solving for the scale, zero-columns excluded |
| `bbo-vs-impact.mjs` | `0x80e` against top-of-book and against `impactPxs`; premium reconciliation |
| `hl-formula2.mjs` | the corrected 8-hour funding formula, 10,752 asset-hours |
| `hl-bound.mjs` | pinned-block oracle-vs-spread; impact price recomputed by walking the L2 book |
| `dydx-probe.mjs` | raw-store probes and key-space sweep via non-existence neighbours |
| `dydx-tick-final.mjs` | the 144-tick recomputation against published rates |
| `dydx-e2e.mjs` | signed header + verified ICS-23 proof + recompute, and 5 falsification controls |
| `dydx-votes.mjs` | the vote-to-sample median stage, 8/22, cause identified |

`perp-gate` is unchanged. No verifier for any of this exists on chain, and nothing above has been
deployed.
