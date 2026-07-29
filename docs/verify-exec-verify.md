# exec-verify: three reported blockers, measured — and the headline proved anyway

Every number below was computed on 30 July 2026 by running the gate or the probe named beside it.
Nothing is quoted from memory. Where a figure disagrees with an earlier note, the run wins.

Standing constraints honoured: nothing under `src/engine/` was touched and the engine still builds at
`q1-e1fa99d08887d6cc`; `npm test` still reports 386 tests, 0 failures; the paper was not opened;
nothing was deployed. `zk/circuits/constantproduct.circom` and gates B5-0/1/2 were **run** but not
edited, because their sizes are quoted in the research record.

---

## Verdict in one line

Two of the three blockers are refuted by measurement, the third is real as stated and was closed by
building a second circuit. exec-verify now has an end-to-end snark over the number it actually sells.

| # | reported blocker | status | what the measurement says |
|---|---|---|---|
| 1 | "inEff is never published" | **refuted, twice** | the service does not publish it, but the circuit does — and the fee identity pins it to a unique grid value on 3,988 of 4,000 trades and to one grid step always |
| 2 | "reserves routinely exceed 9e6 where the scaled-product encoding is wrong by up to 64 grid steps" | **half true, misattributed** | 42.7% of pools do exceed 9e6, and 64 grid steps is the right number — for the encoder this repo **already fixed**. The live encoder is within 3 grid steps at every magnitude |
| 3 | "the headline adverseExecutionBps has no circuit signal" | **held** | correct as of yesterday. An identity over it existed all along; it is now built, gated, and costs +504 Plonk gates in the same proving domain |

---

## Blocker 1 — "inEff is never published"

**What the service actually returns.** Calling the engine directly on a 30bp pool
(`{amountIn: 15000, amountOutRealized: 37150, reserveIn: 1.5e6, reserveOut: 3.75e6, feeTier: 0.003}`)
returns these keys and no others:

```
ok, inputs, mode, midPrice, honestFillPrice, realizedFillPrice, honestOut,
unavoidableCostBps, adverseExecutionBps, adverseValueOut, verdict, note, checks, slippageTolerance
```

`inputs` echoes `amountIn` and `amountOutRealized` only. So the blocker's literal claim is correct and
goes further than it says: `inEff` is absent, and so are `reserveIn`, `reserveOut` and `feeTier` as raw
values. The fee survives as `unavoidableCostBps.fee` (30) and the pool survives only as the ratio
`midPrice` (2.5).

**Why it is not a blocker.** Two independent reasons, both measured.

*First, the circuit publishes it.* `inHat` is a public input of `constantproduct.circom`
(public signal index 8) and of the new `execadverse.circom` (index 11). Gate B5-3 asserts the value
directly: `signal[11] = 14955000000000`, which is `dx·(1−f)` on the 1e-9 grid. A proof's public
signals are part of what a buyer receives; a field being absent from the JSON response says nothing
about whether it can be a snark signal.

*Second, it is recoverable even if nothing published it.* The circuit's fee statement is
`în·S = dx̂·(S − f̂)` held to `|Rf| ≤ S/2`. Two adjacent integers differ in `Rf` by exactly `S`, so at
most two can satisfy that window, and only when the exact value lands on a half step. Measured over
4,000 sampled trades: **3,988 have a unique admissible `inHat`, 12 have exactly two, and none has
more than two.** The 12 are real — gate B5-4's `tightestFeeRatio` is `1.000e+0`, i.e. some trade sits
exactly on the boundary — so the honest statement is one grid step, `1e-9` input tokens, not zero.

A verifier holding the published `amountIn`, the published fee, and the proof can therefore reconstruct
the effective input to within a nanotoken. Nothing is hidden by its absence from the response body.

## Blocker 2 — the scaled-product encoding

This one names a real defect class. `zk/scripts/lib/gatekit.mjs` carries its own post-mortem: the
encoder was once `BigInt(Math.round(snap(x) * S))`, the product passes 2^53 above about 9e6, and at
`x = 8.03e8` a double's granularity is 128 — so the returned integer was wrong by up to sixty-four grid
steps. Gate B5-1 found it by refusing to certify 455 of 3,595 pools.

So the question is not whether that ever happened. It is whether it is happening now, over the reserve
magnitudes exec-verify actually sees. Measured over 4,000 sampled pools (3,595 priced by the engine,
405 outside the circuit's 2^62 width). All figures are **grid steps of 1e-9 output token, maximum over
the bucket**, against an exact-rational reference computed in BigInt at 1e-24:

| reserve bucket | n | encoder alone | + input snapping | the ENGINE's own error | cert vs served | the OLD `Math.round` encoder | rearranged algebra |
|---|---|---|---|---|---|---|---|
| `max(x,y) < 9e6` | 2061 | 3 | 5 | 5 | 8 | 1 | 3 |
| `9e6 … 1e8` | 625 | 3 | 5 | 5 | 8 | 8 | 3 |
| `1e8 … 1e9` | 533 | 3 | 5 | 12 | 11 | **64** | 3 |
| `≥ 1e9` | 376 | 3 | 5 | 30 | 30 | 255 | 3 |

Four things fall out of that table.

**The premise is true.** 1,534 of 3,595 pools — **42.7%** — have `max(x,y) ≥ 9e6`. Reserves really do
routinely exceed the magnitude where a naive scaled product breaks. That is not a hypothetical corner.

**The 64 is real and it belongs to the old encoder.** It appears exactly where the post-mortem says it
will, in the 1e8–1e9 bucket, and grows to 255 steps past 1e9. The blocker quoted a true number about
code that is no longer there.

**The live encoder is flat.** Three grid steps at every magnitude, including past 1e9. `toScaled`
splits `toFixed(9)` on the decimal point and reassembles in BigInt, so no product is ever formed as a
double and there is nothing for 2^53 to truncate. A magnitude-independent error is the signature of an
encoder that does not depend on magnitude.

**What does grow with magnitude is the engine, not the encoder.** The "ENGINE's own error" column —
the gap between the engine's published `round(honestOut, 8)` and exact arithmetic — runs 5 → 5 → 12 →
30 grid steps. That is IEEE double precision plus an 8-decimal display grid, and it is the entire
reason gate B5-1's agreement allowance has a `honestOut·1e-14` term. Calling that an encoding defect
would send the next reader to fix the wrong file.

One further measurement, because the record was ambiguous. Gate B5-1's comments describe a third
appearance of the "read what the engine reads" defect, in which the encoder computed the algebraically
identical `y − x·y/(x + in)` instead of `y·in/(x + in)`. In BigInt the two orders agree to within 3
grid steps — the rightmost column — identical to the engine's own order. The 5-step gap that was
originally blamed on the rearrangement was the `round(honestOut, 8)` display step all along, which is
what the gate's own later note concluded. The rearrangement was harmless; the diagnosis that a constant
gap surviving two encoder fixes is not the encoder was correct.

## Blocker 3 — the headline has no circuit signal

**What the service leads with.** The registered blurb for `exec-verify` reads: "Fair-fill / sandwich
check — proves how many bps a swap lost to adverse execution its slippage tolerance hid." The response
object's decision field is `adverseExecutionBps`, and the `verdict` string is a predicate over it
(`> 5` bps ⇒ sandwiching / MEV / stale quote).

**What the shipped circuit proved.** `constantproduct.circom` certifies the benchmark — `honestOut` —
and nothing about the trade. `amountOutRealized` was not a signal at all. The blocker is correct: as of
29 July the sold number sat outside the statement.

**Does an identity over it even exist.** Yes, and it is one multiplication. With everything on the
shared grid,

```
shortfall  ŝ = ô − ẑ                        exact, nothing to round
headline   b̂·ô = 10000·S·ŝ                  one rounded division, cleared of its denominator
```

The shortfall — `adverseValueOut`, the loss in output tokens, which is the figure a dispute is actually
about — needs **no tolerance at all**: both terms are already integers on the same grid, so the
subtraction is exact in the field. Only the conversion to basis points rounds, and `b̂` rounds by half a
grid step over a factor of `ô`, giving `|Rb| ≤ ô/2`. The bound scales with the fill rather than being a
constant, for the same reason the engine made its own self-check relative.

That is now `zk/circuits/execadverse.circom`, carrying the whole benchmark forward unchanged and adding
the fill, the exact shortfall and the headline.

---

## What it cost

Read from the artifacts by `zk/scripts/circuit-facts.mjs`, not written down:

| circuit | R1CS | Plonk | public | domain | EVM accept | verifier bytes |
|---|---|---|---|---|---|---|
| `constantproduct` (benchmark only) | 671 | 1,293 | 10 | 2048 | 276,892 gas | 7,694 |
| `execadverse` (benchmark + headline) | 932 | 1,797 | 15 | 2048 | 279,280 gas | 8,754 |
| delta | +261 | +504 | +5 | **unchanged** | **+2,388 gas (+0.9%)** | +1,060 |

The domain not moving is the whole economics of this. Plonk's cost is set by the power-of-two domain,
and 1,797 gates still fit the 2048 the benchmark alone already needed — so the headline needs no new
ceremony file, no larger `hez_final_12`, and the proof stays constant-size. On chain it costs 2,388
extra gas, which is the marginal cost of five more public inputs and nothing else.

This is the same shape as the fixed-point lesson the greeks work already learned: `greeksfp.circom`
came out at 1,919 Plonk against `greeks.circom`'s 2,152 — the more honest encoding was the cheaper one.
Here the encoding did not have to change at all; the identity that had been assumed expensive was one
multiplication and one signed window.

---

## The gates

All five run clean, freshly, on this machine today. Gates B5-0/1/2 are unmodified.

**B5-0** `constantproduct`, prove / verify / refuse — PASSED. 1,293 Plonk, proved in 1,000 ms. All 10
public signals refuse a `+1` perturbation; a bent proof point is refused; 6 of 6 dishonest witnesses
are refused before a proof exists.

**B5-1** `constantproduct` against the live engine — PASSED. 3,595 pools kept, 405 refused as outside
the 2^62 width, 0 divergences, 0 bound violations. Tightest invariant `2|R|/TOL = 7.997e-1`; tightest
fee `2|Rf|/S = 1.000e+0`; **the worst honest case uses 77.7% of the derived agreement allowance.**

**B5-2** `constantproduct` in an EVM — PASSED. Accept 276,892 gas, cheapest refusal 573 gas, 11 of 11
tampered submissions refused, solc 0.8.26.

**B5-3** `execadverse`, prove / verify / refuse — PASSED (new). 1,797 Plonk, 15 public, domain 2048,
proved in 1,036 ms. All 15 public signals refuse a `+1` perturbation. **13 of 13** dishonest witnesses
refused, including the three that matter for a headline: the effective input off by one grid step in
either direction, the headline off by one unit of 1e-9 bps, and the headline with its sign flipped. A
favorable fill is carried rather than refused — filled at 37,500 the engine says −130.09 bps and the
circuit certifies −130.090270812.

**B5-4** `execadverse` against the live engine — PASSED (new). 3,596 trades kept, 404 outside the 2^62
width, 0 outside the 2^50 bps width, 0 divergences, 0 violations of any of the three bounds.

**B5-5** `execadverse` in an EVM — PASSED (new). Accept 279,280 gas, cheapest refusal 573 gas, 16 of 16
tampered submissions refused, verifier 8,754 bytes.

### The divergence bound, derived rather than inherited

B5-1's allowance is in output tokens. Basis points are a ratio, so every term has to be divided through
by the fill and one term changes size, because `round(bps, 2)` is coarser in bps than
`round(honestOut, 8)` is in tokens. Reusing B5-1's figure would have been the liquidation half-cent
again — a bound belonging to a different quantity. Derived term by term, in bps, with the worst case
this sweep found:

| term | derivation | value at the worst case |
|---|---|---|
| display | the served field is `round(bps, 2)` | 5.00e-3 |
| bps grid | `b̂ = round(bps·S)` rounds by half a unit | 5.00e-10 |
| fill grid | `realized` snaps by half a step, `d(bps)/d(realized) = −1e4/out` | 1.74e-12 |
| benchmark | `d(bps)/d(out) = 1e4·realized/out²`, times an a-priori `gOut` | 1.49e-10 |
| IEEE | the engine's own cancellation, `out·1e-16`, carried through | 1.00e-12 |
| **total** | | **5.0000e-3** |

The display step is 99.99% of the whole allowance, which is itself the finding behind the two blind
spots recorded below: this bound's resolution is set almost entirely by how coarsely the service prints
the number, not by anything in the circuit.

Worst measured gap **4.9988e-3 bps against an allowance of 5.0000e-3 — the worst honest case uses
99.98% of the bound** (the gate prints 100.0% at one decimal; the artifact records 0.99976). The shortfall
statement carries its own derived allowance in tokens and the worst honest case uses **45.6%** of it
(7.000e-9 tokens of 1.535e-8). The three circuit bounds are used at **79.34%** (invariant), **100.00%**
(fee — `2|Rf|/S` is exactly 1, an exact half-step tie, which is also why the effective-input window
below is one grid step rather than zero) and **99.97%** (headline) by the worst honest case in the
sweep. None of them is slack.

**The first version of this bound could not fail, and the gate caught it.** `gOut` was measured as
`|certified − served|` for the trade under test, so the allowance expanded to cover whatever the encoder
had just done — and the proof that it was worthless is that it then failed to refuse an encoder this
repo is on record as having had wrong. `gOut` is now the a-priori form B5-1 derived
(`0.5e-8 + (1 + 2y/x)/S + honestOut·1e-14`), and B5-4 reports how much of it the measured gap uses —
**77.4%** — so the borrowed formula is checked here rather than assumed.

### The bound is shown to be exceeded

Five deliberately wrong benchmarks, run through the identical sweep:

| known-wrong benchmark | refused | worst | its own benchmark error |
|---|---|---|---|
| a MID-price benchmark | 3,596 of 3,596 = 100.0% | 214,614x | 1.09e-1 relative |
| a 1e-6 relative slip | 3,447 of 3,596 = 95.9% | 3.1x | 1.01e-6 relative |
| a 1e-7 relative slip | 328 of 3,596 = 9.1% | 1.2x | 1.05e-7 relative |
| reading the DISPLAY-ROUNDED benchmark | 0 | — | 2.06e-16 relative, 30 grid steps |
| the `Math.round(v*1e9)` encoder | 0 | — | 5.41e-9 relative, 60 grid steps |

The mid-price case is the confusion this entire service exists to prevent — unavoidable cost relabelled
as adverse execution — and it is refused on every single trade. The two slip runs bracket the
derivation's own crossover: the bound is dominated by the 0.005 bps display step, a relative slip `r`
shows up as `1e4·r` bps, so the line sits at `r ≈ 5e-7`. A 1e-6 slip is refused on 95.9% of trades and
a 1e-7 slip on 9.1% — the 1e-7 cases that do break it are the ones where display rounding was already
most of the way there. Catching everything would have meant the line is not where it is claimed to be.

The last two rows are recorded, not hidden. **This bound cannot see the encoder defect blocker 2 named,
and the reason is measured:** in relative terms that encoder is wrong by 5.41e-9, four orders of
magnitude under the 5e-7 this bound can resolve. In absolute output tokens it is wrong by 60 grid steps,
which is gate B5-1's instrument and not this one's. Two bounds, two jobs, and neither is sufficient
alone — which is the argument for keeping both gates rather than replacing B5-1 with B5-4.

### How far a cheating prover could move the sold number

Not the residual-to-tolerance ratio, which measures how close honest cases sit to the bound. This is the
soundness question: given the public signals a buyer already knows, what set of intermediates still
verifies?

| intermediate | pinned by | window |
|---|---|---|
| effective input `în` | `dRf/dîn = S`, `\|Rf\| ≤ S/2` | 1 grid step = 1e-9 input tokens, everywhere |
| benchmark `ô` | `dR/dô = −(x̂+în)`, `\|R\| ≤ (x̂+în+ŷ−ô)/2` | 1.34 grid steps at the widest = 1.34e-9 output tokens |
| headline `b̂` | `dRb/db̂ = ô`, `\|Rb\| ≤ ô/2`, plus whatever `ô`'s window lets through | 2.17e-2 bps at the widest |

The headline window is a **ratio**, so it widens as the fill shrinks: the same 1.3-nanotoken uncertainty
is a larger fraction of a smaller fill. The widest case in the sweep is 2.17e-2 bps, on a fill of
5.98e-4 output tokens — **1/230 of the 5 bps threshold the verdict turns on.** It exceeds the 0.01 bps
step the field is published at on 5 of 3,596 trades, and every one of those is a fill below 2.64e-3
output tokens. The honest statement is therefore: on any fill of more than about a hundredth of a token
the proof pins the headline finer than the service prints it, and on dust fills it does not — it pins it
to about two hundredths of a basis point, still two orders under the decision threshold. Asserting
"finer than published, always" would have been a claim the measurement refutes, and the gate refused
that wording.

---

## The smallest honest statement, and whether it is worth money

`perp-gate`'s snark publishes a `proves` / `doesNotProve` pair and covers a ceiling rather than the
recommendation, and says so. The same discipline applies here, and the reserves being an input makes it
matter more, not less.

**What a proof over exec-verify says.** For the pool state, trade size, fee and realized fill handed to
it: the honest constant-product benchmark for the caller's own size is correct arithmetic; the shortfall
against it, in output tokens, is exact on the grid with no tolerance of any kind; and the basis-point
headline follows from those two to within one unit of 1e-9 bps, with the whole chain's soundness window
under 2.2e-2 bps and under 1/230 of the verdict threshold. Any threshold decision — including the
engine's own `> 5` bps verdict — is a public predicate over a proven public signal, so it needs no
comparator in the circuit and no trust in the server.

**What it does not say, and this is the load-bearing half.** The reserves are an input. So is the
realized fill. It does not prove the pool state was real, or the right block, or the state before an
attacker front-ran the trade — the engine's own `note` field says exactly this in English, and a proof
does not upgrade it. It does not prove the caller received what they said they received. It does not
prove the verdict is the right verdict about the world; only that the number the verdict is computed
from is the number the stated arithmetic produces. The input problem is Phase D and this touches none
of it. Any wording that suggests otherwise is a lie with a verifier attached.

**Why the small statement is still worth paying for.** Three reasons, each of which survives the
disclaimer.

The benchmark is the one number in the response the buyer cannot compute for themselves. Given reserves
they can see, they still have to trust that `y·dx(1−f)/(x + dx(1−f))` was evaluated correctly for their
size, and this repo has now found the same class of arithmetic defect three separate times in its own
encoders. A succinct proof replaces "re-run it and see" with "check 279,280 gas of pairing".

The shortfall is the number a dispute is about. An insurance claim, a DAO reimbursement vote, or a
relayer's SLA argument is denominated in output tokens lost, not in basis points, and that figure is
now certified exactly — no tolerance, no allowance, no rounding argument to have with a counterparty.

And the statement is composable in the direction the input problem needs. Once the arithmetic is a
snark over public reserves, an attestation about *where those reserves came from* — a TEE quote, a
zkTLS transcript, an `eth_getProof` at a named block — plugs into the same public signals without
touching this circuit. Proving the arithmetic first is not a detour around the input problem; it is the
half that has to be finished before the other half has anything to attach to.

---

## Files

New, all mine, none of them touching a sibling's circuit or gate:

- `zk/circuits/execadverse.circom` — the benchmark plus the fill, the exact shortfall and the headline
- `zk/scripts/gateB5-3-execadverse.mjs` — prove / verify / refuse, 13 dishonest witnesses
- `zk/scripts/gateB5-4-execadverse-sweep.mjs` — against the live engine, with the derived bound and five breakers
- `zk/scripts/gateB5-5-execadverse-evm.mjs` — the exported verifier in an EVM, and the marginal cost over B5-2

Run, unmodified: `zk/scripts/gateB5-0-constantproduct.mjs`, `gateB5-1-constantproduct-sweep.mjs`,
`gateB5-2-constantproduct-evm.mjs`.

**Two things about the clone that are stated rather than glossed.** B5-3 and B5-4 were run from the
mirror as well as from the dev tree and pass identically there — B5-3 at 975 ms, same 1,797 gates —
so the `service-root.mjs` resolver and the mirrored artifacts are doing their job. B5-5 does **not**
run from the mirror, because `solc` is not installed there; neither does the existing B5-2, for exactly
the same reason and with exactly the same error. That is the documented `cd zk && npm install` step,
which `gate-clone-portability.mjs` already classifies as a missing third-party package rather than a
portability defect, and it is not something this work introduced. Separately, `execadverse` is not yet
in that gate's `CIRCUITS` list; adding it is a one-word change to a file three agents are working in
simultaneously, so it is left for whoever batches that list next rather than raced for.

Reproduce the whole thing:

```
node zk/scripts/build-circuit.mjs execadverse
node zk/scripts/gateB5-0-constantproduct.mjs
node zk/scripts/gateB5-1-constantproduct-sweep.mjs
node zk/scripts/gateB5-2-constantproduct-evm.mjs
node zk/scripts/gateB5-3-execadverse.mjs
node zk/scripts/gateB5-4-execadverse-sweep.mjs
node zk/scripts/gateB5-5-execadverse-evm.mjs
```
