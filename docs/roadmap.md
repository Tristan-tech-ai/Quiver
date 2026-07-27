# Roadmap

*Section 11 of the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper).*

A hackathon submission that ends at the deadline is a demo. This is what happens next, what is
committed regardless of any competition result, and what would falsify the plan — because a service an
agent is asked to depend on has to say how long it intends to exist.

---

## Standing commitments

The endpoint stays live at its registered address, because agents discover this through an on-chain
registry entry and breaking that entry breaks every integration built against it. The availability
record stays public and externally measured, **including the outages** — a reliability claim a reader
cannot check is not a claim. And the repository stays open with the research scripts intact, so every
number remains reproducible after the event that prompted it.

## The single metric

Not revenue, not usage counts, not service breadth: **recurrence by callers who are not us.** Distinct
external agents calling more than once, because a second call is the only signal that an answer was
worth its price in a real loop. Usage without recurrence measures curiosity; revenue without
recurrence measures novelty.

Since the metric governs the plan it is reported rather than described. Three wallets that are not
ours have paid, for one or two calls each. None has returned. **External recurrence is zero**, against
568 calls from our own audit desk over the same window. That is the number, and by the standard set
two sentences earlier it is the only one that would justify building anything further.

## Sequence

**Near term — distribution over construction.** The engine is ahead of its adoption, so the work is
meeting agent builders where they already are rather than adding services. Already an MCP server on
the official registry with a free tier and framework snippets; the work is getting it in front of
builders. The reliability item sequenced here is a custom domain and a second region, which together
make redundancy possible — a registry update, planned deliberately rather than executed under deadline
pressure.

**Then — prove the number is worth a real price.** Sub-cent per-call pricing is right for discovery
and wrong as a revenue engine: dollar volume in agent payments sits above a dollar, not at a hundredth
of one. Bundles and subscriptions for high-loop callers, plus an embeddable form so a risk platform
can call these numbers inside its own product.

**Then — attestation where it carries liability.** The natural end state of a proof-carrying answer is
an attestation a third party consumes in an audit: typed, signed, revocable, anchored. That is a
compliance artefact rather than a mathematical advance, and its verifier is external — an attestation
actually *relied upon*. Deeper venue coverage and trustless-execution work are gated behind a
counterparty that genuinely requires them, not built speculatively.

---

## Known gaps that are engineering work, not limits

Stated as commitments with a definition of done, so a reader can hold the plan to them. None is
shipping in the version described here, and each is disclosed in the relevant service output today.

1. **Vanna-volga correction for one-touch barriers.** Currently priced under a single volatility with
   the model-uncertainty span published. The correction is a closed-form overhedge from three vanilla
   quotes already in the fitted smile — arithmetic not yet written, not a modelling barrier.
   *Done:* barrier prices carry the adjusted figure alongside the single-volatility one, the
   difference is reported, and a self-check asserts the correction vanishes as the smile flattens.
2. **Live macro calendar with the curated table as fallback.** *Done:* releases fetched from primary
   sources, the response states which source answered and how old it is, and a failed fetch falls back
   to the transcribed table and says so.
3. **Deeper tape coverage.** The sampled-feed limit is the exchange's, but the implementation does not
   exhaust the pagination the endpoint does offer. *Done:* the tape is walked as deep as the venue
   permits and the density diagnostic reports coverage achieved against coverage available.
4. **A succinct proof for a verifier that cannot run Node — built, with all three limits measured and
   each answered.** A smart contract has no runtime, so today it can only check a signature, which
   means trusting the signer rather than the arithmetic. The liquidation identity compiles to a
   667-constraint Groth16 circuit over BN254: **242 ms to prove, a 256-byte proof constant in the
   position, 8 ms to verify in JavaScript or 242,971 gas on chain** against a 2,025-byte Solidity
   verifier, pinning the liquidation price to within 1e−9 of the canonical integer answer.
   The word is *succinct*, not *zero-knowledge* — the circuit has **zero private inputs** and hides
   nothing. Three limits, each with its cause and its remedy rather than a bare disclosure:
   - *It certifies a fixed-point restatement, not the engine's float output* — 70.8% exact agreement,
     up to 1.9×10⁻⁴ divergence. The cause is not float-versus-integer arithmetic: the encoder
     truncates the maintenance rate onto the 1e−9 grid while the engine keeps the full double, so the
     two describe **different positions**. Snapping service inputs to that grid collapses the worst
     gap to **6.33×10⁻¹⁰**. *Done:* grid-snapped inputs become the canonical request representation
     and the gap is zero by construction.
   - *It binds six numbers to each other, not to an account* — every input is public and free, so an
     adversary picks a liquidation price and solves for the margin that makes it true. The remedy
     needs no new cryptography: every value the circuit constrains is **already inside the payload
     this service signs**. *Done:* signature-plus-proof is documented as the supported integration,
     with in-circuit signature verification held for a threat model that does not trust the signer.
   - *The circuit-specific phase of the Groth16 setup had one participant, and it was our machine* —
     whoever holds that secret can forge a proof. Phase 1 is the public Hermez ceremony and is fine.
     The remedy is removing the per-circuit ceremony rather than organising one: the same circuit
     compiles under **Plonk over that same public reference string**, run end to end — setup, prove
     and verify all pass. *Done:* Plonk is the published artifact and this reduces to a note about
     proof size.
5. **A block range on the concentrated-liquidity replay.** `lp-desk` replays real on-chain swaps —
   the most reproducible input here — then reports the window in days and swap count rather than the
   block range it walked. *Done:* the response names the first and last block and the node it read
   them from.
6. **Cross-region redundancy behind a custom domain.** *Done:* the registered endpoint resolves
   through a domain we control, a second region can serve it, and the published availability record
   shows the improvement rather than asserting it.
7. **Reproducible builds across runtimes.** Two different hashes sit behind this heading, and only
   one of them has a runtime question. The *code* hash is `sha256` over the engine's source bytes and
   performs no arithmetic at all, so it is runtime-independent by construction rather than by promise
   — and that is checkable: feeding the same file list through coreutils `sha256sum`, outside
   JavaScript entirely, returns `q1-404d7ab899d32fef`, the identical string the service serves.
   `/build` publishes the selection and ordering rule alongside the hash so the recomputation can be
   done in any language. The residual risk is the *content* hash, over computed floating-point
   results: basic IEEE-754 arithmetic is bit-identical across platforms, transcendentals
   (`exp`/`log`/`pow`/`erf`) are stable within a V8 version, and `size-gate`'s content hash is
   byte-identical on Windows and Linux on the same Node major. *Done:* a locked toolchain and a
   published OS×runtime matrix, so the transcendental case is a table rather than a mechanism
   argument.

## What three review rounds found, and the pattern that matters more than any of them

Three adversarial rounds are recorded in full in Section 11.5–11.7 of the paper: what was wrong, why,
and how it was closed. The finding worth carrying out of them is not a defect but a **recurrence** —
three separate times, a fix held only on the code path the reviewer had walked, and the fourth time it
happened the rule was moved into the constructor rather than repaired at a fifth call site.

A reader deciding how much to trust this engineering should weigh that pattern more heavily than the
defect count, because it is the part that predicts what is still undiscovered.

## What would falsify this plan

Stating the kill signal is part of the honesty the rest of this argues for.

- **If, after distribution work is genuinely done rather than merely intended, no external agents
  return for a second call** — the correct conclusion is that this capability is not yet worth paying
  for in a loop, and the response is to stop building services and either re-target the buyer or stop.
- **A measured settlement leak reappearing at volume** would mean the acceptance rule is still wrong
  in a way one day of data could not reveal.
- **An availability record that stops improving** despite the redundancy work would mean the hosting
  choice, not the code, is the product's limit.

Each is checkable by a reader from public artefacts, which is the point.
