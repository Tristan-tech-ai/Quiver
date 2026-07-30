# Known defects — unfixed, disclosed, dated

**As of 30 July 2026.** The engine build under test is `q1-e1fa99d08887d6cc`.

Every number on this page comes from a fresh measurement taken first and written down second — §1–§3
against the live service at `https://quiver-production-c3a8.up.railway.app` on 29 July, §4–§13 against the
engine, the circuits and the gate artifacts in this checkout on 30 July, each named at the point of use.
Nothing here is copied from a report: where a figure originated in an outside review it was reproduced
independently, and where the reproduction disagreed with the review this page follows the measurement and
says so.

This page exists because the alternative is worse. A project whose thesis is *do not trust the seller,
re-derive the number* cannot hold a defect back until after it is judged. What follows is the list of
things a reviewer would be right to mark us down for, written by us, with the reproduction steps.

Each section carries its own status line, and the records of closed defects are kept in place rather than
deleted, because what a defect looked like before it was closed is the part a reader cannot reconstruct
afterwards. `/changelog` is the dated index of what has moved.

**Ten sections were added on 30 July 2026**, after four services were investigated for whether their zk
proofs can be wired and every one of those investigations was then handed to an adversary. That round
produced more defects than it closed, which is the outcome to expect from an honest one. The index:

| § | what | status |
| --- | --- | --- |
| 1 | `side` / option `type` matched as exact lowercase strings, failing open to the riskier default | **fixed** 29 Jul, both surfaces, hash unmoved |
| 2 | 12 of 13 observation services ship `selfChecks: []` while the summary copy promises a proof on every answer | **open** — envelopes honest, copy overreaches |
| 3 | `portfolio_gate` sealed an undisclosed live venue read inside a `deterministic: true` proof | **fixed** 29 Jul, both surfaces |
| 4 | 20 of 23 circuits have no private input; on the paid path a proof costs 134× the same predicate in Solidity | **open**, not scheduled — needs a different circuit |
| 5 | `lp-risk`'s boundedness self-check fails on a live call, and the paid path reports "input rejected by engine" | **fixed** 30 Jul **outside `src/engine/`** — hash unmoved, not yet deployed; one residual band 5.2149e-4 wide disclosed |
| 6 | the served note calls the leading-order divergence a diverging approximation; it is that expectation's logarithm | **open** — and unlike §5 it cannot be fixed outside the hashed tree |
| 7 | `gateB6` passed "the contract picks the right leg" while ranking by liquidation price, against its own copy of that rule | **fixed** 30 Jul — the claim was deleted, not the ranking changed |
| 8 | `gate-clone-portability` listed 14 of 21 circuits and missed `liquidation`, which the published mirror did not carry | **fixed** 30 Jul, both halves: gate discovers from disk, and all 5 artifacts are now at HEAD (`ddcc434` shipped 1, this change shipped 4) |
| 9 | every gas figure in the four Phase B reports disagreed with its artifact, and every disagreement was inside the noise | **fixed** 30 Jul, and the checker now reads gas |
| 10 | of the four circuits built, proved, gated and swept this round, three are still unreachable from a served answer | **open for 1 of 4** — `execadverse`, `lpbracket`, `ncdf` wired 30 Jul; `portfolioleg` left |
| 11 | two shipped circuit headers claim more than the circuits prove | **open**, unpatched |
| 12 | three constants inside the trust root contradict the code beneath them | **open**, unpatched |
| 13 | the four refutations that redirected this round are not reproducible from this repository | **open** — sources now committed (38 of 38), **2 of 38 compiled artifacts committed** 30 Jul (`lpclosed`, `lpclosed2`, with `hez_final_13.ptau`; one more exists uncommitted), ceremony question answered for those two only |

`gates/gateN-known-defects.mjs` (`npm run gate:n`) re-measures the symptom behind every open section above
and fails if this page and the measurement disagree — in either direction, so closing a defect without
updating this page is as red as inventing one. `npm run gate:n-revert` puts each disclosure back the way it
was and shows the gate go red while `docs-consistency` stays green over the same edit — which is why an
omission from this page was invisible to a checker that reads every document in the tree. **What that
checker cannot read is git**, and neither could this gate until 30 July: §13 published a count of what is
*committed* while every source either checker consulted was a working tree, so the row was wrong twice and
nineteen green rows had nothing to say about it. `gate:n` now asks `git ls-tree HEAD` for that row and for
§8's, and the revert puts the wrong count back.

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

## 4. Eighteen of the twenty-one compiled circuits have no private input, every circuit on the paid path among them, and a proof costs 134× what checking the same predicate costs

**Status: OPEN, disclosed, and not scheduled.** Nothing here is a repair — closing it means a different
circuit, not a fix to this one. Measured 30 July 2026 with an `.r1cs` header parser written for this
page, and with a Solidity checker built for it.

**What is wrong.** Every `.r1cs` in `zk/build` was parsed from its section-1 header — `nWires`,
`nPubOut`, `nPubIn`, `nPrvIn`, `nLabels`, `nConstraints`, with a guard that throws on a zero rather
than reporting a row that passed green on nothing:

| | circuits | `nPrvIn` |
| --- | --- | --- |
| compiled in this checkout | **23** | |
| with no private input at all | **20** | `0` |
| with any private input | 3 | `portfoliogate` 3, `portfoliogate4` 4, `lpexpectation` 246 |

Both figures moved on 30 July when `lpclosed` and `lpclosed2` were compiled, from 21 and 18. Read out of the
`.r1cs` headers: each declares `nPubIn` 2, `nPubOut` 2 and `nPrvIn` **0**, so both land on the wrong side of
this defect and make it slightly worse rather than better. The three circuits with a private input are
unchanged. This ratio is the defect: a proof over an all-public witness is a verifiable computation, not a
confidentiality claim, and nothing in this repository has ever said otherwise.

**Every circuit on the paid path is in the first group.** `src/util/proverWorker.mjs` carries a closed set
of circuit names — `liquidation`, `kelly`, `concentration` and, since 30 July, `execadverse`, `lpbracket`
and `ncdf` — and each of the **six** measures `nPrvIn = 0`. `preflight.mjs` prints the proof-emitting handler set as
`http:exec-verify, http:perp-gate, http:size-gate, http:treasury-risk` and the four matching MCP tools,
with 23 of 31 handlers building no proof at all. The count of services a caller can obtain a proof from
moved from three to four while this page was being written, and the private-input count did not move at
all: `execadverse` has eight public signals, seven public outputs and nothing private.

**And it kept not moving as the set kept growing.** `lpbracket` was wired to `lp-risk` on 30 July and
measures `nWires` 912, `nPubOut` 4, `nPubIn` 9, `nPrvIn` **0**, `nConstraints` 932 — thirteen public
signals and nothing hidden, on the cheapest circuit this host carries. It is the sharpest case on this
page for the *succinctness* half of the complaint above, and the first one where that half does not
land: the statement it proves is that a root lies inside a bracket, and the search that found the root
costs 163,608 exponentials and 82,016 square roots (measured) against a certificate of six
inequalities. A contract cannot re-execute that in eleven lines of Solidity, because eleven lines of
Solidity cannot run a 401-point quadrature two hundred times. The 134× gas complaint below is a claim
about identities a contract could check directly; it is not a claim about this one.

**And it had already not moved for a sixth.** `ncdf` is wired too — to `options-risk` and `event-vol` — and
measures `nWires` 2,036, `nPubOut` 3, `nPubIn` 4, `nPrvIn` **0**, `nConstraints` 2,051: seven public signals
and nothing hidden. **Six of six on the paid path, and the private-input count has not moved once across six
wirings.** That is the shape of the complaint, and it is why this entry is not scheduled: no amount of
further wiring trends this set toward privacy. This paragraph is late — `ncdf` was wired before this page
was last edited and the closed-set sentence above still said four, which `gate:n` went red over rather than
anyone noticing.

**The paper is honest about the count and does not draw the consequence.** It says, and this page is
quoting it approvingly rather than retracting it:

> "The word for it is *succinct*, not *zero-knowledge*: the circuit has **zero private inputs**, every
> value it consumes is one the service already publishes, and it hides nothing. Reviewers who know the
> field check that count first, so this document states it rather than letting the phrase do work the
> circuit does not."

That paragraph disposes of *privacy*. It leaves **succinctness** standing, and the same sentence sells
it: a proof is what lets "a verifier that cannot run Node" check the arithmetic, because "what
re-execution needs is a *runtime*, and a smart contract has none". **With every input public, that is
not true of these three statements.** A contract does not need a runtime to check
`M + s·q·(P_liq − P_0) = q·P_liq·mmr` on integers it already has in calldata. It needs eleven lines of
Solidity.

**Measured, both sides, in the same process, each in a fresh EVM.**
`zk/scripts/probe-direct-vs-snark-gas.mjs` proves the identity for a real `perp-gate` answer (long 1.5
BTC at 64,000, 10×, mmr 0.005 → `liquidationPrice` 57,889.45), then evaluates *every constraint
`liquidation.circom` imposes* — five range bounds, `(s−1)(s+1) = 0`, `mmr < 1`, `q ≠ 0`, the residual and
the derived bound `2|R| ≤ q̂(SCALE + m̂mr)` — directly in Solidity over the identical integers:

| | accept gas | deployed bytes |
| --- | --- | --- |
| the Plonk pairing check (`PlonkVerifier.sol`, 8 public signals) | 273,693 <!--gas:probe-direct-vs-snark-gas#snark.acceptGas~2%--> | 7,270 <!--gas:probe-direct-vs-snark-gas#snark.deployedBytes--> |
| the same predicate, in Solidity | 2,050 <!--gas:probe-direct-vs-snark-gas#direct.acceptGas--> | 790 <!--gas:probe-direct-vs-snark-gas#direct.deployedBytes--> |

**133.5×**, and the two columns are not the same kind of number, which the probe measures rather than
assumes: across twelve proofs of that identical statement the verify figure moves by
3,022 gas <!--gas:probe-direct-vs-snark-gas#spread.gas--> (1.1%), while the direct check returns the
identical gas on a second run because it touches no precompile and its control flow does not depend on a
proof scalar. The left column is a sample; the right one is a value.

The comparison is generous to the proof in two further ways, both left in deliberately. Execution gas
excludes calldata, where the proof carries twenty-four extra words —
13,532 gas <!--gas:gateB9-2-widening-evm#single.calldataGas~2%--> of calldata for a single-proof
submission, from `gateB9-2`'s own artifact. And the direct checker is held to the same refusals as the
circuit: it accepts the honest answer, **refuses the same single-grid-step perturbation of `pLiqHat` that
the on-chain registry records as `ProofRejected`**, and refuses `side: 0`
(592 gas <!--gas:probe-direct-vs-snark-gas#direct.guards.0.gas-->), `mmr ≥ 1`
(598 <!--gas:probe-direct-vs-snark-gas#direct.guards.1.gas-->) and `size: 0`
(621 <!--gas:probe-direct-vs-snark-gas#direct.guards.2.gas-->). A cheap checker that accepted everything
would be worthless, so the probe fails if any of those six behaviours is missing.

**What a caller sees.** Nothing wrong. Every number a proof carries is correct and every proof verifies.
What a *reviewer* sees is a claim that overstates what the machinery buys: for these three identities the
SNARK is not the thing that makes the answer checkable on chain, and it costs two orders of magnitude
more than the thing that does. What it does buy is worth stating precisely, because it is not nothing —
third-party certification that the arithmetic came from the published circuit, a constant-size artifact
whatever the statement's size, and a public-signal surface that a commitment or an attestation can later
be joined to. None of that is succinctness in the sense a reviewer will test.

**Why it is not being fixed.** The circuit that would earn the word exists on paper and not in this
repository: a Poseidon-committed variant measured at 1,764 R1CS with two public signals and every input
private, on the ceremony file already on disk. It is a new statement, a new gate and a new wiring — not a
defect repair — and `src/engine/` and the paper are both frozen, so neither the identity nor the
sentence selling it can move this week. The honest interim is this entry.

**One number that entered the record unmeasured, and is now measured.** The review that first drew this
conclusion said the proof costs "about 55× the gas of just checking the predicate". Its direct-check figure
was never run by anybody, and `phase-b-verified.md` §3.1 says so in as many words:

> "I did not myself measure the ~5,011-gas direct Solidity check. That number is the adversary's."

Measured here, the direct check is 2,050 <!--gas:probe-direct-vs-snark-gas#direct.acceptGas--> and the
ratio is 133.5× rather than 55×. The borrowed figure was wrong in the direction that flattered the proof,
and it was still being repeated as a reason to act on the conclusion.

---

## 5. `lp-risk`'s own boundedness self-check fails on an ordinary live call, and the paid path tells the buyer their input was rejected

**Status: FIXED in this checkout, 30 July 2026 — and fixed OUTSIDE `src/engine/`, so the build hash
`q1-e1fa99d08887d6cc` did not move.** The sentence below this line, in the entry as it stood that
morning, said the fix needed the hashed tree and could not be done. That was wrong, and the reason it
was wrong is worth more than the fix: the entry asked whether the un-rounded value is *published* (it is
not — `eIlExact` is a local variable) and stopped there, when the question was whether anything
published lets a reader **recompute** it. §6 below is the answer, sitting on the next page of this same
register: `E[IL] = exp(-sigma^2*T/8) - 1` exactly, and `sigma`/`horizonPeriods` are echoed in every
envelope. The verdict is now re-evaluated on that exact fraction in `src/util/lpBoundedness.js`.
**NOT YET DEPLOYED — the live service still answers the old way while deploys are frozen for judging.**

**What is wrong.** The check ranges over the **rounded display value** rather than the quantity:

```js
checks.push({ name: 'boundedness: reported expected divergence lies in (-100%, 0] ...',
              residual: e, pass: e <= 0 && e > -100 });     // e = round(E[IL]*100, 4)
```

Once `E[IL] ≤ −0.9999995`, `round(E[IL]·100, 4)` is exactly `-100`, and `-100 > -100` is false. The
value is not wrong: at σ = 0.62 per period over 365 periods the full-precision expectation is
**−0.9999999758323288**, strictly inside `(−1, 0]` where the check says it must be. It is display
rounding meeting a strict inequality — the same class as the `divergence-headroom.md` defect.

**Measured, calling the service's own `lp-risk` handler** with
`{volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000}`:

```
ok                          true
expectedIlPct               -100
totalVariance               140.306
proof.deterministic         true
proof.allSelfChecksPass     false          <- one of four checks
  [pass] IL identity: closed form 2√r/(1+r)−1 == explicit constant-product token value
  [pass] E[IL] check: −σ²T/8 == numerical E[IL] at σ²T=0.01
  [FAIL] boundedness: reported expected divergence lies in (-100%, 0] ...   residual = -100
  [pass] breakeven: expected fees == expected divergence at breakevenVolatility
isChargeable(result)        false
```

**The threshold, bisected today rather than recalled.** At T = 365 the first volatility whose call flips
the check is **σ = 0.5639118274086009**, i.e. total variance **σ²T = 116.06874041832731**. Above it every
high-volatility LP question ships this way.

**What a caller sees, and it is worse on the paid surface than the free one.** `src/x402.js`
`isChargeable()` returns `false` on any failed self-check, and `src/app.js` then answers with
`PAYMENT-RESPONSE` carrying `status: "not_charged"` and `reason: "input rejected by engine — no
settlement"`. So a buyer who asks a perfectly ordinary question — an LP position in a 62%-vol asset held
for a year — is told **their input was rejected**, over an answer that is correct, complete, and
delivered. The seller loses the fee; the buyer is told something false about their own request; and the
envelope's `allSelfChecksPass: false` invites a reviewer to conclude the arithmetic is broken, which it
is not.

**The one-line shape of the fix, as this entry predicted it.** Evaluate the check on the unrounded
fraction rather than on the served percentage. That half was right. "It moves the build hash" was not:
it moves the build hash *if you edit the engine*, and nothing forces that.

**What was actually built, 30 July 2026 — `src/util/lpBoundedness.js`, and it is not one expression.**
The check is re-evaluated after the engine returns and before the envelope is built, on the same three
echoed inputs the engine used. Four things had to be true and each was measured:

- **The exact fraction is recomputable from the response.** `E[IL](v) = exp(-v/8) - 1` with
  `v = sigma^2*T`. Verified against a quadrature that does NOT share the engine's `|z| <= 6` window —
  `|z| <= 12`, N = 6000 — worst disagreement **6.88338e-15** at `v = 1.19809e-4` over 401 log-spaced `v`
  in [1e-6, 250], printed by `npm run gate:lb`. The same comparison at the engine's own window gives
  **1.41910e-9** (and **1.41912e-9** at `v = 1.12564` over a wider 20,001-point sweep of [1e-8, 1e4]),
  six orders larger: that is the truncation floor §6 describes, not an error in the closed form.
- **The strict inequality has to be asked in L-form.** Recomputing `E[IL]` and testing `> -1`
  reproduces this very defect one digit lower: at `v = 300`, `exp(-v/8)` is 5.18e-17 and
  `exp(-v/8) - 1` is exactly `-1` in doubles. So the test is carried out on `L = 1 + E[IL] = exp(-v/8)`
  and never on `L - 1`. Measured: the engine's check flips at `v = 116.06874041832731`, this one does
  not flip until `v > 5961.07`, **51× further out**.
- **It is one-way and fail-closed.** A check whose `pass` is not literally `false` is never touched, so
  nothing that passes today can start failing. A failing one is overridden only when the exact fraction
  is inside the interval **and** the recomputation reproduces the 4-dp figure the response published.
  The second condition is what keeps the check able to fail: fed the -135% headline of §C in
  `liveAdversarial.test.mjs`, or the -200% amplified figure of `judgeRound2.test.mjs`, or a positive
  expected divergence, the override is withheld and the check stays red.
- **The failure that remains is real.** Past `v ~ 5961.07`, `exp(-v/8)` underflows to zero, the
  engine's own quadrature has itself saturated to exactly `-1` (measured: from `v = 266.25`), and the
  served `-100%` **is** the boundary rather than a rounding of something inside it. Nothing certifies
  it. `{volatility: 100, horizonPeriods: 1}` still ships `allSelfChecksPass: false` and is still not
  billed, and so does a non-finite variance.

**The residual gap, which is not fixed.** For `v` in
(**116.06874041832731**, **116.06926190819375**) the engine's quadrature rounds to `-100` while the
closed form rounds to `-99.9999`, so the digits disagree, the override is withheld, and the false
failure is **retained** — a band **5.2149e-4** wide in total variance, 1.3e-6 wide in sigma at T = 365.
Its upper end is exactly the `-8*ln(5e-7)` this entry recorded as an unconfirmed prediction; it is now
the confirmed edge of a disclosed gap. 52 sweep points sit inside it and gate LB asserts that all 52
still fail, so the disclosure cannot go stale without going red.

**What it costs, stated because it is caller-visible.** `selfChecks` is inside the contentHash preimage,
so correcting a `pass` moves the hash of exactly the calls that were publishing a false failure —
**741 of 1142** points on gate LB's sweep, and no others (asserted as an equality, not a containment).
The two pinned `lp-risk` fixtures and the Appendix C exhibit `8575ce5a…` are byte-identical. And for a
moved call, re-running `src/engine/lpRisk.js` alone no longer reproduces the response: the corrected
check says so in its own `reEvaluated.reproduce`, a sentence naming the util module is appended to
`proof.reproduce`, and the SDK's `reproduce()` applies the same step so it does not answer
`reproduced: false` on an honest high-volatility response.

**Where it is asserted.** `gates/gateLB-lp-boundedness.mjs` (`npm run gate:lb`) — 12 checks over 1,142
calls across the flip point, the engine-saturation region and the underflow edge, with the closed form
restated rather than imported. `npm run gate:lb-revert` puts the rounded-field comparison back, puts the
subtraction back, drops the fail-closed guard, and unwires the free surface, and requires the gate to go
red naming the case each time.

**A second instance of the same class, found by sweeping for it and also fixed.** `realizedIL`'s
boundedness check has the identical shape and the identical defect: at `priceRatio <= 6.2499999975846693e-14`
(and symmetrically at `>= 1.6e13`) `round(IL*100, 4)` is exactly `-100` and the check fails on a value
whose exact `L = 2*sqrt(r)/(1+r)` is 2.0e-7. Both flips are where the closed form says they are —
`2*sqrt(r) = 5e-7` gives `r = 6.25e-14`. It is corrected by the same one-way rule. Unlike the divergence
half, this conjunct **cannot fail on any reachable input**: `2*sqrt(r)/(1+r) > 0` for every representable
`r > 0`, so what keeps that check honest is the fail-closed digit guard and not the range test. Said
plainly rather than left for a reader to discover.

**A prediction this page is not making.** The closed form of the expectation (see §6) puts the flip at
`−8·ln(5e-7)` = **116.06926190819375**, which is **5.2e-4 away** from the measured 116.06874041832731 —
consistent with the truncation floor of the engine's own `|z| ≤ 6` quadrature window, and *not* an
agreement. A sibling report described that as an analytic prediction of the threshold. It is recorded
here as an unconfirmed one.

---

## 6. The engine's served note calls the leading-order expected divergence a diverging approximation. It is that expectation's logarithm.

**Status: OPEN, and — unlike §5 — this one really cannot be closed outside the hashed tree.** §5's
verdict was a *derived* field, so it could be re-derived after the engine returned. This defect IS the
served string `expectedDivergence.note`, which sits inside the contentHash preimage of every call that
carries a volatility, including the pinned `lp-risk#1` fixture. Rewriting it from outside the engine
would move those hashes to correct a sentence, which is a worse trade than the one §5 made. A
served-text defect, in the engine, and it stays there until the hash is allowed to move.

**What is wrong.** `expectedDivergence.note` reads, on every call:

> "Outside the small-variance regime (σ²T = 22.5): the leading-order −σ²T/8 diverges from the exact
> expectation of impermanent loss, which is what this figure reports, so the exact value is the headline."

Measured against the engine's own published fields over eight (σ, T) pairs spanning σ²T from 0.075 to
259.2, the two numbers are not an approximation and a target. They determine each other exactly:

| what was checked | worst over 8 cases |
| --- | --- |
| `expectedIlPct` against `round((exp(−σ²T/8) − 1)·100, 4)` | **3.96e-5 percentage points**, inside the 5e-5 half-step of the published 4-decimal rounding |
| `approximationGapPct` against `round((e^x − 1 − x)·100, 4)` at `x = −σ²T/8` | **exact to the published digit in 8 of 8** |
| `1 + expectedIlPct/100` against `exp(expectedIlLeadingOrderPct/100)` | **3.32e-7**, pure rounding |

`E[IL](v) = exp(−v/8) − 1`. So `−v/8` is not a small-variance expansion that leaves its valid range; it
is `ln(1 + E[IL])`, everywhere, and the "approximation gap" the service publishes beside it is exactly
`e^x − 1 − x` — a quantity that says nothing about the accuracy of anything. The engine's own
`E[IL] check: −σ²T/8 == numerical E[IL] at σ²T = 0.01` passes for that reason, and was read twice as
evidence for the opposite conclusion.

**What a caller sees.** A true statement about the two numbers' *difference* wrapped around a false
suggestion about their *relationship*, and a field named `approximationGapPct` that is not a measure of
approximation error. Nobody is given a wrong number. A quantitative buyer who takes the note at face
value will mistrust the headline in exactly the regime where it is exact.

**Why it is not being fixed.** `src/engine/lpRisk.js`. Same hash, same freeze, same decision as §5.

---

## 7. `gateB6` recorded "the contract picks the right leg" as PASS while ranking by liquidation price, against its own copy of that rule

**Status: FIXED, 30 July 2026 — by deleting the claim rather than by changing the ranking, which is the
part worth reading.** The record of what it published is kept below.

**What was wrong, in two layers.** The on-chain router the gate deploys keeps the smallest
`signals[i][PRICE_INDEX]` with `PRICE_INDEX = NPUB − 1`, which for `liquidation.circom` is `pLiqHat` —
**the liquidation price.** `portfolio-gate` reports the leg nearest to liquidation, which
`src/engine/portfolioGate.js:107` selects by `moveToLiqPct`, the adverse move from the mark, and whose own
published self-check asserts *"nearestLiquidation is the true minimum distance-to-liq across the LIVE
legs"*. Those are different answers. On the gate's own eleven-leg book, priced through the real engine:

| ranking | leg | adverse distance | liquidation price |
| --- | --- | --- | --- |
| distance (`moveToLiqPct`, the engine's) | **10** | **6.103%** | $300.47 |
| liquidation price (`gateB6`'s router) | 3 | 24.089% | $0.4706 |

The router named a leg **3.95× further from liquidation** than the binding one, and this is what the gate
wrote beside it:

```
[PASS] the contract picks the right leg
         leg 3, price 0.470647773
```

The second layer is why it stayed green for a day. The expectation was built by
`prepared.reduce((a, b) => (BigInt(b.sigs[NPUB - 1]) < BigInt(a.sigs[NPUB - 1]) ? b : a))` — a
price-minimum in JavaScript, compared against a price-minimum in Solidity. **The check could not fail on
the error it was about**, however wrong the ranking was, because both sides implemented the same wrong
rule. A verifier that cannot fail, in the gate whose subject is the correctness of an answer.
`portfoliogate.circom`'s own header had said so in writing since the circuit was built.

**What fixed it, and why not the obvious thing.** Ranking correctly on chain is **not available**, and
the reason is structural rather than lazy: `liquidation.circom` publishes eight signals — residual,
tolerance, `mHat`, `qHat`, `p0Hat`, `s`, `mmrHat`, `pLiqHat` — and **none of them is the mark** the engine
measures distance from. Substituting `p0Hat` looks free on this book, because no leg here carries a
`markPrice` and the engine then falls back to entry; the gate now measures what that substitution does the
moment one leg is marked, and the two rankings part company. A router that is right only for markless
books, with nothing in the proof saying which kind of book it was handed, is a worse defect than the one
being repaired.

So the claim was deleted instead. `gateB6` now asserts what it actually measures — that the contract
returns the smallest **certified liquidation price**, checked against the engine — plus, as checkable
assertions rather than footnotes, that `liquidation.circom` publishes neither the mark nor the distance,
that the price minimum is **not** the book's binding leg, and that the engine's own binding leg is the
distance minimum. `B6_REVERT=binding` puts the deleted claim back verbatim and the gate goes red. The gate
that answers the portfolio question is `gateB10-portfolio-perleg.mjs` over `portfolioleg.circom`, which
publishes the distance numerator and the mark as signals of its own and ranks by cross-multiplication.

**What a caller saw.** Nothing: no portfolio circuit is reachable from a served response (§10), so the
router was never in front of anybody. What it cost was a green gate cited as evidence that the
per-leg-plus-on-chain-minimum shape works. A router that verifies eleven real proofs and returns the wrong
leg is the most expensive failure mode available to a service whose product is "the risk math was
checked" — every proof valid, every signature recovering, and the answer wrong.

---

## 8. The gate that certifies the published clone is self-sufficient kept a list of fourteen circuits and missed `liquidation` — and the clone really is missing it

**Status: FIXED, both halves, 30 July 2026. The gate was repaired first and the artifacts it named were
shipped afterwards, in two steps; the file-by-file measurement is in the last section below.**

<!-- Careful with the wording of the line above: gate N decides open from fixed with /\bopen\b/ over the
     Status text, so the first draft of this line said "see what closed the open half below" and was read
     as OPEN despite starting with FIXED. The detector is a substring match and other sections depend on
     it, so the wording moved rather than the check. -->


**What was wrong.** `zk/scripts/gate-clone-portability.mjs` checked six artifacts per circuit from a
hardcoded `CIRCUITS` array. Measured against what is compiled:

```
listed  (14): kelly, concentration, divergence, constantproduct, padprobe, greeks, greeksfp,
              greekssigned, parity, portfoliogate, kellybatch1..4
compiled(21): the above, plus execadverse, liquidation, lpbracket, lpexpectation, ncdf,
              portfoliogate4, portfolioleg
```

Seven circuits had no portability verdict, and one of the seven was `liquidation` — the flagship, the
circuit a paying `perp-gate` caller's proof is built and checked against, the one the paper's Appendix C
exhibit and both on-chain registry transactions are about. The gate's own comment says a list that is
accidentally empty checks nothing and reports PASS. The same is true of a list that is accidentally short,
and this one was short by exactly the entry that would have gone red.

**What fixed the gate.** The circuit set is now **discovered from `circuits/` on disk** rather than listed,
with a floor (22 `.circom`, 21 with a `component main`) so coverage cannot silently shrink, and every
circuit is either fully checked or **named in an exclusions table whose reason is re-measured on each run**
— `kellybatch` has no `component main`, `lpexpectation` cannot have a zkey on a 4,096-gate domain at 36,613
constraints, `portfoliogate4` needs 2^13. Section 3 of the same gate had discovered its gates from disk all
along and said so in its own comment; section 1 kept a list and regressed. It also now asserts the
verification-key filename mapping the service actually serves, which is where the `vk_plonk.json` exception
in §12 was found.

**What is still open, and it is now measured from the clone rather than argued about.** Run from
`Quiver/`, the repaired gate goes red and names what is absent:

```
[*** FAIL ***] every artifact a gate needs is present in this checkout
         5 missing:
         build/liquidation.r1cs
         build/liquidation_plonk.zkey
         build/vk_plonk.json
         build/liquidation_js/liquidation.wasm
         build/liquidation_js/witness_calculator.cjs
```

`zk/scripts/gateB6-portfolio-routes.mjs` is the one gate that proves against `zk/build/liquidation_*`, so it
was the one gate that could not run from a clone at all — a harder failure than the seven `evmRehearsal`
gates that stop for want of `solc`.

**What closed the open half, 30 July 2026, measured one artifact at a time rather than as a group.** The
five were not all shipped at once and saying "fixed" without the breakdown would have hidden that. Asked of
`git ls-files` at HEAD, not of a directory listing:

| artifact | shipped by | bytes |
|---|---|---|
| `build/liquidation.r1cs` | `ddcc434`, the commit that repaired the gate | 107,920 |
| `build/liquidation_plonk.zkey` | this change | 5,436,000 |
| `build/vk_plonk.json` | this change | 2,043 |
| `build/liquidation_js/liquidation.wasm` | this change | 47,368 |
| `build/liquidation_js/witness_calculator.cjs` | this change | 10,356 |

So `ddcc434` closed **one of five**, and the register said "the 5 missing artifacts are still missing" while
one of them was already in the clone. `gate:n` is the gate that caught that, by going red on a stale
disclosure, which is what it is for. 5.5 MB is well inside the convention this repository already keeps:
four zkeys it tracks are larger, the largest being `greekssigned_plonk.zkey` at 24,672,856 bytes.

**A second circuit set arrived in the same window.** `lpclosed` and `lpclosed2` were compiled on 30 July,
which briefly made this gate red on `[lpclosed,lpclosed2]` rather than on `liquidation` — a true report of a
different fact. Both `.r1cs` are now in the mirror, along with `hez_final_13.ptau` (9,520,280 bytes), which
`lpclosed` needs because it is 7,471 Plonk constraints and `hez_final_12` refuses it outright.

**And the gate still cannot be run to completion.** It spawns every discovered `gate*.mjs` with a
300-second cap and fully buffered output, so a full run is structurally hours. The flag meant to shrink the
gates for it, `QUIVER_GATE_PORTABILITY_PROBE`, appears in **exactly one file in the tree — the gate
itself.** It is dead, which is why nothing shrinks.

**What a caller sees.** Nothing: the live service does not read `zk/build`. Its proving artifacts are
`assets/zk/liquidation_plonk.zkey`, `assets/zk/liquidation_js/` and `assets/zk/vk_plonk.json`, all tracked
in git and all checked at deploy time by `preflight.mjs`. **The live paid path is unaffected and is not in
doubt.** What is affected is the claim a reviewer will actually test — clone the repository, run the gates,
reproduce the numbers — and for the flagship circuit the artifacts to do that are not in the clone.

---

## 9. Every gas figure the four Phase B reports published disagreed with the artifact that measured it — and every disagreement was smaller than the noise

**Status: FIXED on 30 July 2026, hours after it was found, and the fix is better than a correction.**
The record of what was published is kept because the *shape* of this defect is the interesting part: not
one wrong measurement, but a noisy quantity published to six significant figures and then subtracted from
another sample of itself.

**What was wrong.** Seven figures across the four Phase B reports — `verify-exec-verify.md`,
`verify-lp-risk.md`, `verify-options-risk.md`, `verify-portfolio-gate.md`, and their `VERIFY_*.md` twins in
the submission tree — each read against the JSON on disk that produced it. Every pair differed. These are
the retracted figures, quoted rather than deleted:

| quantity | the document said | the artifact held |
| --- | --- | --- |
| `constantproduct` accept, gate B5-2 | "276,892" | 273,564 |
| `execadverse` accept, gate B5-5 | "279,280" | 281,984 |
| `execadverse` marginal over the benchmark | "**+2,388 gas (+0.9%)**" | 6,340 |
| `lpbracket` accept, gate LP0 | "277,953" | 278,051 |
| `ncdf` accept, gate B7-5 | "272,672" | 273,406 |
| the 11-leg per-leg route, gate B10 | "2,968,446" | 2,969,816 |
| the wide 3-leg verifier, gate B8-2 | "291,708" | 292,124 |

**The mechanism was visible in the timestamps.** Gate B5-5 wrote its artifact four seconds before gate
B5-2 wrote its own, and B5-5 computes the marginal by reading B5-2's file off disk — so the two terms of
one published difference came from two different runs. That single quantity has now been published as
**"2,388"**, **"3,318"**, **"6,340"** and **"8,420"** with nothing in the circuits having changed between
them.

**And the deeper half, measured today.** Plonk verify gas is not deterministic. Across twelve proofs of one
identical `liquidation` statement the spread is
3,022 gas <!--gas:probe-direct-vs-snark-gas#spread.gas--> — 1.1% of the mean — and the first call in an EVM
instance costs **7,500 gas** more than every later one (EIP-2929: three cold precompile accesses at 2,500
apiece). `probe-plonk-gas-variance.mjs`, re-run for this page against `kelly`, prints the same shape at
1.34%. A sibling's
`probe-execadverse-marginal.mjs` puts 25 proofs through each of two circuits in a fresh EVM per sample and
measures spreads of 3,438 <!--gas:probe-execadverse-marginal#constantproduct.spread--> and
4,466 gas <!--gas:probe-execadverse-marginal#execadverse.spread-->. **Every one of the six single-verifier
disagreements above is inside that band** — the largest, 276,892 against 273,564, is 1.22% out, and the
smallest is 98 gas. So none of them was a wrong measurement. All of them were legitimate samples published
as though the digits meant something. The seventh row is the marginal, and it is worse than stale: its
3,952-gas disagreement sits inside the measured
7,904-gas <!--gas:probe-execadverse-marginal#marginal.oneShotWindow--> window that a one-shot marginal can
land anywhere in — a window **twice the width of the quantity being measured**.

The honest marginal, as a difference of means over 25 proofs each, is
**+3,815 gas** <!--gas:probe-execadverse-marginal#marginal.meanMinusMean--> with a standard error of 288
and a 95% interval of 3,251 <!--gas:probe-execadverse-marginal#marginal.ci95Low--> to
4,379 <!--gas:probe-execadverse-marginal#marginal.ci95High--> — about
763 gas <!--gas:probe-execadverse-marginal#marginal.gasPerExtraPublicSignal--> per extra public signal.

**What a caller sees.** Nothing. No served field carries any of these numbers; they are figures in
verification reports, and the reports' conclusions do not turn on them. What a reviewer sees is the
project's own discipline failing in its own reports, in the exact class of defect `circuit-facts.mjs` was
written to kill for constraint counts.

**What closed it, and why it is more than a correction.** `tools/docs-consistency.mjs` — which on the
morning of 30 July passed over the whole corpus without ever looking at a gas number — now reads every
`<!--gas:ARTIFACT#FIELD-->` citation against the artifact it names, and requires one on every verify-scale
gas figure in a gate report. Deterministic quantities are held exactly; a single verify-gas sample may
carry a stated tolerance up to 5%, past which the citation "cannot fail" and is itself the finding. The
figures in this section carry those citations, which is why they can go stale loudly. The remaining hole
is stated by the rule's own author: 39 documents in this corpus publish a verify-scale gas figure and only
the report class is held to citing one — `assets/whitepaper.*` among them, and frozen.

**One figure this section will not restate.** `zk/scripts/lib/gas-facts.mjs` describes the spread as
"3,328-gas, 1.26%". Today's four runs measured 1.10%, 1.24%, 1.34% and 1.59% of their means, on three
different circuits. The noise floor is itself a sample, and a six-figure literal for it in a comment is
the same defect one layer up.

---

## 10. Three of the four circuits built this round are still unreachable from a served answer

**Status: OPEN for one of the four — read the table below rather than this line for the count.**
`execadverse` was wired on 30 July, hours after this entry was written, and `lpbracket` and `ncdf` the same
day; the count in the heading above is what it was when the entry was opened and is left there
deliberately, because a heading that keeps getting quietly re-numbered is how a register stops being a
record. **`portfolioleg` is the only one left.** The `ncdf` row below said "no" from `be0d4c9`, the commit
that wired it, through **both** later edits of this page — `ea69ea3` and `3c73436` — each of which corrected
other rows of this same table and left that one. The §10 test predates the wiring, so `gate:n` was red on
this row for every commit in between; no count of them is given here because it grows with every sibling
commit and would be stale before it was read. **The gate was working and nobody was running it**, which is
the one failure this page has no rule against: a red gate nobody runs costs exactly what a green gate that
cannot fail costs. The entry is kept and
corrected rather than replaced — the interesting part is that the gap
existed at all and closed in one afternoon once someone owned it.

**What is wrong.** `portfolioleg`, `execadverse`, `lpbracket` and `ncdf` are compiled, have Plonk zkeys,
have exported Solidity verifiers, and have gates that pass. `src/util/proverWorker.mjs` names a closed set
of circuits and refuses anything else rather than joining a caller's string onto a filesystem path, and
that set decides what a response can carry:

| circuit | built and gated | reachable from a served answer |
| --- | --- | --- |
| `execadverse` (exec-verify) | yes | **yes, since 30 July** — `snark: true`, both surfaces, `/proof/vk/execadverse` |
| `portfolioleg` (portfolio-gate) | yes | no |
| `lpbracket` (lp-risk) | yes | **yes, since 30 July** — `snark: true`, both surfaces, `/proof/vk/lpbracket` |
| `ncdf` (options-risk) | yes | **yes, since 30 July** — `snark: true`, both surfaces, `/proof/vk/ncdf`; also serves `event-vol` |

**What this entry said before `execadverse` landed**, kept because the sentence was true when it was
written and is the reason the entry exists:

> "A caller who asks `exec-verify` for a proof of the basis-point number it sells does not get one, and
> cannot: there is no `snark` option on that service."

There is now. `preflight.mjs` prints four proof-emitting services against 23 of 31 handlers that build no
proof, and `src/services.js` publishes a `proves` string for the new one naming all three nested
statements and the tolerances each carries.

**What a caller sees.** For the ones still unwired, nothing: they answer with no proof and no `snark`
option. The four Phase B reports each open with `buildable-and-built`, which is true and is not the same
sentence as "wired" — and a reader who moves from `verify-lp-risk.md` to the live endpoint will find that
gap themselves. Better that they find it here first.

**`lpbracket` closed on 30 July and its residue was published rather than resolved.** The wiring is in
`src/util/lpBracket.js` and `src/util/snark.js`; `wire-lp-risk.md` is the write-up. The residue this
entry predicted — "certifies a bracket around two quadrature values it takes as public inputs and
certifies neither" — is exactly what the response's `doesNotProve` now says, in those terms, with the
two assumed integers among the public signals and a one-line closed form (`L = exp(-v/8)`) beside them
so a reader can check what was assumed. Naming the residue is not removing it: the percentage `lp-risk`
leads with, `expectedDivergence.expectedIlPct`, IS the assumed quadrature and is not proven. The circuit
that would prove it, `lpexpectation.circom`, is 36,613 constraints against the 4,096 `hez_final_12`
allows — 8.94× over, needing `powersOfTau` 16 or 17 — so that half is blocked on a ceremony file and not
on a wiring.

**Why the remaining three are not fixed.** Wiring is not a document change: each circuit needs a witness
builder on the request path, a refusal by name for inputs outside its domain, a grid decision made on
purpose rather than inherited, and its own gate — which is what the `execadverse` wiring took. Two of the
three also carry a residue that wiring would publish: `lpbracket` certifies a bracket around two
quadrature values it takes as public inputs and certifies neither, and `ncdf` pins a CDF at a point the
caller supplies rather than at a `d1` derived from `(F, K, T, σ)`. Each would have to say so in its own
`doesNotProve`.

---

## 11. Two shipped circuit headers claim more than the circuits prove, and both over-claims were demonstrated with accepted proofs

**Status: OPEN, unpatched, and each is a change with its own gate.**

**What is wrong.** `zk/circuits/parity.circom`'s header says:

> "Parity is not: it ties a call to a put at the same strike, so a price that drifts on one side and not
> the other fails here."

It cannot. In Black-76 the put is not an independent quotation, and for **any** `N` with
`N(−x) = 1 − N(x)` — which every tail-plus-branch implementation has, and the engine's `ncdf` has by
construction, returning `x <= 0 ? c : 1 - c` — the CDF cancels out of `C − P = df·(F − K)` algebraically.
A whole book repriced with Abramowitz-Stegun 7.1.26, wrong by $0.004763 on a $2,688 call, produces a
`parity` witness that verifies. Parity is not a weak check on the price level; it is not a check on the
price level at all. The same header carries a second sentence that has been false since 30 July —
*"That residue is unchanged and stays until erf is provable"* — because `ncdf.circom` now computes the
CDF, and the engine never computed `erf` in the first place.

`zk/circuits/greekssigned.circom:26` says identity A, `d1 − d2 = σ√T`, is *"proven here as a by-product
rather than as a separate statement"*. `dDiff` appears in exactly one constraint and nothing ties it to
σ or T, so a compensating power of ten in two alignment exponents leaves every mantissa identical:
moving `vannaE` 11→10 and `dDiffE` 9→10 yields an accepted proof asserting a `vanna` ten times the
engine's and a `d1 − d2` one tenth of `σ√T`.

**Provenance, stated.** Both over-claims were demonstrated with real accepted Plonk proofs by the
`options-risk` investigation; **this session re-measured that the two sentences are still in the two
files, and did not re-forge the proofs.** The algebra behind the parity claim is checkable by hand in two
lines and was.

**What a caller sees.** Nothing yet — neither circuit is wired (§10). What a reader sees is a false
sentence in the file that is supposed to be the trust root, in a project whose `perp-gate` precedent is a
published `proves` / `doesNotProve` pair. Shipping that pair with these headers would put a false claim in
front of a buyer, which is the reason both circuits are named here before either is wired.

---

## 12. Three constants inside the trust root contradict the code beneath them

**Status: OPEN, unpatched. Each is a comment, and each is the kind of comment a reader would act on.**

- **`zk/circuits/portfoliogate4.circom:220`** reads
  `// Result: 1,989 non-linear + 64 linear R1CS, 3,970 Plonk, domain 4,096 — 126 gates of slack.` Those
  are the **N = 3** figures. The circuit is N = 4 and its own `.r1cs` header measures **2,736**
  constraints, needing domain 8,192 under Plonk. `diff` against `portfoliogate.circom` shows the only
  differing line is the parameter. A reader sizing a 4-leg build from that comment fetches the wrong
  ceremony file.
- **`zk/scripts/gen-ncdf-circom.mjs:3`** says the circuit needs "208 exponential constants and 15
  polynomial coefficients". Counted in the emitted circuit: **192** exponential constants — 12 `Mux4`
  groups × 16, and 192 `.c[i] <==` assignments — plus 15 coefficients plus `SQRT2PI` is 208 *in total*.
  The circuit's own line 130 says 192 and the generator's `console.log` prints 192, so line 3 contradicts
  the code beneath it in the file the review calls the trust root.
- **`vk_plonk.json`** is the `liquidation` verification key. Every other circuit here uses
  `<name>_vk.json`, and there is no `liquidation_vk.json`, so a reader following the convention finds
  nothing and a script following it throws. `preflight.mjs` carries the exception explicitly in its
  artifact list, which is where it was found. **This one is now held rather than merely irregular**: the
  repaired `gate-clone-portability` (§8) asserts the filename mapping the service actually serves, so the
  name cannot drift from `/proof/vk` without a gate going red. The irregularity stands; the trap is closed.

**What a caller sees.** Nothing. These are read by the next person to build on the circuits, which is
precisely who this project asks to check its work.

---

## 13. The four refutations that redirected this round's work are not reproducible from this repository

**Status: OPEN, partly repaired while this page was being written.**

**What is wrong.** Four adversarial passes overturned four "cannot" verdicts, and their conclusions now
steer decisions: that a 4-leg portfolio circuit fits the ceremony file on disk under Groth16, that
`E[IL] = exp(−σ²T/8) − 1` in closed form, that the exec-verify statement has a Poseidon-committed variant
where every input is private, that a leg price needs two proofs rather than a bigger circuit. Measured in
this checkout:

| | |
| --- | --- |
| adversary circuit sources rescued out of temp into `zk/circuits/adv/` | **38 files**, including `lpclosed2`, `xacommit`, `xamin`, `pg4`–`pg7`, `price40`, and `ncdfonesided` |
| of those, **committed** to the published repository | **38 of 38** — `git ls-tree -r --name-only HEAD zk/circuits` returns **60** paths, **38** of them under `adv/`, and those 38 names are the same 38 that are on disk. |
| of those, with a compiled `.r1cs` **committed** anywhere under `zk/build` | **2 of 38** — `lpclosed` and `lpclosed2`, committed 30 July with `hez_final_13.ptau`, so those two ARE rebuildable from a clone. It was **0 of 38** until then. One further circuit is built and not committed: `ncdfonesided`, at `zk/build/adv/ncdfadv/ncdfonesided.r1cs`, **uncommitted**, three directories below where every other circuit's artifact lands. It exists on one machine and in no clone, which is the exposure this whole section is about. The rule behind this row was a flat `existsSync` in `zk/build` and could not see the nested file, so it reported "no adversary artifacts" — absence read off a search that did not recurse is not absence, and it is now asked of git for the count and of the whole build tree for the name. |
| Plonk zkeys for any of them | **0 of 38 committed**; 2 of 38 exist on this desk uncommitted (`lpclosed_plonk.zkey` 16,604,080 bytes, `lpclosed2_plonk.zkey` 8,293,092). Those two are in a materially different position from the other 36 and it is worth saying why rather than lumping them in: their `.r1cs` and the `hez_final_13.ptau` they need are both committed, so a clone REGENERATES them with one `plonk setup` in about 930 ms measured. The other 36 have no committed `.r1cs`, so no clone can rebuild them at any price. Asked at every depth under `zk/build`, and for `_plonk.zkey`, `.zkey` and `_final.zkey` |
| powers-of-tau files on disk | **2**, both power 12, 4,801,688 bytes each |
| the locally generated 2^13 and 2^17 ceremonies those builds used | **absent** |

**Three different quantities, because one number was wrong in every reading.** *Committed*, *compiled* and
*has a proving key* are three different states and this row published one figure for all of them. The
sources are in the repository. **Nothing built from them is**: zero compiled artifacts and zero proving keys
are committed, so **no refutation can be re-derived from what is published** — which is the defect, and it is
not the same sentence as "the sources are lost". The single `.r1cs` that exists at all is uncommitted and is
the only artifact of any of these builds still on this machine; it is named in the row above rather than
counted in it, because a figure that changes depending on which working tree you ask is not a figure a
reviewer can use.

**What this row said, twice, and why the second version was worse than the first.** It is kept because a
register that deletes its corrections is not a register:

> First: `| of those, present in the published repository | **0** — git ls-files zk/circuits returns 22
> paths and none is under adv/ |`
>
> Then: `| of those, present in the published repository | **37 of 38** — git ls-files zk/circuits returns
> 59 paths and 37 are under adv/ |`

The **0** was true when written and went stale when commit `620c041` committed the rescue. The **37 of 38**
is the interesting one: the commit that wrote it, `ea69ea3`, **added the 38th file in the same commit**. The
number was measured before the file was staged and was therefore false the moment it landed — and the cell
said so itself two sentences later, that `ncdfonesided.circom` was "added 30 July and committed with the
change that made it necessary". A cell that contradicts its own count in its own second sentence is not a
transcription slip; it is a measurement taken against the working tree and published as a fact about the
repository. Both versions were wrong in the same direction, understating what is published, which is the
harmless direction for a reader and the dangerous one for a checker: it is the direction a gate that reads
the working tree can never see.

`ncdfonesided.circom` is `ncdf.circom` as it stood before the range check on its shifted CDF residual was
restored, kept so `gateB7-5` §0 and `revert-ncdf-twosided.mjs` can show a claimed at-the-money call delta of
1.0 SATISFYING a constraint system rather than describe it. A defect demonstrated against a file that only
exists in one working tree is the exposure this section is about, so that one is not left there.

So the sources survived the session that produced them **and are now under version control**. Most of the
artifacts they were measured with are still absent, and every gas figure, prove time and constraint count
attributed to those builds still rests on a single run by the party that benefits from it.

**Two of the thirty-eight stopped being in that position on 30 July, and the ceremony sentence here was
wrong within a day of being written.** It said "no `.r1cs`, no zkey, and no ceremony file above power 12".
Measured now: `lpclosed.r1cs` and `lpclosed2.r1cs` are committed, and `hez_final_13.ptau` (9,520,280 bytes,
power 13, domain 8,192) is committed beside them, which makes three ceremony files in `zk/build` rather than
two. `lpclosed` needed it: 3,854 R1CS becomes 7,471 Plonk and `hez_final_12` refuses it in as many words,
"circuit too big for this power of tau ceremony. 7471 > 2**12". Those two are rebuildable from a clone.
The other thirty-six are not, and that is what remains open here.

**And nobody has attacked the new claims.** Four investigations were adversaried; the four adversaries
were not. Two of their own results are known to be shaky and were left that way: a breakeven probe that
refused 2 of 8 cases on a tolerance its author did not fix, and a Monte Carlo third confirmation
discounted at 16 standard errors — so the closed form has two independent confirmations rather than three.

**What a caller sees.** Nothing. This is a claim-quality defect, and it is the one that most directly
contradicts what this project sells: re-derive it yourself. For these four results, today, you cannot —
not without regenerating a ceremony file, which takes 55 seconds offline for 2^13 and about eleven
minutes for 2^17, and which is a decision about what counts as a valid ceremony rather than a build step.

**Why it is not fixed here.** Rescuing the artifacts means running the builds, which means generating
ceremony files, which is decision 2 on the list in `phase-b-verified.md` §8 and is Tristan's to make.
Copying the probe scripts is minutes of work and the sources are already in; the ceremony question is not
an agent's to answer.

---

## How to reproduce §1 and §3, and what the live service answers today

**This section is about the two input-handling defects only**, and it was titled *"How to reproduce
anything on this page"* until 30 July, when ten sections were added that it does not cover. Each of
§4–§13 carries its own reproduction inline, and `npm run gate:n` re-measures all of them at once.

§1 and §3 are reachable free, unauthenticated, with no key and no payment, over the MCP endpoint:

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
