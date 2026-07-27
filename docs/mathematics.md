# Mathematics

*Section 5 of the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper),
which carries the full derivations and all 24 numbered equations. This is the map, not the territory.*

None of this is novel mathematics. The contribution is implementing it correctly, arbitrage-free,
tested, and behind a priced interface an agent can call — which is what had not existed.

Deribit crypto options are quoted on the forward, so the pricing model throughout is **Black-76**
rather than spot Black-Scholes.

---

## Options

**The greeks.** First-order by differentiation; the second-order volatility greeks vanna
(`∂𝒱/∂F = −e^{−rT}φ(d₁)d₂/σ`) and volga (`𝒱·d₁d₂/σ`) in closed form — and because a closed form is
only as good as its verification, each is checked against a finite difference of the first-order
greek. Vanna and volga are identical for calls and puts, as they must be, and the suite asserts it.

**The arbitrage-free surface.** Raw SVI fitted per expiry to total variance, with the no-arbitrage
conditions enforced as **penalties inside the objective**, so a converged fit is arbitrage-free by
construction rather than by inspection. Three conditions, not one: the butterfly condition (the
Durrleman function non-negative), the Roger Lee wing bound, and — most easily overlooked — the
calendar condition *between* slices, checked on the **rounded parameters the caller actually
receives** rather than on the full-precision fit, because rounding a slice can reintroduce a crossing
the fit had eliminated. Near-expiry slices are jump-dominated and a diffusive parameterisation cannot
describe them, so they are excluded by design and the exclusion is disclosed.

**The risk-neutral density, and why `N(d₂)` is wrong.** Breeden–Litzenberger gives the density as the
second strike-derivative of the call price. With a strike-dependent volatility the derivative carries
a term in the smile slope, so the exact probability is

```
P(S_T > K) = N(d₂) − e^{rT}·𝒱·∂σ/∂K
```

The textbook `N(d₂)` is the first term alone. On a real skewed crypto smile the second term is
material and **changes sign where the smile slope does** — measured live at +3.3 points just below
the money and −0.8 points in the upper wing, which is the sign flip the equation predicts and better
evidence for the correction than its magnitude. Reporting `N(d₂)` to a tenth of a point while
carrying a five-point error is not a simplification; it is a defect.

**Model-free calendar bounds.** A single smile prices vanillas; it says nothing about a payoff
depending on two dates. Rather than assume a dynamics and inherit its misspecification, a linear
program over martingale couplings returns the tightest interval consistent with *every* arbitrage-free
model. Its feasibility is exactly the Strassen convex-order condition, so **the bound doubles as a
calendar-arbitrage certificate** — agreeing with the total-variance check by a completely independent
route. Two exact identities gate the output; when either fails the bounds are withheld.

**Variance risk premium, and an honest refusal.** Overlapping windows are highly correlated, so the
window count badly overstates the independent sample and using it would manufacture significance. The
service deflates to an effective sample and tests there. On live BTC the median realised/implied ratio
is 0.881 — which looks like a premium — and the p-value is **0.254**. The service reports that it is
not significant and refuses to present the derived real-world probabilities as anything but
indicative. The deflation is deliberately blunt, and its error direction is stated: collapsing
correlated observations costs power, which *raises* the p-value, so 0.254 is a **ceiling, not a
floor** — nothing follows about what a sharper HAC-corrected test would say.

## Perpetuals

A venue liquidates an isolated position when account value falls to maintenance margin. With posted
margin `M`, size `q`, entry `P₀`, side `s`, and maintenance rate `mmr`, equating
`M + s·q·(P − P₀)` with `q·P·mmr` gives

```
P_liq = (s·q·P₀ − M) / (q(s − mmr))          →  for a long, (P₀ − M/q)/(1 − mmr)
```

On every call the engine substitutes `P_liq` back and confirms the two sides agree — residual of
order 10⁻¹² against a tolerance scaled to notional. This is deriving from the primary source rather
than repeating a widely-copied secondary formula that dropped the maintenance term and reported
roughly double the true buffer. **What that check does and does not catch is stated precisely in
[verifiability](verifiability.md)**: it catches an error in solving the condition, not an error in
the condition itself.

## Position sizing

Full Kelly maximises expected log-growth but its drawdowns are violent, so the engine bets a fraction
λ of it, defaulting to a quarter. The probability of *ever* drawing down to a fraction α is derived
rather than recalled: under fractional Kelly, log-wealth is a Brownian motion with drift
`g = (μ²/σ²)λ(1−λ/2)` and variance rate `s² = λ²μ²/σ²`; the probability of ever reaching `−L` is
`exp(−2gL/s²)`, and with `L = ln(1/α)` this collapses to

```
RoR(α, λ) = α^((2−λ)/λ)              → at full Kelly, the classic RoR = α
```

## Impermanent loss is not LVR

Both names get used for one number, and they are different quantities.

**Impermanent loss** for a realised price ratio `r` is `IL(r) = 2√r/(1+r) − 1`. It is a function of
the **terminal** price alone: path-independent, and bounded in (−100%, 0].

**Loss-versus-rebalancing** is the running loss to arbitrageurs against a rebalancing portfolio. It
accrues monotonically along the path, never gives anything back, and is therefore **unbounded**. On a
path that ends where it began, IL is exactly zero while realised LVR is strictly positive.

They coincide only *in expectation*, only to leading order, only under a driftless lognormal — which
is exactly the regime the expansion `E[IL] ≈ −σ²T/8` is derived in, and exactly why the two names get
swapped. An earlier version of this project rejected that expansion because "at large total variance
the rate returns a loss that cannot happen." **That reasoning was wrong in an instructive way:** an
unbounded loss is precisely what LVR is, so unboundedness is not evidence the rate is broken — it is
evidence the rate measures the other quantity. The boundedness belongs to impermanent loss, and
impermanent loss is what `lp-risk` reports.

## Microstructure

Three estimators on the cleaned tape, computed on **equal-count volume blocks rather than tick by
tick** — a correction ground-truthing forced. A per-trade Amihud ratio divides by the dollar size of a
single trade, and a DEX tape carries sub-cent dust whose near-zero denominator sends the ratio to
enormous values: on a live memecoin the per-trade estimator returned order 10⁹, obvious nonsense.
Blocks aggregate real volume over a real interval and are the faithful period form of both estimators.

- **Kyle's lambda** — the slope of block return on signed dollar flow, reported with its R², its
  sign-agreement, and an analytic 95% confidence interval, so a coefficient indistinguishable from
  zero is *said* to be indistinguishable from zero.
- **Amihud illiquidity** — `mean(|r_j| / V_j)`, reported as `pctMovePer1kUsd`, i.e. scaled by 10³ and
  expressed as a percentage. The scale is part of the definition here because without it the reported
  figures cannot be reproduced from the formula.
- **VPIN** — mean absolute buy-minus-sell imbalance across equal-volume buckets, in [0, 1].

Trade direction comes from the exchange's own label rather than a Lee–Ready classifier, which
introduces no classification error.

## Concentrated liquidity

A Uniswap-V3 position holds `amount0 = L(1/√P − 1/√P_b)` and `amount1 = L(√P − √P_a)` while price sits
in range. `lp-desk` fixes `L` from capital at entry, replays the pool's real swap sequence from chain,
credits the pro-rata fee share at each in-range swap and re-marks the holdings, so

```
(LP − HODL) = fees earned − divergence loss
```

The replay is exact for *ranking* strategies at small size and is a relative measure, not absolute
PnL at scale, because public swap logs expose only aggregate active liquidity — and the service says
so in its own output rather than in a footnote.
