# T10: a bound on the Hyperliquid premium. It pins about a quarter of asset-hours, not 71%.

**28 July 2026. Opened by V1. Repo-only plus live reads of public endpoints — nothing deployed,
nothing signed, no money moved. `src/engine/` untouched: `q1-e1fa99d08887d6cc` before and after.
Measurement scripts live in scratchpad (`.../cdeb06fc-.../scratchpad/t10/`); the adapter, the gate,
the calibration and the fixture are in the repo and mirrored to `Quiver/`.**

---

## Verdict

**The opening is real, the mechanism works, and it closes on roughly two fifths of the hours it
could close on.**

An on-chain-readable bound on the Hyperliquid premium exists, is *tight* in the information-theoretic
sense, and pins the hourly funding rate exactly — with no new data source — on a large minority of
asset-hours.

| | measured |
|---|---|
| asset-hours where the venue's rate is the constant 1.25e-5 (a bound *could* work) | **68.36%** on the measured hour, **67.12%** over 12 days |
| asset-hours the chain-readable bound **proves**, margin applied, against the venue's own published premium | **25.99%** |
| the same without the margin, against the venue's premium averaged on our grid | **29.38%** |
| recall on the hours a bound could have worked on | **38.02%** (margin applied) |
| projected over 50,976 published asset-hours | **31.48%** pinned, **46.90%** recall |

Headline measured on **UTC hour 16:00, 720/720 samples, 177 assets, zero sampler errors**, against
Hyperliquid's own published `fundingHistory` for that hour.

**What is short, and by how much.** The no-clamp band is asymmetric — `P ∈ [-4e-4, +6e-4]`, i.e.
4 bps of room below zero and 6 bps above. The bound is one-sided per sample and always contains
zero, so the two edges are consumed independently, and they are nothing alike:

| edge | what the bound uses (raw / with margin) | allowed | verdict |
|---|---|---|---|
| **upper** (+6 bps) | p50 **0.00** / 0.58 bps, p90 **1.03** bps | 6.00 | **nearly free** — 171/177 assets clear it |
| **lower** (−4 bps) | p50 **5.45** / 6.03 bps, p90 **11.59** bps | 4.00 | **short by 1.45 bps at the median** — only 58/177 clear it |

So the shortfall is not "an 11 bps bound against 4 bps needed". The upper half costs almost nothing.
**The whole result turns on one number: the median asset's lower bound is 5.45 bps where 4.00 bps is
allowed.** Over the 12-day history, of the non-binding hours the bound fails to prove, **45.08%** are
lost to the low edge and only **5.23%** to the high edge. Had the band been symmetric at ±6 bps,
recall would be **68.13%** instead of 46.90%.

This is not a quirk of one session's regime: **79.6%** of non-binding asset-hours over 12 days carry
a *negative* premium. Hyperliquid perps sit below the index most of the time, which loads the tighter
edge. The venue's band is asymmetric in the unhelpful direction for this technique.

**The bound cannot be improved.** Not "we did not find better" — there is none. Given
`(oracle, best_bid, best_ask)`, two books consistent with the same three numbers produce premia at
the two ends of the interval and every value between, so no verifier holding only those three can
separate them (§6). Tightening requires **order-book depth**, and no HyperEVM precompile exposes it:
`0x80E` returns 64 bytes — two prices, no sizes.

---

## 1. What was run

| | |
|---|---|
| `probe1.mjs`, `identify.mjs` | precompile identification, sandwich-controlled, full 232-perp universe |
| `sampler.mjs` → `tape.jsonl` | every 5 s, one pinned-block Multicall3 read of `0x807` + `0x80E` for all 232 perps, beside the venue's published premium / impact prices. **1,347 ticks, 15:13:50 → 17:06:00 UTC, 112 minutes, 0 errors** — hours 15 (554/720), **16 (720/720)**, 17 (73/720) |
| `chain1s.mjs`, `join1s.mjs` | the same read at every HyperEVM block (~1 s) for 40 assets, to test whether the residual is a sampling artefact |
| `v1fixed.mjs` | independent re-verification of V1's formula, exact BigInt, fresh 12-day harvest |
| `lag.mjs`, `gaps.mjs` | diagnosis of the impact-vs-touch residual; touch-to-impact distances at scale |
| `impactfit.mjs` | fitting the impact price as a book VWAP against real `l2Book` depth |
| `final.mjs`, `project.mjs` | headline numbers, and the projection over 50,976 published asset-hours |
| `gates/calibrate-hl-premium-bound.mjs` | the margin, and the leave-one-out check that says one hour is not enough to fit it |

Total: **238,419 asset-samples** on the chain side, **50,976 published asset-hours** on the history
side, **354 asset-hours** in the replayable fixture.

---

## 2. V1's formula, re-verified rather than inherited

Fresh harvest, own parser, own checker, exact BigInt, **fixed** absolute tolerance:

```
harvested 66,816 rows / 232 coins over 12 days
dead markets removed: 15,840 rows (55 coins, every hour premium==0 && funding==0)
live rows: 50,976
live rows with funding==0 but premium!=0: 0

published rate == correctly-rounded (P + clamp(1e-4-P,±5e-4))/8
  50,976/50,976 = 100.0000%      half-ulp ties 2,082
  clamp NOT binding : 34,217/34,217
  clamp BINDING     : 16,759/16,759
  non-binding share : 67.12%
  non-binding rows printed literally 0.0000125: 34,217/34,217
```

**V1's formula survives an independent re-derivation.** Two corrections to this work’s *reproduction*, both
recorded because each flattered the result:

1. **My first checker could not fail.** It asked whether the published rate was the correctly-rounded
   image of the formula *at the precision the venue printed*. The venue prints a dead market's rate
   as `"0.0"` — one decimal — so the tolerance became ±0.05 and 15,840 rows sailed through. Fixed
   with a **fixed** 5e-11 absolute tolerance (half-ULP at the venue's maximum 10 decimals). The
   headline read 66,816/66,816 before the fix and 50,976/50,976 after; only the second is a
   measurement.
2. **The dead-market exclusion never fired.** V1 drops rows with `premium == 0 && fundingRate == 0`;
   this work compared against `"0"` but the API returns `"0.0"`. Those 15,840 rows are exactly 55 coins ×
   288 hours — the 55 delisted perps — and **zero** live rows have `funding == 0` with a non-zero
   premium, which is the counterexample that would matter. Consistent with V1 §8.

Controls, confirming the fixed checker can fail:

| control | accepted | of which clamp-binding |
|---|---|---|
| unmodified | 50,976/50,976 | 16,759/16,759 |
| premium +1e-9 | 34,217 | **0**/16,759 |
| premium +1e-6 | 34,214 | **0**/16,712 |
| rate ±1e-10 (1 ulp) | 1,051 / 1,031 | the half-ulp ties, and only those |
| rate = B's naive composition | 34,007 | **0**/16,759 |
| **rate = the formula without the /8** | **0**/50,976 | 0 |
| clamp widened to ±5e-3 | 34,217 | **0**/16,759 |

Non-binding rows survive premium perturbations *by construction* — the rate is pinned at the constant
whatever the premium was. That is not a weakness of the checker; it is the entire opening this task
was sent to exploit, visible directly in the control table.

**On 67.12% vs V1's 71.2%:** both are window-specific — V1 measured a 14-day window, this a disjoint
12-day one. The share of non-binding hours moves with the regime.

---

## 3. The two precompiles, identified by measurement

A first pass compared a stale API snapshot against fresh chain reads and produced nonsense (`0x80E`
matching the book on 4/25, the structural inequality "failing" on 11/25). Every number below is
**sandwich-controlled**: the API is read, the chain is read at a pinned block, the API is read again,
and only assets whose value is identical in both API reads are scored — so a disagreement cannot be
blamed on time skew, and cannot be hidden by it either.

```
0x807 vs published oraclePx : 2,104/2,104 sandwich-stable reads EXACT, worst relative error 0
0x80E vs stable l2Book BBO  : 65/66
0x80E returned width        : 64 bytes = two prices. NO SIZES. There is no depth on chain.
```

`0x80E` is the top of book. Its mid reproduces the published `midPx` to a p50 of **0.009 spreads**
and within one spread on **98.9%** of 622 stable reads; a genuinely different register (the oracle)
sits ~9.9 bps away, well over one spread for a typical ~6 bps book.

**The chain read is systematically old, and that had to be measured before anything else made
sense.** Block timestamp vs fetch time: p10/p50/p90 all **1.00–1.01 s** across 1,347 ticks. Worse, a
HyperCore oracle refresh only reaches the EVM at the next block, so the two delays stack. An
`api → chain → api` sandwich therefore does *not* bracket the chain state — the block can predate the
first API read — and an early version of the gate failed on a third of the universe at random because
of it. Padding before the chain read fixes it, and the pad is measured rather than chosen:

| pad before the chain read | 0 ms | 1500 ms | 3000 ms | 4500 ms |
|---|---|---|---|---|
| exact match on sandwich-stable rows | 89.58% | 82.86% | 99.21% | 100.00% |

---

## 4. The bound

The venue's per-sample premium is built from **impact** prices — depth-weighted VWAPs walking away
from the touch:

```
p(t) = ( max(impact_bid − oracle, 0) − max(oracle − impact_ask, 0) ) / oracle
```

A VWAP selling into the bids cannot beat the best bid, and a VWAP buying from the asks cannot beat
the best ask, so `impact_bid ≤ best_bid` and `impact_ask ≥ best_ask`. Substituting the touch bounds
the premium from the inside, using only quantities on chain:

```
LB(t) = −max(oracle − best_ask, 0)/oracle   ≤   p(t)   ≤   max(best_bid − oracle, 0)/oracle = UB(t)
```

Three properties make this worth having:

* **`LB(t) ≤ 0 ≤ UB(t)`, and at most one is non-zero**, because `best_bid < best_ask`. The bound is
  one-sided per sample, which is why the asymmetric band matters so much.
* **When the oracle sits inside the touch, both are zero.** That is not a bound but an exact
  determination: `p(t) = 0`. Measured on **14.79%** of 238,419 asset-samples, and on those the
  venue's own published premium was 0 on **98.11%** (the remainder is the ~1 s chain lag).
* **Bounds compose by linearity, for free** — precisely because V1 established the clamp is applied
  *after* the hour is averaged: `mean(LB) ≤ P ≤ mean(UB)`. Under a per-sample clamp no bound on the
  inputs would survive 720 kinks.

The rate is pinned iff `mean(LB) ≥ −4e-4` **and** `mean(UB) ≤ +6e-4`.

All arithmetic is BigInt at 1e18 with **directed rounding** — `UB` terms round up, `LB` terms round
down, and so do their means. The per-asset price grid `10^(6−szDecimals)` cancels in every ratio, so
it is never applied; the gate checks that scale-invariance explicitly.

Where the oracle actually sits, over 238,419 asset-samples: **inside the touch 14.79%**, best bid
above oracle **8.68%**, **oracle above the best ask 76.52%**. That last number is why the low edge is
the one under pressure. The touch-to-impact distance, measured rather than assumed: bid side p50
**6.69** bps, ask side p50 **5.58** bps, against a top-of-book spread of p50 **5.72** bps. The impact
price *is* the touch on only **2.69%** of samples — those are the ones where the bound is exact.

---

## 5. The residual, and why denser sampling does not fix it

At a point-in-time read the structural inequality does not hold universally:

```
impact_bid <= best_bid : 98.36%      impact_ask >= best_ask : 97.96%     (213,743 skew-free samples)
excess when it fails (bps): bid p50 1.17 p90 4.56 max 48.19 | ask p50 1.26 p90 4.98 max 57.80
LB <= published premium <= UB, per sample: 98.38%
```

A short lookback envelope recovers most of it, which looks like a timing artefact. **It is not.**
Reading every HyperEVM block instead of every 5 s does not close it:

| envelope | 5 s grid | 1 s grid (every block) |
|---|---|---|
| 0 s | 95.65% | 95.00% |
| 5 s | 97.24% | **98.10%** |
| 20 s | 99.01% | 98.71% |
| 60 s | 99.40% | 99.14% |

Block-rate sampling buys about a point and then saturates. The residual is a real property —
published impact prices are rounded to the price grid, and HyperCore's book moves between the states
the EVM exposes at all. So it is carried as a **measured margin**, never as an assumption.

**It matters far less than it looks**, because the clamp applies to the hour's *average*. A
per-sample violation of ~1 bp on 2% of samples moves the hourly mean by ~0.03 bps against a 4 bps
edge. Measured at the hour level against the venue's own published premium: the **raw** bound, with
no margin at all, already contained it on **352 of 354** asset-hours.

There is a second, separate error of the same kind, and it is reported rather than absorbed: the
venue averages the premium on **its** 5-second grid, the attestor on its own. On the fully-covered
hour that mismatch is **p50 0.020 bps, p90 0.066, max 0.165**. The same measurement also *settled*,
rather than assumed, which hour a `fundingHistory` entry belongs to: scoring both alignments gives
**0.181 bps** for "entry at time *T* averages [*T*−1h, *T*)" against **1.335 bps** for the other, so
the entry is stamped at the **end** of the hour it averages.

### The margin is the weak half, and a leave-one-out says so

A margin fitted and tested on the same rows is not a measurement, so the calibration fits on the
best-covered hour and tests on the other. **It fails:**

```
fitted on 16:00 (coverage 100%): worst residual 0.081 bps -> trial margin 0.162 bps
  tested on 15:00: 177 asset-hours, exceeding the trial margin 1, worst uses 179.53% of it  <- FAILS
  the worst out-of-sample residual is 3.59x the in-sample worst.
```

So **one hour is not enough to calibrate this**. The shipped margin is fitted across every hour
observed — `2 × 0.292 bps = 0.583 bps` — and the worst honest asset-hour uses **50.00%** of it
(kPEPE), with **0 of 354** exceeding it. It is still **not proven sufficient for an unseen hour**,
and that is the honest status of the number rather than a claim that it was validated.

---

## 6. The bound is tight

The gate demonstrates this by construction (`T10.12`) rather than asserting it. Fix
`(oracle 1000, bid 998, ask 999)`, so the chain-readable bound is `[−10.00, 0.00] bps`:

* **All depth at the touch** → impact prices equal the BBO → premium **−10.00 bps**, the lower endpoint.
* **Dust at the touch, the rest past the oracle** → the impact ask clears the oracle → premium
  **0.00 bps**, the upper endpoint.

Both books are consistent with the same three on-chain numbers, and every value between is reachable
by interpolating the depth. **A verifier holding only `(oracle, best_bid, best_ask)` cannot narrow
this interval**, so the result is not a deficiency of this construction — it is the ceiling for this
input set.

The impact-price-as-VWAP model underwriting the argument was fitted against real `l2Book` depth:
exact on BTC (0.00 bps), 0.15 on BNB, 0.36 on HYPE, 0.49 on MORPHO; within 5 bps on 15 of 26 assets
sampled across the universe (the loose ones are thin books, where a snapshot taken milliseconds later
has already moved). Correspondingly, when the oracle is *inside* the touch the premium is forced to 0
for **every** book — checked against three different depth profiles.

---

## 7. What it buys

Hour 16:00 UTC, 720/720 samples, 177 assets, against Hyperliquid's own published premium and rate:

```
bound brackets the venue premium   : 175/177 raw, 354/354 with the margin
bound PINS the rate                : 46/177 = 25.99%   (52/177 = 29.38% before the margin)
venue non-binding (rate 1.25e-5)   : 121/177 = 68.36%
recall on non-binding hours        : 38.02%   (42.28% before the margin)
attested hours whose published rate was NOT 1.25e-5 : 0
refused hours that really were 1.25e-5              : 75      <- the cost of soundness
hourly bound width (bps)           : p50 5.65  p90 12.29  max 84.8
```

How much the band would have to give for the bound to close, holding the high edge at 6 bps:

| low edge (bps) | 2 | 3 | **4 (real)** | 5 | 6 | 8 | 10 | 15 |
|---|---|---|---|---|---|---|---|---|
| asset-hours pinned | 16.4% | 22.0% | **29.4%** | 40.7% | 52.5% | 70.6% | 82.5% | 93.2% |

### Projection over 50,976 published asset-hours

One window is one window. Taking each asset's **measured** bound slack from the live tape and
applying it across the 12-day published history — stated assumption: an asset's slack, a liquidity
property, is roughly stable hour to hour —

```
venue non-binding (rate is 1.25e-5) : 34,217/50,976 = 67.12%
bound would pin                     : 16,047/50,976 = 31.48%
recall on non-binding hours         : 46.90%
pinned but NOT actually in band     : 0
of the 34,217 non-binding hours: lost to the LOW edge 45.08%, the HIGH edge 5.23%, both 2.79%
per-asset slack, low side (bps)     : p25 1.13  p50 2.98  p75 5.31  p90 7.94
```

**31.48% projected against 29.38% measured directly on the full hour** — two sample constructions
sharing no arithmetic, agreeing to about two points. Sensitivity, since the slack is the whole story:

| slack multiplier | asset-hours pinned |
|---|---|
| ×0 (a perfect bound — unreachable) | 67.12% |
| ×0.5 | 48.60% |
| **×1 (measured)** | **31.48%** |
| ×2 | 14.62% |

Pinning tracks liquidity, which is the practical shape of the result:

| oracle sits inside the touch | assets | pinned |
|---|---|---|
| 0–5% of samples | 104 | 6% |
| 5–15% | 18 | 28% |
| 15–30% | 19 | 68% |
| 30–50% | 18 | **83%** |
| >50% | 18 | 72% |

Some assets pin essentially always (CFX, kLUNC, MANTA, GOAT, GRIFFAIN, RESOLV: 100% of 288 hours).
BTC pins. ETH misses the low edge with a slack of only 0.29 bps — because its *true* premium was
−3.76 bps, already a hair off the clamp edge. That distinction matters: a large share of the misses
are hours the venue itself sat near or past the boundary, not hours the bound was bad.

---

## 8. What was built

| file | |
|---|---|
| `veritape/src/adapters/hyperliquid-funding-bound.js` | the bound, exact BigInt with directed rounding; `readSnapshot` reads both precompiles for N assets in one pinned-block Multicall3 call (464 sub-calls, 772 ms for the full universe) |
| `veritape/gates/gateT10-hl-premium-bound.mjs` | 12 tests, `npm run gate:t10` |
| `veritape/gates/gateT10-revert.mjs` | the scripted revert, `npm run gate:t10-revert` |
| `veritape/gates/calibrate-hl-premium-bound.mjs` | measures the margin, runs the leave-one-out, emits the fixture — `npm run calibrate:t10` |
| `veritape/gates/hl-premium-bound-{calibration,fixture}.json` | the measured margin, and **354 real venue asset-hours** to replay |

Mirrored to `Quiver/` at the same relative paths.

**The refusals are the point.** The adapter returns `UNATTESTABLE` on an hour the bound does not pin;
it never approximates, never interpolates, and never falls back to the venue's own number and calls
the result attested. `T10.7` measures the cost of that honesty and prints it rather than hiding it:
131 asset-hours refused, of which **75 really were 1.25e-5**.

Three guards, each removed in turn by the revert script, each reddening the tests it protects:

```
GATE T10 REVERT: proving each guard can fail
  engine build id before : q1-e1fa99d08887d6cc
  gate as shipped        : 12 pass, 0 fail
  removed guard: band check (pinFundingRate)
    gate against reverted code : 9 pass, 3 fail   red: T10.3, T10.7, T10.11
  removed guard: premium bound check (checkClaimedPremium)
    gate against reverted code : 11 pass, 1 fail   red: T10.5
  removed guard: coverage assertion (pinFundingRate)
    gate against reverted code : 11 pass, 1 fail   red: T10.8
  gate against restored code : 12 pass, 0 fail
  engine build id after  : q1-e1fa99d08887d6cc
GATE T10 REVERT: PASSED, all three guards are capable of failing
```

The coverage assertion (`T10.8`) is not decoration. `mean(UB)` and `mean(LB)` are means of
**non-negative** excursions, so an attestor that keeps only the quiet samples shrinks its own bound
and manufactures a pin. Forty hand-picked quiet samples out of 720 pin an hour that is not pinnable —
the same defect `gateF-tvl-reconstruct.mjs` §F8 found in an intersection-only comparison, refused the
same way. It reads the honest sample count, not a metadata field: an attempt during development to
replay a 77%-covered hour while *labelling* it 95% was refused as `INSUFFICIENT_COVERAGE`.

### Three thresholds that had to be measured, not chosen

Each was first set from a hopeful assumption, and each was wrong.

* **`T10.2`, the structural inequality.** The violations are the ~1 s chain lag during a price move,
  and a move is **market-wide**, so on a single snapshot the failures are correlated across assets
  and 80 of them average nothing out. Measured over 471 snapshots × 80 assets: a single snapshot's
  pass rate floors at **0.575**, while pooling five snapshots 5 s apart lifts the floor to **0.838**.
  Pooling over time is what makes the test stable; a bigger single snapshot is not.
* **`T10.1`, the oracle identification.** A four-round probe suggested 100%, so the bar went to 0.95
  — the same error as calling one block a measurement, committed against this report’s own threshold. Over 18
  rounds the pooled rate is **97.31%** and the per-round rate is bimodal: 15 rounds at exactly 1.000,
  three at 0.737 / 0.842 / 0.846 when a market-wide oracle refresh straddles the window. The test now
  pools three rounds with the bar at 0.80, against a wrong register that would score near zero.
* **`T10.4`, the margin.** Originally scored only on the hour the margin was fitted on — a check that
  could not fail. It now scores every hour in the fixture, which is what exposed the leave-one-out
  failure in §5.

---

## 9. What remains unattestable

* **About three quarters of asset-hours.** The bound does not pin them; they are refused, not
  approximated. 75 of the 131 refusals on the measured hour really were 1.25e-5 — the price of
  soundness, paid rather than papered over.
* **Every clamp-binding hour.** When the rate is *not* the constant, its value depends on `P` itself
  and a bound is worth nothing. 16,759 of 50,976 live asset-hours (32.9%). No bound on the premium
  will ever reach them.
* **The premium's value, always.** This module never recovers `P`; it proves `P` lies in an interval.
* **Order-book depth — the single missing quantity.** `0x80E` gives two prices and no sizes, and no
  precompile in `0x800`–`0x814` returns depth. With depth at the touch the bound would collapse to
  near-exact on liquid assets (BTC's impact price *equals* its BBO whenever the impact notional fits
  at the touch, measured). A related lead was closed rather than left open: `0x800` returns five
  words with no cumulative funding, so realised funding cannot be read off a position either —
  consistent with the exhaustive sweep already recorded in `hyperliquid-attest.js`.
* **The margin, for an unseen hour.** §5: the leave-one-out failed at 3.59x. Two hours is not enough
  to fit it, and the shipped value is the weak half of this gate.
* **The venue's honesty.** Oracle and book both come from HyperCore. A manipulated oracle is bounded
  with full force. Attestation reaches the venue's state and stops there — the same boundary
  `hyperliquid-attest.js` and V1 §9 both draw.
* **Trust in the transport.** Read off chain, as the adapter runs by default, both reads are unsigned
  HTTPS and one adversary at the network edge sees both. It becomes an attestation only when the
  comparison runs *inside a contract on HyperEVM*, where the precompile value comes from consensus.
  Not deployed; not claimed.
* **The 4%/hour cap.** Still untested, as V1 §8.3 said. Nothing here exercises it.
* **Sample size.** The live measurement is two UTC hours, one of them complete, on one day. The
  12-day projection is the larger corroboration and it rests on the stated stability assumption about
  per-asset slack.

---

## 10. Corrections to the brief

* **"a BBO-derived bound at roughly 11 bps wide against the roughly 4 bps needed"** — the ~11 bps is
  the *impact-vs-BBO gap*, which is not the bound width. The bound width is the oracle's excursion
  outside the touch: p50 **5.65 bps** at the hour level. More importantly the bound is **one-sided**
  and always contains zero, so it is never a symmetric interval and the two edges must be scored
  separately — which is what turns "it does not close" into "it closes on a quarter of asset-hours,
  and the low edge is the only reason it is not more".
* **"71.2% of asset-hours"** — window-specific. On a disjoint 12-day window it is **67.12%**; on the
  measured hour, 68.36%.
* **`0x80e` "is the top of book rather than the impact price, matching BBO 10 of 12 and `impactPxs`
  0 of 12"** — right conclusion, but those counts came from a skew-contaminated comparison. Under
  sandwich control it is 65/66 against the book. And `0x80E` *does* equal `impactPxs` exactly when
  the impact notional fits at the touch (2.69% of asset-samples, routinely for BTC) — that is the
  case where the bound is tight, not a contradiction.
