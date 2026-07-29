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

## 29 July 2026 — the durable proof store can now be shared by every replica, and is still switched off

Phase A claims a finished proof survives a redeploy **and a second replica**, and that `/proof/<hash>`
answers identically from any instance. The store that shipped could only ever carry the first half: it
wrote content-addressed files to a local directory, so a second container answered 404 for a proof the
first one had just built.

The obvious fix was a Railway volume, and it does not work. Railway's own reference says **"Replicas
cannot be used with volumes"**, one volume per service, pinned to that service's region. A volume
would have delivered the redeploy half and silently failed the replica half — the worse of the two,
because the endpoint would have gone on advertising both.

So the store now has an **S3 backend beside the filesystem one**, chosen by environment: set
`QUIVER_PROOF_S3_BUCKET` for a store every replica shares, `QUIVER_PROOF_DIR` for one only this
container sees, neither for memory. The filesystem backend was kept rather than replaced — it is the
one anybody can exercise from a clone with no credentials, and it is what keeps the durability gate
runnable unattended.

What a caller can see:

- `/build.proofStorage` keeps its shape, `{durable, kind, stored, note}`, and `kind` now names which
  backend is live rather than describing storage in general.
- A `durable: false` always travels with the **reason**. A bucket that does not exist, credentials
  that were refused and an endpoint that did not answer are three different sentences, not one shrug.
  A store that breaks after a healthy start stops claiming to be durable rather than quietly reverting
  to being a Map — which is the failure the whole rewrite is designed against.
- The `/proof/<hash>` 404 gained a third form: "configured but not working", so a miss caused by a
  broken store cannot read like a miss caused by a store nobody turned on.

**Nothing is turned on by this.** With neither variable set the service behaves exactly as before and
`/build` still reports `durable: false`. The endpoints, the service list, the schemas and the engine
build hash `q1-e1fa99d08887d6cc` are all unchanged.

Under the hood the store became asynchronous on every path, including the memory one, because the S3
SDK is and a `read()` that returns a record for one backend and a Promise for the other is the worst
available shape: `res.json()` renders a Promise as `{}`, so one missing `await` would have made
`/proof/<hash>` answer 200 with an empty body that reads exactly like a cache miss. `npm run gate:a`
now runs 11 cases against **both** backends — building a proof in a child process, killing it, and
asking a fourth process for the proof over HTTP — and `npm run gate:a-revert` proves that gate can
fail five separate ways, one of which is dropping precisely that `await`.

## 29 July 2026 — the signpost could only name twelve of the twenty-two, and nobody had counted

The mis-route signpost added yesterday works by scoring a request against all twenty-two services on
two signals kept deliberately apart: **shape**, meaning does the body carry a service's required keys,
which is a fact; and **words**, meaning vocabulary overlap, which is a guess. Only shape is allowed to
redirect.

Shape read one field, `inputSchema.required`, and **eight of the twenty-two declare that empty** —
chart-press, calldata-x, macro-sentry, perp-gate, portfolio-gate, size-gate, lp-risk, risk-attest.
They declare it honestly: each accepts alternative input forms, so no single key is required across
all of them. size-gate takes `{winProb, winLossRatio}` **or** `{expectedReturn, volatility}`; perp-gate
takes `margin` **or** `leverage`. There is no one list to put in `required` without lying. The
consequence, measured by sweeping all 651 ordered pairs of distinct services with a genuine body for
every accepted form rather than by spot-checking: **the signpost could name only 12 of 22 services**,
and a request that was unmistakably a size-gate call, sent to perp-gate, produced nothing at all.

The same measurement found something nobody was looking for, and it is the worse half. Both existing
silence sweeps skip a service whose `required` list is empty — so a third of the catalogue had never
been checked by the one check whose failure costs the most, and **three services were flagging their
own correct calls**. A genuine `portfolio-gate` request carrying `positions` scored zero against
portfolio-gate and one against treasury-risk, so a correct, paid portfolio answer arrived with a
notice telling the caller they had meant a different service. A signpost that fires on a correct call
is worse than one that stays quiet on a wrong one, because it makes a right answer look wrong.

What changed:

- Each service that accepts alternative forms now states them as **declared fact**, derived from what
  its validator actually enforces rather than from what its description says. Shape scores a full
  match when any one complete form is present. This widens which sets count as complete; it does not
  soften what counts as evidence, and none of it goes anywhere near the words signal.
- Two services whose declared `required` **understated** what they enforce are stated accurately:
  exec-verify also needs a pricing reference, and event-vol also needs a vol and a horizon. Both were
  collecting redirects they had not earned.
- Candidates are now ranked so that **a count of matched requirements outranks a vocabulary
  coincidence**. A body of `{symbol, notional, leverage}` satisfies three of perp-gate's required keys
  and exactly one of chart-press's, and the blended score gave it to chart-press, 3.18 to 3.10, on
  word overlap alone.

Measured after: **19 of 22 reachable**, correct redirects over the 651 pairs 249 → 536, mis-directed
127 → 75, and **no service flags its own correct call any more**. Three remain unreachable and are
named rather than rounded away: macro-sentry requires nothing at all, so it has no shape to match, and
token-scan and wallet-audit share one schema object with tape-pulse, so `{chain, address}` genuinely
does not say which of the three questions is being asked.

Nothing a buyer reads moved. The engine build hash is still `q1-e1fa99d08887d6cc`; the advertised
`inputSchema` of all twenty-two is byte-identical, verified against the live `/` index and the live
MCP `tools/list` rather than assumed; and the alternatives are kept in a table keyed by service name
inside `src/util/routing.js`, never as a field on a service object, so there is no path by which they
could reach the listing. Content hashes are untouched: this component only ever adds a `routingNotice`
sibling, and the preflight sweep that replays every service and every optional field of each still
reports every body byte-identical.

## 28 July 2026 (later) — a wrong shop is now told apart from a wrong answer

Nothing about the mathematics changed. The engine build hash is still `q1-e1fa99d08887d6cc`, all
twenty-two services are the same twenty-two, the endpoint has not moved, and every published proof
reproduces byte-for-byte exactly as before. What changed is how this service behaves when a **caller**
gets something wrong.

The reason is on chain and anyone can read it: `agent feedback-list --agent-id 5152` returns ten
five-star reviews and two half-stars, and both half-stars are the same reviewer agent, which asked for
an Aave lending-protocol health check and called `options-desk`. Two other agents ran the same Aave
task through `protocol-pulse` and scored it 5.0 and 4.8. The capability was there. The caller picked
the wrong service out of twenty-two, and this service had no way to say so — and worse, on the second
attempt the call **succeeded** and returned a perfectly correct options surface to somebody who had
asked about a lending protocol.

So three things are new in a response, all of them **siblings** of `result` and `proof` and none of
them inside either, which is why the content hash is untouched:

- **`routingNotice`** — when a request looks aimed at a different service, this names that service and
  gives the exact call to make. It appears on refusals *and* on successful answers, because the
  dangerous case is the one that succeeds.
- **`inputRepairs`** — params nested under `params`/`input`/`arguments`, numbers sent as strings,
  `Currency` for `currency`, `token` for `address`: shapes are normalised and **every normalisation is
  reported**. Values are never invented. A missing position size, `"64,000"`, `"64k"`, and prose with
  no parameters are all still refused, because repairing a shape is not the same as deciding what a
  caller meant.
- **`howToFix`** on a refusal — the body that *would* have worked, keeping whatever values the caller
  did supply, with the gaps shown as visible placeholders rather than plausible defaults.

The free MCP endpoint gets all of this too, plus a `didYouMean` on an unknown tool name.

Quiver still never reroutes a paid call. You asked this endpoint and this endpoint answered; the
signpost is there so a caller can tell a wrong shop from a wrong answer.

Also shipped, and off by default: a content-addressed proof store, so a finished proof can survive a
redeploy instead of living in memory. `GET /build` reports which of the two states this deploy is in
under `proofStorage`, rather than asking anyone to take our word for it.

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
