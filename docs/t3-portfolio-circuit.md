# T3 — `portfolio-gate` as a circuit, at n ≤ 3 legs

**Built, proved, swept and rehearsed. Nothing deployed, nothing spent, `src/engine/` untouched**
(tree hash `b3207d10d0febf3e…` before and after).

---

## The five answers

| | |
|---|---|
| **Circuit size** | **2,053 R1CS · 3,970 Plonk · 28 public signals · domain 4,096** — 126 gates of slack |
| **Does n = 3 fit?** | **Yes — but not at liquidation.circom's bit widths.** At full parity it is **4,540 Plonk, 444 over** the ceiling. Two things bought the fit. |
| **Worst bound usage** | **0.999284** of the per-leg tolerance (raw inputs), **0.998538** (grid-snapped). The bound is approached, not admired. |
| **Gas** | **~292,000 accept** (291,916 / 292,222 / 292,748 / 293,054 across four runs) · **573 reject** for a bent proof point · **~284,000 reject** for a tampered public signal |
| **Wide or per-leg?** | **Wide**, and the deciding argument is not gas. Per-leg proofs cannot answer this question at all — see [§6](#6-wide-circuit-or-per-leg-proofs). |

Artifacts: `zk/circuits/portfoliogate.circom`, `zk/scripts/gateB8-{0,1,2}-*.mjs`,
`zk/scripts/lib/portfolio-witness.mjs`, mirrored byte-identically into `Quiver/zk/`, and
`portfoliogate` added to `gate-clone-portability.mjs` (24 of 24 gates portable).

---

## 1. The statement

`portfolio-gate` reports the leg nearest liquidation. That is a minimum, and a minimum is two claims:

1. **every** leg satisfies the liquidation identity in its own right — not only the winner, because a
   minimum taken over numbers nobody checked is a minimum over numbers somebody made up; and
2. no other leg is nearer.

(1) is `liquidation.circom`, once per leg. (2) is comparisons. The asymmetry in their cost is the
whole story of this circuit.

**"Nearest" is taken from the engine, not from intuition.** `portfolioGate` ranks on perpGate's
`moveToLiquidationPct` — the adverse percentage move from the **mark** — not on the liquidation price:

```
dist_i = s_i · (ref_i − pLiq_i) / ref_i          ref = markPrice, or entry when no mark
```

so the comparison is a ratio, cross-multiplied to stay in integers:
`dist_a ≤ dist_b ⟺ d_a·ref_b ≤ d_b·ref_a`.

**Liveness is the range check.** The engine drops legs already past their liquidation price from the
ranking ("their liquidation is not a future event"). Those have `d < 0`, and `Num2Bits` on `d` refuses
exactly them. The circuit speaks only about books where every leg is live, and declines the rest.

Public signals (28): 3 residuals, 3 tolerances, then `mHat qHat p0Hat s mmrHat pLiqHat refHat` × 3,
then `nearest`. The one-hot selector is private; `nearest` is **derived** from it, not compared to it.

---

## 2. What three legs actually cost

**The roadmap's arithmetic was 4,096 ÷ 1,301 = 3 legs. It counted the legs and not the minimum.**
Built at liquidation.circom's own bit widths the circuit is **2,338 R1CS / 4,540 Plonk** — an 11%
overrun. Two changes closed it, and both are in the source with the reasoning attached.

**(a) The tolerance check, re-expressed. Same statement, 137 fewer R1CS per leg.**
`liquidation.circom` enforces `2|R| ≤ tol` by pinning `shifted = 2R + tol` with `Num2Bits(160)` and
closing the top with `LessEqThan(160)` — 323 R1CS, nearly half that circuit. The identical statement
follows from two `NB_TOL`-bit decompositions, of `shifted` and of `2·tol − shifted`: the first forces
`shifted ≥ 0`, the second forces `shifted ≤ 2·tol`, and neither can wrap because `2·tol < 2^NB_TOL` by
construction. That is 186 R1CS. Worth **825 Plonk** across three legs, and without it no bit width
saves this — three legs would sit around 5,400.

**(b) Narrower input domains. Refusals, not approximations.**

| | was | now | means |
|---|---|---|---|
| `NB_M` | 80 | **60** | margin ≤ $1,152,921,504 |
| `NB_Q` | 60 | **55** | size ≤ 36,028,797 units |
| `NB_P` | 60 | **50** | price ≤ $1,125,899.9 (also bounds `refHat` and `d`) |

A position outside these cannot be encoded, so the circuit declines rather than certifying something
adjacent — and §4 measures how often the real engine produces one (**316 of 1,500 books**, all of them
the size ceiling, all of them sub-cent tokens at large notional).

**`NB_M` and `NB_P` both had to move.** Restoring either alone puts it back over: `NB_M` costs 120
Plonk, `NB_P` costs 240, and the slack is 126. `NB_TOL = 87` and `NB_X = 100` are *derived* from those,
not chosen.

Measured with `node zk/scripts/circuit-facts.mjs portfoliogate`, read out of the artifacts:

```
  circuit           R1CS    Plonk  public   domain      zkey
  portfoliogate     2053     3970      28     4096   22.9 MB
```

---

## 3. Gate B8-0 — prove / verify / REFUSE  ✅ PASSED

A circuit proving a minimum has a failure mode the single-leg circuits do not: it can be perfectly
correct about every leg's arithmetic and still name the wrong leg. So the centrepiece is not the
honest proof.

**The worked case.** BTC 10× / ETH 8× / SOL 5× short. The engine names BTC at 9.548%.

```
  leg   served P_liq       certified         gap   served %     exact %
    0         184.16   184.158415842     1.58e-3     18.812   18.811881
    1       57889.45 57889.447236181     2.76e-3      9.548    9.547739
    2         2816.9  2816.901408451     1.41e-3     11.972   11.971831

  leg                   residual R               tolerance    2|R|/tol
    0       -168000000000000000000   404000000000000000000    0.831683
    1           142500000000000000     1507500000000000000    0.189055
    2          5880000000000000000    20120000000000000000    0.584493
```

The exact residual on the named leg is **R = 142,500,000,000,000,000** against a derived tolerance of
1,507,500,000,000,000,000 — **0.189054726** of it. The circuit's three published residuals were checked
to equal `scale.residual()` exactly, so the table above describes the circuit that actually proved.

Diagnostic shapes: none of the three ratios is near 1.0 (a bound merely too tight), near 2.0 (one side
negligible against the other — a scale error), or a clean power of ten (a wrong exponent).

**Refusals** — 28 of 28 perturbed public signals rejected, bent proof point rejected, and fifteen
dishonest witnesses killed inside the constraint system before a proof existed:

- **names leg 2 as nearest while leg 1 is nearer, 2.42 points apart** — the case the brief names ✅
- **the same lie with the two legs 1.01e-5 points apart**, both served as an identical `9.548%`, so
  nothing above the third decimal can tell them apart ✅
- names leg 0, the furthest leg · selector naming two legs · selector naming none · stated index
  disagreeing with the selector · selector outside {0,1} that still sums to one
- liquidation price moved by 0.001 on the named leg, **and on a leg that lost the comparison**
- zero size · side neither long nor short · maintenance rate exactly 1 · zero mark · a mark already
  below the leg's liquidation price
- **negative control:** the honest witness still passes the same calculator, so the refusals are
  refusals and not a broken harness ✅

---

## 4. Gate B8-1 — the sweep against the real engine  ✅ PASSED

Ground truth is `portfolioGate().nearestLiquidation`, matched back onto `positions[]`. **The argmin is
never recomputed** — a recomputed argmin agrees with itself and proves nothing. And the check is not
arithmetic in the gate: every kept book is pushed through the **real witness calculator** carrying the
engine's index, and a disagreement is a throw.

1,500 deterministic books, 1–3 legs, seven instruments spanning $64,000 to $0.0000082, notionals over
five orders of magnitude, marks drifting ±15% from entry. **Run twice** — see §5.

| | raw inputs (today) | grid-snapped |
|---|---|---|
| books encoded | 681 (1-leg 333 · 2-leg 204 · 3-leg 144) | 694 (335 · 210 · 149) |
| bound violations | **0** | **0** |
| witness rejections | **0 of 681** | **0 of 694** |
| ordering disagreements | **0** | **0** |
| worst `2|R| / tol` | **0.999284** | 0.998538 |
| refused: size ceiling | 316 | 316 |
| refused: leg already past liquidation | 331 | 334 |
| refused: no unambiguous nearest | 142 | 142 |
| **refused: divergence past published precision** | **30** | **14** |
| widest divergence *turned away* | **1.017e-2** points | 7.718e-3 points |

**The bound is real.** Worst case uses **99.93%** of the per-leg tolerance — it is derived from `qHat`
and `mmrHat` inside the circuit, so a prover cannot widen it without changing the position.

**Guards, and how much of each is used.** Two published precisions, both guarded:

- `liquidationPrice` is `round(pLiq, 2)` → guard 0.005. **99.95% used** — and that is a warning, not a
  reassurance: on a $0.09 asset `round(0.085002634, 2) = 0.09` consumes 4.997e-3 of the guard through
  *display rounding alone*, with no divergence involved. **The price guard has essentially no
  discrimination left on sub-dollar assets.**
- `moveToLiquidationPct` is `round(pct, 3)` and is what the engine **ranks** on → guard 0.0005.
  **99.96% used.** This is the guard doing the real work.

---

## 5. Two defects found in the service, not in the circuit

### 5.1 `portfolio-gate` never grid-snaps its inputs

`util/grid.js` exists because the engine's doubles and the circuit's 1e-9 integers are not the same
numbers, and `services.js:313` snaps every **perp-gate** input onto that grid before pricing — worst
divergence 3.53e-6 down to 5.53e-10.

**`portfolio-gate` does not.** Its `run` enriches the legs and calls `portfolioGate` on raw doubles.
The first version of this sweep failed because of it, and it was right to fail. Measured:

- certified liquidation prices up to **6.0e-3** away from the ones served;
- certified **distances** up to **1.017e-2 percentage points** away — **twenty times** the third
  decimal the ranking is published at.

The guard refuses those books, so nothing false is certified either way. What it costs is books that
can be answered at all: **30 refused for divergence on the raw path against 14 snapped**, and 13 fewer
answerable books out of 1,500. The fix is one call to `gridSnapFields` with the field list
`services.js` already uses for perp-gate — **not applied here, because this task's remit is `zk/`**.

### 5.2 The ranking is rounded too, and a proof can contradict it

The engine ranks on `round(pct, 3)` and breaks ties by **book order**. The circuit ranks on the exact
ratio. Those orderings disagree in exactly one place: two legs that round to the same third decimal
while being strictly ordered underneath.

Found by construction, not by reasoning — the first near-tie book written for gate B8-0 happened to be
one, and the circuit refused the engine's own answer:

```
  leg 1  BTC 10×          served 9.548%   exact 9.547738693467%
  leg 2  ETH 10.0000109×  served 9.548%   exact 9.547727738719%   ← strictly nearer
  engine names leg 1 (first in book order); leg 2 beats it by 1.1e-5 points
```

The builder now **declines** such books. Certifying the engine's answer would certify a minimum that is
not one; silently naming the other leg would certify an answer the service never gave. Neither is a
proof of what was served. Covered as a passing test in gate B8-0. Rate in the sweep: 0 of 1,500 on
random books — it needs a near-coincidence — which is precisely why it had to be constructed.

Closing it in-circuit would mean proving `no other leg is nearer *by more than 0.001 points*`, which
costs ~108 Plonk against 126 spare and weakens the statement to "nearest to within the published
precision". Recorded as a deliberate choice, not an oversight.

---

## 6. Gate B8-2 — EVM rehearsal  ✅ PASSED

Solidity compiled with solc 0.8.26, deployed into an in-process EVM at 11,530 bytes. **Nothing on chain.**

- **honest proof accepted: ~292,000 gas** (291,916 / 292,222 / 292,748 / 293,054 over four runs — the
  Plonk prover blinds each proof, and the verifier's cost moves ~0.4% with it)
- **every one of 29 tampered submissions refused** (28 moved signals + a bent point)
- **two refusal costs, and quoting only the cheap one would mislead:** a bent proof point dies at
  **573 gas** on the on-curve check before any pairing runs; a **tampered public signal costs
  ~284,000** — the full pairing has to run to find it, so refusing a moved signal costs essentially
  what accepting costs.

The 20 extra public signals cost **18,798 gas** over the 8-signal single-leg verifier.

---

## 7. Wide circuit or per-leg proofs?

Gate B6 measured 11 separate proofs at 2,939,155 gas against 273,118 for one, called the difference
economically nothing on X Layer, and left the question open. With the wide circuit actually built, the
comparison can be made **at the same leg count**:

| at 3 legs | one wide proof | three per-leg proofs + on-chain min |
|---|---|---|
| gas | **292,000** | **802,547** (gateB6, measured) |
| proving | 1,772 ms, unsplittable | 811 ms/leg — 2,433 ms serial, 811 ms parallel |
| ceiling | **3 legs**, and only with a narrowed domain | none |
| domain | margin ≤ $1.15e9, price ≤ $1.13e6 | liquidation.circom's full domain |

On gas the wide circuit wins 2.75×. On wall-clock it beats serial per-leg proving and loses to parallel
per-leg proving. Neither is decisive, and gateB6 was right that on X Layer neither number matters much.

**What is decisive is that the per-leg route does not answer this question.** gateB6's `PortfolioMin`
router takes the minimum over `signals[i][PRICE_INDEX]` — the liquidation **price**. The engine ranks
on **distance from the mark**. On gateB6's own eleven-leg book:

```
ENGINE names   : POS10 long   liqPrice 300.47   distance  6.103%
MIN-PRICE leg  : POS3  long   liqPrice   0.47   distance 24.089%
same leg?      : false
```

The router returns a leg **four times further from liquidation** than the binding one. Its gate check
`the contract picks the right leg` passed — against its own expectation, `min(liquidationPrice)`, never
against the engine. That is a verifier that could not fail on the thing that mattered.

**And it is not a router bug.** `liquidation.circom`'s public signals are
`[residual, tolerance, mHat, qHat, p0Hat, s, mmrHat, pLiqHat]` — **there is no mark in them.** No
per-leg proof in existence carries the quantity the ranking is done on, so a distance-ranked minimum
over per-leg proofs would have to either trust an unproven mark handed to the contract alongside the
proofs — which is exactly the input the whole exercise exists to remove — or extend the leg circuit,
at which point it is a new circuit and the comparison restarts.

**Verdict: the wide circuit, at n ≤ 3, and not because it is cheaper.** It is the only one of the two
that proves the statement `portfolio-gate` actually makes. The per-leg route stays the right answer for
books above three legs, but it needs a leg circuit that publishes the mark before its minimum means
anything — and that is a T3 follow-on, not a thing gateB6 already has.

---

## 8. What is not proven

- **Books of 1 or 2 legs are padded by repeating the last leg.** A duplicate cannot change a minimum
  and cannot smuggle in an unproven leg, and it is visible in the public signals as an identical tuple
  — but a verifier reading only the signals cannot tell a 2-leg book from a 3-leg book with a
  duplicate. Documented in the circuit source, not hidden behind a count.
- **Books with any breached leg are refused outright**, not ranked among the survivors as the engine
  does. 331 of 1,500 sampled books.
- **Nothing about notional, HHI, or the correlated-crash stress** — `portfolio-gate` publishes those
  and this circuit says nothing about them. It proves the nearest-liquidation claim and only that.
- **The inputs themselves are still asserted.** Same ceiling as every other circuit here: this proves
  the identity over the numbers it was given, not that those numbers describe a real position.
- **The size ceiling is real**: 316 of 1,500 books (21%) were refused for a position size above
  36,028,797 units — all sub-cent tokens at large notional. That is the price n = 3 charged.

---

## 9. Re-running

```
node zk/scripts/circuit-facts.mjs portfoliogate     # size, read from the artifacts
node zk/scripts/gateB8-0-portfolio.mjs              # prove / verify / REFUSE
node zk/scripts/gateB8-1-portfolio-sweep.mjs        # 1,500 books, both input paths
node zk/scripts/gateB8-2-portfolio-evm.mjs          # EVM rehearsal
node zk/scripts/gate-clone-portability.mjs          # 24 of 24 gates run from a clone
node zk/scripts/build-circuit.mjs portfoliogate     # rebuild from source
```

Results land in `zk/build/gateB8-*.json`. Everything is mirrored byte-identically into `Quiver/zk/`.
