# Tier 3, re-examined: I was wrong about why it is blocked

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

Two causes, and the first was mine:

**A scaling error.** The identity needs `V·100·S⁴` on the left and I wrote `S³`. The sweep reported a
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

## The negative half is solved, measured

That last sentence is an argument against **one** scale, not against fixed point.

Give every quantity its own power-of-ten exponent, so each carries nine significant digits whatever
its magnitude, and align the exponents when the two sides are compared. Over the same 4,000 surfaces:

| encoding | surfaces kept | worst relative residual |
|---|---|---|
| shared 1e-9 grid | 3,956 of 4,000 | **6.077e-1** |
| shared grid, gamma alone at 1e-18 | 3,973 | 2.237e-1 |
| per-value exponent, 9 significant digits | **3,999** | **7.344e-9** |

Eight orders of magnitude better, with no domain restriction at all, and 7.3e-9 is exactly what nine
significant digits should give. The worst case is no longer a deep-OTM option with a vanishing gamma;
it is an ordinary one at gamma 8.1e-3, which means the encoding stopped being the binding constraint.

So the arithmetic is **solved**. What remains is ordinary circuit engineering:

- each mantissa needs a range check plus a normalisation check that it sits in `[1e8, 1e9)`
- exponent alignment needs `10^d` supplied as a witness and constrained to be a genuine power of ten,
  which is a one-hot selector over a bounded exponent range rather than anything exotic
- cost, and this is an **estimate rather than a measurement**: 600 to 800 R1CS on top of the current
  1,103, so around 3,700 Plonk against the 4,096 ceiling. It would fit, narrowly, at domain 4,096

**Not built.** `greeks.circom` still uses the shared grid and `gateB7-1` still fails, because building
the encoding is the next piece of work and claiming it before it exists is the error this whole
document was written to correct.

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
| `zk/scripts/gateB7-1-greeks-sweep.mjs` | runs the circuit's statement against the real engine; **fails, on purpose** |

Nothing is served. `options-risk` does not emit any of this and no verifier for it exists on chain.
