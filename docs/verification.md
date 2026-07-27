# Verification

*Section 6 of the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper).*

Four independent things hold the claims up, in ascending order of how hard they are to fake: an
automated invariant suite, ground-truthing against live venues, a population-scale replay of real
crashes, and an outside party paying real money to check the answers.

---

## 1. The invariant suite — 363 tests, 358 passing, 5 skipped, 0 failing

Model-free properties that must hold for *any* inputs, so a regression in the mathematics breaks the
build rather than shipping a wrong number. It runs under the built-in Node test runner with no
external dependency and **no network access**, so it can be verified offline:

```bash
npm ci && npm test
```

The load-bearing ones: put-call parity and delta parity; vanna and volga matching analytic against
finite-difference values; the smile-corrected probability matching a numerical Breeden–Litzenberger
derivative; the risk-neutral density non-negative and integrating to one; the distribution's mean
equalling the forward; total variance non-decreasing in maturity; **no look-ahead in any time-series
indicator** — recomputed on a truncated prefix, a settled past value must not change; the
microstructure estimators recovering known-answer synthetic tapes; an internal Merkle node presented
as a member leaf failing to verify.

**Defects found in review each ship with a test proven red against the pre-fix code**, and that was
established by *running a scripted revert* for each rather than by reasoning about it. Twice in this
project a test passed against the broken code it was written to reject. Reasoning did not catch
either; running the revert did.

## 2. Ground-truthing — where the real defects came from

Synthetic tests only check what their author thought to check. Every service was run against live
venues and its output compared to an independent method. That is where the substantive corrections
came from: the textbook `N(d₂)` probability carrying a five-point bias on a skewed smile because it
omits the volatility-slope term; a per-trade Amihud ratio returning a figure of order 10⁹ on a live
memecoin tape because sub-cent dust drives the denominator to near zero; USD Coin reported as *not* a
proxy because it predates EIP-1967 and hides its implementation in an older slot.

The pattern in every case is the same: the code was internally consistent and wrong, and only contact
with reality exposed it.

## 3. The crash study — population-scale, pre-registered, out-of-sample

Daily snapshots of *every* open perpetual position on Hyperliquid, joined against the addresses
actually liquidated in each crash, reconstructed from the raw fill stream. Hypotheses, thresholds and
pass/fail bars were fixed in published files **before any validation number was computed**, with a
hard cutoff at the end of 2025 — betas measured only on 2025 episodes, tested only on 2026 events the
calibration had never seen.

| Event | Role | Accounts | Flagged & wiped | Cleared & wiped | Relative risk |
|---|---|---|---|---|---|
| Oct 10, 2025 | calibration | 79,386 | 7.07% | 1.83% | 3.9× |
| **Feb 2026** | **out-of-sample** | 66,148 | **43.97%** | **3.30%** | **13.3×** |
| **Jun 2026** | **out-of-sample** | 100,034 | **25.37%** | **1.78%** | **14.3×** |

**Now the parts that are hardest on the result, which belong beside it and not after it.**

*Relative risk is the most flattering true framing.* Lift over the base rate is **2.1×, not 14×**, and
lift is what an operator should use. What the flag buys: it catches about nine in ten of the accounts
it could see beforehand, at the cost of flagging four in ten of all accounts.

*An ablation the result did not survive intact.* Run twice on each event at matched flagged-population
size, once with the pre-registered betas and once with every beta forced to 1: **beta scaling adds
nothing measurable** (14.25× vs 13.85× in June; 13.32× vs 13.36× in February — noise). The threshold
also travels slightly *worse* in beta units.

*And whose distance is being measured.* The flag reads the `liquidation_price` column of the venue's
own position snapshot — literally `liquidation_price AS liq` in `h2.sql`, `h2b.sql`, and both arms of
the ablation. **It never calls `perp-gate`.** So the study establishes that *the quantity* predicts
liquidation, not that *our computation of it* does. Two consequences follow: the naive baseline a
sceptic would ask for was in the study all along, unlabelled — an agent reading the venue's endpoint
gets that price for free, so the "raw distance" arm *is* the method an agent could run without us; and
the engine's own correctness rests on evidence of a different kind, namely the per-call invariant and
`portfolio-gate`'s cross-check against the venue's published price.

Everything reproduces from public data with the scripts in
[`research/reservoir-data/`](../research/reservoir-data/) for about $1 of requester-pays S3 access.

## 4. The commissioned buyer audit

A separate autonomous buyer agent operated as a paying customer for four days from its own wallet, on
a different machine and network, with no access to the server or any internal credential. **It was
commissioned by us, so this is an arm's-length audit, not a third-party endorsement** — and what
makes it worth reading is that every figure reproduces from public data, and that it retracted its
own headline finding when the finding turned out to be wrong.

- **1,721 settled calls; 1,750 envelope verifications; zero failures.** Read that for what it is: the 1,785 rows touch fourteen of the twenty-two services and `perp-gate` alone is 1,102 of them (62%), so it establishes stability under heavy repetition and no observed mismatch where the desk went — not breadth. Eight services never appeared in its traffic. Content hashes recomputed,
  self-checks re-evaluated, signers recovered, code hashes compared against a fresh clone,
  deterministic engines re-run for byte-identical output. The desk log contains exactly one distinct
  verification outcome, `verify=OK`, and no line recording any other.
- **It found a real defect in the money path.** A fraction of calls returned a delivered answer while
  the facilitator reported success with no transaction hash, and those settlements never landed. The
  acceptance rule now gates on the transaction rather than the success flag. Note the direction: it
  cost the operator revenue and callers nothing.
- **After the fix: 719 settled calls, zero without a transaction hash.**
- **The self-correction is the part worth recording.** Its first report put the shortfall near 11%
  using the wallet's paginated aggregate history as on-chain truth. Challenged, it queried eight
  supposedly missing hashes individually — all eight existed. It withdrew the figure, re-measured two
  ways that avoid that endpoint, adopted the reading least favourable to us, and published a warning
  for whoever measures next: never treat a paginated aggregate history as ground truth.

Raw ledger: [`research/BUYER_LEDGER.csv`](../research/BUYER_LEDGER.csv) ·
recount: `node research/buyer-ledger-recount.mjs`

## 5. Concurrency

The audit's own limitations noted that no figure described behaviour under simultaneous load. Eighty
paid calls in bursts of 2, 3, 6 and 12 concurrent requests, on a deterministic service with fully
explicit inputs so nothing depended on an upstream having a good minute:

- **Settlement accounting held exactly at every level.** 0.490000 claimed against 0.490000 moved,
  forty-nine distinct transaction hashes, every one confirmed individually on chain. Nothing charged
  twice, nothing charged without an answer.
- **Delivery degrades with simultaneity.** All served at two and three concurrent; 8 and 9 of 12 at
  six; 24 of 48 at twelve. The undelivered calls were re-challenged and cost **exactly zero**.
- **The cause is not isolated** between our client's concurrent signing, the payment rail, and this
  service — so reading it as "the service handles three concurrent callers" is unsupported.
- One payer identity, so between-payer isolation remains untested. And it is our own money moving to
  our own operator wallet: quality assurance, never counted as a sale.
