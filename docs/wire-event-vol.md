# event-vol: the claim, tested — and the one field it turned out to be true about

`event-vol` was the eighth deterministic service and the fourth of those eight with no circuit. A
claim had been made about it: that it *publishes a field which is a single `N(x)`, reachable by the
already-built `ncdf` circuit with zero new artifacts*. This is what happened when that was measured
instead of accepted.

**Verdict: the mathematical half of the claim is TRUE, with one correction that changes the guard.
The "zero new artifacts" half is FALSE.** The field is now wired on both surfaces, behind
`snark: true`, and `gateB7-6-eventvol-straddle.mjs` proves it end to end. Nothing is deployed.

> **Re-measured 30 July, after the `ncdf.circom` two-sided rebuild.** Every figure below was taken
> again against the current key rather than carried forward, and three classes of them had moved.
> §8 records what was stale and why, §9 records a defect the re-measurement found in
> `src/util/snark.js` that had turned gate B7-6 red, and §10 records what a second reader must still
> not conclude. The route itself did not change: it is the same circuit, the same single `N(x)`, and
> still no new artifacts beyond the four the rebuild replaced.

---

## 1. The claim, tested

### 1.1 Which field, and why that one is reachable when options-risk's is not

`ncdf.circom` pins `N(x)` **given** `x`. Its own header says what it does not do — it does not pin
`x` — and for `options-risk` the point is `d1 = [ln(F/K) + ½σ²T]/(σ√T)`, so pinning it needs a
logarithm. That is why options-risk still has no proof.

The event-vol straddle is struck **at the forward**. `K = F`, so `ln(F/K) = 0` and the logarithm is
gone:

```
d1 = ½σ²T / (σ√T) = σ√T / 2        d2 = d1 − σ√T = −d1
C = S·N(d1) − S·N(d2)              P = S·N(−d2) − S·N(−d1)
C + P = 2·S·(2·N(σ√T/2) − 1)
```

One point of the normal CDF, no logarithm. That is the whole reason this service is reachable with a
circuit that already exists, and it is the reason the same route does **not** open for the service the
circuit was originally written for.

The remaining binding — that `x` really is `σ√T/2` — is a **squaring**, `4x² = σ²T`. A reader performs
it on the public signals in one line of rational arithmetic. It is not in the circuit, and the
`doesNotProve` text says so rather than letting the shape imply it.

### 1.2 The correction: it is one POINT, not one EVALUATION

`d2 === −d1` is exact in the reals and **false in IEEE-754 on the majority of legs**, because the
engine forms `d1` as `(0 + 0.5*sigma*sigma*T)/(sigma*sqrtT)` and `d2` as `d1 - sigma*sqrtT` — two
different float paths. Measured over 40,000 legs (vol 5–300%, horizon 6h–400d):

| measured | value |
| --- | --- |
| `d2 === -d1` in doubles | 15,923 of 40,000 = **39.81%** (gate seed) · 8,124 of 20,000 = **40.62%** (independent seed) |
| worst \|\|d2\| − d1\| | 1.465e-3 ulp of 2^-40 |
| worst \|N(d1) − (1 − N(d2))\| | **3.662e-4 ulp**, identical on both sweeps = **6.104e-3%** of the 6-ulp band the circuit enforces |
| max `x` reached | 1.56071 (the circuit's branch split is 7.07107) |

The first row is a **sampling statistic**, and it is quoted with its sweep from here on. The encoder's
own header used to state one figure as though it were reproducible and the gate that claims to
reproduce it produced a different one; both are correct for their seed and neither is "the" number.
The row that matters — the worst collapse — is quantised to a multiple of the grid and came out
bit-identical on both sweeps, which is why one proof can carry the field.

So the engine calls Hart four times, at two magnitudes. **One proof still carries the field** — the
collapse is 6.104e-3% of the band the circuit enforces — but it is charged **per leg**, from
the engine's own two values, rather than assumed away. `black76(...).delta` is `ncdf(d1)` and
`probAbove(...)` is `ncdf(d2)`; both are lifted, neither is restated.

The last row matters too: `x = σ√T/2` never approaches the tail branch on any realistic input (7.07
would need `σ√T = 14.14`, e.g. 300% vol over 22 years), so every served answer is on the **computed**
branch and none gets the weaker bounded statement. The encoder refuses the tail by name anyway rather
than relying on the sweep.

### 1.3 "Zero new artifacts" is false, and here is the bill

The circuit was built and gated. The **served build was not carrying it.** Wiring required copying
four files into `assets/zk`:

| file | bytes |
| --- | --- |
| `ncdf_plonk.zkey` | 10,265,940 |
| `ncdf_js/ncdf.wasm` | 99,694 |
| `ncdf_js/witness_calculator.cjs` | 10,356 |
| `ncdf_vk.json` | 2,043 |
| **total added** | **10,378,033** |

Measured 30 July with `cmp` against `zk/build`: all four are **byte-identical** between `assets/zk`
and the build the gate gates. The three that moved are the two-sided rebuild — the first cut of this
table was taken before it.

That is the largest single artifact this deploy carries, and it is why `proverWorker.mjs` loads every
circuit lazily: a deploy where nobody asks event-vol for a proof never reads it.

Two other things cost something, and neither was free:

- **`gates/preflight.mjs` assumed one grid.** Its check read "every handler that builds a zk proof
  snaps its inputs onto **that** grid first", where *that* meant 1e-9, because every circuit on this
  host scaled by 1e9. `ncdf.circom` carries integers at 2^-40 and its public signals are not caller
  fields at all. The blanket form of the check called the correct handler a defect. It now exempts by
  **name**, with the grid written down, and polices the list in both directions.
- **`snark` becomes a preference rather than an input** for event-vol, exactly as it already is for the
  other four proof-emitting services. A caller who was passing `snark: true` to event-vol had it
  hashed into `proof.inputs`; it is now destructured out. That moves the contentHash for that one
  request shape and no other — the pinned fixture hash is unmoved, verified below.

### 1.4 The second honest statement, and why it is not built

There were two candidate statements at different strengths, and the brief was right that they are
different in kind. The weaker one is **not** wired, and the reason is worth writing down.

- `oneSigmaUsd = S·σ·√T`, `oneSigmaPct`, `rangeOneSigma`, and
  `eventIsolation.eventMove1SigmaUsd = S·√(σ_A²T_A − σ_B²T_B)` are **pure rational arithmetic plus one
  square root**. A square root is provable by squaring, so all four are reachable — but by a **new**
  circuit, a new ceremony run and a new verifier. That is the opposite of what this task was about.
- `checks[0]` is **not** what the brief described. The numerical integral in `eventVol.js` checks the
  **straddle**, not the event isolation; the event isolation carries only a non-negativity test on
  `σ_A²T_A − σ_B²T_B` and discloses an inverted term structure rather than fabricating a move. And a
  501-point quadrature agreeing with a closed form is an **agreement claim between two computations**,
  not an identity over the inputs. A circuit could only certify it by integrating in-circuit, which is
  a different and much larger object than the one that already exists.

---

## 2. The guard, derived

The circuit certifies `N(x̂)` at the point it was handed. Two bounds follow and they are **not the same
claim** — conflating them is how a guard ends up either refusing honest answers or promising more than
the circuit does.

`dStraddle/dN = 4·S` exactly, from `C + P = 2S(2N − 1)`. The map is affine, so a bound on `N` times
`4S` **is** a bound on the straddle — no linearisation, no derivative estimate. (The liquidation guard
was measured wrong precisely by linearising; this one cannot be, because there is nothing to linearise.)

**`encodingBoundUsd` — what the server may assert**, holding both numbers:

```
4·S·(0.5 + collapseUlp)·2^-40  +  ε·S + 0.5·ε·|R|
```

one rounding of `N` onto the 2^-40 grid, the measured per-leg collapse, and the reconstruction's own
float error. `n̂ ∈ [½,1]` so `1 − n̂` is exact by Sterbenz; the two products carry ε/2 of `S·n̂` and
`S·(1−n̂)`, whose magnitudes sum to `S`; the difference carries ε/2 of `|R|/2`; the doubling is exact.

**`envelopeUsd` — what a buyer is entitled to**, knowing only what the circuit promises:

```
4·S·(TOLC + 0.5·φ_max + collapseUlp)·2^-40 ,  TOLC = 12 ulp, φ_max = 1/√(2π)
```

### Headroom, measured over 20,000 legs from the SERVED handler

| | gate B7-6 (20,000 legs) | independent sweep (20,000 legs, other seed) |
| --- | --- | --- |
| worst honest leg / `encodingBoundUsd` | **99.9915%** | **99.9914%** |
| worst honest leg / `envelopeUsd` | **4.0987%** | **4.0989%** |
| exceedances | 0 | 0 |
| legs refused | 0 | 0 |

The independent sweep is not a rerun of the gate: it takes the same 20,000 served answers but measures
the buyer side against a normal CDF that is **neither Hart nor the circuit** — Maclaurin `erf` below 2,
the classical `erfc` continued fraction above it, the two checked against each other to 9.02e-12
relative on their overlap before either is used as a ruler. The worst encoding case sits at spot
**5.185737**, vol 44.0724%, horizon 353.911 days: gap 9.4333e-12 against a bound of 9.4341e-12. The
bound is reached at a **low** spot, because the `ε·S + 0.5·ε·|R|` float term is the part that does not
scale with the grid.

The encoding bound is **reached**, not respected from a distance — which is what makes it a bound
rather than a number nobody measured. The buyer envelope is 24.4x wider and **the whole of the
difference is a promise `ncdf.circom` makes that this engine does not need**: the ratio is
`(12 + 0.5·φ_max)/0.5`. Tightening it means tightening `TOLC`, which is a property of the circuit, not
of this service. Reporting 4.1% as though it were slack I chose would be the dishonest version of that
sentence.

#### And `TOLC` is not the band, which makes that expression conservative for two reasons that cancel

This is the correction with the sharpest edge on it, and it was found by re-deriving the buyer bound
rather than reading the one that shipped. `ncdf.circom` states its CDF constraint as
`2·resid + TOLC·dHat ≤ 2·TOLC·dHat`, so what it **enforces** is `|resid| ≤ TOLC/2 = 6 ulp` — the
circuit's own header says so and `gateB7-5`'s artifact publishes `bandUlpN: 6`. A buyer's real distance
from the truth is three terms, all three of them measured, none of them 12:

| term | ulp of 2^-40 | what it is |
| --- | --- | --- |
| band | 6.0000 | what the circuit enforces (`TOLC/2`, not `TOLC`) |
| evaluator | 2.1100 | the in-circuit fixed-point Hart recurrence vs the independent ruler — **not named in `envelopeUsd`** |
| x grid | 0.1995 | half a grid step of `x` through the Lipschitz constant (`0.5·φ_max`) |
| **buyer envelope** | **8.3095** | = 7.5575e-12 absolute; **±1.8138e-6** on a $60,000 spot |

`envelopeUsd` spends `TOLC + 0.5·φ_max = 12.1995` ulp, which is **1.4681×** that. So it is sound — but
sound because 12 over-covers the band by 6 while the omitted evaluator term only costs 2.11. **Two
errors of opposite sign.** Measured over the same 20,000 legs, the worst honest leg uses **6.0177%** of
the corrected 8.3095-ulp envelope, with zero exceedances.

That makes the constant a trap rather than a typo, and it is written into the encoder now: "correcting"
`TOLC` from 12 to the band without adding the evaluator term gives 6.1995 ulp — **74.61%** of what a
buyer actually needs — and the envelope becomes **unsound while looking like a fix**. The value was
therefore left at 12 (gate B7-6 asserts it equals the constant it parses out of the circom, and it
does), the comment was corrected to say which of the two it is, and the three-term decomposition is now
written beside the expression that does not use it.

Confirmed separately over 200,000 legs across a deliberately wider box (spot 1–1.1266e8, vol 1–500%,
horizon 1h–1000d): worst use **99.9943%**, zero exceedances. That wider sweep was a **one-off probe, not
a committed gate** — the number a reader can reproduce from this repository is the 20,000-leg 99.9915%
above, and it is quoted first for that reason.

### The ceiling fires

Above the spot where the circuit's 12-ulp envelope exceeds half of the last digit the straddle is
published at, no proof of this shape is about the number that was served:

```
0.005 / (4·(12 + 0.5·φ_max)·2^-40) = 1.1266e8
```

Bisected against the real handler: it refuses above spot **1.1266e8**, matching the derivation. A call
at spot 2e8 comes back `status: "unavailable"` with the envelope quoted in the reason. Outside the
ceiling — beyond 1e9, nine times past a refusal that already fired — the tight bound itself would
start to fire; the check order puts the ceiling first, so that region is unreachable on the served
path.

Because the shipped envelope is 1.4681× the corrected one, the shipped ceiling is the **tighter** of the
two: from the 8.3095-ulp decomposition above it would sit at 1.65399e8. So the conservatism runs in the
safe direction here as well — it refuses a band of spots between 1.1266e8 and 1.65399e8 that a correctly
decomposed envelope would have served. That is a refusal of honest answers, not a certification of wrong
ones, and it is the right way round.

---

## 3. What the proof catches, and the uncomfortable half

`gateB7-5` measured a wrong CDF over options-risk's `d1`, which ranges over the whole axis. event-vol's
`x` is `σ√T/2`, a narrow slice near zero, so the question had to be asked again rather than inherited.

| wrong CDF | straddle wrong by (worst / mean) | ncdf refuses | worst residual | slipped under → verified |
| --- | --- | --- | --- | --- |
| Abramowitz-Stegun 7.1.26 | 0.0007% / 0.00006% | 99.99% | 6.39e3x the bound | 1 of 8,000 → 1 of 1 |
| logistic 1.702x | 6.6570% / 4.4700% | 100.00% | 8.69e8x the bound | 0 → 0 |

**Read the first row honestly.** On options-risk's wider domain A-S prices a leg 19.4% wrong. On the
ATM straddle it does not — the straddle sits where A-S happens to be accurate. So what this proof buys
here is that **the evaluator is pinned**, not that a buyer is protected from a large mispricing. One
A-S leg in 8,000 landed inside the tolerance and its proof verified, because at a zero crossing of its
own error a wrong CDF is momentarily right. Both facts are in the gate as passing assertions with the
numbers attached, not as caveats in prose.

The second row is the one where the tightness earns its keep: a surrogate that **is** economically
wrong is refused on every leg.

The honest engine, on this domain, leaves a CDF residual of **2.4853 ulp** and a density residual of
**2.1152 ulp** over 20,000 legs — both exercised, neither exceeded. Against the bands the circuit
actually enforces that is **41.42%** of 6 ulp and **42.30%** of 5 ulp. The gate prints those two
residuals as fractions of `TOLC` and `TOLP`, which reads as 20.71% and 21.15% and is **2× optimistic**;
the ulp figures are the same measurement and the denominator is the thing that was wrong. This is the
same 2× that `gateB7-5` corrected for options-risk's domain and that never propagated here.

Do not confuse that residual with Hart's own accuracy. `|N_engine(x) − ruler(x)|` over the same 20,000
legs is **4e-4 ulp** on the CDF and **2e-4 ulp** on the density — four orders smaller. The 2.4853 ulp
above is the distance from the engine's rounded value to the **circuit's fixed-point recurrence**, which
is the quantity that has to fit inside the band. Two different claims, and the small one is not evidence
about the large one.

---

## 4. What was wired

| site | change |
| --- | --- |
| `src/util/ncdfWitness.js` | **new.** The encoder and the guard. Imports `black76`, `probAbove`, `round` from the engine — lifted, not restated. |
| `src/util/snark.js` | the fifth builder, `buildNcdfInBackground`, and `ncdf` in `VK_FILES`. |
| `src/util/proverWorker.mjs` | `ncdf` in the lazy circuit table. |
| `src/services.js` | `event-vol` handler: `snark: true` → snark block + background build. |
| `src/mcp.js` | `event_vol` handler: **the same edit, in the same commit** — this array has been the forgotten site four times. |
| `gates/preflight.mjs` | grid exemption by name, exemption-rot check, proof-emitting set, ncdf artifact presence. |
| `assets/zk/` | the four artifacts above. |
| `zk/scripts/gateB7-6-eventvol-straddle.mjs` | **new.** Seven sections. |
| `zk/scripts/revert-eventvol-straddle.mjs` | **new.** Four mutations, each one turning the gate red. |

`src/engine/` was **not touched**: the whole directory is byte-identical to the mirror, and the build
hash is still `q1-e1fa99d08887d6cc`, which is what the live service publishes.

### The five equalities that pin the reconstruction

`asDecimalIv` and the days-or-years horizon selection are local to `src/engine/eventVol.js` and not
exported, and the engine must not be touched to export them — so the encoder restates those two lines.
A restated engine expression is the defect class that has drawn blood three times here, so it is not
trusted: the reconstruction is required to reproduce **five** published fields, each a different
function of `(S, σ, T)`, as **equalities** rather than tolerances.

```
atmIvPct                                round(σ·100, 2)
horizonDays                             round(T·365, 2)
expectedMove.oneSigmaPct                round(σ√T·100, 3)
expectedMove.oneSigmaUsd                round(S·σ√T, 2)
expectedMove.straddleImpliedAbsMoveUsd  round(C + P, 2)
```

A reconstruction that misread percent-for-decimal or days-for-years fails all five. The sweep in
section 4 of the gate puts 20,000 served answers through them.

---

## 5. The gate, and the proof it can fail

`node zk/scripts/gateB7-6-eventvol-straddle.mjs` — **PASSED**.

1. the service's copies of `S`, `TOLC`, `TOLP`, `ZSPLIT` equal the values parsed out of
   `circuits/ncdf.circom` (they live in two files; nothing else compares them)
2. all four artifacts byte-identical between `zk/build` and `assets/zk` — *the service proves against
   what this gate gates*
3. the single-point claim, with the two-point correction measured
4. the guard against the **served handler**, both surfaces, the pinned hash, and the ceiling
5. a real proof on the worst served leg, plus **the proof a served response actually points at**,
   fetched from the store the handler wrote to and verified
6. wrong-CDF refusal rates, measured on this service's slice
7. the exported Solidity verifier in an in-process EVM

Measured 30 July, **twice, on the rebuilt two-sided key**: **3,812 Plonk constraints**, domain 4096,
7 public signals — identical on both runs. Proving wall-clock 2,961 ms and 1,950 ms, which is scheduling
noise on a contended box and not a property of the circuit. Accept gas **273,920** and **275,584**; that
is a 1,664-gas, **0.6075%** spread between two runs of the same verifier on the same proof shape, inside
the 1.22% (~3,500 gas) spread `probe-plonk-gas-variance` measured — so both are quoted and neither is
"the" figure. Refusal gas was **573** on both runs. Every one of the 7 public signals is refused when
moved by one, and a bent proof point is refused at 573 gas. `PlonkVerifier` deploys to 7,080 bytes under
solc 0.8.26.

The constraint count moved 3,740 → 3,812 in the two-sided rebuild, which is why the earlier figure in
this file was wrong rather than merely old: 3,740 is the count for a circuit whose CDF bound held on one
side only.

`node zk/scripts/revert-eventvol-straddle.mjs` — **PASSED, 4 of 4 mutations turn the gate red**:

| mutation | check that goes red |
| --- | --- |
| service's `TOLC` 12 → 11 | the service's TOLC is the circuit's TOLC |
| a different circuit's vk at `assets/zk/ncdf_vk.json` | every artifact the service proves against is the one this gate gates |
| delete the display ceiling | the display ceiling fires, at the spot the derivation predicts |
| reconstruct from the engine's unrounded `N` instead of the gridded `n̂` | **the encoding bound is REACHED**, not merely respected |

The fourth is the grid-snapping failure in its own shape: skipping the 2^-40 grid agrees with the
engine to 1e-16 and certifies an identity about a number the circuit was never handed. Nothing
notices except the reached-bound assertion, which is why that assertion exists.

---

## 6. What a buyer must still trust

- **That `x` is `σ√T/2` for the σ and T they sent.** Public, checkable by squaring, not in the proof.
- **That the vol and spot were read from a real book.** They are inputs. No circuit can attest where a
  number came from; that is the input-attestation problem, and it is not this circuit's.
- **Five of the six published fields.** `probabilityMoveBeyond` needs the CDF at two *further* points
  per threshold — six for the three defaults — and has no proof. `oneSigmaUsd`, `oneSigmaPct` and
  `rangeOneSigma` have no transcendental in them and no circuit either. `eventIsolation` is a variance
  difference and a root. `checks[0]` is a quadrature agreement claim.
- **That the display rounding is the last word.** The proof pins the straddle to ±2.663e-6 on a
  $60,000 spot; the field is published to two decimals, 1,878x coarser. The record now publishes
  `straddleFromProofUsd` at full precision so a reader can tell a 1e-6 proof from a 1e-3 one.

## 7. Regression surface, re-run 30 July

`npm test` **386**, 0 fail (381 pass, 5 skipped) — the same count before and after every edit here.
`node tools/docs-consistency.mjs` **CONSISTENT**. The corpus size is deliberately not quoted here: it
read 252 documents at the start of this session and 253 at the end, because concurrent sessions are
adding pages — a count in a report is a number that rots between two runs four seconds apart, which is
the same failure as §8's gas row.
`node --test gates/gateIF-inflight-eviction.mjs` 5 pass, 0 fail.
`node gates/gateIF-revert.mjs` **PASSED, 2 of 2 reverts red**.
`node zk/scripts/gateB7-6-eventvol-straddle.mjs` **PASSED**.
`node zk/scripts/revert-eventvol-straddle.mjs` **PASSED, 4 of 4**.
The pinned event-vol contentHash `8d653115a9c4e8752725a63288b283c5c10c25be2ee63b92b0e48f82ba09fd8a`
is unmoved, `src/engine/` is byte-identical to the mirror, and the build hash is still
`q1-e1fa99d08887d6cc`, read out of `buildId()` rather than quoted.

`node gates/preflight.mjs` **PASSED** in the dev tree, with the proof-emitting set now **14** entries:
`{http,mcp} × {perp-gate, size-gate, treasury-risk, exec-verify, event-vol, lp-risk, options-risk}`.

That verdict changed under this session and the reason is worth recording, because a report that quoted
either half without the other would be wrong. **When first measured, preflight was RED** on exactly two
checks, and they named `http:options-risk` and `mcp:options_risk` and nothing else:

```
[*** FAIL ***] every handler that builds a zk proof snaps its inputs onto that grid first
               http:options-risk, mcp:options_risk
[*** FAIL ***] the proof-emitting set is the one that has been checked
```

A concurrent session was mid-wiring on options-risk — `src/util/optionsRiskNcdfWitness.js` exists in the
dev tree and in no commit, `src/services.js` and `src/mcp.js` differed from the mirror, and
`gates/preflight.mjs` did not yet. That session then updated `gates/preflight.mjs` in the dev tree,
deciding options-risk's grid on purpose and adding it to `OTHER_GRID` and the pinned array, which is what
the check exists to force. So the red was real, was never event-vol's, and is now resolved by the session
that owned it. event-vol's own grid exemption was in the **passing** half of that check throughout.

Two consequences a reader should not have to infer. `gates/preflight.mjs` is still **uncommitted** in the
dev tree, so a clone at `HEAD` sees the 12-entry pin and a services.js that emits 14 — it will go red
until that session commits, and this commit deliberately does not carry their file. And the green above is
a measurement of the dev tree, which contains their uncommitted work: **it is not a statement that `HEAD`
is deployable.**

---

## 8. What was stale, and what a re-measurement is for

`ncdf.circom` was rebuilt on 30 July because its CDF bound held on one side only. That rebuild changed
the key, the constraint count, the artifact bytes and — the part that propagated furthest — the
**denominator** of every headroom figure, because it made explicit that the enforced band is `TOLC/2`
and not `TOLC`. It did not touch this page, `src/util/ncdfWitness.js`, or the encoder's published
`proves` text. So the following was wrong here until now, and every entry was found by measuring again
rather than by reading a diff:

| what it said | what it is | direction of the error |
| --- | --- | --- |
| 3,740 Plonk constraints | **3,812** | described a one-sided circuit |
| 274,654 accept gas | **273,920 / 275,584** across two runs | one sample presented as a figure |
| 10,372,638 artifact bytes | **10,378,033** | pre-rebuild |
| collapse = 3.05e-3% of the envelope | **6.104e-3%** of the 6-ulp band | 2x optimistic |
| honest engine uses 20.71% / 21.15% | **41.42% / 42.30%** of the 6- and 5-ulp bands | 2x optimistic |
| `d2 === -d1` on 39.70% of legs (encoder header) | **39.81%** gate seed, **40.62%** another | a sampling statistic quoted as a constant |
| "12 ulp is what the circuit enforces" | 12 is the **circom constant**; the band is 6 | the trap in section 2 |

Two of those are the same 2x, and it is the one `gateB7-5` corrected for its own domain and never
carried across. None of them made a served number wrong: the two headroom rows understate how much of
the circuit the honest engine uses, and the `TOLC` row makes the published envelope wider than it needs
to be. Both errors point at "the proof is looser than claimed", which is the safe direction — and being
in the safe direction is not the same as being measured.

**The published `proves` and `note` strings still say "pinned to within 12 ulp of 2^-40 (1.09e-11)" and
"the density to 10 ulp".** Both sentences are **true** — a buyer's real envelope is 8.3095 ulp on the
CDF and 7.0510 on the density — and both are **loose**. They were left alone rather than corrected,
because tightening a published claim is a caller-visible text change with a changelog and a docs gate
behind it, and the honest decomposition belongs to whoever makes that change deliberately. Recorded here
so it is a known looseness rather than a later discovery.

---

## 9. The re-measurement found a defect in the proof store, and it had turned gate B7-6 red

Gate B7-6 was **failing** before any edit on this page, on two checks in section 5:

```
[*** FAIL ***] the proof a served response points at verifies against the published key
               /proof/8d653115... -> status unavailable
[*** FAIL ***] the record published beside it names the reconstruction a buyer performs
```

The circuit, the identity and the guard were all fine. `src/util/snark.js` was not.

**The mechanism, reproduced rather than reasoned about.** `/proof/<hash>` is answered out of a
200-entry `Map`. All six builders open with the same guard against proving one content hash twice:

```js
if (store.has(contentHash) || claimed.has(contentHash)) return;
```

`claimed` is released when the build is **enqueued**, not when it settles. So between enqueue and
`ready`, the `building` record in that Map is the *only* marker that the hash is in flight — and
eviction was insertion-order and took it like any other entry. Measured on the served handler: one
fixture call, then 20,200 further distinct-hash proof requests, then the **same** fixture again.

| step | observed |
| --- | --- |
| first call | `building`, hash `8d653115...` |
| after 20,200 further requests | `getProof(hash)` -> **undefined**; the in-flight marker is gone |
| the same request again | passes the guard, starts a **duplicate** build for a hash already in the prover |
| that duplicate | hits `MAX_QUEUED = 8`, writes `unavailable: prover busy` **over** it |
| the poller | stops on any status that is not `building`, so it reports `unavailable` |
| the same request on a quiet process | `ready` in ~3 s, `straddleFromProofUsd 3645.45397918846` |

It is not a gate artifact. It is what a public endpoint does under any burst wider than its cache: the
request that answers `ready` on a quiet process answers `unavailable` on a busy one, and that answer is
**wrong** rather than merely slow — the proof was being built the whole time.

**The fix** is two lines in `put()`: skip `building` records when choosing what to evict, and do not
evict at all when overwriting a key that is already present. At most `MAX_QUEUED` records can be
`building` at once, because that status is only written after the queue admits the build, so the skip can
never empty the search — and there is a fallback anyway, because a guard that assumes its own invariant
is a guard that cannot fail.

**`gates/gateIF-inflight-eviction.mjs`** is the reproduction, and every check in it drives the real
handler and reads the real store. No check reads source: a textual probe for `observationEnvelope` in
this repository once reported 22 of 22 services and was wrong, because the call it was looking for sat in
a nested helper. It asserts the eviction **pressure** as its own floor before asserting that the marker
survived, so that "never evict anything" — which turns a bounded cache on a public endpoint into a
memory-exhaustion primitive — cannot pass it. `gates/gateIF-revert.mjs` puts both halves back and
requires the gate to name each one:

| revert | goes red | stays green |
| --- | --- | --- |
| insertion-order eviction, back | the in-flight marker survived the flood (plus 2 downstream) | the eviction-pressure floor |
| nothing is ever evicted | the eviction-pressure floor | the in-flight marker check |

Each revert leaves the *other* assertion green, which is what makes the pair non-redundant rather than
two names for one check. With the fix in place gate B7-6 is **PASSED**.

**What is NOT fixed, and it is adjacent.** A record that legitimately reaches `unavailable` — queue
full, or the encoder's own refusal — is then memoised: `store.has(contentHash)` short-circuits every
later request for the same body until the entry is evicted. `src/util/proofStore.js` deliberately
refuses to *persist* `unavailable`, on the stated grounds that "a refusal is a judgement made by one
build of the code... Cheap to redo" — so the in-memory memoisation contradicts the durable store's own
intent. It affects all six builders equally, it is not what turned gate B7-6 red, and it is left alone
here rather than folded into a change about event-vol.

---

## 10. What this page does not establish

- **The claim was true and the work was already done.** The task that produced sections 8 to 10 was
  asked to find out whether event-vol needed a circuit built. It does not: the route was wired on
  30 July, on both surfaces, and the `N(x)` claim holds exactly as stated. What was left was that the
  numbers describing it had gone stale under a circuit rebuild, and that the gate proving it was red for
  a reason that had nothing to do with the circuit.
- **The second honest statement is still not built, and section 1.4's reasoning stands.**
  `eventIsolation.eventMove1SigmaUsd = S*sqrt(sigA^2*TA - sigB^2*TB)` is reachable — a square root is
  provable by squaring — but only by a *new* circuit, a new ceremony and a new verifier, which is the
  opposite of what made the straddle worth wiring. And `checks[0]` remains a 501-point quadrature
  agreeing with a closed form: an agreement claim between two computations, not an identity over the
  inputs. (The brief that prompted this re-measurement attached that quadrature to the event isolation.
  It is attached to the **straddle**. The event isolation carries only a non-negativity test on
  `sigA^2*TA - sigB^2*TB`, and discloses an inverted term structure instead of fabricating a move.)
- **The evaluator term is quoted from `gateB7-5`, over the whole computed branch.** 2.1100 ulp was
  measured over `z` in `[0, 7.0711)` at 400,001 points. event-vol's `x` never exceeds 1.56071, so using
  it here is an upper bound and therefore conservative — but it is *not* a measurement on this service's
  slice, and a tighter buyer envelope would want one.
- **Nothing was deployed.** No `railway up`. The four artifacts in `assets/zk` are byte-identical to
  `zk/build`, which is the only thing that makes the gate's verdict a statement about what the service
  would actually serve.
