# Closing the input loop: HyperEVM on chain, and a real dYdX light client

**Written 28 July 2026. Months of work, deliberately. Nothing here needs to land before the winners
are announced, and nothing here is allowed to move `q1-e1fa99d08887d6cc`.**

Two workstreams. They look similar and they are not: one is small and immediately valuable, the other
is the harder half of a claim we have already partly made.

---

## The thing that changed when the numbers sat next to each other

The plan I was carrying had a `QuiverPerpInputAttestor` on HyperEVM whose job was to read a precompile
and record the answer. Writing it down next to the gas figures killed it.

A precompile read costs **3,237 gas** in a `STATICCALL` and **nothing at all** off chain, because
`eth_call` is free. A contract that reads a precompile and stores the result is a contract that pays
to write down something anybody could have read for free. It buys one thing only: a chain-committed
record that somebody looked. That is worth very little.

**What is worth building is the other contract.** Today `QuiverProofRegistry` on X Layer verifies a
SNARK proving the *arithmetic* of a liquidation price. The input to that arithmetic is attested by
nothing. Meanwhile HyperEVM can read the input from HyperCore's own committed state, but has no
verifier. Each chain holds one half.

So the target is a single contract on HyperEVM that does both in one call:

```
verifyPerpGate(proof, publicSignals, asset)
  1. read the mark price from the HyperCore precompile at this block
  2. require it equals the price bound into publicSignals
  3. verify the Plonk proof
  → the input came from HyperCore's committed state AND the arithmetic on it is correct
```

That is the whole Phase D thesis in one transaction, for one service. Nothing else in this document
is as valuable per unit of work.

---

## Workstream A — `QuiverPerpVerifier` on HyperEVM

### What it is

The existing Plonk verifier for the liquidation circuit, redeployed on chain 999, wrapped in a
function that first reads the precompile and refuses if the proof describes a different price.

### Why it is small

| | measured |
|---|---|
| HyperEVM gas price | 0.1 gwei |
| precompile read via `STATICCALL` | **3,237 gas** per additional read |
| Plonk verify, measured in an EVM | 273,118 gas |
| deployed verifier bytecode | 8,098 bytes for the largest circuit built so far |
| deployment, estimated at ~200 gas/byte plus overhead | ~1.8M gas ≈ **0.00018 HYPE**, once |

Against `perp-gate` at 0.01 USDT per call, the deployment pays for itself before the first call
finishes and never recurs. **The per-call cost is zero for us**: a caller who wants the on-chain check
pays their own gas, and a caller who does not still gets the free off-chain read.

### Order of work

1. **A0 — the verifier alone.** Deploy the liquidation Plonk verifier to HyperEVM and prove one
   existing proof against it. This is a pure port; `gateB2` already rehearses the same contract in an
   in-process EVM, so the only new thing is the chain. **Done means**: a proof that verifies on X Layer
   verifies identically on HyperEVM, and a bent one is refused on both.
2. **A1 — the precompile read, in Solidity.** A view function that returns the mark for an asset.
   **Done means**: it returns the same integer the off-chain read returns, checked across every asset,
   and it reverts rather than returning zero when the precompile has no answer.
3. **A2 — the join, which is the actual product.** `verifyPerpGate` as sketched above. **Done means**:
   an honest proof whose price matches the live precompile verifies; the same proof one block later,
   after the mark has moved, is REFUSED; a proof for a different asset is refused; a bent proof is
   refused. The second of those is the one that can fail and the one worth writing the gate around.
4. **A3 — the staleness question, which A2 will force.** A mark moves between the moment Quiver reads
   it and the moment a proof is submitted. A2 as written would refuse almost every honest proof. The
   fix is a tolerance or a block-anchored read, and the choice must be **measured**: sample how far the
   mark moves over the real interval between an answer and a plausible submission, then set the window
   from that. A window chosen before that measurement is a guess.

### A correction this plan already needs

The 3,285 figure the research reports is a single-shot measurement that folds in its own call baseline.
Differencing N reads against N−1 gives **3,237 gas per additional read**, 3,218 for the STATICCALL
alone, linear from N=1 to 6. The N=1→2 step equals steady state within one gas, which means the
precompile is **already warm and pays no 2,600-gas cold surcharge**. It changes no decision here, and
it is the difference between a number that was measured and a number that was measured correctly.

And a sharper one, from the same measurement pass: **§4.4 of the research claims a gate
`gateD0-input-attest.mjs` was written and run. That file does not exist anywhere in the tree.** Its
reported bound of 1e-3 is also breached by honest data. A0 through A3 below must therefore treat §4.4
as an unverified claim rather than as prior work.

### What this will not prove

That HyperCore's mark price is correct. It proves the number came from HyperCore's committed state,
which for a venue that is itself a chain is as close as provenance gets to truth, and is not truth.
Funding is not covered at all: no funding precompile exists in `0x800`-`0x830`, and `perp-gate`
returns a funding-drag figure that stays unattested.

---

## Workstream B — a dYdX light client with a real checkpoint

### Exactly what is missing, and only this

Everything else is built and green. `gate:d3` passes nine checks including more than two-thirds of
verified voting power, recomputed locally, corroborated across three independently operated providers.
The signature verification that the previous build declared impossible turned out to be a proto3
encoding bug at home, and is fixed.

The one hole, in the adapter's own words:

> There is no trusted checkpoint. The validator set is fetched from the same RPC and checked against
> `header.validators_hash`, which lives in the header that same RPC served. Internally consistent but
> circular: a malicious provider could invent a validator set of its own keys, sign a fabricated block
> with them, and every check would pass.

Corroboration across three providers is what currently forces that attack to require collusion. That
is a real defence and it is not cryptography. **Closing the hole means pinning the validator set to
something no dYdX RPC controls.**

### Where an independent checkpoint could come from, best first

1. **An IBC light client of dYdX running on another Cosmos chain.** This is the strongest idea in this
   document and it is not mine to claim as novel; it is what IBC is. Any chain with an open connection
   to dYdX maintains dYdX consensus states on chain, updated and validated by *that* chain's own
   validators. Reading one gives a validator-set hash whose integrity rests on a different set of
   people entirely. **Establish first**: which chains hold live dYdX clients, how far back their stored
   consensus states go, and whether their trusting period covers the heights we care about. All three
   are measurable and none has been measured.
2. **A hash published out of band** by the dYdX foundation, an explorer, or a release artifact. Weaker,
   because it is one party, but it is genuinely not the RPC.
3. **A hash we pin ourselves, once, by hand.** Weakest and still better than circular. Its honesty
   depends entirely on saying that a human looked at a block explorer on a given day.

### Order of work

1. **B0 — survey the checkpoint sources.** Which chains carry dYdX IBC clients, at what heights, with
   what trusting periods. Pure measurement, no code. **Done means**: a table of candidate checkpoint
   sources with heights and freshness, or a finding that none is usable, stated with the reason.
2. **B1 — verify a header chain from a pinned checkpoint.** Given a trusted validator-set hash at
   height H0, walk to height H and verify each step. Tendermint bounds validator-set change per block,
   which is what makes this tractable rather than a full replay. **Done means**: a header at H verifies
   from a checkpoint at H0 thousands of blocks earlier; a header signed by a fabricated validator set
   is REFUSED; and the refusal is proven by constructing that fabrication rather than by asserting it.
3. **B2 — the trusting-period rule.** Tendermint light clients accept a jump only inside an unbonding
   window. Past it a checkpoint is worthless and the honest move is to refuse. **Done means**: an
   expired checkpoint is refused, loudly, rather than silently downgraded.
4. **B3 — return `TRUST.CHECKPOINTED`.** The constant already exists in the code and is deliberately
   never returned. This step is what earns it. **Done means**: the label is returned only when B1 and
   B2 both hold, and `gate:d3`'s existing assertion that it is never returned is replaced by an
   assertion that it is returned exactly when it should be and never otherwise.

### The design question B0 will not answer

The T2 verifier lives on X Layer. The dYdX evidence lives on a Cosmos chain. A light client verified in
Node.js is useful to a caller reading our envelope and useless to a contract. Whether any of this ends
up on chain, and on which chain, is a decision that should wait until B1 has measured what verification
actually costs. Deciding it now would be deciding it blind.

---

## Sequencing, and why A comes first

A is roughly two weeks of work with no research risk and a product at the end of it. B is months, and
its first step is a survey that might return nothing usable.

So: **A0 through A3, then B0.** If B0 finds a live IBC client with a usable trusting period, B is
ordinary engineering. If it finds none, B1 still proceeds from a hand-pinned checkpoint and the
honesty burden moves into the envelope wording.

## Constraints that hold throughout

- **Nothing touches `src/engine/`.** Adapters, gates and contracts only. `q1-e1fa99d08887d6cc` does not
  move, so no re-review, and every published proof keeps reproducing.
- **No new service.** Adding an endpoint changes the service list and triggers `agent update`. Whatever
  A and B produce attaches to existing envelopes as sibling fields.
- **Every on-chain transaction is confirmed per action.** A0 is a deployment from a real wallet. It is
  cheap and it is still not mine to send.
- **Any deploy that changes what a caller sees carries a changelog entry in the same deploy**, not
  after it.
- **Every gate proves it can fail by a scripted revert.** No exceptions, including for the ones that
  look obviously correct. The proto3 bug in B looked obviously correct across eleven chains.

## Stop conditions

Report rather than continue if:

- **A2's staleness window has to exceed the honest mark drift** to make gates pass. That would mean
  accepting proofs about prices the chain no longer holds, which is the failure this work exists to
  prevent.
- **B0 finds no checkpoint source outside the RPC set.** Then `TRUST.CHECKPOINTED` stays unreturned and
  the current label stands. That is not a failure; corroboration across three providers is a real
  defence, and claiming more would be worse than the gap.
- **B1's fabricated-validator-set refusal cannot be constructed.** If the negative case cannot be
  built, the positive result means nothing and must not be reported as a pass.

## What neither workstream will ever prove

Both establish provenance: that a named chain committed to this number. Neither establishes that the
number is true about the world. A manipulated HyperCore oracle is attested with full force, and so is a
manipulated dYdX one. That limit is structural, it is stated in the research, and no amount of work in
this document moves it.

The reason the work is still worth months is that provenance is what Quiver currently lacks entirely,
and the gap between "we say the mark was 63,362" and "the chain committed to 63,362 and here is the
proof" is the whole difference between a claim and evidence.
