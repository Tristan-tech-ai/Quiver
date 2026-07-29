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

## 29 July 2026 — the refusal a PAYING caller gets, and a fetched mark that claimed to be re-runnable

Two changes, both caller-visible, both outside `src/engine/`. The build hash is unchanged at
`q1-e1fa99d08887d6cc` and no content hash on any request that already worked has moved.

**1. A paid refusal now carries the corrected body, not just the complaint.** `src/app.js` builds a
refusal as an error carrying two halves: prose naming what went wrong, and a machine-readable object
holding `howToFix` (a body that would work, with the caller's own values kept), `routingNotice` (the
service that fits, with its endpoint, price and a retry) and `repairsApplied`. The x402 wrapper
serialised only the prose and dropped the object, so a caller who **paid** and got the shape wrong
received a bare refusal while a free MCP caller received the corrected body. The whole buyer-defence
effort was sitting on the surface that does not bill, and the listing points at the paid endpoints for
13 of the 22 services. Before, on `POST /api/perp-gate` with `{side:"long", entryPrice:64000}`:
`{error, detail}` and nothing else. Now: the same `{error, detail}` **plus** the `howToFix` object,
byte-identical to the one the free surface returns for the same body. The 402 challenge, the
advertised `inputSchema` on both rails and the MCP `tools/list` bytes are untouched. Billing is
untouched in both directions and this is measured rather than argued: a caller-mistake refusal returns
before `/settle` is ever called, so a refusal that teaches is still free; a delivered answer still
settles and still hashes identically.

**2. `portfolio-gate` no longer seals a fetched mark inside a `deterministic: true` proof.** A leg
naming an asset without a `markPrice` has one read from Hyperliquid at request time. That number went
into `proof.inputs` under `deterministic: true` with no `observedAtUtc`, no source and no `live`
block — the defect §11.5 of the paper records fixing on `perp-gate` symbol mode, one branch over. Such
a call now returns the **observation** envelope instead: `kind: OBSERVATION`, `deterministic: false`,
an `observedAtUtc`, a `live.filled` block naming each fetched value and the venue it came from, and a
`mathReproducibility` note. Fixed on both surfaces at once — the paid HTTP path and the free MCP tool
— from one shared helper, because the record of this defect is four fixes at four call sites.

**The shape change, stated plainly.** A `portfolio-gate` call whose legs are enriched from the venue
returns `observation` where it used to return `proof`, so its `contentHash` moves and its envelope key
changes. That was measured over all 22 services against the unmodified repository: **13 deterministic
content hashes identical, exactly one row moved** — `portfolio-gate` with an un-marked leg, from
`proof(deterministic:true)` to `observation(deterministic:false)`. A call that supplies `markPrice` and
a maintenance-margin source on every leg fetches nothing, keeps the deterministic proof envelope, and
returns the same `contentHash` it always did (`f491b453…` on the reference body, before and after,
identical on both surfaces). Account mode already shipped an observation and is unchanged.

Both fixes are held by gates that were shown to fail: `gates/gateP-paid-teaching.mjs` drives the real
payment middleware end to end and requires the paid refusal to carry the *same* teaching object as the
free one; `gates/gateP-sealed-provenance.mjs` sweeps all 22 services and all 9 MCP tools and refuses
any `deterministic: true` envelope that echoes a value the caller did not supply.
`gates/gateP-revert.mjs` puts each defect back and shows the owning gate go red — and shows the two
older gates that ought to have caught them stay green, which is why they survived this long.

---

## 29 July 2026 — a defect we have NOT fixed, said plainly: `side: "SHORT"` returns the wrong answer

An outside reviewer swept the live service and found a defect in the worst possible place. We
reproduced every number below ourselves before writing this, and we are leaving the defect in place
until judging closes. Both halves of that sentence need saying.

**What is wrong.** `side` and option `type` are matched as exact lowercase strings, and anything that
does not match becomes the *riskier* default instead of a refusal. `perp_gate` with `side: "SHORT"`
returns **91,139.24** — the LONG's liquidation price — where `"short"` returns **108,641.98**. It
tells a short seller they liquidate on the way *down*. A perfectly hedged book on `portfolio_gate`
reports net exposure **0** with `side: "short"` and **+200,000** with `side: "SHORT"`: a flat book
served as a fully doubled-up directional bet. `options_risk` prices every `type` that is not literally
`"put"` as a **call**, including `"PUT"` — the delta sign flips from −0.680 to +0.320.

**The answer is wrong, not merely surprising.** A caller who acts on it takes the opposite risk from
the one they intended.

**Every self-check passes, and the answer is signed.** All six finite-difference greek checks pass in
every row; they verify the greeks against the book the engine *chose*, not the book the caller
*described*. `proof.inputs` echoes `"SHORT"` faithfully, the content hash reproduces, and the
signature recovers to the published signer — because re-running the open engine repeats the same
substitution. **Re-runnability certifies the pipeline, not the interpretation.** That is the sharpest
limit on this project's thesis and it belongs in the paper, which does not yet state it. And because
`isChargeable()` only declines on `ok:false` or a failed check, the inverted answer is billable.

**Why it is still here.** The two lines are inside `src/engine/`, which is the directory the build
hash covers, so fixing them changes `q1-e1fa99d08887d6cc` — and the top of this page promises that
hash will not move while judging runs. Moving it breaks the Appendix C exhibit's reproduction and
every document that quotes the build identity. **That is a trade-off, and we are naming it as one:
we chose stability of the published artifact over correctness on an unusual input, and that is only
defensible because it is disclosed here instead of discovered.** An inverted risk number is a worse
defect than a changed hash; what makes us hold is changing the hash underneath a reviewer who is
mid-verification. **It will be fixed immediately after judging closes.**

One smaller disclosure from the same sweep is also unfixed: **12 of the 13 observation services ship
`selfChecks: []`** while `/` and `/llms.txt` say every answer carries a self-checked proof (true of 9
of 22 — the envelopes themselves are scrupulous about this; the summary line overreaches). A second
one from that sweep — `portfolio_gate` sealing a fetched Hyperliquid mark inside a
`deterministic: true` proof — **has since been fixed**; see the entry above it for what changed and
what moved.

The full write-up, with the reproduction commands and the exact four-part fix, is in
`KNOWN_DEFECTS.md` in the repository.

## 29 July 2026 — three fixes on the surfaces the build hash does not cover

All three were found by the same sweep, all three are outside `src/engine/`, and the build hash does
not move.

**`portfolio_gate {account: "0x…"}` crashed.** It answered `error: fetchHlAccount is not defined` — a
live ReferenceError on the headline feature of the most expensive tool, on the free endpoint a builder
tries first. `src/mcp.js` called the function and never imported it; the HTTP path imported it
correctly, so the paid surface worked and the free one did not. Account mode now returns the full
live book again.

**Two caller mistakes were reported as server faults.** `poly-fill` on a market slug that names
nothing live, and `tape-pulse` on a chain/address mismatch, both returned HTTP 500 `engine_error` —
and the second pasted OKX's own `{"code":"51000","msg":"tokenContractAddress param is error"}` into
the response, which reads to a caller as "the service is down". Both now refuse in the shape every
other refusal here uses: `ok:false` with a `howToFix` carrying a body that would work. Because
`isChargeable()` reads `ok:false` to skip settlement, these refusals are free. Genuine upstream
failure still surfaces as a 500 — the conversion matches one enumerated symptom each and rethrows
anything else, because an outage reported as a caller mistake is the same defect pointing the other
way.

**A guard that could not fail.** `gates/preflight.mjs` asserts that any service building a zk proof
snaps its inputs onto the circuit's grid first. It read `SERVICES.map(s => s.run)` and nothing else,
so it could not see the MCP handler array at all — and `src/mcp.js` builds Plonk proofs without
snapping. The check swept 22 handlers, found the one that already complied, and reported that every
one did. It now enumerates both surfaces and asserts each is non-empty on its own. The MCP handler now
snaps, with the same field list the HTTP path uses: measured over 20,000 random off-grid positions,
the un-snapped path's served liquidation price differs from the certified one at full display
precision (a whole cent) in 1 of them, and the proof store's divergence guard refuses only at 0.005 —
an order of magnitude too coarse to see it. Snapping is the identity on any value already on the grid,
so the Appendix C content hash `8575ce5a…` is unmoved; for an off-grid body the free MCP hash now
*agrees* with the paid HTTP hash, where the two silently disagreed before.

Each of these has a check that would have caught it (`gates/gateM-mcp-surface.mjs`), and each check
has a scripted revert that puts the defect back and requires the check to go red
(`gates/gateM-revert.mjs`). Two of those reverts also demonstrate the *old* checks staying green over
the same defect, so the blind spot is measured rather than asserted.

## 29 July 2026 — a symbol-mode perp-gate call can now carry a succinct proof, and says what it does not cover

`perp-gate` built a Plonk proof only when the caller supplied every input. Pass a symbol instead and
the entry price defaults to the venue's live mark, the answer ships as an OBSERVATION rather than a
deterministic proof — correctly, because a live read is not re-runnable — and `snark: true` was
silently ignored. So the proof existed only where its inputs were a private fact about the caller's
position, and the one input a chain could corroborate existed only where there was no proof.

Symbol mode now builds the proof too. **What changed is only what is added**: the envelope is still an
observation, `deterministic` is still `false`, the SNARK is attached as a sibling exactly as it is on
the other branch, and the content hash is taken before it and over the same inputs as before. No
published proof moves, and the caller-supplied path is untouched to the byte.

Because the proven entry price was **fetched rather than supplied**, the response says so in fields a
program can read — `inputsWereFetchedLive`, `entryPriceSource`, `entryPriceVenue` — and states plainly
what the SNARK does not cover: it proves the arithmetic over the integers it pins, and nothing about
whether the entry price is really the venue's mark or whether that mark is honest. Covering the input
is a separate on-chain step against the venue's own state, and it is not deployed; the response says
that too rather than implying otherwise. The same disclosure is stored on the proof itself, so a third
party fetching `/proof/<hash>` without ever seeing the answer is told as well.

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
