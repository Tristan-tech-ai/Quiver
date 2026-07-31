# options-risk: the blocker was wrong, and the residue is closed

30 July 2026. Every number below was read from an artifact or produced by a script named beside it.
Nothing is deployed. `options-risk` does not emit any of this.

---

## 0. Verdict first

**`buildable-and-built`.** The reported blocker — "requires `exp` and `erf` in-circuit, which is where
this stops being arithmetic and starts being a research project" — is **refuted**. The reported
*permanent residue* — "a wrong normal CDF satisfies every consistency identity and is still wrong about
the price level" — **held**, was reproduced, and turned out to be **worse than reported**. It is now
closed by a circuit, not bounded.

| claim under test | verdict |
|---|---|
| `greeksfp`/`greekssigned`/`parity` exist and prove consistency identities | **held** |
| `greeksfp` is cheaper than the `greeks.circom` it replaced | **held** — 1,065/1,919/2,048 vs 1,103/2,152/4,096 |
| the shared factor `df·nd1` cancels between any two greeks | **held**, and it is exactly what the new circuit exploits |
| a wrong normal CDF satisfies every consistency identity | **held**, all eight, to 3.3e-14 |
| parity "reaches the price" and would catch a one-sided drift | **REFUTED** — parity is blind to the CDF *algebraically* |
| `greekssigned` proves identity A (`d1 − d2 = σ√T`) "as a by-product" | **REFUTED** — a forged proof was accepted |
| the residue is permanent until `erf` is provable | **REFUTED** — `erf` is not what the engine computes |

Two new defects, both demonstrated with real accepted Plonk proofs. One new circuit, gated.

---

## 1. Reproducing what exists

`node zk/scripts/circuit-facts.mjs`, read from `build/*.r1cs` and `build/*_plonk.zkey`:

| circuit | R1CS | Plonk | public | domain | zkey |
|---|---|---|---|---|---|
| `greeks` (fixed grid, replaced) | 1,103 | 2,152 | 13 | 4,096 | 13.5 MB |
| `greeksfp` (per-value exponent) | **1,065** | **1,919** | 13 | **2,048** | 6.8 MB |
| `greekssigned` | 1,952 | 3,615 | 29 | 4,096 | 23.5 MB |
| `parity` | 1,153 | 2,255 | 13 | 4,096 | 13.5 MB |
| `ncdf` (new, this work) | 2,012 | 3,740 | 7 | 4,096 | 9.8 MB |

The brief's figures for `greeksfp` are exact. It is cheaper than the fixed-grid circuit it replaced on
every axis including the ptau power, which is the axis that actually costs something.

`node zk/scripts/probe-black76-identities.mjs`, 5,000 surfaces: **8 of 8 identities hold**, worst
relative residual 4.01e-13 (identity F), best 0.00e+0 (identity H). So the algebra is real.

### 1.1 Identity coverage — what is pinned, and what floats

`node zk/scripts/probe-identity-coverage.mjs`. What `options-risk` actually publishes, and by what:

| published quantity | pinned by | what is left free |
|---|---|---|
| `gamma` | B: `vega·100 = gamma·F²·σ·T` | relative to `vega` only — both carry `df·φ(d1)`, which cancels |
| `vega` | B and E | B and E are two equations in three unknowns: rank 2 of 3 |
| `theta` | E: `theta·730·T = −vega·100·σ` | relative to `vega`; sign pinned only at `r = 0` |
| `volga` | C: `volga·σ = vega·d1·d2·0.01` | relative to `vega` **and** to `d1`, `d2` — unpinned witnesses |
| `vanna` | D: `vanna·F·(d1−d2) = −vega·d2` | relative to `vega`, `d2` **and** `dDiff` — `dDiff` is unconstrained |
| `delta` | G (parity only) | **not pinned** |
| `price` | F (parity only) | **not pinned** |
| `d1`, `d2` | A — *claimed* by `greekssigned` | **not enforced anywhere** |

And the publication grid, which caps any proof: greeks at `round(x, 6)` → ±5e-7, `gamma` at
`round(x, 8)` → ±5e-9, `portfolioValue` and per-leg `value` at `round(x, 6)` → ±5e-7,
`spanMargin.requirement` at `round(x, 2)` → ±5e-3. `d1` and `d2` are **not published at all** — both
`greekssigned` and `parity` take them as public inputs, so those circuits *widen* what the service
commits to rather than proving something about what it already said. That is worth stating plainly to a
buyer.

---

## 2. The residue is real, and parity does not soften it

`node zk/scripts/probe-cdf-residue.mjs`. Black-76 re-derived with a pluggable CDF — checked identical
to the real engine on the real CDF first (worst relative 0.00e+0 over 2,000 surfaces × 9 fields, so
the substitution is the engine with one part swapped) — then three wrong CDFs, 4,000 surfaces:

| identity | hart (engine) | A-S 7.1.26 | logistic 1.702x | hart + 3e-3·x·e^(−x²/4) |
|---|---|---|---|---|
| A `d1 − d2 = σ√T` | 1.54e-14 | 1.54e-14 | 1.54e-14 | 1.54e-14 |
| B `vega·100 = γF²σT` | 6.11e-16 | 6.11e-16 | 6.11e-16 | 6.11e-16 |
| C `volga·σ = vega·d1·d2·0.01` | 2.91e-16 | 2.91e-16 | 2.91e-16 | 2.91e-16 |
| D `vanna·F·(d1−d2) = −vega·d2` | 4.24e-15 | 4.24e-15 | 4.24e-15 | 4.24e-15 |
| E `theta·730T = −vega·100σ` | 5.44e-16 | 5.44e-16 | 5.44e-16 | 5.44e-16 |
| **F `C − P = F − K`** | 1.32e-13 | **3.30e-14** | **1.32e-13** | **6.73e-14** |
| **G `Δcall − Δput = 1`** | 0.00e+0 | **0.00e+0** | **0.00e+0** | **1.11e-16** |
| H `γ/vega/vanna/volga call==put` | 0.00e+0 | 0.00e+0 | 0.00e+0 | 0.00e+0 |
| **worst relative price error** | 0.00e+0 | **19.40%** | **199.13%** | **100.00%** |

All eight hold. **Including parity.** And that is not a near-miss that a tighter bound would catch —
it is exact algebra, and the circuit's own header is wrong about why:

> `parity.circom`: *"it ties a call to a put at the same strike, so a price that drifts on one side and
> not the other fails here."*

In Black-76 the put is not an independent quotation. `P = df·(K·N(−d2) − F·N(−d1))`. For **any** `N`
with `N(−x) = 1 − N(x)`:

```
C − P = df·(F·N(d1) − K·N(d2)) − df·(K − F + F·N(d1) − K·N(d2)) = df·(F − K)
```

`N` cancels. Every tail-plus-branch implementation has that reflection symmetry — the engine's
`ncdf` returns `x <= 0 ? c : 1 - c`, so it has it *by construction*. Parity cannot drift on one side
only. It is not a weak check on the price level; it is not a check on the price level at all. Note that
A-S's residual on F (3.30e-14) is **smaller** than the correct engine's (1.32e-13), which is the
signature of a quantity that cancels rather than one that is being tested.

**Demonstrated, not argued.** `probe-identity-coverage.mjs` builds a real `parity` witness from a whole
book repriced with A-S — F 65,000, K 70,000, T 30d, σ 0.62; call $2,688.470638 against a true
$2,688.465876, **$0.004763 wrong** — and `parity` returns `true`. `C − P` is off by 7.276e-12, which is
double-precision noise.

---

## 3. A second defect found on the way: `greekssigned` does not prove identity A

> `greekssigned.circom`: *"`d1 − d2 = σ√T` … is also identity A from the same family — proven here as a
> by-product rather than as a separate statement."*

`dDiff` appears in exactly one constraint (identity D) and nothing ties it to `σ` or `T`. D contains
the **product** `vanna·dDiff`; the alignment exponent `dD` contains their **sum**. So a compensating
power of ten in the exponents leaves every constraint satisfied with **identical mantissas**.

Measured on F 65,000 / K 70,000 / T 0.08219 / σ 0.62:

| | honest | forged |
|---|---|---|
| `vannaE` | 11 | 10 |
| `dDiffE` | 9 | 10 |
| claimed `vanna` | 3.084100e-3 | **3.084100e-2** (10× the engine's) |
| claimed `d1 − d2` | 1.777485e-1 | **1.777485e-2** |
| true `σ√T` | 1.777485e-1 | 1.777485e-1 |
| `greekssigned` verdict | `true` | **`true`** |

Identity A is not proven as a by-product. `dDiff` is an unconstrained witness and `vanna` is pinned
only *jointly* with it. The fix is cheap — a witness `s` with `s² = T` in mantissa form, then
`dDiff = σ·s` — and is **not applied here**, because `greekssigned` is a built and gated circuit and
moving it is a separate change with its own gate. Recorded, not silently patched.

---

## 4. Defeating the blocker

### 4.1 The premise was wrong

The roadmap says `erf` is needed. **The engine does not compute `erf`.** It computes Hart (1968):

```
N(−z) = e^(−z²/2) · b(z) / d(z)        for 0 ≤ z < 7.07106781186547
```

- a ratio is a multiplication: `c·d = e·b`
- two polynomials are Horner, 13 steps
- that leaves **one** transcendental, `e^(−w)` — and `e^(−w)` *factors* over the binary expansion of
  `w` in a way `erf` does not:

```
w = Σ bᵢ2ⁱ    ⟹    e^(−w) = Π (e^(−2ⁱ))^(bᵢ)
```

Every factor is a constant and every choice is a multiplexer, so `exp` is a product of selected
constants — which a circuit does natively. **The wall was never the transcendental. It was the
fixed-point representation**, the same way Tier 3 was.

### 4.2 It computes, so bounding is the wrong question

The brief asked for a monotonicity + endpoint + known-value ladder, measured. Measured
(`probe-ncdf-fixedpoint.mjs`), against the alternative of actually computing:

| approach | worst \|ΔN\| | table size | price envelope on the reference leg |
|---|---|---|---|
| monotone bracket, 64 anchors | 9.87e-2 | 64 | $2,970 |
| monotone bracket, 1,024 anchors | 6.23e-3 | 1,024 | — |
| density-aided bracket, 1,024 anchors | 5.91e-5 | 1,024 | $11.80 |
| density-aided bracket, 4,096 anchors | 3.69e-6 | 4,096 | $0.738 |
| density-aided bracket, 16,384 anchors | 2.31e-7 | 16,384 | $0.0462 |
| **fixed-point Hart, 2^−44** | **1.53e-13** | **208** | **$3.06e-8** |

Reference leg: F = K = $100,000, T = 30d, σ = 0.6, true price $6,853.94. `price = F·N(d1) − K·N(d2)` at
`r = 0`, so an absolute uncertainty `u` in each `N` gives a price envelope of `(F+K)·u`.

The best bracket measured is **1.51e+6× wider** than computing, and needs a 16,384-entry table against
208 constants. **A bracket is not worth stating.** Reported because the brief asked for the number, not
because it is the answer.

### 4.3 What was built: `zk/circuits/ncdf.circom`

Generated by `zk/scripts/gen-ncdf-circom.mjs` (192 exp constants + 15 coefficients, derived at 200
fractional bits by exact-integer Taylor, Machin's π and integer `sqrt` — no float anywhere in the
generator). Measured: **2,012 R1CS · 3,740 Plonk · 7 public · domain 4,096 · proved in 1,742 ms ·
273,406 gas <!--gas:gateB7-5-ncdf#evm.acceptGas~2%--> to accept,
573 <!--gas:gateB7-5-ncdf#evm.rejectGas--> to refuse**.

The gas figure is one sample, read from `gateB7-5-ncdf.json` as written at 2026-07-29T23:41:44.044Z. The
spread is larger than this document previously stated: re-measured on 2026-07-30 across 25 proofs of an
identical statement, `zk/scripts/probe-execadverse-marginal.mjs` finds **1.24% on a 10-public-signal
circuit and 1.59% on a 15-signal one — 3,438 <!--gas:probe-execadverse-marginal#constantproduct.spread--> and 4,466 <!--gas:probe-execadverse-marginal#execadverse.spread--> gas** — and `probe-plonk-gas-variance.mjs` finds
**1.73%, 4,576 gas**, on kelly's 5 signals. The 1.26% this section used to quote is the bottom of that
range, not the range. Add a 7,500-gas EIP-2929 cold/warm gap between the first call in an EVM instance
and every later one, and the honest reading of this figure is ~273k with a four-thousand-gas error bar.

Every quantity is an integer at `2^−40`. The dominant cost is the truncating multiply
`out·2^S + rem = a·b, 0 ≤ rem < 2^S` — one constraint plus an S-bit range check, 25 of them, and that
cost is irreducible because the total bits discarded is fixed however you group them.

**S = 40 is a measurement, not a preference.** S = 44 was built first: 2,555 R1CS → **4,810 Plonk**,
and `hez_final_12` tops out at 4,096. Refused. 40 is the largest scale that fits without fetching a
larger ceremony file, which the standing rule makes a deliberate act rather than a build side effect.

**What is proven:** for the public point `x`, the public `n` is the standard normal CDF at `x` and the
public `p` is its density, each within a stated envelope.

**Both tolerances are derived, not chosen** (`probe-ncdf-tol.mjs`), term by term, worst at `z = 0`:

| term | ulp |
|---|---|
| accumulated `exp` error (1 quantising `W` + 12 truncations + 12 constant roundings at ½) × `b/d ≤ 0.5` | 9.500 |
| from `b`, Horner-amplified by `Σzʲ` | 3.41e-3 |
| from `d` | 1.70e-3 |
| the `c` relation's own floor remainder | 1.0023 |
| **total** | **10.507** |

`TOLC = ceil(10.507) + 1 = 12` ulp → an envelope of **1.09e-11 on N**. `TOLP = 10`.

**The worst case's use of the bound:** over 6,000 real legs the worst uses **18.3%** of `TOLC` (2.00e-12
absolute) and **21.4%** of `TOLP`. The derivation is conservative because it adds twelve independent
truncations as if they all pushed the same way; the sweep's worst is where they partly cancel.

**The bound can be exceeded.** 13 ulp out moves the residual from 2.197 to 15.197 against a limit of 12
— refused. 2 ulp out sits at 4.197 — accepted. So it is a band, not a knife edge, and not infinite.

**The tail.** Hart switches to a continued fraction at `z = 7.0711`; the circuit does not carry that
branch. Above the split it proves a **bound**: the upper tail is under 2 ulp (1.82e-12, true maximum
0.845 ulp — uses 42.3%) and the density under 8 ulp (7.28e-12, true maximum 6.092 ulp — uses 76.1%).
The output signal `computed` is 1 or 0 so a reader can tell an evaluated statement from a bounded one
without asking. Both branches are proved in the gate. Measured branch rates:

| book shape | \|d\| ≥ 7.0711 | max \|d\| |
|---|---|---|
| the identity sweeps' range (F 1e1–1e5, K 0.3–3×, T 7d–2y, σ 0.2–2.5) | 0.63% | 28.5 |
| a listed Deribit-shaped book (K 0.5–2×, T 1d–180d, σ 0.4–1.5) | 1.03% | 27.2 |
| a hostile short-dated wing (K 0.2–5×, T 1h–7d, σ 0.3–3.0) | **46.79%** | 386.7 |

The last row is the honest limit: on a one-hour-to-one-week wing, nearly half the legs get the bound
rather than the value.

**One tail bound was wrong first time and the derivation caught it.** Computing the bounds by running
the S-scaled recurrences at the split gave `PHI_TAIL = 6` ulp against a true 6.092 — a bound the real
tail violates. `e^(−25)` at `2^−40` is the integer 15, and every relative error in a 15 is 6.7%; the
bound inherited it. A value at the representation floor cannot be used to bound itself. Both constants
are now computed at 200 fractional bits, rounded up, plus one ulp; the gate measures the true maximum
independently and refuses if either constant is under it.

### 4.4 Why this closes the residue rather than moving it

`gamma = φ(d1)/(F·σ·√T)` at `r = 0` — **pure density, no CDF anywhere in it.** And Hart's own
intermediate `e^(−z²/2)` *is* `φ` up to `1/√(2π)`, so the circuit computes the density for one extra
multiply. That intermediate is `df·φ(d1)` — the factor that **cancels** between any two greeks, which
is the whole reason the consistency identities could exist without a transcendental. Pin it and it
stops cancelling.

So a caller who binds `p` to the published `gamma` pins `x = d1` **with no logarithm at all**, and with
`x` pinned, `n` must be `N(d1)`.

### 4.5 Does it actually refuse a wrong CDF? Measured, with real proofs

| wrong CDF | legs | worst \|Δdelta\| in ulp | × the bound | per-leg refusal | proofs accepted |
|---|---|---|---|---|---|
| Abramowitz-Stegun 7.1.26 | 1,194 | 7.66e+4 | 6.39e+3 | **99.66%** | 3 of 3 of the slips |
| logistic 1.702x | 1,194 | 1.04e+10 | 8.69e+8 | **100.00%** | 0 of 0 |

**Detection is per leg and it is not universal, and the gate says so.** The first version of that check
asserted "every leg is outside the bound" and **A-S failed it**: 4 of 1,194 legs slipped under, and all
3 put to the prover **verified**. That is not a defect in the circuit — A-S's error function has 11
sign changes on [−7.07, 7.07] (at ±0.1696, ±0.4973, ±0.9747, ±1.5987, ±2.4306 and 0), and at a
crossing a wrong CDF is momentarily right. It also agrees wherever the CDF has saturated, which is
18.1% of the `d1` axis by measure but a much smaller share of a real book.

A service must prove **every** leg it publishes, so misses compound:

| wrong CDF | 1 leg | 2 legs | 4 legs | 8 legs |
|---|---|---|---|---|
| A-S 7.1.26 | 3.35e-3 | 1.12e-5 | 1.26e-10 | 1.59e-20 |
| logistic | 0 | 0 | 0 | 0 |

**The adversary's better move, also measured.** Nothing forces the prover to submit the true `d1`. A
wrong-CDF service could solve `N_hart(x') = delta_wrong` for `x'` and submit that — the CDF relation
then holds *exactly*. It cannot also match the density, because `gamma` is CDF-independent. Over 1,492
legs: worst `|x' − d1|` **9.16e-4**, worst density gap **2.32e+5 ulp against a 10-ulp bound (2.32e+4×)**,
and **1,489 of 1,492 = 99.80%** of relocated points are outside it. The two relations cannot both be
satisfied.

For scale, the thing being caught: A-S prices a leg wrong by **32.2% worst, 0.0220% mean** over 4,000
legs, while satisfying all eight consistency identities to 3.3e-14.

---

## 5. GATE B7-5

`node zk/scripts/gateB7-5-ncdf.mjs` → **PASSED**, artifact `zk/build/gateB7-5-ncdf.json`.

Constants checked against **two independent references**, and against the circuit source rather than
the generator's own JSON (comparing the generator's two outputs to each other proves only that the
generator is self-consistent):

- every exp constant within **0.5000 ulp** of `Math.exp` — V8's libm, a different implementation from
  the generator's integer Taylor, and 1,000× more accurate than the 2^−40 the table needs
- the functional equation `e^(−a)·e^(−b) = e^(−(a+b))`, 1,260 triples, worst **2 ulp**, no float involved
- group `g+1` is group `g` to the sixteenth, worst **15 ulp** against a derived 16
- `SQRT2PI` from Machin + integer sqrt matches `Math.sqrt(2*Math.PI)` to 0.9 units

**A check that cannot fail is not a check**, so each is shown to fail: the squaring threshold was
**wrong first time** (8, a guess; the derived value is `1+2+4+8 = 15` because squaring amplifies an
error by `2v` per step) and the gate failed on it, accusing a table that was fine. It now carries the
derivation, and a deliberately corrupted entry is shown to cross the line.

Plus: 6,000-leg sweep with 0 violations, a real proof from the worst leg, all 7 public signals refused
when moved by one, a bent proof point refused, the tail branch proved separately, and the exported
Solidity verifier compiled and run in an in-process EVM — accepts once, refuses all 8 tampered
submissions.

---

## 6. What a buyer gets, and what they must still trust

**Gets:**

1. `N(d1)` and `φ(d1)` computed in a circuit to **1.09e-11 / 9.09e-12** absolute — a **$2.18e-6** price
   envelope on a $6,853.94 leg, 3.18e-8% of the price.
2. Therefore `gamma` pinned **absolutely** rather than relative to `vega`, which kills the cancelling
   factor and — through identities B and E — pins `vega` and `theta` absolutely too.
3. A wrong normal CDF refused on 99.66–100% of legs, 1.12e-5 miss probability on a two-leg book, and
   the relocation attack refused on 99.80%.

**Must still trust:**

1. **`x` itself is not pinned by the circuit.** Pinning `d1` to `(F, K, T, σ)` needs `ln(F/K)`, which
   is this same `exp` gadget backwards (`L` is the log of `F/K` iff `K·exp(L) = F`) — one more instance
   of the same block, **not built**. The binding through `gamma` (§4.4) is real and measured but is an
   **off-circuit** check the caller performs: one `sqrt` and two multiplies.
2. **The price needs two instances.** `price = F·N(d1) − K·N(d2)` needs `ncdf` twice; 2 × 3,740 = 7,480
   Plonk against a 4,096 ceiling. It does not fit `hez_final_12`. Either three composed proofs (the
   registry takes any `(proof, publicSignals)` pair) or a larger ptau, deliberately.
3. **The wings.** 46.79% of a one-hour-to-one-week wing book gets a 1.82e-12 bound instead of a value.
4. **The publication grid.** ±5e-7 on the greeks, ±5e-9 on `gamma`, ±5e-3 on `spanMargin`. No proof
   pins a number tighter than it is printed, and the circuit's envelope is already four orders inside
   the grid — so **the grid, not the circuit, is now the binding constraint** on `delta`.
5. `r = 0`, as crypto futures options are quoted. Identity E and the `theta` sign both depend on it.
6. **The two defects in §2 and §3 are unrepaired.** `parity`'s header over-claims and `greekssigned`
   does not prove identity A.

---

## 7. Is an identity-only proof worth shipping?

`perp-gate`'s precedent is a published proves/doesNotProve pair, and that is the right shape — but the
pair has to be *true*. As written, `parity.circom`'s header and `greekssigned.circom`'s header both
claim more than the circuits deliver, and both over-claims were caught by a forged proof rather than by
reading. Shipping an identity-only proof with those headers would put a false sentence in front of a
buyer.

The honest recommendation:

- **Ship the identity family** with the proves/doesNotProve pair *corrected*: parity does not reach the
  price level, because `N` cancels algebraically; and `greekssigned` does not prove identity A.
- **Ship `ncdf` as its own statement.** It is the piece that turns "these greeks agree with each other"
  into "this density is the normal density", and it is the only thing measured here that a wrong CDF
  cannot satisfy.
- **Do not ship a price claim yet.** Two `ncdf` instances do not fit the ceremony file on hand, and the
  `d1` pin is off-circuit. Both are measured, both are ordinary engineering, neither is done.

The blocker was "erf is a research project". It was not. It was fixed-point representation, twice now.

---

## Reproduce

```
node zk/scripts/circuit-facts.mjs                    # sizes, from the artifacts
node zk/scripts/probe-black76-identities.mjs         # 8 of 8 identities hold
node zk/scripts/probe-cdf-residue.mjs                # the residue is real; parity is blind
node zk/scripts/probe-identity-coverage.mjs          # 2 coverage claims fail against real proofs
node zk/scripts/probe-ncdf-fixedpoint.mjs            # computing vs bracketing
node zk/scripts/probe-ncdf-params.mjs                # scale/cost table, branch rates
node zk/scripts/probe-ncdf-tol.mjs                   # the tolerance, derived
node zk/scripts/gen-ncdf-circom.mjs                  # emit circuits/ncdf.circom
node zk/scripts/build-circuit.mjs ncdf               # compile, setup, export
node zk/scripts/gateB7-5-ncdf.mjs                    # the gate
```

Run from `research startup/zk`, where the gate passes end to end including the EVM rehearsal. Run from
the `Quiver/` mirror, sections 1–5 pass (30 checks, 0 failures) and section 6 stops with
`Cannot find package 'solc'` — `Quiver/zk/` has no `node_modules` (correctly gitignored) and needs
`npm install` first. That is pre-existing and affects all **7** gates that call `evmRehearsal`, not
just this one; it is not repaired here because it is shared infrastructure with three other agents
working in the tree.

`npm test` is unchanged at **386** test cases (381 pass, 5 skipped, 0 fail). `src/engine/` is untouched;
the build hash `q1-e1fa99d08887d6cc` has not moved. `node tools/docs-consistency.mjs` →
**CONSISTENT, 223 documents**. Nothing is deployed to any chain.
