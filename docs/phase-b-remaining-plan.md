# Phase B, the remaining seven — an autonomous completion plan

**Written 28 July 2026, after the deadline. Repo only. Nothing here deploys, and nothing here touches
`src/engine/`, so the published `codeHash` cannot move.**

Nine of Quiver's twenty-two services have a deterministic path that can carry a proof envelope. Two
are done: `perp-gate` has a circuit that is served and verified on chain, and `size-gate` has one that
is built but not served. This document is about the other seven, and it says plainly which of them
should be built, which should wait, and which should **not be built at all**.

---

## The ceiling that decides most of this

Read from the artifacts by `node zk/scripts/circuit-facts.mjs`, not written down:

| circuit | R1CS | Plonk | public | domain | zkey |
|---|---|---|---|---|---|
| liquidation | 667 | 1,301 | 8 | 2,048 | 5.2 MB |
| kelly | 372 | 718 | 5 | 1,024 | 2.1 MB |

The powers-of-tau file on hand is `hez_final_12`, which caps a circuit at **4,096 Plonk constraints**.
That leaves room for roughly three liquidation circuits or five Kelly circuits, and it is the single
fact that ranks everything below. Going past it means fetching a larger Hermez file, which is a
download in the gigabytes and a decision about disk, not a coding problem — but it is also not
something to do speculatively.

A note on how that table came to exist. `gateB0-kelly.mjs` recorded `plonkConstraints: 718` as a
literal, and the README quoted "357 R1CS", which is circom's *non-linear* count and not what the
`.r1cs` file holds (372). The literal happened to be correct; nothing had ever compared it to the
artifact, so it could have gone stale on the first edit to the circuit and still been reported with a
straight face. Both numbers are now read out of `build/*.r1cs` and the Plonk zkey header. **Fixing the
instrument before using it three more times is the whole reason this section is first.**

---

## Tier 1 — build these, in this order

Each rests on an identity the engine **already self-checks**, which is why they are tractable: the
circuit statement does not have to be invented, it has to be transcribed. All three fit the ptau
ceiling with room to spare.

### B3 · `treasury-risk` — Herfindahl concentration

**Identity**: `HHI = Σ wᵢ²` with `Σ wᵢ = 1`, and `1/n ≤ HHI ≤ 1`.
Sums of squares over a bounded asset count. The cheapest circuit in the catalogue, cheaper than Kelly:
no division to clear, no square root, just `n` multiplications and two comparisons.

**Estimate**: well under 500 Plonk constraints at `n ≤ 16`. Comfortable.

**The trap, already visible in the engine's own words.** The self-check is named
`HHI(asset) == Σ wᵢ² and 1/n ≤ HHI ≤ 1, compared at the 4dp precision it is published to`. So the
served number is display-rounded to four decimals, and a witness that reads it would certify a
portfolio up to 5×10⁻⁵ away from the one that was measured. This is the third appearance of the same
defect: `round(M, 2)` on margin, `round(fullKelly, 6)` on Kelly, now 4dp on HHI. **Recompute at full
precision from the snapped weights, and guard the divergence.** Do not skip the sweep because the
trap is anticipated: the point of the sweep is that anticipating it is not evidence.

### B4 · `lp-risk` — the impermanent-loss identity

**Identity**: `IL = 2√r/(1+r) − 1`, self-checked against the explicit constant-product token value at
a residual under 1e-12.

**The interesting part**: a circuit does not compute a square root, it *proves* one. Introduce `s` as
a witness with `s² = r` and `s ≥ 0`, then the identity cross-multiplies to
`(IL + 1)·(1 + r) = 2s` — polynomial, and the range discipline on `s` is one `Num2Bits`. Two
constraints for the root, a handful for the identity.

**Estimate**: comparable to Kelly, 600 to 900 Plonk constraints.

**Honest scope**: this proves the closed-form IL for a given price ratio. The *expected* IL check
(`−σ²T/8` against a numerical expectation) is a different animal and is **not** in scope; that one
needs the same machinery as Tier 3.

### B5 · `exec-verify` — the constant-product invariant

**Identity**: `(x + dx(1−f))·(y − honestOut) == x·y`, self-checked as a relative error on `k`.

This is *already* polynomial, with no division and no root. Mechanically the easiest of the three.

**Estimate**: a few hundred constraints, dominated by range checks on reserve-sized integers, which
are large (an AMM reserve can exceed 2⁶⁴ in base units) and so want careful `NB_` widths rather than
the 45 bits Kelly uses.

**The limitation must be stated in the circuit header, not buried.** The roadmap already says it: the
benchmark or fair price is an *input*. The circuit proves the AMM arithmetic is right about the
reserves it was handed; it proves nothing about whether those reserves were real. That is Phase D, and
a proof that implies otherwise is worse than no proof.

---

## Tier 2 — one that needs a decision, not a night

### `portfolio-gate` — a minimum over legs

Proving a minimum means proving two things: the named leg satisfies the condition, **and** no other
leg is smaller. The second half is `n` comparisons, which is cheap. The expensive half is that each
leg's condition *is the liquidation circuit*, so the honest cost is `n × 1,301` Plonk constraints plus
the selection argument.

**Against the measured ceiling of 4,096, that is `n ≤ 3`.** A three-leg portfolio circuit is real but
it is not what the service does; the account-mode book that was used to test it had five legs, and
whale books are larger. So this is the first place where the roadmap's Phase C stops being an
abstraction: aggregating per-leg proofs is the actual answer, not a wider circuit.

**Recommendation**: do not build it blind. Either accept `n ≤ 3` as an explicitly labelled partial
capability, or fetch a larger ptau first. That is a call for Tristan, and it is the only item in this
document that needs one.

---

## Tier 3 — blocked on transcendentals, and say so

### `options-risk` and `event-vol`

`optionsRisk` imports `black76`, which uses `Math.exp`, `Math.log`, `Math.sqrt` and a normal-CDF
approximation. `eventVol` self-checks its straddle against a **numerical integral**
(`straddle == numerical E|S_T − S₀|`). Neither is arithmetic a Plonk circuit states cheaply: `exp`,
`log` and `erf` in-circuit mean lookup arguments or polynomial approximation with a proven error
bound, and a numerical quadrature means proving a summation whose accuracy is itself the claim.

The roadmap already placed `options-risk` last and called it the point where this "stops being
arithmetic and starts being a research project". Reading the code confirms that rather than softening
it, and `event-vol` belongs in the same bucket for the same reason.

**Recommendation**: leave both at T1. Write the reason down publicly. A circuit that proves *nearly*
the served answer is worse than none, and an approximation of `erf` without a proven error bound is
exactly that.

---

## Declined — `risk-attest`

This one should **not** be built, and the reason is worth more than the circuit would be.

`riskAttest` produces a Merkle root over proof envelopes plus an EIP-712 signature. Its self-checks
are inclusion, non-inclusion of a fabricated leaf, and domain separation against an internal node
presented as a leaf. A Merkle-inclusion circuit is standard and circomlib ships the pieces.

But the roadmap already states the thing that makes it pointless here: *"a Merkle root proves inclusion
and nothing else — it says these answers were committed, not that they were right."* Anyone can verify
a Merkle path in ten lines of ordinary code, with no proving key, no ceremony, and no trust. Wrapping
that in a SNARK adds a 2 MB key and 200 ms of proving to re-state something already checkable, and it
would let the service claim a circuit count that overstates what is actually proven.

**So: declined, deliberately, and recorded here so that the absence reads as a decision rather than an
omission.** If `risk-attest` ever needs a circuit, it will be because it is aggregating proofs, and
that is Phase C.

---

## The discipline each gate must meet

Identical to B0/B1/B2, because that is what caught the defect in B1.

1. **B*0 — prove, verify, and REFUSE.** A worked case with an exact residual, then every public signal
   perturbed by one, each of which must be rejected, plus a bent proof point. A verifier that cannot
   reject is decoration.
2. **B*1 — sweep against the REAL engine.** Thousands of cases, inputs drawn deterministically from a
   seeded generator so a failure reproduces. The certified quantity must come from the engine's own
   module, never from a recomputation of the same formula, because a recomputation agrees with itself
   and proves nothing. **The bound must be tight**: if the worst observed case uses a vanishing
   fraction of it, the bound is generous and the sweep is not evidence.
3. **B*2 — the Solidity verifier in an EVM.** Compile, deploy in-process, accept the honest proof, then
   refuse every tampered signal and a bent point. Report accept gas and reject gas.
4. **A scripted revert for any gate whose green result carries weight**, on the model of
   `gates/gateA-revert.mjs`: remove the feature, require the gate to go red, restore it, require green.
   Both halves, because a gate red in both states is broken rather than strict.
5. **Sizes read from artifacts** via `zk/scripts/circuit-facts.mjs`. No literal constraint counts.

## Stop conditions

Stop and report rather than continue if any of these is hit:

- A sweep shows the bound violated and the cause is **not** display rounding. That would mean the
  identity as transcribed is wrong, and a wrong identity must not be papered over with a wider bound.
- A circuit exceeds **4,096 Plonk constraints**. Do not fetch a larger ptau autonomously.
- An identity needs a value the service does not publish. Say which, publicly, and leave it at T1.
- Proving exceeds **3 seconds**, the roadmap's stated abandon threshold.

## What this plan does not do

No deploy. No `agent update`. No changes under `src/engine/`, so `q1-e1fa99d08887d6cc` stands. No new
tests in `test/`, because the paper is served live and quotes the suite size; gates live in
`gates/` and `zk/scripts/` until the deploy that ships them. Post-deadline progress is documented in
`README.md` only, and the machine-readable paper stays at exactly seven parts.

## Where this leaves the honest total

If all of Tier 1 lands, the proof layer covers **five of twenty-two services** and **five of nine**
deterministic ones. Tier 2 would make it six, Tier 3 eight, and `risk-attest` will never be counted.
Thirteen services read live markets and ship observation envelopes; no circuit reaches them, because
proving the arithmetic perfectly says nothing about whether the mark price that went in was real.
That is the input problem, it is Phase D, and it is the honest end of this road.
