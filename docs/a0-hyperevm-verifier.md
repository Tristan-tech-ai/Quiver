# The join, on HyperEVM: what was built, what it costs, and what breaks the plan

**Written 29 July 2026.** Workstream A of `PHASE_D_BUILD_PLAN.md`, steps A0 through A3.

> ## DEPLOYED, 29 July 2026, chain 999
>
> | | |
> |---|---|
> | `PlonkVerifier` | [`0xaFf7663e57BfF86605503E0aE0Bcde4B07524900`](https://hyperevmscan.io/address/0xaFf7663e57BfF86605503E0aE0Bcde4B07524900) · tx `0xf800fc70657f16fd55ae66fa7965ff7c406f29929526cffac029db0243810a04` · 1,622,854 gas |
> | `QuiverPerpVerifier` | [`0x139C116C3cDE9C750aA61fB75fa282C9e4a4E3a6`](https://hyperevmscan.io/address/0x139C116C3cDE9C750aA61fB75fa282C9e4a4E3a6) · tx `0xaeb186c27114a8f6bbb51dcbd8008f9829e9f847f56ad0703cf51d82d0a138f2` · 986,104 gas |
> | total | 2,608,958 gas against a 2,631,781 estimate · 0.0002608958 HYPE at the 0.1 gwei floor |
> | `windowPpm` | 4,055, the staleness window gate A3 measured rather than chose |
> | machine-readable record | `zk/build/hyperevm-deployment.json` |
>
> **Checked against the DEPLOYED bytecode, not against `eth_call` with state overrides**, which is what
> every rehearsal in this document used: an honest proof at the live mark returns `true`, a wrong asset
> reverts `MarkMismatch`, a bent proof reverts `ProofRejected`. Every gate prediction held on the real
> contract.
>
> **A past join cannot be re-verified by replay.** The precompiles are not block-scoped, as §3 below
> establishes, so the transaction hashes above are the only evidence these calls ever have. That is why
> they are written down here rather than left in a build artifact.
>
> Deployed from `0x2c2f7FadEA346324BC2248Efc857d650Cf5d68A1`, a wallet Tristan created and controls.
> The three earlier addresses this document names could not sign: one had its key removed by the 27 July
> key-hygiene pass, and onchainos manages neither it nor chain 999 at all. HYPE sent to the first of them
> on a recommendation that was never checked is permanently stranded.

Everything below was measured on chain 999 against the real HyperCore precompiles. Numbers inherited
from the build plan were re-derived rather than repeated; the verify gas and the gas price were both
understated, and one assumption in the plan's own sketch — that the precompile can be read "at this
block" from outside a transaction — turns out not to hold.

| gate | what it establishes | result |
|---|---|---|
| A0 | the same verifier bytes give the same answers on X Layer and HyperEVM | PASSED |
| A1 | the mark, in Solidity, exact for 232/232 perps, reverting where there is no answer | PASSED |
| A2 | the join: one call, both halves, four distinguishable refusals | PASSED |
| A3 | the staleness window, measured over 2,200 samples in three passes | PASSED |

---

## The headline, before the detail

The join works. One call on HyperEVM verifies that a liquidation-price SNARK's bound entry price is
the mark HyperCore's own state holds, and that the arithmetic on it is correct, and refuses in four
distinguishable ways when either half fails. All four gates pass.

**And it currently has no caller.** The live service produces a SNARK only when the caller supplies
every input, and defaults the entry price to HyperCore's mark only when the caller supplies a symbol.
Those two branches are mutually exclusive in `src/services.js`, so today the proof and the attestable
input never appear in the same envelope. §7 has the exact lines and the one-line change that fixes it.

**Nothing is deployed on chain.** Total spent: **$0.00, zero transactions.** The reason changed on
29 July and it is worth stating exactly, because the first reason is now fixed and the second was
never noticed: the deployer wallet **is now funded** — `0xb4ee…eba9` holds 0.042553978797017521 HYPE
on chain 999, measured at block 41,733,382 — and the deployment still cannot be sent, because **the
private key for that address is not on this machine.** Funding was necessary and not sufficient. §8
has the measurement and the one command that finishes this.

Everything else in this document ran through `eth_call` with state overrides, which is a real
HyperEVM node executing the real bytecode against the real precompiles — the same mechanism
`gateD-hl-attest.mjs` already uses — so the results are chain-truth, not fixtures.

---

## 1. What was built

| File | What it is |
|---|---|
| `zk/contracts/QuiverPerpVerifier.sol` | the join: precompile read + window + Plonk verify, one call |
| `zk/scripts/lib/perpkit.mjs` | chain 999 client, proving, the local-EVM constructor runner, revert decoding |
| `zk/scripts/gateA0-hyperevm-verifier.mjs` | A0 — the same verifier, the same answers, on two chains |
| `zk/scripts/gateA1-precompile-view.mjs` | A1 — the Solidity mark view, over all 232 perps |
| `zk/scripts/gateA2-join.mjs` | A2 — the join, and its four refusals |
| `zk/scripts/gateA3-staleness.mjs` | A3 — the window, measured |
| `zk/scripts/deploy-hyperevm.mjs` | the deployment, with `--dry-run`, ready and funded but unkeyed (§8) |

Mirrored into `Quiver/` at the same relative paths. `src/engine/` was not touched; `q1-e1fa99d08887d6cc`
was verified identical on this machine and on the live service before and after this work.

```
node zk/scripts/gateA0-hyperevm-verifier.mjs     # ~1 min
node zk/scripts/gateA1-precompile-view.mjs       # ~6 min, 232 assets
node zk/scripts/gateA3-staleness.mjs             # ~18 min, measures the window A2 needs
node zk/scripts/gateA2-join.mjs                  # ~3 min, reads the window from A3's output
node zk/scripts/deploy-hyperevm.mjs --dry-run    # what it would send, and what it would cost
```

A2 **refuses to run** without `zk/build/gateA3-staleness.json` unless a window is passed explicitly on
the command line, because a window picked to make a gate pass is not a window.

---

## 2. A0 — the verifier, on both chains, byte for byte

Not "a verifier of the same kind". The **same bytes**, checked against the contract already live at
`0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25` rather than against a fresh compile of its source.

| | measured |
|---|---|
| deployed verifier on X Layer | 7,270 bytes |
| this build, solc 0.8.26, optimizer 200, evmVersion paris | 7,270 bytes, **identical** |
| `verifyProof` selector | `0xa79b30ed` (derived from the compiled ABI) |

The same calldata, on both chains:

| case | X Layer (196) | HyperEVM (999) | expected |
|---|---|---|---|
| honest proof | `true` | `true` | `true` |
| bent proof point | `false` | `false` | `false` |
| liquidation price moved one grid step | `false` | `false` | `false` |

and on HyperEVM, each of the eight public signals moved by one on its own: **8 of 8 refused**.

The proof is about the position X Layer's registry already holds — long 1 BTC at 64,000, 10x, mmr
1.25% → 58,329.11 — proved locally in 1,112 ms.

### The cost figures the plan carries are both understated

| | plan | measured |
|---|---|---|
| Plonk verify | 273,118 gas | **304,472–306,420 gas** across two runs, and identical on both chains to the gas in each |
| HyperEVM gas price | 0.1 gwei | **0.1005, 0.1746 and 0.3000 gwei** at three measurements over one session. 0.1 is the floor, not the price, and quoting it as the price understates cost by up to 3x |
| verifier deployment | ~1.8M gas ≈ 0.00018 HYPE | **1,636,901 gas** |
| verifier + join deployment | not estimated | **2,631,781 gas ≈ 0.000263 HYPE ≈ $0.014** at 0.1 gwei and HYPE $54.86. An earlier figure of 2,614,147 could not be reproduced — §8 |

273,118 is *execution* gas from an in-process EVM. On chain the same call costs about 305,000 once the
21,000-gas transaction base and ~11,000 gas of calldata are included, and that is the number a caller
pays. The figure moves by a couple of thousand gas between proofs because the calldata's zero-byte
count changes, which is why it is quoted as a range. The two chains agreeing to **zero gas difference**
on the same calldata, in both runs, is worth more than either figure: it says the port is exact.

---

## 3. A1 — the mark, in Solidity, for every asset

`markPxRaw(uint32)`, `szDecimals(uint32)`, `markPxHat(uint32)`, plus `marksHat(uint32[])` for reading a
whole basket at one moment and `markProvenance(uint32)` for handing back the precompile's raw return
bytes alongside the values derived from them.

**The unit conversion is exact, and that matters more than it sounds.** HyperCore carries a perp price
as an integer of 10^(6 − szDecimals) units; the circuit works on a 1e9 grid; and
1e9 / 10^(6 − szDecimals) = 10^(3 + szDecimals), an integer for every szDecimals in 0..8. So the
conversion is a multiplication, nothing is lost, and **every residual the join then sees is real price
movement** rather than a rounding artefact. Verified against the bytes the precompile returned in the
same call, for **232 of 232 assets, exact**.

Against a separate direct read the agreement is necessarily looser, because the two reads are at
different moments and a mark turns over about once a second: 189 of 232 landed inside a wide bracket on
the first pass, and all 43 that did not agreed under a tight back-to-back re-read. Zero decode
disagreements.

**The negative half.** `markPxHat(232)`, `(300)`, `(9999)`, `(100000)`, `(4294967295)` all revert with
`PrecompileUnavailable(address,uint32)` — 5 of 5. The precompiles themselves revert with
`PrecompileError` on an out-of-range asset rather than returning zero, and the contract propagates that
instead of swallowing it. A view that returned 0 here would make the join compare a proven price
against zero, which fails open or closed depending on which way the comparison is written.

No asset the precompile *does* answer for carries a zero mark either — 0 of 232 — which matters because
a zero would make the join size a window against nothing. The contract reverts on it regardless; this
is the separate question of whether that path is reachable, and today it is not.

Cost: `markPxHat` through the contract estimates at **37,645 gas** including the 21,000-gas transaction
base — two precompile reads at 3,237 each plus dispatch. Contract runtime: 4,296 bytes.

---

## 4. Two things about the precompiles that are not written down anywhere

### 4.1 They are not block-scoped

The plan's step 1 says "read the mark from the HyperCore precompile **at this block**". Inside a
transaction that is true and it is the whole basis of the attestation. But `eth_call` at an explicit
block tag does **not** reproduce the value that block held. Measured: a tag 20,000 blocks (5.5 hours)
old tracked `latest` in lock-step across six samples while BTC's mark moved 635570 → 635610 → 635560 →
635559 → 635550. The precompile answers with current HyperCore state whatever tag it is given.

Two consequences:

- **A past join cannot be re-verified by replaying `eth_call`.** The evidence that a mark held at some
  block is the transaction's own inclusion in that block, not a simulation anyone can repeat later.
  This is a real limit on how much a third party can independently check after the fact.
- Historical-block reads are not even portable: **`rpc.purroofgroup.com` reverts on any explicit block
  tag**, answering only at `latest`. A gate that pins a block silently fails on one endpoint in three.

### 4.2 One tick is worth wildly different amounts across the universe

Prices are integers, so the smallest deviation that can exist is one tick — and one tick is
1.6 ppm of BTC's mark, 508 ppm of PUMP's, and **17,857 ppm (1.79%) of HMSTR's**. A staleness window
expressed only in ppm and sized on the majors is therefore *smaller than one tick* for a large part of
the universe, which makes the gate unsatisfiable there: nothing but an exact integer match could pass,
and an exact match on a moving price is luck, not correctness.

How much this bites depends entirely on the window. Measured against the live universe:

| window | assets where one tick exceeds it |
|---|---|
| 200 ppm | **55 of 166** |
| 4,055 ppm (the measured window) | **1 of 177** — HMSTR, at 5,917 ppm per tick |

So `QuiverPerpVerifier` takes the **wider** of a ppm window and a tick floor, per asset, computed on
chain from the asset's own `szDecimals`. At today's wide window the floor is nearly inert; it becomes
load-bearing the moment the window is tightened, which is what §6 recommends. It is not a comfort
margin — it is what stops one window from being correct at one end of the universe and impossible at
the other.

---

## 5. A2 — the join

```
verifyPerpGate(uint256[24] proof, uint256[8] pubSignals, uint32 asset)
  1. markPxRaw(asset) and szDecimals(asset) via STATICCALL, at this block
  2. require |chainMark − pubSignals[4]| <= max(windowPpm of mark, windowTicks ticks)
  3. require verifier.verifyProof(proof, pubSignals)
```

**Which signal carries the price, measured not assumed.** The public signals were printed over three
positions of different magnitude and both sides before anything was built on them:

```
[0] residual  [1] tolerance  [2] mHat  [3] qHat  [4] p0Hat  [5] s  [6] mmrHat  [7] pLiqHat
```

There is no mark-price signal in the circuit at all — the mark is not a term in the liquidation
identity. The only place a HyperCore mark enters the proven statement is `p0Hat`, index 4, and only
when perp-gate defaults the entry price to the live mark. §7 is about why that matters.

### Every case, on chain 999, at the measured window (`windowPpm 4055`, `windowTicks 1`)

| case | result |
|---|---|
| honest proof, live mark, right asset | `true` |
| same proof, asset = ETH instead of BTC | revert `MarkMismatch` |
| bent proof point, price still right | revert `ProofRejected` |
| asset 99999, no HyperCore answer | revert `PrecompileUnavailable` |
| price one grid step outside the contract's own bound | revert `MarkMismatch` |
| price at half the bound | `true` — the window is a window, not a wall |
| **the same PEOPLE proof, 312 s later, mark 5,063 ppm away** | **revert `MarkMismatch`** |

The last row is the one the plan calls "the one that can fail", and it was produced by holding honest
proofs and waiting for the market rather than by moving a number.

And it is refused for the right reason: `verifyProof` on that same stale proof **still returns true**.
The arithmetic was never in question; the input went out of date. That distinction is the entire
product, and the contract makes it visible by reverting with different errors for the two cases.

**The first attempt at that row failed, and the failure is a finding.** Watching BTC alone at a
4,055-ppm window, the mark did not breach in 480 seconds — it reached 969 ppm and came back. The gate
reported FAILED rather than quietly claiming a pass, which is what it is for. What it exposed is that a
window sized for the whole universe is four times BTC's own worst 30-second drift, so on a major it is
barely a gate at all. The watch now holds proofs on BTC plus the three assets A3 measured as the most
volatile, and PEOPLE breached in 312 s. The right fix is not a longer wait; it is §6's per-asset window.

### Cost

| | gas |
|---|---|
| `verifyPerpGate` — precompile reads, window, and Plonk verify | **327,845** |
| `verifyProof` alone through the same contract | 307,541 |
| **what the attestation costs on top of the proof** | **20,304** |

At the 0.1–0.3 gwei observed over this session, the whole join is 0.00003–0.0001 HYPE, under a cent.
Two precompile reads at 3,237 each is 6,474 of that 20,304; the rest is dispatch, the `szDecimals`
decode and the comparison.

The bound is read out of the contract's own `allowedDeviationHat`, not recomputed in the gate — a test
that recomputes the boundary it is testing is checking its own copy of the rule.

The order of the two checks is deliberate: the price comparison is two precompile reads and a
subtraction, and the Plonk verify is 270,000 gas. Checking the cheap half first means a stale
submission — which is the common failure, because marks move — costs about 37,000 gas instead of
307,000. It also means a submission that is both stale and bent reports `MarkMismatch`; the gate proves
each error separately so that is a naming choice rather than a gap.

### Re-run against the contract as it stands today

Re-run 29 July at **06:18:20Z**, 5h43m after the first pass, against the file a deployment would
actually send.

**The reason for re-running was wrong, and the error is worth recording because it nearly went into
this document as a finding.** The first A2 run is stamped `00:35:02Z` in its own JSON, and
`QuiverPerpVerifier.sol` shows an mtime of `06:57` — which looked like the contract had been edited
*after* the gate validated it, meaning the gates had passed a draft. They had not. The JSON is UTC and
the directory listing is local time (UTC+7). In one clock:

| | UTC |
|---|---|
| `QuiverPerpVerifier.sol` last edited | 2026-07-28T23:57:21Z |
| committed (`0a9fe62`) | 2026-07-29T00:03:45Z |
| **A2 first run** | **2026-07-29T00:35:02Z** |
| A2 re-run | 2026-07-29T06:18:20Z |

The gate ran 38 minutes *after* the last edit and 31 minutes after the commit. **A0–A3 validated the
committed contract all along.** Comparing a UTC timestamp against a local-time mtime is a one-line
mistake that manufactures a scary conclusion out of nothing, and it is the second time on this project
that a clock, not a contract, was the defect.

So the re-run below is a **fresh independent confirmation**, not a correction: the same contract, five
hours later, in a different market.

**GATE A2: PASSED**, every row reproduced:

| case | first run (00:35Z) | re-run (06:18Z) |
|---|---|---|
| honest proof, live mark, right asset | `true` | `true` |
| asset = ETH instead of BTC | `MarkMismatch` | `MarkMismatch` |
| bent proof point | `ProofRejected` | `ProofRejected` |
| asset 99999 | `PrecompileUnavailable` | `PrecompileUnavailable` |
| price one grid step outside the bound | `MarkMismatch` | `MarkMismatch` |
| price at half the bound | `true` | `true` |
| the same proof, minutes later, mark past the window | `MarkMismatch` | `MarkMismatch` |

The staleness row was earned the same way and, independently, on the same asset: honest proofs held on
BTC, PEOPLE, RSR and STABLE, and **PEOPLE breached after 290 s at 4,478 ppm** against a 4,054-ppm
bound — against 312 s and 5,063 ppm five hours earlier. Two runs, five hours apart, and the same perp
is the one that leaves the window on roughly the same timescale. BTC peaked at 966 ppm in this run
against 969 ppm in the earlier BTC-only watch — under a quarter of the window, both times, which is
§6's point about the window being far too loose for a major restated by accident. `verifyProof` on that same stale proof still returns `true` — the input went out of
date, the arithmetic did not. The proof bound the precompile mark exactly, with no rounding in
between: `publicSignals[4] = markPxHat = 64058000000000`.

Gas, re-measured: `verifyPerpGate` **327,404**, `verifyProof` alone **307,103**, so the attestation
costs **20,301** on top of the proof — within a few hundred gas of the figures above, which move with
the calldata's zero-byte count. The tick-floor survey read 177 of 177 live perps and the floor binds
on 1 of them (HMSTR, 5,952 ppm per tick at today's mark).

So the contract on disk is the contract the gates describe. The unreproducible deployment-gas figure
in §8 is a stale *estimate*, not a behavioural change.

---

## 6. A3 — the window, measured

Three passes, all sampling the precompile once a second across a basket read at ONE moment per sample
(`marksHat`, so inter-asset timing skew is removed):

| pass | basket | length | samples | recommends |
|---|---|---|---|---|
| 1 (canonical) | 38 perps, majors + a spread to the thin end | 899 s | 892 | `windowPpm 4055` |
| 2 (corroboration) | same basket, adds the tick table | 923 s | 914 | `windowPpm 3550` |
| 3 (targeted) | the 30 coarsest-GRID perps in the universe | 420 s | 417 | `windowTicks 1` |

Two independent 15-minute samples put the p99.9 of 30-second drift at 4,055 and 3,550 ppm. The larger
is used, because a window has to cover the worse of what was seen rather than average it. HyperEVM
block time, measured independently in both passes: **0.984 s/block**.

A provenance note, because the file matters more than the prose: `zk/build/gateA3-staleness.json` holds
**pass 1**, and pass 1 ran before the tick table existed, so that file carries the ppm analysis and no
`driftTicks`. Pass 3 is in `zk/build/gateA3-staleness-coarse.json` and carries the tick analysis. Pass 2
was overwritten by pass 3 and survives only as console output; its numbers appear here as corroboration
of pass 1, never as the source of a recommendation. These files were not hand-edited to look tidier.

The table below is pass 1. 33,858 pooled pairs at lag 1 s.

**|Δmark| / mark, in ppm, pooled over the basket:**

| lag (s) | p50 | p95 | p99 | p99.9 | max |
|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 127 | 393 | 827 | 3087 |
| 2 | 0 | 220 | 514 | 1077 | 3087 |
| 5 | 0 | 400 | 807 | 1701 | 3970 |
| 10 | 56 | 575 | 1028 | 2814 | 4556 |
| 30 | 187 | 1025 | 1701 | **4055** | 4556 |
| 60 | 328 | 1476 | 2419 | 4989 | 6600 |
| 120 | 543 | 1970 | 3553 | 6643 | 7393 |

**The plan's premise for A3 is confirmed with a number.** A window of zero would refuse **16,831 of
33,706** honest five-second-old proofs — 49.9%. "A2 as written would refuse almost every honest proof"
is close: it would refuse half of them, and the half it accepted would be the half where nothing traded.

### The interval that actually applies, and the surprise in it

The chain contributes about one block, 0.98 s. The service contributes 361–646 ms of round trip
(median 400) and ~1.1 s of proving. But the dominant term is none of those: **`src/adapters/hyperliquid.js`
caches the HTTP perp context for 30 seconds** (`TTL_MS = 30000`), so a served mark can already be half a
minute old before anything else has happened. That is why the 30 s row is bolded above.

Then the end-to-end measurement disagreed with its own worst case, and the disagreement is the useful
part. Twenty-four live calls to the deployed service for BTC/ETH/SOL/DOGE, each compared against the
precompile at the moment the answer landed and again two seconds later:

```
0 10 13 14 15 20 29 46 51 52 52 54 67 67 70 99 109 127 140 141 156 187 374 452   (ppm)
```

Median 55 ppm, p95 374, **worst 452** — an order of magnitude tighter than the 4,055 ppm the raw
30-second drift implies. The cache is visible in the raw data (the same served value reappears across
calls seconds apart while the chain moves under it), but in practice it is being refreshed often enough
that the served mark is usually seconds old, not tens of seconds. **That is luck, not a guarantee**, and
a window has to cover the guarantee.

### What the window should be, and the two ways to make it much smaller

Two honest numbers, for two different claims:

- **`windowPpm = 4055`** covers the p99.9 of 30-second drift **across the whole universe**, which is
  what the service can actually serve today. 0.4% of a $63,900 BTC is $259, and that is a wide gate.
  It is wide because it is carrying two things it should not have to: the illiquid tail of the perp
  universe, and a 30-second cache. The cost of that width was measured directly — at this window BTC's
  mark wandered for eight minutes without ever leaving it.
- **`windowPpm ≈ 1077`** (p99.9 at 2 s) is what the same measurement supports if the mark is read fresh
  at proving time. The per-asset table shows why the majors do better still: BTC's worst 30-second
  drift over the sample was 1,065 ppm and its worst 5-second drift 663 ppm, against PEOPLE's 4,556 and
  3,970.

So the two changes that shrink the window are not in the contract:

1. **Bypass the 30 s cache when a snark is being built.** One flag through `fetchPerpContexts(force)`,
   which already exists. Interval drops from ~31 s to ~2 s; window from 4,055 to about 1,077 ppm.
2. **Read the mark from the precompile rather than from HTTPS in the first place.** Then the entry
   price bound into the proof is by construction a value HyperCore committed, the HTTP snapshot leaves
   the trust path entirely, and the only residual left is inclusion delay — one block, 0.98 s, where
   the measured p99.9 is 827 ppm and the p95 is 127.
3. **Make the ppm term per-asset.** One universe-wide window is four times BTC's own worst 30-second
   drift and barely a quarter of what PEOPLE needs; there is no single number that is tight for both.
   The contract already computes its bound per asset from the chain's own `szDecimals`, so a per-asset
   ppm table is a storage change, not a redesign — at the price of needing someone to maintain it,
   which is why it is a recommendation rather than something done here.

None of the three is in scope for A0–A3 and none touches `src/engine/`. They are recorded here rather
than done, because changing the service was explicitly out of bounds for this task.

### `windowTicks = 1`, and the recommendation that had to be thrown away

The gate's first version recommended `windowTicks` as the p99.9 of drift measured **in ticks**, pooled
over the basket: **2,300 ticks**. That number is nonsense and it is worth saying why, because it is the
exact mirror of the ppm mistake. The pooled tick percentile is dominated by the FINE-grid end — PAXG's
tick is 0.248 ppm of its mark, so an ordinary move is thousands of its ticks — and applying 2,300 ticks
as a floor to RSR, whose tick is 804 ppm, would open a window of 185% of the price. A floor that admits
everything is not a floor.

Drift does not normalise in ticks either. Measured, per asset, worst 30-second move divided by that
asset's own tick:

| | tick | worst 30 s | in ticks |
|---|---:|---:|---:|
| PAXG | 0.248 ppm | 974 ppm | 3,927 |
| BTC | 1.561 ppm | 1,530 ppm | 980 |
| PEOPLE | 147 ppm | 4,418 ppm | 30 |
| RSR | 804 ppm | 3,225 ppm | 4.0 |

So `windowTicks` is not an alternative unit for volatility. It is a **floor**, it only ever binds where
one tick is already wider than `windowPpm`, and it must therefore be measured *there* — which is what a
second targeted pass did, sampling the 30 coarsest-grid perps in the universe for 420 s. The result:

- the coarsest tick in the entire live universe is **HMSTR at 5,917 ppm** (1.79% per tick), then NOT at
  2,959 and MEME at 1,969;
- at `windowPpm = 4055`, **the floor binds on exactly 1 of 177 live perps** — HMSTR — and one tick is
  more than its measured drift;
- so **`windowTicks = 1`**, and the floor is a safety property rather than an active constraint at this
  window size.

It becomes an active constraint the moment the window is tightened, which is what §6 recommends: at
1,077 ppm the floor would bind on HMSTR, NOT and MEME, and without it those three would be held to a
bound finer than the smallest number they can represent.

---

## 7. The finding that breaks the plan's premise

The build plan's opening move is:

> Today `QuiverProofRegistry` on X Layer verifies a SNARK proving the *arithmetic* of a liquidation
> price. The input to that arithmetic is attested by nothing.

True. But the fix it proposes cannot reach a caller today, because **the SNARK and the attestable input
live on opposite branches of the same `if`.**

`hackathon/veritape/src/services.js`, the `perp-gate` handler:

```js
const r = perpGate(compute);
if (live) {
  …
  return observationEnvelope('perp-gate', compute, r, config.version);   // ← symbol mode ends here
}
const env = proofEnvelope('perp-gate', compute, r, config.version);
if (wantSnark === true || wantSnark === 'true') {
  buildInBackground(env.proof.contentHash, env.proof.inputs, r.liquidationPrice);
}
```

- **Caller supplies a symbol** → `enrichPerpInputs` sets `entryPrice = ctx.markPx` and flags
  `_entryDefaultedToMark` → `live` is truthy → **observation envelope, no snark**. Confirmed against
  the live service: `{"symbol":"BTC","venue":"hyperliquid","size":1,"leverage":10,"snark":true}`
  returns `entryPrice 63919`, `markPrice 63919`, `_entryDefaultedToMark: true`, and `snark: undefined`.
- **Caller supplies every input** → `live` is falsy → **proof envelope, snark built** → but `p0Hat` is
  now the caller's own entry price, a private fact about their position that no chain attests, and
  `verifyPerpGate` correctly refuses it unless it happens to equal the current mark.

So the join is built, correct, and unreachable. The change that connects them is one call, in
`src/services.js`, on the observation branch — `buildInBackground(env.observation.contentHash, …)` —
and it touches no file under `src/engine/`, adds no endpoint, and moves no content hash, because
`snark` is already excluded from the hashed inputs.

**That change was deliberately not made here.** The service was deployed minutes before this work
started and the brief forbids disturbing it. It is a one-line change with a real test behind it now.

A second, smaller consequence of the same reading: the join binds a **price**, not an **asset**. The
circuit carries no asset identifier, so two perps whose marks agree within the window are
interchangeable to `verifyPerpGate`. Naming the asset in calldata is what a caller asserts; the price
is what the chain confirms. That is stated in the contract's own header rather than left to be
discovered.

---

## 8. Money

**Total spent: $0.00. Zero transactions sent. Zero gas consumed.** Still true on 29 July, for a
different reason than before.

Every result in this document came from `eth_call` and `eth_estimateGas`, which are free.

### The funding blocker is gone

Re-measured 29 July against `https://rpc.hyperliquid.xyz/evm`, chain id `0x3e7` = 999, block
41,733,382:

| address | role | HYPE on chain 999 | nonce |
|---|---|---|---|
| `0xb4ee095c20635d10e74dfee822ad853a196eeba9` | the X Layer deployer | **0.042553978797017521** | 0 |
| `0xba3ae4e9ff20d14b391bd9fd2dac71faa20b1f9b` | the selected onchainos account | 0 | 0 |
| `0x65bb932D9987F1d1a98b8942a3fa98CB28Ec073B` | the registered agent owner | 0 | 0 |

At HYPE $54.86 that is **$2.33**, against a deployment that costs $0.014 — **162x** the measured cost,
where the script insists on 3x. Nonce 0: that address has never sent a transaction on this chain.

### The blocker that replaced it

**The private key for `0xb4ee…eba9` is not on this machine.** The deploy script reads it from a file
named by `DEPLOYER_KEY_FILE`, or from `DEPLOYER_KEY`. Checked, 29 July:

| where a key could be | result |
|---|---|
| `$env:TEMP\dk.txt`, the path this document's own instructions name | does not exist |
| `DEPLOYER_KEY` / `DEPLOYER_KEY_FILE` in the environment | both unset |
| `.env`, `*.key`, `*deployer*` under `zk/` and `hackathon/veritape/` | none |
| `~/.onchainos/wallets.json` | holds `0xba3ae4…1f9b` only; `0xb4ee…eba9` is **not** an onchainos account |

The last row is the one that closes the alternatives. onchainos can sign for the account it manages,
but that account holds nothing, and moving the HYPE to it would be a transfer — outside the authority
granted, which covers gas for this deployment and nothing else. So there is no path from this machine
to a signed transaction from the funded address.

This is not a defect in the script; it is the key hygiene working as intended. The X Layer deployment
on 27 July used the same mechanism and the key file was cleaned up afterwards, which is why nothing
is lying around now.

**To finish A0 on chain**, write the private key for `0xb4ee095c20635d10e74dfee822ad853a196eeba9` to a
file and run the deploy against it. The key is never logged; only the address derived from it:

```
$env:DEPLOYER_KEY_FILE = "$env:TEMP\dk.txt"   # you write the key into that file
node zk/scripts/deploy-hyperevm.mjs --dry-run     # prints the address, the gas and the cost
node zk/scripts/deploy-hyperevm.mjs               # sends two transactions
Remove-Item $env:TEMP\dk.txt                      # afterwards
```

### The cost, re-measured, and a figure this document had wrong

Estimated against the real chain rather than from a bytes-times-200 rule, and confirmed **identical on
both RPC endpoints and stable across repeated calls**:

| | gas |
|---|---|
| `PlonkVerifier` deployment | 1,636,901 |
| `QuiverPerpVerifier` deployment | **994,880** |
| **total** | **2,631,781 → 0.0002631781 HYPE ≈ $0.0144** at 0.1 gwei and HYPE $54.86 |

At the 0.3 gwei this session also observed, the same deployment is $0.043. Both are far under any
plausible budget; the entire wallet holds $2.33, so the deployment cannot overspend even by accident.

**The join figure this document previously carried — 977,246, for a total of 2,614,147 — could not be
reproduced, and the reason is not established.** The current source estimates **994,880** on both
`rpc.hyperliquid.xyz` and `rpc.purroofgroup.com`, twice each, with zero variance; the verifier's
1,636,901 reproduces exactly. So the disagreement is confined to the join, and it is 17,634 gas
(+1.8%).

What is ruled out: the contract changed after it was committed (it matches `0a9fe62` exactly), the
endpoint (both agree), and estimate jitter (four calls, no variance). What is *not* ruled out is that
977,246 was measured earlier in that session against a draft that was edited at 23:57:21Z and never
committed in its earlier form — plausible, because the figure appears in a document written after the
edit while nothing forces the measurement to have been taken after it. **That is a hypothesis, not a
measurement, and no evidence for it survives on disk.**

The number to trust is the one that reproduces on demand: **2,631,781**. The actual receipts will
settle it, and they should be compared against 994,880 rather than 977,246.

The script checks the balance before sending anything, refuses below 3x, and writes every transaction
hash and its actual gas to `zk/build/hyperevm-deployment.json`.

### What the deployment will and will not prove

When it does run, the three checks it performs against the deployed contract are `eth_call`s, and they
are worth more than the rehearsal only in one respect: they run against code the chain committed
rather than code planted by a state override. **The precompiles are not block-scoped** (§4.1), so
those calls read HyperCore's state *now*, not the state at the deployment block — and a join verified
today cannot be re-verified tomorrow by replaying it. **The transaction's inclusion is the evidence,
and it is the only evidence.** Anyone checking a past join is trusting that the chain executed as its
receipt says. A live join they can check for themselves.

HyperEVM **testnet (chain 998) is reachable** and carries the same precompiles against testnet
HyperCore, so a real deployment transaction with real measured gas is available there for nothing. It
was not attempted: the faucet is a web flow on Hyperliquid's site, claiming it is an action on
Tristan's behalf rather than a gas fee, and it is outside what this task authorised.

---

## 9. What this does not prove

Unchanged from the plan, and worth repeating because the gates passing makes it easy to forget:

- **Not that HyperCore's mark is correct.** It is a stake-weighted median of external venues. A
  manipulated oracle is attested with full force. This reaches the venue's committed state and stops.
- **Not the asset**, per §7.
- **Not funding.** No funding precompile exists anywhere in `0x800`–`0x8ff`, so perp-gate's
  funding-drag figure stays unattested.
- **Not replayable after the fact**, per §4.1: a third party can check a *live* join for themselves,
  but checking a *past* one means trusting that the transaction executed as the chain says it did.
