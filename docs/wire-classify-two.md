# The two services that could not be classified, and the portfolio-gate contradiction

A sweep classified all 22 services by calling each with its `gates/routing-fixtures.mjs` fixture and
asking whether the answer carried `proof` or `observation`. It got 20. `chart-press` threw; `poly-fill`
returned neither. This is what each of those actually was, and what happened when the measurement was
repaired.

**The short version.** Neither was a fact about the service. One was the harness, one was a third
envelope the sweep had no name for, and the third finding — the one that was not on the list — is that
`portfolio-gate` was misclassified in the *other* direction: it serves a deterministic proof envelope
whenever the caller supplies a complete book, and the fixture does not.

Nothing was wired. `src/engine/` is byte-identical to the mirror and the engine build id is still
`q1-e1fa99d08887d6cc`.

---

## 1. `chart-press` — the harness, not the handler

**Reproduced.** Called with the ctx the HTTP surface passes, both fixture forms answer:

| form | body | result |
|---|---|---|
| 0 | `{symbol:'BTC-USDT', interval:'1H'}` | OBSERVATION, a PNG, `source: okx-cex` |
| 1 | `{chain:'ethereum', address:'0x1111…1111', interval:'15m'}` | OBSERVATION, `verdict: DATA_UNAVAILABLE` (there is no token at that address) |

`invalidFixtures()` returns the empty list, so the fixture has not drifted. Neither of the two
possibilities in the brief is what happened: the fixture is not stale, and the handler has no path that
throws on a body its validator accepts.

**What did happen.** `chart-press` is the only handler of the twenty-two that dereferences its **second**
argument at all, and it did so unguarded:

```js
run: async (i, ctx) => observationEnvelope('chart-press', i, await (i.cex
  ? chartPress(null, null, { …, host: ctx.host })      // ← the throw
```

Measured by diffing every handler's own source for a `ctx.` dereference — one hit, in this handler, twice.
So a sweep that called `s.run(s.validate(body))`, which is the natural shape and the shape the other
twenty-one handlers tolerate, got `TypeError: Cannot read properties of undefined (reading 'host')`
before a pixel was drawn. Measured three ways:

| second argument | outcome |
|---|---|
| omitted | `TypeError: Cannot read properties of undefined (reading 'host')`, both forms |
| `{}` | answers; `hostedUrl` falls back to a relative `/card/….png` |
| `{host:'http://gate'}` | answers; `hostedUrl` absolute |

**No served response is affected, and this is the reason it went unmeasured for so long.** `src/app.js`
builds `{host}` from the request at every entry point that reaches a service, and `chart-press` is not on
the MCP surface — `TOOLS` carries the nine risk tools (`perp_gate`, `portfolio_gate`, `size_gate`,
`exec_verify`, `options_risk`, `lp_risk`, `treasury_risk`, `risk_attest`, `event_vol`). So the handler was
simultaneously unreachable-by-defect and uninvokable-by-checker, and the second half is the defect that
matters: **a fixture that cannot run is a gate measuring nothing.**

**Fixed** by making the argument optional (`ctx?.host`, both occurrences), which widens the path `ctx = {}`
already took rather than inventing one. `gates/gateG-envelope-classification.mjs` check 2 now sweeps all
22 services with the argument omitted and requires no property-of-undefined TypeError from any of them.
The scripted revert puts `ctx.host` back and check 2 goes red naming `chart-press#0`.

**Classification: OBSERVATION, and there is no identity here worth proving.** `chart-press` renders live
candles into an image. The numbers baked into the picture are the venue's; the picture is a rendering.
A Plonk proof certifies arithmetic over inputs it was handed — there is no arithmetic claim in a chart
that a buyer would pay to have certified, and the thing they would actually need to trust is the candle
feed. That is input attestation, not a circuit.

## 2. `poly-fill` — a third envelope, reached because markets resolve

**Reproduced.** The fixture returns the `callerMistake` **REFUSAL** envelope: `{ok:false, errors,
refusalDetail, howToFix, searched, findASlug, elapsedMs}`, carrying neither `proof` nor `observation`,
with the sentence *no active Polymarket market matched "will-btc-hit-100k" — it is resolved, it never
existed, or the slug is misspelt*.

That is correct behaviour, and it is deliberate: the handler catches the engine's own diagnosis and
converts what used to be an HTTP 500 into an unbilled refusal that names the fix. `validate()` accepts
the body because it checks `market` is present and `usd > 0`, which is everything it can know — liveness
is not a property of a string.

**So the fixture is stale in a way no fixture can be immune to.** Driven at three live markets it returns
an OBSERVATION every time:

| body | envelope |
|---|---|
| `{market:'will-btc-hit-100k', usd:500}` | REFUSAL — the market has resolved |
| `{market:'fed-rate-hike-in-2026', usd:500}` | OBSERVATION, `deterministic:false`, `verdict: FILLS_CLEAN` |
| `{market:'will-the-us-invade-iran-before-2027', usd:500}` | OBSERVATION, `deterministic:false` |
| `{market:'Fed rate hike in 2026?', usd:500}` | OBSERVATION — question text resolves to the same slug |

The fill prices those calls returned are wall-clock and are deliberately not quoted here; they are an
observation, and an observation printed in a document stops being one.

**Nothing was changed about the fixture.** Replacing it with a live slug would buy a few months and then
fail the same way, because every named market eventually resolves. Its job in
`gates/routing-fixtures.mjs` is to be a body the *router* can be asked about, and for that job liveness
is irrelevant and the fixture is correct. What was wrong was reading a routing fixture as a run fixture.
Recorded in that file's header, and `gateG` check 7 now pins REFUSAL as a **third named outcome** —
driven through `tape-pulse`'s offline chain/address mismatch so it does not depend on anybody's uptime.

**Classification: OBSERVATION, and no identity worth proving.** The order-book walk is deterministic
*given a book*, but the book is the entire input and the walk is three lines of arithmetic a buyer can
redo. A proof would certify the easy half and say nothing about the half that can be wrong.

## 3. `portfolio-gate` — the classification was wrong, not the circuit

The brief noted that `portfolio-gate` was filed as OBSERVATION "because it reads live venue data" while
`zk/circuits/portfolioleg.circom` exists for it and publishes the adverse-distance numerator and the mark
as public signals 2 and 9, and asked which is right.

**The circuit is right. The classification was an artifact of the fixture.** Both facts are true, of
different branches, and which branch a caller gets is a property of their body:

| body | outbound fetches | envelope |
|---|---|---|
| fixture form 0 — a leg with **no `markPrice`** | 1 (`api.hyperliquid.xyz/info`) | OBSERVATION, `deterministic:false`, with a `live` block |
| a leg with `markPrice` + `maintMarginRate` supplied | **0** | PROOF, `deterministic:true`, no `live` block |
| fixture form 1 — `{account:'0x…'}` | ≥1 | OBSERVATION (the book *is* the fetch) |

Fetches were counted by wrapping `globalThis.fetch`, not by asking the adapter. A fully supplied
three-leg book returns `contentHash 8afbef9ab9c95f10e31ff2f7b7e41f0ea704ac30824e9172e3e9e599935df474`,
reproduced identically on repeat runs, with all seven of the engine's self-checks passing.

The routing is done by `legsFetchedLive()`, which diffs the legs the caller sent against the legs that
came back and discloses *what was fetched*. A leg that supplies everything fills nothing, gets no `live`
block, and stays a proof. So `portfolio-gate` is a **hybrid**, exactly as `perp-gate` is — `perp-gate`'s
explicit form serves a proof and its `{symbol, notional, leverage}` form serves an observation — and
`perp-gate`'s deterministic half is already wired to `liquidation.circom`.

**What this means for whether `portfolio-gate` can ever serve a proof: it already serves one.** What it
does not yet serve is a *zk* proof. The pinned proof-emitting set in `gates/preflight.mjs` is
`perp-gate`, `size-gate`, `treasury-risk`, `exec-verify`, `event-vol` and `lp-risk` on both surfaces —
twelve entries of 31 handlers (22 HTTP + 9 MCP), and the other 19 build no proof.

This figure was read out of `preflight.mjs` again rather than carried over, and it had gone stale: it
said four services / eight entries, which was true when this section was written and stopped being true
the same day, because two sibling sessions wired `event-vol` (`ncdf.circom`) and `lp-risk`
(`lpbracket.circom`) after it. Worth recording as its own finding, because `tools/docs-consistency.mjs`
is green over 252 documents and does not check this claim — the number lives in a prose sentence, not in
a pinned table, so nothing in the tree could go red when the set it describes grew by 50%.

**The identity is real and it is the one the circuit publishes.** The engine ranks legs on
`liquidation.moveToLiqPct`, and on the three-leg book above that is `5.963%` for the SOL leg against
`10.355%` and `9.671%` — the minimum, and `nearestLiquidation.moveToLiquidationPct` is exactly that
minimum. `portfolioleg.circom` proves the liquidation identity for one leg and publishes `d = s·(ref −
pLiq)` and `ref` separately so the "no other leg is nearer" comparison is integer cross-multiplication
over public values. The signal layout is confirmed from `build/portfolioleg.sym`, not from convention:
witness slots 1–10 are `residual, tolerance, dOut, mHat, qHat, p0Hat, s, mmrHat, pLiqHat, refHat`, so
`publicSignals[2]` is the numerator and `publicSignals[9]` is the mark — which is what
`scripts/gateB10-portfolio-perleg.mjs` pins as `D_INDEX = 2, REF_INDEX = 9`.

**Why the mark being live does not block the proof.** This is the point the OBSERVATION label got
backwards. The mark is a *public signal*. The circuit does not claim to know it is the true mark; it
publishes it, so the statement is explicitly conditional and the trust collapses onto one named number
that a separate mechanism can attest — which is what the HyperEVM verifier reading HyperCore precompiles
is for. A circuit whose live input is hidden would be overclaiming. This one is not.

**What wiring it would take, and why it was not done here.** `zk/build` already carries
`portfolioleg.r1cs`, `portfolioleg_plonk.zkey`, `portfolioleg_vk.json` and `PortfoliolegVerifier.sol`,
and `zk/build/gateB10-portfolio-perleg.json` (dated `2026-07-30T01:41:22.761Z`, produced by a sibling
session, read here rather than re-run) records 651 R1CS / 1,267 Plonk gates per leg inside a 2,048-gate
domain on a 2^11 ceremony, against 2,053 / 3,970 for the three-leg wide circuit and 2,736 / 5,295 for
four legs — which needs a 2^13 file that is not on disk. So the shape is **built and not wired**, and the
gap to wiring is service-side, not circuit-side:

1. **Grid snapping first**, on `markPrice`, `entryPrice`, `size`, `margin`, `maintMarginRate` and
   `maxLeverage` per leg, before any proof is built — otherwise the circuit certifies a book up to
   3.5e-6 away from the one served. `preflight` already asserts that every proof-emitting handler snaps,
   and a **seventh** service in that set has to be a decision recorded there, not a diff.
2. **A divergence bound derived for the ranking, not inherited from `liquidation.circom`.** The residual
   bound there is a bound on one leg's identity. What `portfolio-gate` additionally claims is a
   *comparison*, and two legs whose rounded distances tie are the case that needs a bound of its own —
   `scripts/lib/portfolio-perleg.mjs` already refuses an `orderingSplit` where the engine's rounded
   ranking names a leg that is not strictly nearest, which is the right shape and needs its headroom
   measured before it is trusted.
3. **Lifting the engine's expression rather than re-deriving it.** A `constantproduct` encoder rearranged
   engine algebra into a mathematically equal, numerically different form and was wrong by 64 grid steps.
   The distance the ranking uses is `liquidation.moveToLiqPct`; the encoder must consume that, not
   recompute `s·(ref − pLiq)/ref` beside it.
4. **Both surfaces.** `portfolio_gate` is on the MCP array as well as the HTTP one. That array has been
   the forgotten fourth site four times.
5. **The gas is per-leg and it is not small.** Verifying 11 legs on chain cost 2,974,674 gas in that
   artifact, against 292,124 for the single wide three-leg proof. Per-leg proving removes the domain
   ceiling and buys back the full input widths; it does not make verification cheap.

**What a `portfolioleg` proof would still not prove.** That the book is complete. Its legs are public
inputs in either shape, so a prover who omits the leg that is actually nearest gets a true statement
about the legs it submitted. That is the input problem, and no circuit shape addresses it.

---

## The corrected measurement

`gates/gateG-envelope-classification.mjs` — 8 checks, all green, 6.2 s, **no network required**.
`globalThis.fetch` is replaced with an immediate rejection, so the pinned table is a function of the tree
and not of Deribit's uptime, and `netTried` is recorded as a boolean rather than a count so caching
cannot make it flap. The live-venue behaviour of these services is measured with real fetches by gates
D/D3/D4/S and by the judge sweep; what this gate pins is which of them are live **at all**.

| check | what it asserts |
|---|---|
| 1 | every one of the 31 fixture forms is accepted by its own service's validator |
| 2 | every handler survives its ctx being omitted — the chart-press class of defect |
| 3 | the same sweep **with** a ctx is silent, so check 2 detects the argument and not the sweep |
| 4 | the envelope each service serves, per input form, as a 31-row equality |
| 5 | exactly eight services answer with no venue read, and they are the deterministic pool |
| 6 | a fully supplied `portfolio-gate` book reaches no venue and serves a proof envelope |
| 7 | a `callerMistake` refusal carries neither envelope — REFUSAL is a third outcome |
| 8 | this report quotes the proof-emitting set `preflight` actually pins, on both copies |

With the network reachable, the 31 forms are 12 PROOF, 18 OBSERVATION and 1 REFUSAL, over 8
proof-serving services: `perp-gate`, `size-gate`, `exec-verify`, `options-risk`, `lp-risk`,
`treasury-risk`, `risk-attest`, `event-vol`. Two of those eight — `perp-gate` and `portfolio-gate` —
serve a proof on one input form and read a venue on another, and check 5 asserts that a *third* such
service would need its own paragraph rather than silently joining them.

One behaviour worth recording because it is easy to mistake for a defect: offline, `portfolio-gate` form
0 serves a **proof**. The venue read fails, nothing is filled, `legsFetchedLive` reports nothing, and the
answer is a deterministic computation over the caller's own numbers. Nothing false is sealed. The same is
true of `perp-gate`'s symbol form, which returns `ok:false` with `live.error: "unavailable: …"` — no
attestation is claimed for a read that did not happen.

## The revert, and the blind spot it found

`gates/gateG-revert.mjs` — three corrections put back one at a time, each required to go red on the
check that owns it, and green again on restore. Measured, not asserted:

| revert | gate G | named |
|---|---|---|
| `ctx?.host` → `ctx.host`, both occurrences | 6 pass, 1 fail — check 2 | `chart-press#0: Cannot read propert…` |
| the original two-bucket classifier, no REFUSAL arm | 6 pass, 1 fail — check 7 | `expected the refusal envelope, got NEITHER` |
| one fixture body edited off its own schema | 5 pass, 3 fail — checks 1, 4, 5 | `require spot>0, atmIv/atmIvPct, and daysToEvent/T` |
| the report's pinned set back to four services, **both copies** | 7 pass, 1 fail — check 8 | `the report names [exec-verify, perp-gate, size-gate, treasury-risk]` |

The first revert also carries a **blind-spot companion, and it held**: with `ctx.host` restored,
`gates/preflight.mjs` stayed green. Preflight invokes every MCP tool with a real fixture body — the most
thorough invocation sweep in the tree — and `chart-press` is not an MCP tool, so it never called this
handler at all. That is how an uninvokable handler stayed uninvokable.

One line in the revert's own header was written wrong and corrected by running it: check 4 does **not**
go red under the first revert, because check 4 builds its table with a ctx supplied, as the HTTP surface
does. Check 2 is therefore the only thing in the tree standing between this and a handler no checker can
invoke — a reason to keep check 2, not to widen check 4 into a second copy of it.

## Everything that was verified after the change

| gate | result |
|---|---|
| `npm test` | 386 tests, 0 fail |
| `node gates/preflight.mjs` | PREFLIGHT PASSED |
| `node tools/docs-consistency.mjs` | CONSISTENT |
| `node --test gates/gateG-envelope-classification.mjs` | 8 pass, 0 fail |
| `node gates/gateG-revert.mjs` | 4 of 4 reverts red on the right check, green on restore |
| `gateV-recipe-reproduces` | 9 pass, 0 fail |
| `gateP-sealed-provenance` | 7 pass, 0 fail |
| `gateM-mcp-surface` | 17 pass, 0 fail |
| `gateC-case-sensitivity` | 10 pass, 0 fail |
| `gateL-elapsed-timing` | 8 pass, 0 fail — Appendix C still reproduces at `8575ce5ae5bfae9c…` on both surfaces |
| `src/engine/` | byte-identical to the mirror; build id `q1-e1fa99d08887d6cc` |

No content hash moved for any request that already worked, and no caller-visible shape changed: the only
source edit makes an argument optional that every real caller already supplies, so there is no changelog
entry.

## What is still unverified

- The three live Polymarket markets were reachable at the time of measurement. The classification of
  `poly-fill` as an observation service rests on those three calls; a fourth market could in principle
  refuse for a reason other than resolution and nothing here would catch it.
- Gate G's offline table is pinned against **this** tree's degradation behaviour. A service that changes
  how gracefully it fails an unreachable venue will move a row, and the correct response is to read the
  change rather than to re-pin.
- The `portfolioleg` numbers quoted in §3 were read out of `zk/build/gateB10-portfolio-perleg.json` and
  its `.sym`/`.vk` siblings. The R1CS and gas figures were not re-derived here; the signal layout was,
  from the sym file.
- No divergence bound was derived, because nothing was wired. Point 2 of the wiring list is an open item,
  not a solved one.

---

## Second pass — an independent re-measurement, 30 Jul

Everything above was re-measured from scratch by a later session that was handed the ORIGINAL brief (two
services unclassifiable, `chart-press` throwing) and did not know this document existed. What it found:

| claim re-measured | result |
|---|---|
| `chart-press` throws on its own fixture | **could not reproduce** — 40 consecutive runs of both forms, 0 throws, under 5 call conventions (raw body, shared object re-validated, per-form, and a 31-form parallel sweep). The `?.` guard holds. |
| `poly-fill` returns neither envelope | **reproduced exactly** — `ok:false` + `errors` + `howToFix`, the `callerMistake` REFUSAL. Slug `will-btc-hit-100k` still resolves to no active market. |
| `publicSignals[2]` and `[9]` are the numerator and the mark | **confirmed independently** from `zk/build/portfolioleg.sym` slots 1–10 and `nPublic: 10` in `portfolioleg_vk.json` (protocol `plonk`). |
| the live envelope table | **confirmed** — 31 forms, 12 PROOF / 18 OBSERVATION / 1 REFUSAL, over the same 8 named services. |
| the preflight pinned set | **stale, corrected above** — 12 entries / 6 services, not 8 / 4. |
| `src/engine/` untouched | `diff -rq` against the mirror: identical. `q1-e1fa99d08887d6cc` unmoved. |
| `npm test` · `preflight` · `docs-consistency` · gate G · gate G revert | 386 / 0 fail · PASSED · CONSISTENT (252 docs) · 8 pass · 4 of 4 reverts red on the right check, green on restore |

Two measurement notes from that pass, both worth keeping:

- **The offline throw is not the live refusal.** With `globalThis.fetch` stubbed, `poly-fill` *throws*
  (which is what gate G's table pins as `THREW net=tried`); with the network up it *refuses*. Both are
  correct and they are different rows. A reader who takes the pinned offline table as a description of
  live behaviour will misread this service, which is why check 7 drives the REFUSAL arm through
  `tape-pulse` — decided before any fetch — instead of through `poly-fill`.
- **`chart-press` is the slowest of the 22 but not the slowest overall**, so a sweep with a per-call
  timeout is a plausible way to see a "throw" that is not one: measured 973 ms against `protocol-pulse`
  at 1,935 ms and `options-desk` at 1,043 ms. Offline, both `chart-press` forms degrade to
  `verdict: DATA_UNAVAILABLE` inside an observation envelope rather than throwing.

**One defect found outside this report's subject, belonging to another session and left for it.** Gate G
cannot currently be run from the `Quiver` mirror at all — not because of anything above, but because the
mirror's committed `src/services.js` imports `./util/lpBoundedness.js` and that file is neither tracked
nor present there. `git log -S` puts the import in `3c73436`, which is `HEAD` and is pushed, so the
published repo's service catalogue does not load:
`ERR_MODULE_NOT_FOUND … Quiver/src/util/lpBoundedness.js`. The file exists in the working tree
(14,617 bytes) and was simply never mirrored. It is the only missing import of the committed
`services.js` — checked by resolving every `./util|adapters|engine/*.js` import in that file against
`git ls-files`, not by eye. Not fixed here, because it is another session's uncommitted work and this
one owns three paths; recorded so it is not discovered by a judge. It is also why check 8 discovers its
root by walking up rather than by counting `..`: this gate file lives at two different depths in the two
trees, and a fixed `../..` was green in one and wrong in the other.
