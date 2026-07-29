# The join has a caller now: what was actually in the way, and what the proof still does not say

**Written 29 July 2026.** Follows `A0_HYPEREVM_VERIFIER.md` §7, which found the defect and, being
forbidden from touching the service, wrote down the one-line change that would fix it.

The finding reproduced. The one-line change would not have fixed it. Both halves are below, measured.

| | result |
|---|---|
| the finding, reproduced against the live service before anything was changed | CONFIRMED |
| the proposed one-line fix, measured over the live Hyperliquid universe | **0 of 232 perps** would have produced a proof |
| what shipped instead | **231 of 232** |
| gate S — the proof is reachable, verifies, and certifies the served answer | 9 of 9 PASS |
| gate S revert — four scripted defects, each must turn it red | 4 of 4 red, green again after restore |
| engine `codeHash` | `q1-e1fa99d08887d6cc`, unmoved |
| `npm test` | 386, unmoved |
| `gates/preflight.mjs` | PASSED |

---

## 1. Reproducing it, before touching anything

Both branches, against the deployed service, through the free gated tester:

```
/diag/scan?svc=perp-gate&symbol=BTC&side=long&size=1&leverage=10&snark=true
  -> observation envelope, snark: undefined, live.filled._entryDefaultedToMark: true
     entryPrice 63785 == markPrice 63785, observation.contentHash aae967cf…

/diag/scan?svc=perp-gate&side=long&entryPrice=64000&size=1&leverage=10&maintMarginRate=0.0125&snark=true
  -> proof envelope, snark { status: "building", retrieveAt: "/proof/b2fc805f…" }
```

Exactly as reported: the SNARK is built where the entry price is the caller's own number, and the
entry price is HyperCore's mark on the branch that returns no SNARK. The two are the arms of one `if`
in `src/services.js`, so no request can be in both.

---

## 2. The reason it was not a one-line change

`A0` §7 proposes adding `buildInBackground(env.observation.contentHash, …)` to the observation branch.
Run that against the live venue and it produces, for every Hyperliquid symbol, a stored record reading
`status: "unavailable", error: "this position is outside the circuit domain"`.

The circuit's witness needs a maintenance-margin **rate**. Hyperliquid does not publish one. It
publishes notional **margin tiers**, and `enrichPerpInputs` fills `marginTiers` into the inputs; the
engine then selects the tier by notional and derives `mmr = 0.5 / maxLeverage` itself. So the echoed
inputs carry no `maintMarginRate`, `witnessFor` returns `null`, and the proof is honestly refused.

dYdX publishes a rate, so dYdX symbol mode does build a witness. Which is exactly backwards:

| symbol mode | echoes a rate? | witness from echoed inputs | can HyperCore attest the mark? |
|---|---|---|---|
| Hyperliquid | no — `marginTiers` | **null** | **yes** |
| dYdX | yes — `maintMarginRate` | builds | no — the precompiles hold no dYdX state |

The one-line change connects the proof to the venue whose mark no chain in this design can corroborate,
and leaves the venue it can corroborate exactly as unreachable as before. Measured over the whole live
universe, sizing each position at a ~$5,000 notional and a leverage safely above maintenance for that
asset's own tier:

```
HL symbol-mode answers that echo maintMarginRate       :   0 / 232
certifiable with ONLY the echoed inputs (the one-liner):   0 / 232
certifiable with the engine-derived rate (what shipped): 231 / 232
```

So the witness is built from the echoed inputs **plus the rate the engine derived**, taken from
`r.inputs.maintMarginRate` — the engine's own `mmr` at full precision. Not from the display fields
beside it: `r.inputs.size` is `round(q, 8)` and `r.inputs.margin` is `round(M, 2)`, and certifying
either would prove a neighbouring position. That trap is already documented in the caller-supplied
branch, in those words, about `margin`; this is the same trap one field over.

The derived rate is not a number a reader has to take on trust. It is published in the response as
`snark.maintenanceRateProven`, it is checkable against public signal 6, and it is re-derivable from
`observation.inputs.marginTiers` by anyone running the open engine. Gate S.3 asserts all three agree,
including against the answer's own `maintenanceMarginRatePct`.

The remaining 1 of 232 is `RUNE`, refused for an unrelated pre-existing reason — see §7.

---

## 3. What is returned, and why it is not a proof envelope

The rule this codebase enforces in `proofEnvelope` itself, after fixing it at three call sites on three
separate occasions and missing a fourth, is that **a result carrying live provenance is never sealed as
a deterministic proof**. There is a test named almost exactly that. Nothing here weakens it:

- the envelope stays an **observation**: `kind: "OBSERVATION"`, `deterministic: false`;
- the SNARK is attached as a **sibling** of `observation`, exactly as it is a sibling of `proof` on the
  other branch — never inside `result`;
- `contentHash` is computed before the attachment and over the same inputs as before, and the delivery
  flag was already destructured out of the request so it can never enter the hash.

The distinction that matters is that the two claims are different sizes and the response has to make
that visible:

> The **SNARK** proves the liquidation identity over five pinned integers. That statement is
> deterministic, and it is checkable offline against the published verification key.
>
> The **ENVELOPE** commits a live upstream read at `observedAtUtc`. That is not re-runnable, and no
> SNARK can make it so, because the circuit has no term for where a number came from.

A proof over a live-fetched mark proves the arithmetic. It does not prove the mark. So the answer
carries, in fields a program can read rather than prose a reader has to notice:

```json
"snark": {
  "protocol": "plonk", "status": "building",
  "retrieveAt": "/proof/<observation.contentHash>", "verificationKey": "/proof/vk",
  "inputsWereFetchedLive": true,
  "entryPriceSource": "live-mark",
  "entryPriceVenue": "hyperliquid",
  "entryPriceProven": 63878,
  "maintenanceRateProven": 0.0125,
  "observedAtUtc": "…",
  "proves": "The liquidation identity over the five integers pinned in the proof's public signals …",
  "doesNotProve": "That the entry price it pins is the venue's mark, or that the venue's mark is right …",
  "markAttestation": { "appliesToThisAnswer": true, "deployed": false, "mechanism": "…", "window": "…" }
}
```

`markAttestation.deployed` is `false` and stays false until a contract exists at an address.
`A0` §8 records the reason: **$0.00 spent, zero transactions**, no funded wallet on chain 999. A
response that described the join without saying that would be advertising something that has not
happened, which is the failure this project has already shipped once and gated against since.

### The three cases the field has to tell apart

`inputsWereFetchedLive` is true on the whole observation branch — the tiers and the funding rate were
fetched whatever else happened — so it is not sufficient on its own. Two more facts decide whether the
on-chain half can reach this answer at all, and gate S.7 asserts each:

| call | `entryPriceSource` | `markAttestation.appliesToThisAnswer` |
|---|---|---|
| `{symbol: BTC}` — entry defaults to the mark | `live-mark` | **true** |
| `{symbol: BTC, entryPrice: 64000}` | `caller-supplied` | false — nothing for HyperCore to corroborate |
| `{symbol: BTC, venue: dydx}` | `live-mark` | false — the precompiles hold no dYdX state |

A single "verifiable on chain" banner over all three would be a false attestation. The middle row is
the subtle one: it looks like symbol mode, it *is* symbol mode, and the number that would be compared
against HyperCore is the caller's own.

---

## 4. The proof outlives the answer, so the disclosure had to travel with it

`/proof/<hash>` is free and is deliberately fetchable by somebody who never saw the response — that is
a stated feature of the design, and it lets a third party pull the proof for someone else's answer. At
that endpoint, before this change, a proof whose entry price was read off a venue was indistinguishable
from one whose entry price a caller typed. Both are eight field elements and a Plonk transcript, and
the circuit cannot carry the difference.

So `buildInBackground` takes an optional `provenance` object, stored verbatim on the finished record
and surfaced by `/proof/<hash>` immediately above the `onChain` instruction — which is where a reader
forms the belief that the thing is verifiable end to end, and where, for a live-read input, it is the
arithmetic that gets verified and not the input.

It is spread rather than assigned, at both the store and the route, so **a proof built from
caller-supplied inputs serialises exactly as it did before this field existed**. Gate S.9 asserts that
as the whole key list in order, because an added key is as much a change as a removed one, and this
endpoint is what a buyer checks a published proof against.

---

## 5. Proving the negative, executably

"The SNARK does not prove the mark" is a claim, and a gate that only reads the sentence saying so
proves nothing about the code. Gate S.6 demonstrates it instead:

1. build a proof in symbol mode, where the entry price IS the mark at `observedAtUtc`;
2. wait, and read the mark again, direct and uncached — measured at 9.4 to 107.9 ppm of movement over
   an 8-second interval across runs;
3. the proof **still verifies**. If it attested the mark it could not.
4. substitute the current mark into the price signal and it **stops verifying**. The proof is bound to
   a frozen number, not to "whatever the mark is".

Which is the whole argument for the on-chain half, and the reason the response points at it.

Gate S.5 adds the guard against the over-claim creeping back in as prose: every field of the snark
block except `doesNotProve` is scanned for any assertion that the mark, the entry price or the input is
proven, attested or verified. `doesNotProve` is exempt because saying "this does not prove the mark" is
the opposite of the claim being banned.

### The revert, run

```
GATE S REVERT: proving the gate is capable of failing

  engine build id before : q1-e1fa99d08887d6cc

  --- revert 1 (services.js): the symbol-mode branch no longer builds a proof at all (the state this work found)
      gate against reverted code : 2 pass, 7 fail
      red: S.1 a symbol-mode call produces a proof that can actually be fetched
      red: S.2 that proof verifies against the key the service publishes
      red: S.3 the value it certifies is the value the answer reported
      red: S.5 THE NEGATIVE: the answer says, in machine-readable form, that the inputs were fetched
      red: S.6 THE NEGATIVE, EXECUTED: the proof is bound to a frozen number, not to "the mark"
      red: S.7 the two ways the input is NOT attestable are told apart, and neither is dressed up
      red: S.9 a proof fetched WITHOUT its answer still says its input was a live read

  --- revert 2 (services.js): the machine-readable "these inputs were fetched" flag lies, in the answer AND on the proof
      gate against reverted code : 6 pass, 3 fail
      red: S.5 THE NEGATIVE: the answer says, in machine-readable form, that the inputs were fetched
      red: S.7 the two ways the input is NOT attestable are told apart, and neither is dressed up
      red: S.9 a proof fetched WITHOUT its answer still says its input was a live read

  --- revert 3 (services.js): the snark block claims it also proves the entry price is the venue mark
      gate against reverted code : 8 pass, 1 fail
      red: S.5 THE NEGATIVE: the answer says, in machine-readable form, that the inputs were fetched

  --- revert 4 (app.js): a proof fetched without its answer loses the fact that its input was a live read
      gate against reverted code : 8 pass, 1 fail
      red: S.9 a proof fetched WITHOUT its answer still says its input was a live read

  2 files restored
  gate against restored code : 9 pass, 0 fail
  engine build id after  : q1-e1fa99d08887d6cc

  [PASS] revert 1 makes gate S fail
  [PASS] and the failure is the positive half (S.1-S.3) and every negative that needs a snark to inspect
  [PASS] revert 2 makes gate S fail
  [PASS] and the failure is S.5 and S.9, the assertions that the inputs were disclosed as live
  [PASS] revert 3 makes gate S fail
  [PASS] and the failure is S.5, the scan that forbids claiming the fetched input is proven
  [PASS] revert 4 makes gate S fail
  [PASS] and the failure is S.9, the assertion that /proof/<hash> discloses a live-read input
  [PASS] and the gate PASSES again once every revert is undone (9 pass, 0 fail)
  [PASS] engine build id unmoved (q1-e1fa99d08887d6cc -> q1-e1fa99d08887d6cc)

==========================================================================
GATE S REVERT: PASSED, the gate is capable of failing
```

Revert 3 is the one worth reading twice. It adds a single clause — *"and it also proves that the entry
price is the live mark HyperCore holds"* — to a field nobody would look at twice, and the gate catches
it. That sentence is the failure mode this whole exercise is guarding against, and it is exactly the
kind of thing that gets written by someone trying to be helpful.

---

## 6. Nothing that already worked moved

Measured against the deployed service, not reasoned about.

| | measured |
|---|---|
| engine `codeHash`, local vs live `/build` | `q1-e1fa99d08887d6cc` = `q1-e1fa99d08887d6cc` |
| engine file count | 37 = 37 |
| caller-supplied `contentHash`, local vs live | `b2fc805f…` = `b2fc805f…` |
| the whole caller-supplied response, signature aside | **byte-identical** to live |
| published Appendix C `contentHash` | `8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960` |
| `snark` object on the caller-supplied branch | asserted as the exact five-key object, note string included (S.8) |
| symbol mode with no `snark` asked for | top-level and `observation` key sets identical to live |
| advertised `inputSchema` in the mandatory 402 challenge | identical |
| index service names, order, blurbs and prices | identical, sha256 `afe23dc1a70c62b0` |
| MCP `tools/list` bytes | identical, sha256 `c98cdfebcdc84e8c` |
| `/proof/<hash>` shape for a caller-supplied proof | the same 11 keys, in order (S.9) |
| `npm test` | 386 tests, 0 fail |
| `gates/preflight.mjs` | PASSED, including that the proof-emitting set is still exactly `[perp-gate]` |
| `npm run gate:a` (the durability gate, not ours) | 11 of 11 |
| `node tools/docs-consistency.mjs` | CONSISTENT |

Three things differ between a local run and the deployed service, and all three are environmental
rather than caused by this work: the local process has no `QUIVER_SIGNING_KEY`, so the T1 signature and
the `T0`/`T1` attestation string differ; the 402 challenge names `localhost` in `resource.url`; and the
Base rail is absent locally for want of CDP credentials. Setting a throwaway signing key makes the
caller-supplied response byte-identical apart from the signature bytes themselves, which is what a
different key produces.

`src/engine/` was not touched. `src/services.js`, `src/util/snark.js`, `src/util/grid.js` and
`src/app.js` all sit outside the hashed tree — confirmed by reading `buildId()`, which walks
`src/engine` recursively and nothing else, and by the hash being the same string before and after.

---

## 7. What this does not fix, and one thing it exposed

**The mark is still only as good as HyperCore.** Unchanged from `A0` §9. The precompile returns a
stake-weighted median of external venues; a manipulated oracle is attested with full force. The join
reaches the venue's committed state and stops.

**Nothing is attested yet.** The contract is not deployed and no wallet reachable from this machine
holds HYPE. Until it is, `markAttestation` describes what *would* cover the input.

**The window is wide, for reasons the service can fix and this change did not.** `A0` §6 measured
4,055 ppm and named the two causes: the 30-second HTTP cache in `src/adapters/hyperliquid.js`, and
reading the mark over HTTPS at all rather than from the precompile. Both are still true. Forcing the
cache when a proof is being built is a one-flag change to an argument `fetchPerpContexts` already
accepts, and it would take the interval from ~31 s to ~2 s and the window from 4,055 to about 1,077 ppm.
It was left alone deliberately: it changes the *number the answer reports*, which is a behaviour change
to a paid endpoint on a day with no deploy window, and it deserves its own measurement.

**Live-fetched proofs never deduplicate.** The caller-supplied `contentHash` is a pure function of the
position, so the same request is answered from the store rather than re-proved. An observation hash
commits `observedAtUtc`, so every symbol-mode request with `snark: true` costs a fresh ~700 ms of
proving. The existing backpressure covers it — `MAX_QUEUED = 8`, past which callers are told no rather
than silently stacking work — and this branch is the *paid* one, but it is a real cost difference and
it is not hidden.

**The MCP twin was deliberately not changed**, and that is a departure from this codebase's own hard-won
rule that fixing call sites one at a time does not work. The reason is specific: `src/mcp.js` builds its
SNARK from inputs that were never put through `gridSnapFields`, so a proof from that path is already
about a position up to 3.5e-6 away from the answer — which this project's own standard calls a proof of
a nearby position and therefore not a proof. Adding a second, free, un-snapped proof surface would have
shipped something the repository rejects on its own terms. Worse, `gates/preflight.mjs` cannot see this:
its grid check reads `SERVICES.map(s => s.run)` and the MCP tool handlers are a different array, so the
check reports success over a path it does not examine. That is a check that cannot fail, which is the
disease this project has a document about. Recorded here, not fixed here, because the fix — adding
`gridSnapFields` to the MCP handler — would move content hashes for any caller sending an off-grid
number, and that is the one thing this work was told not to do.

**The divergence guard has almost no headroom on cheap assets, and that is pre-existing.** The refusal
that stops a proof certifying a different position is `gapToServed <= 0.005`, sized as half a cent
because the served price is rounded to 2dp. Measured over the live universe:

| | measured |
|---|---|
| assets whose liquidation price is below \$1 | **189 of 232** |
| assets whose gap is already within 10% of the 0.005 ceiling | **30** |
| worst | `RUNE`, gap 5.000e-3, liquidation price \$0.24 — **refused a proof by rounding alone** |
| median gap across the universe | 2.632e-3 |

No proof is wrong because of this: `pLiqHat` is the canonical integer solve and is correct by
construction. What is lost is the guard's ability to *distinguish* display rounding from a genuine
divergence, on the majority of the universe. It applies identically to the caller-supplied branch — a
\$0.27 position sent with every input explicit lands at 1.284e-3 — and was invisible until now only
because that branch is exercised with BTC and ETH. The honest fix is to compare against an unrounded
price rather than to widen the tolerance, and it belongs to whoever owns the display rounding.

---

## 8. How to run it

```
npm run gate:s              # 9 assertions, ~20 s, needs the network (live Hyperliquid + real proving)
npm run gate:s-revert       # four scripted defects, each must turn the gate red, ~2 min
node gates/preflight.mjs    # the deploy seatbelt, unchanged and still green
npm test                    # 386
```

Gate S builds real Plonk proofs against live venue data. It is slow and it is not offline, on purpose:
the defect it guards lives in the seam between a live read and a deterministic proof, and a fixture on
either side of that seam would have hidden it.
