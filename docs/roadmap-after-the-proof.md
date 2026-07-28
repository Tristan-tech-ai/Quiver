# Quiver — what comes after the proof lands

Written 28 July 2026, the day a contract on X Layer first checked one of our answers and refused a
tampered copy of it. That transaction is the end of the beginning, not the end. This document is the
next year, written so that each item can be *held to* rather than admired: every phase states what
would have to be true to call it done, and what would make us abandon it.

The organising idea has not changed and should not: **an agent should not have to trust a number it
just bought.** Everything below is a different answer to the question *"how does the buyer check?"*,
ordered by how much of the catalogue each answer can reach.

---

## Where the ladder actually stands

Four rungs, and it is worth being exact about which services are on which, because the headline
covers one of twenty-two.

| Rung | What the buyer must trust | Coverage today |
|---|---|---|
| **T0 — re-runnable** | that they can run Node | all 22 deterministic answers |
| **T1 — signed** | our key, for *provenance only* | all 22 |
| **T2 — proven** | nothing; a contract checks the arithmetic | **1** (`perp-gate` liquidation) |
| **T3 — attested input** | that the venue reported what we say it did | **0** (observations are signed, not attested) |

The gap between T2's *one* and T1's *twenty-two* is the whole roadmap. The gap between T3's zero and
everything live-market is the part nobody in this space has solved honestly, and it is where the
interesting work is.

---

## Phase A — the proof outlives the process (2 weeks)

> **Status, 28 July 2026 — built, not shipped.** A content-addressed store, five gates, and a scripted
> revert that proves those gates go red without it: `npm run gate:a`, `npm run gate:a-revert`, both
> runnable from a clone. It is **off unless `QUIVER_PROOF_DIR` is set**, and the live service does not
> set it, so everything the next paragraph says in the present tense is still true of the deployment.
> Turning it on is a deploy, and deploys wait while judging runs. See the README's post-deadline
> section.

The proof store is a `Map` in memory. A redeploy clears it; a second replica would answer 404 for a
proof the first one built. That is fine for a demonstration and unacceptable for anything a contract
depends on.

Content-addressed storage, keyed by the same content hash: write the proof to object storage on
completion, serve from there, keep the in-memory map as a cache. The proof is already immutable and
already named by its own hash, so this is a lookup change and not a design change.

**Done means**: a proof survives a redeploy and a second replica; `/proof/<hash>` answers identically
from any instance; a test kills the process between build and fetch and the fetch still succeeds.

**Abandon if**: nothing. This is unglamorous and required.

---

## Phase B — circuits for the rest of the deterministic catalogue (3 months)

> **Status, 28 July 2026 — one of six done, not shipped.** `size-gate` has a circuit: 357 R1CS / 718
> Plonk constraints, 547 ms to prove, 273,118 gas to verify and 573 to refuse. Three gates run from a
> clone (`zk/scripts/gateB{0,1,2}-kelly*.mjs`). Gate B1 failed on its first run and found a real
> defect, described in the README. No Kelly verifier is deployed and the live `size-gate` does not
> serve proofs. The remaining five are unstarted.

Six of the twenty-two engines rest on a closed-form identity that a circuit can state. In rough order
of how much a buyer would pay to have it proven rather than re-run:

1. **`size-gate`** — the Kelly first-order condition. One equation, no iteration, smaller than the
   liquidation circuit. This is the one to do second, precisely because it is easy: it turns
   "we built a circuit" into "we build circuits."
2. **`portfolio-gate`** — net exposure and first-leg-to-liquidate. Harder: it is a *minimum* over
   legs, and proving a minimum means proving both that a candidate satisfies the condition and that
   no other leg does, so constraint count grows with leg count.
3. **`exec-verify`** — slippage and price impact against a stated fair price. Arithmetic is trivial;
   the honest difficulty is that "fair price" is an input, so the proof says less than it appears to
   unless the input is itself attested. See Phase D.
4. **`lp-risk`** — impermanent loss against the constant-product identity. Closed form, provable.
5. **`treasury-risk`** — HHI and concentration. Sums of squares; provable, and the residual bound is
   already published.
6. **`options-risk`** — Black-76 greeks. Requires `exp` and `erf` in-circuit, which is where this
   stops being arithmetic and starts being a research project. Deliberately last.

The shape that makes this tractable is one the liquidation work already produced: a shared fixed-point
encoder (`scale.cjs`), a shared divergence guard that *refuses* rather than certifies when witness and
engine disagree, and a registry that takes any `(proof, publicSignals)` pair. Adding a circuit should
be adding a circuit, not rebuilding the plumbing.

**Done means**: five of the six ship with a circuit, a published verification key, and a registry that
routes by circuit id; the divergence guard is shared, not copy-pasted; each has a test that binds
public signals to echoed inputs by a relation the implementation cannot fake agreement with.

**Abandon a given circuit if**: its constraint count makes proving slower than 3 seconds, or the
identity turns out to need a value the service does not publish. Say which, publicly, and leave it at
T1. A circuit that proves *nearly* the served answer is worse than none.

---

## Phase C — one proof for a thousand answers (2 months, after B)

> **Status, 28 July 2026 — not started, and the two-month estimate assumes a toolchain we do not have.**
> This was checked rather than recalled. `snarkjs@0.7.6` exposes `plonk: setup, fullProve, prove,
> verify, exportSolidityCallData` and nothing else: there is no aggregation or recursion primitive in
> the library this project is built on, and none of Halo2, Nova, or plonky2 is installed. Verifying a
> BN254 Plonk proof *inside* a BN254 circuit means emulating a pairing over a non-native field, which
> is millions of constraints against the 718 the Kelly circuit uses, and the largest powers-of-tau
> file on hand is `hez_final_12` (2^12) at 4.8 MB against the tens of gigabytes such a circuit would
> need. So Phase C is not "the next circuit, but bigger". It is a change of proving stack, and the
> honest reading of the two months is that it is the estimate for the *work*, not for the *learning*.
> The cheaper thing to measure first is whether anyone batches: the abandon condition below is a
> measurement, and it has not been taken.

Every proof today costs its own transaction. An agent polling risk in a loop cannot put each answer on
chain, and does not want to.

Recursive aggregation: fold *n* proofs into one that says "all *n* of these verified". The registry
already batches attestations under `risk-attest`; this replaces a Merkle root of *claims* with a
single proof of *arithmetic*. The honest note is that a Merkle root proves inclusion and nothing else
— it says these answers were committed, not that they were right — and this document has never
pretended otherwise. Aggregation closes exactly that gap.

**Done means**: 100 answers verify in one transaction for less gas than 5 verify today; the aggregate
names the circuit ids it covers; a tampered member makes the aggregate fail.

**Abandon if**: aggregation costs more than it saves below 20 answers *and* real usage never batches
that many. Measure before building the second half.

---

## Phase D — the input problem, which is the real one (6 months, and may fail)

Everything above proves *arithmetic over inputs*. It says nothing about whether the inputs are true.
A proof that a liquidation price follows from a mark price of 64,000 is worthless if the mark was
61,000. For caller-supplied inputs this is correct and sufficient — the caller chose them. For
live-market answers it is the whole game, and it is why those ship as *observations* and not proofs.

Three approaches, and the order matters because the cheap one may be enough:

1. **Signed venue data where it exists.** Some venues sign their feeds; some oracles publish signed
   prices. Where a signature exists, carry it through: the observation envelope quotes it, and a
   contract can check the venue's signature and our arithmetic separately. Cheap, partial, honest.
2. **TEE attestation for the fetch.** Run the venue read inside an enclave and publish a remote
   attestation binding *this binary* to *this response at this time*. This is the approach OKX's own
   wallet infrastructure uses for key custody, so it is not exotic in this ecosystem. What it buys:
   a buyer who trusts the enclave vendor no longer has to trust us. What it does **not** buy, and
   this must be said in the same breath every time: it does not prove the venue told the truth, and
   the history of TEE side-channel breaks is not short. It converts trust-in-Quiver into
   trust-in-Intel-or-AMD, which is a genuine improvement and not a proof.
3. **zkTLS for the venue read.** Prove that a TLS session with `api.hyperliquid.xyz` returned these
   bytes, without trusting an enclave. This is the honest end state and the least mature; the
   proving costs are currently absurd for anything but small responses.

**Done means**: at least one live-market service ships with input provenance a third party can check
without trusting us, and the paper states precisely what each mechanism does and does not establish.

**Abandon if**: after three months no mechanism gets below the cost of simply re-fetching from the
venue yourself. That is a real possible outcome — for a public API, "go look yourself" may dominate
every cryptographic answer, and if so we should say that rather than ship theatre.

---

## Phase E — a ceremony worth trusting, and the speed it buys (1 month, whenever)

Groth16 proves in 32 ms and verifies for 13% less gas than the deployed Plonk verifier. It is not
deployed because its circuit-specific ceremony had one participant, and that participant was our
laptop. With rapidsnark on native hardware the same circuit proves in single-digit milliseconds —
which would put proving *back on the request path* and make the proof free from the caller's
perspective.

The blocker is social, not technical: a multi-party ceremony needs participants who do not know each
other, and each must destroy their contribution. Running one properly for each circuit is a real cost
and it multiplies with Phase B.

**Done means**: a ceremony with at least seven independent participants, transcripts published,
contributions verifiable, and the resulting Groth16 verifier deployed *beside* the Plonk one so a
buyer chooses.

**Abandon if**: seven real participants cannot be found. Then Plonk stays, permanently, and the 703 ms
stays with it. That is an acceptable outcome and much better than a ceremony with our friends in it.

---

## Phase F — distribution, which none of the above helps with (continuous)

Six external payers and 44 payments over eight days is real and small. Proof does not sell itself; a
contract that checks arithmetic is worth nothing to an agent that never discovers the endpoint.

- **MCP is the widest door** and it is already open and free. The work is presence: registries,
  client directories, template repos where "add this URL" is one line of a config file.
- **A reference integration** — a working agent that reads a position, buys a gate, submits the proof
  and acts on the verdict — is worth more than any amount of documentation. It should live in the
  repo and run in CI against production.
- **Payment channels** for high-frequency polling. Per-call x402 has fixed overhead; a session that
  settles periodically fits an agent checking risk every block. The protocol already supports it.

**Done means**: twenty external payers in a month, at least five of them recurring, none of them
commissioned by us. Stated with the same instrument that measured the current number — on chain, not
an in-memory counter that resets on deploy.

---

## What this roadmap deliberately does not contain

**No directional signals, ever.** The refusal to output an edge is not a limitation to be lifted
later. It is the reason the numbers are checkable at all: a model that predicts cannot be verified by
re-running it, only by waiting.

**No "AI-powered" layer over the engines.** The engines are deterministic because determinism is what
makes a proof possible. An LLM in the computation path would end the entire premise.

**No token.** Nothing above needs one, and adding one would replace a business that gets paid per call
with one that gets paid by speculation.

---

## The one thing that would invalidate all of it

If, after Phase B, the recurring buyers still number in single digits, then the hypothesis under this
entire project — that agents will pay for verifiability rather than merely for answers — is wrong.
The honest response would be to publish that finding, keep the engines free and open, and stop
charging. Writing that down now, while it would be embarrassing, is the only way it stays a real
possibility rather than something that gets quietly redefined later.
