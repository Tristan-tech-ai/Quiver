# The instructions for checking us did not work

Every enveloped Quiver response carries `proof.verifyContentHash` — a sentence telling a caller how to
recompute the `contentHash` printed beside it. That sentence is the product. The whole argument of
this service is *do not trust the seller, re-derive the number*, and the paper prints a worked exhibit
in Appendix C precisely so a reader can try.

The sentence was wrong. Not stale, not imprecise: followed literally, on the live service, on the
exhibit the paper points at, it produced the wrong hash — beside a second sentence saying that a
mismatch means the response was altered. A judge who did as invited would have got a mismatch and an
accusation, and concluded the proof was fake.

This document is the reproduction, the fix, the proof that nothing moved, and the gate that would have
caught it.

---

## 1. Reproduced before anything was touched

### 1.1 On the live service

`POST https://quiver-production-c3a8.up.railway.app/mcp`, `tools/call` → `perp_gate`, with the
Appendix C position and its parameters wrapped in `params` — which is what an agent framework does by
default, and which the service silently and correctly unwraps:

```
top-level keys : ok, inputs, liquidationPrice, moveToLiquidationPct, positionStatus,
                 effectiveLeverage, initialMarginRatePct, maintenanceMarginRatePct,
                 marginTier, funding, model, checks, proof, inputRepairs
published contentHash                    : 8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960
recipe verbatim (response minus `proof`) : 1d1fcfdb143b5fb571c63fe42a7016431f0dd687d4256215ad65c8325020d0d2   MISMATCH
minus `inputRepairs` as well             : 8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960   MATCH
codeHash                                 : q1-e1fa99d08887d6cc
```

`8575ce5a…` is the Appendix C exhibit. The same call **without** the wrapper reproduces verbatim,
which is why the defect was invisible to anyone who wrote their request exactly the way the docs do.

A second live reproduction, on a different `perp_gate` body, is recorded in `elapsedms.md` §6.1:
published `3dbb480d…`, recipe verbatim `968b12e2…`, agreeing only once `inputRepairs` is removed.

### 1.2 Locally, on both surfaces, across the whole catalogue

Every service and every input form in `gates/routing-fixtures.mjs`, sent two ways — as written, and
wrapped in `params` — through the **real** paid HTTP route (express + the x402 middleware against a
stub facilitator, as gate P does) and through `handleRpc` on the free MCP surface, plus `snark: true`
on perp-gate:

```
108 responses, 90 enveloped, 48 FAIL the published recipe verbatim
```

Not a corner case: **more than half** of the enveloped responses in the sweep failed their own printed
instruction.

### 1.3 Why the hash is right and the sentence is wrong

`src/engine/proof.js` computes

```
contentHash = sha256(canonical({ engine, codeHash, [observedAtUtc,] inputs, result }))
```

where `result` is the **engine's return value**, hashed *before* `{...result, proof}` is assembled.
The host then attaches its own keys at the top level, after the hash exists. Those keys are inside
what the caller hashes and outside what the service hashed. The stored hash never moved; only the
instruction was insufficient.

---

## 2. Every sibling, enumerated rather than assumed

Found by sweeping, not by grepping — then confirmed against the call sites:

| key | attached at | surfaces | seen on an enveloped response |
|---|---|---|---|
| `inputRepairs` | `src/app.js` (paid route), `src/mcp.js` (`handleRpc`) | both | yes — every service, whenever a body is repaired |
| `routingNotice` | `src/app.js`, `src/mcp.js` | both | yes — 27 measured (called, meant) pairs that both validate and draw a signpost |
| `howToFix` | `src/mcp.js`, when the answer is `ok:false` | MCP | yes — `risk_attest#0`, `risk_attest#1`, `portfolio_gate#1` |
| `snark` | `src/services.js` — `env.snark` and `obs.snark`, inside the handler | both | yes — `perp-gate` with `{"snark": true}` |
| `unknownEnumValues` | `src/mcp.js` | MCP | **no** — it appears only on a refusal that computes nothing and carries no envelope, so it has no preimage to disturb |
| `elapsedMs` | `src/util/timing.js` | both | **no** — placed *inside* the envelope for exactly this reason; `gate:l` holds it there |

`snark` is the one a surface-level fix misses: it is attached inside the service handler rather than
by either surface, so it also reaches the gated `/diag/scan` testers, which are sealed too.

The enumeration itself does not depend on that table being complete, and neither does the fix — see §3.

---

## 3. The recipe was corrected; no field was moved

Moving a sibling into the envelope would also have fixed the arithmetic. It would also have changed
the response shape for every caller already parsing `inputRepairs`, `routingNotice` and `howToFix` —
including this repository's own `gate:p`, `gate:m` and `gate:buyer`, the SDK, and the mis-routed
callers the whole buyer defence was built for. The blast radius of correcting a sentence is zero
parsers.

`verifyContentHash` is **not in the preimage** — it is written into the envelope after the hash is
taken — so its text is free to change. That was verified rather than assumed: the 24 pinned
deterministic hashes and the Appendix C exhibit are byte-identical after the change (§4).

### 3.1 What a response now carries

Inside the envelope, so the caller's own recipe strips it whole and it can never enter a preimage:

```json
"excludedFromContentHash": ["inputRepairs"]
```

and the sentence itself, executable as written:

> Recompute from the response you received: contentHash = sha256(canonical({engine, codeHash, inputs,
> result})) where result = this response WITHOUT its `proof` key **and WITHOUT the host-attached keys
> named in `proof.excludedFromContentHash` = ["inputRepairs"] (attached after the hash was taken, so
> they are not in the preimage)**, the other fields are echoed inside `proof`, and canonical(x) =
> recursive key-sorted JSON…

The list is published even when it is empty, so a caller writes one verifier rather than two branches
— and so its **presence** is the evidence that a response passed through the seal at all.

### 3.2 The list is derived, not written down

A hardcoded strip-list drifts the moment someone adds a twelfth sibling, which is precisely how this
arrived: four workstreams each attached one key. So `src/util/recipe.js` derives it from a property of
the response:

> `proofEnvelope` returns `{...result, proof}`. In JavaScript's insertion order the envelope key is
> therefore the **last** key of the hashed part, and every top-level key appearing after it was
> attached later.

Measured over the 90 enveloped responses of the pre-fix sweep and every sibling combination that
occurs in them, that derivation reproduces the published hash **90/90**. No sibling name appears
anywhere in the fix.

Insertion order is an implementation fact about this host and is deliberately *not* what the caller is
asked to rely on. The caller is handed the resulting **names**, which are order-independent and
survive any JSON parser.

### 3.3 And it is checked, not believed

Every response recomputes its own hash from the recipe it is about to publish, before it is sent. If
that ever fails, the response says so in `contentHashRecipeSelfCheck` and the sentence that accuses
the caller of tampering is replaced by one that blames us. The gate asserts no response ever carries
that field.

### 3.4 Where the seal runs

Four sites, all outermost — after every sibling is attached and immediately before serialisation:

- `src/app.js`, the paid `/api/*` handler
- `src/app.js`, `/diag/scan` and `/diag/scanpost` (they attach nothing themselves, but `snark` does)
- `src/mcp.js`, `handleRpc`

Deliberately **not** wrapped around `SERVICES[].run`: the siblings are attached outside it, and
`gates/preflight.mjs` reads `s.run` as *source* to decide which handlers build a zk proof — another
wrapper there blinds that guard, which is the failure recorded at the foot of `src/services.js`.

### 3.5 The SDK had the same defect

`sdk/index.js` is the executable form of the same recipe, and `verify()` inherited it exactly: it
removed the envelope key and nothing else, so an honest wrapped `perp_gate` response came back
`contentHashOk: false`. `reproduce()` had it too, stripping `proof` and `live` only. Both now read the
published `excludedFromContentHash`, and degrade to the old behaviour when it is absent — which is
correct precisely when nothing was attached.

---

## 4. Proof that nothing moved

`src/engine/` is untouched. The build hash is `q1-e1fa99d08887d6cc`, locally and live, and preflight
confirms `local q1-e1fa99d08887d6cc vs live q1-e1fa99d08887d6cc` over 37 engine files.

All 24 deterministic content hashes — 12 input forms on each of two surfaces — are pinned in
`gates/gateV-recipe-reproduces.mjs` and re-measured on every run, restated there independently of
`gate:l` so two files have to agree. `gate:l`'s own pinned-hash check is green after the change, as is
its Appendix C check.

The exhibit, in every shape that reaches it:

```
HTTP plain    8575ce5ae5bfae9c…  recipe strips []              -> reproduces
HTTP wrapped  8575ce5ae5bfae9c…  recipe strips [inputRepairs]  -> reproduces
MCP plain     8575ce5ae5bfae9c…  recipe strips []              -> reproduces
MCP wrapped   8575ce5ae5bfae9c…  recipe strips [inputRepairs]  -> reproduces
MCP snark     8575ce5ae5bfae9c…  recipe strips [snark]         -> reproduces
```

The paper is unchanged — part 4 keeps its 85 bytes of headroom and `gate:y` reports 8 of 8. The test
suite is unchanged at 386.

---

## 5. The gate

`gates/gateV-recipe-reproduces.mjs` (`npm run gate:v`), 9 checks, 45 seconds.

### 5.1 It reads the recipe; it does not reimplement it

For every response it parses, out of the response's own words:

| what | from |
|---|---|
| the preimage field list | `sha256(canonical({…}))` |
| the envelope key to remove | ``WITHOUT its `proof` key`` |
| the extra keys to remove | ``​`proof.excludedFromContentHash` = [ … ]`` |

…then recomputes and requires equality with the published `contentHash`. **No sibling name appears in
the gate.** A twelfth sibling the seal can see is named by the response and followed; one it cannot
see is not named, is not stripped, and the gate goes red pointing at the key.

That distinction is the whole reason this gate exists. `gate:l` already checked this recipe — and held
the list `['inputRepairs', 'routingNotice', 'howToFix', 'snark']`, removed those keys itself when the
verbatim recipe missed, and printed a note calling them *"a pre-existing sibling, not this field"*. It
was green throughout. A checker that knows what to strip agrees with the code by construction.

The canonicalisation and the hash are restated inside the gate rather than imported: a checker that
imports the function under test cannot witness that function changing.

### 5.2 The corpus

Every service and every input form in `gates/routing-fixtures.mjs`, on both surfaces, in the request
shapes that actually cause a sibling to be attached — because a sweep of well-formed bodies alone
reproduces verbatim and would have been green throughout the defect:

- **plain** — the fixture body as written
- **wrapped** — the same body under `params`, forcing `inputRepairs`
- **misroute** — a body that validates for the called service and still draws a signpost, forcing
  `routingNotice`; the pairs are derived from the fixtures rather than listed
- **snark** — `{"snark": true}` on perp-gate

100 calls, 98 enveloped responses, 55 of them carrying at least one sibling.

The HTTP half runs through the real express app and the real x402 middleware, because the siblings are
attached in the route handler and a sweep that calls `SERVICES[].run` directly — which is what
`gate:l` does — never sees them. That is not a hypothetical blind spot; it is why this shipped.
`X-Forwarded-For` is varied per request purely to get past the 60-per-minute limiter, which is not
what is being measured.

### 5.3 The floors, so the gate cannot pass by reading nothing

Enveloped-response floors per surface, a ceiling on unreached calls, an equality between the fixture
set and `SERVICES`, and — the one that matters most — **at least 30 responses must carry a sibling at
all**. A sweep that stopped producing siblings would otherwise sail through the exact defect this gate
owns. The list of known siblings appears once, as a *coverage* floor and a containment, never as a
strip-list: a new sibling that the seal names and the gate follows is a success, not a chore.

---

## 6. Proof that the gate can fail

`npm run gate:v-revert`, verbatim:

```
GATE V REVERT — proving the recipe gate can fail

  baseline gate V: 9 pass, 0 fail

  revert: UNSEALED — the recipe names only `proof`, exactly as the live service publishes it today
    gate V against reverted code : 3 pass, 6 fail
      RED: ★ following the published recipe reproduces the published contentHash — paid HTTP
      RED: ★ following the published recipe reproduces the published contentHash — free MCP
      RED: ★ every enveloped response was sealed — the exclusion list is published even when it is empty
      RED: ★ the sweep still exercises every sibling this host is known to attach
      RED: ★ not one deterministic content hash moved, and Appendix C still reproduces on both surfaces
      RED: ★ the sweep actually reached the corpus it claims to cover
    names the key it is about      : 5/5 [inputRepairs, routingNotice, howToFix, snark, fails to name]
    companion check stays green    : YES (8 pass, 0 fail)
      because gate L hardcodes the four sibling names and removes them itself, so it cannot fail on the list it holds

  revert: NEW SIBLING (free surface) — one more top-level key in src/mcp.js, attached after the seal
    gate V against reverted code : 7 pass, 2 fail
      RED: ★ following the published recipe reproduces the published contentHash — free MCP
      RED: ★ not one deterministic content hash moved, and Appendix C still reproduces on both surfaces
    names the key it is about      : 1/1 [creditsRemaining]
    companion check stays green    : YES (7 pass, 2 fail)
      because the drift is on one surface only, and a gate that could not tell them apart would not say where to look

  revert: NEW SIBLING (paid surface) — one more top-level key in src/app.js, attached after the seal
    gate V against reverted code : 7 pass, 2 fail
      RED: ★ following the published recipe reproduces the published contentHash — paid HTTP
      RED: ★ not one deterministic content hash moved, and Appendix C still reproduces on both surfaces
    names the key it is about      : 1/1 [billingNotice]
    companion check stays green    : YES (7 pass, 2 fail)
      because the drift is on one surface only, and a gate that could not tell them apart would not say where to look

  restored gate V: 9 pass, 0 fail

RESULT
  [OK] UNSEALED — the recipe names only `proof`, exactly as the live service publishes it today
  [OK] NEW SIBLING (free surface) — one more top-level key in src/mcp.js, attached after the seal
  [OK] NEW SIBLING (paid surface) — one more top-level key in src/app.js, attached after the seal
  [OK] the files are restored and gate V is green again
```

Three things in that output are worth reading twice.

**The first revert is not an invented fault.** It makes the seal the identity function, which is the
code exactly as it stands on the live service. The gate is red on it, on both surfaces, naming all
four siblings — so the claim "this gate would have caught it" is measured rather than argued.

**Under that revert, `gate:l` stays green.** Eight of eight, on the code that publishes a broken
recipe. That is the blind spot stated as a measurement.

**A new sibling on one surface reddens that surface and not the other.** The gate says where to look.

---

## 7. Things found on the way that this work did not fix

### 7.1 `gate:x` is red on a document this work never opened

`npm run gate:x` reports 7 pass, 1 fail: its over-claim rule fires twice, on `PDF_RERENDER.md:142` and
its mirror `pdf-rerender.md:142`, where a superseded Table 2 caption is *reproduced as evidence* inside
a sentence contrasting it with the corrected one. The rule's `isQuoted` guard does not recognise the
typographic quotation marks it is written with.

**Confirmed pre-existing rather than assumed.** With `sealContentHashRecipe` temporarily neutralised —
that is, against the pre-fix code — `gate:x` reports the same 7 pass, 1 fail, the same two findings, at
the same two lines. Nothing in this change touches a document those findings are in, and the five
tests that do not run in the default environment are gated on an archive-node environment variable in
`test/lpdesk.test.mjs`, unrelated to anything here.

`elapsedms.md` §6.4 records the same finding and the same diagnosis, and warns that quoting the phrase
in a new document adds two more false positives. This one is therefore written without reproducing it.

### 7.2 The recipe is now correct on the wire and not yet in the paper

Appendix B and §11.5 of the paper describe the recipe in its old form. They are not wrong about the
preimage — that has not changed — but they do not mention `excludedFromContentHash`. The paper was
left untouched deliberately: part 4 has 85 bytes of headroom, and prose added to it re-cuts what
`/paper/N` serves. The response is self-describing, which is the surface a verifier actually uses.

---

## 8. Verification run

| check | result |
|---|---|
| `npm test` | 386 tests, 0 fail, 5 not run in the default environment |
| `npm run gate:v` | 9 of 9 |
| `npm run gate:v-revert` | 3 reverts, each red and naming its key; restored green |
| `npm run gate:l` | 8 of 8 |
| `npm run gate:y` | 8 of 8 |
| `npm run gate:x` | 7 of 8 — pre-existing, §7.1 |
| `npm run docs:check` | consistent |
| `node gates/preflight.mjs` | PREFLIGHT PASSED |

`codeHash` `q1-e1fa99d08887d6cc`, unchanged locally and live. Nothing here has been deployed.
