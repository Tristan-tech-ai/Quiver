# What is waiting for a deploy

Everything built since the deadline is repo-only. The live service has not been touched since 28 July
2026 and still serves the submitted build. This is the list of what a deploy would actually change,
what it would not, and what to check afterwards.

**Nothing here changes the published `codeHash`.** Every file touched is under `src/util/` or
`src/app.js`; the hash walks `src/engine/` only, and `q1-e1fa99d08887d6cc` is unchanged locally and
live. So a deploy does **not** trigger a re-review and does not invalidate a single published proof.

---

## The decision, stated plainly

OKX said it in the group: during judging they cannot go back and forth resolving errors, and if the
ASP breaks while being scored, it comes back empty. Our redeploys take up to three minutes before the
new container serves.

So there are two risks and they point in opposite directions.

| deploy | don't deploy |
|---|---|
| ~3 minutes where a judge could hit a cold or missing container | a judging agent mis-routes exactly as MantaRay did and Quiver cannot say a word |
| new code paths that have never run in production | the two half-star reviews stay the only evidence of how Quiver behaves when a caller is wrong |
| the changelog and the repo diverge from live until it lands | every buyer-mistake fix stays theoretical |

The mis-routing defence is the only item on this list that addresses a risk **specific to being
judged by an agent**. Everything else is an improvement that can wait.

---

## Group 1 — buyer defence. The reason to consider deploying at all.

| file | what changes on the wire |
|---|---|
| `src/util/routing.js` (new) | refusals name the service that fits and give the exact retry; a successful call that looks mis-aimed carries `routingNotice` |
| `src/util/repair.js` (new) | wrapped, stringified, mis-cased and aliased bodies are normalised and the normalisation is reported as `inputRepairs`; anything ambiguous is refused with `howToFix` |
| `src/app.js` | wires both into the paid path and the two other refusal sites |

**New response fields, all additive and all siblings of `result`/`proof`:** `routingNotice`,
`inputRepairs`, and on a 400, `detail.howToFix`. The content hash covers `{engine, codeHash, inputs,
result}` and none of these is inside it, so published proofs keep reproducing byte-for-byte.

```bash
npm run gate:r        # 6 checks — replays both half-star reviews
npm run gate:buyer    # 16 checks — the buyer-mistake scenarios
```

Both proven able to fail by scripted revert: stub the detector and 2 of 6 go red; stub the repair
layer and 6 of 16 go red.

**Known gap:** the MCP path (`src/mcp.js`) goes through `handleRpc` and does **not** get these. Free
MCP callers still get the old behaviour. Worth closing before or soon after this ships.

## Group 2 — durability. Safe, but needs a decision first.

| file | what changes |
|---|---|
| `src/util/proofStore.js` (new) | proofs survive a redeploy and a second replica |
| `src/app.js` | `/build` reports `proofStorage`; the 404 body stops saying "a redeploy clears them" when it no longer does |

**Off unless `QUIVER_PROOF_DIR` is set.** Deploying without setting it changes nothing at all, which
makes it the safest thing on this list. Turning it on needs a persistent volume attached on Railway,
and that is a configuration decision, not a code one.

```bash
npm run gate:a
npm run gate:a-revert
```

## Group 3 — not for deploy

The five circuits (`kelly`, `concentration`, `divergence`, `constantproduct`, plus `liquidation`
already on chain) and everything under `zk/`. No endpoint serves the four new ones and no verifier for
them is deployed. Shipping them means new endpoints and new on-chain contracts, which is a much larger
change than anything above and has no reason to happen during judging.

---

## Order, if the answer is yes

1. `cd hackathon/veritape && npm test` — expect 386 / 381 pass / 0 fail.
2. `node tools/docs-consistency.mjs` — expect CONSISTENT.
3. `npm run gate:r && npm run gate:buyer && npm run gate:a` — expect 6, 16, 5.
4. Confirm the hash has not moved: local `q1-e1fa99d08887d6cc` against `curl .../build`.
5. `railway up --service quiver --detach` from `hackathon/veritape/`.
6. Wait for the new container. **Verify by a content marker, not by `/build`'s codeHash**, which is
   deliberately unchanged and therefore proves nothing about which container answered. The marker is
   `proofStorage` in `/build`: absent means the old code is still serving.
7. Re-check the seven paper parts are still byte-identical to the repo. They are static assets and
   should not move, and if they do something is wrong that has nothing to do with this change.
8. Add a dated entry to `assets/changelog.md`. It is served at `/changelog` and a judge who notices
   behaviour the submission did not describe should be able to see when and why it changed. **The
   changelog is the one file that must be edited in the same deploy**, not after: an undocumented
   behaviour change during judging is exactly what the promise at `/changelog` says will not happen.

## What to check afterwards

```bash
curl -s .../build | jq .proofStorage                 # the marker: present = new code is live
curl -s -X POST .../api/options-desk -d '{"protocol":"aave"}' -H 'content-type: application/json'
```

The second should now come back as a 402 (payment first, as always) — the routing notice lives behind
payment because it is attached to the answer. To see the refusal path without paying, the MCP route is
free, which is also the route that does not have this yet. That asymmetry is the known gap above and
is worth writing down rather than discovering later.

## Rollback

`railway rollback` to the previous deployment. Nothing here writes to disk, nothing migrates, and no
on-chain state is touched, so a rollback is complete: the previous container serves the submitted
build with no residue.
