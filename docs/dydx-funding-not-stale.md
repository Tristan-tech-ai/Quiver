# dYdX funding is not stale, and the reconstruction that suggested it was is incomplete

> **SUPERSEDED IN PART, 28 July 2026.** This document was right that the feed is correct and right
> that the reconstruction was incomplete. It was wrong to leave the gap open. A later pass transcribed
> dYdX's `MaybeProcessNewFundingTickEpoch` and recomputed the rate from its store inputs: **144 of 144
> funding ticks integer-exact** across 12 markets, 30 of 30 again on a second independent archive, and
> `nextFundingRate` itself 18 of 18 at a worst relative error of 2.7e-14, end to end from a signed
> CometBFT header through a verified ICS-23 proof. The interest term this document could not locate is
> a clamp, and it is deterministic.
>
> The gap that made it look impossible was one wire type: `premiums` is `repeated sint32`, zigzag
> encoded, so a plain `int32` read returns roughly −2x the true value.
>
> **dYdX funding is verifiable today, for every market and not only the sampled ones.** See
> `PHASE_D_FUNDING.md`. Everything below stands as the record of how far the evidence reached at the
> time, including the part that was too cautious.

**Measured 28 July 2026. No code changed: nothing was found to be wrong.**

## The claim under test

A prior measurement found that only 17 to 22 of dYdX's 296 markets carry premium samples in
`PremSamples` at any instant, that 201 of 296 nonetheless report a nonzero `nextFundingRate`, and that
over a 130-second control the 19 sampled markets all moved while **none** of the 277 unsampled ones
did. The inference drawn was that for roughly 94% of symbols the indexer serves a value carried over
from the last epoch that sampled that market, and that `perp-gate` therefore consumes stale funding.

Every one of those measurements reproduces. The inference from them does not survive.

## The test the inference had never had

The gap was named in the report itself: the behaviour across an actual funding tick was never
observed. It does not need waiting for one. `/v4/historicalFunding/{ticker}` publishes one settled
entry per hour with an `effectiveAt`, so a tick that already happened is as good as one you sit
through.

Sampled 24 markets carrying a nonzero `nextFundingRate`, spread across the list rather than taken from
the top:

| | |
|---|---|
| last six hourly rates all identical | **21 of 24** |
| last six hourly rates varying | 3 of 24 (BTC, JUP, PUMP) |
| **markets with a fresh 13:00 entry** | **24 of 24** |

The last row is the answer. **A carried-forward value produces no new hourly entry.** Every one of
these markets settled a fresh entry at 13:00. They are being funded every hour; the rate simply does
not change.

## Why it does not change, and why the value is correct

Across all 296 markets the `nextFundingRate` histogram is not a spread. It is a spike:

| value | markets |
|---|---|
| **1.25e-5** | **182** |
| 0 | 93 |
| everything else | 21, all distinct |

`1.25e-5` per hour is `1.0e-4` per eight hours, which is 0.01% per 8h: the standard interest-rate term
in a dYdX-style funding formula. Funding is premium plus an interest-rate component, and when a market
has no premium samples the premium contributes nothing and the interest term is the whole answer.

So the 182 markets sitting on that constant are not showing a stale number. They are showing the
**correct** number for a market whose premium is zero, and they re-settle it every hour, which is
exactly what the fresh 13:00 entries show.

## What actually was wrong: the reconstruction, not the feed

The reconstruction that started this was

```
nextFundingRate_1h = mean(premium samples, sint32 ppm) / 8 / 1e6
```

and it matched exactly on 17/17, 17/17, 17/17, 17/17 and 19/19 markets across five snapshots. Those
are real matches and they are not luck. But every market in them was a **sampled** market, where the
premium term dominates.

The formula has no interest-rate term. That is why it reproduces sampled markets perfectly and says
nothing about the other 94%: for those, the quantity it computes is zero, and zero is not what the
chain settles. **A formula validated only where one of its terms vanishes has not been validated.**

## Decision: no change to `src/adapters/dydx.js`

The two options the brief offered were to disclose funding as stale for unsampled symbols, or to
derive it from the store. Neither is right, because the premise is not.

- Disclosing it as stale would tell a buyer something **false**. The value is current and correct.
- Deriving it from `PremSamples` alone would be a **regression**: it would return zero for 182 markets
  that currently return the right answer.

`fundingHourly = Number(m.nextFundingRate)` stands. `perp-gate` is consuming a live, hourly-settled
figure.

## What this does change

The attestation work, not the correctness. `PHASE_D_HARD_CASES.md` moves dYdX funding out of the
"blocked" column on the strength of that reconstruction. That move is still right in direction and
**incomplete in substance**: the reconstruction covers the 17 to 22 sampled markets and would need the
interest-rate term, and its parameters, to cover the rest. Whether those parameters are readable from
the store is not established and has not been looked for.

So the honest status of dYdX funding attestation: **provable today for the markets that carry premium
samples, unproven for the 182 sitting on the interest-rate constant.** That is a narrower claim than
the one currently written down, and it is the one the evidence supports.

## What was verified and what was not

Verified: the histogram, the fresh hourly entries across 24 markets, the arithmetic that `1.25e-5`
per hour is 0.01% per 8h, and that `PremSamples` returns a 2-op existence proof.

Not verified: that dYdX's interest-rate parameter is exactly 0.01%/8h rather than a coincidence of the
same magnitude, and that no market sits on `1.25e-5` for some unrelated reason. Both would be settled
by reading the funding parameters out of the chain's own params store, which is the obvious next step
and was not taken here.
