# The proof-publication guard had stopped being a guard for anything cheap

**Written 29 July 2026.** `src/util/snark.js` refuses to publish a Plonk proof whose witness disagrees
with the answer that was served. It refused on one line:

```js
const DISPLAY_ROUNDING = 0.005;
if (!(w.gapToServed <= DISPLAY_ROUNDING)) { /* refuse */ }
```

Half a cent, sized off `liquidationPrice: round(pLiq, 2)` in `src/engine/perpGate.js`. Correct
reasoning for BTC, and on the majority of the live perp universe it could no longer tell display
rounding from a genuine witness/engine divergence at all.

| | result |
|---|---|
| the reported measurements, reproduced against live Hyperliquid before anything changed | **CONFIRMED** |
| the refusal with nothing wrong, reproduced deterministically without a venue | **CONFIRMED** |
| the first bound written for the fix — a first-order sensitivity sum | **WRONG, and measured wrong: 153 of 357,138 positions exceeded it** |
| what shipped | recompute the price *unrounded*; bound the witness against it by the encoding, exactly |
| worst honest live position, as a fraction of the new bound | **96.14%** of 1,856; none exceeds it |
| how much tighter, on a \$0.24 liquidation | **1.0 × 10⁷ ×** |
| gate W | 8 of 8 PASS |
| gate W revert — five scripted defects, each must turn it red | **5 of 5 red, green again after restore** |
| engine `codeHash` | `q1-e1fa99d08887d6cc`, unmoved; `src/engine/` byte-identical |
| Appendix C `contentHash` | `8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960`, reproduces |
| `npm test` | 386, unmoved |
| `gates/preflight.mjs` | PASSED |
| `node tools/docs-consistency.mjs` | CONSISTENT |

---

## 1. Reproducing it, before touching anything

The reported measurement is the whole live Hyperliquid universe, each perp sized at a ~\$5,000
notional with a leverage safely above that asset's own maintenance tier, through the symbol-mode path
`src/services.js` actually uses: `enrichPerpInputs` → `gridSnapFields` → `perpGate` → `witnessFor`,
with the maintenance rate supplied from the engine's own derived `mmr` because Hyperliquid publishes
notional tiers and no rate.

"Leverage safely above the tier" is `max(2, floor(maxLeverage / 2))` — twice the initial margin the
venue's own headline leverage would post, four times the maintenance requirement. That reading of the
phrase is the one that reproduces; three others were measured too and differ only in the noise.

| | reported | measured, 29 Jul 03:52 UTC | other snapshots |
|---|---|---|---|
| perps in the universe | 232 | **232** | 232 |
| liquidation price below \$1 | 189 of 232 | **189** | 181–189 |
| gap within 10% of the 0.005 ceiling | 30 | **31** | 18–32 |
| median gap | 2.632e-3 | **2.5506e-3** | 2.600e-3 – 2.800e-3 |
| worst | RUNE 5.000e-3 at \$0.24, refused | **SNX 4.980e-3 at \$0.12** | CHIP, GOAT, XAI at 4.98e-3 |

**The numbers reproduce.** The gap is essentially uniform on [0, 0.005] regardless of price, which is
what a distance-to-the-nearest-cent looks like, and the median lands where a uniform draw puts it. The
counts that move between snapshots (31 versus 30, 189 versus 181) move because marks move; the
structure does not.

**The caller-supplied path has the same property**, and it is not a symbol-mode artifact. A position
sent with every input explicit — `long 20000 @ 0.3, 10×, mmr 0.0125`, served \$0.27 — lands at
`gapToServed` 3.4177e-3, which is 1.266% of the price it is a proof about. The reported \$0.27 case at
1.284e-3 is the same position class at a different draw from the same uniform.

### 1a. The refusal, made deterministic

RUNE at 5.000e-3 is a knife edge: it needs the unrounded price to sit within about a nanodollar of a
half-cent boundary, so it appears and disappears with the mark and it did not appear in the snapshot
above. It is not luck and it does not need a venue. Take

```js
{ side: 'long', entryPrice: 0.5, size: 1, margin: 0.4358125, maintMarginRate: 0.0125 }
```

* the engine's unrounded liquidation price is **0.065 exactly**
* the circuit's canonical integer solve is **0.065 exactly** — the two agree to the last bit
* the engine displays it as **0.07**, because the double nearest `0.065` sits a hair above the decimal
  and `toFixed(2)` rounds half up
* `gapToServed` is therefore `0.0050000000000000044`, and the old rule **refused the proof**

Nothing is wrong with that position. The guard was reading the arithmetic of its own tolerance as
tampering. This fixture is `gates/gateW-divergence-guard.mjs` W.6, and it asserts the defect still
exists in the old number before asserting the new one publishes — so the day it stops reproducing, the
gate says so instead of quietly testing nothing.

---

## 2. Why widening or rescaling the tolerance cannot work

Both obvious repairs fail for the same reason, and it is worth writing down because the failure is not
about the size of the constant.

`gapToServed` compares the circuit's price against `round(pLiq, 2)`. That comparison carries an
**absolute** half-cent of display rounding whatever the price is. So:

* **widening it** — 0.01, 0.02 — makes the guard blinder everywhere and buys nothing at the boundary,
  which is a tie and will always be a tie one step further out.
* **scaling it by price magnitude** cannot go *below* half a cent for a cheap asset without refusing
  honest answers, because honest answers there really do sit up to half a cent from the served price.
  A tolerance of `max(0.005, k·P)` is the old rule with extra words.

The display rounding has to leave the comparison. That means having the price **before** it was
rounded, and the rounding happens inside `src/engine/perpGate.js`, which must not change. So the
unrounded price is recomputed outside the engine — which is the trap in this repository, not the fix.

---

## 3. Not re-deriving the expression

A `constantproduct` encoder once rearranged this kind of algebra into a mathematically equal,
numerically different form and was wrong by up to 64 grid steps. That defect class has appeared three
times here. So nothing is re-derived.

The expression used is **`scale.engineLiquidationPrice`**, which was already written down in
`src/util/scale.cjs` — "the engine's computation, in doubles, exactly as stated in the brief, retained
so the canonical integer path can be checked against it". It is the engine's line, character for
character:

```
src/engine/perpGate.js:113   const pLiq = (s * q * P0 - M) / (q * (s - mmr));
src/util/scale.cjs             return (s * q * P0 - M) / (q * (s - mmr));
```

The other half of "the same position" is margin, and `witnessFor` already formed it in the engine's
order — `q * P0` first, then divided by leverage — for the reason its own comment gives.

**W.1 does not take that on trust and does not compare the two by eye.** It lifts the engine's own
source line out of `src/engine/perpGate.js` with a regex, compiles it with `new Function`, and requires
`Object.is` agreement with `scale.engineLiquidationPrice` over 200,000 random positions spanning nine
orders of magnitude on each input. A rearrangement passes a textual check only when the text is
identical; it fails this one on the first position where the two evaluation orders part. W.2 does the
same for the display rounding against `round` from `src/engine/stats.js`.

Agreement with the engine over the *whole universe* rather than a sample is W.3: for all 1,856 live
positions (232 perps × 4 leverage rules × both sides), `displayRound(recomputed)` is the served
`liquidationPrice`. Zero misses. Zero misses across 107,122 synthetic positions too.

---

## 4. What the guard asks now

Four questions in `buildOnce`, each with its own refusal so the stored record says which one failed.

1. **Is there an answer to be a proof of?** A position at or below maintenance has no future
   liquidation threshold and the engine returns no price. The old guard reached that state as
   "diverges from the served price by NaN", which is true and teaches nothing.
2. **Does the witness describe the position the engine priced?** `displayRound(enginePrice) === served`
   — an equality against the engine's own rounding, not a tolerance. This is the whole of what the old
   half-cent rule could ever detect, asked in a form where the boundary case cannot arise.
3. **Can the 1e-9 grid pin this position at all?** If encoding the inputs could move the price further
   than `DISPLAY_HALF_UNIT`, no proof of it is a proof of this answer, however sound the arithmetic.
4. **Does the circuit's integer solve agree with that price?** `gapToEngine <= encodingBound`, at grid
   resolution rather than display resolution.

Composed, the guarantee is what it always was — the certified price is within one displayed unit of
the served price — with the second half of it now measured at 5e-10 instead of 5e-3.

---

## 5. The bound, and the version of it that was wrong

```
encodingBound = HALF_STEP + encodingShift + fp
```

* `HALF_STEP = 0.5 / SCALE = 5e-10`. `canonicalLiquidationPrice` solves the identity exactly over the
  encoded integers and rounds **once**, half away from zero, so this is exact and reachable at a tie.
* `encodingShift` is how far snapping the inputs onto the grid could have moved the price.
* `fp` is sixteen ulps for evaluating any of it in doubles. It is the only generous term and it is
  there because a guard that fires on its own arithmetic noise is the defect, not the fix.

**The first version of `encodingShift` was a first-order sensitivity sum** — `|∂P/∂M|·h + |∂P/∂q|·h +
…` — which is how anyone would write it. It is not a bound. At a size near the grid step itself a
half-step perturbation is a third of the value and Taylor says nothing: **153 of 357,138 sampled
positions exceeded it**, the worst by 49%. Found by sweeping deliberately extreme magnitudes, not by
reading the algebra.

The shipped version uses no derivatives. `pLiq` is a Möbius function of each input separately, so
between poles it is monotone in each, so its extremes over an axis-aligned box are attained at the
box's corners. All sixteen corners of the encoding box are evaluated and the largest excursion is the
bound. A box straddling a pole — zero size, a maintenance rate reaching the side sign — returns
`Infinity` and question 3 refuses, rather than reporting a small number from two finite corners that
happen to sit either side of an infinity.

The box is not uniform, and that is what makes the bound tight rather than merely correct. A value that
survives the round trip through `toFixed(9)` — which is exactly the rounding `scale.toScaled` performs
— is already on the grid, and its encoding costs at most half its own ulp instead of half a grid step:
seven orders of magnitude less. Every served path runs its inputs through `gridSnapFields`, so
`entryPrice`, `size` and `maintMarginRate` normally arrive snapped and contribute nothing. The one that
does not is `margin`, which the engine derives from leverage. **The bound is dominated by the single
input the service cannot snap**, which is the shape the measured data has, and it is not gameable: the
box is a function of the echoed inputs, so widening it means proving a different position.

---

## 6. Headroom

A bound the worst case barely touches is not measuring anything, and a bound nothing can exceed is not
a bound. Both were measured.

**Live — 1,856 positions, 232 perps × 4 leverage rules × long and short.** A snapshot: marks move, so
the median moves with them (28.6% and 36.3% in two runs an hour apart). The worst case and the zero do
not — the saturating position is a rounding tie, and there is always one in 1,856 draws.

| | |
|---|---|
| positions exceeding the bound | **0** |
| worst honest position, as a fraction of its bound | **96.14%** |
| p99 | 94.7% |
| median | 28.6% – 36.3% |
| the bound itself | median **5.03e-10**, worst 1.85e-6 |

**Synthetic — 107,122 positions in four deliberately different shapes** (as served, i.e. every input
snapped; wholly off-grid; magnitudes from 1e-9 to 1e9 on every input; and a maintenance rate crowding
the side sign so the numerator cancels):

| | |
|---|---|
| positions exceeding the bound | **0** |
| worst publishable position | **99.985%** of its bound |
| p99 / median | 97.03% / 36.87% |
| refused as unpinnable (question 3) | 9,243 — of which the old half-cent rule would have **accepted 2,329** |

The saturating positions are the ones whose canonical solve lands on a tie, where the bound is exactly
`HALF_STEP` and exactly reachable. That is a bound being tight, not a bound being lucky: with 1,856
samples one of them always lands near the tie, and the assertion in W.4 is set far below the measured
value so it fails on a widened bound rather than on a quiet market.

Half the universe is at 0% — the integer solve lands on the engine's own double, bit for bit.

**How much tighter, as a fraction of the price the proof is about:**

| asset | served | old tolerance | new bound | tighter by |
|---|---|---|---|---|
| YGG | \$0.01 | 50.000% of the price | ±5.06e-8 | 9.9 × 10⁶ × |
| RUNE | \$0.24 | 2.083% | ±2.1e-9 | **1.0 × 10⁷ ×** |
| SOL | \$67.47 | 0.00741% | ±5.1e-10 | 9.9 × 10⁶ × |
| ETH | \$1,769.54 | 0.000283% | ±7.0e-10 | 7.1 × 10⁶ × |
| BTC | \$61,287.84 | 0.0000082% | ±7.2e-9 | 7.0 × 10⁵ × |

BTC gains least, which is the point: half a cent was already a sane guard there and the fix does not
pretend otherwise.

---

## 7. It still says no

Gate W checks the refusals it can reach without patching anything — a served answer the witness does
not price (W.7), an answer that does not exist (W.7), a position the grid cannot pin (W.8). It cannot
manufacture the fourth failure, a witness/engine mismatch, because the witness is built from the
echoed inputs and both sides of that comparison move together. That failure has to be *injected*, and
a gate written after the code it guards will pass regardless. So `gates/gateW-revert.mjs` puts five
defects back, one at a time, and requires the gate to go red for each and green again after:

```
  --- revert 1 (snark.js): the encoder drifts one grid step on margin
      gate against reverted code : 5 pass, 3 fail
      red: W.4  W.5  W.6
  --- revert 2 (snark.js): the canonical solve is rearranged into a mathematically equal, numerically different form
      gate against reverted code : 6 pass, 2 fail
      red: W.4  W.5
  --- revert 3 (snark.js): the side flips inside the witness only
      gate against reverted code : 5 pass, 3 fail
      red: W.4  W.5  W.6
  --- revert 4 (snark.js): the bound is widened back to the half-cent this work removed
      gate against reverted code : 5 pass, 3 fail
      red: W.4  W.5  W.6
  --- revert 5 (snark.js): the display rounding drifts from the engine's
      gate against reverted code : 3 pass, 5 fail
      red: W.2  W.3  W.5  W.6  W.8

  1 file restored
  gate against restored code : 8 pass, 0 fail
  engine build id : q1-e1fa99d08887d6cc -> q1-e1fa99d08887d6cc

GATE W REVERT: PASSED, the guard is capable of saying no
```

The first three are genuine witness/engine mismatches — the circuit handed a position the engine did
not price. Revert 1 moves the certified price by 1.01e-9, which is **five thousand times inside the
half-cent the old rule allowed**: it would have sailed through. Revert 2 is the `constantproduct`
defect verbatim, `(s·q·P0 − M)/(q·(s − mmr))` rewritten as `(s·P0 − M/q)/(s − mmr)` with the
margin-per-unit formed and rounded onto the grid first — mathematically identical, and it disagrees
with the canonical solve on 23% of positions by exactly one grid step. Revert 4 attacks the
measurement rather than the arithmetic: nothing is mis-certified, the guard simply stops being able to
tell, and the headroom assertions are the only thing standing between that and a green board.

Revert 2 is also the reason this document exists in the shape it does. Its **first** version divided
before it multiplied in a way that turned out to be numerically near-identical, and the revert reported
green against a defect that was not there. That was the script failing, not the guard passing, and it
was caught by measuring the rearrangement's actual disagreement rate before believing either result.

---

## 8. What did not move

| | |
|---|---|
| `src/engine/` | byte-identical to the committed tree, whole directory diffed |
| engine `codeHash` | `q1-e1fa99d08887d6cc` before and after, including across the revert script |
| Appendix C `contentHash` | `8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960` |
| `npm test` | 386 tests, 0 fail, unchanged |
| `gates/preflight.mjs` | PASSED — including that repair leaves every already-valid body byte-identical across all 22 services and every optional field of each, so no content hash moves |
| the advertised `inputSchema` and MCP `tools/list` | untouched; nothing here reaches `src/services.js` or `src/mcp.js` |
| `/proof/<hash>` response shape | unchanged key for key — `gapToServedPrice` still carries the distance to the served price, which is still the number a reader holding the JSON wants |
| gate S (9), gate A (11) | pass, unchanged |
| the paper | not touched |

Nothing was deployed.

The one thing that did change on the published record is *which* proofs exist: a position at the
display boundary is now published where it used to be refused, and a position the grid cannot pin is
now refused where it used to be published. Both changes make the record more true.

---

## 9. How to run it

```
node --test gates/gateW-divergence-guard.mjs   # 8 assertions, ~15 s, needs the network for W.3/W.4
node gates/gateW-revert.mjs                    # five scripted defects, each must turn it red, ~2 min
node gates/preflight.mjs                       # the deploy seatbelt, unchanged and still green
npm test                                       # 386
```

`QUIVER_GATEW_SYNTHETIC` sets the synthetic sweep size; the revert script shrinks it to 20,000 so five
runs stay inside a couple of minutes, and the gate's own default is 120,000.

The two gates have no `npm run` aliases yet. `package.json` was owned by another session while this was
written and adding two lines to it would have been the one edit most likely to collide; they are two
`"gate:w"` / `"gate:w-revert"` entries whenever that session lands.

---

## 10. What this still does not do

**It does not make the witness/engine comparison catch an input divergence.** Questions 2 and 4 answer
different things, and only question 2 is anchored to something the witness did not compute — the
served price — so it is the only one that can notice `witnessFor` being handed the wrong inputs, and it
resolves at half a cent because that is the only precision the engine publishes. The specific case
already documented in `src/services.js` — a witness reading the display-rounded `margin` and certifying
a position 0.0019 away — moves the liquidation price by 0.00015 and remains invisible to both the old
guard and this one. Closing that needs the engine to publish a price at more than 2dp, or the witness
to be built from `r.inputs` under a comparison the engine itself signs. Neither is a change to this
file.

**It does not widen what can be proved.** The circuit still speaks about isolated linear perps with an
explicit positive maintenance rate; everything else is still refused as outside the domain.

**The representability cap is a backstop, not a working part.** No position in the live universe comes
within four orders of magnitude of it. It exists so that a caller reaching `buildInBackground` with
un-snapped inputs gets a refusal with a reason instead of a proof about a position four dollars away
from the answer — which the old absolute ceiling caught by accident, and which it would have been easy
to lose while making the tolerance smaller.
