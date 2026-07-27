# Quiver — what changed, and when

The hackathon submission describes this service as it stood at the moment it was written. Judging
runs afterwards and the service keeps improving, so this page exists to close the gap the other
direction: everything below is dated, and anything the submission claims should be *at least* as true
now as it was then.

Two things will not change while judging runs, because a reviewer testing a moving target learns
nothing: the endpoint URL, and the engine build hash `q1-e1fa99d08887d6cc` that every published proof
quotes. The worked proof in Appendix C of the paper reproduces byte-for-byte against this build, and
that is the contract with anyone checking our claims.

---

## 28 July 2026 — a contract checks the arithmetic

- `QuiverProofRegistry` deployed on X Layer at `0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60`, with the
  PLONK verifier at `0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25`. One transaction accepted a proof
  bought from this live endpoint (`0x50397d713b96414800fef2dc6c2b4b8a48bd89d7f793683df9deddfbe73f368a`)
  and one rejected the same proof with the certified price moved a single grid step
  (`0x97502c78e61958a9a1013a257bf281c665684e214d6474c41444eb0294cb4aac`).
- `POST /api/perp-gate` and the free MCP `perp_gate` accept `"snark": true`. The answer is unchanged
  and carries a retrieval URL; `GET /proof/<contentHash>` returns the proof, `GET /proof/vk` the key.
- Inputs are snapped onto the 1e-9 grid the circuit proves on before computing, so the proof is about
  the position that was priced. Worst divergence over 3,000 sampled positions: 5.53e-10.
- The service signs the eight public signals themselves, so the contract can check *"Quiver sold
  this"* and *"the arithmetic is right"* as two separate claims rather than one blurred one.
- Proving runs in a separate process. It had been on the main thread, which froze the event loop for
  506 ms and showed up in production as a p95 of one full second for callers who had asked for no
  proof at all. After: p95 403 ms with a proof requested, 384 ms for ordinary calls while five proofs
  build.
- Test suite 367 → 386.

## 27 July 2026 — the free path, fixed

- MCP's `perp_gate` was not stripping the proof flag from the hashed inputs, so a caller asking for a
  proof got a different content hash for the same position and no proof was built. Both halves now
  tested.
- Proofs build one at a time behind a queue of eight, because the MCP endpoint is free and proving
  costs ~700 ms of a core.

## 26 July 2026 — build `q1-bce7e7bccb16ea1b` → `q1-e1fa99d08887d6cc`

Four defects closed in the deterministic engines; Section 11.5 of the paper names each one and what
found it. The earlier build's sources remain in the repository history and still hash to the old id.

---

## How to check any of this without asking us

```bash
curl -s https://quiver-production-c3a8.up.railway.app/build          # engine identity and the rule that produced it
curl -s https://quiver-production-c3a8.up.railway.app/proof/vk       # the verification key
```

Every dated claim above resolves to something on a public chain or in a public repository. The paper's
Table 10 lists them with the command that checks each.
