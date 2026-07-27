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

Since the metric governs the plan it is reported rather than described — and measured **on chain**,
not from our own counter. Over the eight days to 27 July 2026, **six payer addresses that are not
ours** sent **44 payments totalling 0.575 USD₮0** to the `payTo` advertised in every 402 challenge,
at per-call amounts inside the published price band. **Four of the six paid more than once**, which is
this metric. One returned across 2.55 days; another made twelve calls on 20 July and came back a week
later. Half a dollar is not a business, and it is stated plainly because a governing metric that is
flattered governs nothing.

An earlier draft said *three* wallets and external recurrence *zero*. Wrong twice: the conclusion
tested for a *third* call while the definition above says *more than once*, and the count came from an
in-memory instrument that resets on every deploy — this service deployed eight times on 27 July alone.
The chain does not forget; our instrumentation did. Addresses: `0x1b010a9c…` (22), `0xbc59eb75…` (12),
`0xc385e2df…` (5), `0xcab2b9e3…` (3), `0x8d295ff5…` (1), `0x86f10e00…` (1) — recomputable from the
USD₮0 transfer log on X Layer over blocks 65,711,861–66,403,061. One of ~70 scan windows failed, so 44
is a floor. That is against 568 calls from our own audit desk over the same window — and by the
standard this section sets, those 44 external payments are the only number here that would justify
building anything further.

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
4. **A succinct proof for a verifier that cannot run Node — SHIPPED, on X Layer, 28 July 2026.** A
   smart contract has no runtime, so it could previously check only a signature, which means trusting
   the signer rather than the arithmetic. Add `"snark": true` to a `perp-gate` call and the answer
   returns unchanged with a retrieval URL; a free `GET /proof/<contentHash>` returns a PLONK proof of
   the liquidation identity for that exact position.
   [`QuiverProofRegistry`](https://www.okx.com/web3/explorer/xlayer/address/0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60)
   hands it to the deployed verifier and records the outcome: one transaction accepting a proof bought
   from the live endpoint (468,459 gas, `ProofAccepted`) and one rejecting the same proof with the
   certified price moved a single grid step (333,155 gas, `ProofRejected`). The chain holds
   `58329.113924051` against the `58329.11` the service sold. The word is *succinct*, not
   *zero-knowledge* — the circuit has **zero private inputs** and hides nothing.
   All three limits this item used to list are closed, and how each closed is worth keeping:
   - *It certified a fixed-point restatement, not the engine’s float output* — 70.8% exact agreement,
     up to 1.9×10⁻⁴ divergence, because the encoder truncated the maintenance rate onto the 1e−9 grid
     while the engine kept the full double, so the two described **different positions**. The service
     now snaps inputs onto that grid before computing: worst divergence **5.53×10⁻¹⁰** over 3,000
     sampled positions, none above 1e−9. Leverage is snapped too, because the engine derives margin
     from it. No published content hash moved.
   - *It bound six numbers to each other, not to an account.* Closed more carefully than this document
     originally proposed. Composing the proof with the **envelope** signature leaves a gap you could
     drive a position through — a valid proof of one position beside a valid signature over another,
     each fine alone, because the content hash is a SHA-256 over canonical JSON that nothing on chain
     can recompute. So the service signs the **public signals themselves**,
     `keccak256(abi.encodePacked(uint256[8]))`, which is what the contract hashes from calldata. An
     unattested proof is still accepted and recorded as unattested; an impostor signature over the
     right digest does not set the flag.
   - *The circuit-specific phase of the Groth16 setup had one participant, and it was our machine* —
     whoever holds that secret can forge a proof. Phase 1 is the public Hermez ceremony and was never
     the problem. The deployed verifier is therefore **Plonk over that same public reference string**,
     at 13% more gas and 22× the proving time than the Groth16 artifact we did not deploy (32 ms
     against 703 ms, measured). That is the price of not asking anyone to trust a ceremony we ran
     alone, and it is paid where the caller never sees it: proving runs in a separate process, off the
     request path entirely. → [on-chain verification](onchain-verification.md)
5. **A block range on the concentrated-liquidity replay — shipped.** `lp-desk` replays real on-chain
   swaps, the most reproducible input here, and now names the range it walked: `firstBlock` and
   `lastBlock` beside the day count and swap count, so a reader re-fetches the identical window
   rather than an approximately similar one. The block numbers were already on every log the replay
   iterated; not publishing them was the defect and the fix was two fields. *Remaining:* the response
   does not yet name which node it read them from.
6. **Cross-region redundancy behind a custom domain.** *Done:* the registered endpoint resolves
   through a domain we control, a second region can serve it, and the published availability record
   shows the improvement rather than asserting it.
7. **Reproducible builds across runtimes.** Two different hashes sit behind this heading, and only
   one of them has a runtime question. The *code* hash is `sha256` over the engine's source bytes and
   performs no arithmetic at all, so it is runtime-independent by construction rather than by promise
   — and that is checkable: feeding the same file list through coreutils `sha256sum`, outside
   JavaScript entirely, returns `q1-e1fa99d08887d6cc`, the identical string the service serves.
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

---

## What comes after the proof

This document is the operating plan for the hackathon period and the commitments made inside it. The
year after is a different question, and it has its own file:
**[the roadmap after the proof](roadmap-after-the-proof.md)**.

The one-line version, because it should not need a click: the on-chain registry above covers **one
computation of twenty-two**. Five more deterministic engines can carry circuits, proofs should
aggregate so an agent polling in a loop does not pay a transaction per answer, and the honest end of
the road is not more circuits at all — it is the **input** problem, which no amount of proving the
arithmetic touches. A proof that a liquidation price follows from a mark of 64,000 is worthless if the
mark was 61,000, and that is why live-market answers ship as observations rather than proofs.
