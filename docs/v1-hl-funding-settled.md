# V1: settled. Agent A's formula survives; Agent B measured a different formula than the one it reported

**28 July 2026. Verification pass, repo-only. Nothing served, deployed, or on chain. No project file
touched except this one. Nothing under `src/engine/` read or written, so `q1-e1fa99d08887d6cc` does
not move. Every script lives in scratchpad
(`.../cdeb06fc-.../scratchpad/v1/`).**

---

## Verdict

**A's claim survives, and generalises far past the sample A ran it on.**

```
funding_hourly = ( P + clamp(1e-4 - P, -5e-4, +5e-4) ) / 8      P = published hourly `premium`
```

reproduces Hyperliquid's published hourly `fundingRate` on **167,257 of 167,257 asset-hours**,
across **232 coins** and **five disjoint 14-day windows spanning ten months**, of which **50,026 are
clamp-binding**. Verified in exact integer arithmetic, no floating point anywhere: the published rate
is the correctly-rounded value of the formula on the published premium, on every row, with zero
failures.

**B's four reported statistics are all real, and all four come from a different formula.** Feeding
`fundingHistory` the composition

```
funding_hourly = P + clamp(1.25e-5 - P, -5e-4, +5e-4)           # hourly interest inside, no /8
```

on the 6 major coins over the last 26 hourly rows reproduces **61/156**, worst error
**0.00026496690** (**232%** annualised), **89.5%** of misses within 2e-4 of that formula's own clamp
edges against **54.1%** of matches. Four numbers, to the digit. On those **identical 156 rows** —
95 of which are clamp-binding — A's composition is **156/156** exact.

**Jensen's inequality does not apply here, and this was tested four independent ways rather than
argued.** Hyperliquid averages the premium over the hour *first* and applies the clamp to the
average. The venue's own documentation says so ("Funding Rate (F) = **Average** Premium Index (P) +
clamp(interest rate - Premium Index (P), -0.0005, 0.0005)"), and the measurements below confirm it
against live per-5-second data.

**Answer to the question asked:** Hyperliquid's hourly funding rate **is** recoverable from one
published aggregate. It needs the hourly premium, not the 720-sample series. The per-sample problem
is real but sits one layer down, at the premium itself, and it is a *linear* averaging problem, which
is strictly easier than the nonlinear one B feared.

---

## 1. What was actually run

Every number below was produced by running something during this session. Nothing is quoted from
either prior agent without re-running it.

| dataset | scope | rows |
|---|---|---|
| `harvest.mjs` -> `raw.json` | full perp universe (232 coins), last 14 days + the 14 days before | 154,599 raw |
| | after removing rows where `premium == 0 && fundingRate == 0` | **117,639** |
| `deep.mjs` | 58 coins spread across the universe, windows 60-74d / 150-164d / 300-314d ago | **49,618** |
| `sampler.mjs` -> `sampler.json` | `metaAndAssetCtxs` every 5s, 232 coins, 14:38:43 - 15:00:55 UTC, across the hour boundary | 264 snapshots x 232 |
| **total asset-hours checked** | | **167,257** |
| **of which clamp-binding** | | **50,026** |

Both agents' claims were re-run against the same cached bytes, so no result below turns on one of
them having fetched a luckier window.

---

## 2. A reproduces, verbatim and then at 16x scale

A's own script `hl-formula2.mjs` re-run unmodified:

```
samples                       : 10752 asset-hours
formula exact (abs err < 1e-10): 10752/10752 = 100.00%
  clamp NOT binding           : 7071/7071
  clamp BINDING               : 3681/3681
worst absolute error          : 5.000e-11
```

Identical to the doc's headline (the 7,083/3,669 split in `PHASE_D_FUNDING.md` becomes 7,071/3,681
only because the 14-day window slid forward by the elapsed time; the total is the same 10,752).

Scaled to the whole universe and checked in exact integer arithmetic (`exact.mjs`) — decimal strings
parsed to BigInt numerators, the clamp branch decided by exact comparison against -4e-4 and +6e-4,
the published rate tested for being the correctly-rounded image of the exact rational:

```
rows                                  : 117639
published rate == correctly-rounded g(P): 117639/117639
  non-binding rows, rate exactly 1.25e-5 : 83744/83744
  clamp-binding rows, correctly rounded  : 33895/33895
  exact half-ulp ties: 1868 rounded one way, 1917 the other (both accepted)
failures: 0
```

Older history (`deep.mjs`), same exact checker:

| window | rows | exact | non-binding | binding |
|---|---|---|---|---|
| 60-74 days ago | 16,128 | 16,128 | 12,004 | 4,124 |
| 150-164 days ago | 17,347 | 17,347 | 8,556 | 8,791 |
| 300-314 days ago | 16,143 | 16,143 | 12,927 | 3,216 |

A's 5.0e-11 residual is exactly the half-ulp of the 10-decimal printed rate, as A said. The exact
checker shows what that residual actually is: **3,785 rows land on an exact half-ulp tie**, and the
venue splits them roughly evenly between the two rounding directions. That is printing, not
arithmetic. (It is also why a naive `round-half-away-from-zero` string comparison "fails" on ~1,883
rows — an artefact of the comparator, not of the formula. Measured and discarded.)

---

## 3. B reproduces too, and identifies the procedure

I did not have B's script. B is identified from its **output signature**: four statistics, matched
simultaneously. Search over candidate compositions and coin sets (`bsearch.mjs`, `bconfirm.mjs`):

```
B-candidate: naive hourly formula, 6 majors BTC,ETH,SOL,XRP,DOGE,HYPE, last 26 rows each
  matches         : 61/156
  worst abs error : 0.00026496690  (= 232% annualised)
  worst row       : SOL 2026-07-28T03:00Z  P=-0.0008028193  published=-0.0000378524  calc=-0.0003028193
  within 2e-4 of [naive edges (P=-4.875e-4,+5.125e-4)]: misses 89.5%  matches 54.1%
```

against B's reported 61/156, 2.65e-4, 232%, 89.5%, 54.1%. The third and fourth only land when the
"distance to the clamp threshold" is measured to the **naive formula's own** clamp edges
(-4.875e-4, +5.125e-4) rather than the correct ones (-4e-4, +6e-4) — which is itself further evidence
that the naive composition is what was in the loop.

One near-miss was ruled out rather than assumed: `P/8 + clamp(1.25e-5 - P/8, +-5e-4)` also gives
61/156 on this sample, but its worst error is 5.035e-5, not 2.65e-4. The joint match of count *and*
worst error *and* both threshold percentages is what pins it.

Head to head on B's own 156 rows, in exact arithmetic:

| composition on the identical 156 rows | result |
|---|---|
| `P + clamp(1.25e-5 - P, +-5e-4)` (B's numbers) | **61/156** |
| `(P + clamp(1e-4 - P, +-5e-4)) / 8` (A's) | **156/156**, 95 of them clamp-binding |

Universe-wide, the naive composition scores **83,024/117,639 (70.6%)** and — the tell —
**0 of 33,895 clamp-binding rows**. That is A's "0 of 655" finding, at 50x the sample.

---

## 4. Why they differ

Not a period, not an asset set, not a different field. **A different reading of one sentence in the
venue's docs**, which both agents were reading correctly-in-part.

The docs give two statements that have to be composed:

> "Funding Rate (F) = Average Premium Index (P) + clamp(interest rate - Premium Index (P), -0.0005, 0.0005)"

> "0.01% every 8 hours, which is 0.00125% every hour"

The expression is at **8-hour scale** throughout: interest 1e-4, clamp +-5e-4, and the hourly rate is
the whole thing divided by 8. B substituted the hourly interest rate (1.25e-5) into the expression
but left the clamp at its 8-hour magnitude and did not divide. That single substitution is the entire
disagreement, and it has a nasty property:

- Where the clamp does **not** bind, both readings collapse to the interest rate and both return
  exactly 1.25e-5. They agree on the majority of rows — 71.2% of the universe.
- Where the clamp **does** bind, the readings differ by construction, and B's is wrong on every
  single one.

So the wrong reading passes casual checking and fails exactly on the rows that carry information.
B's own diagnostic — "misses concentrate near the clamp threshold" — is the fingerprint of a wrong
clamp *scale*, and B correctly observed it, then attributed it to the wrong cause.

**Both agents were looking at the same evidence and the mechanism B proposed for it was plausible.**
It was also testable, so it got tested.

---

## 5. The decisive test for Jensen, four ways

B's mechanism: the hourly rate is the mean of a clamped (nonlinear) function of many samples, so it
cannot be recovered from the mean of the inputs. Correct in general. It requires that the venue clamp
**per sample**. It does not.

**5.1 The partition B asked for.** Split every row by whether the clamp binds. If B's mechanism held,
the formula should hold on non-binding rows and fail on binding ones.

| | measured |
|---|---|
| non-binding rows, rate exactly 1.25e-5 | 117,231 / 117,231 |
| clamp-binding rows, correctly rounded | **50,026 / 50,026** |

The predicted failure mode is absent. Deep-binding rows (`|1e-4 - P| > 5e-3`) are 185/185 exact.
Binding rows where the premium moved more than 1e-3 hour-over-hour — so the within-hour path was
certainly not still — are 647/647 exact, on jumps as large as 3.045e-2.

**5.2 Boundary sandwiches** (`crossings.mjs`). Take a non-binding hour flanked by binding hours on
the same side. The premium is continuous; to be outside the band at the end of hour t-1 and outside
again at the start of hour t+1, the path spent part of hour t outside the band. Per-sample clamping
would drag such an hour's rate off the constant.

```
non-binding hours sandwiched between two binding hours on the same side : 2391
  of which the published rate is EXACTLY 1.25e-5                        : 2391
  same, but both neighbours more than 5e-4 outside the band             : 37/37
  deepest: HEMI 2026-07-20T19:00Z  P(t-1)=-0.00184  P(t)=-0.00034  P(t+1)=-0.00189  rate=0.0000125
```

**5.3 Live, at the venue's own sampling rate** (`sampler.mjs`, `sampler_analyze.mjs`).
`metaAndAssetCtxs` publishes the **instantaneous** premium and the **running** hourly funding rate
for the hour in progress. Sampled every 5 seconds for 22 minutes across the 15:00 UTC boundary,
232 coins:

```
coin-hours with >=20 samples                                 : 232
of which: some instantaneous premium OUTSIDE the band AND the
running hourly funding pinned at EXACTLY 1.25e-5 throughout  : 62

  WLFI    192 of 252 samples out of band, down to -9.468e-4, funding constant 0.0000125
  GALA    173 of 252, down to -1.107e-3,                     funding constant 0.0000125
  PENDLE  154 of 252, down to -1.593e-3,                     funding constant 0.0000125
  NIL      91 of 252, down to -2.624e-3,                     funding constant 0.0000125

intra-window range of the INSTANTANEOUS premium: median 9.90e-4  p90 2.34e-3  max 9.00e-3
                                                (the no-clamp band is 1.0e-3 wide)
```

The instantaneous premium routinely traverses the entire no-clamp band within a single hour — the
condition under which Jensen would bite hardest. Under per-sample clamping, WLFI's 192 out-of-band
samples each contribute a clamped value below the constant, and the hour's average cannot be exactly
1.25e-5. It was exactly 1.25e-5, in every one of the 252 snapshots.

**5.4 The two aggregates, computed directly.** For the completed hour 14:00 UTC, using the independent 252
five-second samples, compute both candidates and compare to what the venue published:

| coin | published P | published rate | `g8(mean(samples))` | `mean(g8(samples))` |
|---|---|---|---|---|
| BTC | -0.000298729 | **0.0000125** | **1.250000e-5** | 1.192049e-5 |
| HYPE | -0.0001152184 | **0.0000125** | **1.250000e-5** | 1.591154e-5 |

Clamp-of-the-mean agrees with the venue; mean-of-the-clamped does not, and misses in *both*
directions. (The four binding majors are omitted from this table on purpose: my window covers only
22 of the 60 minutes, so neither aggregate can reproduce a rate that depends on the full-hour mean.
BTC and HYPE are informative precisely because in the non-binding region clamp-of-the-mean is pinned
at the constant while mean-of-the-clamped is not.)

**5.5 Which way the dependence runs.** If the API synthesised `premium` by inverting a rate it
computed some other way, the identity would be circular. It does not: inverting the published rate
on binding rows fails to return the published premium on **29,744 of 33,895** rows. The rate is the
rounded image of the premium, not the reverse. And on non-binding rows the premium varies freely
while the rate is pinned, so the premium cannot be a function of the rate at all.

---

## 6. Falsification controls

A check that cannot fail proves nothing, so the exact checker was attacked (`v1` control run,
33,895 binding rows):

| control | checker still accepts |
|---|---|
| published rate perturbed by +1 ulp (1e-10) | 1,917 / 33,895 |
| published rate perturbed by -1 ulp | 1,868 / 33,895 |
| rate replaced by B's naive composition | **0 / 33,895** |
| premium perturbed by +10 ulp (1e-9) | 3,002 / 33,895 |
| premium perturbed by +100 ulp (1e-8) | 292 / 33,895 |
| premium perturbed by +1 ulp (1e-10) | 29,417 / 33,895 |

The survivors of the +-1 ulp rate perturbation are exactly the half-ulp ties counted in section 2.
The last row is a genuine resolution limit, stated rather than hidden: because the formula divides by
8, the published 10-decimal rate only pins the premium to about +-4e-10. A verifier that checks the
rate cannot detect a premium error below that.

---

## 7. What this means for proving Hyperliquid funding

**The clamp is not the obstacle, and the nonlinearity is not the obstacle.** One number — the hourly
premium — determines the hourly rate exactly. B's structural conclusion ("proving a Hyperliquid
funding rate needs all 60 samples and not one aggregate") does not hold for the clamp step.

**The real obstacle is one layer down, and A already named it.** The hourly premium is itself the
mean of 720 five-second samples of

```
premium = ( max(impact_bid - oracle, 0) - max(oracle - impact_ask, 0) ) / oracle
```

confirmed live this session on **177 of 177** assets carrying `impactPxs`, worst absolute error
4.988e-11 — a stronger version of A's 39/39. The oracle price is on HyperEVM (`0x807`); the impact
prices are not, and no precompile in `0x800`-`0x814` returns book depth. So the premium is
attestable-if-published but not recomputable from chain state today.

**The ordering makes the remaining problem easier, not harder.** Because the clamp is applied *after*
averaging:

- Bounds compose by linearity. A bound on each 5-second sample gives a bound on the hourly mean for
  free. Under B's model — clamp per sample — you would need each clamped sample's value, and no
  bound on the inputs would compose cleanly through 720 kinks.
- A *bound* is often sufficient, no value needed. Whenever the hourly mean premium lands in
  `[-4e-4, +6e-4]` the rate is exactly the constant 1.25e-5 whatever the premium was. Measured over
  the full 232-coin universe that is **83,744 of 117,639 asset-hours, 71.2%**.

So the honest end of this road is unchanged from A's section 6: the missing quantity is order book
depth beyond the touch, and the accumulation problem is 720 readings per asset per hour. Neither is
a Jensen problem.

---

## 8. Corrections to A worth recording

A's headline claim is right. Three supporting figures are sample-specific and were quoted as if
general:

1. **"65.9% of asset-hours are non-binding"** is A's 40-coin slice. Universe-wide over 232 coins it
   is **71.2%** (83,744/117,639).
2. **"a bound must beat |P| < 4e-4"**, from a p99 of 3.97e-4, is A's 20-coin slice. The no-clamp band
   is **asymmetric**: `P` in `[-4e-4, +6e-4]`. Universe-wide the p99 of `|P|` in non-binding hours is
   **5.00e-4** and the max is **6.00e-4**. `|P| < 4e-4` is sufficient but not necessary; the correct
   sufficient condition is the asymmetric band.
3. **The 4%/hour cap branch is never exercised.** Largest `|fundingRate|` in 167,257 rows is
   **6.276e-3** (BLUR, 2026-07-07T12:00Z, premium -0.0507). Neither A's measurement nor mine tests
   that branch of the venue's code. It is transcribed, not verified.

A's exclusion of rows where `premium == 0 && fundingRate == 0` was audited rather than taken on
trust, because an exclusion rule is exactly where a result like this would hide:

```
total rows 154599   both-zero rows 36960 = 23.9%
coin-windows entirely both-zero (dead market): 110
coin-windows PARTIALLY both-zero:               0
rows with premium==0 but funding!=0: 2986  (kept, and they pass)
rows with premium!=0 but funding==0:    0
```

The rule removes 110 whole dead markets and never removes an hour from inside a live one. It is
clean.

---

## 9. What is not settled

- **B was identified by output signature, not by reading its code.** Four statistics matching to the
  digit is strong, but I never saw B's script. If B's write-up and B's code disagree about which
  formula ran, that is the finding; I can only show that B's *numbers* cannot have come from the
  formula B says it tested.
- **All of this concerns the venue's published fields.** It establishes that the published rate is a
  deterministic, exactly-checkable function of the published premium. It does not establish that
  either number describes a real order book. Hyperliquid computes both and publishes both; nothing
  here is independent of the venue. That is the same boundary A draws in `PHASE_D_FUNDING.md` s.5,
  and it is the honest one.
- **The 4%/hour cap is untested** (section 8.3).
- **The live sampler covers one partial hour on one day.** It is corroboration; the 167,257-row
  offline result carries the weight.
- **Nothing here was checked against Hyperliquid's source**, which is not public. The formula is
  established empirically, to the printing precision of the API, over ten months. That is a very
  strong empirical claim and it is not a proof of what the matching engine does.

---

## 10. Files

All in `.../cdeb06fc-e974-4d4a-9172-8033d0b77930/scratchpad/v1/`. Nothing in the repo.

| | |
|---|---|
| `harvest.mjs` -> `raw.json` | 232 coins x 2 windows, decimal strings kept unparsed |
| `analyze.mjs` | six candidate compositions, float tolerance + string comparison |
| `exact.mjs` | BigInt verification, no floating point, 117,639 rows |
| `deep.mjs` | 60/150/300-day-old windows, 58 coins |
| `bsearch.mjs`, `bconfirm.mjs` | identification of B's procedure from its output signature |
| `crossings.mjs` | boundary-sandwich test |
| `direction.mjs` | which way the premium/rate dependence runs; deep-binding and jump partitions |
| `sampler.mjs` -> `sampler.json` | 5-second `metaAndAssetCtxs`, 22 minutes, across the hour boundary |
| `sampler_analyze.mjs` | per-sample vs aggregate clamp; `g8(mean)` against `mean(g8)` |
| `stats.mjs` | universe-wide binding share and premium quantiles |

`perp-gate` is unchanged. No adapter, no engine file, and no other markdown file was touched.
