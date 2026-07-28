# V4: the per-reserve TVL gate, and the two ways it could have been unfalsifiable

`PHASE_D_OFFCHAIN_VENUES.md` §3.6 ends with a warning rather than a gate: comparing the Aave V3
reconstruction against DefiLlama **on the total** produces a verifier that cannot fail. This document
is that warning acted on. It builds the per-reserve gate, and it spends most of its length on the half
that can fail, because that is the only half that makes the green half worth anything.

Two findings came out of it that were not in the brief. The first is that **the per-reserve form has a
worse failure mode than the total form**, and the obvious implementation walks straight into it. The
second is that **the obvious way to calibrate the band is wrong by two orders of magnitude**, in
exactly the shape of the units defect this project has caught before.

Everything below was measured in this session. Where a figure from `PHASE_D_OFFCHAIN_VENUES.md` was
re-measured rather than inherited it says so, including one place where it did not reproduce.

---

## 1. The answers, up front

| question | answer |
|---|---|
| worst honest per-reserve divergence | **SNX, using 98.33% of its quantity bound**; 0 of 57 reserves outside it |
| largest fabrication a total-only comparison swallows | **34 of 57 reserves zeroed, $55,363,881, 0.489% of TVL** at a charitable 50 bps band; **30 reserves, $17,640,041** at 10 bps |
| largest fabrication the *shipped* per-reserve form swallows | **$0.20** on WBTC, the largest reserve on the book |
| is the gate falsifiable | **yes, and it was demonstrated twice.** Two scripted reverts, four tests red on one, one test red on the other, green again after both |
| the finding that was not asked for | an intersection-iterating per-reserve comparison swallows **$2,266,124,107 (20.01% of TVL)** — 41x worse than the total form it appears to improve on |

---

## 2. Verifying rather than inheriting

Before building anything, the §3.3 result was re-derived through an independently written pipeline
against the same block, on a different RPC path, with reserve discovery and Multicall batching
restructured.

| | `PHASE_D_OFFCHAIN_VENUES.md` §3.3/§3.5 | re-measured here |
|---|---|---|
| reconstructed USD at block 25,631,552 | 11,413,041,125.361603 | **11,413,041,125.361605** |
| relative divergence | −1.7334727909474643 bps | **−1.733472790945793 bps** |
| tokens compared | 57 of 57 | 57 of 57 |
| unmatched | 3 dust PT reserves, $1,067 | 3 dust PT reserves, **$1,067** |

Agreement to the fifteenth digit across a third implementation. The §3.3 result stands.

**Where the document did not reproduce.** §3.6 states that at a 10 bps aggregate band, "32 of the 57
reserves could be set to zero and the gate would still read green, because those 32 together are worth
$33,533,833, less than the headroom." The $33,533,833 is right — the 32 smallest reserves at that
snapshot measure **$33,533,314** here. The headroom is also right: **$9,436,257** at 10 bps, exactly as
its own table says. But $33.5M is 3.6x $9.4M, so the two halves of that sentence contradict each other.
The reproducible figure at 10 bps is **27 reserves, $8,004,258**. The 32-reserve set does not fit inside
any band in that table; it needs 50 bps.

The qualitative claim survives intact and is if anything stronger at wider bands — the point was that a
total-only gate swallows roughly half the book, and it does. The specific count was overstated.

---

## 3. Where the bounds come from

The brief asked for a bound set from what it measures rather than from a guess. The quantity side turned
out to admit a bound with **zero free parameters**, which is better than a calibrated one.

### 3.1 Quantity: DefiLlama's own print precision

DefiLlama publishes each reserve quantity as a decimal string — `9352130.64906`, `481074327.50127`. The
most that string can be wrong by is half of its last digit. Relative to the value, that half-ULP is the
tightest tolerance any reconstruction can honestly be held to, and it is not chosen, it is read off the
number DefiLlama itself printed.

Measured across all 57 reserves at two drift-0 snapshots:

| bound utilisation | value |
|---|---|
| median | 38.2% |
| p90 | 88.9% |
| **worst** | **98.33% (SNX)** |
| reserves exceeding the bound | **0 of 57** |

That distribution is the signature of a rounding artifact and nothing else. The honest reading
**saturates** the bound to within 1.7%, which is what distinguishes a measured bound from a guessed one:
a bound nothing comes near is a bound someone picked.

The bound is conservative in the safe direction. JavaScript prints the shortest round-tripping decimal,
so a value whose true last digit is `0` prints one digit short and gets a bound 10x too *wide*, never
too tight. Under the hypothesis "the quantities are equal and only DefiLlama's printing differs",
utilisation can never exceed 1. It never did.

### 3.2 The residual is price, and now to the dollar

Separating the two residuals — quantity held at DefiLlama's price, price held at our quantity — gives a
much sharper statement than "median error 1.5e-9 percent":

| snapshot | quantity residual | price residual |
|---|---|---|
| block 25,631,552 | **−$0.48** (−4.2e-7 bps) | −$1,979,830 (−1.734 bps) |
| block 25,631,787 | **−$0.56** (−4.9e-7 bps) | +$10,092,106 (+8.913 bps) |

**The quantity half of DefiLlama's Aave V3 Ethereum TVL is reproducible from Ethereum state to under one
dollar out of eleven billion.** The entire disagreement is price, and it is real: Aave's oracle uses
capped LST exchange-rate feeds and DefiLlama uses market quotes.

### 3.3 Price: the weak half, and the gate says so

The price band cannot be derived, only calibrated, and it is the honest limit of this gate.

| | value |
|---|---|
| worst honest per-reserve USD impact | **5.413 bps of total (WBTC)** |
| band shipped | 25 bps per reserve |
| utilisation | 21.7% |
| largest single-reserve **price** lie that survives | **~$28,306,692** |
| largest single-reserve **quantity** lie that survives | **$0.20** |

The price half of this gate is roughly a million times weaker than the quantity half. That is a property
of the problem rather than of the implementation — two honest oracles disagree by tenths of a percent —
but a gate that did not say so out loud would be implying a completeness it does not have. Test F5
prints the $28M figure on every run.

This band is also the weakest-calibrated number in the gate: it rests on two snapshots 47 minutes apart,
and 44 of 60 reserve quantities were byte-identical between them, so they are closer to 1.3 independent
samples than to 2. Per-reserve price divergence was separately measured to move by up to **1.70
percentage points** on a single reserve across those 47 minutes.

---

## 4. The calibration trap, which is the second unasked-for finding

The obvious way to widen that sample is DefiLlama's own history: `/protocol/aave-v3` carries **1,282**
daily points for Ethereum. Reconstructing against them would give a long run to calibrate from, which is
precisely what §3.10 item 4 asks for.

It is wrong, and quietly.

| snapshot | drift | reserves outside the print bound | total divergence |
|---|---|---|---|
| live last point (ts 1785247331) | 0 s | **0 of 57** | +8.91 bps |
| live last point (ts 1785244487) | 0 s | **0 of 57** | −1.73 bps |
| daily point, −1 day | −1 s | **12 of 57** | −149.70 bps |
| daily point, −2 days | −1 s | **9 of 57** | −130.14 bps |

The block pinning is not the problem — drift is one second. The daily points simply are not chain state
at their own timestamp. At the −1 day point DefiLlama publishes USDC 218,620,983.57 where the chain holds
**25,494,209.25**, an 88.3% divergence. That was checked for an archive-node fault before being believed:
two independent operators (MEV Blocker and dRPC) return byte-identical historical state at that block,
and the value there is not DefiLlama's.

A band fitted to those points would come out around **150 bps wide**. It would pass everything. That is
the same failure this project has already caught once — a bound nine orders of magnitude too wide that
passed every input until a metric was noticed reading exactly 0.0% — arrived at from a different
direction. It is now test **F10**, which asserts that the daily points *fail* to reconcile, so that the
day DefiLlama changes this the gate goes red and asks to be revisited rather than silently widening.

The consequence for the gate is a hard restriction: **it may only pin to DefiLlama's live last point,
where drift is 0**, asserted in F1. That point refreshes roughly every 47 minutes, so calibration
accumulates in wall-clock time and cannot be backfilled.

---

## 5. The half that can fail

### 5.1 Zeroing reserves: the contrast the gate is built on

Identical fabrication — take the N smallest reserves and set their quantity to zero — fed to both
comparison forms at the same snapshot.

| aggregate band | reserves zeroed while total-only stays GREEN | dollars fabricated | share of TVL |
|---|---|---|---|
| 1 bps | honest reading is already red (false positive) | — | — |
| 5 bps | honest reading is already red at one of the two snapshots | — | — |
| 10 bps | **27** / **30** (two snapshots) | $8,004,258 / $17,640,041 | 0.070% / 0.156% |
| 25 bps | 31 / 32 | $25,187,522 / $33,400,988 | 0.221% / 0.295% |
| **50 bps** (charitable) | **33 / 34** | $44,609,255 / **$55,363,881** | 0.391% / **0.489%** |
| 100 bps | 37 / 37 | $98,939,668 / $98,604,096 | 0.867% / 0.871% |

The gate ships the 50 bps row deliberately: a total-only comparison given a band five times more generous
than the one §3.6 tabulates still swallows **34 of 57 reserves**, so its failure cannot be dismissed as
an unfairly tight total.

The per-reserve form catches **N = 1**, on **STG at $58.87**, which is 5.2e-5 bps of the book.

**Why the total is blind, measured rather than asserted:** the per-reserve divergences sum to
**$15,076,001 in absolute value** but only **$10,093,173 net** — a factor of **1.5x** at that snapshot
and **4.9x** at the other. Summing destroys sign information before anything gets compared.

### 5.2 The trap: per-reserve is not the fix

This is the finding that was not in the brief, and it inverts the naive conclusion.

The obvious per-reserve implementation walks the reserves it has and compares each against DefiLlama —
the shape of the §3.3 analysis script, `if (mine && llama) { compare }`. Under a **deletion** rather than
a zeroing, a reserve that is simply absent from the reconstruction never enters the loop.

Deleting the single largest reserve, **weETH at $2,266,124,107, 20.01% of the entire book**:

| comparison form | verdict |
|---|---|
| total-only, 50 bps | RED (the total moved 2,000 bps) |
| **per-reserve, iterating the intersection** | **GREEN — it never looked** |
| per-reserve, iterating DefiLlama's key set and asserting coverage | RED, `coverage-missing: WEETH` |

So "compare per reserve" on its own is **41x weaker** than the total-only comparison it was supposed to
replace, and it fails in a way that is much harder to notice, because the code reads as more careful.
The fix is not granularity, it is direction: **iterate DefiLlama's own key set and require a
reconstruction for every entry in it.** An unmatched reserve is a finding, never a skip.

This is now test **F8**, which runs both forms on the same input every time and requires the intersection
form to go green — if that defect ever stops reproducing, the contrast being claimed would be invented.

### 5.3 The sensitivity floor, in both directions

A gate that refuses everything is not strict, it is broken. F9 perturbs three of the largest reserves
just *inside* the bound and just *outside* it, and requires green then red:

| reserve | reserve value | perturbation under bound | over bound | largest undetectable quantity lie |
|---|---|---|---|---|
| WETH | $572,029,238 | GREEN | RED | **$0.01** |
| USDC | $224,154,412 | GREEN | RED | **$0.00** |
| WBTC | $2,039,677,240 | GREEN | RED | **$0.20** |

If every one of the 57 reserves were tampered simultaneously, each to its own individual limit, the total
undetectable fabrication is **$7.33 — 6.5e-6 bps of TVL**. Against $55,363,881 for the total form, the
per-reserve form is about **7.5 million times** tighter on quantity.

---

## 6. Coverage, stated rather than implied

The gate asserts its own scope on every run (F11), from figures it fetches rather than quotes.

| | measured |
|---|---|
| what this gate verifies | Aave V3 **Ethereum only**, $11.32B |
| as a share of Aave V3 across all 22 chains | **82.74%** |
| as a share of all DefiLlama-tracked TVL | **4.779%** of $236.9B |
| Bridge | **18.95%** of tracked TVL |
| RWA | **11.19%** |
| Bridge + RWA | **30.14%** — §3.9's 30.1% confirmed |
| Canonical Bridge (a *separate* category) | **+3.42%**, which §3.9's figure does not include |
| honest unreconstructable total | **33.56%** |

§3.9's 30.1% is correct for the two categories it names, but DefiLlama files canonical bridges under
their own category, and a canonical bridge's TVL is a claim about an off-chain operator by exactly the
same argument §3.9 makes. Counting it, **a third of all tracked TVL is out of reach of any chain-state
reconstruction**, not 30.1%.

**`/hacks`, measured:** 603 incident records, 168,895 bytes, 13 distinct fields, 269 tagged Ethereum, 263
distinct free-text technique labels. **Zero records contain any string shaped like an on-chain address or
transaction hash. Zero carry a non-empty source link.** There is not one pointer in the entire dataset
that a chain could be asked about. §3.9's "structurally unverifiable" is not a judgement call — there is
nothing there to verify against. F11 asserts the pointer count is 0, so if DefiLlama ever adds one, the
gate says so.

### What this gate does *not* do

It compares a reconstruction against DefiLlama per reserve. It does **not** Merkle-prove the balances: it
trusts `eth_call` from the RPC endpoints it queries. §3.7 measures that `eth_getProof` anchoring at about
6.7 KB per reserve, and that is not wired in here. So the honest statement of what a green F is:

> every reserve DefiLlama publishes for Aave V3 Ethereum was reproduced from state those RPCs served at a
> named block, to within DefiLlama's own printing precision on quantity and 25 bps of impact on price.

Not "the chain says so". Adding `anchorState()` per reserve would close that, and it is named work rather
than a research question.

---

## 7. Is the gate falsifiable

Yes, and it is demonstrated rather than argued. `gateF-revert.mjs` performs two separate reverts because
the gate guards two separate defects.

```
1/4  baseline: the gate as shipped must be GREEN                    pass=12 fail=0
2/4  REVERT 1, per-reserve degraded to total-only (the §3.6 defect) pass=8  fail=4
     red tests: F7 | F8 | F9 | F12
3/4  REVERT 2, coverage assertion removed (the F8 defect)           pass=11 fail=1
     red tests: F8
4/4  restored: the gate must go GREEN again                         pass=12 fail=0
```

Revert 1 changes one constant. The reconstruction still runs, all 57 reserves are still read, every
number is still correct — only the place the comparison *looks* changes, from 57 reserves to one sum.
Four tests notice. Revert 2 deletes the four-line coverage loop and leaves a program that still compares
per reserve and still looks careful; F8 notices.

Three vacuous-pass paths were closed while building it, and they are worth naming because each would have
produced a green gate that measured nothing:

1. **The intersection hole** (§5.2) — closed by iterating DefiLlama's key set.
2. **The empty comparison** — F3 asserts it compared at least 50 reserves before believing its own
   result. Zero rows means zero violations means green.
3. **Silent transport skips** — F12 fails if more than one check was skipped for network reasons, so a
   green cannot be assembled out of tests that did not run.

**The honest residual weakness:** the price band (§3.3). It is the one number in the gate that carries a
chosen multiplier, it is calibrated on effectively 1.3 independent samples, and it lets a single reserve's
USD be wrong by $28M. It is a real assertion — a run that exceeds 25 bps on any reserve goes red — but it
is not in the same class as the quantity bound, and the gate prints that comparison rather than burying
it.

---

## 8. Files

| | |
|---|---|
| `hackathon/veritape/gates/gateF-tvl-reconstruct.mjs` | the gate, 12 tests, ~25 s, live network |
| `hackathon/veritape/gates/gateF-revert.mjs` | the scripted revert, two reverts, ~2 min |
| `Quiver/gates/gateF-tvl-reconstruct.mjs`, `Quiver/gates/gateF-revert.mjs` | mirrors |

```
node --test gates/gateF-tvl-reconstruct.mjs     # from hackathon/veritape
node gates/gateF-revert.mjs
```

Engine untouched: `q1-e1fa99d08887d6cc` before and after.
