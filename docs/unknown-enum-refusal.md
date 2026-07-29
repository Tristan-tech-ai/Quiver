# `side: "banana"` — refused, outside `src/engine/`, with the build hash unmoved

**29 July 2026.** The engine build is `q1-e1fa99d08887d6cc` before this change and
`q1-e1fa99d08887d6cc` after it. `diff -rq src/engine ../../Quiver/src/engine` reports the directory
identical. The whole change is `src/util/repair.js`, `src/services.js` and `src/mcp.js` — the same
three files the case-sensitivity work used, and none of them hashed.

Every number here was measured twice: once against the unmodified Quiver mirror (which was the
pre-change tree at the moment of capture) and once against this one, and written down second.

---

## 1. The hypothesis, and whether it held

**It held.** `CASE_SENSITIVITY_FIX.md` §5 recorded the residue as needing an engine change:

> Closing that requires `perpGate.js:29`, `portfolioGate.js:30` and `optionsRisk.js:32` to **refuse**
> an unrecognised value, which is inside `src/engine/` and moves `q1-e1fa99d08887d6cc`.

That reasoning was wrong about *where the line had to be drawn*, in the same way §1 of
`KNOWN_DEFECTS.md` had been wrong once already. `repair.js` will not coerce `"banana"` to a nearest
neighbour, and it should not — guessing invents a value the caller did not write. But **refusing
invents nothing**, and refusing happens at the validation layer, which is outside the hashed tree.

The engines still read anything unrecognised as the riskier default. They are simply never reached.

---

## 2. What was measured before the change

Nine declared enum fields across six services, seven illegal values each — a typo, a truncation, a
doubled letter, a trailing space, the empty string, the word `"null"`, and a nonsense word — driven on
both surfaces. **All 63 rows were SERVED. Not one was refused.**

### `perp_gate` — `{side, entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000}`

| sent `side` | before: HTTP | before: free MCP | after (both) |
| --- | --- | --- | --- |
| `"banana"` | long · 91,139.24 · `81c536a46683` | identical | **refused** |
| `"lng"` | long · 91,139.24 · `9208665deed0` | identical | **refused** |
| `"p"` | long · 91,139.24 · `7c20a49e0644` | identical | **refused** |
| `"SHORTT"` | long · 91,139.24 · `d59a78ec3ea6` | identical | **refused** |
| `""` | long · 91,139.24 · `927d519819d7` | identical | **refused** |
| `"long "` | long · 91,139.24 · `5a8fbe37d6fe` | identical | **refused** |
| `"null"` | long · 91,139.24 · `1c129f4d7236` | identical | **refused** |

Every one of those content hashes is a **distinct signed artifact** attesting a long position to a
caller who never wrote the word "long". Every self-check passed in every row, because a self-check
verifies the book the engine chose, not the book the caller described.

### `portfolio_gate` — a perfectly hedged book, one long and one short, same asset, size and price

| leg 2 `side` | before | after |
| --- | --- | --- |
| `"short"` (correct) | net 0 · long 100,000 · short 100,000 | unchanged |
| `"banana"` | **net 200,000 · long 200,000 · short 0** | **refused** |
| `"lng"`, `"p"`, `"SHORTT"`, `""`, `"long "`, `"null"` | all net 200,000 | all refused |

### `options_risk` — `{forward: 100000, positions: [{type, strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1}]}`

| sent `type` | before | after |
| --- | --- | --- |
| `"banana"` and the other six | **call · delta +0.319866** | **refused** |

### The other six fields

`perp-gate.venue`, `portfolio-gate.betaTier`, `poly-fill.action`, `options-desk.focus`,
`chart-press.quality`, `chart-press.theme` — all seven illegal values accepted on the HTTP surface
before, all refused after. `poly-fill`, `options-desk` and `chart-press` have no MCP tool.

---

## 3. Where the fix lives, and the fourth site

The route exists on both surfaces, and it is **not the same line on each**:

| surface | file:line | what closes it |
| --- | --- | --- |
| paid `/api/*` | `app.js:548` — `s.validate(raw)` | the wrapper at the foot of `services.js` |
| gated `/diag/scan` | `app.js:410` — `svc.validate(body)` | the same wrapper |
| gated `/diag/scanpost` | `app.js:425` — `svc.validate(body)` | the same wrapper |
| **free MCP** | `mcp.js` `handleRpc` — **never calls `validate()`** | an explicit guard in `mcp.js` |

`handleRpc` hands `repairBody` the `SERVICES` entry and then calls `tool.run(args)`. There is no
validator on that path at all, which is exactly why an enum declared only in `mcp.js` was decoration
before — and exactly why a guard written only in `services.js` would have left the **free** surface,
the one a builder and a judge try first, still answering `side:"banana"` as a long while every paid
check went green. That is the fourth-site miss this repository has now made repeatedly, and
`gates/gateU-revert.mjs` revert 2 (`NOGUARD-MCP`) is the scripted demonstration that the gate catches
it: services.js keeps its wrapper, only `mcp.js` loses the guard, and gate U goes red on tests 3, 4
and 6 while `preflight` and `gateBuyer` both stay green.

`app.js` was not touched. It did not need to be: three of the four sites already funnelled through
`s.validate`, so one wrapper closed all three.

### The mechanism

`src/util/repair.js` gains `enumViolations(service, body)` and `enumRefusal(violations)`. The first is
the **exact complement of step 6** of `repairBody`: the same case-insensitive comparison against the
same declared set, top level and one array-item level deep, strings only. A value step 6 could repair
can therefore never be one the guard refuses — the two halves of the file cannot disagree about what
"matches a declared alternative" means. Gate U test 5 asserts that as a property rather than trusting
it.

Three limits, each deliberate:

- **Case-insensitive.** A guard stricter than the repairer would refuse values the repair layer
  considers legal. It also means the gated `/diag/*` testers, which do not call `repairBody` at all,
  behave exactly as they did before.
- **Strings only.** `perpGate.js:29` honours the **number** `-1` as short; that is not a declared
  alternative and refusing it would break a request that answers correctly.
- **Top level plus one array level.** `positions[1].side` and `positions[0].type` are two of the three
  fields that carry direction and neither is top-level.

---

## 4. What a caller now sees

### Paid HTTP — `POST /api/perp-gate` with `{"side":"banana", …}` → **400**

```json
{
  "error": "bad_input",
  "detail": "unknown value for \"side\": \"banana\" is not one of \"long\", \"short\", \"buy\", \"sell\", \"-1\" (this service says: long | short (buy | sell are accepted synonyms, as is -1 for short); default long) — compared case-insensitively against the alternatives this service declares. Nothing was computed and you were not charged: an unrecognised value used to be served as the engine default, which answered a different position than the one described. Send one of the listed values. | perp-gate — Perp liquidation price, distance-to-liq & funding drag …",
  "howToFix": {
    "missing": [],
    "send": { "method": "POST", "url": "/api/perp-gate", "body": {
      "side": "<one of: long | short | buy | sell | -1>",
      "entryPrice": 100000, "size": 1, "leverage": 10, "maxLeverage": 40, "markPrice": 100000
    } },
    "note": "Send the body above to /api/perp-gate. Replace \"side\" with one of the values shown."
  }
}
```

Three things the old answer did not have: the field is **named** (`positions[1].side` for an array
leg, not just "side"), the legal values are **listed**, and the corrected body has the offending value
replaced with a placeholder rather than echoed back — a "corrected" body that reproduces the refusal
is not a correction.

### Free MCP — `tools/call perp_gate` with the same arguments → `isError: true`

```json
{
  "ok": false,
  "errors": ["unknown value for \"side\": \"banana\" is not one of \"long\", \"short\", \"buy\", \"sell\", \"-1\" …"],
  "unknownEnumValues": [{ "path": "side", "sent": "banana", "allowed": ["long","short","buy","sell","-1"], "hint": "long | short …" }],
  "howToFix": { "missing": [], "send": { "method": "POST", "url": "/api/perp-gate", "body": { … } }, "note": "…" }
}
```

**The sentence is built by one function and used by both**, so the free surface and the paid one
cannot drift into describing the same refusal two different ways.

### It is free

`isChargeable()` (`x402.js:31`) returns `false` for `ok:false`, which is what the MCP shape carries.
On the paid path the refusal is thrown with `status = 400` from inside the handler, and `x402.js:255`
returns it **before** `/settle` is ever reached — the same path every other `bad_input` refusal takes.
Asserted on the wire in `gateP` (`status 400`, `billed: false`) and as a rule in gate U test 6.

---

## 5. Proof that nothing legal moved

The strongest available control: the **Quiver mirror**, whose `src/` differed from this tree in
exactly the three files this change touches and nothing else, with `src/engine/` identical. A capture
script drove **every declared value of every declared enum, in every casing a caller might write it**
(`long`, `LONG`, `Long`, `lOnG`), on both surfaces, recording the validated input, the repairs
reported, the served answer and the content hash. Run against both trees and diffed:

```
$ diff before.txt after.txt
200a201,205
> perp-gate side = "-1" (legal "-1") | HTTP-INPUT   {"side":"-1", …}
> perp-gate side = "-1" (legal "-1") | REPAIRS      []
> perp-gate side = "-1" (legal "-1") | HTTP-HASH    ca717a01b637a9137bcd619b961867ccc479b156f2057297ac9e7daa2fc8b98b
> perp-gate side = "-1" (legal "-1") | HTTP-ANSWER  108641.98
> perp-gate side = "-1" (legal "-1") | MCP isError=false hash=ca717a01b637a9137bcd619b961867ccc479b156f2057297ac9e7daa2fc8b98b
381,382c386,387
< TOOLS/LIST BYTES 29800          > TOOLS/LIST BYTES 29945
< TOOLS/LIST perp_gate inputSchema 1424   > 1569
404c409
< SERVICES perp-gate inputSchema 1549     > 1694
```

**All 413 pre-existing rows are byte-identical.** Every declared value, in every casing, on both
surfaces, produces the same validated input, the same repairs, the same answer and the same content
hash as it did before the guard existed. The only added rows are for `-1`, which was not a declared
value before and so was never driven by the pre-change sweep.

Held permanently by **gate U test 1**, which replays the sweep against sixteen content hashes
hardcoded from the pre-change tree. `preflight`'s own independent version of the claim — *repair
leaves every already-valid body byte-identical, so no contentHash moves* — still passes, as does
*every fixture used below is a call the service itself would accept*.

### The one enum value that was added, and why

`perp-gate.side` gained `'-1'`. `perpGate.js:29` honours the **string** `"-1"` as short; measured on
the mirror it answers 108,641.98 with content hash `ca717a01b637a913…`, and measured on this tree it
answers **the same number with the same hash**. Leaving it undeclared would have turned a request that
answers *correctly* today into a refusal — which is a worse defect than the one being fixed, and is
the exact failure the brief named. This is the same reasoning that put `buy` and `sell` in the enum
during the case work: **an enum that is enforced has to list what the engine actually honours, not
what the description used to claim.**

That row is asserted in gate U test 4 as a **hardcoded number**, deliberately not discovered from the
enum — because a guard that dropped `-1` would have deleted the row that should have failed and gone
quiet instead of red. `gateU-revert.mjs` revert 3 (`NOMINUSONE`) proves it goes red.

The **number** `-1` needs no declaration: the guard, like `repairBody`, only looks at strings.

---

## 6. The eleven free-form fields, re-derived rather than inherited

Re-derived from the live schemas — every string field whose description enumerates alternatives with
`|` and which declares no enum — and driven with the same seven illegal values. The guard is silent on
all of them, because it acts on a declared `enum` and nothing else:

`calldata-x.chain`, `chart-press.chartType`, `chart-press.format`, `chart-press.interval`,
`lp-desk.chain`, `options-desk.currency`, `poly-fill.side`, `tape-pulse.chain`, `token-scan.chain`,
`updown-pulse.coin`, `wallet-audit.chain`.

**Eleven, not twelve — and re-deriving is how that surfaced.** Gate C test 9's `DECIDED` map carries a
twelfth key, `chart-press.chain`, which the live schema never produces: its description reads *"DEX
chain (with address); OR omit and pass symbol for a CEX pair"* and contains no `|`. That map is
filtered one way only (`found ⊆ DECIDED`), so a stale key passes silently there. `CASE_SENSITIVITY_FIX.md`
§3 says eleven, and eleven is what the schemas contain. Gate U test 7 asserts the set as an equality in
**both** directions, which is why it showed up the first time it ran. Gate C's map is left as it is —
it is over-broad, not wrong, and the equality now lives somewhere that fails on drift.

---

## 7. Cost

**The advertised `inputSchema` grew by 145 bytes, all of it on `perp-gate`.** MCP `tools/list` goes
from 29,800 to 29,945 bytes; `perp-gate`'s `inputSchema` from 1,549 to 1,694 (and its MCP twin from
1,424 to 1,569). **Every other service's `inputSchema` is byte-identical.** The 402 challenge
embeds `inputSchema` at `x402.js:123–130`, so the perp-gate challenge changes by the same amount.

Three edits account for it: `'-1'` added to the `side` enum, the `side` description updated to say so,
and the `venue` description extended (below).

**It does not touch the OKX registry, so it triggers no re-review** — and that is checkable rather
than asserted. `gates/preflight.mjs` §2 is titled *nothing that would trigger a re-review* and checks
the service count (**22**, unchanged), the endpoint URL (unchanged), and the ERC-8004 agent identity
(**5152**, unchanged), plus the `codeHash` in §1 (`q1-e1fa99d08887d6cc`, unchanged). `inputSchema` is
in none of them, and `/.well-known/agent-card.json` (`app.js:110`) carries names and endpoints, not
schemas. All four checks pass unchanged.

### What the `venue` refusal replaced, and what was done about it

`perp-gate {venue: "okx"}` used to be refused by the venue registry inside `run`
(`hyperliquid.js:99`), as HTTP 200 with `ok:false` and a genuinely useful sentence: *the maths is
venue-agnostic, so pass `maxLeverage`/`markPrice`/`fundingRateHourly` manually*. The guard now refuses
it earlier — at validation, before any venue is resolved — so that message no longer reaches a caller
through that path.

That would have been a downgrade wearing a better status code, so **the sentence moved into the
schema**: `venue`'s description now carries it, and the refusal quotes the field's own description
back (`this service says: …`). `gateP` asserts the string `venue-agnostic` is present in the 400 body,
so it cannot be lost again. `test/unsupportedVenue.test.mjs` still covers the adapter marker directly
and still passes; that path is now defence in depth rather than the first line.

Two consequences stated rather than buried:

- `{venue: "okx", entryPrice: …}` **without** a symbol used to return a correct answer, because
  `enrichPerpInputs` ignores `venue` when there is no symbol to resolve. It is now refused. The answer
  was right and the request was not: an undeclared venue was being sealed into a signed proof's
  `inputs` for a computation that never consulted it. An advertised enum a client would validate
  against, and that the server then ignores, is the same "advertised, never enforced" defect gate C
  test 6 exists to prevent — one level down.
- `gateP`'s engine-refusal fixture was changed for the same reason: `venue:"okx"` no longer exercises
  the `ok:false` path, so that test now drives `tape-pulse {chain:"solana", address:"0x…"}`, which
  still refuses inside `run`. A second test was added asserting the venue case is refused at 400,
  unbilled, with the escape hatch intact. `gateP` went from 10 checks to 11.

### The disclosure note was left alone, deliberately

Both surfaces tell a caller: *"a value matching none of them is passed through exactly as you wrote
it."* That sentence is about what the **repair layer** does to the bytes, and it is still exactly
true — `repairBody` passes `"banana"` through untouched, which gate C test 7 and gate U test 5 both
still assert. What changed is that a body containing such a value no longer reaches an answer at all,
so the note can no longer be *displayed* alongside a wrong one. It is word-for-word identical on both
surfaces and was not edited, which also keeps this change out of `app.js`.

---

## 8. The gate, and the proof it can fail

`gates/gateU-unknown-enum.mjs` — `npm run gate:u` — **8 checks, all passing.** It discovers the
enum-carrying fields by reading the live schemas, so a field added tomorrow is covered without editing
the gate.

1. every declared value, in every casing, on both surfaces, against sixteen content hashes recorded
   from the pre-guard tree — **the half that matters most**
2. an unrecognised value is refused on the paid surface, and the message names the field, quotes back
   what was sent, and lists every legal value
3. and on the free MCP surface, which never calls `validate()`
4. the published rows as **hardcoded numbers**: 91,139.24 is gone, net 200,000 is gone, delta
   +0.319866 is gone — and `side:"-1"` still answers 108,641.98 at hash `ca717a01b637a913…`
5. the guard is the exact complement of `repair.js`, asserted both ways
6. a refusal is free, by the rule the billing contract already reads
7. a field with no declared enum is never caught — the eleven, re-derived
8. the guarded set as an equality, and the shared message builder

`gates/gateU-revert.mjs` — `npm run gate:u-revert` — **PASSED**:

```
  baseline gate U : 8 pass, 0 fail
  baseline preflight : 20 pass, 1 fail (pre-existing, not this change: every paper part is still byte-identical to live)
  baseline gateBuyer : 16 pass, 0 fail

  revert: NOGUARD-HTTP — services.js stops refusing an unrecognised value
    gate U against reverted code : 5 pass, 3 fail
      RED: 2. an unrecognised value is REFUSED on the paid surface …
      RED: 4. the published rows, as hardcoded numbers …
      RED: 6. a refusal is FREE …
      NAMED: http perp-gate side:"banana" -> still served 91139.24, the LONG's liquidation price
      BLIND SPOT: the older check STAYED GREEN (1 pre-existing failure(s), unchanged) — preflight …
      BLIND SPOT: the older check STAYED GREEN (0 pre-existing failure(s), unchanged) — gateBuyer …

  revert: NOGUARD-MCP — ONLY the free surface loses the guard; services.js keeps its wrapper
    gate U against reverted code : 5 pass, 3 fail
      RED: 3. and on the FREE MCP surface, which never calls validate() …
      NAMED: mcp perp_gate.side = "banana": SERVED, not refused
      BLIND SPOT: the older check STAYED GREEN — preflight DOES call every MCP tool, with an empty
                  argument set, which never carries a value to be wrong about
      BLIND SPOT: the older check STAYED GREEN — and gateBuyer does not reach the MCP surface at all

  revert: NOMINUSONE — "-1" dropped from perp-gate's side enum, so the guard REFUSES a value that answers correctly
    gate U against reverted code : 6 pass, 2 fail
      NAMED: perp-gate side:"-1" -> REFUSED a value the engine honours and answers correctly

  gate U against restored code : 8 pass, 0 fail
GATE U REVERT: PASSED
```

The third revert is the one that is not about the defect. It removes nothing and breaks nothing open
— it makes the guard **over-fire**, refusing a value the engine answers correctly. A gate that only
proves it catches under-refusal cannot see the failure a guard introduces, and that failure is worse
than the bug.

`gates/gateC-case-sensitivity.mjs` **test 7 was inverted.** It used to assert the pass-through was
deliberate, on the reasoning that closing it needed an engine change. It now asserts both halves
separately: `repairBody` still passes the value through untouched, *and* both surfaces refuse the
request. `gateC-revert.mjs`'s `NOENUM` literal was updated for the `-1` addition and still passes.

---

## 9. Verification run

| | |
| --- | --- |
| `node --test gates/gateU-unknown-enum.mjs` | 8 pass, 0 fail |
| `node gates/gateU-revert.mjs` | PASSED |
| `node --test gates/gateC-case-sensitivity.mjs` | 10 pass, 0 fail |
| `node gates/gateC-revert.mjs` | PASSED |
| `npm test` | **386 tests**, 381 pass, 5 skipped, 0 fail — unchanged, no test case added |
| `node tools/docs-consistency.mjs` | CONSISTENT |
| `node gates/preflight.mjs` | 20 pass, 1 fail — the single failure is `every paper part is still byte-identical to live`, which predates this change and belongs to concurrent paper work |
| `gateBuyer / gateM / gateP / gateP2 / gateR / gateA / gateS / gateW / gateDiv / gateD4 / gateE / gateF / gateX` | 16 / 17 / 11 / 7 / 15 / 11 / 9 / 8 / 21 / 32 / 15 / 12 / 8 — all 0 fail |
| `diff -rq src/engine ../../Quiver/src/engine` | identical |
| `_internal.buildId()` | `q1-e1fa99d08887d6cc`, before and after |

No deploy was performed. `assets/` and `tools/` were not touched.

---

## 10. What still requires an engine change

**Nothing, for this defect class.** The three fail-open lines are still there and still read anything
unrecognised as the riskier default — they are simply unreachable with such a value:

```
src/engine/perpGate.js:29      (s === 'short' || s === 'sell' || s === -1 || s === '-1' ? -1 : 1)
src/engine/portfolioGate.js:30 (p.side === 'short' || p.side === 'sell' || size < 0) ? 'short' : 'long'
src/engine/optionsRisk.js:32   const type = p.type === 'put' ? 'put' : 'call'
```

That is defence at one layer, not two, and it is worth naming as such. A future caller who reaches an
engine by any route that does not pass `validate` or `handleRpc` gets the old behaviour. Today there
is no such route — the four sites are enumerated in §3 and all four are closed — but the property that
makes that true is a *fact about the call graph*, not an invariant the engines enforce about
themselves. Closing it in the engines as well would move `q1-e1fa99d08887d6cc` and remains an owner's
decision with a coordinated re-publication attached. It buys defence in depth, not a defect fix.

Two smaller residues, both stated rather than fixed:

- **A non-string value is not guarded.** `side: {}` or `side: 42` passes through and hits the default.
  The guard matches `repairBody`'s reach on purpose; widening it would have refused the number `-1`,
  which the engine honours correctly.
- **A required field with a declared enum that is simply absent** is unaffected, as it should be:
  absence means "use the default", and every one of these fields documents its default.

---

## Appendix — the `/changelog` entry, staged rather than written

`assets/changelog.md` was being edited concurrently by the paper work while this change was made
(mtime 13:49 on the day of writing, carrying that agent's entry at the top), and the instruction for
this task was to stay out of `assets/` entirely. Appending here would have risked losing the other
agent's edit to a write collision, so the entry is staged below instead of written. **It is the one
deliverable of this change deliberately left undone**, and it should be pasted above the previous
dated section by whoever mirrors this work.

> ## 29 July 2026 — an unrecognised value is refused instead of being answered as something else
>
> `src/engine/` is untouched, the build hash is unchanged at `q1-e1fa99d08887d6cc`, and no content
> hash has moved for any request that already worked. `npm test` is unchanged at 386 tests, 381
> passing, 5 skipped, 0 failing.
>
> **What was wrong.** The case fix earlier the same day made `side: "SHORT"` answer as the short it
> means. It did nothing for `side: "banana"` — or `"lng"`, or `""`, or any of the other spellings that
> match no declared alternative — because `repair.js` matches a declared value or leaves the value
> exactly as written, and `perpGate.js:29` reads anything unrecognised as **long**. Measured across
> nine declared enum fields and seven illegal spellings each: **all 63 rows were served, on both
> surfaces.** Seven distinct signed content hashes each attested a long position to a caller who never
> wrote the word "long"; a perfectly hedged book read as net +200,000; any option `type` but `put`
> priced as a call.
>
> **What changed.** A value matching no declared alternative is now refused before an engine is
> reached, with a message naming the field, quoting back what was sent, listing every legal value and
> attaching a corrected body. Refusals are free on both surfaces. The guard is the exact complement of
> the repair layer — same case-insensitive comparison, same declared set — so no value the repairer
> accepts can be one the guard refuses.
>
> `perp-gate.side` gained `'-1'` as a declared alternative, because the engine honours the string and
> answers it correctly; leaving it out would have turned a correct answer into a refusal.
> `perp-gate`'s advertised `inputSchema` grew 145 bytes and every other service's is byte-identical.
> The OKX registry surface is untouched: 22 services, same endpoint, agent 5152, same `codeHash`.
>
> Held by `gates/gateU-unknown-enum.mjs` (`npm run gate:u`) and `gates/gateU-revert.mjs`, which puts
> the guard back — on each surface separately, and once in the over-firing direction — and requires
> the gate to go red on the exact rows measured above. Write-up: `docs/unknown-enum-refusal.md`.
