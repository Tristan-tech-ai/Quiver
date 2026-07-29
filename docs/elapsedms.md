# The paper invited a check that failed

**Date:** 29 July 2026 · **Build:** `q1-e1fa99d08887d6cc` (unchanged — `src/engine/` is untouched and
diffed byte for byte) · **Status:** fixed in the repository, **not deployed**, declared in
`gates/paper-pending-deploy.json`.

Two sentences in the served paper were false. One named a field and told a reader to hold the service
to account with it; the field did not exist. The other appeared in §8, the limitations list, and
claimed a disclosure that ships on fewer than half the catalogue. One was closed by building the thing
the paper promised. The other was closed by correcting the paper, and the reason for the difference is
the point of this document.

---

## 1. Both claims reproduced before anything was touched

### 1.1 `elapsedMs`

`assets/whitepaper.part1.md:239`, from `assets/whitepaper.html`, §2.3:

> Every response carries an `elapsedMs` field so a caller can hold the service to its own timing.

Measured against the live endpoint:

```
curl -s https://quiver-production-c3a8.up.railway.app/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"perp_gate",
       "arguments":{"side":"LONG","entryPrice":100000,"size":1,"leverage":10,
                    "maxLeverage":40,"markPrice":100000}}}'
```

The response is 7,406 bytes and contains no occurrence of the string `elapsedMs`, at any depth. Its
payload keys are `ok, inputs, liquidationPrice, moveToLiquidationPct, positionStatus,
effectiveLeverage, initialMarginRatePct, maintenanceMarginRatePct, marginTier, funding, model, checks,
proof, inputRepairs`.

Swept locally across **every service and every input form** in `gates/routing-fixtures.mjs` — 31 HTTP
forms, 15 MCP forms — before any change:

| surface | forms carrying `elapsedMs` |
| --- | --- |
| HTTP (`SERVICES[].run`) | **8 of 31** |
| free MCP (`handleRpc`) | **0 of 15** |

By service rather than by form: **7 of 22** services carried it on at least one input form
(`chart-press`, `options-desk`, `calldata-x`, `protocol-pulse`, `macro-sentry`, `updown-pulse`,
`loop-digest`), and **15 of 22 carried none on any form**, including all nine deterministic risk
engines — the services a caller most wants to time. Every occurrence in the tree was inside
`src/engine/`; the count in `src/app.js`, `src/mcp.js` and `src/services.js` was zero in each.

**Reproduced. The claim was false as stated.**

### 1.2 The not-advice disclosure

`assets/whitepaper.part4.md:270` (§8, structural limitation 9), mirrored at `part1.md:298` (§3.5) and
`docs/limitations.md:102`:

> Every output that touches a decision carries a not-advice disclosure, and the short-window up/down
> service refuses to output a directional edge at all.

Measured two ways. The live `perp_gate` response above contains no occurrence of the word *advice*.
And per service, reading only lines that are emitted rather than commented:

| | count | services |
| --- | --- | --- |
| observation services carrying a disclosure | **10 of 13** | all but `chart-press`, `lp-desk`, `loop-digest` |
| deterministic risk engines carrying one | **0 of 9** | none of `perp-gate`, `portfolio-gate`, `size-gate`, `exec-verify`, `options-risk`, `lp-risk`, `treasury-risk`, `risk-attest`, `event-vol` |

Across the whole 15-form MCP sweep — which is exactly the nine deterministic engines — the string
*advice* appears **zero** times.

**Reproduced.** The second clause is true; the first is false, and it is false precisely on the
services where a disclosure would matter most.

---

## 2. Where the field went, and why that was the hard part

`elapsedMs` is a new field in **every** response, and the content hash is taken over the echoed inputs
and the result. Getting the placement wrong breaks something worse than a missing field.

`src/engine/proof.js` computes

```
contentHash = sha256(canonical({ engine, codeHash, [observedAtUtc,] inputs, result }))
```

where `result` is the engine's return value, and then returns `{ ...result, proof: { … } }`. The
envelope is attached **after** the hash and is never in its preimage. Every response then publishes
its own recipe, in `proof.verifyContentHash`:

> Recompute from the response you received: `contentHash = sha256(canonical({engine, codeHash, inputs,
> result}))` where `result` = **this response WITHOUT its `proof` key** … A mismatch means the response
> was altered.

So a new key at the **top level** would sit *inside* what the caller hashes and *outside* what the
service hashed. The stored hash would not move — every pin and every test would stay green — and every
published proof would silently stop verifying, from an envelope whose own text says a mismatch means
tampering. §11.5 of the paper records finding exactly this defect twice, in a different field. The
worked exhibit of Appendix C, which the paper invites a reader to re-derive offline, is in that set.

**The field therefore goes inside the `proof` / `observation` block**, which is where `version`,
`codeHash`, `codeHashScope`, `observedAtUtc` and `attestation` already live, for the same reason: a
timing is provenance of the call, not part of the computation. Inside the envelope the caller's own
recipe strips it, so it is *provably* outside the preimage rather than accidentally outside it.

A response carrying no envelope at all — a `callerMistake` refusal, which computes nothing — has no
preimage to disturb, so the field goes at its top level, the only non-committed place such a response
has. An engine that already sets its own top-level `elapsedMs` is never overwritten: that number is
inside its own content hash.

### The two wrappers

Four call sites reach an engine. Three — the paid `/api/*` route and both gated diag testers — go
through `SERVICES[].run`, so one wrapper at the foot of `src/services.js` covers them, the same shape
as the enum guard already there. The fourth is `handleRpc` in `src/mcp.js`, which shares neither the
validators nor the service objects and carries the stamp explicitly. `src/util/timing.js` holds the
single definition both use, and the gate reads the field through the same locator so a checker cannot
look somewhere the server never writes.

The wrapper is **sync-preserving**: several services are declared synchronously and
`test/buyerFixes.test.mjs:29` asserts on `svc.run({hours:72})` without awaiting. Forcing everything
through `async` would have turned that assertion into one against a Promise — a behaviour change
smuggled in under a timing field.

---

## 3. Proof that nothing moved

Measured by running every fixture form through both surfaces before and after.

| | before | after |
| --- | --- | --- |
| HTTP forms carrying `elapsedMs` | 8 / 31 | **31 / 31** |
| MCP forms carrying `elapsedMs` | 0 / 15 | **15 / 15** |
| deterministic content hashes identical | — | **24 of 24** |
| content hashes moved | — | **0** |

The 24 are the twelve deterministic proof forms measured on each of the two surfaces; the paid and
free answers agree hash-for-hash, which is itself the paper's claim that the free answer *is* the paid
answer for these nine engines.

Observation hashes commit an `observedAtUtc` and therefore differ between any two calls; they cannot
be pinned, and are covered instead by the recipe check below.

### Appendix C

```
HTTP contentHash 8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960  == Appendix C
MCP  contentHash 8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960  == Appendix C
HTTP proof.elapsedMs = 4 | MCP proof.elapsedMs = 0
top-level elapsedMs present? false / false
HTTP recipe reproduces: YES  8575ce5ae5bfae9c
MCP  recipe reproduces: YES  8575ce5ae5bfae9c
```

The last two lines are the ones that matter: recomputing the hash **exactly as the published recipe
instructs** — the response with its `proof` key removed — reproduces `8575ce5a…` byte for byte after
the change. The field is outside the preimage *and* outside what a verifier following the paper hashes.

### The advertised surface

MCP `tools/list` was compared byte for byte against the live service: **30,041 bytes on both, identical**,
nine tools on both. No `inputSchema` changed. `outputSchema` did not need to change either — every
schema in `src/mcp.js` is `additionalProperties: true`, including `PROOF_SCHEMA`, so
`structuredContent` still validates. **Nothing on the OKX registry surface moves**: service count,
endpoints, agent identity and `codeHash` are all unchanged, and `/build` still reads
`q1-e1fa99d08887d6cc` locally and live.

`src/engine/` was diffed in full against the committed tree: **no differences**.

---

## 4. The gate, and the proof that it can fail

`gates/gateL-elapsed-timing.mjs` (`npm run gate:l`) sweeps all 22 services and every input form on
both surfaces — 46 response forms — rather than sampling. Eight checks:

```
    22 services, 46 response forms across both surfaces
    31/31 http responses carry elapsedMs
    15/15 mcp responses carry elapsedMs
    45 enveloped answers checked
    24 pinned deterministic content hashes re-measured on both surfaces
    42 envelope(s) reproduce the recipe verbatim
✔ 8 pass, 0 fail
```

The fixture set is asserted as an **equality** against `SERVICES`, so a service added tomorrow with no
fixture is a gate failure rather than a silent hole. The pin count is asserted too: a pin list that
stopped matching any response would make the hash check unfailable.

### `npm run gate:l-revert`

```
GATE L REVERT — proving the elapsed-timing gate can fail

  baseline gate L: 8 pass, 0 fail

  revert: REMOVE — timedRun stops stamping, so no response carries elapsedMs (the code as it shipped)
    gate L against reverted code : 4 pass, 4 fail
      RED: ★ every response on the paid HTTP surface carries elapsedMs
      RED: ★ every response on the free MCP surface carries elapsedMs
      RED: ★ the field is in the provenance block, never bolted onto the top level of an enveloped answer
      RED: ★ the Appendix C exhibit still reproduces on both surfaces
    names the services it is about : 4/4 [perp-gate, size-gate, perp_gate, event_vol]
    companion check stays green    : YES (17 pass, 0 fail)
      because gate M asserts each answer carries an envelope with a contentHash, and never looks at what is inside it

  revert: TOPLEVEL — the stamp lands at the top level, so every published proof stops verifying
    gate L against reverted code : 3 pass, 5 fail
      RED: ★ every response on the paid HTTP surface carries elapsedMs
      RED: ★ every response on the free MCP surface carries elapsedMs
      RED: ★ the field is in the provenance block, never bolted onto the top level of an enveloped answer
      RED: ★ the Appendix C exhibit still reproduces on both surfaces
      RED: ★ the published recipe still reproduces, and elapsedMs is never a key that has to be removed
    names the services it is about : 1/1 [caused by a top-level elapsedMs]
    companion check stays green    : YES (3 pass, 5 fail)
      because the stored hash genuinely does not move — only the instruction the caller is told to follow breaks

  restored gate L: 8 pass, 0 fail

RESULT
  [OK] REMOVE — timedRun stops stamping, so no response carries elapsedMs (the code as it shipped)
  [OK] TOPLEVEL — the stamp lands at the top level, so every published proof stops verifying
  [OK] the file is restored and gate L is green again
```

Two things in that output are worth more than the reds.

**Under REMOVE, `gate:m` stays green.** Gate M calls every MCP tool and asserts each answer carries a
verifiability envelope with a `contentHash`. It never looks at what is *in* the envelope. That is how
fifteen of twenty-two services could carry no timing at all with every check in the repository green.

**Under TOPLEVEL, gate L's own pinned-hash check stays green.** The stored hashes genuinely do not
move; only the instruction the caller is told to follow breaks. The obvious check — pin the hashes —
cannot see the defect that actually reaches a reader. Only the check that follows the caller's own
published recipe can.

---

## 5. The not-advice claim was corrected, not implemented

Both were universal quantifiers over an unenumerated set. They got opposite treatments, and the
difference is not taste.

**A timing is a measurement the machinery already takes.** It has no editorial content, cannot be
wrong for a particular service, and has a home — the provenance block — that is provably outside every
content hash. Adding it costs one number per response.

**A disclosure is an editorial assertion, per service, and it has no such home.**

1. **It would move published hashes.** The three engines that carry a disclosure today carry it inside
   `result`, which is inside the content-hash preimage. Adding it there for the other nineteen moves
   every hash those services publish — and for the nine deterministic engines that means all 24 pinned
   hashes and the Appendix C exhibit `8575ce5a…`. A published proof that stops reproducing is worse
   than a missing sentence.
2. **Putting it outside the preimage would be safe and wrong.** The provenance block is about who
   computed what and how to re-derive it. A legal disclaimer is not provenance, and burying it beside
   `codeHash` would satisfy a grep rather than a reader.
3. **A wrapper is a far larger blast radius than one field.** One number is identical for all 22
   services. A disclosure is not: it would need wording appropriate to a liquidation price, a Merkle
   root, and a Kelly fraction, and it would land on refusals whose own text already says *nothing was
   computed and you were not charged*.
4. **§8 is the limitations list.** It is the section whose entire argument is that the authors count
   carefully against themselves. The honest repair there is an accurate count, not a field added so a
   sentence technically passes.

So §3.5, §8 limitation 9 and `docs/limitations.md` now state the measured numbers — ten of thirteen
observation services, none of the nine risk engines — and each records that an earlier version claimed
otherwise.

---

## 6. Things found on the way that this work did **not** fix

### 6.1 The published recipe already fails on the live service

Measured on the live endpoint, on the `perp_gate` response quoted in §1.1:

```
published contentHash                     : 3dbb480d100df158f2f07cd46e29c58a0f93f6d3722ec7510a6a92ead4ef8a7b
recipe verbatim (response minus `proof`)  : 968b12e28dd27765647b69e74193b861ca5a6910d9b5accbc75b47852b356b6a
minus `inputRepairs` as well              : 3dbb480d100df158f2f07cd46e29c58a0f93f6d3722ec7510a6a92ead4ef8a7b
```

`inputRepairs` is attached at the **top level** after the envelope is sealed. The stored hash is
correct and the recipe as written does not reproduce it. The comment at that call site says the
sibling is attached "so the content hash covers exactly what it covered before and every published
proof keeps reproducing" — true of the stored hash, false of the published instruction, which is the
half a caller actually runs.

The same shape appears locally on `howToFix`: gate L reports it on `portfolio_gate#1`,
`risk_attest#0` and `risk_attest#1`, and passes them as a **named note** rather than a failure,
because they are pre-existing and in a different field. Gate L is written so that this tolerance
cannot cover `elapsedMs`: the sibling allow-list does not contain it, and a top-level stamp is
reported as *"caused by a top-level elapsedMs"*.

**This is exactly the defect the placement decision above was made to avoid, already shipped in another
field.** It is Tristan's call, not this work's: fixing it means either moving those siblings inside the
envelope or amending the recipe on every response, and both change what a caller reads.

### 6.2 A wrapper blinded a guard, and preflight caught it

Replacing `SERVICES[].run` with a closure made all 22 HTTP handlers stringify to the wrapper, and
`gates/preflight.mjs` decides which handlers build a zk proof by reading handler source. Its
proof-emitting set collapsed from `[http:perp-gate, mcp:perp_gate]` to `[mcp:perp_gate]` and its own
check *"the proof-emitting set is the one that has been checked"* went red. The grid guard had gone
blind to 22 handlers while still reporting a pass.

Fixed by publishing the original handler as `s.run.unwrapped` and having preflight read **both** bodies
rather than swapping one for the other — so a future wrapper that does not expose its inner function
still collapses the set and still goes red. Preflight now reports
`http:perp-gate, mcp:perp_gate snap; the other 29 build no proof`, which is what it read before.

### 6.3 A pre-existing preflight failure, unrelated to this work

Preflight blocked on `part 7 names the changelog entry "…a fifth site said the same thing in a verb",
which is ALREADY live`. Part 7 is byte-identical to live and nothing here touched it; the live
changelog does contain that entry. `gates/paper-pending-deploy.json` documented this state as
"harmlessly stale", which is wrong about its own checker's code — the check blocks on it. The shipped
row was removed and the file's note corrected: a shipped change is not pending, and the pinned hash of
a part that already matches live is evidence of nothing.

### 6.4 `gate:x` is red on a document this work never opened

`npm run gate:x` reports 7 pass, 1 fail. Its over-claim rule fires twice, on `pdf-rerender.md:142` and
its mirror `PDF_RERENDER.md:142`, for the unqualified suite-wide pass phrase while five of 386 tests do
not run in the default environment.

**Pre-existing and outside this change.** The line is committed at `HEAD`, `git status` reports the
file unmodified, and nothing here touched either mirror. What the line actually does is *reproduce the
old Table 2 caption* inside a sentence contrasting the old wording with the corrected one, so the
phrase appears there as evidence rather than as an assertion — and the rule's `isQuoted` guard does not
recognise the typographic quotation marks it is written with.

That diagnosis was confirmed the expensive way: the first draft of **this** section quoted the same
sentence to illustrate it, and gate X immediately reported four over-claims instead of two, at
`elapsedms.md` and `ELAPSEDMS.md`. The rule cannot tell a claim from a citation of one. This section is
therefore written without reproducing the phrase, which restores the count to two.

Left alone deliberately: `pdf-rerender.md` is one of the findings documents another agent is working
in, and a commit touching it (`cd55bcc`) landed in `Quiver` during this session. Either the rule should
treat a typographically-quoted span as quoted — which the evidence above argues for, since it now has
two independent false positives — or the sentence should name the caption without reproducing it.
Both are that agent's call, not this one's.

### 6.5 The working tree is shared with running revert scripts

During this work `src/util/repair.js` was observed carrying a `// SCRIPTED REVERT` marker and
differing from the committed tree, with `src/util/repair.js.revert-backup` and
`src/util/routing.js.revert-backup` present. Re-checked minutes later, both files matched the
committed tree and the markers were gone: another agent's revert was mid-run, working as designed.
Recorded because **any measurement taken in this tree can be taken against a transiently reverted
file**, and none of those files is part of this change.

---

## 7. What a reader of this document should watch

`assets/whitepaper.part4.md` now has **85 bytes** of headroom against the 55 kB packing budget, down
from 173. The part count is still 7, `assets/whitepaper.parts.json` is byte-identical, and
`npm run gate:y` is green on all eight checks — but the next prose added to §6, §7 or §8 re-cuts the
document and moves *§8 Limitations and Honest Disclosures* into part 5 while the count stays at seven.
Run `gate:y` before and after any edit there.

---

## 8. Verification run

| | result |
| --- | --- |
| `npm test` | **386 tests**, 381 pass, 0 fail, 5 skipped (unchanged count; no test added) |
| `npm run gate:l` | 8 pass, 0 fail |
| `npm run gate:l-revert` | all three lines OK, restored green |
| `npm run gate:x` | **7 pass, 1 fail — pre-existing and unrelated, see 6.4** |
| `npm run gate:y` | 8 pass, 0 fail — 7 parts, mapping unchanged |
| `npm run docs:check` | CONSISTENT — 209 documents |
| `node gates/preflight.mjs` | **22 of 22**, PREFLIGHT PASSED |
| `src/engine/` diff | no differences |
| MCP `tools/list` vs live | byte-identical, 30,041 B |

**Not deployed.** `railway up` was not run. The repository is ahead of live on parts 1 and 4 of the
paper, declared by content hash in `gates/paper-pending-deploy.json` against an unpublished changelog
entry, which is what preflight check 5 requires.
