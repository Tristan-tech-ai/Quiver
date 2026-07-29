# Known defects — unfixed, disclosed, dated

**As of 29 July 2026.** The engine build under test is `q1-e1fa99d08887d6cc`.

Every number on this page comes from a fresh measurement against the live service at
`https://quiver-production-c3a8.up.railway.app` on that date, taken first and written down second.
Nothing here is copied from a report: where a figure originated in an outside review it was
reproduced independently, and where the reproduction disagreed with the review this page follows the
measurement.

This page exists because the alternative is worse. A project whose thesis is *do not trust the seller,
re-derive the number* cannot hold a defect back until after it is judged. What follows is the list of
things a reviewer would be right to mark us down for, written by us, with the reproduction steps.

Each section carries its own status line. **§2 is unfixed and disclosed; §1 and §3 were fixed outright
on 29 July 2026** — §1 in two passes on the same day, first for a miscased value and then for a value
matching no declared alternative at all. Their records are kept in place rather than deleted, because
what a defect looked like before it was closed is the part a reader cannot reconstruct afterwards.
`/changelog` is the dated index of what has moved.

> **How to read this page, because it is half history.** Both §1 fixes and the §3 fix are **live** —
> deployed, verified against the endpoint at 10:38 UTC on 29 July 2026, and none of them moved the
> build hash. The measured tables inside §1 and §3 are the *before* state and are labelled as such at
> the point of use. If you want only the current behaviour, read the status line at the top of each
> section and the *"What the live service answers today"* block at the foot of the page.
>
> **This page contradicted itself for part of 29 July**, and it is the one page where that costs most.
> §1's status line said `side: "banana"` was refused while the closing section said it still returned
> 91,139.24 and would need a moved build hash to fix. The closing section was the false one. It is
> retained, quoted and marked at the foot of this page rather than deleted. The repair is written up in
> `claim-repair.md`.

---

## 1. `side` and option `type` are matched as exact lowercase strings, and fail open to the riskier default

**Status: FIXED, 29 July 2026, on both surfaces — in two passes on the same day.** First for a
miscased value (`side: "SHORT"` now answers as the short it means), then for a value matching no
declared alternative at all (`side: "banana"` is now **refused**, naming the field and listing what
would work, rather than served as a long). Neither pass touched `src/engine/`; the build hash is still
`q1-e1fa99d08887d6cc`. Everything below describes the state before the fixes and is left standing;
what changed and what it cost are at the end of this section. The write-ups are
`CASE_SENSITIVITY_FIX.md` and `UNKNOWN_ENUM_REFUSAL.md`.

**The reason this section previously said the fix was impossible without moving the build hash was
wrong, and the correction is the interesting part.** It read: *"Both lines are inside `src/engine/`,
the directory the build hash covers."* Both lines are — but the *substitution* those lines perform can
be prevented before the engine is ever called, by declaring the alternatives in the schema the repair
layer already consults. The four-part fix listed at the bottom of this section had it right in its own
step 1 and then treated step 3 as load-bearing for the whole thing. It was not: steps 1 and 2 close
the case half completely, and they touch no hashed file.

### The answer is wrong

Not surprising, not a rough edge, not an unusual input handled unusually. **Wrong.** A caller who
sends `side: "SHORT"` and acts on the answer takes the opposite risk from the one they asked about.

Two functions decide direction by comparing against a lowercase literal, and anything that does not
match becomes the *riskier* default rather than a refusal:

```
src/engine/perpGate.js:29     const sideSign = (s) => (s === 'short' || s === 'sell' || s === -1 || s === '-1' ? -1 : 1);
src/engine/optionsRisk.js:32  const type = p.type === 'put' ? 'put' : 'call';
```

### What that does, measured — BEFORE THE FIX

> **Every table in this section is the historical record, not current behaviour.** These are the
> numbers the live service returned *before* 29 July 2026. They are kept because they are the evidence
> the defect was real and the measurement anyone can hold us to. **What the service returns today is at
> the foot of this page**, under *"What the live service answers today"* — the bolded rows below no
> longer reproduce.

**`perp_gate`, over the free MCP endpoint.** Body
`{side, entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000}`:

| sent `side` | served as | liquidationPrice | self-checks |
| --- | --- | --- | --- |
| `"long"` | long | 91,139.24 | pass |
| `"short"` | short | 108,641.98 | pass |
| `"sell"` | short | 108,641.98 | pass |
| `-1`, `"-1"` | short | 108,641.98 | pass |
| **`"SHORT"`** | **long** | **91,139.24** | **pass** |
| `"Short"`, `"SELL"`, `"s"`, `""`, `"buy"`, `null` | **long** | **91,139.24** | **pass** |

A short seller who capitalises one word is told they liquidate at 91,139.24 — *below* their entry.
They liquidate on the way **up**, at 108,641.98. The number they are given is the number for the
opposite position, and it is the direction of the error that matters: it tells someone their risk is
in the direction they are not exposed to.

**`portfolio_gate`, over the free MCP endpoint.** A perfectly hedged book — one long, one short, same
asset, same size, same price:

```
positions: [ {asset BTC, side "long",  size 1, entryPrice 100000, markPrice 100000, leverage 10, mmr 0.0125},
             {asset BTC, side "short", size 1, entryPrice 100000, markPrice 100000, leverage 10, mmr 0.0125} ]

→ netExposureByAsset[0] = { netNotional 0, longNotional 100000, shortNotional 100000 }
  allSelfChecksPass: true      contentHash 21c86613cbb676390957542d…
```

Capitalise one word in the second leg:

```
             {asset BTC, side "SHORT", …}

→ netExposureByAsset[0] = { netNotional 200000, longNotional 200000, shortNotional 0 }
  allSelfChecksPass: true      contentHash 81378c368ee36c5369916d3a…
  proof.inputs echoes side "SHORT"; the served leg reads side "long"
```

**A flat book is reported as a fully doubled-up directional bet**, and the tool whose stated purpose
is "to see whether independently-sized bets are secretly ONE bet that blows up together" says the
opposite of the truth about the simplest book there is.

**`options_risk`** — again, as it behaved BEFORE the fix. Every `type` that is not the literal string
`"put"` was priced as a **call**. Body
`{forward: 100000, positions: [{type, strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1}]}`:

| sent `type` | served as | portfolioValue | delta | self-checks |
| --- | --- | --- | --- | --- |
| `"call"` | call | 3,270.26 | +0.319866 | 6/6 pass |
| `"put"` | put | 13,270.26 | −0.680134 | 6/6 pass |
| **`"PUT"`** | **call** | **3,270.26** | **+0.319866** | **6/6 pass** |
| `"Put"`, `"P"`, `"p"`, `"puts"`, `" put"`, `"banana"`, `null`, `""`, `123` | **call** | 3,270.26 | +0.319866 | 6/6 pass |

The delta sign flips. A caller hedging a put book is handed the greeks of a call book — a position
that moves the other way — and the mark-to-model value is wrong by 10,000 on a single leg.

None of the four rows above reproduces today. `"PUT"` and `"Put"` price as puts; `"P"`, `"p"`,
`"puts"`, `" put"` and `"banana"` are refused outright. The row listing `"banana"` under **call** is
the strongest single piece of evidence on this page and also the one most likely to be misread — it
records what the service did in the past tense, and only that.

### Every self-check passes, and that is the point

All six finite-difference greek checks pass in every row above. They are not broken. They verify that
the greeks are consistent with the book **the engine chose**, not with the book **the caller
described**. A self-check is a statement about internal consistency, and internal consistency is
exactly what a silent substitution preserves.

### The proof machinery signs the wrong answer

`proof.inputs` faithfully echoes `"SHORT"`. Re-running the open engine on those echoed inputs
reproduces the served result byte for byte — because the engine repeats the same substitution. The
content hash reproduces. The signature recovers to `0x946324E0E5d7D77206731E35Ef4044a383e2a8C2`, the
signer published in the agent card.

**Re-runnability certifies the pipeline, not the interpretation.** That sentence is the sharpest limit
on this project's whole thesis, and it is the one the paper does not currently state. A verifiable
answer is an answer you can prove came from the published code applied to the stated inputs. It is not
an answer you can prove is *about the question you asked*. Every verification apparatus here — the
content hash, the EIP-191 signature, the Plonk proof, the on-chain registry — sits downstream of the
interpretation step, and none of them can see an error that happens before it.

### It is billable

`src/x402.js` `isChargeable()` returns `false` only for `ok === false` or a failed self-check. Here
`ok` is `true` and every check passes, so a paying caller is charged for the inverted answer. This is
derived from the source rather than observed through a settlement, and is labelled as such.

### Why it was held — the reasoning as it stood, and where it was wrong

The paragraph below is the argument this page made on the morning of 29 July. It is kept because it
is the mistake worth publishing: not a wrong number, but a **wrong assumption about where a fix has to
live**, which held a wrong risk answer in place for longer than it needed to be. The premise that
`isChargeable()` bills for it and that every self-check passes is correct and unchanged; the
conclusion that nothing could be done outside `src/engine/` is what did not survive.

Because **the fix moves the codeHash, and the served changelog promises `q1-e1fa99d08887d6cc` will
not move while judging runs.** Both lines are inside `src/engine/`, the directory the build hash
covers. Changing either produces a different hash, and then:

- the Appendix C exhibit stops reproducing against the live build;
- every published proof quotes a build identity that no longer exists;
- `/build` disagrees with every document that names the hash.

That is a real trade-off between two things a reviewer cares about, and naming it as a trade-off is
the honest framing. **We chose stability of the published artifact over correctness of an unusual
input, and that is a defensible choice only because it is disclosed here rather than discovered.** A
reviewer who thinks we chose wrong is not making a mistake — the case for shipping the fix and
re-publishing every hash is strong, and it comes down to whether a moving build hash during judging
costs more trust than a documented wrong answer. We are not neutral about which defect is worse: an
inverted risk number is worse than a changed hash. We are only claiming that changing the hash *while
a reviewer is mid-verification* is worse than either, and that the window closes in days.

**The fix, in full, for when the window opens — THE PLAN AS IT STOOD, AND ITS STEP 3 IS WRONG.** It
was believed to be four changes, of which only the third touched the hashed tree. Step 3 was never
needed and was never done; `"banana"` is refused today at the validation layer, outside the hash. The
list is kept unedited because *"the fix has to live in the hashed tree"* is the assumption this page
got wrong twice, and reading the reasoning is how the second occurrence was caught:

1. `src/services.js` — declare `enum: ['long','short']` on perp-gate's `side` and
   `enum: ['call','put']` on the option-type item property. The repair layer (`src/util/repair.js`
   step 6) already case-corrects enum values, but **only where the service's own `inputSchema`
   declares an `enum`**, and `services.js` declares `side` as
   `{ type:'string', description:'long | short' }` with no `enum` array — so the recase never fires.
2. `src/util/repair.js` — descend into array items, which is where option `type` and portfolio-leg
   `side` both live. `repairBody` currently only walks top-level properties.
3. `src/engine/perpGate.js:29` and `src/engine/optionsRisk.js:32` — **refuse** an unrecognised value
   instead of defaulting to it. This is the change that moves the build hash, and it is the one that
   actually closes the defect; 1 and 2 narrow it but leave `"banana"` priced as a call.
4. Re-publish the hash everywhere it is quoted, and add a changelog entry saying so.

Note also that `src/mcp.js:76` already advertises `side: { enum: ['long','short'] }` to every MCP
client. `handleRpc` repairs against the `SERVICES` entry rather than the `TOOLS` entry, so **the enum
the MCP server publishes is decorative and unenforced** — a client that trusts the advertised schema
is being told a constraint that is not applied.

### What shipped, 29 July 2026

Steps 1 and 2 of that list, plus the same treatment applied to every other field of the same shape.
**Step 3 was not needed for the case half and was not done: `src/engine/` is byte-identical to the
published mirror and the build hash is still `q1-e1fa99d08887d6cc`.** Step 4 is therefore moot.

Every row in the tables above that differs only by capitalisation now returns **the same content hash
as the correctly-cased body it meant** — not a similar answer, the identical signed artifact.
`"SHORT"`, `"Short"` and `"SELL"` all return 108,641.98 on both surfaces; the hedged book reports net
0 again; `"PUT"` and `"Put"` price as puts with delta −0.680134.

Nine fields were declared, across six services, after sweeping all 22 for string fields whose
description enumerated alternatives in prose: `perp-gate.side`, `perp-gate.venue`,
`portfolio-gate.positions[].side`, `portfolio-gate.betaTier`, `options-risk.positions[].type`,
`poly-fill.action`, `options-desk.focus`, `chart-press.quality`, `chart-press.theme`. Three of those
were defects nobody had reported: `poly-fill` quoted a seller the **buy** side of the market on
`action: "SELL"` (60c for 166.7 shares instead of 40c for 250), `betaTier: "SEVERE"` silently returned
the default stress table instead of the validated tier, and `options-desk` with `focus: "ALL"`
returned *strictly less* than sending nothing at all. Eleven further candidates were deliberately left
alone because their consumer already folds case; each is listed with the file:line that does so, as an
equality a new field cannot slip past.

`repairBody` also learned to descend into array items, which is where option `type` and portfolio-leg
`side` live — enums alone would have fixed `perp-gate` and left the other two untouched.

**Nothing that was already correct moved.** Swept across all 22 services — 31 fixture forms and 14
deterministic content hashes, captured from the unmodified repository and re-measured against the
fixed one — the two runs are byte-identical. One honest exception, measured rather than argued: a
miscased spelling that happened to land on the default branch anyway (`side: "LONG"`,
`venue: "HYPERLIQUID"`) now hashes as the canonical value while its served numbers stay identical.
No canonically-cased request moved.

### The second pass, later the same day: a value matching NO declared alternative

The paragraph that stood here said this was still open and needed an engine change:

> A value that is not a case-variant of a declared alternative — `"banana"`, `"p"`, `"puts"` — is
> still passed through and still hits the engine's fail-open default. Closing that needs
> `perpGate.js:29`, `portfolioGate.js:30` and `optionsRisk.js:32` to refuse, which does move the build
> hash.

**Wrong for the second time in this section, in the same way.** `repair.js` will not coerce `"banana"`
to a nearest neighbour, and it should not — that would invent a value the caller never wrote. But
**refusing invents nothing**, and refusing happens at the validation layer, which is outside the
hashed tree. `q1-e1fa99d08887d6cc` did not move.

Measured before the change: **all 63 illegal-value rows were served** — nine declared enum fields ×
seven illegal spellings, on both surfaces. `side: "banana"`, `"lng"`, `"p"`, `"SHORTT"`, `""`,
`"long "` and `"null"` each returned 91,139.24 under a *distinct* content hash — seven separate signed
artifacts attesting a long position to a caller who never wrote the word. The hedged book doubled to
net 200,000 on any of them; any `type` but `put` priced as a call at delta +0.319866.

All 63 are now refused, on both surfaces, with a message that names the field (`positions[1].side`,
not just "side"), quotes back what was sent, lists every legal value, and hands over a corrected body
with the offending value replaced by a placeholder. The refusal is free: `ok:false` on MCP, and HTTP
400 thrown before `/settle` on the paid path.

Three of the four call sites that reach an engine go through `s.validate`, so one wrapper at the foot
of `services.js` closed the paid route and both gated diag testers. The fourth, `handleRpc`, **never
calls `validate()` at all** and carries the guard explicitly — a fix written in `services.js` alone
would have left the free surface still answering `side:"banana"` as a long.

One enum value was added: `perp-gate.side` gained `'-1'`, because `perpGate.js:29` honours the string
and answers it correctly at 108,641.98. Omitting it would have converted a correct answer into a
refusal, which is worse than the defect. `perp-gate`'s advertised `inputSchema` grew 145 bytes; the
other twenty-one are byte-identical, and the OKX registry surface (service count, endpoint, agent
identity, codeHash) is untouched. Full write-up: `UNKNOWN_ENUM_REFUSAL.md`.

**What is still open.** Nothing in this class, at the surfaces. The three fail-open lines remain in
the engines and are simply unreachable with an unrecognised value — defence at one layer rather than
two. A non-string value (`side: 42`, `side: {}`) still reaches the default, deliberately: the guard
matches `repairBody`'s reach, and widening it would have refused the number `-1`, which the engine
honours correctly.

Held by `gates/gateC-case-sensitivity.mjs` (`npm run gate:c`, 10 checks) for the case half, and
`gates/gateU-unknown-enum.mjs` (`npm run gate:u`, 8 checks) for the unrecognised-value half. Both
sweep every service and every enum field on both surfaces, and both assert the published numbers as
hardcoded values so that removing an enum makes the check go red rather than go quiet. Gate C test 7,
which used to assert the pass-through was deliberate, now asserts its opposite.

`gates/gateC-revert.mjs` and `gates/gateU-revert.mjs` (`npm run gate:c-revert`, `npm run gate:u-revert`)
put each half of each fix back and show the gates fail — and show `preflight` and `gateBuyer` stay
green over the same defect, which is why it survived this long: gateBuyer's whole subject is what
buyers get wrong about inputs, and it checks miscased **keys** while never once checking the **value**.
Gate U's third revert is the one that is not about the defect: it makes the guard *over-fire*, and
requires the gate to catch a refusal that fires on input the engine answers correctly.

---

## 2. Twelve of the thirteen observation services ship `selfChecks: []`, while the front page says every answer carries a proof

**Status: the envelopes are honest; the summary copy is not. Copy fix pending.**

Served at `/`, `/llms.txt` and the agent card:

> "Deterministic risk computation where every answer carries a re-runnable, self-checked proof"

Measured, calling all 22 services on their own genuine fixture bodies:

| | services | `selfChecks` | `allSelfChecksPass` |
| --- | --- | --- | --- |
| deterministic (`kind` absent, `deterministic: true`) | 8 answered with 1–7 checks each | non-empty | `true` |
| observation (`kind: OBSERVATION`, `deterministic: false`) | 12 of 13 | **`[]`** | **`null`** |
| observation — the exception | `macro-sentry` (options form) | 1 check | `true` |

The per-response envelopes are scrupulous: every one of the 13 live-data services ships
`kind: OBSERVATION`, `deterministic: false`, an `observedAtUtc`, and a `semantics` block that says in
plain words the number is not re-runnable. **The envelopes do not lie. The one-line summary
overreaches**, and a reader who takes the summary at face value will expect a self-checked proof on
services that correctly and openly ship none. The claim is true of 9 services out of 22 and should
name them.

---

## 3. `portfolio_gate` seals an undisclosed live venue read inside a `deterministic: true` proof

**Status: FIXED, 29 July 2026, on both surfaces.** The record of what was wrong is kept below because
this is the same defect §11.5 of the paper records finding and fixing on `perp-gate` symbol mode, and
`portfolio-gate` was the branch next door — which is the pattern worth publishing, not the individual
bug. What changed, and what a caller sees now, is at the end of this section.

Sent, over free MCP — one leg, no mark price:

```
{positions: [{venue: "hyperliquid", asset: "BTC", size: 1, entryPrice: 100000, leverage: 10, maxLeverage: 40}]}
```

Returned:

```
proof.inputs.positions[0] = {venue "hyperliquid", asset "BTC", size 1, entryPrice 100000,
                             leverage 10, maxLeverage 40, markPrice 63850}
proof.deterministic  true
proof.observedAtUtc  (absent)
live                 (absent)
mathReproducibility  (absent)
checks               7, all pass
nearestLiquidation   null
```

`markPrice: 63850` was never supplied by the caller. It was fetched from Hyperliquid at request time
and frozen into the echoed inputs. The content hash still reproduces — precisely *because* the fetched
value was frozen — so nothing detects it. But a reader comparing their request to `proof.inputs` finds
a number they never sent, **with no source, no timestamp, and an envelope that says
`deterministic: true`**. The same request tomorrow returns a different answer under the same claim of
determinism.

The practical effect is worse than the principle. Because the live mark (≈63,850 at the time of
measurement) is far below the hypothetical entry (100,000), the textbook example comes back
`nearestLiquidation: null` and the leg reads as already past maintenance — so the tool's headline
output is null and a reviewer trying the obvious example is told their hypothetical book is already
liquidated. The per-leg `statusNote` explains it well; nothing at the top level does.

**The fix, shipped 29 July 2026.** A call whose legs were enriched from the venue now returns the
**observation** envelope — `kind: OBSERVATION`, `deterministic: false`, an `observedAtUtc`, a
`live.filled` block naming every fetched value and the venue it came from, and a
`mathReproducibility` note — exactly as `perp-gate` symbol mode does. Which values were fetched is
*measured*, by diffing the legs the caller sent against the legs that came back, rather than
self-reported by the adapter. Applied to the paid HTTP handler and the free MCP tool at the same time
from one shared helper (`legsFetchedLive` in `src/services.js`), because the history of this defect is
four fixes at four call sites.

The cost was the one this section previously held it for, and it is now measured rather than feared:
the envelope *kind* changes on exactly the calls that were lying. Swept across all 22 services against
the unmodified repository, **13 deterministic content hashes are identical and exactly one row moved**
— `portfolio-gate` with an un-marked leg, `proof(deterministic:true)` → `observation(deterministic:false)`.
A call that supplies `markPrice` and a maintenance-margin source on every leg fetches nothing and
returns the identical `contentHash` it always did. `gates/gateP-sealed-provenance.mjs` now sweeps all
22 services and all 9 MCP tools and fails any `deterministic: true` envelope that echoes a value the
caller did not supply; `gates/gateP-revert.mjs` puts the defect back on each surface in turn and shows
that gate go red while preflight stays green.

---

## How to reproduce anything on this page

Everything above is reachable free, unauthenticated, with no key and no payment, over the MCP
endpoint:

```
curl -s https://quiver-production-c3a8.up.railway.app/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"perp_gate",
       "arguments":{"side":"SHORT","entryPrice":100000,"size":1,"leverage":10,
                    "maxLeverage":40,"markPrice":100000}}}'
```

Compare `liquidationPrice` against the same body with `"side":"short"`.

### What the live service answers today

**Both fixes are deployed.** Measured against the live endpoint at 10:38 UTC on 29 July 2026, on the
free MCP surface — the one the command above uses:

| you send | live answer | |
|---|---|---|
| `"side":"short"` | `liquidationPrice` **108,641.98** | the short's price |
| `"side":"SHORT"` | `liquidationPrice` **108,641.98** | identical to the above, and the identical `contentHash` |
| `"side":"banana"` | **refused** — `ok:false`, `unknownEnumValues`, *"Nothing was computed and you were not charged"* | not answered at all |

`/build` reads `q1-e1fa99d08887d6cc`. **The hash did not move for either fix**, because neither one
touched `src/engine/`: both shipped in `src/services.js`, `src/mcp.js` and `src/util/repair.js`.

If you get **91,139.24 for `"SHORT"`**, or a priced answer for `"banana"`, you have reached a cached
or older response — that is not the build this document describes, and the tables in §1 tell you
exactly what you are looking at.

### What this section used to say, and why it is worth keeping

Until 29 July this section predicted the opposite, in two sentences that were false in three ways
between them:

> Either way, `{"side":"banana"}` still returns 91,139.24 on both builds. That half is genuinely still
> open and is not scheduled around judging: it needs `src/engine/` and a moved build hash.

`banana` is refused, not answered; it did not need `src/engine/`; and the hash did not move. The same
page said so 355 lines earlier, at §1's status line. **A defect register that contradicts itself is
worse than one that is merely out of date**, because the reader cannot tell which half to trust — and
this is the page whose whole purpose is being trusted about bad news. It is recorded here rather than
quietly deleted for the same reason every other superseded paragraph on this page is.

The other retracted sentence claimed *"no deploy has been performed since it landed"*. Three had:
28 July 17:20:59 UTC, 29 July 00:30:41 UTC, and 29 July ~09:30 UTC. See `deploy-manifest.md`.

**Nothing here was measurable.** No checker reads a document against the endpoint it predicts, so
these sentences could not go red however false they became. `claim-repair.md` proposes the gate that
would have caught them.

To reproduce the fix locally without the network, against whatever is checked out:

```
npm run gate:c          # 10 checks, every service and every enum field, both surfaces
npm run gate:c-revert   # puts each half of the fix back and shows the gate go red
npm run gate:u          # 8 checks, the unrecognised-value half
npm run gate:u-revert   # removes the guard from each surface in turn and shows gate U go red
```
