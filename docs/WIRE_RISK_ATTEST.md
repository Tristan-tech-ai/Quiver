# risk-attest: the circuit is the wrong purchase

**Outcome: no circuit built, and that is the finding.** The statement a SNARK would prove about
risk-attest is already decided by the response it publishes, using a hash function and no circuit. Below
is what was measured, what a buyer still has to trust, and the one thing no circuit here could ever fix.

This document has been through **two passes**. The first established the finding. The second set out to
verify it independently, and did — the crux replicates from the served response alone, at every batch size
up to the service's ceiling, and all five scripted defects still kill the gate. It also found that **two of
the first pass's published figures were not reproducible**, traced them to an under-determined error
estimator, and rebuilt the estimator. The finding itself did not move: the gate was green in every one of
12 re-runs. Section 3a is that correction, kept in the document rather than quietly patched, because the
gas leg is the one leg where a buyer could otherwise be misled about how much room the argument has.

Nothing in `src/engine/` was touched. Engine build id `q1-e1fa99d08887d6cc` before and after, and the
directory is byte-identical to the mirror.

**Every figure below is checked against the artifact that produced it** by
`zk/scripts/verify-attest-report.mjs` — **72 checks**, in three kinds. Deterministic quantities (the direct
on-chain check, constraint counts, the body-limit ceiling, hash counts, enumerated permutation classes,
sample sizes) must match **exactly**. Anything downstream of a Plonk proof is checked **within the
measuring instrument's own error bar**, because Plonk proving is randomised and exact-matching a random
variable produces a checker that cries wolf until someone switches it off. Claims *about* the measurement
are required of the artifact rather than quoted from it.

Two things were learned the hard way here, both by the checker going red rather than by inspection. A first
version demanded exact matches for everything, the gate was re-run, and **22 figures went stale at once**.
Then the surviving band turned out to hide a worse problem: the error bar itself was estimated from three
data points, so **two published figures were not reproducible** and a re-run refuted them. Section 3a is
that story, and the estimator was rebuilt rather than the tolerance widened.

---

## 1. The question, and why the obvious answer was wrong

A Merkle root with inclusion proofs is already succinct and already verifiable. So the honest first task
was to establish what a zk proof would add. The candidate statement was completeness: an inclusion proof
says "this leaf is in the tree" and can never say "nothing was left out", so a root that silently omits an
item still yields valid inclusion proofs for everything it does contain. That gap is real, and it was
worth building for — if the caller could not close it.

**They can.** `attestations[]` carries every leaf: the complete contentHash list, in index order, one entry
per item. So set-exactness is a recomputation, not a proof obligation. Rebuild the root over the published
leaves; it lands on the published root or it does not.

Measured, over the real engine (`gateAT-attest-no-snark.mjs`, all 13 checks green):

| N | leaves published | inclusion proofs verify | set-exact decided | sha256 calls |
|---|---|---|---|---|
| 1 | 1 | yes | yes | 1 |
| 2 | 2 | yes | yes | 3 |
| 3 | 3 | yes | yes | 5 |
| 5 | 5 | yes | yes | 9 |
| 8 | 8 | yes | yes | 15 |
| 13 | 13 | yes | yes | 25 |
| 64 | 64 | yes | yes | 127 |

Exactly `2N-1` hashes, including the odd-promotion sizes (1, 3, 5, 13). At N=1024 the rebuild takes **2.591 ms** in Node (best of 5, after warm-up).

So the two things a SNARK sells are both already spent before a circuit is written. There is no privacy to
buy — every leaf is public. There is no succinctness to buy — the verifier already holds every leaf.

## 2. The recomputation is a real check, not a function that returns true

A gate that concludes against building is the most dangerous kind to trust. Every way a root can
misrepresent its set was run through the checker. The middle row is the whole finding in one line:

| tamper | set-exact | served inclusion proofs still all pass |
|---|---|---|
| a leaf is listed but the root omits it | refused | no |
| **the root covers a leaf the response never lists** | **refused** | **YES** |
| a listed leaf is substituted | refused | no |
| leafCount is inflated | refused | yes |
| the root is replaced wholesale | refused | no |

A hidden extra leaf is invisible to every inclusion proof served — all eight verify against the nine-leaf
root — and the recomputation catches it in 15 hashes. That is the property an inclusion proof provably
cannot establish, and it needs no circuit. The honest response still passes the same checker (negative
control), or the five refusals above would prove nothing.

## 3. Gas: the circuit loses, and the margin is derived rather than asserted

The pairing check has to **name the set** it claims the root covers, or the statement is about an
unspecified set and decides nothing. A 32-byte contentHash does not fit one BN254 scalar, so each leaf
costs two public signals and the root costs two more: `2N+2`.

The marginal is measured with a **public-input measuring stick** — `circuits/pubprobe<K>.circom`,
generated per run: K public inputs, a chain of quadratic constraints, an all-ones witness. Public-input
handling in a Plonk verifier is a generic loop over `nPublic` and does not depend on what the circuit
means, so the witness is free to construct and the number of measurement points becomes a choice. Ten
signal counts from **2 to 64**, 10 real proofs each, fresh EVM per call, EIP-2028 calldata gas on both
sides:

- marginal **1,015.21 gas per public signal**, SE **6.22**, over **8 residual degrees of freedom**
- base **279,290 gas** at zero signals, **R² = 0.99970**, residual sd 383 gas
- **cross-checked against real circuits**: the fitted line predicts gateAT's own measured means for
  liquidation (8 signals), concentration (12) and portfoliogate (28) to within **1%**, read from its
  artifact rather than re-measured here — and every real circuit lands *above* the line, which is the
  conservative side

At the service's own ceiling of N=244 (490 public signals):

| | gas |
|---|---|
| direct set-exactness on chain, whole set | **708,175** (582,655 exec + 125,520 calldata) |
| Plonk verify @ 490 public signals | **776,741** |
| margin | **68,566** |

The direct check is also **deterministic** — identical gas on a repeat call, asserted rather than assumed,
because it touches no proof scalars.

**The derived bound.** That figure is extrapolated 426 signals past the furthest point measured, so the
uncertainty that matters is the SE of the *fitted mean* at 490 signals, which correctly widens with
distance from the data: **2,900 gas**. Taking a one-sided **3 SE** bound in the only direction that can
overturn the finding — a cheaper pairing check:

- worst-case pairing check **768,042 gas**, worst-case margin **59,867 gas**
- **the worst honest case consumes 12.7% of the central margin** — 10.6% to 12.7% across four runs

**Two estimators, and the conclusion needs neither to be right.** gateAT fits the same marginal through
its three real circuits and gets **1,048.8 – 1,130.2** gas/signal across 12 runs — roughly 30 to 115
gas/signal steeper than the ten-point instrument, whose four runs span 1,015.0 – 1,023.3. **The two ranges
do not overlap**, so the difference is systematic rather than noise, and all three real circuits sit
*above* the synthetic line. A steeper real slope makes the pairing check **more** expensive at 490 signals,
so the synthetic estimator is the SNARK-favourable one and using it is the conservative choice. Under the
real-circuit estimator the pairing check exceeds **800,000 gas**. The direct check is cheaper under
**both**, asserted per run rather than assumed — and that, not either point value, is the property the
finding needs.

**And the honest limit of this leg.** N=244 is the *tightest* point on the curve — the direct check grows
with N, the pairing check's public-input term grows twice as fast, so they are closest at the ceiling. At
N=64 the pairing check costs **2.15x** the direct check (411,267 vs 190,931). At the ceiling they are
within **10%**. The gas argument is decisive below the ceiling and close at it, and the finding is not
allowed to lean on it.

### 3a. The estimator this section replaced, and how it was caught

The figures above are the *second* set. The first rested on an OLS through gateAT's three real circuits
alone — three points and two fitted parameters, leaving **one residual degree of freedom**. A slope SE
computed from 1 dof is itself a wildly noisy quantity, and it was then multiplied by 3 × 490 = 1,470 to
form the worst-case bound. Publishing a point estimate of that was not defensible, and re-running proved
it:

| quantity | published as | measured over **12** independent gate runs |
|---|---|---|
| worst honest case, % of central margin | 27.7% | **18.43% – 31.32%** (spread 12.89 points, mean 25.96%) |
| central margin | 97,931 gas | 85,792 – 123,936 gas |
| worst-case margin | 70,841 gas | 58,921 – 93,634 gas — **positive in 12/12** |
| marginal gas per signal | 1,074.6 | 1,048.8 – 1,130.2 |

Each published figure was a *plausible* draw — 27.7% sits inside the measured range. What is not
defensible is publishing it as a point, because nobody re-running the gate lands on it. The drift broke
`verify-attest-report.mjs`, which is how it surfaced: the checker was doing its job.

A second figure went with it. The claim that *every linearity residual sits inside 2 SE* is a per-run
accident when there is 1 residual dof: across the same 12 runs the worst residual ranged **0.38 to 2.42
SE**, and **1 run in 12 exceeded 2 SE**. It was published as a property and it is not one. Both figures
are now measured on the ten-point instrument, where the headroom moves only **10.6% – 12.7%** across four
runs — a tenfold improvement in reproducibility.

Note what did *not* move: the gate was **green in 12/12 runs** and the worst-case margin stayed
**positive in 12/12**. The finding was never in question; two of its published figures were.

The tempting repair was to widen the checker's tolerance until the numbers fitted. That is the disease
this project keeps finding. The estimator was replaced instead, and randomised quantities are now
published as **one-sided bounds** with a stated basis rather than as point estimates, because a point
estimate of a random variable cannot be reproduced by anyone.

## 4. The crossover exists, and it is unreachable

Being straight about this, because the first measurement got it wrong: **a real crossover exists.** Priced
against a pairing check carrying the eight public signals the liquidation circuit happens to have, the
direct check first costs more somewhere in N ∈ (64, 128]. That was the wrong verify to compare against.
Priced correctly at `2N+2`, the crossover moves to **N=512**.

Three independent measurements say N=512 cannot be reached:

1. **The service refuses it.** `express.json({ limit: '16kb' })`. Bisected against real POSTs: the largest
   batch accepted is **N=244** (16,367 bytes, HTTP 402 — body accepted, payment demanded). **N=245** is
   refused **413**, at a measured 67.0 bytes per leaf. Both ends of the boundary asserted.
2. **The circuit cannot be built.** risk-attest commits with sha256 over packed bytes — deliberately, so an
   on-chain verifier is a short loop on precompile 0x02. sha256 is the most expensive primitive to put in
   an arithmetic circuit. Compiled with real circom 2.2.3 and circomlib, **omitting the 256-bit sorted-pair
   comparator so every count is a lower bound**: N=2 → 125,056 constraints, N=4 → 312,640, N=8 → 687,808.
   Marginal **93,792 constraints per leaf**. At the N=244 ceiling that is **~22.8 million constraints**,
   needing a Plonk **ptau of 2^25**. The largest in `zk/build` is **2^12**.
3. **It would prove less.** The pairing check certifies arithmetic over inputs the response already
   publishes in full. The recomputation decides the same statement from the same data.

A Poseidon commitment would be about two orders of magnitude cheaper in-circuit — and has no precompile,
so it would cost far more on chain. That is the trade the engine already made, correctly, for the consumer
that matters.

## 5. What the root does not commit to (found while building the tamper matrix)

`hashPair` sorts its two arguments, so swapping the two leaves of one sibling pair cannot change their
parent. Measured by enumerating every permutation against the real engine:

| N | permutations | distinct roots | collide with the identity root |
|---|---|---|---|
| 2 | 2 | 1 | 2 |
| 4 | 24 | 3 | 8 |
| 6 | 720 | 45 | 16 |
| 8 | 40,320 | 315 | **128** = 2^7 |

The root commits to the leaf **set together with its pairing structure**, not to the published `index`. A
within-pair swap leaves the root unchanged; an across-pair swap moves it. `index` is metadata beside the
commitment, not inside it.

This is not a defect — membership is a property of the set, both leaves stay members, and sorted pairs are
what on-chain verifiers expect. It is written down because it is easy to assume otherwise, and a circuit
would not change it.

## 6. What this proves, and what a buyer must still trust

**Proves:** that a party holding one risk-attest response can decide, alone and with a hash function, that
the published root is the root over exactly the published leaves — no item dropped, no item hidden. That
is strictly stronger than what per-item inclusion proofs give, cheaper than a pairing check at every batch
size the service accepts, and needs no trusted setup, no proving key, and no circuit.

**Does not prove, and no circuit here could:** that the submitter submitted its *complete* set of
computations. The root covers what it was handed. A circuit's witness is also what it was handed. If an
agent runs twelve risk checks and roots eleven, every artifact in the system is valid and the twelfth is
simply absent. **This is the input problem, not a circuit problem**, and it is answered by input
attestation — the HyperEVM verifier reading the mark from HyperCore precompiles itself — not by a SNARK
over a tree.

Two smaller things a buyer should not over-read: the EIP-712 attestation is a signature over the root, so
it says Quiver's key saw this root, not that the root is honest; and the on-chain anchor is the operator's
own transaction, so the root's *timing* is attested by the chain, not by this service.

## 7. Where the work is

| file | what it is |
|---|---|
| `zk/scripts/gateAT-attest-no-snark.mjs` | the gate — 13 checks, artifact `zk/build/gateAT-attest-no-snark.json` |
| `zk/scripts/gateAT-revert.mjs` | five scripted defects, each must turn the gate red |
| `zk/scripts/probe-attest-snark-need.mjs` | direct on-chain check, N=2..1024, with the tamper matrix |
| `zk/scripts/probe-attest-public-input-cost.mjs` | what a public input costs a Plonk verify |
| `zk/scripts/probe-attest-circuit-floor.mjs` | real circom constraint counts for the tree |
| `zk/scripts/probe-attest-service-ceiling.mjs` | the N=244 body-limit ceiling, bisected over real POSTs |
| `zk/scripts/probe-attest-root-commitment.mjs` | permutation classes by enumeration, and the recomputation's wall clock |
| `zk/scripts/probe-attest-pi-marginal.mjs` | the ten-point public-input measuring stick — generates `pubprobe<K>.circom`, measures, cleans up |
| `zk/scripts/probe-attest-estimator-dispersion.mjs` | runs gateAT 12 times to show why the 3-point figures were withdrawn |
| `zk/scripts/verify-attest-report.mjs` | checks every figure in this document against the artifact that produced it |

The six EVM-measuring scripts need `solc`, `@ethereumjs/evm` and `circomlib`, which live in the dev `zk/`
tree and not in the mirror's `node_modules` — the same requirement `probe-direct-vs-snark-gas.mjs` already
has. `probe-attest-pi-marginal.mjs` additionally needs `zk/circom.exe` and the 2^12 ptau, because it
compiles its own measuring stick. `verify-attest-report.mjs` needs only the artifacts and runs anywhere.

**The revert.** Gate AT was written after the finding, so of course it is green. Five defects go in one at
a time and each must turn it red; the file is then restored and must go green again. Two are not invented —
they are the mistakes this work actually made:

- **the prefix comparison.** The recipe sorts each pair as byte strings; the response prints siblings
  `0x`-prefixed while an intermediate fold is bare hex. The gate's first run compared `0x8f...` against
  `ce...`, ordered on the prefix, and **every inclusion proof it checked came back false**.
- **the wrong verify to compare against.** Pricing the pairing check at 8 public signals instead of
  `2N+2`. Putting it back flips the conclusion, so the gate must die — or its conclusion was never resting
  on the measurement.

The other three: a verifier that cannot fail; the published-leaf-set premise weakened so one leaf out of
sixty-four passes it; and domain separation dropped from the gate's own recomputation, which stays
perfectly self-consistent and stops agreeing with the engine.

All five go red. The restored gate is green. Engine build id identical on both sides.

## 8. Not this work’s, and left alone

When this work was first written `gates/preflight.mjs` was **red on arrival**, on the grid-snapping check
and on the pinned proof-emitting set — a sibling's in-flight lp-risk and event-vol proof wiring. That was
reported rather than touched, because updating another agent's pinned set would collide with their commit.

**Re-measured on this pass: preflight is GREEN, 29 of 29 checks.** The sibling landed the work (commit
`3c73436`, lp-risk serving a bisection-bracket proof) and updated the pinned set themselves. The live
proof-emitting set is now **six** http services — `event-vol, exec-verify, lp-risk, perp-gate, size-gate,
treasury-risk` — so risk-attest and options-risk are the only two deterministic services not serving a
proof, and this document is the reason risk-attest is one of them.

`npm test` **386, 0 failures** (5 skipped). `tools/docs-consistency.mjs` **CONSISTENT, 255 documents**.
`gates/preflight.mjs` **29/29**. `src/engine/` is byte-identical to the mirror across all 37 files and the
build id is `q1-e1fa99d08887d6cc` before and after. No contentHash moved; no caller-visible shape moved, so
there is no changelog entry to make.
