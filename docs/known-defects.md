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

---

## 1. `side` and option `type` are matched as exact lowercase strings, and fail open to the riskier default

**Status: NOT FIXED. Scheduled to be fixed immediately after judging closes.** The reason it is not
fixed today is at the bottom of this section, and it is a trade-off, not an excuse.

### The answer is wrong

Not surprising, not a rough edge, not an unusual input handled unusually. **Wrong.** A caller who
sends `side: "SHORT"` and acts on the answer takes the opposite risk from the one they asked about.

Two functions decide direction by comparing against a lowercase literal, and anything that does not
match becomes the *riskier* default rather than a refusal:

```
src/engine/perpGate.js:29     const sideSign = (s) => (s === 'short' || s === 'sell' || s === -1 || s === '-1' ? -1 : 1);
src/engine/optionsRisk.js:32  const type = p.type === 'put' ? 'put' : 'call';
```

### What that does, measured

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

**`options_risk`.** Every `type` that is not the literal string `"put"` is priced as a **call**. Body
`{forward: 100000, positions: [{type, strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1}]}`:

| sent `type` | served as | portfolioValue | delta | self-checks |
| --- | --- | --- | --- | --- |
| `"call"` | call | 3,270.26 | +0.319866 | 6/6 pass |
| `"put"` | put | 13,270.26 | −0.680134 | 6/6 pass |
| **`"PUT"`** | **call** | **3,270.26** | **+0.319866** | **6/6 pass** |
| `"Put"`, `"P"`, `"p"`, `"puts"`, `" put"`, `"banana"`, `null`, `""`, `123` | **call** | 3,270.26 | +0.319866 | 6/6 pass |

The delta sign flips. A caller hedging a put book is handed the greeks of a call book — a position
that moves the other way — and the mark-to-model value is wrong by 10,000 on a single leg.

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

### Why it is not fixed

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

**The fix, in full, for when the window opens.** It is four changes, not one, and only the third
touches the hashed tree:

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

**Status: NOT FIXED.** This is the same defect §11.5 of the paper records finding and fixing on
`perp-gate` symbol mode. `portfolio-gate` was not given the same treatment on the explicit-positions
path.

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

**The fix**, when the window opens: return an observation envelope with `observedAtUtc`, a `live`
block and a `mathReproducibility` note whenever any leg's mark was fetched — exactly as `perp-gate`
symbol mode now does. It is outside `src/engine/` and does not move the build hash; it is held only
because it changes the envelope *kind* on a response shape a reviewer may be mid-way through
verifying, and that is a judging-window argument, not an engineering one.

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

Compare `liquidationPrice` against the same body with `"side":"short"`. If the two differ, §1
reproduces. If they do not, §1 has been fixed and this page is stale — check `/changelog`.
