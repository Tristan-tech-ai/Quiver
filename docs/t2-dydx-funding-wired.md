# dYdX funding, wired into the attestation path

**28 July 2026. Repo-only. Nothing here is served, deployed, or on chain. `src/engine/` is untouched —
the published build hash reads `q1-e1fa99d08887d6cc` before and after this work.**

`PHASE_D_FUNDING.md` established that dYdX's hourly funding rate, while never stored under a key, is
exactly recomputable from store inputs that each carry an ICS-23 existence proof. It stopped there.
`src/adapters/dydx-attest.js` still carried `NOT_ATTESTABLE.fundingHourly` — a pointer to that work
rather than the work itself — and `gate:d3` still asserted that funding was refused.

That entry is gone. Funding is now recomputed inside the adapter, from proven state, and `gate:d3`
attests it. What follows is what that is worth, measured by running it, and one place where
`PHASE_D_FUNDING.md` is wrong.

---

## 1. What is now attestable that was not

Two quantities, and they are **not the same claim**. Conflating them is the easiest way to overstate
this result, so the registry names them separately and the gate tests them separately.

| quantity | what it is | inputs | how it is checked |
|---|---|---|---|
| `fundingTickHourly` | the **realized** rate for a completed hour | `PremSamples`, `Params`, `Perp:<id>`, `LiqTier:<tier>`, `Info:funding-tick`, `Info:funding-sample` | **integer equality** against the rate the venue published for that hour, at an anchor pinned to `effectiveAtHeight - 1` |
| `fundingHourly` | the **predicted** rate over the partial epoch — the indexer's `nextFundingRate`, and the only funding number `perp-gate` consumes | `PremSamples`, `Perp:<id>` | against the live indexer, inside a bound derived from the proven samples |

The rule, transcribed from `MaybeProcessNewFundingTickEpoch` and living in `fundingTickPpm()`:

```
premiumPpm = AvgInt32( pad0( PremSamples[perp], max(NumPremiums, tickDur/sampleDur) ) )
fundingPpm = clamp( premiumPpm + DefaultFundingPpm,
                    +/- FundingRateClampFactorPpm/1e6 * (InitialMarginPpm - MaintenanceMarginPpm) )
hourly     = fundingPpm / 8e6
```

Every constant in it is read from proven state, not hardcoded: the tick and sample durations come
from `epochs/Info:funding-tick` and `epochs/Info:funding-sample` (measured: 3600 s and 60 s), the
clamp factor from `perpetuals/Params` (6,000,000 ppm; the same value also yields 60,000,000 for the
premium-vote clamp and 15 for minimum votes per sample), and the margin parameters from the market's
own liquidity tier. A governance change to any of them moves the answer, and hardcoding would hide it.

### The realized rate: 72 of 72, integer-exact

Two runs through the adapter, 24 markets across 3 tick heights each, on archive anchors whose
precommits were ed25519-verified at that historical height:

| tick height | anchor | verified voting power | corroborating providers | result |
|---|---|---|---|---|
| 99,349,592 | 99,349,591 | 95.01% | 2 | 24/24 exact |
| 99,343,635 | 99,343,634 | 90.93% | 2 | 24/24 exact |
| 99,337,694 | 99,337,693 | 85.01% | 2 | 24/24 exact |

**72 of 72.** No bound, no tolerance: the recomputed integer ppm equals the published integer ppm.
Largest rate recomputed 434 ppm; 45 of the 72 rows carry a nonzero rate. Proof cost measured at
**4,715–4,770 B per market-tick**, of which 3,211–3,274 B is the shared market-independent context
(the four keys `PremSamples`, `Params`, `Info:funding-tick`, `Info:funding-sample`, proven once per
anchor for the whole book) and the remainder is the market's own `Perp:` and `LiqTier:`.

The ticker set is deliberately mixed, and that matters — see §2.

### The predicted rate: exact where it can be, and honestly bounded where it cannot

280 market-observations over 5 rounds:

| | measured |
|---|---|
| markets with **no** premium samples this epoch | 200 of 200 divergence **exactly zero** |
| markets **with** premium samples | 22 of 80 exact (worst 4.0e-14); the rest at a full one-sample step, worst **2.51e-2** relative / **18.74 ppm** absolute |
| on-chain `default_funding_ppm / 8e6` vs the indexer's own `defaultFundingRate1H` | **280 of 280** exact |

The sampled-market disagreement hits **every** sampled market in a round simultaneously or none of
them. That is the signature of a `num_premiums` clock difference between the anchored block and the
indexer's snapshot, not of a per-market disagreement — and §3 is what happened when I tried to turn
that observation into a bound.

---

## 2. What contradicts `PHASE_D_FUNDING.md`

**The predicted-rate formula in §3 of that document is incomplete, and its 18-of-18 was measured
entirely on markets where the missing term is zero.**

`PHASE_D_FUNDING.md` gives

```
nextFundingRate = sum(PremSamples[perp]) / NumPremiums / 8e6
```

and reports **18 of 18 markets, worst relative error 2.7e-14**. It omits `default_funding_ppm`.

Measured here at one anchored height, against all 296 dYdX markets:

| formula | markets reproduced exactly |
|---|---|
| `sum / NumPremiums / 8e6` | **102 / 296** |
| `(sum / NumPremiums + default_funding_ppm) / 8e6` | **284 / 296** |

The distribution of `default_funding_ppm` across those 296 markets is **114 at 0 and 182 at 100**.
The 182 are precisely the markets publishing exactly `1.25e-5` per hour with no premium samples at
all, and the omitting formula returns `0` for every one of them. Every one of the 102 it does
reproduce is a market where *both* terms are zero, so it reproduces nothing but zeros.

The 18-of-18 is not contradicted by this — it is explained by it. The markets that carry premium
samples at any instant are 12 to 22 of 296 and they are the majors, and **every one of them has
`default_funding_ppm = 0`**. The missing term vanished across the entire sample it was validated on.
`PHASE_D_FUNDING.md` names this exact failure mode in its own account of the superseded refusal —
"a formula validated only where one of its terms vanishes has not been validated" — and then
reintroduces it one section later. The remaining 12 misses under the corrected formula are the
sampled markets and are a snapshot-height difference, not a formula error.

**The TICK rule in the same document is correct** and already contains the term; only the
`nextFundingRate` shortcut drops it. That is also why the 144-of-144 stood: it used the full rule.

Two smaller corrections, both in the direction of *narrower* claims than the document implies:

* **The 144-of-144 used the full tick rule, so it was correct — but its 12 markets were majors, and
  every major measured here carries `default_funding_ppm = 0`.** The term was therefore present in
  the code and contributed nothing to the result, which is why its absence from the *predicted*
  formula went unnoticed in the same document. It is exercised now: of the 72 market-ticks measured
  here, **30 are markets whose entire rate is that term** (settling at exactly 100 ppm) and **15 are
  markets whose entire rate is the premium average**. `gate:d3` asserts that both branches are present
  in every run rather than hoping the sample happens to contain them.
* **Archive availability is two providers, not "an archive provider".** Twelve public dYdX RPC
  endpoints were probed at tick height 99,349,592. Two serve the proof: `dydx-ops-rpc.kingnodes.com`
  and `dydx-dao-rpc.polkachu.com`. `dydx-rpc.publicnode.com` prunes application state and answers
  `proof is unexpectedly empty` while reporting 3M blocks of history, and the other nine fail at the
  transport (DNS failure, HTML error pages, timeouts). `MIN_CORROBORATORS` is 2, so the realized-rate
  path has **exactly zero redundancy**: if either archive goes down, the module refuses. That is the
  correct behaviour and it is also a real fragility.

---

## 3. The bound this report got wrong, and how the gate caught it

Worth recording, because the first version of the new test passed my calibration and was still wrong.

I calibrated the predicted rate's bound over 280 observations and wrote the obvious test: unsampled
markets must match the indexer exactly (measured 200/200), sampled markets within 6e-2 relative
(worst observed 2.51e-2). All 280 observations happened to sit at `num_premiums` 50–53, late in an
hourly epoch.

The first gate run after that landed at `num_premiums = 1`, minutes after a funding tick. It went red
immediately, on an **unsampled** market, at relative divergence **exactly 1**.

The mechanism, measured rather than guessed: the indexer's snapshot and the anchored block are at
different heights — the indexer's own `/v4/height` ran **3 to 9 blocks ahead** of the anchor, which
itself lags the tip by `PROOF_LAG` plus the spread across corroborating providers. One sample round of
difference moves `sum / num_premiums` by at most one sample's worth. So the **absolute** effect scales
as `1/num_premiums`, and the **relative** effect is unbounded: it reaches 1 the instant a market
crosses from zero samples to one, however small the absolute numbers are. A relative bound fitted late
in an epoch is nine minutes of every hour away from being nonsense.

The fix is a bound derived from proven state instead of fitted to one regime:

```
|proven - claimed| ppm  <=  SKEW_ROUNDS x ( largest premium sample at this height + |rate| ) / num_premiums
```

Every term is read out of the proof. It tightens automatically as an epoch fills, it is valid at
`num_premiums = 1`, and `SKEW_ROUNDS = 2` is the only fitted number in it (the measured indexer offset
is well inside one 60-second round; 2 is that with headroom). Observed usage: 9.1% of the bound at
`num_premiums = 5`, against an assertion that the honest worst case must stay under 75%.

The two relative bounds are still asserted, but only in the regime they were measured in
(`num_premiums >= 30`), and the gate **prints the reason** when it withholds them rather than skipping
silently. The claim that runs unconditionally is the realized tick, which is exact.

This is the same class of error the project has hit before — a bound written in units that do not hold
across the domain it is applied to. It survived calibration because calibration sampled one regime.

---

## 4. Gate counts, before and after

| | before | after |
|---|---|---|
| `npm run gate:d3` | 9 tests, 9 pass, 0 fail | **16 tests, 16 pass, 0 fail** |
| `npm run gate:d3-revert` | 4 injected defects | **8 injected defects** |

The nine original tests are all still present. Two were edited rather than replaced, and both edits
are corrections that the change forced:

* **`quantities with no proof path are REFUSED, never guessed`** used `fundingHourly` as its example.
  It cannot any more, because that would be asserting a refusal that is no longer true. The exemplar
  moved to `orderbook`, which dYdX documents as in-memory per node and never written to application
  state — unprovable in principle rather than merely unimplemented. The test additionally now asserts
  that `fundingHourly` is *absent* from `NOT_ATTESTABLE`, so a stale refusal cannot outlive the work
  that made it false, and that a market proven without a funding context refuses with `NOT_IN_PROOF`
  — a reason that names its own cause instead of falling back to "unprovable".
* **`the registry refuses to grow silently`** now also asserts the four entries of `FUNDING_CAVEATS`.
  Removing a refusal removed a place where limits were written down; putting them in code that the
  gate checks means a green run cannot quietly come to mean "funding is proven true".

The seven new tests:

| test | what it can fail on |
|---|---|
| the REALIZED funding rate recomputes integer-exactly at a historical tick | any arithmetic error; also asserts the epoch is complete at the anchor, and that both the premium-driven and default-funding-driven branches are actually covered |
| the PREDICTED funding rate agrees with the indexer, and a fabricated one does not | the derived skew bound; unsampled markets landing exactly on their default-funding term; 10x / sign-flipped / 1%-per-hour fabrications refused; the honest value still attesting |
| a **PERTURBED** premium sample is REFUSED | +`paddedTo` ppm on one sample moves the truncated mean by exactly 1 ppm, by construction |
| a **DROPPED** premium sample is REFUSED | removing the largest sample; also pins the `int32`-vs-`sint32` decode |
| a funding proof lifted from **ANOTHER HEIGHT** is REFUSED | two real anchors crossed, so the rejection is the root mismatch and not a pruning error; plus funding inputs reused across anchors; plus the ticker cross-check on the funding path |
| an **ABSENT** funding key is REFUSED, never silently zero | four absent keys; the hypothetical mid-epoch tick rate withheld from the attestable surface and refused with `NOT_IN_PROOF`; the decoders refusing zero-divisors and missing epoch durations |
| the clamp branch and the direction of integer truncation are pinned | synthetic, and labelled synthetic |

---

## 5. What the revert proves

`gates/gateD3-revert.mjs` removes one load-bearing check at a time, reruns the gate, requires RED,
restores, and requires GREEN again. It refuses to run at all if any target string is missing, so a
revert that silently did not apply cannot report a meaningless pass.

Four defects existed. Four more were added, all specific to the funding path, because "it matched
72 of 72 on mainnet" is exactly the kind of evidence that hides a defect in a branch mainnet does not
reach:

| # | defect injected | why it is the one to inject |
|---|---|---|
| 5 | the `sint32` zigzag decode of premium samples, reinstated as a plain `int32` read | the exact wire type that made this look impossible; returns roughly -2x every sample |
| 6 | the `default_funding_ppm` term dropped from the tick rule | silently correct on 114 markets and wrong on 182 — the defect §2 found in the document |
| 7 | the funding-context height binding removed | lets inputs proven at one height be reused against another anchor, which no per-key root check can see, because each individual proof is valid |
| 8 | `Math.floor` in place of truncation toward zero in `AvgInt32` | right on every positive rate, wrong on every negative one; funding is negative about half the time |

Executed, `npm run gate:d3-revert` (reduced to `GATE_D3_MARKETS=10`, `GATE_D3_TICK_HEIGHTS=1` — these
runs are about whether the gate can fail, not about re-deriving the bounds; the tick ticker list is
left alone on purpose, since trimming it is exactly how defect 6 would stop being caught):

```
  removed: the proto3 zero-omission in the vote encoder (the historical defect)
    gate against reverted code : 2 pass, 14 fail
  removed: the divergence comparison
    gate against reverted code : 10 pass, 6 fail
  removed: the no-proof-path refusal
    gate against reverted code : 15 pass, 1 fail
  removed: the ticker cross-check
    gate against reverted code : 15 pass, 1 fail
  removed: the sint32 zigzag decode of premium samples
    gate against reverted code : 14 pass, 2 fail
  removed: the default-funding term in the funding rule
    gate against reverted code : 14 pass, 2 fail
  removed: the funding-context height binding
    gate against reverted code : 15 pass, 1 fail
  removed: the direction of integer truncation in AvgInt32
    gate against reverted code : 14 pass, 2 fail
  all mutations restored
    gate against restored code : 16 pass, 0 fail

GATE D3 REVERT: PASSED — the attestation gate is capable of failing
```

**8 of 8 go red, and the gate returns to 16 of 16 green.** Red-when-reverted alone would not be
enough — a gate that is red in both states is simply broken and would satisfy a one-sided check — so
the restored run is asserted too.

Two of the counts are worth reading rather than skimming. Defects 7 and 8 each take down only one or
two tests, and in both cases it is a test that exists *only* because that defect is possible: without
the height binding, nothing else in the gate notices that funding inputs from one anchor were used
against another, because every individual proof involved is valid. Without the synthetic truncation
test, a `Math.floor` would be invisible on any hour whose rates all happen to be positive.

---

## 6. What this still does not prove

These are in the code as `FUNDING_CAVEATS`, and the gate asserts they are still there, because
deleting a refusal deletes the place limits were written down.

* **The premium is not proof of a book.** dYdX's premium comes from `k.MemClob.GetPricePremium` —
  each validator's **in-memory orderbook**, which the protocol documents as never written to
  application state. Proposers sample their local book, submit `MsgAddPremiumVotes`, and the chain
  takes a median across the proposers of that minute. So 72 of 72 establishes that **the chain applied
  its own rule correctly to its own committed inputs**. It does not establish that those inputs
  describe a real orderbook. A validator set that collectively misreported would produce a funding
  rate that verifies perfectly. Attestation is provenance, never truth.
* **The clamp branch is unexercised on chain.** It is transcribed from source. Across every
  observation here — 72 realized ticks and 280 live ones — the clamp bound **never bound, not once**.
  The bounds seen were 48,000 / 120,000 / 300,000 ppm per hour against realized rates of order 100 ppm.
  `gate:d3` exercises the branch with a **synthetic** input, which proves the code clamps; it does not
  prove the transcription matches dYdX at the bound, because nothing on chain reaches it. The same
  applies to the integer rounding inside the bound: every real liquidity tier divides exactly, so the
  truncation there is unexercised too.
* **The vote-to-sample stage is not verified.** Each premium sample is itself the median of validator
  votes in `PremVotes`, which is provable, and this work starts at the sample rather than the vote.
  `PHASE_D_FUNDING.md` reproduces that stage on 8 of 22 markets with the cause identified and no fix
  applied. Nothing here improves it.
* **The realized rate needs an archive, and there are two.** See §2. A live anchor can only produce
  the tick rule's output as a *hypothetical* — the rate the epoch would settle at if the tick fired
  now, which the venue has not published and nothing can check. `proveFunding` reports
  `tickEpochComplete` from proven state (one sample round per sample-epoch across the whole tick
  epoch), and `proveMarket` withholds `fundingTickHourly` from the attestable surface unless it is
  true, so `attest` refuses with `NOT_IN_PROOF` instead of returning a comparable-looking number that
  is not comparable to anything.
* **The predicted rate cannot be pinned tightly against the indexer at all**, because the two sides
  are computed at heights that cannot be aligned (§3). It is attested so the field is not silently
  omitted and so a gross fabrication is refused. It is not a lie detector. The lie detector on this
  path is the realized rate.
* **Everything above inherits the module's existing ceiling**: there is no weak-subjectivity
  checkpoint. The validator set is checked against a `validators_hash` in a header served by the same
  RPC. Corroboration across independently operated providers is what forces an attack to require
  collusion, and on the realized-funding path that is two providers, not three.

---

## 7. Files touched

| | |
|---|---|
| `veritape/src/adapters/dydx-attest.js` | the recomputation, the two registry rows, `FUNDING_CAVEATS`, `proveFundingContext` / `proveFunding`, `proveKeyAny`, and a pinned-height option on `openAnchor` |
| `veritape/src/adapters/ics23.js` | `uvarints()` — packed repeated-varint decoding, which `pbFields` cannot do because a packed body is a bare varint stream and not tag/value pairs |
| `veritape/gates/gateD3-dydx-input-attestation.mjs` | 9 tests to 16 |
| `veritape/gates/gateD3-revert.mjs` | 4 injected defects to 8 |

All four are mirrored into `Quiver/` at the same relative paths (`Quiver/src/adapters/…`,
`Quiver/gates/…`), byte-identical, and `gate:d3` was run from `Quiver/` to confirm the mirror works
rather than merely exists: 16 pass, 0 fail. This document is mirrored to
`Quiver/docs/t2-dydx-funding-wired.md`, following the convention already used for the other
`hackathon/PHASE_*.md` notes.

`src/engine/` is untouched in both trees. `node -e "import('./src/engine/proof.js').then(m=>console.log(m._internal.buildId()))"`
reads `q1-e1fa99d08887d6cc` in `hackathon/veritape` and in `Quiver`, before and after.
