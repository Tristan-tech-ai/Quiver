# Wiring what holds: `exec-verify` serves a proof, and the two "free" services do not exist

**Written 30 July 2026.** The brief was "four circuits exist and serve nobody — wire what holds to the
standard", with two more services said to come free off the already-built `ncdf`. One circuit was
wired. The free pair was measured and the claim is **false for both**. The other three circuits are
each not wired for a reason that is written down and measured, not for lack of time.

**The honest count: 4 of 22 services serve proofs**, up from 3. `perp-gate`, `size-gate`,
`treasury-risk`, and now `exec-verify`.

One correction to the brief's own arithmetic while counting: it said "four more circuits exist and are
unwired" and then named **five** — `execadverse`, `lpbracket`, `lpexpectation`, `ncdf`, `portfolioleg`.
Five circuit files, five unreachable before this session, four after.

| | before | after |
|---|---|---|
| services serving a zk proof | 3 | **4** |
| circuits reachable from a served response | 3 | **4** |
| of the circuits named in the brief, still unreachable | **5** (`execadverse`, `lpbracket`, `lpexpectation`, `ncdf`, `portfolioleg`) | **4** (`lpbracket`, `lpexpectation`, `ncdf`, `portfolioleg`) |
| pinned content hashes moved | — | **0** |
| `npm test` cases | 386 | **386** |
| engine build hash | `q1-e1fa99d08887d6cc` | `q1-e1fa99d08887d6cc` |

---

## 1. The claim that did not survive measurement

> *"`event-vol` and `options-desk` each publish a field that is a single `N(x)`, reachable by the
> already-built `ncdf` with zero new artifacts. Verify that claim before relying on it."*

Verified. **Neither service publishes a single `N(x)`.** Both were measured against the real engines.

### `event-vol` — the field is a SUM OF TWO CDFs at two different arguments

`src/engine/eventVol.js:52-54` builds `probabilityMoveBeyond[].probPct` as

```
up = probAbove(S, S*(1+m/100), T, sig, 0)      = N(d2_up)
dn = 1 - probAbove(S, S*(1-m/100), T, sig, 0)  = 1 - N(d2_dn)
probPct = round((up + dn) * 100, 1)
```

Measured at spot 100,000, ATM vol 60%, T = 7/365:

| threshold | served | decomposition | the two arguments |
|---|---|---|---|
| 1% | 90.4% | `N(-0.161298) + 1 - N(0.079410)` | differ by 2.407e-1 |
| 2% | 81.0% | `N(-0.279870) + 1 - N(0.201594)` | differ by 4.815e-1 |
| 5% | 54.7% | `N(-0.628735) + 1 - N(0.575769)` | differ by 1.205e+0 |

`ncdf.circom` carries **one** `(xSign, xMag, nHat, pHat)` tuple and no addition of two CDFs. One proof
cannot state this field. Pretending the 2% field is the single `N` at the up-leg gives 38.9789% against
a served 80.9906% — **off by 42.01 percentage points**, which is not a rounding disagreement.

Two `ncdf` proofs plus an addition would state it, and that addition is a new circuit and new
artifacts, so it is not free.

### `options-desk` — the field is `N(d2)` MINUS the smile term, and the bare `N` is never published

`src/engine/optionsDesk.js:138-147`. The published `probAbovePct` comes from `probAboveSmile`, which is
`N(d2) − e^{rT}·vega·∂σ/∂K` — the Breeden–Litzenberger correction the engine's own comment says must
not be dropped ("a MEASURED error of up to ~5 percentage points"). Measured on a skewed BTC-shaped
smile, F = 100,000, T = 30/365:

| strike | published `probAbovePct` | bare `N(d2)` | smile term |
|---|---|---|---|
| 85,000 | 83.3% | 81.5% | +1.79 pts |
| 95,000 | 61.3% | 59.5% | +1.73 pts |
| 100,000 | 48.2% | 46.9% | +1.37 pts |
| 110,000 | 24.9% | 24.5% | +0.48 pts |
| 125,000 | 6.3% | 6.5% | −0.13 pts |

The bare `N(d2)` **is** computed — `nd2` at `optionsDesk.js:141` — and is **never published**. Only
`skewCorrectionPts = round((p − nd2)·100, 2)`, a *difference of two* quantities, reaches the response.
`reachOddsPct` is `p` or `1 − p` off the same corrected `p`. So no field on this service is a single
`N(x)` either, and `options-desk` is a live Deribit read, which is served as an observation rather than
a deterministic proof in the first place.

**Nothing was wired on the strength of the claim.** Had it been taken on trust, `event-vol` would now
publish a proof of a number 42 percentage points from the one it serves.

---

## 2. `exec-verify` → `execadverse`, against every item of the standard

### Grid snapping — decided per field, not applied wholesale

`gridSnapFields(raw, ['amountIn', 'amountOutRealized', 'reserveIn', 'reserveOut', 'feeTier'])` on both
surfaces. Five fields, and **the two omissions are the decision**:

- `fairPrice` is the *reference* mode's benchmark — a number the caller supplied instead of a pool —
  and `execadverse.circom`'s invariant is about reserves. It reaches no circuit term, so snapping it
  would move a content hash and buy nothing. Reference mode is **refused a proof by name**.
- `slippageTolerancePct` drives the "within tolerance yet robbed" lesson, which is a comparison
  against the headline, not a term in it.

Why five and not three: the circuit takes eight public signals and only these five are the caller's.
The effective input, the benchmark fill, the shortfall and the basis-point figure are all **derived**,
each rounded onto the grid exactly once in `src/util/scale.cjs`. Snapping the five is what makes the
double the engine divides the same double a reader recomputing from `proof.inputs` would form.

That buys more here than anywhere else, because the benchmark is a quotient of a quotient: `dO/din`
reaches **5.4e3** on a pool lopsided past 100:1, so half a grid step on the effective input moves the
fill by **2.7e-6 output tokens**.

### The divergence bound — derived here, and deliberately NOT gate B5-4's

`zk/scripts/gateB5-4-execadverse-sweep.mjs` already derived a bound for this circuit. **It is the wrong
number for a served path** and was not imported. That gate feeds the encoder raw doubles, so its
benchmark term carries `(1 + 2·y/x)/S` for snapping `x`, `y` and `dx`. Both handlers here run
`gridSnapFields` first, so those three are on the grid to within half an ulp of a double, and that term
is two to ten times wider than anything it guards. Inheriting it would have been the liquidation
half-cent again, in the generous direction.

**One ceiling, derived once, applied in two units.** The headline is published as `round(bps, 2)` —
0.005 bps out of the 1e4 bps a whole fill is worth, a relative precision of **5e-7**. Transferred onto
the quantity the headline is a ratio of:

```
gOut  <=  honestOut · (0.005 / 1e4)
```

Nothing in that is chosen: the 0.005 is the engine's own `round(bps, 2)` and the 1e4 is the engine's
own basis-point scaling. Both arms are still tested separately in their own units, because
`realized/honestOut` is not exactly 1 — measured, the two arms refuse 21,311 and 21,370 of the same
226,761 trades.

**What fraction the worst honest case uses**, over 54,410 trades from the real engine across five
deliberately different pool shapes (`npm run gate:ex`, EX.7):

| bound | worst honest case | remaining margin |
|---|---|---|
| headline, in basis points | **99.984989%** | 1.501e-4 |
| shortfall, in output tokens | **99.992421%** | 7.579e-5 |
| benchmark fill, in output tokens | **99.992443%** | 7.557e-5 |

Never exceeded on any of the 49,241 published trades. The bound is tight because its dominant term is
an irreducible grid rounding at a near-tie, not because it was tuned.

**A correction the revert script found, not review.** The first version of the encoding bound was a
first-order derivative. The benchmark fill is **concave** in the effective input, so the linear term is
not an upper bound — measured, it understates the true excursion by up to **45%** on a small trade
(corner max / derivative − 1 reaches 8.35e-1 relative, on 6,000 of 6,000 shapes). It is now a maximum
over the eight corners of the encoding box. The same mistake was present in the headline's `dB/do` term
and was fixed the same way: `B(o,z) = 1e4(o−z)/o` is convex in `o`, and the linearisation was sitting
at 99.8% of a number that did not bound it — a 0.2% empirical margin standing in for a missing term.

### Not re-deriving the engine's expression

`scale.engineHonestOut` and `scale.engineAdverseBps` are the engine's own lines, copied not rearranged,
with the engine's own parameter order `(dx, x, y, f)` and the engine's own intermediate name `inEff`.
EX.1 **reads those lines out of `src/engine/execVerify.js` as text, compiles them with `new Function`,
and requires `Object.is` agreement over 20,000 shapes each**. Revert 2 of `npm run gate:ex-revert`
replaces `engineHonestOut` with the one-line `(y * dx * (1 - f)) / (x + dx * (1 - f))` — the same
identity, a different double, the `constantproduct` defect verbatim — and EX.1 goes red.

### Both surfaces

`src/services.js` and `src/mcp.js`, written in the same edit. EX.3 parses the `gridSnapFields` call out
of **each** handler's source independently and requires the same five fields; EX.3b requires each to
attach the `snark` sibling *after* the envelope; EX.3c requires each to refuse reference mode by name.
`gates/preflight.mjs` now pins an **eight-entry** proof-emitting set across two surfaces, so a surface
contributing nothing turns it red.

### `proof.excludedFromContentHash`

Nothing to declare by hand: `src/util/recipe.js` derives the exclusion list from insertion order, and
`snark` is attached after `proof`. EX.3b asserts that ordering structurally. `npm run gate:v` is green
at 9/9 and Appendix C still reproduces at `8575ce5a…`.

### No content hash moved

| | before | after |
|---|---|---|
| `exec-verify#0` (constant-product) | `7be44a5186acc925…` | `7be44a5186acc925…` |
| `exec-verify#1` (reference) | `9091b9533045e649…` | `9091b9533045e649…` |
| Appendix C | `8575ce5ae5bfae9c…` | `8575ce5ae5bfae9c…` |

Asserted on **both** surfaces, and also with `snark: true` and `snark: "true"` present, because the
flag is destructured out before `compute` is formed (EX.8). EX.8b asserts `gridSnapFields` is the
identity on both fixtures, which is why nothing published could move.

The one behaviour that *does* change: a caller who was already sending `{"snark": true}` to this
endpoint — and receiving no proof for it — sees their content hash move once, to the hash the identical
body without the flag has always returned. This is the same one-time move `size-gate` recorded, for the
same reason, and it is declared here rather than discovered.

### The preflight pinned set, and why this addition's grid was chosen

Updated consciously with the reasoning above written into `gates/preflight.mjs` beside the other three.
Artifacts asserted present: `execadverse_plonk.zkey` (7.8 MB), `execadverse_vk.json`,
`execadverse_js/execadverse.wasm`, `execadverse_js/witness_calculator.cjs`.

### Per-service: prove, verify, perturb, bend, sweep, revert

| requirement | result |
|---|---|
| prove | ready in ~0.7 s off the request path; 15 public signals |
| verify | `snarkjs.plonk.verify` against `/proof/vk/execadverse` → **true** |
| refuse every perturbed signal | all **30** perturbations (15 signals × ±1) refused |
| refuse a bent proof | **15** proof elements bent one at a time: 6 returned `false`, 9 refused by a throw; all 3 other circuit keys also refuse it |
| sweep against the REAL engine | `execVerify` imported and called; 54,410 trades, 5 shapes; 0 divergences |
| the bound can be exceeded | a 1e-5 relative slip in the benchmark → **100.0%** refused; 1e-6 → 100.0%; 1e-7 → 96.4% |
| scripted revert going red | **7 of 7** reverts turn `gate:ex` red; green again after restore; engine hash unmoved |

The measured public-signal layout (read off a real proof, not off the circuit source):
`[residual, feeResidual, bpsResidual, tolerance, feeTolerance, bpsTolerance, shortfall, xHat, yHat,
dxHat, fHat, inHat, outHat, realizedHat, bpsHat]`.

### The honest cost: 9.5% of trades are REFUSED a proof

This is the first proof here whose sold number is a **ratio**, and that has a price. `adverseExecutionBps`
is a fraction of the benchmark fill, so its absolute precision collapses as the fill shrinks:

- on a fill of **9.97e-10** output tokens the 1e-9 grid cannot pin the headline at all (the encoding box
  contains an empty pool, so the bound is literally infinite);
- on a fill of **8.8e-8** tokens it pins the headline only to **91 bps**, against the **5 bps** threshold
  this same engine uses to call a fill a sandwich.

So the guard refuses rather than certifying a neighbouring trade. Measured refusal rates:

| pool shape | published | refused |
|---|---|---|
| realistic V2 pool (1e4–1e8 reserves, trade 1e-5–1e-2 of pool) | **100.0%** | 0% |
| huge (trade 5–45% of the pool) | **100.0%** | 0% |
| normal (wide) | 99.8% | 0.2% |
| lopsided (past 100:1) | 95.1% | 4.9% |
| dust (trade down to 1e-11 of the pool) | 57.5% | 42.5% |
| **overall** | **90.5%** | **9.5%** |

A refused proof never refuses the answer — the number is still served, and the refusal carries the
measured figure that could not be pinned.

---

## 3. Two defects found in existing checks

### `EMITS_ZK` matched one of the four builders it was written for

`gates/preflight.mjs` used `/env\.proof|obs\.snark|buildInBackground/` to decide which handlers build a
proof. **`buildKellyInBackground`, `buildConcentrationInBackground` and `buildExecInBackground` do not
contain the substring `buildInBackground`.** All three were being detected only by the incidental
`env.proof` alternative — which any handler that reads its own content hash matches, for any reason,
whether it proves anything or not.

So the trigger the comment block describes as "an actual Plonk proof built off-request" was never
matching three of the four calls that do it, and the pinned set stayed correct by luck. A fifth circuit
whose handler did not happen to mention `env.proof` would have been invisible to the one guard that
exists to see it. Widened to `/env\.proof|obs\.snark|build\w*InBackground/`.

### My own EX.2b could not fail — and the revert script is what found that

The first EX.2b compared the shipped encoding bound against `dO/din × HALF_STEP` and required it to be
wider. It always was, because the shipped half-width carries an ulp term the comparison did not — so
**replacing the entire function body with the linearisation still passed the check written to catch
exactly that**, and revert 7 walked straight through it.

It now reimplements the corner maximum independently in the gate and requires **bit equality**, plus a
second assertion that the two forms genuinely differ on real shapes (they differ on 6,000 of 6,000, by
up to 8.35e-1 relative) so the equality is discriminating rather than vacuous. This was a decoration in
the *gate*, not a defect in the code, and it would have shipped unnoticed without the revert script.

---

## 4. The three circuits still unwired, and why — measured, not deferred

### `lpbracket` / `lpexpectation` → `lp-risk`: **blocked by a known engine defect, out of scope**

`KNOWN_DEFECTS` records a boundedness check in `src/engine/lpRisk.js` reading a rounded field, and that
fix is explicitly reserved for Tristan. Wiring a proof onto a service whose arithmetic has a known open
defect would attach a certificate to a number that is under repair. **Stop, on purpose.** The circuits
and their gates (`gateLP0`, `gateLP1`, `gateLP2`) are green under `zk/` and stay there until the engine
question is settled.

### `ncdf` → `options-risk`: needs a design decision, not wiring

Two blockers, both measured:

1. **No published field is a bare `N(x)`.** `optionsRisk` publishes `positionGreeks.delta =
   round(qty · df · N(d1), 6)` and `value = round(qty · price, 6)`, and `price` contains two CDFs. A
   bare `N` appears only when `qty = 1`, `r = 0` and the leg is a call. Adding a field to expose one
   would move every published `options-risk` content hash, which the standard forbids.
2. **The circuit pins `n` GIVEN `x`; it does not pin `x`.** The circuit's own header says so. Here
   `x = d1`, and pinning that needs `ln(F/K)` — the same exp gadget run backwards, and explicitly
   **NOT BUILT**. A proof would therefore certify "the CDF is correctly evaluated at this `d1`" while
   `d1` itself arrives as an unproven public input the caller must recompute in doubles. That is a
   materially weaker statement than the other four make, and shipping it without that being the
   headline of its own `doesNotProve` would be the kind of overclaim this project is arranged against.

Neither is a reason it cannot be done. Both are reasons it is not a wiring job.

### `portfolioleg` → `portfolio-gate`: a per-leg shape, and another session's ground

`portfolio-gate` answers a book of N legs and has an account mode that reads Hyperliquid live, so it
already branches to an observation envelope. A per-leg circuit means N proofs or a batching decision,
and the open task list shows the leg-ceiling and per-leg-plus-on-chain-ratio work in flight elsewhere.
Two sessions wiring the same handler from opposite ends is how a circuit got orphaned last night.

---

## 5. What was run

| | result |
|---|---|
| `npm test` | **386 tests, 0 fail** (exactly 386, unchanged) |
| `npm run gate:ex` | 18 pass, 0 fail |
| `npm run gate:ex-revert` | **7 of 7 reverts red**, green after restore, engine hash unmoved |
| `npm run gate:v` (recipe + Appendix C) | 9 pass, 0 fail |
| `npm run gate:k` | 8 pass, 0 fail — went red first on its pinned circuit list, updated consciously |
| `npm run gate:h` · `gate:m` · `gate:c` · `gate:l` · `gate:p2` · `gate:s` | 7 · 17 · 10 · 8 · 7 · 9, all 0 fail |
| `npm run gate:u` · `gate:r` · `gate:buyer` · `gate:a` · `gate:d4` · `gate:w` | 8 · 15 · 16 · 11 · 32 · 8, all 0 fail |
| `npm run docs:check` | CONSISTENT — 231 documents |
| `npm run preflight` | PASSED (read-only; **nothing was deployed**) |

`gate:k` going red was the pinned list at `gateK-kelly-snark.mjs:491` refusing to let
`/proof/vk/<circuit>` grow silently. That is the behaviour that makes the pin worth having, and the
update records why `execadverse` joined: a proof carrying fifteen public signals cannot be checked
against any of the three keys already there.

## 6. What was NOT verified

- **Nothing was deployed.** Every figure is local. `/proof/vk/execadverse` and the 15-signal retrieval
  shape are asserted against the in-process app, not against `quiver-production-c3a8`. Preflight
  confirms the codeHash, service count and schemas are unmoved, so a deploy triggers no re-review —
  but the live host does not serve this proof yet.
- **No EVM check was re-run here.** `zk/scripts/gateB5-5-execadverse-evm.mjs` verifies
  `ExecadverseVerifier.sol` against a local EVM and is unchanged; the `uint256[15]` signature published
  at `/proof/<hash>.onChain` was derived from the measured signal count, not from a fresh EVM run.
- **No gas figure is quoted.** Plonk verify gas has a measured 1.22% spread (~3,500 gas) and no
  execadverse gas measurement was taken in this session, so none is reported.
- **The 9.5% refusal rate is over a synthetic five-shape sweep**, weighted deliberately toward the
  corners where the bound bites. It is not a measurement of real traffic, and the realistic-pool row
  (0% refused) is the one that describes the paying case.
