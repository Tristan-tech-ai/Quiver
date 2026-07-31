# Gate D4 and divergence disclosure: the floor is not a detection threshold, and a lie can lower it

**28 July 2026. Repo-only. Nothing here is served, deployed, or on chain. Nothing touches
`src/engine/`, and `q1-e1fa99d08887d6cc` was read out of `proof.js` before and after every step of
this work, including both scripted reverts, and did not move.**

Two things were built. **Gate D4**, the negative gate `PHASE_D_RESEARCH.md` §6 specifies and §7 calls
"the highest ratio of protection to effort in this document", and **multi-source divergence
disclosure**, which §7 says must be labelled a 10.8 bps floor.

Both pass. Both have a scripted revert that breaks them, shows them red, restores them and shows them
green. The headline result is not that they pass. It is this:

> **10.8 bps is a spread, not a detection threshold, and using it as one overstates the check by
> 2.6x.** Measured over 170 rounds: honest sources sit 11.6 bps apart at p95, but a fabrication is
> only certain to be caught at **30.3 bps**, and a fabrication of up to **43.5 bps** on a single
> source was measured to make the reported divergence **smaller** than the truth did.

A low divergence number is therefore not weak evidence of honesty. It is no evidence at all, and
under some fabrications it is evidence pointing the wrong way.

---

## 1. What gate D4 covers

§6 specifies it in one paragraph: assert that services with no attestation path do not claim one, so
that "if a future edit attaches an attestation field to a Deribit answer, this goes red". Built as
specified, in five parts, `gates/gateD4-no-false-attestation.mjs`, 32 tests.

| | what it holds | how it can fail |
|---|---|---|
| **D4.1** | the register classifies all 22 services exactly once, and its host list agrees with a census **parsed out of `services.js` and the import closure of every engine** | a new service, a newly added `fetch`, or a quietly reclassified one |
| **D4.2** | the no-mechanism services produce real envelopes with no input-attestation claim anywhere in them | any claim-shaped field or phrase appearing in an envelope, at T0 or T1 |
| **D4.3** | the scanner catches claims in 12 injection shapes and stays silent on 5 honest ones and 5 denials | a scanner that stops catching, or starts over-firing |
| **D4.4** | `attachSibling` refuses the exact edit §6 names, and **permits the edits that are correct** | the refusal being removed, or the permission being removed |
| **D4.5** | a fabricated or tampered input does not produce a confident answer | a tampered result that still hashes; a below-floor fabrication reported as agreement; a single source reported at all |

The distinction the whole gate rests on, and which nothing in the repo previously named:

- **envelope attestation** is "Quiver computed this and stands behind the bytes". That is what
  `proof.js` already ships, and it is honest.
- **input attestation** is "the mark price this answer consumed is the one the venue's own state
  holds". That exists for two services.

Conflating them is the failure this project keeps catching: a guarantee stated over the general case
that holds only over a subset. D4 is the negative gate for exactly that conflation.

### The census reproduces the research exactly

D4.1 parses `services.js` and walks every engine's import closure rather than trusting a table.
Independently derived, and it agrees with §1 on every number:

| | parsed | §1 |
|---|---|---|
| services | 22 | 22 |
| can ship an observation envelope | 15 | 13 always + 2 conditional |
| can contact an external host | **14** | 14 |
| ships an observation while contacting nothing | `macro-sentry`, and only it | `macro-sentry` |
| branches between proof and observation at runtime | `perp-gate`, `portfolio-gate` | same two |

That is a confirmation, not a correction, and it is worth recording because these numbers are the
denominator of every coverage claim in the research.

### Four defects the gate found in its own first draft

Each was found by running the gate, not by reading the code.

1. **The sibling key was never scanned.** `attachSibling` scanned the payload and not the field name,
   so `attachSibling(env, 'inputAttestation', { venue: 'deribit', markIv: 0.55 })` passed. The claim
   was entirely in the key. That is precisely the edit §6 names, sailing through the gate written to
   stop it. Fixed by scanning `{ [key]: value }`.
2. **The scanner read denials as claims.** It flagged this stack's own honest output: `isAttestation:
   false`, and the sentence "this is a disclosure, not an attestation". A scanner that cannot tell a
   denial from a claim forces its allowlist to grow until it swallows everything. Fixed with
   sentence-scoped negation, and the fix is itself tested in both directions: "This is not a
   signature. The input is attested." must still be caught, and it is.
3. **The envelope allowlist had three dead permissions.** It was drafted from an exploratory word
   list, not from what the shipped scanner actually matches. The test that every allowlist entry be
   reachable by a real envelope rejected `.proof.reproduce`,
   `.proof.verifyContentHash` and `.observation.verifyContentHash`. The allowlist is now two entries.
   A permission nothing uses is a hole waiting for something to grow into it.
4. **The signature paths were exempted from that check** because the T1 signer is read once at module
   scope and the test could not see it. That exemption was a wing of the allowlist nobody had read.
   Now measured in a subprocess with a key configured, and the exemption is gone.

---

## 2. The register was rebuilt against measurement, and §5 moved

`PHASE_D_HARD_CASES.md` reports that four of §5's five hard-case claims are wrong on a load-bearing
detail. Building D4 on §5 as written would have encoded a falsehood, so the claims that change the
register were re-measured here rather than inherited. All measurements below are this work’s, on 28 July
2026, from this host.

### dYdX funding is in the store. It was a key-name error.

§4.2 and §5 both say funding "was not located in either store". Measured against
`dydx-rpc.publicnode.com`, `/store/perpetuals/key`, `prove=true`:

| key | code | value | proof | ops | verdict |
|---|---|---|---|---|---|
| `PremSamples` | 0 | **675 B** | **1,382 B** | `ics23:iavl`, `ics23:simple` | **existence** |
| `PremVotes` | 0 | 1,418 B | 2,121 B | same | existence |
| `PremiumSamples` (the old name) | 0 | **0 B** | 2,140 B | same | **non-existence** |

The third row is the control and it is the whole story: the Go constant name returns a
**non-existence** proof, which is what a key-name error looks like from the outside. The proof shape
is identical to the one §4.2 already verified for oracle price, and `src/adapters/ics23.js` already
checks that shape.

The exact reconstruction (`mean(premium samples, sint32 ppm) / 8 / 1e6`, five snapshots) is
`PHASE_D_HARD_CASES.md`'s measurement and this work did not repeat it. What this work verified is the part that moves
the register: the key exists and carries a two-op ICS-23 proof.

**This contradicts a sibling module in the same repo.** `src/adapters/dydx-attest.js` exports
`NOT_ATTESTABLE.fundingHourly` with the reason "never committed under a key ... Searched the prices
and perpetuals stores by non-existence-proof neighbour walk; not found." That refusal is wrong, and it
is wrong in the file that would implement the fix. D4 does not assert against that module, because it
is being edited concurrently and coupling a gate to a moving file produces a flaky gate rather than a
strict one. Flagging it here instead.

### The keyed OKX five are the best-provisioned for re-fetch, not the worst

§5 calls them the worst case because "the buyer cannot re-fetch without their own HMAC credentials".
Measured with **no credentials of any kind**:

| endpoint | service | status | x402 | amount |
|---|---|---|---|---|
| `market/trades` | `tape-pulse`, `chart-press` | **402** | v2, `payPerUse: true` | `100` |
| `market/candles` | `chart-press` | **402** | v2 | `100` |
| `token/advanced-info` | `token-scan` | **402** | v2 | `200` |
| `portfolio/overview` | `wallet-audit` | **402** | v2 | `200` |
| `portfolio/recent-pnl` | `wallet-audit` | **402** | v2 | `200` |
| `market/holders` | `token-scan` | 404 | | the endpoint does not exist |
| `portfolio/dex-history` | `loop-digest` | **401** `50103` | | genuinely credential-locked |

Asset `0x4ae46a…` on `eip155:196`. this work called `decimals()` on that contract on X Layer and it returned
**6**, so `100` is **$0.0001** and `200` is **$0.0002**. Control: `www.okx.com/api/v5/market/candles`
returned 200 with no credential, so `chart-press`'s CEX branch was never keyed. No payment was
executed and none should be.

So §5's stated reason is false for six of eight endpoints and true for exactly one, `loop-digest`.

**The category does not move, and that distinction is the point.** A re-fetch is not an attestation.
The responses are still unsigned JSON, and §2 of the research already measured that ordinary drift
exceeds any useful attestation bound inside a minute, so re-fetching is a concurrent check rather than
an audit. What was false was the reason, and a register whose reasons are false is a register nobody
should trust the categories of.

### Two services moved category

| service | was | is | measurement that moved it |
|---|---|---|---|
| `poly-desk` | none | **possible-unbuilt** | it reads exactly `positions(wallet)` and `activity(wallet, 40)`, which are Conditional Tokens storage on Polygon. `eth_getProof` on `0x4D97DCd9…6045` at `polygon-bor-rpc.publicnode.com`: account proof 9 nodes / 3,847 B, storage proof 7 nodes / 3,307 B, **about 7.2 KB**. `polygon-rpc.com` did not answer. This is `lp-desk` with a different contract address. |
| `protocol-pulse` | none | **partial** | TVL is recomputable from chain state for a measured subset (Aave v3 Ethereum, 1.0010x DefiLlama, that agent's measurement not this work’s). Measured here: `api.llama.fi/tvl/aave` returns the scalar in **18 bytes** against **10,173,949** for `/protocol/aave`. |

`poly-fill` stays in `none`: it walks the **resting** book, which never touches a chain. That half of
§5 is right, and the split between the two Polymarket services is the thing §5 missed by treating them
as one row.

`options-desk` stays in `none`, with its reason rewritten. Two of §5's statements about it do not
survive: "seven times past any published zkTLS benchmark" is a fact about what has been *benchmarked*
rather than a cost cliff, and §6's instruction never to build a TEE-attested Deribit fetch rests on an
analogy with DefiLlama TVL that does not hold, because `mark_iv` **is** Deribit's mark by definition
and has no external referent to be wrong about. Neither changes the verdict: nothing is built, nothing
is measured working, and Deribit signs nothing.

### The census, before and after

| category | §5 / first draft | measured |
|---|---|---|
| available | 2 | 2 |
| possible-unbuilt | 2 | **3** |
| partial | not a category | **1** |
| none | 10 | **8** |
| not-needed | 8 | 8 |

**A fifth category had to be added.** Forcing `protocol-pulse` into either "none" or
"possible-unbuilt" would state a guarantee over the general case that holds over one protocol of
7,938, which is the exact defect the register exists to catch. A `partial` entry is required to name
its subset and what falls outside it, and `attachSibling` demands more of a partial mechanism than of
a complete one: the sibling must carry a `subset` string as well as a `gaps` array.

### The gate proves it does not block correct edits

The concern raised was that D4 built on §5 "would go red on a correct future edit". An assertion that
it would not is worth nothing next to a test that performs the edit, so there are three:

- a well-formed **OKX x402 re-fetch disclosure** attaches cleanly to all five OKX services today
- a **Polygon state-proof anchor** attaches cleanly to `poly-desk` as data, while calling it an
  attestation is still refused because it is not built
- **the ratchet has a release**: promoting `poly-desk` to `available` with a mechanism and gaps on
  record makes the attestation attachable. Measure, record, then claim, in that order.

---

## 3. Divergence disclosure: what it does and does not prove

`src/util/divergence.js`. Eight sources over six hosts, six of them over four hosts already contacted
by Quiver's adapters. `usedByQuiver` separates those from corroborators, because adding a host adds a
failure mode and a reader deserves to know which is which.

### It refuses three ways, and each refusal has a test that can fail

1. **fewer than two readings** to REFUSED, with no numbers at all. A spread over one number is 0.0
   bps, which prints as perfect agreement between sources that were never compared.
2. **fewer than two distinct hosts** to REFUSED. `hyperliquid_mark` and `hyperliquid_oracle` arrive in
   one HTTP response. Two fields of one response are one source wearing two hats, and their
   difference is not multi-source agreement.
3. **no calibrated floor for this symbol** to REFUSED. A verdict without a floor asserts a detection
   capability nobody has measured.

The verdict vocabulary is `WITHIN_FLOOR` and `ABOVE_FLOOR`, swept over 498 fabrication scenarios and
never anything else. There is no `AGREE`, because that would be a claim about the world rather than
about the measurement. Every disclosure carries `isAttestation: false` and `confirmsCorrectness:
false`, and the whole object is scanned for correctness vocabulary in every one of those 498
scenarios.

### The floor, measured, 340 rounds

`gates/calibrate-divergence.mjs` runs the **same readers the module ships**, so the bound belongs to
the code that enforces it. 340 rounds at 3.5 s cycling BTC/BTC/ETH/SOL, so 170 BTC and 85 each of ETH
and SOL. Raw samples saved, so the analysis re-derives without refetching.

| symbol / set | hosts | rounds | p50 | **p95 = floor** | p99 | max |
|---|---|---|---|---|---|---|
| BTC native | 4 | 170 | 9.30 | **11.60** | 13.51 | 14.50 |
| BTC all | 6 | 170 | 10.59 | **15.88** | 19.79 | 22.05 |
| ETH native | 4 | 85 | 9.01 | **11.95** | 14.94 | 17.14 |
| ETH all | 6 | 85 | 9.88 | **19.63** | 27.64 | 30.39 |
| SOL native | 4 | 85 | 7.79 | **11.25** | 13.07 | 13.94 |
| SOL all | 6 | 85 | 8.82 | **13.23** | 18.76 | 22.94 |

§3.5's 10.8 bps sits inside the BTC distribution, between the median and the p95. Four rounds got the
order of magnitude right. What four rounds cannot show is the shape, and the shape is where the two
findings below live.

**Adding sources widens the floor.** BTC goes from 11.60 bps over four hosts to **15.88 bps over
six**. The headline is a range over independent opinions, so every source added can only push the max
up or the min down. More corroboration buys less sensitivity, not more. That is the opposite of what
"multi-source consensus" suggests, and it means the corroborator hosts are a liability for detection
even as they are an asset for availability.

### Per source pair, BTC, 170 rounds

| pair | p50 | p95 | max | note |
|---|---|---|---|---|
| `dydx_oracle` vs `okx_spot` | 8.81 | **13.65** | 17.30 | USD against USDT |
| `hyperliquid_oracle` vs `okx_index` | 10.81 | 12.74 | 15.75 | |
| `hyperliquid_oracle` vs `deribit_index` | 10.82 | 12.66 | 16.03 | |
| `hyperliquid_oracle` vs `dydx_oracle` | 8.62 | 12.24 | 15.94 | both USD oracles |
| `okx_spot` vs `okx_index` | 11.09 | 11.81 | 12.78 | **same host, same instant** |
| `okx_spot` vs `deribit_index` | 10.99 | 11.63 | 13.15 | |
| `hyperliquid_mark` vs `deribit_index` | 7.43 | 9.57 | 12.96 | |
| `hyperliquid_mark` vs `okx_index` | 7.48 | 9.39 | 12.43 | |
| `hyperliquid_mark` vs `dydx_oracle` | 5.18 | 8.85 | 12.19 | |
| `dydx_oracle` vs `okx_index` | 2.57 | 6.60 | 7.90 | |
| `dydx_oracle` vs `deribit_index` | 2.76 | 6.05 | 7.76 | |
| `hyperliquid_mark` vs `okx_spot` | 3.62 | 5.51 | 8.69 | |
| `hyperliquid_mark` vs `hyperliquid_oracle` | 3.46 | 4.25 | 6.01 | **same response** |
| `hyperliquid_oracle` vs `okx_spot` | 0.48 | 3.05 | 5.25 | |
| **`okx_index` vs `deribit_index`** | **0.26** | **1.03** | 2.21 | two hosts, and they barely differ |

Two rows carry most of the information.

**`okx_spot` vs `okx_index` at 11.09 bps is the largest median in the table, and it is one host at one
instant.** The entire difference is the USDT-against-USD basis. It is honest, permanent, and larger
than any cross-venue disagreement here. A cross-source divergence check that does not model the quote
currency is measuring the stablecoin basis and calling it disagreement.

**`okx_index` vs `deribit_index` at 0.26 bps is the tightest pair, and it is two different hosts.**
Two independent venues agreeing to a quarter of a basis point are not two independent opinions: they
are two constructions of an index over largely the same constituent exchanges. Independence of hosts
is not independence of information, and the disclosure says so rather than counting hosts and
stopping.

**A first-draft defect worth recording.** The module originally carried one `basis` string per source
and compared it, so it flagged "USD perp mark against USD index" as a stablecoin-basis pair, and the
disclosure's own limits text then described 13 of 15 BTC pairs wrongly. Splitting `quote` from
`quantity` fixed it, and the numbers above are what made the error visible: a real basis pair sits at
11 bps and a same-quote pair at 0.26, and a field that cannot separate those is not carrying the
distinction it claims to.

### The floor is not the detection threshold

This is the part §7's "labelled as a 10.8 bps floor" instruction gets wrong, and it is the reason the
module ships three more numbers beside the floor. For every source and every round, the calibration
solves for the smallest multiplicative lie on that one source that pushes the headline past the floor.

BTC native, floor 11.60 bps, medians over 170 rounds:

| source | cheapest direction | hardest direction | **spread-reducing (p50 / max)** |
|---|---|---|---|
| `deribit_index` | **2.42** | 14.00 | 11.50 / 20.25 |
| `dydx_oracle` | 4.49 | 9.26 | 6.75 / 18.75 |
| `hyperliquid_mark` | 4.61 | **30.30** | 25.50 / **43.50** |
| `hyperliquid_oracle` | 4.60 | 30.28 | 25.50 / 43.50 |
| `okx_index` | 12.09 | 15.96 | 7.00 / 22.75 |
| `okx_spot` | 12.07 | 15.94 | 7.00 / 22.75 |

Three readings, and they point in three different directions.

**Cheapest** is the adversary's number, because the adversary picks the source and the direction. At
2.42 bps for `deribit_index`, this check is more sensitive than the floor suggests for a source that
already sits at the edge of the band: push it further out and the range grows immediately.

**Hardest** is the defender's number, and it is the one that matters for any sentence beginning "a
fabrication larger than X is caught". At **30.30 bps for `hyperliquid_mark`, that is 2.6x the floor.**
Anyone reading 11.6 bps as a detection threshold is overstating the check by a factor of 2.6.
For `perp-gate` this is not academic: a mark error passes into distance-to-liquidation roughly 1:1, so
§3.5's own example of an undetected 30 bps error at 20x leverage is exactly the point where detection
becomes certain rather than comfortably inside it.

**Spread-reducing is the uncomfortable one.** A lie of up to **43.50 bps** on the Hyperliquid mark was
measured to leave the reported divergence **at or below** what the truth produced. Inside that range a
fabrication does not merely evade the check, it improves the number the check reports. So a small
divergence figure is not weak evidence of honesty. It is no evidence, and under a fabrication aimed at
the middle of the band it points the wrong way. Every disclosure carries this as a limit, in its own
output, in bps.

The mechanism is not subtle: `hyperliquid_mark` sits near one edge of the band, so moving it toward
the centre narrows the range. It is worst for the sources furthest from the middle, which are exactly
the ones a divergence check looks at hardest.

### What it does not prove, stated in the object itself

Every `DISCLOSED` object carries these, not just this document:

- it is not an attestation, not a T1 signature, not a consensus read, not a state proof
- every reading is unsigned HTTPS terminating at Quiver, so one adversary positioned there sees and
  can alter all of them together. That is §3.5's point and it is unchanged by any of the above
- agreement is not correctness. These venues quote overlapping order flow and can be wrong together,
  and the 0.26 bps `okx_index` / `deribit_index` pair is what that looks like when it is benign
- `sameHost: true` pairs arrived in one response and are not independent evidence of anything
- `sameQuote: false` pairs carry the stablecoin basis, which is the largest single term in the table
- the floor is historical. In a dislocation, honest divergence exceeds it, and one round of the
  calibration hit 22.05 bps on BTC for reasons that had nothing to do with fabrication

---

## 4. Both gates can fail, proved by script

Neither revert deletes a test. Each removes the **feature** and requires the gate to notice.

```
GATE D4 REVERT: proving the negative gate can fail
  engine build id before : q1-e1fa99d08887d6cc
  feature removed: attachSibling no longer scans for input-attestation claims
  gate against reverted code : 27 pass, 5 fail
      red: D4.4 the exact edit the research names: an attestation field on a Deribit answer is REFUSED
      red: D4.4 refused for every no-mechanism service, in prose as well as in a field name
      red: D4.4 permitted only where a mechanism was measured, and only when the sibling names its gaps
      red: D4.4 does NOT block a Polygon state-proof sibling for poly-desk
      red: D4.4 a PARTIAL mechanism must name its subset as well as its gaps
  feature restored
  gate against restored code : 32 pass, 0 fail
  engine build id after  : q1-e1fa99d08887d6cc
  [PASS] D4 FAILS when the claim scan is removed
  [PASS] and the specific failure is the one §6 names: an attestation field on a Deribit answer
  [PASS] and PASSES again once it is restored
  [PASS] engine build id unmoved (q1-e1fa99d08887d6cc -> q1-e1fa99d08887d6cc)
GATE D4 REVERT: PASSED, the negative gate is capable of failing
```

```
GATE DIV REVERT: proving the divergence gate can fail
  engine build id before : q1-e1fa99d08887d6cc
  feature removed: a single source now reports spreadBps 0 and WITHIN_FLOOR
  gate against reverted code : 19 pass, 2 fail
      red: DIV refuses on one source, and publishes no number when it does
      red: DIV live: one source reached means REFUSED, on real data
  feature restored
  gate against restored code : 21 pass, 0 fail
  engine build id after  : q1-e1fa99d08887d6cc
  [PASS] DIV FAILS when the single-source refusal is removed
  [PASS] and the red test is the single-source one, not an unrelated casualty
  [PASS] and PASSES again once it is restored
  [PASS] engine build id unmoved (q1-e1fa99d08887d6cc -> q1-e1fa99d08887d6cc)
GATE DIV REVERT: PASSED, the divergence gate is capable of failing
```

Four conditions each, and all four have to hold: red when reverted, red **for the named reason** and
not as an unrelated casualty, green when restored, and the engine build id unmoved across a script
that rewrites files. A gate red in both states is broken rather than strict and would satisfy a
one-sided check.

The divergence revert installs a specific defect rather than a crash: one source reporting
`spreadBps: 0` and `WITHIN_FLOOR`. That is the shape this project has caught before, a metric reading
exactly 0.0 on every sample, and it is what "implying agreement" looks like in code.

---

## 5. What contradicts the research

| § | says | measured |
|---|---|---|
| §3.5, §7 | "full spread 10.8 bps", to be labelled as the floor | the spread is right in order of magnitude (BTC p50 9.30, p95 **11.60** over 170 rounds), but it is **not a detection threshold**. Guaranteed catch is **30.30 bps**, 2.6x higher |
| §3.5 | a divergence gate "cannot detect a fabrication smaller than roughly that" | true and not the worst of it: a fabrication up to **43.50 bps** was measured to make divergence **smaller** than the truth did |
| §3.5 | nine sources give the tighter picture | **more sources widen the floor**: 11.60 bps over four hosts against 15.88 over six |
| §5 | ten services have no mechanism | **eight.** `poly-desk` is Polygon state (7.2 KB proof, measured), `protocol-pulse` is partial |
| §5 | the keyed OKX five are the worst case because a buyer cannot re-fetch | false for six of eight endpoints: **402 x402 at $0.0001**, verified with no credentials and with `decimals()` read on chain. True for exactly `loop-digest` |
| §4.2, §5 | dYdX funding "not located in either store" | **it is there.** `PremSamples` returns an existence proof, 675 B value, 1,382 B proof; the old key name returns a non-existence proof |
| §5 | `poly-fill` and `poly-desk` are one row | two different problems. One reads a resting book, the other reads chain state |
| §6 | never build a TEE-attested Deribit fetch, by analogy with DefiLlama TVL | the analogy fails: `mark_iv` **is** Deribit's mark and has no external referent. The conclusion survives for a different reason, that nothing is built or measured |
| §1 | 22 services, 14 contact a host, `macro-sentry` contacts nothing | **confirmed**, re-derived by parsing source rather than quoting the table |

One contradiction is inside the repo rather than the research. `src/adapters/dydx-attest.js` refuses
`fundingHourly` on the grounds that it is "never committed under a key". That is wrong, in the file
that would implement the fix.

---

## What none of this would ever prove

**Divergence disclosure is not an attestation and cannot become one by getting better numbers.** Every
reading is unsigned HTTPS terminating at Quiver's own network edge. One adversary there sees and can
alter all eight together, and no sample size changes that. It is a floor, it is now a measured floor,
and it is still a floor under a check that a positioned adversary defeats entirely.

**Gate D4 proves an absence, which is the weakest useful thing a gate can prove.** It establishes that
no service says it attests its inputs when it does not. It does not establish that any attestation is
correct, that any mechanism works, or that the register's categories are right. It establishes that
the categories and the claims agree, and that a future edit cannot silently move one without the
other. If the register is wrong, D4 will defend the wrong answer with the same rigour, which is why
two rows were re-measured rather than inherited and why every correction above names the measurement
that forced it.

**The scanner is a vocabulary check.** It catches claims phrased in the words people use for claims.
A claim phrased in words nobody anticipated passes, and D4 would be green. Twelve injection shapes is
a floor on its coverage, not a proof of it.

**The detection thresholds are one asset on one day.** 170 BTC rounds over about 20 minutes of a
quiet market. A dislocation widens the honest band and the thresholds with it, and the calibration
should be re-run rather than assumed to hold. One round in the sample hit 22.05 bps, which is 1.9x the
floor derived from the same sample, on nothing more dramatic than a normal afternoon.

**Nothing here is wired into a service.** The disclosure attaches through `attachSibling`, which is
tested against real envelopes and provably leaves the content hash where it was, but no service in
`services.js` calls it. That is deliberate for a repo-only change with four agents in the same tree,
and it means the production behaviour of this code is currently zero.

---

## Files

| | |
|---|---|
| `veritape/src/util/inputClaims.js` | the input-attestation register for all 22 services, the claim scanner, and `attachSibling`, the single chokepoint a sibling field reaches an envelope through |
| `veritape/src/util/divergence.js` | eight sources over six hosts, the three refusals, the calibrated floor and the three detection figures |
| `veritape/gates/gateD4-no-false-attestation.mjs` | the negative gate, 32 tests in five parts |
| `veritape/gates/gateD4-revert.mjs` | removes the claim scan, requires D4 red, restores it, requires green |
| `veritape/gates/gateDiv-disclosure.mjs` | 21 tests, a 498-scenario fabrication sweep and a live half against real venues |
| `veritape/gates/gateDiv-revert.mjs` | makes one source report zero divergence, requires DIV red, restores it, requires green |
| `veritape/gates/calibrate-divergence.mjs` | the 340-round campaign, using the shipped readers; `--analyse-only` re-derives from saved samples |
| `veritape/gates/divergence-calibration.json` | the artifact. `gateDiv` asserts the shipped `FLOOR` still matches it, so the two cannot drift apart |

Mirrored into `Quiver/` at the same relative paths. `npm run gate:d4`, `gate:d4-revert`, `gate:div`,
`gate:div-revert`, `calibrate:div`.

Nothing is served, no service emits any of this, and no verifier for it exists on chain.
