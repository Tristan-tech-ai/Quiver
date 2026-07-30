# gateB6 recorded PASS on a claim its own book disproves

**Date:** 30 July 2026 · **Scope:** `zk/scripts/gateB6-portfolio-routes.mjs`, `zk/package.json`,
a cross-reference in `zk/scripts/gateB10-portfolio-perleg.mjs`. No engine change. No deploy. No paper change.

## 1. The defect, reproduced before anything was touched

Run of the unmodified gate, 30 July 2026 01:33 UTC:

```
Route B — verify n proofs and take the minimum, in one call:
   legs         gas   gas/leg
      1      276259    276259
      3      803685    267895
      5     1337042    267408
      8     2136691    267086
     11     2939559    267232
  [PASS] the contract picks the right leg
           leg 3, price 0.470647773
...
GATE B6: PASSED
```

`build/gateB6-portfolio-routes.json` carried `"passed": true` beside it.

The router (`gateB6-portfolio-routes.mjs`, the inline Solidity at what was line 105–127) ranked on
`signals[i][PRICE_INDEX]` with `PRICE_INDEX = NPUB - 1`. For `liquidation.circom` that signal is
`pLiqHat`, the liquidation **price**. The engine ranks on `moveToLiquidationPct`, the adverse move from
the mark, at `src/engine/portfolioGate.js:107`:

```js
for (const p of live) if (nearest == null || p.liquidation.moveToLiqPct < nearest.liquidation.moveToLiqPct) nearest = p;
```

`portfoliogate.circom`'s header (lines 19–30) had said so in writing since the circuit was built.

**Why the check could not fail.** Its reference was
`prepared.reduce((a, b) => (BigInt(b.sigs[NPUB - 1]) < BigInt(a.sigs[NPUB - 1]) ? b : a))` — the argmin
of the same signal the contract takes the argmin of. It compared a rule against itself. That is the
disease `VERIFIER_DISCIPLINE.md` names, and it is the reason the wrong leg passed for as long as it did.

## 2. Both rankings, reproduced twice by different routes

**Independently, engine + encoder only, no proving** (scratchpad probe, exact scaled integers):

| leg | pLiq (certified) | d (scaled) | refHat (scaled) | d/ref | engine's served pct |
|---|---|---|---|---|---|
| 0 | 57889.447236181 | 6110552763819 | 64000000000000 | 9.5477% | 9.548 |
| 3 | 0.470647773 | 149352227 | 620000000 | **24.0891%** | 24.089 |
| 5 | 108.929170863 | 9070829137 | 118000000000 | 7.6871% | 7.687 |
| 10 | 300.469483568 | 19530516432 | 320000000000 | **6.1033%** | 6.103 |

```
engine nearestLiquidation leg = 10
RATIO ranking (d*refStar < dStar*r)  -> leg 10  6.1033% away  pLiq 300.469483568
PRICE ranking (min pLiqHat)          -> leg 3  24.0891% away  pLiq 0.470647773
agree with engine?  ratio=true  price=false
```

**And by `gateB10-portfolio-perleg.mjs`**, which proves all eleven legs and ranks on chain
(run 30 July 01:41 UTC, `GATE B10: PASSED`):

```
  ranking on the distance RATIO  -> leg 10 (6.1033% away, pLiq 300.469483568)
  ranking on the liquidation PRICE -> leg 3 (24.0891% away, pLiq 0.470647773)
  [PASS] the ratio ranking agrees with the leg the ENGINE named
  [PASS] price-ranking names a DIFFERENT leg, so gateB6 route B answered a different question
```

Two independent computations, same two legs, same four significant figures. The price minimum is
**3.9x further** from liquidation than the binding leg (24.089 / 6.103), measured off the engine's own
served percentages.

## 3. The choice: (b), relabel — and (a) is unsafe for a reason worth recording

(a) retarget to `portfolioleg.circom`; (b) relabel as a price-minimum rehearsal; (c) retire for gateB10.

**(a) is not available, and the reason is structural.** `liquidation.circom` publishes eight signals —
`residual, tolerance, mHat, qHat, p0Hat, s, mmrHat, pLiqHat`. No mark, no distance numerator. The gate
now asserts that absence rather than describing it.

The tempting repair is to rebuild the distance from signals that *are* public: `d = s*(p0Hat - pLiqHat)`,
`ref = p0Hat`. **On this book that is exactly right** — 11 of 11 legs reconstruct, because no leg carries
a `markPrice` and the engine then falls back to entry (`perpGate.js:119`,
`const ref = Number(p.markPrice) > 0 ? Number(p.markPrice) : P0`). Nothing in the proof says which kind
of book it was handed. Mark one leg and measure — from engine output alone:

| book | engine ranks | `p0Hat`-as-mark ranks |
|---|---|---|
| as written, no marks | leg 10 at 6.103% | leg 10 at 6.1031% — agrees |
| leg 0 marked at 61,000 | **leg 0 at 5.099%** | **leg 10 at 6.1031%** — disagrees |

A router that is correct only for markless books, with no public signal distinguishing them, is a worse
defect than the one being fixed: it would be right in the test and wrong in production, which is the
shape that survives review. That is measured in the gate as §3b, not argued.

**(c) was rejected because it orphans a cited artifact.** `PHASE_C_RESEARCH_OPUS.md:700` sources its
per-leg verify slope from `zk/build/gateB6-portfolio-routes.json`, "five measured rows, exactly linear",
and uses it again at lines 530 and 583. Deleting the gate deletes the only measurement of this
aggregation shape's gas curve over the eight-signal single-position verifier — a real number about a real
shape, which was never the thing that was wrong.

**So (b).** The gas curve was always honest. The label was not.

## 4. What changed

| | before | after |
|---|---|---|
| contract name | `PortfolioMin` | `CertifiedPriceMin`, with a NatSpec header saying it is not a portfolio router |
| the false check | `the contract picks the right leg` — argmin compared against itself | deleted |
| replaced by | — | `the contract returns the smallest CERTIFIED LIQUIDATION PRICE, checked against the engine` |
| plus | — | `the price minimum is NOT the book's binding leg, and this gate claims only the former` |
| plus | — | `liquidation.circom publishes neither the mark nor the distance the engine ranks on` |
| plus | — | `substituting p0Hat for the mark agrees on THIS book and disagrees the moment a leg is marked` |
| signal layout | index taken on faith | `pLiqHat` tied back to the encoder's integer for all 11 legs |
| artifact | gas only | `answers` and `ranking` blocks record what the minimum is over |
| revert | none | `npm run gate:b6-revert` |

Two of the new checks **failed on first run** and were right to. Both had the same cause: I used
`toScaled(servedPrice)` as the reference for `pLiqHat`. The served price is `round(pLiq, 2)` and the
circuit is handed the canonical integer solve — on leg 3 that is 0.47 against 0.470647773. The reference
is now the encoder's own `built.encoded.pLiqHat`, with the encoder's `gapToServed` asserted against the
half-cent the engine's 2dp display allows. Worst measured gap across the book: **0.004839255** of 0.005.

## 5. The gate can fail

```
$ npm run gate:b6-revert
  !! REVERT MODE: the deleted claim "the price minimum is the binding leg" is back. The gate must fail.
  [PASS] the contract returns the smallest CERTIFIED LIQUIDATION PRICE, checked against the engine
           slot 3 = book leg 3 · certified 0.470647773 · the engine's price minimum is leg 3, served 0.47
  [*** FAIL ***] the price minimum IS the book's binding leg  [REVERT: the deleted claim, back verbatim]
           contract names leg 3 at 24.089% · the engine's binding leg is 10 at 6.103%
GATE B6: FAILED — the price minimum IS the book's binding leg  [REVERT: the deleted claim, back verbatim]
  REVERT MODE: build/gateB6-portfolio-routes.json left untouched.
  exit 1
```

The revert deliberately does **not** write the artifact. `PHASE_C_RESEARCH_OPUS.md` cites those gas rows;
writing a broken configuration's `passed: false` over the real measurement would turn a demonstration
into a corrupted record. Confirmed: the artifact's `at` stayed at `2026-07-30T01:40:31.079Z` with
`passed: true` across a revert run.

The flag form exists because `cmd.exe` has no `VAR=value command` syntax, so an env-only revert is
unreachable from an npm alias on Windows. `B6_REVERT=binding` still works.

## 6. Measured numbers from the passing run (30 July 2026 01:40 UTC)

Gas is measured; the gas/leg column is integer division of it, not a second measurement.

| legs | gas (measured) | gas/leg (derived) |
|---|---|---|
| 1 | 275,953 <!--gas:gateB6-portfolio-routes#gasByLegCount.0.gas--> | 275,953 |
| 3 | 803,587 <!--gas:gateB6-portfolio-routes#gasByLegCount.1.gas--> | 267,862 |
| 5 | 1,339,856 <!--gas:gateB6-portfolio-routes#gasByLegCount.2.gas--> | 267,971 |
| 8 | 2,144,705 <!--gas:gateB6-portfolio-routes#gasByLegCount.3.gas--> | 268,088 |
| 11 | **2,948,931** <!--gas:gateB6-portfolio-routes#routeB.gas--> | 268,084 |

Against Route A's 292,124 <!--gas:gateB8-2-portfolio-evm#acceptGas--> (read from
`gateB8-2-portfolio-evm.json`, not written down): **10.1x**.
Proving 858 ms per leg, 9,443 ms serial, ~1,166 ms if eleven legs run on eleven workers.

**These rows move between runs and that is expected.** `probe-plonk-gas-variance.mjs` measures a 1.26%
spread across identical statements, about 3,500 gas on a single verify. The 11-leg row has been observed
at 2,939,559 / 2,942,899 / 2,942,997 / 2,943,829 / 2,948,931 across five runs today — a 9,372 spread,
**0.319%** across eleven verifies, inside that band. Any claim resting on a difference smaller than it is a false
claim, which is why the docs that quote 2,941,443 / 2,944,135 / 2,939,155 / 2,947,769 are not in
disagreement with each other; they are five samples of one number.

## 7. What is still open

- **The `answers` block is new and unread.** Nothing consumes
  `gateB6-portfolio-routes.json:answers.isThePortfolioMinimum` yet. A reader who takes the gas rows and
  ignores the label is still able to mislabel them downstream.
- **`T3_PORTFOLIO_CIRCUIT.md:264` is now stale in one clause.** It says "No per-leg proof in existence
  carries the quantity the ranking is done on" — true when written, and `portfolioleg.circom` has since
  been built and publishes `refHat`. Left alone here: it is a dated §7 verdict, and editing another
  session's document mid-flight is how the working tree gets contested. Flagged, not touched.
- **The mark itself is still an unproven input.** `portfolioleg.circom` binds `refHat` into the
  liquidation identity, so a router cannot move it — but nothing proves the mark handed to the encoder is
  the venue's. That is the input problem `QUIVER_ROADMAP_V2.md` already names as the honest end of this
  road, and this change does not touch it.
- **Route A's 5.4 s proving figure is still `EXTRAPOLATED`**, from `domain-scaling.mjs`'s domain^1.01,
  and is labelled as such in the gate output. Not measured here.
