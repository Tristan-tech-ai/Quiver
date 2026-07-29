# What is waiting for a deploy

> **SUPERSEDED, 29 July 2026.** This document was written while the plan was to ship nothing, and its
> opening said the live service had not been touched since 28 July. **Three deploys have since gone
> out**, and the live service now carries everything listed below.
>
> | # | when | darkness | how that is known |
> |---|---|---|---|
> | 1 | **28 Jul 17:20:59 UTC** (01:20 WITA 29 Jul) | **11 seconds** | `verification-log.md` §"The deploy, for the record"; commit `468c701`, *"deployed at 01:20 WITA, dark for 11 seconds"*; corroborated from a separate workstream by `148f8fb` |
> | 2 | **29 Jul 00:30:41 UTC** | **0 seconds** | `verification-log.md` §V10; commit `af31f77`, *"second deploy, live at 00:30:41 UTC, and it never went dark at all"*, **committed 00:32:25 UTC — 1m44s after the stated go-live** |
> | 3 | **29 Jul ~09:30 UTC** | **never measured** | no commit, no log section, no watchdog output; bracketed by a measurement at 08:50 UTC showing live *behind* the tree and one after it showing live byte-identical |
>
> **An earlier version of this banner said "two deploys … 11 seconds on the first and 0 on the second",
> and both figures were attached to the wrong events.** That sentence was copied from the verification
> log, where "first" and "second" meant deploys 1 and 2 above. Re-listing the deploys as *the two on
> 29 July* silently re-bound those words: 11 seconds moved onto a deploy that had none, and 0 seconds
> onto a deploy nobody timed. Nothing could catch it — the count and the darkness of a past deploy are
> read by no checker, and no deploy log is committed.
>
> **What is settled and what is not.** The count, the order and the times are settled by commit
> timestamps, which are evidence independent of anyone's recollection. The 11 and 0 second figures are
> contemporaneous eyewitness records, not re-derivable measurements: `gates/watchdog.mjs` prints
> darkness to stdout and writes no file, so the terminal that held both numbers is gone. Deploy 3's
> darkness is not merely unrecorded but unknown, and this document does not assign it a number.
> `claim-repair.md` proposes the committed deploy log that would end this.
>
> What still stands is the reasoning: what a deploy changes, what it does not, and what to check after.
> That is why the list below is kept rather than rewritten. Read it as the record of what shipped.

Everything built since the deadline was repo-only while this was written. This is the list of what a
deploy would actually change, what it would not, and what to check afterwards.

**Nothing here changes the published `codeHash`.** Every file touched is under `src/util/`, `src/app.js`
or `src/mcp.js`; the hash walks `src/engine/` only, and `q1-e1fa99d08887d6cc` is unchanged locally and
live. So a deploy does **not** trigger a re-review and does not invalidate a single published proof.

---

## The decision, stated plainly

OKX said it in the group: during judging they cannot go back and forth resolving errors, and if the
ASP breaks while being scored, it comes back empty. Our redeploys take up to three minutes.

Two risks, pointing opposite ways:

| deploy | don't deploy |
|---|---|
| ~3 minutes where a judge could hit a dark container | a judging agent mis-routes exactly as MantaRay did and Quiver cannot say a word |
| new code paths that have never run in production | the two half-star reviews stay the only evidence of how Quiver behaves when a caller is wrong |

The buyer defence is the only item here that addresses a risk **specific to being judged by an agent**.
Everything else is an improvement that can wait.

---

## Group 1 — buyer defence. The reason to consider deploying at all.

| file | what changes on the wire |
|---|---|
| `src/util/routing.js` (new) | refusals name the service that fits and give the exact retry; a successful call that looks mis-aimed carries `routingNotice` |
| `src/util/repair.js` (new) | wrapped, stringified, mis-cased and aliased bodies are normalised and every normalisation is reported as `inputRepairs`; anything ambiguous is refused with `howToFix` |
| `src/app.js` | wires both into the paid path and the two other refusal sites |
| `src/mcp.js` | the same, on the free MCP path, plus `didYouMean` on an unknown tool name |

**New response fields, all additive, all siblings of `result`/`proof`:** `routingNotice`,
`inputRepairs`, `howToFix`. The content hash covers `{engine, codeHash, inputs, result}` and none of
these is inside it, so published proofs keep reproducing byte-for-byte.

```bash
npm run gate:r
npm run gate:buyer
```

Fifteen checks and sixteen, both proven able to fail by scripted revert — `npm run gate:r-revert` and
`npm run gate:buyer-revert`. Measured, by the reverts themselves rather than asserted here:

| gate | checks | reverts | distinct checks turned red |
|---|---|---|---|
| `gate:r` | 15 | 4 | **7** |
| `gate:buyer` | 16 | 6 | **8** |

**This sentence used to say both gates were proven able to fail, and it was false for half of it.**
`gate:buyer` had no revert of any kind until 29 July 2026 — only `gates/gateBuyer-mistakes.mjs` and a
single alias. Its sixteen checks had never been shown able to fail once, on the gate whose subject is
the failure this project exists for: a reviewer's agent that sends a slightly wrong body and does not
understand the answer. The sentence also miscounted `gate:r` as six checks when it has fifteen.

That mattered more than a wrong number, because **this gate has already let a defect through**.
`gates/gateP-paid-teaching.mjs:14` records it: every check of the teaching layer called `repairBody`
and `correctedExample` directly, or went through `/mcp`, and not one ever put a `PAYMENT-SIGNATURE`
header on a request — so a paying caller got the prose of a refusal and none of the retry, while the
free caller got the corrected body. A gate that cannot fail cannot tell you which half of the surface
it is standing on.

`gateBuyer-revert.mjs` puts six defects back into `src/util/repair.js` and `src/util/routing.js` one
at a time — a refusal that hands back plausible defaults instead of visible placeholders; the historical
empty-example bug; `"64,000"` and `"64k"` parsed instead of refused; an alias overwriting the caller's
own value; unwrapping firing on a wrapper key that is not alone; and the mis-route signpost losing the
branch `routing.js` calls *"the case that actually cost two stars"*. Each must turn gateBuyer red
**naming** the defect, and green again on restore. **Eight of the sixteen checks are covered; the other
eight are named in the output as unreverted** — not proven sound, just not yet shown able to fail,
which is the state the whole gate was in before.

Five of the six defects are caught by gateBuyer alone; `gate:r` also catches the signpost one.

**The MCP gap is closed**, and it was worth closing first. The free endpoint is where a caller
explores, so it is where a caller is most likely to be wrong, and it was the one getting no help.

## Group 2 — durability. Safe, but needs a decision first.

| file | what changes |
|---|---|
| `src/util/proofStore.js` (new) | a finished proof survives a redeploy and a second replica |
| `src/app.js` | `/build` reports `proofStorage`; the 404 body stops promising "a redeploy clears them" when it no longer does |
| `src/server.js` | drains in-flight proof writes on SIGTERM, bounded at five seconds |

**Off unless `QUIVER_PROOF_S3_BUCKET` or `QUIVER_PROOF_DIR` is set.** Deploying without setting either
changes nothing at all, which makes it the safest thing on this list. Turning it on is entirely
configuration: a bucket and a role, no code change and no endpoint change.

The Railway-volume route was measured and dropped. Railway's own reference says "Replicas cannot be
used with volumes", one volume per service, region-pinned — so a volume delivers the redeploy half of
the Phase A claim and silently fails the replica half, which is the worse failure because the endpoint
would go on advertising both. The store therefore has an S3 backend beside the filesystem one, chosen
by environment; see `PHASE_A_S3.md` for what is proven against an emulator and MinIO and what remains
unproven without real AWS credentials. `npm run gate:a` (11 cases, both backends) and
`npm run gate:a-revert` (five scripted reverts).

## Group 3 — not for deploy

The five circuits and everything under `zk/`. No endpoint serves the four new ones and no verifier for
them is deployed. Shipping them means new endpoints and new on-chain contracts, which is a far larger
change and has no reason to happen during judging.

---

## The seatbelt

```bash
npm run preflight
npm run watchdog
```

`preflight` checks eleven things against the **live** service and exits non-zero on any failure.

The one that matters most is not the codeHash. It is this: **repair rewrites the request body, the
echoed inputs come from that body, and the contentHash is taken over the echoed inputs.** If a request
that already worked came out repaired, its contentHash would move and a published proof would stop
reproducing — the single failure this whole project exists to make impossible. So preflight sweeps
every service and every optional field of each, and requires an already-valid body to come back
byte-identical.

That check earned its place before it ever ran in anger. The alias table mapped `symbol` to `currency`
without first asking whether `symbol` is a property the service declares in its own right, and three
services declare exactly that. They did not misfire only because the canonical name happens to be
absent there, which is luck rather than design. Fixed, and the sweep is what catches the next one.

Preflight also **refuses to pass while the changelog has no new entry**, because an undocumented
behaviour change during judging is exactly what the promise at `/changelog` says will not happen.

`watchdog` must be started **before** the deploy, so it records what healthy looked like beforehand. It
names three transitions — dark, answering again, new build live — and alarms at five minutes of
continuous darkness. It also watches the quieter failure: a container that answers while serving the
wrong service count, the wrong MCP tool count, or a moved codeHash. A regression that responds is
worse than one that does not, because nothing alerts on it.

## Order, midnight

1. `npm run preflight` — expect PREFLIGHT PASSED.
2. `npm test` (386 / 381 / 0) and `node tools/docs-consistency.mjs` (CONSISTENT).
3. `npm run gate:r && npm run gate:buyer && npm run gate:a` — expect 6, 16, 5.
4. `npm run watchdog` in a **second shell**. Wait for it to print its baseline line.
5. `railway up --service quiver --detach` from `hackathon/veritape/`.
6. Watch the first shell. The watchdog exits 0 by itself when the new build is live and healthy.

## What the watchdog cannot see, and you should check by hand

```bash
curl -s .../changelog | head -20
for i in 1 2 3 4 5 6 7; do curl -s .../paper/$i | head -1; done
```

The changelog entry and the paper parts are static assets. The watchdog checks that the service works;
it does not read what the service says. A judge reads both.

## Rollback

`railway rollback`. Nothing here writes to disk, nothing migrates, no on-chain state is touched, so a
rollback is complete and leaves no residue: the previous container serves the submitted build exactly
as it does now.
