# lp-risk: the square root was never the wall, and the bisection was provable all along

**Written 30 July 2026.** `PHASE_B_WIRED.md` §8 records `lp-risk → divergence` as *"unfinished, with a
large carve-out"*, on two grounds: that the encoder needs a rounded BigInt integer square root, and
that **"two of the three published blocks have no closed form at all"** — a 401-point quadrature and a
200-iteration bisection over it, *"roughly 80,000 transcendental evaluations"*, with the verdict that
*"no identity restates either"*.

Both claims were measured. The first is not a blocker at all — it is seven lines that were already
written and already passing 4,000 ratios. The second is half right in a way that matters: the
quadrature genuinely does not fit, but not for the reason given, and the **bisection turns out to be
the cheapest thing in the service to prove.**

| | result |
|---|---|
| 401-point quadrature | **CONFIRMED** — `N = 400`, `i = 0..N` inclusive |
| 200-iteration bisection | **CONFIRMED** — and 204.0 quadrature passes per served answer, measured |
| "roughly 80,000 transcendental evaluations" | **UNDERCOUNTS BY 3×** — 81,804 quadrature *points*, but **245,624** calls to `exp`/`sqrt` |
| "needs a rounded BigInt integer square root" | **REFUTED as a blocker** — 7 lines, already in `gateB4-1`, already green on 4,000 ratios |
| in-circuit cost of that square root | **194 R1CS constraints**, 41.9% of `divergence.circom`'s 463 — compiled and read from artifacts |
| stating the identity on the squared quantity instead | **works, and is not the cheaper option** — 446 R1CS vs 463, but a 120-bit residual bound instead of 41-bit, and **my first two tolerance derivations were both exceeded** |
| "no identity restates the quadrature" | **REFUTED** — the grid is geometric; 802 exponentials collapse to **2** plus a multiply chain, worst gap **5.218e-15** over 4,000 v |
| "no identity restates the bisection" | **REFUTED** — a bracket certificate, **1,776 Plonk gates**, built and gated below |
| what actually blocks the quadrature | **the ceremony file.** 36,613 R1CS at 81 nodes, **8.94× hez_final_12**; needs 2^16..2^17 |
| …and the closed-form route instead of the quadrature | **also the ceremony file, but only one power up.** 3,023 R1CS, which is **~5,619–5,896 Plonk** at the 1.86–1.95× R1CS→Plonk inflation measured off four of this repo's own zkeys, so **domain 8,192**, not 4,096. `probe-lpclosed-cost.json` said "fits `hez_final_12` with room to spare" by comparing an R1CS count against a Plonk ceiling; that is corrected in the file. **`hez_final_13` is a download, and it moves no hash.** |
| the exact value itself | **needs no circuit and no engine change.** `expectedDivergence.volatility` and `horizonPeriods` are published verbatim and unrounded (verified live, and they are in `proof.inputs` too), so `v = σ²T` and `expm1(−v/8)` are recoverable outside the engine — `src/util/lpClosedForm.js`. `codeHash` measured before and after: `q1-e1fa99d08887d6cc` both times. **Not** from `totalVariance`, which is rounded to 6dp and loses 1.12e-6 pp, eight times the quadrature envelope |
| new circuit | `zk/circuits/lpbracket.circom` — 932 R1CS · 1,776 Plonk · 13 public · domain 2,048 |
| gate LP0 — prove / verify / refuse / EVM | **PASSED**, 991 ms prove, 13/13 signals refused, 8/8 dishonest witnesses refused, 278,051 gas <!--gas:gateLP0-bracket#acceptGas~2%--> accept / 573 gas <!--gas:gateLP0-bracket#rejectGas--> reject (one sample each; see §the gas figure below) |
| gate LP1 — sweep against the real engine | **PASSED**, 562 certified of 600, worst case uses **96.3%** of my derived bound |
| gate LP2 — the closed form and its real cost | **PASSED**, and it caught a broken parser of mine before it shipped a zero |
| engine `codeHash` | `q1-e1fa99d08887d6cc`, unmoved; `src/engine/` untouched |
| `npm test` | **386**, unmoved, 0 fail |
| DEFECT FOUND — **fixed on 30 July, outside the engine** | the engine's own boundedness self-check **failed on live inputs** at σ²T ≥ **116.0687**. §6 said it needed an engine change; it did not. See `FIX_LPRISK_BOUNDEDNESS.md` and `npm run gate:lb` |
| ONE FIGURE IN §6 WAS WRONG | it published the full-precision expectation as −0.999999999999998; measured, it is **−0.999999975832329** — corrected in place below |

---

## 1. What lp-risk actually publishes, counted

Three blocks, sixteen numeric fields, counted off a real envelope rather than off the source:

| block | numeric fields |
|---|---|
| `realizedIL` | 3 — `priceRatio`, `impermanentLossPct`, `usd` |
| `expectedDivergence` | 7 — `volatility`, `horizonPeriods`, `totalVariance`, `expectedIlPct`, `expectedIlLeadingOrderPct`, `approximationGapPct`, `usd` |
| `feeVsDivergence` | 6 — `feeAprPct`, `horizonFeesPct`, `expectedNetPct`, `breakevenVolatility`, `breakevenVolatilityLeadingOrder`, `usd` |

`divergence.circom` reaches two of those sixteen: `priceRatio` (as `rHat`, echoed) and
`impermanentLossPct` (as `lHat`, in L-form). That is the honest fraction — **one of three blocks, two
of sixteen fields** — and the carve-out really is larger than the proven part. The claim was right
about the *proportion*. It was wrong about the *reason*, and wrong that nothing else was reachable.

## 2. The transcendental cost, instrumented rather than inferred

`Math.exp` and `Math.sqrt` were wrapped and counted. Per `lpRisk()` call:

| call | `exp` | `sqrt` | total |
|---|---|---|---|
| `realizedIL` only | 802 | 408 | 1,210 |
| + `expectedDivergence` | 1,604 | 810 | 2,414 |
| + `feeVsDivergence` | **163,608** | **82,016** | **245,624** |
| fees ≥ 100% of capital (engine returns `null`) | 1,604 | 811 | 2,415 |

163,608 / 802 = **204.0 quadrature passes** for one served answer, and the 204 decomposes exactly:
1 for the headline, 1 for the doubling loop's first test, **200 for the bisection**, 1 for the
breakeven self-check, 1 for the fixed `σ²T = 0.01` self-check.

So the reported "roughly 80,000" is 204 × 401 = 81,804 quadrature *points*. Read as evaluations it
undercounts by 3×, because each point costs two exponentials and a root. Both figures are now on the
record; neither changes the verdict, and the larger one is the honest one.

Note the fourth row. When `feeAprPct` is large enough that no breakeven exists, the engine returns
early and the whole 243,210-call cost disappears. The expensive path is the one with an answer in it.

## 3. The square root: 194 constraints, and removing it costs more

Three probe circuits were compiled and their constraint counts read from the `.r1cs` artifacts:

| probe | R1CS |
|---|---|
| range discipline only — `Num2Bits(44)` on `r̂`, `Num2Bits(30)` on `L̂` | 77 |
| + the whole root block — `ŝ² = r̂·S`, `Num2Bits(38)`, the 72-bit residual bound | **271** |
| the identity with the root **eliminated** — `L̂²(S + r̂)² = 4·r̂·S³`, no `ŝ` signal at all | **446** |
| `divergence.circom` entire (witnessed root **and** identity, two published residuals) | **463** |

**The square root costs 194 R1CS constraints, 41.9% of the circuit.** That is the answer to "establish
the cost in constraints". It is ordinary work.

And the circuit does not need it. Squaring both sides — the move that cleared a division through three
factors of `SCALE` in `liquidation.circom` — eliminates `ŝ` entirely and compiles at 446 against 463.
**But it is not the cheaper option**, for two reasons that only appeared on measurement:

- The residual `L̂²(S+r̂)² − 4r̂S³` needs a **120-bit** range check at the circuit's declared ceiling,
  where the witnessed-root residual needs **41**. Squaring saves 17 constraints of algebra and spends
  most of them back on the bound.
- Its tolerance is genuinely harder to derive. **My first derivation was exceeded on 451 of 4,000
  live-engine ratios, worst ratio 1.821.** That near-2.0 shape is this project's documented signature
  for a scale error, and it was: I kept only the `L̂` half-step through the square and dropped the `r̂`
  half-step through the other square, which is the same order. **My second derivation was worse — 1,011
  of 4,000, worst 2.154** — because it also missed that the published convention here is
  `2|R| ≤ TOLERANCE`, so the tolerance is twice the residual bound, and that `L̂` is computed *from* the
  rounded root `ŝ`, giving it a half-step of `½ + 2/(1+r)` grid steps rather than `½`. The third
  derivation,

  ```
  TOL = 2·( L̂·(S+r̂)² + 2·L̂·S·(S+r̂) + L̂²·(S+r̂) + 2·S³ )
  ```

  holds on 0 of 4,000, **worst case using 1/1.01 of it** — essentially tight.

So `divergence.circom`'s existing design is correct and the header comment that says *"A SQUARE ROOT IS
NOT COMPUTED HERE, IT IS PROVEN"* was already the right call. The rounded BigInt integer square root
lives in the **witness generator**, off-circuit, and it has existed since 28 July at
`zk/scripts/gateB4-1-divergence-sweep.mjs`:

```js
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
let sHat = isqrt(target);
if ((sHat + 1n) * (sHat + 1n) - target < target - sHat * sHat) sHat += 1n;   // round, not floor
```

Gate B4-1 re-run today: **PASSED** — 3,999 certified of 4,000 (one refused at a 4-decimal rounding
boundary, a 0.025% refusal rate), **0 identity violations, 0 root violations**, tightest identity
9.604e-1 and tightest root 9.461e-1 of their bounds. An independent re-derivation of the same encoding
under a different seed agrees: 4,000 certified, tightest 9.651e-1 and 9.436e-1. **The blocker was
already cleared and the survey did not notice.**

## 4. The bisection: certify the bracket, not the search

This is the part worth building. A root does not have to be recomputed to be certified — it has to be
*located*. Bisection returns the midpoint of a bracket, and a bracket is closed form:

```
g(v) = E[IL](v) + f              the function being rooted, f = horizon fees as a fraction
g(lo) > 0 >= g(hi)               the endpoints straddle
2·v* = lo + hi                   the returned root is the midpoint
hi - lo <= w                     and the bracket is narrow
σ*² · T = v* · S                 the published volatility is the root of the midpoint
```

In L-form (`L = E[IL] + 1 ∈ (0, 1]`, so the field needs no sign, exactly as `divergence.circom` does)
the straddle is two integer comparisons: `L̂(lo) + f̂ > S` and `L̂(hi) + f̂ ≤ S`. No division, no series,
no quadrature. And the last line is **the square root again, stated on the squared quantity** — the
same move as §3, applied to `breakevenVolatility` this time.

**Three things had to be true, and all three were measured:**

**(a) `E[IL](v)` must be monotone**, or a straddled root is not unique. The engine's comment asserts
it. Measured over **20,001 log-spaced v in [1e-8, 1e4]: 0 non-decreasing steps.** It saturates against
the −100% floor to within 1e-12 at v ≈ 209.4, and every reachable breakeven sits far below that
because `f < 1` is required for a breakeven to exist at all.

**(b) The bracket must be expressible on the 1e-9 grid.** After the engine's 200 halvings the bracket
is about **2.8e-17** wide — both endpoints land on the *same* integer, and `lo < hi` cannot even be
stated. So the encoder halves only until both endpoints round to the published 5-decimal
`breakevenVolatility`. **Measured: 12 to 25 halvings across 562 certified service calls**, 17 on the
worked case. The certificate is two evaluations of the quadrature wide against the engine's 200 — and
the *circuit* evaluates it **zero** times.

**(c) The straddle must survive rounding.** It does not always: 3 of 600 calls were refused with
`g(lo) > 0 does not survive the grid`, where the margin at the low end is under half a grid step.
That is a refusal, not a proof of something else.

### `zk/circuits/lpbracket.circom` — built and gated

932 R1CS · **1,776 Plonk** · 13 public signals · domain 2,048 — **1,776 of the 4,096 hez_final_12
allows**, so it fits the ceremony file this repo already carries.

The worked case, `{volatility: 0.05, horizonPeriods: 30, feeAprPct: 20, capitalUsd: 100000}`:

```
served breakeven σ   : 0.06648
horizon fees         : 1.643836% of capital
bracket              : [0.132598876953125, 0.13260650634765625]   17 halvings, 0 doublings
v* (midpoint)        : 0.13260269165039062
σ certified          : 0.066483755  ->  round to 5dp: 0.06648  ==  served
straddle             : L̂(lo)+f̂ = 1000000104 > 1000000000 >= 999999166 = L̂(hi)+f̂
midpoint residual    : 1              (must be 0 or 1)
width slack          : 563 of an 8192-step policy bound
root residual        : -1632999250    tolerance 5989025360    2|Rs|/TOL = 5.453e-1
```

**GATE LP0 — `zk/scripts/gateLP0-bracket.mjs` — PASSED.** Proved in 991 ms. Every one of 13 public
signals rejected when moved by one; a bent proof point rejected. Eight dishonest witnesses refused
before a proof exists: a non-straddling bracket, a reversed bracket, a root off the midpoint, a
volatility that is not the root of the midpoint, a width bound narrower than the bracket, fees at 100%
of capital, endpoint expectations in increasing order, a zero horizon. In an in-process EVM against
the exported Solidity verifier (solc 0.8.26, 8,330 deployed bytes): honest proof
**278,051 gas** <!--gas:gateLP0-bracket#acceptGas~2%-->, all 14 tampered submissions refused, cheapest
refusal **573 gas** <!--gas:gateLP0-bracket#rejectGas-->.

**The gas figure is ONE SAMPLE and the byte count is not.** 8,330 deployed bytes is deterministic and
reproduces to the digit. The accept figure is read from `gateLP0-bracket.json` as written at
2026-07-29T23:43:06.417Z, and it is a property of the particular proof rather than of the statement:
Plonk proving is randomised, and `zk/scripts/probe-execadverse-marginal.mjs` measures a **1.24%–1.59%
spread — 3,438 <!--gas:probe-execadverse-marginal#constantproduct.spread--> to 4,466 <!--gas:probe-execadverse-marginal#execadverse.spread--> gas — across 25 proofs of an identical statement**, on top of a 7,500-gas
EIP-2929 cold/warm gap between the first call in an EVM instance and every later one. Re-running gate LP0
will move this number by thousands without anything having changed. Read it as ~278k, and never subtract
it from another figure of this kind to claim a marginal: this document's sibling
`VERIFY_EXEC_VERIFY.md` published four different values of one marginal that way.

**GATE LP1 — `zk/scripts/gateLP1-bracket-sweep.mjs` — PASSED.** 600 real service calls, fee APR
log-uniform from 0.01% to 400%, horizons 1 to 365 periods. **562 certified**, 35 where the engine
itself says no breakeven exists, 3 refused by the encoder, **0 strayed from the served figure**.
0 midpoint violations, 0 straddle violations, 0 root-bound violations.

**My derived bound and the worst case's use of it.** The root statement is `σ̂²·T = v̂*·S`. With
`σ̂ = σS + e`, `|e| ≤ ½`:

```
|Rs| = |σ̂²T − v̂*S| <= (σ̂ + ¼)·T + S/2        so, at 2|R| <= TOL,   TOL = 2·(σ̂ + 1)·T + 2·S
```

**The first draft of that line omitted the factor of two** and would have been exceeded by ≈2.0 on
every honest witness — the same near-2.0 shape as §3, caught before the gate existed. The corrected
bound: **worst case over 562 certified calls uses 1/1.04 of it — 96.3%** — at σ = 0.129854598, T = 304.
Not vacuous, and demonstrably able to fail: perturbing `σ̂` by **2 grid steps (2e-9 in σ)** pushes
`2|Rs|/TOL` to 2.938 and the bound rejects it. One grid step is accepted, at 0.9873.

**What LP0/LP1 do not prove, stated in the circuit header, in the gate output, and in the published
signals.** `eLoHat` and `eHiHat` are the 401-point quadrature. They arrive as **public inputs** and are
certified by nothing. A caller who supplies two wrong values that happen to straddle gets a valid proof
of a false breakeven. That is the whole residue, and it is why both values are public: a reader cannot
miss which numbers were assumed. Monotonicity is likewise not in the circuit — it is a property of the
function, established by the LP1 sweep. Nor is the fee arithmetic, the concentration factor, or the
verdict string.

**This is worth building anyway**, because it moves the remaining problem from *two* unprovable objects
to *one*. The bisection is no longer in the carve-out; the quadrature is, twice.

## 5. The quadrature: reducible, and blocked on a download

`PHASE_B_WIRED.md` says *"no identity restates either"*. For the quadrature that is false, and the
reason is sitting in the engine's own grid definition. Its nodes are `z_i = −6 + 0.03·i`, so

```
s_i := √r_i = exp(−v/4 + (√v/2)·z_i) = exp(−v/4 − 3√v) · exp(0.015·√v)^i
```

is **geometric in i**. Two exponentials and 400 multiplications reproduce all 401 nodes, and `r_i = s_i²`
comes free. The Gaussian weights `exp(−½z_i²)` do not depend on `v` at all — they are compile-time
constants. Measured against the engine's own pass over **4,000 log-spaced v in [1e-6, 200]: worst gap
5.218e-15**, at v = 4.632. **802 exponentials per pass become 2.**

The two seeds are polynomial too, so no transcendental primitive is needed:

| seed | argument range | cost for < 1e-12 relative |
|---|---|---|
| `exp(0.015·√v)`, v ≤ 250 | 0.2372 | **9 Taylor terms** (1.25e-13) |
| `exp(−(v/4 + 3√v))`, v ≤ 250 | 109.9 | **10 Taylor terms + 9 squarings = 19 multiplications** (7.74e-13) |

This is the third time on this project that "blocked on transcendentals" has turned out to be
fixed-point work — after Tier 3 and after Black-76.

**81 of the engine's own 401 nodes suffice.** Striding the same grid by 5 reproduces the served
4-decimal `expectedIlPct` on 3,000 of 3,000 sampled v, worst gap to the full sum 4.702e-10 against a
published half-step of 5e-7:

| stride | nodes | worst gap to the 401-point sum | rounded figures that differ |
|---|---|---|---|
| 1 | 401 | 5.551e-16 | 0 of 3,000 |
| 4 | 101 | 3.650e-10 | 0 of 3,000 |
| **5** | **81** | **4.702e-10** | **0 of 3,000** |
| 8 | 51 | 2.845e-8 | **3 of 3,000** |
| 10 | 41 | 3.709e-7 | 37 of 3,000 |
| 20 | 21 | 1.511e-4 | 468 of 3,000 |

Stride 8 is the row that matters for discipline: its worst gap is 2.845e-8, comfortably *under* the
5e-7 half-step, and 3 of 3,000 rounded figures differ anyway. **A gap under half a published step is
not the same claim as rounding to the same figure.** The guard has to compare rounded values.

### Two things I got wrong here, both caught by measurement

**The chain step.** My first fixed-point restatement used `p = exp(0.015·√v)` — the *full*-grid ratio —
with an 81-node *sub*-grid. It read −0.8587 where the engine reads −0.1175 at v = 1, a consistent ≈23×
across the small-v range. That is not a scale error: the chain walked only 1/5 of the domain and
sampled nothing but the left tail, where IL ≈ −1. The ratio must be `exp(stride·0.015·√v)`.

**The seed position.** Seeded at `i = 0` — the obvious reading — the chain starts at the *smallest*
number on the grid, where relative error is worst, and multiplies that error forward into every later
node. Worse: once `ŝ(z=−6)` underflows to zero the chain stays zero, so the **high** tail reads zero
too and the whole figure collapses onto the −100% floor. Measured: the engine reads **−94.5819%** at
v = 23.32 where a left-seeded chain reads **−99.99999980%**. Seeding at `z = 0` (`ŝ = exp(−v/4)`, the
best-conditioned node) sends both tails toward the one place degeneracy is harmless, since
`IL(0) = IL(∞) = −1`. After that fix, at an s-grid of 1e-18:

| s-grid | certified of 3,000 | refused | worst gap among certified | refusal band in v |
|---|---|---|---|---|
| 1e-9 | 2,791 | 209 | 5.000e-7 (a rounding tie) | [4.0e-6, 115.4] |
| 1e-12 | 2,886 | 114 | 5.000e-7 | [4.0e-6, 115.4] |
| **1e-18** | **2,891** | **109** | **5.000e-7** | **[4.0e-6, 10.4]** |

### What actually blocks it: 36,613 constraints against 4,096

`zk/circuits/lpexpectation.circom` implements the centre-seeded 81-node chain — `s[MID] === sMid`, the
chain bound `s_{k+1}·SS = s_k·p`, `r_k = s_k²`, the one division per node cleared by cross-multiplication
`t_k·(SS + r_k) = 2·s_k·SS`, and the weighted summation. It compiles.

| circuit | R1CS |
|---|---|
| `divergence` (the `realizedIL` identity) | 463 |
| `lpbracket` (the bisection's bracket) | 932 |
| **`lpexpectation`** (81-node quadrature) | **36,613** |
| hez_final_12 ceiling | 4,096 |

**8.94× over.** Plonk expands R1CS by between 1× and 2× depending on comparator density, so it needs
powers-of-tau **2^16 to 2^17**. The binding cost is the per-node division bound: one signed range check
per node, and at the s-grid the tails require, that residual is 152 bits wide — roughly 300 constraints
a node, 81 times.

So the quadrature is **not** blocked on a missing identity, and **not** blocked on transcendentals. It
is blocked on a ceremony file. That is a decision about a download, not a research problem — and it is
the same wall `portfolio-gate` hit at 3,970 of 4,096, which a sibling session has just been through.

**GATE LP2 — `zk/scripts/gateLP2-expectation-cost.mjs` — PASSED.** It reads every count from the
`.r1cs` artifacts rather than from circom's console summary, because circom prints both
`linear constraints` and `non-linear constraints` and a regex for the first matches the second.

It also caught a defect of mine. My inlined header parser skipped 20 bytes from `nWires` to
`nConstraints` where the correct distance is 24, and read a zero out of the middle of `nLabels`. The
gate went red on the cross-check against `divergence.r1cs` (known independently to be 463) — and the
row *below* it, "the two provable statements fit the ceiling", had passed **green on zeros**, which is
exactly a check that cannot fail. Both are fixed: the offset, and a non-vacuity guard requiring the
counts to be nonzero.

## 6. A defect found in passing, not fixed here — and closed the same day, outside the engine

**FIXED 30 July 2026 in `src/util/lpBoundedness.js`, with the build hash `q1-e1fa99d08887d6cc` unmoved.**
The paragraph headed *"Not fixed here"* at the foot of this section was wrong twice over and both errors
are left in place below, because what a wrong conclusion looked like is the part a reader cannot
reconstruct afterwards:

1. **It said the fix needs `src/engine/`.** It does not. The check's subject is a *derived* field, and
   §5's own closed form recomputes it from inputs the envelope echoes, so the verdict can be
   re-evaluated after the engine returns. Written up in `FIX_LPRISK_BOUNDEDNESS.md`; asserted by
   `npm run gate:lb` (12 checks, 1,142 calls) and `npm run gate:lb-revert` (four reverts, all red).
2. **One figure in it was simply wrong.** This section published the full-precision expectation at
   σ = 0.62, T = 365 as **−0.999999999999998**. Measured: the closed form gives
   **−0.999999975832329** and the engine's own quadrature gives **−0.999999976290989**. The published
   value is neither; it is the expectation at a total variance near 270, not at 140.306, and it
   understates the distance from −1 by **seven orders of magnitude** (2e-15 against 2.4e-8). The
   defect register had the right number — `−0.9999999758323288` — all along, so the two disagreed and
   nothing compared them. Anything reasoning about how close this value sits to the bound should use
   the register's figure.

**The engine's own boundedness self-check fails on live inputs.**

```js
checks.push({ name: 'boundedness: reported expected divergence lies in (-100%, 0] ...',
              residual: e, pass: e <= 0 && e > -100 });     // e = round(E[IL]*100, 4)
```

The check ranges over the **rounded display value**. Once `E[IL] ≤ −0.9999995`, `round(E[IL]*100, 4)`
is exactly `-100`, and `-100 > -100` is false. Measured: the first total variance where it flips, at
T = 365, is **σ²T = 116.0687404** (σ = 0.5639). At σ = 0.62 daily over a year (σ²T = 140.3) a live call
returns:

```
ok=true  expectedIlPct=-100
[pass] IL identity: closed form 2√r/(1+r)−1 == explicit constant-product token value
[pass] E[IL] check: −σ²T/8 == numerical E[IL] at σ²T=0.01
[FAIL] boundedness: reported expected divergence lies in (-100%, 0] ...   residual=-100
[pass] breakeven: expected fees == expected divergence at breakevenVolatility
```

`src/engine/proof.js` turns any `pass === false` into `allChecksPass: false` in the envelope, so a
plausible high-vol call ships with a failed self-check. **The value is not wrong** — full precision it
is −0.999999999999998, strictly inside (−1, 0]. It is display rounding hitting a strict inequality, the
same class as the `DIVERGENCE_HEADROOM.md` defect.

**Not fixed here.** `src/engine/` is frozen for this session and the build hash `q1-e1fa99d08887d6cc`
must not move. Recorded for whoever owns the next engine change; the one-line shape is to evaluate the
check on the unrounded fraction, not on the served percentage.

> **Retained, and wrong.** The two sentences above are the reasoning that deferred this for a day. The
> first is a non sequitur: the check being frozen does not freeze the *verdict*, which is computed from
> published inputs and can be re-derived outside the tree the hash is taken over. The second is right
> about the shape and wrong about the cost — evaluating on the unrounded fraction moves the build hash
> only if you edit the engine, and nothing forced that. The figure quoted three lines above is also
> wrong; see the correction at the head of this section.

## 7. The smallest honest statement, and the verdict

For `lp-risk`, today, with the ceremony file this repo carries:

> For a full-range constant-product position at a given price ratio, the impermanent loss this service
> published satisfies `L·(1+r) = 2√r` on the 1e-9 grid, with both residuals and both bounds published
> (`divergence`, gates B4-0/1/2, already shipped). And for the fee-breakeven volatility it published,
> the returned value is the midpoint of a bracket whose endpoints straddle the fee level under two
> stated expectation values, is the square root of that midpoint, and is narrow enough that the whole
> bracket rounds to the figure served (`lpbracket`, gates LP0/LP1, new).
>
> **This says nothing about whether those two expectation values are correct.** They are a 401-point
> numerical quadrature, supplied as public inputs, certified by nothing. They are `expectedIlPct` — one
> of the three blocks — and the verdict string rests on them. The quadrature has a closed-form
> restatement (§5) that compiles at 36,613 constraints and needs a 2^16–2^17 powers-of-tau file this
> repo does not have.

**Verdict on the reported blocker: partly held.** The square root claim is refuted — it was 194
constraints of ordinary work, already done, and removing it entirely is not even the cheaper option.
The "no closed form" claim is refuted for both objects: the bisection has a bracket certificate that is
now built, proved, verified, refused, and swept; the quadrature has a geometric restatement that agrees
to 5.218e-15 and needs no transcendental primitive. What survives is the sentence the original survey
got right and for the wrong reason — **the service's verdict still lives in the un-proven part** — and
one new, precise, purchasable statement of what it would take: a larger ceremony file.

---

### Files

- `zk/circuits/lpbracket.circom` — the bracket certificate (new)
- `zk/circuits/lpexpectation.circom` — the quadrature, compiled to measure its cost (new; deliberately
  exceeds hez_final_12, so `build-circuit.mjs` will refuse the setup — compile only)
- `zk/scripts/lib/lpbracket-encode.mjs` — witness generator, with the quadrature copy validated
  against a served figure rather than trusted (new)
- `zk/scripts/gateLP0-bracket.mjs` · `gateLP1-bracket-sweep.mjs` · `gateLP2-expectation-cost.mjs` (new)
- `zk/build/gateLP0-bracket.json` · `gateLP1-bracket-sweep.json` · `gateLP2-expectation-cost.json`
- unchanged: `src/engine/lpRisk.js`, `zk/circuits/divergence.circom`, `zk/scripts/gateB4-*`,
  `assets/whitepaper*`

All three gates were re-run from the **clone layout** (`Quiver/zk/scripts/`, resolving the engine
through `service-root.mjs`'s `../../src/` path) as well as from the dev tree. LP1 and LP2 pass from
both. LP0 passes everything from the clone up to the EVM rehearsal, which needs `solc` — a dependency
the clone's `node_modules` does not carry, and the pre-existing `gateB4-2-divergence-evm.mjs` fails
identically there. That is a property of the clone, not of this circuit, and it is recorded rather
than papered over.
