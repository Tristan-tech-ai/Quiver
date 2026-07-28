# How much of the catalogue the mis-route signpost could actually name

The signpost in `src/util/routing.js` exists because of two half-star reviews. Agent #5152 holds ten
five-star reviews and two half-stars, and both half-stars are the same reviewer agent, which wanted an
Aave lending-protocol health check and called `options-desk`. Two other agents ran the same task
through `protocol-pulse` and scored it 5.0 and 4.8, so the capability was there; the caller picked the
wrong service out of twenty-two and Quiver had no way to say so.

The signpost scores a request against all twenty-two on two signals kept deliberately apart:

- **shape** — does the body carry a service's required keys? A fact about the service.
- **words** — do the body's strings and key names overlap the service's vocabulary? A guess.

Only shape is allowed to redirect. This document is about a limit in shape that nobody had counted,
what it cost, and what the fix does and does not reach.

---

## 1. What was measured

Every claim below comes from sweeping **all 651 ordered pairs of distinct services**: for each pair
(A, B), service B's genuine request body is sent to service A and the signpost's answer is recorded.
Twenty-two services, twenty-one others each, and one body per *accepted input form* rather than one
per service — several services accept more than one form, and "reachable" has to mean reachable the
way a caller would really write the call.

The fixtures are in `gates/routing-fixtures.mjs`. The property that keeps the number honest: **every
fixture body is run through the service's own `validate()` before any sweep result is believed.** A
fixture that has drifted from the schema fails loudly rather than quietly measuring nonsense, which is
how a coverage number becomes a fiction.

## 2. The blind spot, and it was wider than it looked

`shape` read one field, `inputSchema.required`, and **eight of the twenty-two declare that empty**:
chart-press, calldata-x, macro-sentry, perp-gate, portfolio-gate, size-gate, lp-risk, risk-attest.

They declare it honestly. Each accepts alternative input forms, so no single key is required across
all of them — size-gate takes `{winProb, winLossRatio}` **or** `{expectedReturn, volatility}`;
perp-gate takes `margin` **or** `leverage`. There is no one list to put in `required` without lying.
But `shape` computed `satisfied / required.length`, and an empty list can never reach 1, so those
eight scored zero forever and **could never be suggested**.

The sweep then found two more that nobody had predicted:

| Unreachable, and why | |
| --- | --- |
| the eight above | `required: []`, so shape is structurally 0 |
| **token-scan**, **wallet-audit** | they share the *same schema object* (`tokenIn`) with tape-pulse — all three require exactly `{chain, address}`. Three services tie at shape 1 and the tie was broken by vocabulary, which always picked tape-pulse |

**Measured coverage before the fix: 12 of 22, not the 14 that the empty-`required` count implies.**

## 3. The half nobody was looking for: three services flagged their own correct calls

The same sweep turned up something worse than a missed redirect.

Both existing silence sweeps — `gates/preflight.mjs` and `gates/gateBuyer-mistakes.mjs` — synthesise a
test body from `inputSchema.required` and then skip any service whose list is empty:

```js
const req = s.inputSchema?.required || [];
if (!req.length) continue;
```

That is exactly the eight. **A third of the catalogue had never been checked by the check whose
failure costs the most**, and three of them were failing it:

| service | its own genuine body | signpost said |
| --- | --- | --- |
| portfolio-gate | `{positions: [ … ]}` | "you meant **treasury-risk**" |
| chart-press | `{chain, address, interval}` | "you meant **tape-pulse**" |
| macro-sentry | `{hours, spot, atmIvPct}` | "you meant **event-vol**" |

A correct, paid `portfolio-gate` answer was being served with a `routingNotice` telling the caller
they had asked the wrong service. A signpost that fires on a correct call is worse than one that stays
quiet on a wrong one, because it makes a right answer look wrong — and unlike a missed redirect it is
visible in every response.

This is the part of the work that mattered most, and it was not the part that was asked for.

## 4. What changed

**Alternative required sets, declared as fact.** Each service that accepts more than one input form
now states those forms, derived from what its `validate()` actually enforces rather than from what its
description says. Shape scores 1 when any one complete form is present. This widens *which sets count
as complete*; it does not soften *what counts as evidence*, and none of it goes near the words signal.

| service | declared forms |
| --- | --- |
| chart-press | `{symbol}` · `{chain, address}` |
| calldata-x | `{data}` · `{typedData}` |
| perp-gate | a price source × a size × collateral × a maintenance-margin source (24 combinations) |
| portfolio-gate | `{positions}` · `{account}` |
| size-gate | `{winProb, winLossRatio}` · `{expectedReturn, volatility}` |
| lp-risk | `{priceRatio}` · `{volatility}` |
| risk-attest | `{items}` · `{contentHashes}` |
| macro-sentry | **none** — see §6 |

Two more were found whose declared `required` **understates** what they enforce, and they are now
stated accurately. Neither was unreachable; the defect was the other direction — a body carrying only
the declared keys scored a full shape match and pulled redirects it had not earned.

| service | declares | actually refuses without |
| --- | --- | --- |
| exec-verify | `amountIn`, `amountOutRealized` | …and `{reserveIn, reserveOut, feeTier}` **or** `fairPrice` |
| event-vol | `spot` | …and `atmIvPct`/`atmIv`, **and** `daysToEvent`/`T` |

**A count of matched requirements now outranks a vocabulary coincidence.** Ranking candidates on the
blended score alone let the weak signal decide cases the strong one had already settled:

```
body {symbol: "BTC", notional: 60000, leverage: 10}
  perp-gate     shape 1.000  satisfied 3  words 0.050  score 3.10
  chart-press   shape 1.000  satisfied 1  words 0.091  score 3.18   <- won, on word overlap alone
```

Both are complete calls, which is the point — but perp-gate matched three required keys and
chart-press matched one. Ranking is now lexicographic and the order states which evidence outranks
which: a complete form beats an incomplete one; among complete forms, more required keys matched; only
then the blended score, where vocabulary finally gets a vote. `satisfied` was already being computed
and then thrown away by dividing it into a fraction, so this is not a new signal.

## 5. Results

|  | before | after |
| --- | ---: | ---: |
| services the signpost can name | **12 / 22** | **19 / 22** |
| ordered pairs redirected correctly | 249 / 651 | **536 / 651** |
| ordered pairs mis-directed | 127 | **75** |
| ordered pairs silent | 275 | 40 |
| services flagging their own correct call | **3** | **0** |

Per target, over the 21 other callers × each accepted form:

| meant | before | after | what the signpost said, after |
| --- | ---: | ---: | --- |
| tape-pulse | 19/21 | 18/21 | tape-pulse 18 · silent 3 |
| chart-press | 0/42 | **39/42** | chart-press 39 · silent 3 |
| poly-fill | 21/21 | 21/21 | poly-fill 21 |
| poly-desk | 21/21 | 21/21 | poly-desk 21 |
| options-desk | 21/21 | 21/21 | options-desk 21 |
| lp-desk | 21/21 | 21/21 | lp-desk 21 |
| calldata-x | 0/42 | **42/42** | calldata-x 42 |
| protocol-pulse | 21/21 | 21/21 | protocol-pulse 21 |
| macro-sentry | 0/42 | 0/42 | silent 22 · event-vol 20 |
| updown-pulse | 21/21 | 21/21 | updown-pulse 21 |
| loop-digest | 1/21 | **21/21** | loop-digest 21 |
| token-scan | 0/21 | 0/21 | tape-pulse 18 · silent 3 |
| wallet-audit | 0/21 | 0/21 | tape-pulse 18 · silent 3 |
| perp-gate | 0/42 | **42/42** | perp-gate 42 |
| portfolio-gate | 0/42 | **21/42** | portfolio-gate 21 · treasury-risk 19 · silent 2 |
| size-gate | 0/42 | **42/42** | size-gate 42 |
| exec-verify | 42/42 | 42/42 | exec-verify 42 |
| options-risk | 20/21 | 19/21 | options-risk 19 · silent 2 |
| lp-risk | 0/42 | **42/42** | lp-risk 42 |
| treasury-risk | 20/21 | 19/21 | treasury-risk 19 · silent 2 |
| risk-attest | 0/42 | **42/42** | risk-attest 42 |
| event-vol | 21/21 | 21/21 | event-vol 21 |

**Three outcomes changed from a redirect to silence** and each was checked individually rather than
counted as a regression: `{chain, address}` sent to chart-press, and a positions array sent to
portfolio-gate (twice). In all three the called service's own `validate()` **accepts and serves the
body**. Redirecting a caller away from a service that can answer them is the guess this component
exists not to make, so silence is the correct outcome — it is the same "a correct call stays quiet"
property, now extended to services that never had it. There were **zero** cases of a correct redirect
becoming a wrong one, and zero of a silence becoming a wrong redirect.

## 6. What is still unreachable, and why it is not a bug to fix later

Named rather than rounded away, and asserted as an **equality** in the gate, so this list cannot rot
quietly in either direction.

- **macro-sentry.** Its `validate()` never refuses: every field defaults, `hours` to 72, so an empty
  body is a complete call. It genuinely requires nothing, so there is no shape to match. Declaring
  `{hours}` as required would make it reachable and would be a fiction — `hours` is optional, and the
  field is called `anyOfRequired`. **The honest answer is that the shape signal cannot name a service
  that requires nothing**, and inventing a discriminator would be exactly the guessing this design
  keeps out of the redirect path.
- **token-scan** and **wallet-audit.** Both share the `tokenIn` schema object with tape-pulse; all
  three require exactly `{chain, address}`. A body carrying those two keys has *genuinely not said*
  which of the three questions it is asking, so no fact in the request can pick one. The signpost
  names tape-pulse, which is at least the right neighbourhood, and it should not pretend to more.

**Deliberately not done: matching nested item schemas.** The remaining 19 mis-directed pairs are
almost all `portfolio-gate → treasury-risk`, where both match the single top-level key `positions`.
There *is* declared fact one level down — treasury-risk declares `positions.items.required =
['asset','amountUsd']`, options-risk declares `['type','strike','iv','quantity']`, portfolio-gate
declares no item schema — and using it would resolve the three-way tie. It is left alone on purpose:
`gates/preflight.mjs` synthesises `positions: []` for array fields, an empty array would fail an item
check, and the interaction would introduce a *new* false positive into the very sweep that guards
against false positives. That is a change to make deliberately with its own measurement, not as a
rider on this one.

## 7. Nothing a buyer reads moved

An OKX re-review pulls all twenty-two listings back into moderation, and it is triggered by a change
to the ASP name, description, service list, or endpoints. Each of these was executed, not assumed.

| claim | how it was checked | result |
| --- | --- | --- |
| the engine build hash | `_internal.buildId()` vs live `/build` | `q1-e1fa99d08887d6cc` both sides, 37 engine files both sides |
| the advertised `inputSchema` | the alternatives are a table keyed by service name inside `src/util/routing.js`, never a field on a service object | there is no serialisation path to leak through |
| the live MCP `tools/list` | POSTed to the live endpoint and to a locally booted build, JSON compared | byte-identical, 29,411 bytes both sides |
| the live `/` service index | fetched from live and from a locally booted build | the `services` block byte-identical, 22 entries; only `identity.proofSigner` and the Base payment rail differ, both because the local process has no keys configured |
| content hashes | the preflight sweep replaying every service and every optional field of each | every already-valid body still comes back byte-identical |

The signpost only ever adds a `routingNotice` **sibling** of `result` and `proof`, never anything
inside either, so a redirect that newly fires cannot move a content hash.

Placing the table in `routing.js` rather than on the service object was the deliberate trade. It buys
a *structural* guarantee against leaking into the listing instead of a diff-verified one, and it
avoids editing `src/services.js` while another agent is working in that file. The price is that the
table can drift from the schemas, and that price is paid in §8.

## 8. Gates, and the proof that each can fail

Added to `gates/gateR-misroute.mjs` (run by `npm run gate:r`; it is not in `test/`, so the suite size
the paper quotes is unchanged) and to `gates/preflight.mjs`, which always runs before a deploy —
because a gate that lives only behind its own npm script is a gate that quietly stops being run, which
has already happened once in this repository.

- every fixture is a call the service itself would accept
- each of the seven services with declared alternatives is reachable, **asserted one by one**, so a
  partial fix cannot read as a whole one
- the twelve that were already reachable still are
- the unreachable set equals exactly `['macro-sentry','token-scan','wallet-audit']`
- **a correct call to any of the twenty-two stays silent, including the eight the old sweeps skipped**
- every declared key is a real property of that service
- the table agrees with the schemas that already publish their own `anyOf`/`allOf` (perp-gate,
  portfolio-gate)
- a service with no flat required list is never left out of the table — this is the check that
  survives somebody adding a twenty-third service
- nothing about the table reaches the advertised `inputSchema`

`npm run gate:r-revert` executes four independent reverts and requires the gate to go red for each,
then green again once restored — and requires the *specific check that owns the claim* to be the one
that failed, not merely that something did:

```
  baseline (unmodified)      : 15 pass, 0 fail

  revert: COVERAGE — the alternative-form declarations are removed
    gate against reverted code : 10 pass, 5 fail
      RED: each of the eight services that declare no flat required list is reachable, one by one
      RED: the services a body genuinely cannot single out are named, and are exactly these
      RED: a correct call to ANY of the twenty-two stays silent, including the eight
      RED: the table agrees with the schemas that already publish their own alternatives
      RED: a count of matched requirements outranks a vocabulary coincidence

  revert: RANKING — candidates are ranked on the blended score alone
    gate against reverted code : 14 pass, 1 fail
      RED: a count of matched requirements outranks a vocabulary coincidence

  revert: SILENCE — a redirect may fire even when this service can serve the body
    gate against reverted code : 13 pass, 2 fail
      RED: every service leaves its own correct requests alone
      RED: a correct call to ANY of the twenty-two stays silent, including the eight

  revert: DRIFT — a declared requirement names a key no service accepts
    gate against reverted code : 14 pass, 1 fail
      RED: every declared key is a real property of that service

  gate against restored code : 15 pass, 0 fail

GATE R REVERT: PASSED — every routing-coverage check is capable of failing
```

## 9. Reproducing any of this

```bash
npm run gate:r            # the coverage, silence and drift checks
npm run gate:r-revert     # proof that each of them can fail
npm run preflight         # the same checks, plus the live re-review guards
npm test                  # the suite, unchanged in size
node tools/docs-consistency.mjs
```
