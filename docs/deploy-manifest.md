# What is waiting for a deploy

Everything built since the deadline is repo-only. The live service has not been touched since 28 July
2026 and still serves the submitted build. This is the list of what a deploy would actually change,
what it would not, and what to check afterwards.

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

Six checks and sixteen. Both proven able to fail by scripted revert: stub the router and 2 of 6 go
red; stub the repair layer and 6 of 16 go red.

**The MCP gap is closed**, and it was worth closing first. The free endpoint is where a caller
explores, so it is where a caller is most likely to be wrong, and it was the one getting no help.

## Group 2 — durability. Safe, but needs a decision first.

| file | what changes |
|---|---|
| `src/util/proofStore.js` (new) | a finished proof survives a redeploy and a second replica |
| `src/app.js` | `/build` reports `proofStorage`; the 404 body stops promising "a redeploy clears them" when it no longer does |

**Off unless `QUIVER_PROOF_DIR` is set.** Deploying without setting it changes nothing at all, which
makes it the safest thing on this list. Turning it on needs a persistent volume on Railway, which is a
configuration decision rather than a code one. `npm run gate:a` and `npm run gate:a-revert`.

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
