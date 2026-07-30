# options-risk is wired — the greeks block, off one instance of the circuit that already existed

**30 July 2026.** Companion to `WIRE_OPTIONS_RISK.md` (mirror: `Quiver/docs/wire-options-risk.md`),
which is subtitled *and the reason nothing was wired*. **This is a separate file on purpose.** That
document is another session's committed work — it fixed the one-sided CDF bound, measured the envelope,
and left a wiring specification. Overwriting it to announce a different scope would have destroyed the
record of why the scope changed. §9 below is the honest comparison between the two.

Everything on this host said options-risk could not be wired. `ncdf.circom`'s own header said it,
`src/util/ncdfWitness.js` said it in a section titled *why this service reaches a circuit and
options-risk does not*, and `gates/preflight.mjs` said it **inside a check**.

All of those statements are true and none of them was the whole question, because every one of them was
asked **about the price**. options-risk's headline is not the price. It is the `greeks` block, and that
block needs one CDF point, not two.

`npm test` **386** (381 pass, 5 skipped — unmoved). `src/engine/` untouched; codeHash still
`q1-e1fa99d08887d6cc`. Appendix C still reproduces at `8575ce5a…`. Nothing deployed.

---

## 1. What was already there, measured rather than inherited

The brief said `ncdf` served nothing. That was true two days ago and is not true now: **`ncdf` is already
wired to `event-vol`**, and reading `gates/preflight.mjs` rather than trusting a summary is what
established it. The live proof-emitting set was **six** services on both surfaces, not the four the brief
carried:

```
http:perp-gate  http:size-gate  http:treasury-risk  http:exec-verify  http:event-vol  http:lp-risk
```

So the question was never "can this circuit serve anything" — it was "can it serve **options-risk**",
which is harder, because `event-vol` reaches it through a collapse options-risk does not have.

---

## 2. The residue is real, and it is the crux

The brief's framing holds up under measurement. `greeksfp`, `greekssigned` and `parity` prove
**consistency identities** in which the shared `df·φ(d1)` factor cancels between any two greeks, so the
transcendental is dodged rather than solved. Re-measured on options-risk's own domain rather than
carried over:

> A service running **Abramowitz-Stegun 7.1.26** instead of Hart satisfies every one of those identities
> and is wrong about the level by up to **7.66e+4 ulp** of 2^-40 — **12,800×** the band this circuit
> enforces.

`parity`'s blindness is structural, not incidental: `C − P = df(F − K)` holds for **any** `N` with
`N(−x) = 1 − N(x)`, and the engine's `x <= 0 ? c : 1 - c` has exactly that symmetry. The identity cannot
see a wrong CDF even in principle.

`ncdf` closes that. The rest of this document is how tightly, and in what units.

---

## 3. THE COLLAPSE — why one point pins six fields

Read `src/engine/black76.js` at `r = 0`, so `df = 1`. Every one of the six greeks is a **rational**
function of exactly two transcendentals, and both are taken at the **same point** `d1`:

| greek | expression | depends on |
|---|---|---|
| `delta` | `N(d1)`, or `N(d1) − 1` for a put | **the CDF** |
| `gamma` | `φ(d1)/(F·σ·√T)` | the density |
| `vega`  | `F·φ(d1)·√T/100` | the density |
| `vanna` | `−φ(d1)·d2/σ · 0.01` | the density |
| `volga` | `vega·d1·d2/σ · 0.01` | the density |
| `theta` | `−F·φ(d1)·σ/(2√T) / 365` | the density |

`theta` is on that list **only because `r = 0`**. At `r ≠ 0` it regains an `r·price` term, and `price`
needs `N(d2)` — a second point. That is not a footnote; §7 measures it at 4.3e+8× the envelope.

`ncdf.circom` publishes `(x, N(x), φ(x))` and pins **both** values — the CDF to `TOLC/2 = 6` ulp and the
density to `TOLP/2 = 5`. So **one instance of the circuit that already existed pins the whole `greeks`
block: six published fields, where `event-vol` got one.** No new circuit, no new ceremony, no new
verifier, no new grid decision.

### What one point cannot reach

- **`portfolioValue`** is `df·(F·N(d1) − K·N(d2))`. `N(d2)` is a second point, and once `K ≠ F`
  **nothing collapses the two** — `N(d2) = 1 − N(d1)` is precisely what `event-vol`'s at-the-forward
  straddle has and this does not. **Not proven.**
- **`spanMargin`** is the worst of 366 repricings (122 price steps × 3 vol shifts), each two CDF points
  per leg: 732 further transcendentals, a search rather than a formula. **Not proven.**
- **the six finite-difference `checks`** are agreement claims between two computations, not identities
  over the inputs. **Not proven.**

---

## 4. THE ENVELOPE — derived here, and in price terms

### The derivation

The circuit constrains `2·resid + tol <= 2·tol`, so the band in force is **half** the tolerance constant.

| term | on N | on φ | where it comes from |
|---|---|---|---|
| band + evaluator | 12 ulp | 10 ulp | `TOLC` / `TOLP`, used **whole** — see below |
| x grid, half a step | 0.19947 | 0.12099 | `N` is Lipschitz with constant `max φ = 1/√(2π)`; `φ` with `max|x|φ(x) = φ(1)` |
| **total** | **12.19947 ulp** | **10.12099 ulp** | |
| **absolute** | **1.1095e-11** | **9.2050e-12** | at `ulp = 2^-40 = 9.0949e-13` |

`TOLC` is used whole where the band is `TOLC/2`, and the gap covers the fixed-point evaluator's own error
against real Hart. That error cannot be measured inside the service without a third copy of the 192-entry
exponential table, so it is **covered rather than counted** — admissible only while
`TOLC ≥ TOLC/2 + evaluator`. `wire-options-risk.md §0` item 2 flagged exactly this shape in
`ncdfWitness.js` and called it *conservative by accident*. **gateB7-7 §2 removes the accident**: it
asserts the inequality against gateB7-5's measured artifact, in both terms,

```
12 >= 6 + 2.1100   (evaluator on N, measured over 2e6 points by gateB7-5)
10 >= 5 + 1.9300   (evaluator on the density)
```

and it asserts dominance over gateB7-5's tight derivation — **1.468×** headroom on N, **1.435×** on the
density. If anybody tightens `TOLC` toward the band it names, that line goes red instead of the bound
going quietly wrong.

### IN PRICE TERMS — the number a buyer counts

A greek is not a price. The quantity a buyer holds capital against is the **dollar delta** — the
directional exposure the envelope can misstate — with `vega` and `theta` already in quote units.

**Per contract, at σ = 0.65 and T = 30/365:**

| forward | dollar-delta envelope | vega | theta |
|---|---|---|---|
| 1 | ±1.110e-11 | ±2.639e-14 | ±2.859e-14 |
| 3,000 | ±3.329e-8 | ±7.917e-11 | ±8.577e-11 |
| **100,000** | **±1.110e-6** | ±2.639e-9 | ±2.859e-9 |

**±1.11e-6 quote units of dollar delta on a 100,000 forward, per contract — 1.11e-7 bps of the
forward.**

Against what it refuses, in the **same** unit: A-S 7.1.26 misstates dollar delta by up to
**6.881e-3 quote units** on the same legs — **620,000×** the envelope.

Reported against the **forward** and never the premium, deliberately. gateB7-5 measured the same premium
denominator saying 19.4% at one seed and 18,526% at another: a deep out-of-the-money premium is 1e-70 and
a ratio to it is a number about nothing.

### Bound headroom

Two bounds, and they are different claims — the `encodingBound` the **server** may assert (half a 2^-40
step through an exact affine coefficient, plus nine float operations' slack) and the `envelope` a
**buyer** is entitled to (what the circuit promises). Over **19,719 legs of the real `optionsRisk`
engine**: 0 violations, and the worst honest case uses

| greek | fraction of the derived encoding bound |
|---|---|
| delta | 99.885% |
| gamma | 99.9965% |
| vega | 99.9965% |
| vanna | 99.9965% |
| volga | 99.9965% |
| theta | 99.9965% |

**A bound landing on itself rather than near itself.**

#### The first version of that measurement could not fail, and it is recorded rather than fixed quietly

It compared the reconstruction to the **served** (rounded) greek against a bound of
`envelope + half a display digit`, and reported **99.98% of bound used on all six**. Real, and
meaningless: the envelope on delta is 1.11e-11 against a display half-digit of 5e-7, so **99.998% of that
bound WAS the rounding** — a term every honest leg saturates and nothing violates. That is the
liquidation half-cent again: a guard whose width is set by a term that admits everything.

The fix is structural, not a tightening. The display digit is now handled where it belongs — by an
**equality** on the rounded value, a different test with a different failure mode — and the bound
compares against the engine's own **unrounded** greek.

---

## 5. THE RESIDUE — what a buyer must still trust, in its own units

**`x` is not pinned.** The circuit takes the point as given, and binding it needs
`x = [ln(F/K) + ½σ²T]/(σ√T)`. The honest form of what a reader must do is the **exponential**, not the
logarithm:

```
x is this leg's d1   ⟺   K · exp(σ√T·x − ½σ²T) = F
```

gateB7-7 §6 performs it on the served proof and lands at `100000.00000000685` against `F = 100000` —
relative **6.85e-14**. It is one libm call, and it is **not in the circuit**, though it is the same
`e^{−w}` gadget `ncdf.circom` already contains, run backwards.

**What the shape buys** is that the residue moves off the function implementations disagree about and
onto the one they do not: A-S and Hart differ by 7.5e-8 in `N`, which is **82,000 grid steps**, while
every libm `exp` agrees to under an ulp. A strictly smaller thing to trust — not zero.

**And the corollary, stated plainly rather than rounded away:** a wrong CDF that happens to be accurate
**at this point** is not detectable at this point, and a one-leg proof is one point. Measured, **103 of
19,730 legs (0.522%)** are points where A-S lands inside the 6-ulp band. The refusal rate is
**99.478%**, not 100%, and the response's own `doesNotProve` says so.

---

## 6. SCOPE — three conditions, each a piece of mathematics

Every condition is the reason some particular greek would otherwise be a claim about a quantity the
circuit does not carry. Each is refused **by name**, never silently.

| condition | why | refusal |
|---|---|---|
| **one leg** | an n-leg aggregate is a sum over n points, and the proof store holds one proof per content hash. A proof of leg 0 would leave the published aggregate unpinned while looking like it did not. | named, with the leg count |
| **r = 0** | at `r ≠ 0` theta regains `r·price` (needs `N(d2)`) and the other five gain `e^{−rT}`, itself a transcendental nothing here pins | named, with the rate |
| **\|d1\| < 7.0711** | above the split the circuit **bounds** the tail instead of evaluating it, and a bounded `N` cannot reconstruct a delta. It also leaves `xSign` unconstrained — the `cHat` relation is gated by `computed` — so a prover could flip the side. Refusing below the split closes both, and a buyer checks it directly: `publicSignals[0]` must be `1`. | named, with `d1` |

**98.60%** of legs are below the split (279 of 20,000 refused for it, measured). A **fourth** guard is the
per-greek **display ceiling**: where the envelope would be wider than the last digit a greek is displayed
to, the proof is refused rather than served as a statement about a neighbouring number. It is reachable —
`gamma`'s envelope is `EPS_P/(F·σ·√T)` against a 5e-9 half-digit — and gateB7-7 constructs a leg
(`F = K = 0.0004`, `σ = 0.16`, `T = 1/3650`) that trips it, because **a ceiling nothing reaches is a
ceiling nobody has tested**.

---

## 7. WHAT WAS RUN

`zk/scripts/gateB7-7-optionsrisk-greeks.mjs` — **44 checks, 0 failures**, 3,812 Plonk constraints, domain
4,096, 7 public signals, proved in 2,493 ms.

- **§0** the six-greek collapse holds at `r = 0` over four legs spanning 50 to 100,000 forward — **and
  breaks at `r ≠ 0`**, checked in both directions, because a scope condition nobody tested is really an
  assumption
- **§1** every constant the encoder carries is asserted against `circuits/ncdf.circom` **parsed from
  source**, not read from `build/ncdf-consts.json` (that file and the circuit come from one generator
  run, so agreeing with it proves nothing)
- **§2** the conservative envelope dominates gateB7-5's tight one, term by term
- **§3** the display-precision table reproduces the engine's own rounding
- **§4** 0 violations over 19,719 legs of the **real** engine; the bound is reached; the ceiling fires
- **§5** every scope refusal fires, plus a tampered greek and a moved leg descriptor
- **§6** a proof built by the **real served handler** verifies; all 7 perturbed signals refused; a bent
  proof refused; all six greeks reconstruct from the public signals **alone** and display as the figures
  served; the exponential binding performed
- **§7** the substitution attack on options-risk's own slice of the x-axis
- **§8** the exported verifier in an EVM: **274,238 gas** to accept, **573** to refuse (one sample — see
  `probe-plonk-gas-variance`; the measured Plonk spread is 1.22%, so a smaller marginal would be noise)
- **§9** both surfaces call the same builder

### The negative-x branch had never been exercised

`event-vol`'s `x` is always `σ√T/2 > 0`, so `xSign = 1` is a path nothing on this host had ever proved.
options-risk reaches it the moment `K > F`. The gate's served leg is deliberately one of those
(`F = 100,000`, `K = 105,000`, so `d1 = −0.1686`), and the published signals are

```
computed 1 · tailC 2 · tailP 8 · xSign 1 · xMag 185428839242 · nHat 476129582794 · pHat 432447972079
```

It verifies, on chain and off. Had the `cHat` quadratic been wrong on that side, nothing until now would
have noticed.

### The revert goes red — `zk/scripts/revert-optionsrisk-greeks.mjs`

Seven mutations, each a defect class this project has shipped a version of. Six turn a named check red.
**The seventh does not, and that is a finding rather than a failure.**

1. **Drop the substitution** (reconstruct from the engine's own density) → §4's "the bound is REACHED"
   catches it: worst falls from 99.9965% to **0.0675%** of bound. This is the verifier-that-cannot-fail
   in its purest form, and the reached-bound check is what sees it.
2. **Inject one grid step of error** → **23,614 of 23,628** comparisons violate. The bound sees a single
   2^-40 step, the finest error the encoding can express.
3. **Widen the envelope past the display digit** → the ceiling refuses. And a real leg trips it.
4. **Drop `r = 0`** → the discount-free theta is **1.233** away from the engine's against a 2.859e-9
   envelope: **4.3e+8×**. Certifying it would be a wrong number under a correct-looking proof.

**And the one that stays green.** Rearranging `vega` from the engine's `df*F*p*sqrtT/100` into
`(F/100)*p*sqrtT` — mathematically equal, a different double — was written expecting a red, on the theory
that this is the constantproduct defect class that has appeared three times here. It does **not** go red,
and the reason is structural rather than a slack bound:

> The constantproduct defect was large because that expression **cancels**. Every expression in the
> greeks block at `r = 0` is a pure product chain — the only subtraction anywhere is a put's `n − 1`,
> exact by Sterbenz for `n ≥ ½` and bounded absolutely by 2^-53 below it. With no cancellation there is
> no amplification, so a reassociation here can only move the last bit.

Measured: **1.81 double-ulps, which is 1.655e-4 of ONE 2^-40 grid step**, over 4,000 legs. So the honest
statement is not "the bound catches rearrangements" but "in this block a rearrangement cannot be large
enough to matter, and here is the number". The code comment was corrected to say that.

### Everything else, green

`npm test` **386** (381/5, unmoved) · `gates/preflight.mjs` PASSED, with the emitting set consciously
extended to **seven** services on both surfaces · `gates/gateV-recipe-reproduces.mjs` 9/9, Appendix C at
`8575ce5a…`, recipe strips `[snark]` and reproduces · `gates/gateM-mcp-surface.mjs` 17/17 ·
`tools/docs-consistency.mjs` 253 documents.

---

## 8. WHAT MOVED, AND WHAT DID NOT

**No content hash moved for a request that already works**, verified directly rather than inferred:

```
options-risk, no snark:   2f233f76…  before  →  2f233f76…  after   IDENTICAL
```

`snark: true` **does** move, from `c3624b37…` to `2f233f76…`, and it now collapses onto the no-snark
hash. That is intended and is every other proof-emitting handler's behaviour: `snark` is a transport
flag, not an input, so it is stripped before the envelope is taken. Nothing published carried the old
value — there is no pinned options-risk hash anywhere in the tree, and `gateV` confirms not one
deterministic hash moved. It is in the changelog because it is caller-visible.

**No grid snapping**, and that is the decision rather than the omission — `event-vol`'s exemption
argument, arriving a fourth time. `ncdf.circom` works at 2^-40, not the 1e-9 grid the first four circuits
encode over, and its public signals are not caller fields at all. `strike`, `iv` and `forward` **are**
caller fields here where `event-vol`'s were not, and they are still not snapped, because `x` is a
quotient of a logarithm that lands off any grid whether or not its ingredients are on one.
`gates/preflight.mjs` records the exemption by name and polices it in both directions.

**A sentence in `preflight.mjs` was wrong and is replaced rather than deleted.** It read *"options-risk's
d1 is not [σ√T/2], which is why options-risk still has no proof and is not on this list"* — true about
the price, false about the answer. The new entry says what changed and why.

---

## 9. THE HONEST COMPARISON WITH THE EARLIER SPEC

`wire-options-risk.md §4` specified a **more ambitious** scheme: two proofs per leg (at `d1` **and**
`d2`), up to 4 legs, with per-leg proof keys derived as
`sha256(contentHash + '|options-risk-ncdf|leg<i>|<d1|d2>')`. That scheme covers **`portfolioValue`** as
well as the greeks, and covers `theta` at `r ≠ 0`. It is the better end state and **this is not it.**

What was built instead is the subset that needs **no** new storage shape, **no** route change, **no**
queue-capacity rule and **no** second point: one proof, one leg, `r = 0`, the greeks block. The two
sessions agree on the mathematics — that document's own list of the six greeks as functions of
`N(d1), φ(d1), d1, d2` was derived independently and matches — and disagree only on scope.

The cost of the narrower choice, stated as a cost: **`portfolioValue` is not proven**, a multi-leg book
gets a named refusal rather than a proof, and so does `r ≠ 0`. The gain is that what ships is end-to-end
measured against the real engine and the real handler today, rather than specified. The two-point scheme
remains the next step and its specification is still valid.

---

## 10. WHAT A BUYER STILL HAS TO TRUST

Ranked by how much of the remaining risk each carries.

1. **That `x` is this leg's `d1`.** One exponential a reader performs. The largest residue, and the
   smallest it has been.
2. **That `σ` is a real implied vol.** It is an **input**. No circuit can attest where a number came from
   — that is input attestation's problem, not a circuit's, and it is the honest end of this road.
3. **That the 0.522% coincidence did not happen.** A wrong CDF accurate at this one point is invisible at
   this one point.
4. **`portfolioValue` and `spanMargin`.** Unproven, and named as unproven in the response itself.
5. **The Hermez reference string and `snarkjs`'s Plonk.** Shared with every other proof on this host.

---

*Artifacts: `zk/build/gateB7-7-optionsrisk-greeks.json` · `zk/scripts/gateB7-7-optionsrisk-greeks.mjs` ·
`zk/scripts/revert-optionsrisk-greeks.mjs` · `zk/scripts/probe-optionsrisk-ncdf.mjs` ·
`src/util/optionsRiskNcdfWitness.js`. No new circuit, no new zkey, no new verifier, nothing deployed.*
