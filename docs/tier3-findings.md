# Tier 3, re-examined: the stated reason for the block was wrong, and it is now unblocked

**28 July 2026. Research, repo-only. Nothing built here is served, deployed, or on chain, and nothing
touches `src/engine/`, so `q1-e1fa99d08887d6cc` does not move.**

The Phase B plan says this:

> `optionsRisk` imports `black76`, which uses `Math.exp`, `Math.log`, `Math.sqrt` and a normal-CDF
> approximation. Neither is arithmetic a Plonk circuit states cheaply. Leave both at T1.

The first sentence is true. The conclusion does not follow from it, and measuring showed why.

---

## What was wrong

That claim is about **computing** an option price. Proving one is a different question, and it is the
same question Kelly already answered a level down: `f = (p(b+1) − 1)/b` cannot be proven as written
because a circuit cannot divide, but `f·b = p·b + p − 1` is the identical statement with nothing to
divide.

The greeks all share the factor `df·nd1` — the discount times the normal density at `d1` — and that
factor **cancels between any two of them**. What is left is polynomial.

`zk/scripts/probe-black76-identities.mjs` derived eight such relations and measured each against the
real `black76` over 5,000 surfaces. Worst relative residual, per identity:

| | identity | worst rel |
|---|---|---|
| A | `d1 − d2 = σ·√T` | 1.3e-14 |
| B | `vega·100 = gamma·F²·σ·T` | 5.8e-16 |
| C | `volga·σ = vega·d1·d2·0.01` | 2.7e-16 |
| D | `vanna·F·(d1 − d2) = −vega·d2` | 4.8e-15 |
| E | `theta·365·2·T = −vega·100·σ + 2·T·r·price` | 4.0e-14 |
| F | `C − P = df·(F − K)` (put-call parity) | 4.0e-13 |
| G | `Δcall − Δput = df` | 1.3e-16 |
| H | gamma/vega/vanna/volga identical for call and put | exactly 0 |

**Eight of eight hold to double precision.** Not one requires `exp`, `log` or `erf`. So a substantial
part of Black-76 is provable with no transcendental at all, and the plan's stated reason for parking
Tier 3 was wrong.

---

## What is actually blocking it

The algebra survives. The **grid** does not.

`zk/circuits/greeks.circom` proves A and B: 1,103 R1CS, 2,152 Plonk, domain 4,096. It compiles and it
holds — on most surfaces. Then `gateB7-1-greeks-sweep.mjs` ran it against the real engine and the
worst relative residual on identity B was **0.61**, which is sixty percent and cannot be rounding.

Two causes, and the first was this work’s:

**A scaling error.** The identity needs `V·100·S⁴` on the left and the circuit had `S³`. The sweep reported a
relative residual of exactly **2.0**, which is the signature of one side being negligible against the
other — a factor-of-1e9 error, never rounding. Fixed, and worth recording as the shape to recognise:
a residual near 2.0 is a scale bug, a residual near 1.0 is a bound that is too tight.

**The real one: a 1e-9 grid cannot represent a small greek.** After the fix the residual is exactly
`1/G`, where `G` is gamma expressed in grid steps. The worst cases are gamma ≈ 5×10⁻¹⁰ — **one grid
step**. Measured trade-off:

| domain | surfaces kept | worst relative residual |
|---|---|---|
| gamma ≥ 1e-6 | 3,858 of 3,956 | 5.8e-4 |
| gamma ≥ 1e-4 | 2,277 | 2.9e-6 |
| gamma ≥ 1e-3 | 1,311 | 7.8e-7 |
| gamma ≥ 1e-2 | 382 | 7.0e-8 |

Deep out-of-the-money and long-dated options are exactly where gamma is tiny, and they are not
exotica: they are most of a real options book.

**The obvious fix is not sufficient, which is the part worth knowing.** Putting gamma alone on a
1e-18 grid keeps every surface but still leaves a worst residual of **0.22**, at gamma = 1.2e-12.
Vega has the same problem at the same strikes. Identity B relates two small numbers whose ratio
(`F²σT/100`) can exceed 1e8, so no single fixed-point scale carries both ends of it.

---

## The negative half is solved, BUILT, and proved

That last sentence is an argument against **one** scale, not against fixed point.

Give every quantity its own power-of-ten exponent, so each carries nine significant digits whatever
its magnitude, and align the exponents when the two sides are compared. `zk/circuits/greeksfp.circom`
does exactly that, and `gateB7-2` **passes**:

| | shared 1e-9 grid | per-value exponent |
|---|---|---|
| circuit | `greeks.circom` | `greeksfp.circom` |
| size | 2,152 Plonk, domain 4,096 | **1,919 Plonk, domain 2,048** |
| surfaces kept | 3,956 of 4,000, and only after excluding gamma under 1e-6 | **4,000 of 4,000, no exclusion** |
| smallest gamma proved | ~1e-6 before the residual eats the answer | **7.2e-75** |
| worst case uses | violates its own bound | **36.7% of an 8e-8 relative bound** |
| sweep | **FAILS** | **PASSES** |
| proof | — | verifies in 962 ms, refuses all 13 perturbed signals and a bent point |

**The fix is cheaper than the thing it replaces.** That was not the plan; it is what measuring the
alignment exponent turned up. gamma's own exponent ranges over [9, 55] across a real book, so a naive
bound would have reserved a selector of hundreds of entries. Measured, the alignment exponent dE lands
in **{30, 31, 32, 33, 34}** — five values — because the identity itself ties the exponents together.
A 31-entry selector covers it with room to spare, and the circuit came out smaller than the fixed-grid
one by dropping a whole doubling of the evaluation domain.

One more bound had to be set by measurement rather than derivation. The first attempt used a relative
2e-8, taken from a probe that reported a worst residual of 7.3e-9. The gate violated it at 146.9%: the
probe's mantissa rounding differed from the encoder that shipped, in the corner where rounding pushes
999999999.6 up to 1e9 and out of the normalisation window. **A bound belongs to the gate that enforces
it, never to the probe that suggested it.** Now 8e-8, with the worst case at 36.7%.

### What is still not proved

Nothing here evaluates N(d2), and that has not changed. Six of the eight measured identities are still
unbuilt — theta, vanna and the two parity relations all involve signed quantities, and a field has no
sign, so they need an offset encoding on top of this one. That is more of the same ordinary work, not
a new obstacle.

---

## Where that leaves Tier 3

Not "blocked on transcendentals", and no longer blocked on representation either, now that the
per-value encoding above is measured. What is left is bounded circuit work:

- it is arithmetic, not cryptography — no lookup arguments, no polynomial approximation of `erf`, no
  proven error bounds on a transcendental
- it is bounded work: per-quantity scales, or a normalised encoding that carries the greeks relative
  to their own magnitude rather than absolutely
- and it has a measurable target already: the sweep is the instrument, and the number to beat is a
  worst relative residual small enough that the bound is tight rather than generous

That is a much better position than the plan described. It is also **not done**, and this document
does not claim otherwise. `gateB7-1` currently fails, deliberately, and the failure is the finding.

## What none of this would ever prove

Nothing above evaluates `N(d2)`. A service with a subtly wrong normal CDF satisfies every one of the
eight identities and is still wrong about the absolute price level. Proving the greeks are mutually
consistent is worth real money — it catches a hand-coded greek that disagrees with its neighbours,
which is the likely error — but it is not proving the price.

Put-call parity (F) is the one that reaches the price, and only relatively: it ties a call to a put at
the same strike given the discount factor. The absolute level still rests on `N`, and it stays there
until `erf` is provable. **That part of the original claim was right.**

## Files

| | |
|---|---|
| `zk/scripts/probe-black76-identities.mjs` | derives eight identities, measures all eight against the engine |
| `zk/circuits/greeks.circom` | proves A and B; 1,103 R1CS / 2,152 Plonk / domain 4,096 |
| `zk/scripts/gateB7-1-greeks-sweep.mjs` | the shared-grid statement against the real engine; **fails, on purpose** |
| `zk/circuits/greeksfp.circom` | the same identity per-value; 1,065 R1CS / 1,919 Plonk / domain 2,048 |
| `zk/scripts/gateB7-2-greeksfp-sweep.mjs` | 4,000 surfaces plus a real proof and its refusals; **passes** |

Nothing is served. `options-risk` does not emit any of this and no verifier for it exists on chain.
