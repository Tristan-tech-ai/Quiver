# `side: "SHORT"` — fixed outside `src/engine/`, with the build hash unmoved

**29 July 2026.** The engine build is `q1-e1fa99d08887d6cc` before this change and
`q1-e1fa99d08887d6cc` after it. `src/engine/` is byte-identical to the published mirror; the entire
fix is three files under `src/services.js`, `src/mcp.js` and `src/util/repair.js`.

Every number on this page was measured on this tree, twice — once against the unmodified repository
and once against the fixed one — and written down second. Where a number here disagrees with an
earlier document, this page follows the measurement.

---

## 1. The hypothesis, and whether it held

**It held, and it reached further than expected.**

`src/util/repair.js` step 6 already case-corrects a string value against a declared `enum`. It never
fired for `side` because nothing declared one: `src/services.js` had
`side: { type: 'string', description: 'long | short' }`, prose where a machine-readable constraint was
needed. `src/mcp.js` *did* declare `enum: ['long','short']` — and it was decoration, because both
surfaces hand `repairBody` the **SERVICES** entry:

| surface | file:line | what it passes to `repairBody` |
| --- | --- | --- |
| paid HTTP | `src/app.js:546` | `repairBody(s, sent)` where `s` comes from `SERVICES` |
| free MCP | `src/mcp.js:507` | `repairBody(svc, params.arguments)` where `svc = SERVICES.find(...)` |

`handleRpc` never consults the `TOOLS` entry for repair, and never calls `svc.validate()` at all — on
the MCP surface the repaired body **is** the engine input. So one enum array in `services.js` fixes
both surfaces, and an enum in `mcp.js` alone fixes neither. That asymmetry is now a gate, not a
memory: `gateC` test 6 fails if `TOOLS` declares an enum `SERVICES` does not.

One thing the hypothesis did not anticipate: **`repairBody` only walked top-level properties.** Two of
the three fields that carry direction — an options leg's `type` and a portfolio leg's `side` — live
inside an array of objects. Enums alone would have fixed `perp-gate` and left the other two exactly as
broken. The revert `NODESCENT` below demonstrates that half on its own.

---

## 2. What was measured, before and after

Identical bodies, both surfaces, the same tree with and without the fix. The HTTP and MCP content
hashes were identical to each other in every row, before and after, so one column is shown.

### `perp_gate` — `{side, entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000}`

| sent `side` | before: served / liq / hash | after: served / liq / hash |
| --- | --- | --- |
| `"long"` | long · 91,139.24 · `3dbb480d100d` | long · 91,139.24 · `3dbb480d100d` |
| `"short"` | short · 108,641.98 · `1f9a9ca1c43a` | short · 108,641.98 · `1f9a9ca1c43a` |
| `"sell"` | short · 108,641.98 · `4e9ce1458bac` | short · 108,641.98 · `4e9ce1458bac` |
| **`"SHORT"`** | **long · 91,139.24 · `7767b8e23cc8`** | **short · 108,641.98 · `1f9a9ca1c43a`** |
| **`"Short"`** | **long · 91,139.24 · `cae2cc8d18ef`** | **short · 108,641.98 · `1f9a9ca1c43a`** |
| **`"SELL"`** | **long · 91,139.24 · `1b971886aa89`** | **short · 108,641.98 · `4e9ce1458bac`** |
| `"banana"` | long · 91,139.24 · `3a6bdea3e2b9` | long · 91,139.24 · `3a6bdea3e2b9` |

The three bold rows now return **the same content hash as the correctly-cased body they meant**. Not
a similar answer — the identical signed artifact.

### `portfolio_gate` — a perfectly hedged book, one long and one short, same asset, size and price

| leg 2 `side` | before | after |
| --- | --- | --- |
| `"short"` | net 0 · long 100,000 · short 100,000 · `a38b8ee88b81` | unchanged |
| **`"SHORT"`** | **net 200,000 · long 200,000 · short 0 · `d6f77372be39`** | **net 0 · long 100,000 · short 100,000 · `a38b8ee88b81`** |
| **`"SELL"`** | **net 200,000 · long 200,000 · short 0 · `f6a626d3a91c`** | **net 0 · … · `ba5cf4de2edc`** (= `"sell"`) |
| `"banana"` | net 200,000 · `a539223b98f7` | unchanged — see §5 |

### `options_risk` — `{forward: 100000, positions: [{type, strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1}]}`

| sent `type` | before | after |
| --- | --- | --- |
| `"call"` | call · delta +0.319866 · `874b15ccda63` | unchanged |
| `"put"` | put · delta −0.680134 · `2b55bbf8287e` | unchanged |
| **`"PUT"`** | **call · +0.319866 · `22a7bb7992eb`** | **put · −0.680134 · `2b55bbf8287e`** |
| **`"Put"`** | **call · +0.319866 · `9fcbe94a5974`** | **put · −0.680134 · `2b55bbf8287e`** |

Portfolio value moves with it: 3,270.260505 as a call, 13,270.260505 as the put the caller described.

### The three found by sweeping the rest of the catalogue

| service · field | before | after |
| --- | --- | --- |
| `poly-fill.action` = `"SELL"` | filled at **60c for 166.7 shares** — the ASK book, i.e. the buy side | 40c for 250 shares, the bid book |
| `portfolio-gate.betaTier` = `"SEVERE"` | silently fell back to the default Oct-10 table | the validated `severe` tier the caller asked for |
| `options-desk.focus` = `"ALL"` | **strictly less than sending nothing**: `greeksSurface` dropped, `expiries` truncated to 3 | the full dossier |
| `chart-press.quality` = `"FULL"` | rendered the cheap `fast` tier | the `full` tier |
| `chart-press.theme` = `"LIGHT"` | rendered dark | light |

`poly-fill.action` is measured at the engine boundary against an injected 40/60 book, because the
service reads Polymarket live. The other four are network-bound and are proven at the input identity
(§4), which is the object the engine is handed.

---

## 3. Every field changed, and why

Nine fields across six services. The rule applied throughout: **declare an enum where miscasing
changes the ANSWER; do not declare one where the consumer already folds case**, because a declared
enum recases the echoed input and would move a content hash for a request that was already answered
correctly.

| service · field | enum declared | the fail-open site |
| --- | --- | --- |
| `perp-gate.side` | `long, short, buy, sell` | `perpGate.js:29` — anything unrecognised → **long** |
| `portfolio-gate.positions[].side` | `long, short, buy, sell` | `portfolioGate.js:30` — same fall-through |
| `options-risk.positions[].type` | `call, put` | `optionsRisk.js:32` — anything not `"put"` → **call** |
| `poly-fill.action` | `buy, sell` | `polyFill.js:44,47` — anything not `"sell"` walks the ask book |
| `portfolio-gate.betaTier` | `mild, moderate, severe` | `portfolioGate.js:127` — no match → default table |
| `options-desk.focus` | `all, expiries, greeks, headline` | `optionsDesk.js:606–614` — no match → truncated answer |
| `chart-press.quality` | `fast, full` | `chartPress.js:115` — anything not `"full"` → fast tier |
| `chart-press.theme` | `dark, light` | `chartPress.js:41` — anything not `"light"` → dark |
| `perp-gate.venue` | `hyperliquid, dydx` | **not a fail-open** — declared for parity, see below |

**`buy` and `sell` are in the `side` enum on purpose.** The engines have always honoured `sell` as
short (`perpGate.js:29`, `portfolioGate.js:30`); it was in the code before this work. Leaving it out
of the enum would have fixed `"SHORT"` and left `"SELL"` reading as **long** — the same inverted
answer wearing a different word, and a row the published sweep had already measured. The enum
documents what the engine does rather than what the old description said it did.

**`perp-gate.venue` is the one field declared for a reason other than correctness.** The adapter
already lowercases it (`adapters/hyperliquid.js:92`), so `venue: "DYDX"` always resolved correctly.
It is declared because `src/mcp.js` advertised the enum and `services.js` did not, which is exactly
the decorative state that let the `side` defect survive. Making the two surfaces agree is enforced by
gate C test 6, and that check cannot be satisfied while one surface declares an enum the other omits.

### The eleven fields deliberately left without an enum

Each has a `|` in its description and each is read through a case-folding consumer, so an enum would
buy a moved content hash and no correction. They are listed with the file:line that folds the case in
`gateC` test 9, as an **equality** — a new prose-enumerated field that nobody decides on fails the
gate rather than being quietly missed.

`tape-pulse.chain`, `token-scan.chain`, `wallet-audit.chain`, `chart-press.chain`, `lp-desk.chain`,
`calldata-x.chain` (all lowercased in `validate`), `updown-pulse.coin`, `options-desk.currency` (both
uppercased and range-checked in `validate`), `chart-press.chartType`, `chart-press.format`,
`chart-press.interval` (lowercased at `chartPress.js:43`, `:48` and `okx-market.js:13`), and
`poly-fill.side` (`polyFill.js:33` uppercases, so `"no"` already resolves to the NO book).

---

## 4. Proof that correctly-cased content hashes did not move

Two runs of the same capture script — one importing the **unmodified Quiver mirror**, one importing
this tree — diffed byte for byte:

```
=== INPUT IDENTITY (all 22 services, every fixture form) ===   31 forms
=== CONTENT HASHES (deterministic, offline)               ===   14 hashes
$ diff base-prefix.txt base-postfix.txt
*** identical ***
```

The mirror was the right control **at the moment of capture**: `diff -rq` across `src/` then reported
differences in exactly the four files this fix touches and nothing else, with `src/engine/` reported
identical. The fix has since been mirrored, as every change here is, so that diff no longer
reproduces — which is why the recorded values are pinned inside `gateC` test 5 rather than left to be
re-derived from a control that was always going to be updated. `src/engine/` remains identical
between the two trees, and that one *is* still checkable at any time.

Held permanently by **gate C test 5**, which replays every fixture form of all 22 services through
`repairBody` (requiring zero repairs and a byte-identical body) and re-derives twelve deterministic
content hashes against values recorded from the pre-fix tree, plus the hedged portfolio book
(`1b574b4e5985eb81…`). `gates/preflight.mjs` keeps its own independent version of the same claim and
still passes it.

### The one exception, stated rather than buried

For a value that was **already producing the right answer despite the wrong case**, the hash now moves
to the canonical value's hash while the served numbers stay identical:

| body | before | after | served answer |
| --- | --- | --- | --- |
| `venue: "HYPERLIQUID"` | `536b29705758` | `7468bf903954` (= `"hyperliquid"`) | 91,139.24, unchanged |
| `side: "LONG"` | `bce4d88ffca1` | `3dbb480d100d` (= `"long"`) | 91,139.24, unchanged |
| `side: "BUY"` | `1560527ec902` | `6ee9a7862cd8` (= `"buy"`) | 91,139.24, unchanged |

These are the miscased spellings that happened to land on the default branch anyway. Nothing
published quotes them, and no canonical body moved — but "hashes move only where the answer was
wrong" would have been a slightly-too-clean sentence, so here is the version that survives
measurement: **no canonically-cased request moved, and every request that moved now returns the hash
of the request it meant.**

---

## 5. What this does NOT fix

**Case is not the whole defect.** `side: "banana"` is still served as long, and `type: "p"` still as a
call. `repair.js` matches a declared alternative or leaves the value exactly as written — it will
never coerce to a nearest neighbour, because that would be inventing a value on the caller's behalf.
Closing that requires `perpGate.js:29`, `portfolioGate.js:30` and `optionsRisk.js:32` to **refuse** an
unrecognised value, which is inside `src/engine/` and moves `q1-e1fa99d08887d6cc`. That remains an
owner's decision with a coordinated hash re-publication attached, and it is unchanged by this work.

**Gate C test 7 asserts the pass-through is deliberate**, so nobody can read a green gate as a claim
that the whole class is closed.

The residue is much smaller than it was. Before: every spelling except six exact literals was
inverted. After: only spellings that are not a case-variant of a declared alternative.

---

## 6. Cost

**The advertised `inputSchema` gains `enum` arrays.** That changes the bytes of the 402 challenge —
`src/x402.js:123–130` embeds `inputSchema` in `accepts[].outputSchema.input.body` — and the bytes of
MCP `tools/list`.

**It does not touch the OKX registry, so it triggers no re-review.** The framing in
`assets/changelog.md` holds, and it is checkable rather than asserted: `gates/preflight.mjs` §2 is
titled *nothing that would trigger a re-review* and checks the service count (22), the endpoint URL,
and the ERC-8004 agent identity (5152) — plus the `codeHash` in §1. `inputSchema` is in none of them,
and `/.well-known/agent-card.json` carries names and endpoints, not schemas. All four checks pass
unchanged.

**The disclosure note was reworded, because it had stopped being true.** Both surfaces used to say
*"Shapes only: no value was supplied, defaulted or guessed."* Step 6 rewrites a **value**. The three
promises are kept and the claim narrowed to what is enforced: every change is a re-reading of the
caller's own bytes — a wrapper unwrapped, a key matched to a declared one, a written number or boolean
read as one, or a value matched case-insensitively to one of the alternatives the service declares —
and a value matching none of them is passed through exactly as written. The two surfaces carry the
identical sentence.

Whether recasing against a declared enum is still "shape" is a genuine question, and the answer this
codebase settles on is: it is safe for a checkable reason rather than a rhetorical one. The service
has declared the finite set that key accepts; a case-insensitive comparison against it matches exactly
one member or none. There is no second candidate to prefer, so nothing is chosen. That argument is
written into the header of `src/util/repair.js` where the contract lives.

---

## 7. The gate, and the proof it can fail

`gates/gateC-case-sensitivity.mjs` — `npm run gate:c` — **10 checks, all passing.** It discovers the
enum-carrying fields by reading the live schemas rather than listing them, so a field added tomorrow
is covered without editing the gate.

1. every miscased value reaches the **paid** handler as the value the caller meant
2. and reaches the **free MCP** handler as the same value
3. every normalisation is reported to the caller, never silent
4. the served **answer** is identical end to end, on both surfaces, plus `poly-fill` at the engine
   boundary against an injected book
5. *(4b)* the exact published rows — 108,641.98, net 0/100,000/100,000, delta −0.680134 — asserted as
   **hardcoded numbers**, deliberately not derived from the schema, so deleting an enum makes this
   check go **red** rather than go quiet
6. an enum advertised on the MCP surface is also declared on the one that enforces it
7. a value matching no declared alternative is passed through, not guessed at
8. the sweep reached what it claims to cover — an equality on the covered field set
9. every remaining `|`-described field without an enum was decided, with the file:line that folds its
   case

`gates/gateC-revert.mjs` — `npm run gate:c-revert` — **PASSED**:

```
  baseline gate C : 10 pass, 0 fail
  baseline preflight : 20 pass, 1 fail (pre-existing, not this change: every paper part is still byte-identical to live)
  baseline gateBuyer : 16 pass, 0 fail

  revert: NOENUM — services.js declares perp-gate `side` as prose again, exactly as it shipped
    gate C against reverted code : 6 pass, 4 fail
      NAMED: liquidationPrice 91139.24, expected 108641.98 (the SHORT's)
      BLIND SPOT: the older check STAYED GREEN (1 pre-existing failure(s), unchanged) — preflight …
      BLIND SPOT: the older check STAYED GREEN (0 pre-existing failure(s), unchanged) — gateBuyer …

  revert: NODESCENT — repair.js stops descending into array items, every enum left declared
    gate C against reverted code : 5 pass, 5 fail
      NAMED: portfolio-gate leg side:"SHORT" -> net 200000 long 200000 short 0

  revert: MCPONLY — the option-type enum removed from services.js and LEFT in mcp.js
    gate C against reverted code : 6 pass, 4 fail
      NAMED: declares an enum that services.js does not — advertised, never enforced

  gate C against restored code : 10 pass, 0 fail
GATE C REVERT: PASSED
```

The blind-spot lines are the ones that explain why this survived. With the fix removed, **`preflight`
and `gateBuyer` both stay green** — gateBuyer being the gate whose entire subject is what buyers get
wrong about inputs. It checks wrapped, stringified, aliased and miscased **keys**, and never once a
miscased **value**. That is how an inverted, self-checked, signed, billable risk number passed every
gate in the repository.

A note on how that was measured, because the first version of this script got it wrong: preflight is
**already** red on this tree for an unrelated, pre-existing reason (`every paper part is still
byte-identical to live`, 0 of 7 — the repository's paper is ahead of the live deploy, and the
unmodified mirror reports the identical failure). Written as *"preflight stays green"*, the script
reported no blind spot where there plainly was one. It now measures the honest claim: the **named**
check still passes and preflight's failing set is unchanged from its own baseline.

---

## 8. Verification run

| | |
| --- | --- |
| `node --test gates/gateC-case-sensitivity.mjs` | 10 pass, 0 fail |
| `node gates/gateC-revert.mjs` | PASSED |
| `npm test` | **386 tests**, 0 fail, 5 skipped — unchanged |
| `node tools/docs-consistency.mjs` | CONSISTENT — 130 documents |
| `node gates/preflight.mjs` | 20 pass, 1 fail — **byte-identical ledger to the unmodified mirror**; the single failure is the undeployed paper edit and predates this change |
| `gateBuyer`, `gateM`, `gateP`, `gateP2`, `gateR` | 16 / 17 / 10 / 7 / 15, all 0 fail |
| `diff -r src/engine ../../Quiver/src/engine` | identical |
| `_internal.buildId()` | `q1-e1fa99d08887d6cc`, before and after |

No deploy was performed.
