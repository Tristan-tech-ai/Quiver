# The paid path, and two ways it was less honest than the free one

**29 July 2026.** Engine build `q1-e1fa99d08887d6cc`, unchanged by anything on this page —
`src/engine/` was not touched and the directory diffs byte-identical against the published mirror.

Two defects from the live judge sweep, both outside the hashed tree, both with the same shape: the
work that makes Quiver honest to a caller had been done on a surface, and the surface it had been done
on was not the one that takes money. Each was reproduced before it was touched, each is now held by a
gate that was shown to fail, and everything below is a measurement.

---

## Defect 1 — the buyer defence never reached the caller who paid for it

### What was wrong

`src/app.js:555` builds a refusal as an `Error` with two halves. The **message** names what went wrong
and appends the redirect line. The **`detail` object** carries the machine-readable half:

| field | what it is |
| --- | --- |
| `howToFix` | a body that would work, with the caller's own values kept and the gaps as `<placeholders>` |
| `routingNotice` | the service that fits, with its endpoint, price and an executable `retry` |
| `repairsApplied` | the shape repairs made before the refusal |

`src/x402.js` then did this:

```js
return res.status(status).json({ error: code, detail: String(e.message || e).replace(/^bad_input:\s*/, '') });
```

`e.detail` — the object — was never read. The field named `detail` in the response is the *message*,
so the collision hid it: the response looked like it carried the detail and carried only the prose.

### Reproduced, before anything was changed

Driven through the real middleware end to end (402 challenge → `/verify` → handler → `/settle`)
against a stub facilitator on the Base `auth: none` rail, which is a configured rail in
`src/config.js` and not a test-only branch inside the service.

**A missing required field.** `POST /api/perp-gate` with `{"side":"long","entryPrice":64000}`, paid:

```json
{ "error": "bad_input",
  "detail": "require size (base units) or notional | perp-gate — Perp liquidation price… " }
```

The same body over free `/mcp` returned `ok:false`, three specific `errors`, **and** a `howToFix`
naming `size` and `margin` with the caller's `side` and `entryPrice` preserved. The paying caller got
the first and not the second.

**A wrong-service body.** `POST /api/options-desk` with `{"protocol":"aave"}`, paid: `error` +
`detail` only. The prose inside `detail` did name `/api/protocol-pulse` — but an agent cannot execute
prose. `routingNotice`, which carries `{service, endpoint, price, retry:{method,url,body}}`, was
dropped.

**A bad enum.** `POST /api/updown-pulse` with `{"coin":"DOGE"}`, paid: `error` + `detail` only.

**The 402 challenge itself is NOT affected.** It is built from `accepts` before any handler runs, so it
never travelled through the dropped path. Verified: status 402, `PAYMENT-REQUIRED` header present,
two rails, and `accepts[].outputSchema.input.body` byte-identical to each service's advertised
`inputSchema` — checked on all 22, before and after.

### What changed

One call site, and a named helper beside it (`refusalBody` in `src/x402.js`), so the rule has
somewhere to be documented and somewhere to be tested:

```js
export function refusalBody(e, status, code) {
  const body = { error: code, detail: String(e?.message || e).replace(/^bad_input:\s*/, '') };
  const teach = status >= 400 && status < 500 ? e?.detail : null;
  if (teach && typeof teach === 'object' && !Array.isArray(teach)) {
    for (const [k, v] of Object.entries(teach)) if (v !== undefined && !(k in body)) body[k] = v;
  }
  return body;
}
```

`error` and `detail` are written first and never overwritten, so nothing a handler puts in `detail`
can rename the status or replace the message. `undefined` members are dropped, so an absent
`repairsApplied` stays absent rather than becoming `null`. Only a 4xx carries teaching: a 5xx is our
fault and the caller has nothing to correct.

### What a paying caller sees now

Same request, `POST /api/perp-gate` with `{"side":"long","entryPrice":64000}`:

```json
{ "error": "bad_input",
  "detail": "require size (base units) or notional | perp-gate — …",
  "howToFix": {
    "missing": [],
    "send": { "method": "POST", "url": "/api/perp-gate",
              "body": { "symbol": "<perp symbol (e.g. BTC) — auto-fills live markPrice…>",
                        "venue": "<live-data venue: hyperliquid (default) | dydx>",
                        "side": "long", "entryPrice": 64000,
                        "size": "<position size in base units>",
                        "margin": "<isolated margin (or pass leverage)>" } },
    "note": "Send the body above to /api/perp-gate." } }
```

That `howToFix` object is **deep-equal** to the one the free MCP surface returns for the same body —
asserted as an equality in the gate, because two independent "has a howToFix" checks would have been
satisfied by a divergent, worse paid version. `POST /api/options-desk` with `{"protocol":"aave"}` now
also carries the full `routingNotice`, including `retry: {method:"POST", url:"/api/protocol-pulse",
body:{protocol:"aave"}}` and the price.

### Billing: unchanged, and measured rather than argued

`isChargeable()` was **not** touched, and no refusal changed billing class in either direction. The
reason is structural and worth stating: the refusal path `throw`s inside the handler, and the `catch`
returns **before** `/settle` is ever called. `isChargeable()` is consulted only for a result the
handler *returned*. So a refusal that now teaches is still free, and it is not free because the rule
says so — it is free because settlement is not reached. The gate measures this at the facilitator, by
counting `/settle` requests, rather than reading it off the response body:

| paid call | status | teaching | `/settle` reached | billed |
| --- | --- | --- | --- | --- |
| `perp-gate {side,entryPrice}` — missing field | 400 | `howToFix` | no | no |
| `options-desk {protocol}` — wrong shop | 400 | `howToFix` + `routingNotice` | no | no |
| `updown-pulse {coin:"DOGE"}` — bad enum | 400 | `howToFix` | no | no |
| `perp-gate {symbol,venue:"okx"}` — engine refusal, `ok:false` | 200 | `errors` + `supportedVenues` | no | no, `PAYMENT-RESPONSE: not_charged` |
| `perp-gate` complete body | 200 | — | yes | yes |

### No content hash moved, and none could

A refusal is not a proof envelope: no `contentHash` is taken over one and no code path from
`refusalBody` reaches `proofEnvelope`. That was verified rather than assumed, two ways. Preflight's
replay sweep — every already-valid body for all 22 services, plus each optional field in turn — still
reports `repair leaves every already-valid body byte-identical, so no contentHash moves`. And the
delivered-answer case is asserted on the wire in the gate: a complete `perp-gate` body still returns
`deterministic: true` with a `contentHash` identical to the one the free MCP surface returns for the
same request (`3e875134…` before the change and after it).

### One related thing left alone, and named

`config.devMode` (`DEV_MODE=1`, local only, never set on the deployed service) short-circuits `paid()`
before the try/catch, so a caller mistake in local development still falls through to the generic
handler and reads as HTTP 500 `internal`. That is the same class of defect on a path that neither
bills nor ships. It was measured and deliberately not changed here, because changing the status code
on a path nobody asked about is a behaviour change nobody asked for. It is recorded so the next person
does not have to rediscover it.

---

## Defect 2 — a live venue read shipped as a deterministic proof

### What was wrong

`portfolio-gate` in explicit-positions mode calls `enrichPortfolioLegs`, which fills any leg naming an
asset but missing a mark from the live Hyperliquid context. That fetched value went into
`proof.inputs` inside an envelope marked `deterministic: true`, with no `observedAtUtc`, no source and
no `live` block.

### Reproduced, before anything was changed

The judge's exact body:

```
{ positions: [ { venue:"hyperliquid", asset:"BTC", size:1, entryPrice:100000, leverage:10, maxLeverage:40 } ] }
```

```
envelope           proof
deterministic      true
observedAtUtc      (absent)
live               (absent)
contentHash        fd78b116fdb5fa89f44d5226a94c7e4b374a130141bf9139fae4ca2fb240ed5b
sent leg keys      asset, entryPrice, leverage, maxLeverage, size, venue
echoed leg keys    asset, entryPrice, leverage, markPrice, maxLeverage, size, venue
                                              ^^^^^^^^^ never sent — 63815, read from the venue
```

The judge measured 63826 the day before; the mark moves, which is the whole point.

**A control ran in the same process.** The same book with `markPrice` supplied fetches nothing, stays
a `deterministic: true` proof, and returns `contentHash f491b453…` — stable across repeated calls. So
the difference above is the fetch, not ambient noise.

### What changed

The rule is already enforced centrally: `proofEnvelope` routes any result carrying `live` to
`observationEnvelope`. Nothing was missing except the provenance itself, so the fix is to attach it —
the same shape `perp-gate` symbol mode uses, not a second pattern:

- `legsFetchedLive(sent, enriched)` in `src/services.js` reports which per-leg fields were filled by
  **diffing** the legs the caller sent against the legs that came back. Measured, not self-reported: a
  self-reporting adapter is a claim, a diff is evidence. A path whose value arrived as `null` counts as
  not supplied, which closes the one way a fetched value could ride inside a key the caller technically
  typed.
- Both handlers attach a `live` block when that list is non-empty, and a `mathReproducibility` note
  worded for leg enrichment rather than for account mode.

Fixed on **both** surfaces at once, from the one helper. §11.6 of the paper records this same defect
being fixed at three call sites and missed at the fourth — the free MCP path — and the MCP handler
carried an independent copy of exactly this code. Fixing one and leaving the other would have
reproduced that history precisely.

### What a caller sees now

```
envelope           observation
kind               OBSERVATION
deterministic      false
observedAtUtc      2026-07-29T03:33:07.157Z
live.source        hyperliquid live perp context (keyless public API) — per-leg mark, margin tiers…
live.legsEnriched  1  (ofLegs 1)
live.filled        [ { leg:0, asset:"BTC", venue:"hyperliquid", fetched:{ markPrice: 63716 } } ]
mathReproducibility  "…What is NOT re-runnable is the venue read — the marks and margin tiers listed
                      in live.filled move — so this ships as a committed observation…"
```

Identical on the free MCP tool, from the same helper.

### The content hash: what moved, and by how much

Measured, not reasoned. The published mirror (`Quiver`, clean at HEAD) is the pre-change tree; the
working tree is the post-change one. The same 22-service fixture sweep was run against both and every
envelope compared.

```
[before] codeHash=q1-e1fa99d08887d6cc      (Quiver, clean at HEAD)
[after ] codeHash=q1-e1fa99d08887d6cc      (working tree)

  KIND  portfolio-gate#0: proof(det=true) -> observation(det=false)

deterministic hashes identical: 13
observation pairs (re-hash by construction, observedAtUtc is inside the preimage): 17
MOVED: 1
```

**One row moved, and it is the one that was lying.** Thirteen deterministic content hashes are
byte-identical across the change. The moved row is `portfolio-gate` with an un-marked leg: it changes
envelope *key* (`proof` → `observation`) and therefore hash, because `observedAtUtc` enters the
preimage. That is caller-visible and is in `/changelog`.

**Account mode is untouched**, which contradicts the brief that commissioned this work. The brief
predicted the change would move account mode's envelope shape. It does not: account mode already sets
`live` from `clearinghouseState` and already shipped an observation, so the new disclosure is gated on
`!live` and account mode's envelope has exactly the keys it had before. Nothing in account mode ever
claimed `deterministic: true`, so there was no dishonesty there to correct, and the control the brief
asked for was needed for a different reason — an observation re-hashes on every call by construction,
so 17 of the 31 sweep rows are not hash-comparable at all and are reported as such above rather than
counted as "unchanged".

---

## The gates, and the proof that each can fail

### `gates/gateP-paid-teaching.mjs` — 10 checks (`npm run gate:p`)

Drives the real x402 middleware end to end with a `PAYMENT-SIGNATURE` header. **A gate that only
exercises MCP is exactly how this was missed**, so none of these checks can be satisfied by the free
surface. The load-bearing one is differential: `assert.deepEqual(paidRefusal.howToFix, freeRefusal.howToFix)`.
Also asserted: the 402 challenge and both rails' advertised `inputSchema` bytes on all 22; the
refusal-is-free and delivery-is-billed rules, measured by counting `/settle` calls at the facilitator;
paid and free content hashes equal on a delivered answer; and a sweep requiring every service that
refuses a junk body to hand back a corrected one, with a vacuity guard that fails if fewer than 15 of
the 22 actually refused.

### `gates/gateP-sealed-provenance.mjs` — 7 checks (`npm run gate:p2`)

Sweeps **all 22 HTTP services and all 9 MCP tools** against their genuine fixtures and fails any
envelope claiming `deterministic: true` that echoes a leaf path the caller did not supply a value for.
Guarded against passing over nothing: the set of envelopes claiming determinism is asserted as an
*equality* against a written-down list of 24 (service, form, surface) rows, and the portfolio-gate case
fails loudly if the venue read did not actually happen rather than silently certifying a network
outage.

**A measured note on what does *not* work.** Instrumenting `globalThis.fetch` looks like the direct way
to ask "was this fetched?". It is not sufficient, and the evidence is in the pre-fix sweep:
`portfolio-gate#0` issued **zero** fetches — `perp-gate`'s symbol fixture had warmed the adapter cache
two services earlier — while carrying a fetched `markPrice: 63815` under `deterministic: true`. A
fetch counter would have reported that call clean. The instrumentation is kept as a weaker second
signal and is labelled as one in the gate; the structural path diff is the assertion that can fail.

### `gates/gateP-revert.mjs` (`npm run gate:p-revert`)

Puts each defect back one at a time and requires the owning gate to go red, then green again on
restore. Verbatim output:

```
GATE P REVERT — proving the paid-teaching gate and the sealed-provenance gate can fail

  baseline gate P  (paid teaching)      : 10 pass, 0 fail
  baseline gate P2 (sealed provenance)  : 7 pass, 0 fail

  revert: X402DETAIL — the paid path drops err.detail again (the code as it shipped)
    gate against reverted code : 5 pass, 5 fail
      RED: a PAYING caller who gets the input shape wrong is handed a corrected body
      RED: the wrong-shop signpost reaches the payer too, machine-readable
      RED: THE DIFFERENTIAL: the paid refusal carries the same teaching as the free one
      RED: every service that can refuse teaches its paying caller
      RED: a refusal that teaches is still a refusal that is FREE
      BLIND SPOT: the older check STAYED GREEN — gateBuyer calls repairBody/correctedExample
      directly and never sends a payment header — the teaching it certifies is the teaching on the
      surface that does not bill

  revert: PORTFOLIO — src/services.js stops disclosing the venue read on explicit positions
    gate against reverted code : 4 pass, 3 fail
      RED: no envelope claiming deterministic:true echoes a value the caller did not supply
      RED: the set of envelopes claiming determinism is the set that has been decided on purpose
      RED: a portfolio-gate leg whose mark came from the venue ships an observation, on BOTH surfaces
      NAMED: http:portfolio-gate#0 sealed
      BLIND SPOT: the older check STAYED GREEN — preflight replays bodies through repairBody and
      never asks whether an echoed input was supplied or fetched

  revert: MCPONLY — the same disclosure removed from src/mcp.js alone, services.js left fixed
    gate against reverted code : 4 pass, 3 fail
      RED: no envelope claiming deterministic:true echoes a value the caller did not supply
      RED: the set of envelopes claiming determinism is the set that has been decided on purpose
      RED: a portfolio-gate leg whose mark came from the venue ships an observation, on BOTH surfaces
      NAMED: mcp:portfolio_gate#0 sealed

  all files restored
  gate P  against restored code : 10 pass, 0 fail
  gate P2 against restored code : 7 pass, 0 fail

==============================================================================
  [PASS] X402DETAIL — the paid path drops err.detail again (the code as it shipped)
  [PASS] PORTFOLIO — src/services.js stops disclosing the venue read on explicit positions
  [PASS] MCPONLY — the same disclosure removed from src/mcp.js alone, services.js left fixed
  [PASS] both gates are green again once the files are restored

GATE P REVERT: PASSED — each new check is capable of failing, and the old ones are shown blind
```

The two `BLIND SPOT` lines are the part worth reading. `gateBuyer-mistakes` — the gate whose entire
subject is the buyer-defence teaching layer — stays green while a paying caller gets nothing, because
it calls `repairBody` and `correctedExample` directly and has never once put a payment header on a
request. Preflight stays green while a fetched mark is sealed as re-runnable, because it replays
bodies through `repairBody` and never asks whether an echoed input was supplied or fetched. Neither
gate was weak; each was measuring a different thing than the one that broke. The third revert removes
the disclosure from `src/mcp.js` alone, with `src/services.js` left fixed, and the sweep still goes red
and still names `mcp:portfolio_gate#0` — which is the demonstration that this gate covers both
surfaces rather than the one that happened to be fixed first.

---

## Constraints, checked

| constraint | result |
| --- | --- |
| `src/engine/` untouched | `diff -rq` against the mirror: **identical**, whole directory |
| `q1-e1fa99d08887d6cc` unmoved | recomputed on both trees: identical |
| the paper unchanged | `assets/whitepaper.*` untouched; preflight: `every paper part is still byte-identical to live — 7 of 7` |
| `npm test` at exactly 386 | `tests 386, pass 381, fail 0, skipped 5` — unchanged; no test case added, every new check is in `gates/` |
| advertised `inputSchema` unchanged | asserted as bytes on all 22 services across both rails, inside gate P |
| MCP `tools/list` bytes unchanged | `tools/list` serialises `{name, title, description, inputSchema, outputSchema, annotations}`; only a handler body changed |
| ASP name / description / service list / endpoints | untouched; preflight: service count 22, endpoint and identity unchanged |
| `node tools/docs-consistency.mjs` | CONSISTENT |
| `node gates/preflight.mjs` | PASSED |
| not deployed | no `railway up` was run |

**Files changed:** `src/x402.js`, `src/services.js`, `src/mcp.js`, `package.json` (three gate scripts),
`assets/changelog.md`, `gates/gateP-paid-teaching.mjs`, `gates/gateP-sealed-provenance.mjs`,
`gates/gateP-revert.mjs`, plus this document and the `KNOWN_DEFECTS.md` status line.

`src/mcp.js` is outside the file set the brief scoped this work to, and the reason it was edited is
above: the MCP handler holds an independent copy of the portfolio-gate branch, the gate sweeps both
surfaces because a one-surface fix is the documented failure mode here, and leaving it would have
shipped a red gate or a gate deliberately blinded to half its subject. The change there is nine lines
inside `portfolio_gate.run` plus one import, and touches nothing the concurrent work on
`src/util/snark.js` reads.
