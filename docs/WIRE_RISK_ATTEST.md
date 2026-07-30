# risk-attest: the circuit is the wrong purchase

**Outcome: no circuit built, and that is the finding.** risk-attest was examined for the first time. The
statement a SNARK would prove about it is already decided by the response it publishes, using a hash
function and no circuit. Below is what was measured, what a buyer still has to trust, and the one thing
no circuit here could ever fix.

Nothing in `src/engine/` was touched. Engine build id `q1-e1fa99d08887d6cc` before and after, and the
directory is byte-identical to the mirror.

**Every figure below is checked against the artifact that produced it** by
`zk/scripts/verify-attest-report.mjs` — 50 checks, in three kinds. Deterministic quantities (the direct
on-chain check, constraint counts, the body-limit ceiling, hash counts, enumerated permutation classes)
must match **exactly**. Anything downstream of a Plonk proof is checked **within the gate's own measured
3-SE band**, because Plonk proving is randomised and exact-matching a random variable produces a checker
that cries wolf until someone switches it off. Claims *about* the measurement ("every residual inside
2 SE") are checked against the artifact rather than quoted.

That distinction was learned here: a first version demanded exact matches for everything, the gate was
re-run, and **22 figures went stale at once** — caught, not published.

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

Plonk verify gas, measured over three circuits in this repo at 8 / 12 / 28 public signals, 12 real proofs
each, fresh EVM per call, EIP-2028 calldata gas included on both sides:

- base **279,545 gas** at zero signals, marginal **1,074.6 gas per public signal**
- **every linearity residual inside 2 SE** of its own sampling error — the linear model is not an
  assumption here, it was tested

At the service's own ceiling of N=244 (490 public signals):

| | gas |
|---|---|
| direct set-exactness on chain, whole set | **708,175** (582,655 exec + 125,520 calldata) |
| Plonk verify @ 490 public signals | **806,106** |
| margin | **97,931** |

The direct check is also **deterministic** — identical gas on a repeat call, asserted rather than assumed,
because it touches no proof scalars.

**The derived bound.** That 806,106 is extrapolated 462 signals past the furthest point measured, so it
carries the sampling error of both endpoints. SE of the marginal is 18.41 gas/signal. Taking a one-sided
**3 SE** bound in the only direction that can overturn the finding — a smaller marginal makes the pairing
check look cheaper — and anchoring at the low point pushed down by 3 SE too:

- worst-case pairing check **779,016 gas**, worst-case margin **70,841 gas**
- **the worst honest case consumes 27.7% of the central margin**

The first version of this bound used the raw min/max spread as the uncertainty on the marginal. That is the
uncertainty on a single *draw*, not on the estimator, and it gets *worse* as samples are added rather than
better. It produced a **negative** worst-case margin and turned the gate red. The estimator was wrong, not
the finding — SE of the mean is what shrinks with sampling, and that is what the bound now rests on.

**And the honest limit of this leg.** N=244 is the *tightest* point on the curve — the direct check grows
with N, the pairing check's public-input term grows twice as fast, so they are closest at the ceiling. At
N=64 the pairing check costs **2.20x** the direct check (419,245 vs 190,931). At the ceiling they are
within **14%**. The gas argument is decisive below the ceiling and close at it, and the finding is not
allowed to lean on it.

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
| `zk/scripts/verify-attest-report.mjs` | checks every figure in this document against the artifact that produced it |

The five EVM-measuring scripts need `solc`, `@ethereumjs/evm` and `circomlib`, which live in the dev `zk/`
tree and not in the mirror's `node_modules` — the same requirement `probe-direct-vs-snark-gas.mjs` already
has. `verify-attest-report.mjs` needs only the artifacts and runs anywhere.

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

## 8. Not mine, and left alone

`gates/preflight.mjs` is **red on arrival**, on two checks:

- `every handler that builds a zk proof snaps its inputs onto that grid first — on BOTH surfaces` →
  `http:lp-risk, mcp:lp_risk`
- `the proof-emitting set is the one that has been checked` → the live set is now six
  (`event-vol, exec-verify, lp-risk, perp-gate, size-gate, treasury-risk`), not the pinned four

That is a sibling's in-flight lp-risk and event-vol proof wiring: `src/services.js`, `src/mcp.js`,
`src/util/lpBracket.js` and `gates/gateLB-*` are all modified in the shared tree. Nothing in this work
touches those files, and nothing in veritape can even reach the five files added here. Updating another
agent's pinned proof-emitting set would collide with their commit, so it is reported and not touched.

`npm test` **386, 0 failures**. `tools/docs-consistency.mjs` **CONSISTENT, 245 documents**. No contentHash
moved; no caller-visible shape moved, so there is no changelog entry to make.
