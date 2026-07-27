# Services

*Section 4 of the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper).
Inputs and outputs per endpoint are in the [API reference](api.md); the methods are in
[mathematics](mathematics.md).*

Twenty-two priced computations. They are not thin wrappers over a data feed — they implement the
methods a quantitative desk or a security team would actually run, and where the data does not
support a claim they refuse to make it.

**Deterministic** services are pure functions of their inputs and ship a
[proof envelope](verifiability.md). **Live** services read a venue and ship an observation envelope
that says outright it is not re-runnable.

---

## The Risk Brain

The layer beneath the risk gate. Agent risk products now shipping from exchanges and startups enforce
user-set *limits* — max size, leverage caps, drawdown stops — but assume the correct risk numbers as
input. They do not compute them. These do, and prove each answer.

**`perp-gate`** · 0.01 · deterministic with explicit inputs, live in symbol mode
Liquidation price, adverse move to liquidation, effective leverage, and funding drag. The liquidation
price is not copied from a venue formula — it is *derived* from the stated liquidation condition and
then *verified* numerically against that condition on every call, so a wrong derivation fails loudly
rather than shipping a confident wrong number. The maintenance rate steps up with notional through
the venue's margin tiers, so a large position is measured against the tighter rate its size actually
incurs. A position already past its liquidation price is labelled `BELOW_MAINTENANCE` rather than
reported as a future event.

**`portfolio-gate`** · 0.05 · deterministic with explicit legs, live in account mode
The whole-book view: signed notionals summed per underlying, so a long on one venue and a short of
the same asset on another net out instead of double-counting; the leg that liquidates **first**; a
concentration index that exposes when a nominally diversified book is one directional bet; and a
correlated-crash stress that moves every leg together as correlations go to one. It also computes an
account-level cross-margin liquidation, and cross-checks per-leg prices against the venue's own — the
one verifier in this system we do not control. **Its per-leg model is isolated margin**; on a
cross-margined account that is the wrong model by orders of magnitude, and the response says so.
See [limitations](limitations.md) item 2.

**`size-gate`** · 0.01 · deterministic
An edge — discrete odds or a return/volatility pair — converted to a fractional-Kelly position and
the probability of *ever* drawing down to 50/75/90% of capital. Defaults to quarter-Kelly, because
full Kelly rides thin over-estimated edges to ruin. Self-checks the returned fraction against the
first-order condition that defines Kelly, and flags when the recommended bet exceeds the bankroll.

**`exec-verify`** · 0.01 · deterministic
How many basis points a completed swap lost to *adverse* execution — sandwiching, MEV, a stale quote
— beyond the unavoidable fee and its own price impact. It proves the uncomfortable fact that a fill
"within slippage tolerance" can still have been robbed. Given pool reserves it benchmarks against the
constant-product invariant; given only a caller-supplied fair price it reports the invariant check as
**not run** rather than as a pass.

**`options-risk`** · 0.02 · deterministic
Net greeks for a whole options book — delta, gamma, vega, theta, and the second-order vanna and volga
— plus a SPAN-style scenario margin, the worst repriced P&L over a price × volatility grid, swept at
122 price points rather than the conventional seven so an interior worst case cannot hide. All six
analytic greeks are verified against finite differences of the *independently repriced* book.

**`lp-risk`** · 0.01 · deterministic
Forward-looking expected impermanent loss versus holding, and the fee break-even volatility.
Deliberately **not** labelled LVR — see [mathematics](mathematics.md#impermanent-loss-is-not-lvr).

**`treasury-risk`** · 0.02 · deterministic
Stablecoin-treasury concentration, depeg and correlated-depeg stress, and risk-adjusted yield.

**`event-vol`** · 0.01 · deterministic
The options-implied expected move around a scheduled event: one sigma, the straddle `E|ΔS|`, and the
probability beyond a level, with the event isolated from the volatility term structure.

**`risk-attest`** · 0.01 · deterministic
A Merkle batch of proof hashes into one root with inclusion proofs and an EIP-712, EAS-ready
attestation, so a single on-chain anchor attests many computations. Leaves are tagged `0x00` and nodes
`0x01`, and a soundness check presents a real internal node as a member leaf on every call — a check
that can fail structurally, which an earlier version could not.

---

## Options intelligence

**`options-desk`** · 0.01 · live
A desk-grade read of the live crypto options market from Deribit with an OKX cross-check, in layers:
an implied view and a probability ladder that uses the smile-corrected probability rather than the
biased textbook `N(d₂)`; the full risk-neutral distribution with quantiles and tail expected
shortfalls, emitted only when the density is proper and integrates to one; dealer gamma exposure and
the gamma-flip level under a *disclosed* convention; the variance risk premium tested at the honest
effective sample size and reported as **not significant**; cross-market divergence against Polymarket
decomposed into the part explained by the variance premium and the residual; and model-free calendar
bounds by martingale optimal transport, which price a two-date payoff without assuming any dynamics.

---

## Transaction and token safety

**`calldata-x`** · 0.005 · live
Two modes, and the second is why it matters. **Transaction mode** decodes calldata and simulates the
unsigned transaction against live chain state, reading asset transfers and approval changes from the
emitted logs rather than inferring them, and checks the target for an upgradeable proxy including the
pre-standard slot that USD Coin uses. **Signature mode** decodes an EIP-712 permit — the vector that
never appears in a transaction simulator and is how most drainers work today — extracting spender,
amount and expiry, and flagging an unlimited allowance, a non-expiring permit, or a spender that is a
wallet rather than an audited contract. Results are pinned to a block hash so a reader can re-query.

**`token-scan`** · 0.05 · live · **`wallet-audit`** · 0.05 · live
What share of a token's recent DEX volume is organic rather than manufactured, with the specific
wallets and transaction hashes behind the score — and whether a wallet's PnL and win rate reflect
skill or are statistically hollow, reported as a Wilson interval at the real sample size with an
explicit insufficient-data verdict rather than a flattering point estimate.

---

## Microstructure, markets and protocol

**`tape-pulse`** · 0.01 · live — Kyle's lambda, Amihud illiquidity and VPIN on the cleaned DEX tape,
each with a quality gate that returns null rather than a false number, and a tape-density diagnostic
that shows when the exchange is returning a sampled feed.

**`lp-desk`** · 0.01 · live — a concentrated-liquidity reality check that **refuses to sell the
product the rest of the market sells**. It replays the pool's real on-chain swap history and nets
realised fees against divergence loss. The finding, across hundreds of thousands of real swaps in two
windows eighteen months apart, is that no capturable optimal width exists — so it sells the
measurement and says plainly when the honest answer is "don't provide this liquidity."

**`poly-fill`** · 0.01 — walks a live Polymarket book for a requested notional and fits the
square-root impact law, reporting how closely *this* book follows it. The midpoint on a thin book is
a fiction; the walk is the truth.

**`poly-desk`** · 0.01 — a Polymarket wallet's live book with marks and unrealised PnL.

**`updown-pulse`** · 0.01 — the short-window up/down market's own implied odds, time to resolution
and a driftless risk estimate. It deliberately outputs **no fair value and no edge**, because
short-horizon direction is empirically indistinguishable from a coin flip.

**`protocol-pulse`** · 0.01 — DeFi protocol health from TVL, drawdown, chain concentration, age and
the hack registry. It emits **no composite grade**: a 0–100 score would imply a calibrated model, and
with no labelled dataset of protocol failures to validate weights against, a hand-tuned composite
would be goal-seeking. Individually defensible flags instead, each with its threshold disclosed.

**`macro-sentry`** · 0.005 — high-impact US macro events inside a lookahead window, from a curated
table, with the coverage horizon published so the service cannot report a fabricated all-clear past
the last transcribed release.

**`loop-digest`** · 0.01 — a cursor-based diff of a wallet's world since the caller's last call, so
an agent reads one small object instead of re-fetching and re-paying for the entire state. A
zero-row read returns `ok:false` with a coverage note and is **free**, because zero information is
not an answer.

**`chart-press`** · 0.02 — a server-rendered PNG with indicators and drawings, and a facts block that
names the *source* of each field rather than claiming they all come from the drawn series.
