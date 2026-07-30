# Wiring options-risk to ncdf — and the reason nothing was wired

**30 July 2026.** The task was to establish what `zk/circuits/ncdf.circom` proves, how tightly, in
price terms, and then to wire what is defensible.

The answer to the first question changed the answer to the second. **The circuit's CDF bound held on
one side only.** A prover could drive the upper tail arbitrarily far below the truth, and while that
was true, `event-vol` was already serving proofs against it — wired by a parallel session earlier the
same day. So this session's work is the fix, the check that would have caught it, the envelope
measured properly, and a wiring specification for options-risk with every number pre-measured.

Nothing is deployed. `src/engine/` is untouched and the published codeHash has not moved.

---

## 0. REQUIRED FOLLOW-UP, for whoever holds event-vol

Three items. The first is done; the other two are corrections to files another session was editing
while this one ran, and were deliberately **not** made here rather than risk a conflict in a file
mid-flight.

1. **DONE — the corrected proving key is in place.** `assets/zk/ncdf_plonk.zkey`, `ncdf_vk.json` and
   `ncdf_js/ncdf.wasm` in both trees are now the rebuilt two-sided circuit, byte-identical to
   `zk/build/`. Without this the `proves` string on every event-vol response is false. `npm test`
   (386, 0 fail), `gateB7-6` (60 checks), `docs-consistency` (248 documents) and `preflight` are all
   green against the new key.
2. **`src/util/ncdfWitness.js:193` — `envelopeUsd` uses `TOLC` = 12 as the envelope on N.** It is
   *conservative*, not wrong: the measured envelope is 8.3095 ulp, so 12 covers it. But 12 covers it by
   accident. The derivation is `TOLC/2 + evaluator + ½·φ_max`, and that file has the `½·φ_max` term and
   not the other two. If anybody ever tightens `TOLC` toward the band it names, the guard silently
   becomes wrong. Replace the single `TOLC` with the three named terms.
3. **`gateB7-6` reports headroom against `TOLC`, not against the band.** "CDF residual uses 20.71% of
   12 ulp" is 41.4% of the 6 ulp actually enforced. Same 2× understatement `gateB7-5` carried, in the
   reassuring direction, and it is now fixed there and not here.

---

## 1. The defect

`ncdf.circom` bounds the CDF with

```
resid   = cHat*dHat - eHat*bHat
tolC    = TOLC * dHat
cShift  = 2 * resid + tolC
cOk     = LessEqThan(NB_R)(cShift, 2 * tolC) === 1
```

Every sibling circuit — `liquidation`, `kelly`, `concentration`, `execadverse`, `constantproduct`,
`divergence`, `greeksfp`, `greekssigned`, `parity`, `portfolioleg`, `lpbracket`, `lpclosed` — puts a
`Num2Bits` on the shifted residual before the comparison. `ncdf` was the **only one** that did not,
and its generated header argued for the omission:

> NO separate Num2Bits on cShift. LessEqThan(n) already decomposes in[0] + 2^n - in[1] into n+1 bits,
> so a cShift that is out of range — including a field-wrapped negative one — makes that decomposition
> unsatisfiable and the prover cannot produce a witness at all.

That is wrong. `LessThan(n)` decomposes `in[0] + 2^n - in[1]`. For a field-negative `in[0] = p - v` the
two wraps **cancel mod p**, and the comparator sees the ordinary number `2^n - v - in[1]`, whose bit
`n` is clear, so `out = 1` and the comparison **passes**. The bound therefore held only for
`resid > 0`: the upper tail `c` could be made arbitrarily *smaller* than the truth, which for `x > 0`
means `N(x)` arbitrarily close to 1.

`gateB7-5` §0 demonstrates it rather than describing it. The pre-fix circuit is preserved verbatim at
`zk/circuits/adv/ncdfonesided.circom` and its constraint system is shown **satisfied**:

| | |
|---|---|
| leg | F = K = 100,000, T = 0.25, σ = 0.60, r = 0, call |
| true delta | 0.5596176924 |
| delta the pre-fix constraint system accepts | **1.0** |
| price the engine served | 11,923.54 |
| price a proof under the old key certified | **55,961.77 — 369.3% high** |

Witness satisfaction is the statement, not a proof that verifies: a Plonk proof over a satisfied
witness verifies by soundness of the scheme, and §4 exercises that on the honest case.

### Why six gate sections and a full EVM rehearsal did not find it

`proveVerifyRefuse` perturbs the **public signals of a finished proof** and requires the verifier to
reject. It always will — the proof was made for other signals. That tests the SNARK's soundness, not
the constraint system's. Nothing in the gate ever **re-proved from a wrong witness**, and the
wrong-CDF section only put to the prover the cases its own arithmetic said were *under* the bound. The
free side was never asked. `gateB7-5` now walks the witness generator out to 4× the band in both
directions and requires the accepted interval to be closed at both ends — a one-sided bound has no far
edge, so this check cannot be green while that is true. `zk/scripts/revert-ncdf-twosided.mjs` runs the
assertion against the preserved one-sided circuit and requires it to go red.

### What was live

`event-vol` publishes `expectedMove.straddleImpliedAbsMoveUsd = 2·S·(2·N(σ√T/2) − 1)`, which is affine
and **increasing** in N with `dStraddle/dN = 4S`. The free direction of the broken bound is therefore
exactly the direction that inflates the published expected move, and the ceiling is `N = 1`, i.e. a
straddle of twice the spot. `zk/scripts/probe-ncdf-onesided-exposure.mjs` measures it against the
service's own witness encoder:

| spot / iv / horizon | served | one-sided key admits | rebuilt key admits |
|---|---|---|---|
| 100,000 / 60% / 30d | 13,707.88 | nHat +5.12e11 ulp → **200,000.00 (1359.0% high)** | +6 ulp → 13,707.88 |
| 3,000 / 80% / 7d | 265.05 | nHat +5.25e11 ulp → **6,000.00 (2163.7% high)** | +6 ulp → 265.05 |
| 1.02 / 15% / 90d | 0.06 | nHat +5.33e11 ulp → **2.04 (3300.0% high)** | +5 ulp → 0.06 |

For scale, the response itself published `envelopeUsd = 4.4381e-6` on the first row. The one-sided key
admitted 4.2e10 times that.

## 2. The fix, and what it cost

`NB_R` and `NB_P` were sized to the widest *product* in the relation (~2^99), on the reasoning above.
They are now sized to the widest **accepted shift**, which is what the range check is about:

```
NB_R = bits(2 * TOLC * dHat_max)      101 -> 65
NB_P = bits(2 * TOLP * SQRT2PI)        84 -> 46
```

so adding the two `Num2Bits` and shrinking the two `LessEqThan` costs less than adding the `Num2Bits`
alone would have. Measured, not estimated:

| | before | after |
|---|---|---|
| Plonk constraints | 3,740 | **3,812** (+72) |
| domain | 4,096 | 4,096 — still fits `hez_final_12`, no new ceremony |
| public signals | 7 | 7 |
| prove | 1,654 ms | 1,425 / 1,555 ms (two runs) |
| EVM accept gas | 273,406 | 272,990 / 273,504 — **inside the measured 1.22% Plonk spread, so unchanged** |
| EVM refuse gas | 573 | 573 |

## 3. What it proves, and how tight

### The band in force is half the tolerance constant

`2*resid + tol <= 2*tol` bounds `|resid| <= tol/2`. So the enforced band is **6 ulp** on the CDF and
**5 ulp** on the density, not 12 and 10. This was verified by walking the witness generator, not by
reading the algebra: the accepted `nHat` interval is 12 integers wide and closed at both ends.

Every headroom figure in `gateB7-5` was previously divided by `TOLC`, reporting **18.3%** where the
same measurement against the band in force is **36.6%** — a factor of two, in the reassuring direction.

### The envelope a buyer gets is not the band

`TOLC` bounds the distance from `nHat` to the circuit's *own* integer evaluation. A buyer's envelope is
the distance to the true normal CDF. Three terms, each measured in `gateB7-5` §7:

| term | N | φ |
|---|---|---|
| band in force (`TOL/2`) | 6 | 5 |
| the evaluator's own error, `eHat*bHat/dHat` vs an independent reference | **2.1100** (at z = 0.2213) | **1.9300** (at z = 0.4717) |
| half a grid step of x, times the Lipschitz constant | 0.1995 | 0.1210 |
| **envelope** | **8.3095 ulp = 7.5575e-12** | **7.0510 ulp = 6.4128e-12** |

The reference is neither Hart nor Abramowitz–Stegun — Maclaurin `erf` below 2, the classical `erfc`
continued fraction above it — and the gate checks the ruler before using it: the two branches agree to
9.02e-12 relative across the changeover. Hart-in-doubles sits 0.0008 ulp from the same reference
(measured the same way, not carried as a term because it does not reach the third significant figure).

The published `envelopeAbsoluteN` was `TOLC·u` = 1.0914e-11. That is *larger* than 7.5575e-12, so it
over-stated the envelope — safe direction. The headroom fraction was the unsafe one.

### The worst honest case uses 39.7% of the bound

Over 400,000 points spanning the whole computed branch, the worst honest residual is **2.3824 ulp**
against a 6-ulp band = **39.7%**; the density reaches **2.3286 of 5 = 46.6%**. A sweep of 6,000 real
engine legs reaches only 36.6% / 42.8%, because sampled legs do not reach `z → 0` where the residual is
worst. The domain sweep is the binding measurement and the leg sweep is not.

### The tail branch is tighter, not weaker

The circuit's own header calls the `z >= 7.0711` branch "a real weakening". For the **CDF** it is not:
`cHat <= 2 ulp` is asserted and the true tail is under 0.8452 ulp, so the gap is bounded by their sum,
**2.8452 ulp = 2.5877e-12** — about a third of the computed branch's envelope. It *is* a weakening for
the density: 8 ulp asserted against a true maximum of 6.092.

### In price terms — the number a buyer cares about

`price = df·(F·N(d1) − K·N(d2))`, so an envelope `epsN` on each N is `df·(F+K)·epsN` on the leg
premium, per contract:

| F | K | envelope | as bps of the forward |
|---|---|---|---|
| 1 | 1 | 1.511e-11 | 1.511e-7 |
| 3,000 | 3,000 | 4.534e-8 | 1.511e-7 |
| 100,000 | 100,000 | **1.511e-6** | 1.511e-7 |
| 100,000 | 70,000 | 1.285e-6 | 1.285e-7 |
| 100,000 | 200,000 | 2.267e-6 | 2.267e-7 |

**On a 100,000 forward at the money the circuit admits 1.5 micro-dollars per contract.**

Reported against the forward, not against the premium, and that choice is load-bearing. A deep
out-of-the-money premium is 1e-70, so a premium-relative ratio can be made to say almost anything: the
circuit's own header quotes A-S 7.1.26 as pricing a leg "19.4% wrong", and the same sweep at a
different seed reports 18,526%. Both are true and neither is about money.

### What it refuses, in the same unit

A-S 7.1.26 misprices by **2.754e-3 bps of the forward** worst and 7.925e-4 mean over 6,000 legs — about
**2.8 cents on a 100,000 contract**. Against 1.511e-7 bps admitted, that is a ratio of **1.82e4**. On
the CDF error directly: A-S carries up to 7.5e-8 by construction against an admitted 7.5575e-12, a
ratio of **9.92e3**. Four orders of magnitude is the honest margin. It is smaller and truer than "19.4%
wrong", and it is still the whole reason the circuit exists — the consistency identities
(`greeksfp`, `greekssigned`, `parity`) are satisfied to 3.3e-14 by A-S and are blind to all of it.

An earlier draft of that assertion used a threshold of `1e6` written down before anything was measured,
and the gate failed on it. The threshold is now derived from the two CDF errors, which is where the
ratio comes from and where it is stable.

## 4. Why options-risk is still not wired, and exactly what it would take

`event-vol` was reachable with one proof because its straddle is struck **at the forward**: `K = F`
kills `ln(F/K)`, and at `r = 0` the ATM straddle collapses onto a single point of the CDF. Neither is
true for options-risk. This is the specification, with the numbers already measured so the next session
does not re-derive them.

**Two proofs per leg, at `d1` and `d2`.** The premium needs `N(d1)` *and* `N(d2)`; one instance cannot
carry it. With both, **every** published per-leg number is reconstructible from public signals plus
echoed inputs by elementary arithmetic, in the engine's own float order:

- `value = df·(F·n_A − K·n_B)·q` — the engine's exact expression with `ncdf(d1)`, `ncdf(d2)` replaced
  by the certified integers. For a **put** the engine writes `df·(K·ncdf(−d2) − F·ncdf(−d1))`, and
  `1 − (1 − c)` is not `c` in IEEE-754; the two complement roundings are worth ~2.2e-16 absolute =
  2.4e-4 ulp, four orders below the envelope, and belong in the bound as a term rather than a footnote.
- `delta = df·n_A·q` (call) / `df·(n_A − 1)·q` (put)
- `gamma = df·p_A/(F·σ·√T)·q`, `vega = df·F·p_A·√T/100·q`,
  `vanna = −df·p_A·x_B/σ·0.01·q`, `volga = vega·x_A·x_B/σ·0.01·q`,
  `theta = ((−df·F·p_A·σ)/(2√T) + r·price)/365·q`

All six greeks are functions of `N(d1)`, `φ(d1)`, `d1`, `d2` — and `d1`, `d2` are the public `xMag`/
`xSign` signals. The density pins `|x|`; the CDF pins the side; and the **signed** spacing
`x_A − x_B = σ√T`, checked off-circuit, closes the one hole the tail branch leaves — above the split
`xSign` is unconstrained, so a leg with both points on the tail could otherwise have its side flipped,
and a flip of either point or both breaks the signed spacing.

**The residue is the logarithm, and only the logarithm.** `d1 = [ln(F/K) + ½σ²T]/(σ√T)` is not proven.
A service using a wrong `ln` gets a wrong `d1` and every published number consistently wrong with it,
and nothing in this scheme catches it. That is a strictly smaller residue than `{exp, CDF, log}` — it
is one instance of the same exp gadget run backwards (`L` is `ln(F/K)` iff `K·exp(L) = F`) and is not a
new research problem — but it is the honest `doesNotProve` and it must be stated in those words.

**Cost and the leg ceiling.** ~1.5 s per proof, so 2 per leg. `MAX_QUEUED = 8` in `src/util/snark.js`
is global, so a 4-leg book consumes the entire prover queue for ~12 s and a 5-leg book cannot be served
whole. The honest shape is to check capacity **once for the book** and refuse above 4 legs with a named
reason — a half-proved book is worse than a named refusal, and `gateB7-5` §5's own finding is that a
wrong CDF's per-leg miss probability compounds only if *every* leg is proved.

**Storage needs no route change.** The proof store is keyed by a 64-hex contentHash and
`/proof/:contentHash` validates `/^[0-9a-f]{64}$/`. Derive each leg's key as
`sha256(contentHash + '|options-risk-ncdf|leg<i>|<d1|d2>')` — still 64 hex, still a single-proof record,
no change to the route, `sdk/index.js`, `proofStore.js` or `gateV`'s recipe. Publish the preimage recipe
so the derivation is reproducible rather than opaque.

**No grid snapping, and that is the decision.** `ncdf`'s public signals are `(x, N(x), φ(x))` at 2^-40,
not caller fields; the buyer's off-circuit checks consume `F, K, σ, T, q, r`, which are echoed exactly
as the engine received them. Snapping would move a contentHash for every off-grid caller and buy
nothing — the same argument `size-gate` makes for `bankroll` and `event-vol` for `spot`.

### proves / doesNotProve, as they would have to read

**proves.** For the two public points `x_A`, `x_B` of each leg, that `n_A`, `n_B` are the standard
normal CDF and `p_A` the density at those points, **evaluated inside the circuit** by Hart (1968) —
every multiply carrying a range-checked remainder, so the prover cannot choose a rounding — within
8.3095 ulp of 2^-40 (7.5575e-12) on the CDF and 7.0510 ulp (6.4128e-12) on the density. On a 100,000
forward at the money that is 1.5e-6 quote units of premium per contract. Because `x_A`, `x_B`, `n_A`,
`n_B` and `p_A` are all public signals, every greek and the premium of that leg are reproducible from
the proof and the echoed request by elementary arithmetic, offline, against `/proof/vk/ncdf`.

**doesNotProve.** That `x_A` is `d1` for the forward and strike you sent. `ln(F/K)` is not in this
circuit, so a service computing the logarithm wrongly produces a wrong `d1`, wrong greeks and a wrong
premium that are all consistent with each other and with this proof. It does not prove the vol or the
forward were real — they are inputs, and no circuit can attest where a number came from. It does not
prove the SPAN margin: `spanMargin.requirement` is a minimum over a 122×3 repricing grid, which is an
optimisation over evaluations and not an identity over the inputs. It does not prove the six
finite-difference self-checks, which are agreement claims between two computations. And the signed
spacing `x_A − x_B = σ√T` is a check **you** must run on the public signals — the circuit does not
carry it, and without it a leg with both points above `z = 7.0711` can have its side flipped.

## 5. What was run

| | |
|---|---|
| `zk/scripts/gateB7-5-ncdf.mjs` | **PASSED**, 53 checks, exit 0 |
| `zk/scripts/revert-ncdf-twosided.mjs` | **PASSED** — §0's assertion is red against the one-sided circuit, green against the shipped one |
| `zk/scripts/probe-ncdf-onesided-exposure.mjs` | 3 cases, reproducible |
| `zk/scripts/gateB7-6-eventvol-straddle.mjs` | **PASSED**, 60 checks, against the rebuilt key |
| `npm test` | **386 tests, 0 fail, 5 skipped** — unchanged |
| `node tools/docs-consistency.mjs` | **CONSISTENT — 248 documents** |
| `node gates/preflight.mjs` | **PASSED — safe to deploy** |

`src/engine/` is byte-identical: the engine codeHash `q1-e1fa99d08887d6cc` has not moved, and no
service response shape changed, so no contentHash moved and Appendix C still reproduces.
