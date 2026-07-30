# Wiring lp-risk: a bisection certified by its bracket

`zk/circuits/lpbracket.circom` and `zk/circuits/lpexpectation.circom` were built two days ago and
served nobody. One of them is now wired to a caller. The other cannot be, and the reason is a number.

Every figure below was computed in this session. Where an existing artifact disagrees with what I
measured, the disagreement is stated rather than smoothed — there are two of those, and one of them is
a published gate number that should not be read the way its field name invites.

---

## 1. What each circuit actually proves

### `lpbracket.circom` — verified line by line, not taken on trust

The claim in its header is that a bisection RESULT can be certified by proving the BRACKET. Reading the
constraints, that is what it does:

| constraint | what it forces | reading |
| --- | --- | --- |
| `sLo`: `LessThan(SCALE, eLoHat + feeHat) === 1` | `S < L̂(lo) + f̂` | `L(lo) + f > 1`, i.e. `g(lo) > 0` |
| `sHi`: `LessEqThan(eHiHat + feeHat, SCALE) === 1` | `L̂(hi) + f̂ ≤ S` | `g(hi) ≤ 0` |
| `ord`: `LessThan(loHat, hiHat) === 1` | `lo < hi` | it is a bracket, not a point |
| `bMid` + `midOk` | `2v̂* − l̂o − ĥi ∈ {−1,0,1}` | the root is the midpoint to one grid step |
| `bW` on `widthSlack` | `ĥi − l̂o ≤ ŵ` | the bracket is inside a published width bound |
| `bR` + `within` | `\|2·(σ̂²T − v̂*·S)\| ≤ TOL` | the volatility is the root of the midpoint |

with `L = E[IL] + 1 ∈ (0,1]` so the field never needs a sign, and every input range-checked with
`Num2Bits` before it reaches a comparator. So: `g(lo)` and `g(hi)` straddle zero, and the returned root
lies between them. That is the claim, and it holds.

**One precision correction to the header's own wording.** `mid ∈ {−1,0,1}` together with `lo < hi` puts
`v̂*` in the CLOSED interval `[l̂o, ĥi]`, strictly interior only when `ĥi ≥ l̂o + 2`. At `ĥi = l̂o + 1`
with `mid = −1` the circuit admits `v̂* = l̂o`. The served encoder refuses any bracket under two grid
steps, so this is unreachable from a request — but the circuit alone does not forbid it.

Reproduced, not quoted: `node zk/scripts/gateLP0-bracket.mjs` PASSED again in this session — 1,776
Plonk constraints of the 4,096 `hez_final_12` allows, domain 2048, 926 ms to prove, 277,121 gas to
accept on chain, 573 gas for the cheapest refusal, 14 of 14 tampered submissions refused in the EVM,
8 of 8 dishonest witnesses refused before a proof existed.

### `lpexpectation.circom` — cannot be wired, and here is the number

It has an `.r1cs` and nothing else: no `zkey`, no verifier, no verification key. `zk/build/gateLP2-expectation-cost.json` records why, and the figure is decisive:

| circuit | R1CS constraints | vs the ceremony file's 4,096 |
| --- | --- | --- |
| `divergence` | 463 | fits |
| `lpbracket` | 932 | fits |
| `lpexpectation` (81 nodes) | **36,613** | **8.94× over** |

It needs `powersOfTau` 16 or 17. `hez_final_12` cannot express it, so there is no honest statement to
wire: the artifact does not exist and cannot be built from the ceremony file on hand. What it IS is a
cost measurement, and a good one — it establishes that 81 of the engine's 401 nodes reproduce the
served 4-decimal figure, that the grid is geometric so two exponentials generate all 401 nodes, and
that the binding cost is the per-node division bound. None of that becomes a proof without a bigger
ceremony file.

---

## 2. The closed form, reproduced

`E[IL](v) = exp(-v/8) − 1`, and it is exact. The derivation is four lines:

```
2√r/(1+r) = sech(ln r / 2)
ln r = −v/2 + √v·z,  z ~ N(0,1);  with a = √v/2 the argument is a·z − a²
shift z = w + a:  argument becomes a·w, and the pdf gains e^{−a·w − a²/2}
symmetrise w → −w:  e^{−a·w} becomes cosh(a·w),  and cosh·sech = 1
⇒ E[sech(·)] = e^{−a²/2} = exp(−v/8)
```

Measured against the engine's own quadrature over 20,001 log-spaced `v` in `[1e-8, 1e4]`:

| quantity | value |
| --- | --- |
| worst `\|closed − engine quadrature\|` | **1.419121e-9** at `v = 1.1256412505761104` |
| confirmed a supremum by | 40,001-point log pass · golden-section refinement (`1.419121e-9` at `v = 1.126459628754112`) · 200,001-point brute scan of `[0.2, 10]` (`1.419121e-9` at `v = 1.12561`) |
| Gaussian weight discarded outside `\|z\| ≤ 6` | **1.973175e-9** (`= 2·Q(6) = 1.9731752900753966e-9`) |
| the residual as a fraction of that | **71.92%** |

The residual IS the engine's window truncation: `\|IL\| ≤ 1`, so the truncation cannot exceed the
dropped weight, and 71.92% of that ceiling is where it sits.

**Two disagreements with the brief, both stated rather than reconciled away.**

1. The brief cites `1.9786e-9`. My measured supremum is `1.419121e-9`. `1.9786e-9` is within 0.28% of
   the *tail-weight ceiling* `1.973175e-9`, which is an upper bound on the truncation rather than the
   truncation — so the two numbers are answers to different questions.
2. The brief says the residual is "invariant in N". It is not, quite. At the engine's `|z| ≤ 6` window:

   | N | worst residual |
   | --- | --- |
   | 200 | 1.289139e-9 |
   | 400 (the engine) | 1.419121e-9 |
   | 800 | 1.487278e-9 |
   | 1600 | 1.522151e-9 |
   | 4000 | 1.543329e-9 |

   It *converges upward* as `N` grows — which is the right shape for a truncation floor: refining the
   grid removes the quadrature error and leaves only the part that does not depend on `N`.

3. The brief says it collapses to `2.4425e-15` when the window widens. Widening it (holding the 0.03
   step) gives `1.893832e-12` at `|z| ≤ 7`, then `2.997602e-15` at `|z| ≤ 8`, `2.664535e-15` at
   `|z| ≤ 10`, `2.886580e-15` at `|z| ≤ 12`. That is a double-rounding floor of a few ulps, not a
   specific value; `2.4425e-15` is in the same band but is not what my sweep produced.

### The closed form does NOT always reproduce the served digit

A gap under half a display step is not the same claim as rounding to the same figure, and here it
matters. Over a dense scan of `v ∈ (0, 300]` at `1e-3` steps, `round(exp(-v/8)−1, 4)` differed from the
engine's published `expectedIlPct` at **15 of 300,001** points — at ordinary variances like
`v = 0.759` (served `-9.0513`, closed `-9.0514`). And in the band `src/util/lpBoundedness.js` already
names, `[116.0687, 116.0693]`, **3,477 of 4,001** samples disagree. A 6,000-point log-spaced sweep
found zero disagreements, which is exactly why absence on a coarse grid is not evidence.

### The closed form also solves the breakeven outright

`exp(-v/8) − 1 = −f  ⇒  v* = −8·ln(1−f)`, so the 200-iteration bisection has a closed form too.
`\|bisected v* − (−8 ln(1−f))\|` is at worst `1.4345e-8` over 400 fee levels, and
`round(√(v*/T), 5)` equalled the served `breakevenVolatility` on 612 of 612 samples. Where it fails is
worth recording: at `T = 1`, 2 of 4,001 log-spaced fee levels differ by one 5th-decimal step; at
`T = 365`, one differs by `3.795e-2` — at `f = 1 − 1.4e-15`, where the engine's quadrature has
saturated at −100% and the closed form is the one still describing the function.

**This is why the closed form is NOT what gets encoded.** `1.419e-9` is more than one grid step on a
1e-9 grid, and the straddle the circuit checks is decided on single grid steps. Encoding it would
certify a bracket around the root of a function the engine never evaluated. So `src/util/lpBracket.js`
transcribes the engine's quadrature and the closed form is used only as a cross-check a reader can run
in one line — published beside the two assumed values on every proof record.

---

## 3. What was wired

`lp-risk` is the sixth circuit-serving service on this host. `{"snark": true}` on either surface now
builds a Plonk proof of the breakeven bracket off the request path.

| file | what changed |
| --- | --- |
| `src/util/lpBracket.js` | NEW. The normative encoding: the engine's quadrature transcribed, the engine's 200-halving bisection replayed, the bracket search, the encoder, the derived bound, and the shared `snark` block builder. |
| `src/util/snark.js` | the sixth identity: `buildLpBracketInBackground`, the guard as a pure exported `lpBracketRefusal`, `VK_FILES.lpbracket`, `_internalLpBracket`. |
| `src/util/proverWorker.mjs` | `lpbracket` added to the closed set of circuit names. |
| `src/services.js` | the paid handler destructures `snark` and calls the shared block builder. |
| `src/mcp.js` | the free handler, same. |
| `assets/zk/` | `lpbracket_plonk.zkey` (7,094,860 bytes), `lpbracket_vk.json`, `lpbracket_js/`. |
| `gates/gateLP-bracket-snark.mjs` | NEW, 13 checks. |
| `gates/gateLP-revert.mjs` | NEW, 7 scripted reverts. |
| `gates/preflight.mjs` | the pinned proof-emitting set, the grid exemption, and the artifact list — each updated deliberately. |

`src/engine/` was not touched. `q1-e1fa99d08887d6cc` is unmoved, asserted on both sides of a script
that rewrites files.

### Both surfaces publish ONE claim

The five older identities duplicate their `proves` / `doesNotProve` strings across `services.js` and
`mcp.js`. That works until an edit lands on one of them, and the MCP array has been the forgotten site
four times on this project. `lpBracketSnark()` in `lpBracket.js` builds the block for both, so the two
cannot drift; only the closing `note` differs, because one describes a paid response and one a free
one. Asserted in LP.9.

### No field is grid-snapped, and that is a decision

The quantity the circuit compares against is the horizon fee fraction
`(feeAprPct/100) · (horizonPeriods/periodsPerYear)` — a quotient that lands off the 1e-9 grid whether or
not its three ingredients are on it, exactly like perp-gate's margin derived from leverage. The encoder
reads the same doubles the engine read and forms the quotient in the engine's own order, so the only
encoding error is `toScaled` on the quotient — and that error is inside the derived bound by
construction, because the bracket is required to straddle at BOTH the engine's fee fraction and the
encoded one, which puts both roots inside it.

`volatility` reaches no term at all. The breakeven is the root of "expected divergence == fees" and the
fee side does not depend on realized vol; volatility is required to be positive only because that is
what opens the block the breakeven lives in. Snapping any of these would move content hashes for
high-precision callers and buy nothing — size-gate's argument about `bankroll`, arriving for every
field the endpoint has. Recorded by name in `preflight.mjs` rather than left for someone to notice.

---

## 4. The bound, derived here

`breakevenVolatility: round(breakevenSigma, 5)`, so the display half-unit is **0.5e-5**. That is the
5 in the engine's own source, halved — 100× finer than the liquidation guard's half-cent and 10×
coarser than the Kelly guard's half-millionth, which is why it is a sixth constant and not a reuse.

What has to be bounded is `|certifiedSigma − σ*|` where `σ*` is the engine's UNROUNDED breakeven. Two
terms, both evaluated at box corners, no derivatives anywhere:

1. **The bracket.** Both roots lie in `[lo, hi]`; `v̂*/S` lies within one grid step of the bracket
   midpoint `m`. So the excursion is `max over x ∈ [m ± 1/S], y ∈ [lo, hi]` of `|σ(x) − σ(y)|`, attained
   at a corner because `σ(v) = √(v/T)` is monotone. All four corners are evaluated.
2. **The root rounding.** `|σ̂²T − v̂*S| ≤ TOL/2 = (σ̂+1)T + S`, so
   `|σ̂ − √(v̂*S/T)| ≤ (σ̂ + 1 + S/T)/(σ̂ + √(v̂*S/T))`, evaluated rather than approximated.

**Measuring the FULL bracket width instead of term 1 was the first shipped version, and it left the
worst honest case at 49.8% of the bound.** That looked like headroom and was arithmetic: the certified
value is pinned near the midpoint while only the engine's root roams the bracket, so charging the whole
width double-counts. Corrected, the bound is tight:

| measurement | value |
| --- | --- |
| **worst honest case / derived bound** | **99.7384%** (gap `1.273964e-6`, bound `1.2773060e-6`) at `σ=0.005, T=90, feeAprPct=5` |
| cases exceeding the bound | **0** of 756 |
| worst honest case / the CIRCUIT's own root tolerance | 96.717% |
| widest proved bound / the 0.5e-5 display half-unit | 49.887% (the search targets `1/SAFETY = 1/2` of it) |

The 49.887% is by construction, not headroom: the search stops as soon as its bound is under half the
ceiling, so a proved answer is never sitting on the limit that refuses. The number that matters for
whether the guard can fire is the refusal count, below.

### The comparison is against the engine's unrounded figure, and that is load-bearing

An equality on `round(certifiedSigma, 5) === served` — the obvious form — **refused 28 of 770 honest
answers** on the first measurement pass, all sitting on a 5th-decimal boundary. That is the defect that
refused RUNE a liquidation proof for landing a hair the wrong side of a half-cent, on a different
quantity. So `lpBracket.js` replays the engine's own 200-halving bisection (1.26–1.40 ms, measured, off
the request path) and the guard compares against that. The served figure is only required to be what the
replay DISPLAYS as — 0 disagreements in 770, because the replay is the engine's expression in the
engine's order.

The bracket search separately targets the served digit, so a reader is not asked to reconcile a public
signal against a differently-rounded response field: 0 of 378 proved answers differ, where without it
14 of 378 did. That is a courtesy and not a guard — where the engine's root sits within the narrowest
achievable bound of a display boundary no bracket can satisfy it, and the proof is still served with
`gapToServedBreakeven` published. **7 of 784** answers on a fine fee sweep are in that position.

---

## 5. The guard fires

Swept over 882 served answers (7 volatilities × 7 horizons × 9 fee APRs × 2 concentration factors),
calling the shipped `lpBracketRefusal` rather than a paraphrase of it:

| outcome | count |
| --- | --- |
| proved | 756 |
| no breakeven exists at all (the engine returns null; horizon fees exceed the 100% a bounded loss can reach) | 112 |
| refused by the CEILING | **14** |
| refused by the encoder | 0 |
| replay disagreements | 0 |
| exceeded the bound | 0 |

The ceiling is reached, not defensive. `σ = √(v/T)` has unbounded slope at `v = 0`, so for a small
enough breakeven variance the coarsest bracket whose straddle still survives the 1e-9 grid maps to a
range of volatilities wider than 5 decimals. Exceedances in that corner: 216%, 387%, 1,221%, 2,642% of
the ceiling at fee APRs of 0.01, 0.001, 0.0001 and 0.00003 at a one-period horizon. The worked refusal
in the gate cites ±`3.6146e-5` against the `5e-6` allowed — 7.2×.

Refusals a reader sees without a witness, each named rather than collapsed into a silent absence:
realized-IL-only (no `feeVsDivergence` block at all), volatility without `feeAprPct`, fees at or above
100% of capital, and a fractional `horizonPeriods` (the circuit carries the horizon as a 24-bit
integer).

The encoder refuses eight further shapes with a sentence each — a fee fraction that rounds to zero, a
bracket under two grid steps, a horizon past 2²⁴, a variance past 2⁴⁶, a straddle that does not survive
the grid, endpoints out of order, a saturated expectation that underflows the grid, and a bracket
narrower than the fee's own grid rounding.

One refusal path is **unreachable** and is now measured rather than left as undecided code: the search
gives up if the doubling passes `v = 1e4`, and it cannot — the quadrature saturates at exactly −1 well
before then, so the doubling terminates at `hi ≤ 64` for every one of 999 fee levels tested.

### The circuit says no

- 13 of 13 moved public signals refused by `snarkjs plonk verify`; a bent proof point refused.
- 9 of 9 dishonest witnesses refused by the witness calculator before a proof exists: a non-straddling
  bracket, a reversed bracket, a root off the midpoint, a volatility that is not the root of the
  midpoint, a width bound narrower than the bracket, fees at 100%, endpoints in increasing order, a
  zero horizon, an expectation past the −100% bound.
- **Smallest rejected volatility perturbation: 1 grid step (1e-9).** That is the resolution at which the
  circuit pins the answer, against a display half-unit of 5e-6 — 5,000× coarser.

### Monotonicity, and a published number that must not be over-read

`doesNotProve` says monotonicity of `E[IL]` in variance — the property that makes a straddled root
UNIQUE — is established by sweep and not by the circuit. So the sweep is run in the gate, and it does
not say what `zk/build/gateLP1-bracket-sweep.json` invites:

That artifact publishes `nonDecreasingSteps: 0` over 20,001 log-spaced `v` in `[1e-8, 1e4]`. The field
counts steps where the value INCREASES. Asking for STRICT decrease over the same range finds **2,673 of
20,000 steps flat**. Reading `0` as "strictly monotone" is an overclaim.

Uniqueness survives, and the reason had to be checked rather than asserted — my own second draft
assumed every flat step sat at exactly −1 and found 49 that did not:

| measurement | value |
| --- | --- |
| increasing steps | 0 of 20,000 |
| flat steps | 2,673 |
| flatness begins at | `v ≈ 240.547` |
| last strictly decreasing step | `v ≈ 266.440` |
| largest `L = 1 + E[IL]` among the flat steps | `5.9952e-15` |
| `L` at which the steepest expressible fee (`f = 1 − 1e-9`) puts its root | `1e-9` — **1.67e5× above** |
| deepest root any expressible fee level can have | `v = 165.786`, below where flatness starts |

So the flat run is the double-precision floor near −100%, it cannot contain a root of
`g(v) = E[IL](v) + f` for any fee level the 1e-9 grid can express, and the region where the root
actually lives is strictly decreasing.

**And on the true function it is a theorem, not a sweep.** Once `E[IL](v) = exp(-v/8) − 1` is exact,
`d/dv E[IL] = −(1/8)·exp(-v/8) < 0` for every finite `v` — strictly decreasing everywhere, with no
range restriction and nothing to sweep. So the 2,673 flat steps are a property of *the engine's
quadrature in double precision*, not of `E[IL]`, and the sweep is needed only because the engine
bisects the quadrature rather than the closed form. That is a stronger statement than "swept, not
proven", and it is the one the buyer should be given: uniqueness of the straddled root follows from
four lines of algebra, and what the sweep adds is that the *engine's* copy of the function has not
saturated anywhere a root can sit.

---

## 6. The scripted revert found two holes in my own gate

Seven reverts, each required to make gate LP go red. Two did not, and both were real gaps:

**Revert 2 — encode the exact closed form instead of the engine's quadrature.** The gate stayed green
through all twelve tests. It stayed green because the substitution moves only the two values the circuit
does not prove, by about one grid step, while the straddle has 104 and 1,772 grid steps of margin: the
certified volatility does not change and no bound notices. That is a true fact about the coverage of
this certificate, and it is *also* a labelling defect, because the response calls those signals "the
engine's 401-point quadrature". LP.4b now recomputes the endpoint integers from the engine's own
compiled source and counts how many the closed form would encode differently — 172 of 446 on the swept
brackets, so the check discriminates. 45.4% of served brackets have such an endpoint.

**Revert 6 — compare against the served rounded figure.** The check existed; the SWEEP was wrong. The
search targets the served digit and reaches it on every row of LP.6's horizon grid, so the rounded
equality never fired. The cases it would refuse are found by sweeping fee levels finely instead — 7 of
784, the first at `T=1, feeAprPct=0.0244`, where the certified `0.002314519` displays as `0.00231`
against a served `0.00232` while sitting `1.08e-6` from the engine's own root inside a `2.05e-6` bound.
LP.6 arm B is that sweep.

The other five went red on the check they were written for: a rearranged quadrature (LP.1, which
compiles the engine's own source and demands bit equality), the ceiling widened to the half-cent (LP.2,
LP.6, LP.7), the bound turned into a derivative (LP.2b), the factor-of-two restored (LP.6), and the
served-digit stopping condition dropped (LP.6).

---

## 7. `proves` / `doesNotProve`

The pair the response publishes, in short. `perp-gate` set the precedent that a proof of a CEILING must
not be advertised as a proof of the number the service leads with; this is the same discipline, and here
the unproven part is larger than the proven part.

### Proves

That `feeVsDivergence.breakevenVolatility` is the root of a function whose sign CHANGES across a narrow
bracket, and that the volatility served is the square root of that bracket's midpoint. Six inequalities
over 13 published integers on a 1e-9 grid: the ordering, the straddle at both ends, the endpoint order,
the midpoint to one grid step, the width bound with its slack published, and `σ̂²·T = v̂*·S` to a
tolerance the circuit computes from its own signals and publishes. **The circuit evaluates the
quadrature zero times** — the engine needs 163,608 exponentials and 82,016 roots for one served
breakeven; the certificate is two evaluations wide, in 1,776 constraints.

### Does not prove

1. **That the two endpoint expectations are the true ones — the larger half.** `eLoHat` and `eHiHat` are
   the engine's 401-point quadrature at the bracket ends. They arrive as PUBLIC INPUTS and nothing in
   the circuit certifies them: a caller who supplies two wrong numbers that happen to straddle gets a
   valid proof of a false breakeven. They are published in the signals and on the record precisely so
   this cannot be missed, and each can be checked in one line against `exp(-v/8)`.
2. **`expectedDivergence.expectedIlPct` — the percentage the service leads with.** That IS the
   quadrature, and it is assumed here rather than proven. `lpexpectation.circom` is the circuit for it
   and is 8.94× over the ceremony file.
3. **`realizedIL`.** A different identity in a different circuit (`divergence.circom`), not reached from
   this handler.
4. **Monotonicity of `E[IL]` in variance**, which is what makes the straddled root unique. A property of
   the function, established by sweep (section 5), not by any proof.
5. The fee arithmetic, the concentration factor, the USD figures, the verdict sentence.
6. Anything about a real pool, position, or realized volatility. Every input is caller-supplied. This is
   arithmetic about numbers it was handed, not evidence that any of them was true.

---

## 8. What a buyer still has to trust

- That `exp(-v/8) − 1` is `E[IL]`, if they use the one-line check on the two assumed values instead of
  running a 401-point quadrature. The derivation is four lines and reproducible; the agreement with the
  engine is `1.419121e-9`, which is the engine's own window truncation.
- That `E[IL]` is monotone where the root lives. On the true function this is a theorem — `exp(-v/8)`
  is strictly decreasing — so what is *swept* rather than proven is that the engine's double-precision
  quadrature has not saturated anywhere a root can sit. See §5.
- That their own inputs describe their position. No circuit can supply that; for lp-risk the
  input-attestation question does not even arise, because nothing is fetched — `inputClaims.js`
  classifies it `NOT_NEEDED` for exactly that reason.
- That the headline percentage is right. It is not covered. If that is what matters to them, the honest
  answer today is a bigger ceremony file, not a cleverer circuit.

## 9. The next honest step, with its cost

Closing gap 1 means pinning `exp(-v/8)` in-circuit rather than assuming the two endpoint values. It is
not out of reach: the relevant `v` is `−8·ln(1−f)`, which for ordinary fee levels is small (0.132 for
the worked case), and argument reduction plus a short Taylor series and a few squarings is a known
shape. It is a new circuit, a new ceremony fit, new sweeps and a new bound — not an edit to this one,
and not something to land in the same batch as a wiring. `lpexpectation.circom`'s 36,613 constraints are
the measurement of what the *general* version of that costs.

---

## 10. Independent re-verification, and one number corrected

The wiring above was built and left staged but uncommitted. It was re-verified from scratch before being
committed — the point of the pass was to try to break it, not to confirm it.

**The closed form was re-derived independently and agrees.** Symmetrising the density rather than the
integrand: the even part of `N(−v/2, v)` is `φ(x/√v)·e^{−v/8}·cosh(x/2)/√v`, and since
`2√r/(1+r) = sech(x/2)` is even in `x = ln r`, only that even part contributes. `sech·cosh = 1` collapses
the integral to the total mass, leaving `E[IL] = e^{−v/8} − 1` **exactly**. Same result, different route.

**The residual was reproduced against the engine's own bytes.** `expectedIlNumerical` is not exported and
the served field is `round(·,4)` percent — 1e-6, three orders too coarse to see 1e-9. So the function under
test was *extracted from `src/engine/lpRisk.js` by regex and evaluated*, rather than transcribed, and then
held to the real `lpRisk()` output: **400 samples, 0 mismatches**. On that function:

| measurement | this pass | doc above |
| --- | --- | --- |
| supremum `\|closed − engine\|` | `1.419120793e-9` at `v = 1.1258725` (2,000,001-point brute scan of `[1e-3, 30]`) | `1.419121e-9` ✓ |
| `2·Q(6)`, two independent methods agreeing to `3.06e-12` rel. | `1.9731752900753966e-9` | `1.973073e-9` ✗ **corrected** |
| residual / discarded weight | `71.9209%` | `71.92%` ✓ |
| worst honest case / derived bound | `99.7384%` (gap `1.273964e-6`, bound `1.2773060e-6`) at `σ=0.005, T=90, fee=5%` | `99.7384%` ✓ |

The one wrong number was the tail weight: `1.973073e-9` came from a low-accuracy `erfc` and is wrong in
the 5th digit. Recomputed by a Legendre continued fraction and by an endpoint-clustered quadrature, which
agree with each other to `3.06e-12` relative, it is `1.9731752900753966e-9`. The `71.92%` ratio it feeds is
unchanged by the correction — which is exactly why it survived review. Corrected in `lpBracket.js` (a
comment; **no served byte and no contentHash moves**) and in this document. It appears nowhere else.

**The bound was re-derived from the geometry, not read from the encoder**, as
`|certifiedσ − σ(m)| + max_{y∈[lo,hi]}|σ(m) − σ(y)|` with `m = v̂*/S` — no derivative, no linearisation,
endpoints because `σ(v) = √(v/T)` is monotone. Over 882 calls to the real engine (798 proved, 84 with no
breakeven, 0 refused, 0 diverged):

- the encoder's bound is **≥ mine on 798 of 798**, looser by at most 6.287e-2 relative — so it is
  conservative, and sound;
- against **my own tighter bound** the worst honest case uses **99.7963%**, with **0 violations**.

That ~0.2% of headroom is not a near-miss, and it should not be read as one. `findBracket` deliberately
keeps the **widest** bracket that still qualifies, so the engine's root may legitimately sit at a bracket
endpoint — which is precisely where `max_y|σ(m) − σ(y)|` is attained. The bound is therefore tight *by
construction*: its worst case is the supremum being reached, not luck running out. Tightening it would
mean narrowing the bracket, which shrinks the straddle margin and starts destroying straddles on the 1e-9
grid — the trade §4 already describes.

---

## 11. A third pass: "it appears nowhere else" was wrong, and §8's conclusion is refuted

A later session was briefed to *wire* these circuits and found the bracket already wired. What that pass
produced instead is one defect and one measurement, both of which change a claim above.

### 11.1 The corrected constant was still being computed the old way, in the gate

§10 corrected `2·Q(6)` from `1.973073e-9` to `1.9731752900753966e-9` and closed with: *"Corrected in
`lpBracket.js` (a comment) … and in this document. **It appears nowhere else.**"*

**It appeared in one more place: `gates/gateLP-bracket-snark.mjs`, test LP.3, computed live.** The line was

```js
const droppedWeight = 2 * phi(6) * (1 / 6 - 1 / 6 ** 3 + 3 / 6 ** 5 - 15 / 6 ** 7);
```

— the **asymptotic** Mills expansion, a *divergent* series truncated at four terms. So the gate that
exists to make §2's table reproducible was printing `dropped weight outside |z|<=6 = 1.973073e-9` while
the document above and `lpBracket.js`'s header both said `1.973175e-9`. Measured:

| | value | relative error |
| --- | --- | --- |
| what LP.3 computed | `1.9730731536709662e-9` | **5.176e-5** |
| Mills continued fraction (convergent) | `1.9731752900753966e-9` | — |
| Simpson tail quadrature (independent) | `1.9731752900753221e-9` | `3.77e-14` vs the above |

The continued-fraction value matches §10's figure to the last digit. **The correction had landed in two
comments and a document and never in the code that computes it** — which is the same prose-and-code drift
this file's §6 describes, one level up: a gate is code too.

**Why it survived a pass whose stated purpose was to break things.** The only published consequence is the
`71.92%` in the served `doesNotProve`, and that is identical either way — **71.924377%** wrong,
**71.920654%** right. §10 predicted exactly this ("which is exactly why it survived review") and then drew
the wrong boundary around it. A constant whose published consequence is insensitive to its own error is
the one that drifts, because nothing downstream complains and a grep for the *literal* corrected value
finds only the places already corrected.

**Fixed in LP.3, four ways rather than one**, since a single uncross-checked formula is how this lasted:
the weight now comes from the convergent continued fraction; an independent Simpson tail is computed
beside it and the two are asserted to agree to better than `1e-9` relative; the value is **pinned by
equality to the exact figure `lpBracket.js`'s header states**, so prose and code can no longer drift; and
the superseded asymptotic form is asserted *not* to be what is published.

**`gateLP-revert.mjs` gained revert 8** — the divergent series put back, LP.3 required to go red. It is the
first revert here that targets **the gate file itself**, on the principle that a verifier's own arithmetic
needs a revert as much as the code it verifies. **8 of 8** reverts now go red on their nominated test and
the gate returns to 13/13. That script's header also claimed "six" while the list held seven; the count is
now computed from `REVERTS.length`, and the run asserts every declared revert actually executed rather
than reporting PASSED over a subset.

**No served byte moved.** Nothing on a request path reads this constant, the `71.92%` the response
publishes was and is correct, and no contentHash moved.

### 11.2 The residual, reproduced a third time and independently

Re-transcribed from `src/engine/lpRisk.js:23-35` and swept at 200,001 points on three domains:
`[0.2, 10]` linear, `[1e-8, 1e4]` log, and `[0, 200]` linear. All three give a supremum of
**`1.419121e-9`** (at `v ≈ 1.1256`, `1.1255`, `1.125` respectively) — agreeing with §2 and §10.
`2·Q(6)` reproduced two independent ways agreeing to `6.523e-13` relative. The brief's three figures
were re-tested and §2's verdict on each is confirmed: `1.9786e-9` is not attainable as this residual at
any node count tested (100 → 102,400); "invariant in N" is false, the supremum rising monotonically and
saturating near `1.5522e-9`; and the widened-window value is a few-ulp floating-point floor
(`2.66e-15`–`3.77e-15` depending on window), not the specific `2.4425e-15`.

One methodological note on §2's provenance row: the **golden-section refinement is not reliable here.**
`|closed − engine|` is not unimodal on `[1.0, 1.3]`, and golden section converges to `1.414605e-9` at the
bracket edge `v ≈ 1.29999` — *lower* than the true supremum. The 200,001-point brute scan is the binding
measurement and it is the one that agrees across all three domains.

### 11.3 The ceremony file is NOT what blocks block 2 — measured

**§8 says: *"If that is what matters to them, the honest answer today is a bigger ceremony file, not a
cleverer circuit."* That is now refuted, and §9's "new ceremony fit" is measured rather than open.**

`lpexpectation.circom`'s 36,613 constraints are the cost of encoding **the engine's quadrature**, strided
to 81 nodes, and it was written before the closed form was found. A circuit for the **closed form** needs
*one* exponential — not 81 nodes each carrying the per-node division its own header names as the binding
cost. Nobody had measured that. Measured now:
`zk/scripts/probe-lpclosed-cost.mjs` → `zk/build/probe-lpclosed-cost.json`.

`exp(−v/8)` by range reduction and repeated squaring, every intermediate in `(0, 1]` so no signal ever
needs a sign: `t = v/2048`, 12 Taylor terms for `exp(−t)`, then 8 squarings. Each step is one
range-checked fixed-point rescale; the alternating-sign polynomial is a single linear combination and so
is free.

| | |
| --- | --- |
| **constraints** | **2,857 non-linear + 166 linear = 3,023** |
| snarkjs cross-check | `3,023` — agrees |
| `hez_final_12` ceiling | 4,096 — this uses **73.8%** |
| for comparison | `lpexpectation` 36,613 (8.94×) · `lpbracket` 932 · `divergence` 463 |

Both constraint lines are parsed with start-anchored patterns and the total is cross-checked against
snarkjs, because `/linear constraints: (\d+)/` also matches `non-linear constraints: 2857`.

**And the witness closes exactly.** Over 40,000 variances in `(0, 166]` — the domain where
`L = exp(−v/8)` is still nonzero on the 1e-9 grid — against an **independent 40-digit BigInt reference**
with its own range reduction: **0 tolerance violations**, and worst error **0 grid steps**. The scheme
lands on precisely `round(exp(−v/8)·1e9)` everywhere. The per-step residuals use 99.999–100.0000% of
their tolerance, which is correct by construction and not a near-miss: round-to-nearest gives
`|r| ≤ SS/2`, so `2|r| ≤ SS` is exactly tight — which is also why `TOL = 1` is the right tolerance and
not slack, since any witness that is not round-to-nearest fails it.

### 11.4 So what does block it — and why this was NOT wired

**It would certify a number the service does not serve.** The circuit certifies `exp(−v/8) − 1`; the
engine serves the 401-point quadrature. On the same domains:

| domain | 4-dp percent mismatches |
| --- | --- |
| 40,000 `v` in `(0, 166]` — the live domain | **3** — 1 in 13,333 |
| 200,001 log-spaced `v` in `[1e-8, 1e4]` | **43** — 1 in 4,651 |

On roughly one request in 13,333 the proof and the response beside it would **disagree in the last digit
the response prints**. The gap being 0.28% of the display half-unit does not rescue it — *a gap under
half a step is not the same claim as rounding to the same figure*, the distinction `gateLP2` already had
to make about striding by 8, and §2 already makes about `v = 0.759`. This is also exactly the
substitution **revert 2** exists to catch. The standard for this work is *never re-derive an engine
expression outside the engine — lift it, or prove agreement over the whole domain*; the measurement is
**disagreement**, so the standard forbids it, and forbids it correctly.

**The honest fix is engine-side and it is one line.** `expectedIlNumerical(v)` could be
`Math.expm1(-v / 8)`: exact instead of approximate, 802 exponentials down to 1, and the truncation floor
that §2 spends a table on disappears entirely — the quadrature is not a better answer than the closed
form, it is a worse one. That moves `q1-e1fa99d08887d6cc` and every contentHash in the service.
**`src/engine/` must not be touched and contentHashes are frozen, so this is a decision and not a task.**
It is recorded here so whoever unfreezes the engine knows the circuit is already costed at 3,023
constraints inside the ceremony file on hand, the witness scheme already verified exact, and the only
open question is whether to accept the hash movement.

No larger ptau was downloaded, and none is needed: the closed-form design fits in `2^12`.

### 11.5 What this pass ran

`npm test` **386 tests, 381 pass, 5 skipped, 0 fail** — unmoved. `tools/docs-consistency.mjs`
**CONSISTENT**. `gates/preflight.mjs` **PASSED**, with `http:lp-risk` and `mcp:lp_risk` both in the
pinned proof-emitting set — **six** proof-emitting services, which is the live answer to a brief that
listed four. `gateLP-bracket-snark.mjs` **13 pass, 0 fail**. `gateLP-revert.mjs` **PASSED**, 8 of 8.
`zk/scripts/probe-lpclosed-cost.mjs` **COMPLETE**. `src/engine/` byte-identical to the mirror by
whole-directory diff and clean in git; `q1-e1fa99d08887d6cc` unmoved on both sides of a script that
rewrites three files.

One harness note, since it cost a false alarm: **`gateLP-revert.mjs` is a plain script, not a test
file.** Run under `node --test` it restores every file correctly and then fails on
`could not read the runner summary`, because it parses a runner summary that nested test output does not
produce. Run it as `node gates/gateLP-revert.mjs`.

`src/util/lpBoundedness.js`, `src/engine/lpRisk.js` and `docs/verify-lp-risk.md` were left alone — a
concurrent session holds all three, and `verify-lp-risk.md` had uncommitted gas-attribution edits in the
working tree. `docs/verify-lp-risk.md` still carries §8's superseded conclusion in the row *"what
actually blocks the quadrature: the ceremony file"*; that row is true of `lpexpectation.circom` and is no
longer true of the problem, and it is that session's file to correct.

**Everything green on this pass**, measured not restated: `npm test` **386 tests, 0 fail**;
`tools/docs-consistency.mjs` **252 documents consistent**; `gates/preflight.mjs` **PASSED** with
`http:lp-risk` and `mcp:lp_risk` both in the pinned proof-emitting set and both exempted *by name* from
1e-9 field snapping; `gateLP-bracket-snark.mjs` **13 pass, 0 fail**; `gateLP-revert.mjs` **PASSED** — all
seven reverts go red and the engine build id is unmoved. `src/engine/` is byte-identical between the two
trees by whole-directory diff and clean in git; `q1-e1fa99d08887d6cc` did not move.
