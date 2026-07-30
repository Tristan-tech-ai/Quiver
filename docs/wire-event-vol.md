# event-vol: the claim, tested — and the one field it turned out to be true about

`event-vol` was the eighth deterministic service and the fourth of those eight with no circuit. A
claim had been made about it: that it *publishes a field which is a single `N(x)`, reachable by the
already-built `ncdf` circuit with zero new artifacts*. This is what happened when that was measured
instead of accepted.

**Verdict: the mathematical half of the claim is TRUE, with one correction that changes the guard.
The "zero new artifacts" half is FALSE.** The field is now wired on both surfaces, behind
`snark: true`, and `gateB7-6-eventvol-straddle.mjs` proves it end to end. Nothing is deployed.

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
| `d2 === -d1` in doubles | 15,923 of 40,000 = **39.81%** |
| worst \|\|d2\| − d1\| | 1.465e-3 ulp of 2^-40 |
| worst \|N(d1) − (1 − N(d2))\| | **3.662e-4 ulp** = 3.05e-3% of the circuit's 12-ulp envelope |
| max `x` reached | 1.56071 (the circuit's branch split is 7.07107) |

So the engine calls Hart four times, at two magnitudes. **One proof still carries the field** — the
collapse is 3.05e-3% of the envelope the circuit already promises — but it is charged **per leg**, from
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
| `ncdf_plonk.zkey` | 10,262,700 |
| `ncdf_js/ncdf.wasm` | 97,541 |
| `ncdf_js/witness_calculator.cjs` | 10,356 |
| `ncdf_vk.json` | 2,041 |
| **total added** | **10,372,638** |

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

| | |
| --- | --- |
| worst honest leg / `encodingBoundUsd` | **99.9915%** |
| worst honest leg / `envelopeUsd` | **4.0987%** |
| exceedances | 0 |
| legs refused | 0 |

The encoding bound is **reached**, not respected from a distance — which is what makes it a bound
rather than a number nobody measured. The buyer envelope is 24.4x wider and **the whole of the
difference is a promise `ncdf.circom` makes that this engine does not need**: the ratio is
`(12 + 0.5·φ_max)/0.5`. Tightening it means tightening `TOLC`, which is a property of the circuit, not
of this service. Reporting 4.1% as though it were slack I chose would be the dishonest version of that
sentence.

Confirmed separately over 200,000 legs across a deliberately wider box (spot 1–1.1266e8, vol 1–500%,
horizon 1h–1000d): worst use **99.9943%**, zero exceedances.

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

The honest engine, on this domain, uses **20.71%** of the circuit's 12-ulp CDF tolerance and **21.15%**
of its 10-ulp density tolerance over 20,000 legs — both exercised, neither exceeded.

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

Measured: **3,740 Plonk constraints**, domain 4096, 7 public signals, proved in 2,168 ms.
**274,654 gas** to accept, **573** to refuse — one sample; Plonk verify gas has a measured 1.22%
spread (~3,500 gas), so a smaller marginal than that is noise. Every one of the 7 public signals is
refused when moved by one, and a bent proof point is refused at 573 gas.

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

## 7. Regression surface

`npm test` **386**, 0 fail. `node tools/docs-consistency.mjs` consistent.
`node gates/preflight.mjs` PASSED, with the proof-emitting set now
`{http,mcp} × {perp-gate, size-gate, treasury-risk, exec-verify, event-vol}`.
`gateV-recipe-reproduces`, `gateP-sealed-provenance`, `gateL-elapsed-timing`,
`gateC-case-sensitivity`, `gateM-mcp-surface`, `gateR-misroute` all pass. The pinned event-vol
contentHash `8d653115a9c4e8752725a63288b283c5c10c25be2ee63b92b0e48f82ba09fd8a` is unmoved, and a
request that does not ask for a proof grows no `snark` key — the response shape for every existing
caller is byte-identical.
