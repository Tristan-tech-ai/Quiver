# Four Phase B services were told they could not be proven. Three of the four walls were made of nothing, and nobody attacked the new claims

**Written 30 July 2026.** Four services — `portfolio-gate`, `exec-verify`, `lp-risk`, `options-risk` —
were each investigated for whether their zk proofs can be wired. Every negative verdict was to be
handed to an adversary briefed to refute it. **No verdict came back negative, so the adversary ran
zero times.** That is the single most important sentence in this document and it is why the second
half of it is longer than the first.

Everything in the tables below is either measured today from artifacts and running code, or is
labelled as a claim nobody has measured. The distinction is drawn by section, not by tone.

| measured today, in this session | result |
|---|---|
| engines a caller can obtain a proof from | **3 of 22** — `perp-gate`, `size-gate`, `treasury-risk` |
| where that 3 was read from | `gates/preflight.mjs`, which enumerates both handler arrays and prints the proof-emitting set |
| engines that would carry a proof if every *buildable* item here were wired | **7 of 22** |
| engines with any compiled circuit today | 7 of 22; the other 15 have no circuit of any kind |
| adversarial refutation passes actually run against these four | **0 of 4** |
| new circuits, proved and verified | 4 — `portfolioleg`, `execadverse`, `lpbracket`, `ncdf` |
| new circuits compiled but never set up | 1 — `lpexpectation`, 36,613 R1CS against a 4,096 ceiling |
| new gates, green in their own runs | 8 |
| `npm test` | 386 tests, 381 pass, 5 skipped, 0 fail |
| engine build hash | `q1-e1fa99d08887d6cc`, unmoved — `src/engine/` untouched |
| `node gates/preflight.mjs` | 24 PASS, 1 FAIL, exit 1 — the one red is the unpublished-changelog check |
| deployed | nothing |
| new defects found by this round that reached the defect register | **0 of 4** |

---

## 1. One row per service

| service | what the brief claimed was in the way | what measurement said | adversary | what is now buildable |
|---|---|---|---|---|
| `portfolio-gate` | a **structural** wall at 3 legs: the wide circuit outgrows the ceremony file on disk at N=4 | arithmetic exact to the digit, framing wrong. N=3 is 2,053 R1CS / 3,970 Plonk; N=4 is 2,736 / 5,295 and needs 2^13. But the wall was a download, and the download is the wrong lever — a per-leg circuit at 651 R1CS / 1,267 Plonk fits the file already on disk and has no leg cap at all | **not run** — verdict was positive, so the pass never opened | nearest-liquidation leg over **any** number of legs, 11 proved, minimum taken on chain. Also found: `gateB6`'s router ranks by price and names a leg 4x further from liquidation than the binding one |
| `exec-verify` | three blockers: `inEff` unpublished, encoder loses 64 grid steps above 9e6 reserves, and the headline bps has no circuit signal | 1 of 3 survived. `inEff` is already public signal 8 of `constantproduct` and the fee identity pins it to a unique grid integer on 3,988 of 4,000 trades. The 64 steps are real but belong to an encoder already fixed and post-mortemed. The headline genuinely had no signal | **not run** — verdict was positive | the published `adverseExecutionBps` itself, plus an **exact** shortfall in output tokens with no tolerance term, at +504 Plonk over the existing benchmark circuit and no new ceremony file |
| `lp-risk` | two walls: a square root and a 200-iteration bisection, neither with an identity to restate | both counts right, both reasons wrong. The square root is 194 R1CS of already-green work. The bisection has a bracket certificate, now built at 932 R1CS / 1,776 Plonk. The quadrature has a geometric restatement agreeing to 5.218e-15 with no transcendental primitive | **not run** — verdict was positive | the published fee-breakeven volatility, certified as the root of the bracket the search returned. `expectedIlPct` stays uncertified — one unproven object instead of two |
| `options-risk` | the normal CDF cannot be computed in-circuit, so the residue stays open | premise wrong, same shape as Tier 3. The engine computes Hart (1968), not `erf`: a ratio is a multiply, two polynomials are Horner, and the one exponential factors over the binary expansion of its argument into a product of selected constants. The wall was fixed-point representation | **not run** — verdict was positive | the standard normal CDF **and** its density, computed in 2,012 R1CS / 3,740 Plonk, to a derived envelope of 1.09e-11 and 9.09e-12. Also found: `parity.circom` and `greekssigned.circom` both have headers claiming more than they deliver, each demonstrated with a real accepted proof |

Read the adversary column as a single fact rather than four. The refutations reported in each row are
**self-refutations of the brief's blockers**, produced by the same agent that then made the new claims.
No independent pass attacked any of the four new claim sets. Section 3 is the substitute for that pass:
it is what an adversary would have found first, obtained by re-measuring the artifacts.

---

## 2. The numbers behind each row

Every constraint count below was read today out of `build/*.r1cs` headers and `build/*_plonk.zkey`
section-2 headers, independently of the agents' own runs. All sixteen agreed to the digit — including
`kelly` at 372, which is the number that started this project's habit of reading counts back from
artifacts rather than from what `circom` printed.

That reader was itself checked rather than trusted. The `.r1cs` count needs a 24-byte step from
`nWires` to `nConstraints`, and one agent's inlined version stepped 20 and read a zero out of
`nLabels` — with a row below it that passed **green on zeros**. So my own reader was cross-checked
against `snarkjs` through `scripts/circuit-facts.mjs` on `ncdf`, which returned 2,012 / 3,740 / 7 /
4,096, identical to the hand-parsed figures, and every count was asserted nonzero before being
believed.

| circuit | R1CS | Plonk | domain | public signals | zkey exists |
|---|---|---|---|---|---|
| `liquidation` (wired) | 667 | 1,301 | 2,048 | 8 | yes |
| `kelly` (wired) | 372 | 718 | 1,024 | 5 | yes |
| `concentration` (wired) | 451 | 834 | 1,024 | 12 | yes |
| `portfoliogate` | 2,053 | 3,970 | 4,096 | 28 | yes |
| `portfoliogate4` | 2,736 | — | needs 8,192 | 37 | **no — setup never run** |
| `portfolioleg` (new) | 651 | 1,267 | 2,048 | 10 | yes |
| `constantproduct` | 671 | 1,293 | 2,048 | 10 | yes |
| `execadverse` (new) | 932 | 1,797 | 2,048 | 15 | yes |
| `divergence` | 463 | 887 | 1,024 | 7 | yes |
| `lpbracket` (new) | 932 | 1,776 | 2,048 | 13 | yes |
| `lpexpectation` (new) | 36,613 | — | needs 65,536+ | 3 | **no — 8.94x over the ceiling** |
| `ncdf` (new) | 2,012 | 3,740 | 4,096 | 7 | yes |
| `greeks` | 1,103 | 2,152 | 4,096 | 13 | yes |
| `greeksfp` | 1,065 | 1,919 | 2,048 | 13 | yes |
| `greekssigned` | 1,952 | 3,615 | 4,096 | 29 | yes |
| `parity` | 1,153 | 2,255 | 4,096 | 13 | yes |

### 2.1 `portfolio-gate` — the ceiling was a download, and the download was the wrong lever

The per-leg circuit is **34 Plonk gates smaller than `liquidation`** while proving strictly more: it
carries the mark and the adverse distance as public signals so the minimum can be taken outside the
circuit. Bit widths went back to full parity with `liquidation` — margin 2^80, size 2^60, price and
mark and distance 2^60 — which three legs in one domain could not afford.

The leg ceiling is measured, not assumed. `maxItems` appears **0 times** in the whole service tree
across `.js`, `.mjs`, `.json` and `.md`. The only bound in `src/engine/portfolioGate.js` is a lower
one, `if (!positions.length) return { ok: false, errors }`. So the gap was never 3-vs-4; it was
3-vs-unbounded.

Verify gas by leg count, one fresh EVM per row, read out of `build/gateB10-portfolio-perleg.json`
today rather than transcribed:

| legs | 1 | 3 | 4 | 6 | 8 | 11 |
|---|---|---|---|---|---|---|
| gas | 276,656 | 814,655 | 1,084,902 | 1,622,716 | 2,161,547 | 2,969,816 |

Marginal cost is 269,316 gas per leg over the 1-leg row. The wide 3-leg verifier costs 292,124, so
**11 per-leg proofs verify for 10.17x what one wide 3-leg proof costs** — and a single per-leg verify
is 15,468 gas cheaper than the wide 3-leg one. Latency, both routes in the same process on the same
three legs: wide 1,568 ms for one proof; per-leg 2,307 ms serial and 801 ms parallel. At 11 legs,
8,550 ms serial and 863 ms parallel. So 11 legs in parallel beat one wide 3-leg proof in wall-clock,
because Plonk pays for the domain and the per-leg domain is half — and the honest other half is that
8,550 ms is more total prover work and the parallel figure needs 11 workers.

Refusal rate over 200 seeded synthetic books per size, encodability only: 4 legs 195/200, 6 legs
192/200, 11 legs 189/200. Refused legs 5 of 800, 8 of 1,200, 14 of 2,200. Ordering splits 0 at every
size. **Every single refusal was a distance divergence; zero were bounds refusals**, which is the
wider bit widths earning their place.

The ranking defect is in the artifact and reproduces: the engine names leg 10, ratio ranking names leg
10, and `gateB6`'s price ranking names leg 3. A router that verified 11 real proofs still named the
wrong leg, because it compared the wrong field. That is the counterexample proving the certification
is not free.

### 2.2 `exec-verify` — the snark stopped one step short of the number the blurb leads with

`execadverse` carries `constantproduct`'s fee identity and invariant forward unchanged and adds three
things: the realized fill as a public signal, the shortfall as `shortfall === outHat - realizedHat`
with **no tolerance term at all** — both sides are already integers on the shared grid, so the figure
a dispute is denominated in is certified exactly — and the headline as `b*out = 10000*S*shortfall`
held to a bound proportional to the fill rather than constant. Cost: +261 R1CS, +504 Plonk, +5 public
signals, **domain unchanged**. No new ceremony file.

The derived bps bound is 5.0000e-3 bps in total, of which the engine's own `round(bps, 2)` display
step is 99.99%. The worst honest case over 3,596 trades uses 99.97% of it. That bound was then shown
to be exceeded five ways: a mid-price benchmark is refused on 3,596 of 3,596 at up to 214,614x; a
1e-6 relative slip on 95.9% at up to 3.1x; a 1e-7 slip on 9.1% at up to 1.2x, so the two slips
bracket the derivation's own 5e-7 crossover from both sides. Two candidates were **not** refused and
were recorded with reasons rather than quietly dropped.

The self-catch is worth as much as the circuit. The first version of the bps bound read its
denominator off the value under test, so the allowance expanded to cover whatever the encoder had
just done — and the proof that it was worthless is that it then failed to refuse an encoder this
repository is on record as having had wrong. That is the disease this project names: a verifier that
cannot fail.

### 2.3 `lp-risk` — 245,624 transcendental calls, and the expensive one was never the wall

Instrumented, counted rather than inferred: a full `lp-risk` call makes **163,608 `Math.exp` and
82,016 `Math.sqrt` calls**. That decomposes exactly — 163,608 / 802 = 204.0 quadrature passes per
served answer, being 1 headline + 1 doubling probe + 200 bisection + 2 self-checks. The figure
previously reported as "roughly 80,000 transcendental evaluations" is 204 x 401 quadrature *points*;
read as evaluations it undercounts by 3x.

`lpbracket` certifies the bisection by its **bracket** rather than by replaying it: `g(lo) > 0 >= g(hi)`
as two integer comparisons, `2v* = lo + hi` to one grid step, `hi - lo <= w` with the unused slack
published, and the breakeven's own square root stated on the squared quantity. No division, no series,
no quadrature inside the circuit. 600 real service calls, 562 certified, 3 encoder refusals, 35 engine
nulls, **0 strayed from the served figure**. Monotonicity of E[IL] measured at 0 non-decreasing steps
over 20,001 samples. The derived tolerance's worst case uses 96.3% of it, and a 2-grid-step
perturbation is shown to drive it to 2.938 and be rejected while 1 step is accepted at 0.9873 — a
band, not a knife edge.

The engine performs 200 halvings; the number that actually pins the published 5-decimal figure is
between **12 and 25** across 562 certified calls. After 200 halvings the bracket is 2.8e-17 wide and
both ends land on the same 1e-9 integer, so `lo < hi` is not even expressible.

And a defect found in passing, not fixed because `src/engine/` is frozen: `lpRisk`'s own boundedness
self-check tests `round(E[IL]*100, 4) > -100`, so at sigma^2*T >= 116.0687404 it reports `pass: false`
on a value of -0.999999999999998, strictly inside the interval it is checking. `proof.js` turns that
into `allChecksPass: false` in the envelope. A live call at sigma 0.62 over a year ships that way.

### 2.4 `options-risk` — the identity family is blind to the CDF, and `parity` is blind algebraically

The eight consistency identities hold to 4.01e-13 across 5,000 surfaces. They also hold, **unchanged
to 3.3e-14, while a leg is priced 19.40% wrong** under Abramowitz-Stegun 7.1.26, 199.13% wrong under
a logistic surrogate, and 100.00% wrong under an arbitrary odd perturbation. A-S's residual on one
identity is *smaller* than the correct engine's — the signature of a cancelling quantity rather than a
tested one.

`parity.circom` is worse than approximately blind, and this is the one claim in the four reports I
verified structurally rather than taking on trust. Its two constraints are `cpDiffHat * SCALE ===
dfHat * fkDiffHat` and `dCallHat + dPutHat === dfHat`. Neither contains a CDF term. With any `N`
satisfying `N(-x) = 1 - N(x)`, the put reduces to `C - df*(F - K)` identically, so `C - P` is
independent of `N` and the delta sum is `N(d1) + (1 - N(d1))`. The engine's own implementation returns
`x <= 0 ? c : 1 - c`, so it has that symmetry. A whole book repriced with A-S produces a parity proof
that verifies with `C - P` off by 7.276e-12. Parity is not a weak check on the price level; it is not
a check on the price level at all, and its header says otherwise.

`ncdf` closes the residue rather than moving it. Hart's own exponential intermediate *is* the density
up to a constant, and that intermediate is the `df*phi(d1)` factor which cancels between any two
greeks — the reason the identities could exist without a transcendental. Pin it and it stops
cancelling. Measured: envelope 1.09e-11 on N and 9.09e-12 on the density, which on a $100,000-forward
leg is a $2.18e-6 price envelope. The worst case over 6,000 real legs uses 18.3% and 21.4% of the two
derived tolerances, 0 violations; 13 ulp out is refused at 15.197 against a limit of 12, and 2 ulp out
is accepted at 4.197. A-S is refused on 1,190 of 1,194 legs; the 4 that slip through are recorded with
their compounding across a multi-leg book (miss probability 3.35e-3 at one leg, 1.59e-20 at eight).
The relocation attack — solve `N_hart(x') = delta_wrong` and submit `x'` — is refused on 1,489 of
1,492.

Two of the agent's own checks failed first and were wrong about the thing they accused, and both were
converted into derivations rather than into patches: a guessed squaring threshold of 8 where the
amplification is `1+2+4+8 = 15` and the measured worst is exactly 15, and a tail bound of 6 ulp that
the real tail violates at 6.092, because `e^-25` at 2^-40 is the integer 15 and a value at the
representation floor cannot bound itself.

Bracketing was measured as the alternative and rejected on numbers: the best bracket, at 16,384
anchors, is **1.51e+6 times wider** than simply computing the value with 208 constants.

---

## 3. Every claim in this report that nobody measured

Ordered by how much a buyer or a judge could be misled by it. This section exists because the standing
rule here is that an unmeasured claim is worse than an admitted gap, and because a README once said
every gate had passed over a defect it could not see.

### 3.1 The adversarial pass never ran, so no new claim was attacked

All four verdicts were positive, the adversary was briefed only to refute negatives, and so **not one
of the four new claim sets was independently challenged**. What each agent did adjudicate was the
*brief's* blockers, and three of four briefs turned out to be wrong — which is evidence the briefing
process needs an adversary, not evidence that it has one. Concretely un-attacked:

- that `execadverse`'s exact shortfall really has no rounding argument left in it;
- that `lpbracket`'s bracket certificate cannot be satisfied by two wrong endpoint values that happen
  to straddle (the agent states plainly that it can — see 3.6);
- that `ncdf`'s derived envelope is the right envelope rather than a loose one;
- that `portfolioleg`'s cross-multiplied minimum cannot overflow or tie wrongly on real books.

### 3.2 Several figures in the four reports are already stale, and the gas ones cannot be quoted to the digit at all

Every gate artifact on disk was rewritten between 23:41 and 23:43 on 29 July — most likely by the
repo-wide gate spawn one agent reported as still running with buffered output. The gates passed in
both runs and every constraint count is byte-identical, but the gas and latency rows moved:

| figure | in the report | on disk now | delta |
|---|---|---|---|
| `portfolioleg` 11-leg verify gas | 2,968,446 | 2,969,816 | +1,370 |
| `portfolioleg` 1-leg verify gas | 276,448 | 276,656 | +208 |
| wide 3-leg verify gas | 291,708 | 292,124 | +416 |
| `execadverse` accept gas | 279,280 | 278,962 | -318 |
| `constantproduct` accept gas | 276,892 | 275,644 | -1,248 |
| `ncdf` accept gas | 272,672 | 273,406 | +734 |
| `ncdf` prove ms | 1,742 | 1,654 | -88 |
| 11 per-leg proofs, parallel ms | 793 | 863 | +70 |
| one wide 3-leg proof, ms | 1,634 | 1,568 | -66 |

I re-ran `probe-plonk-gas-variance.mjs` today to size that: across 12 different proofs of an
**identical** statement the spread is **3,230 gas, 1.22% of the mean**, and the probe's own advice is
that the error bar is about 3,500 gas. Two consequences the reports do not draw:

1. The `gateB6` 11-leg row has now taken three different values in three tellings — 2,941,443 quoted,
   2,944,135 read back as a correction, and **2,941,749 on disk today**. All three are inside the
   error bar. The correction was as unquotable as the thing it corrected.
2. **The marginal cost of `execadverse` over `constantproduct` is not resolvable at one sample per
   row.** The report gives +2,388 gas; today's artifact computes +3,318 from the same two gates. Both
   are smaller than the 3,500-gas error bar on either term. The +1,060 verifier *bytes* is real and
   deterministic; the gas delta is noise until it is a median over several proofs.

### 3.3 One report states something measurement contradicts

`portfolio-gate`'s note says `src/util/snark.js` "serves only perp-gate (liquidation) and size-gate
(Kelly)". Measured: it exports `witnessFor`, `kellyWitnessFor` **and** `concentrationWitnessFor`, and
preflight prints `treasury-risk` in the proof-emitting set on both surfaces. Three, not two. The
conclusion the note drew from it — that `portfolio-gate` is not snark-wired — is correct; the count
supporting it is not.

Two smaller ones, both harmless and both worth knowing the reports drift at this resolution:
`positions.length` is claimed at 21 hits across `src/`, `api/` and `sdk/` and measures **17** today;
`execadverse`'s tightest bps ratio is quoted as 0.99976 and the artifact records 0.9997165.

### 3.4 The `options-risk` work is not committed, and the commit it was reported inside no longer exists

The report says its 17 paths "landed inside a SIBLING's commit, 8901f04". Measured in `Quiver`:

- `8901f04` exists as a git object but is **not reachable from HEAD**. The reflog shows it was created
  and then removed by `reset: moving to HEAD~1`, exactly as the `exec-verify` agent described doing
  after its bare commit swept up a sibling's staged files.
- The 18 `ncdf` and `options-risk` paths are **staged and uncommitted** right now — `A ` in
  `git status`, contents intact, index-only.
- `main` is **6 commits ahead of `origin/main` and nothing is pushed**.

So the `options-risk` circuit, generator, five probes, gate and doc exist only in the working tree and
the index. Any `git reset --hard`, any `git checkout` of those paths, or any stash by a later agent
takes them out of the tree.

How bad that is, measured rather than dramatised: **all 18 staged paths are present in `8901f04`**, so
the content survives in the object store as a dangling commit until a `git gc` prunes it. `git
checkout 8901f04 -- <paths>` restores any of them. My first pass at this counted 15 of 18 and was
wrong because the grep was case-sensitive and `NcdfVerifier.sol` carries a capital N — recorded here
because a report about unmeasured claims should show its own correction rather than only its result. It
is still a housekeeping item that should be closed, and it is no longer an emergency.

### 3.5 Downloads that were never made, and sizes that were never measured

- **No 4-leg zkey exists.** `portfoliogate4.r1cs` is on disk; `portfoliogate4_plonk.zkey` is not.
  5,295 Plonk / domain 8,192 / 2^13 is what it needs, and that is where the measurement stops.
- **Proving time at domain 8,192 was not measured and deliberately not extrapolated.**
- The 2^13 and 2^14 ceremony sizes — 9,520,280 B and 18,957,464 B — come from HTTP HEAD requests one
  agent made against the Hermez bucket. I did not repeat them. What I can corroborate: the on-disk
  `hez_final_12.ptau` is **4,801,688 bytes**, byte-for-byte the Content-Length that agent reported
  for the same source, so the method was sound even though the two larger figures are unverified here.
- **The 2^16 / 2^17 sizes `lpexpectation` would need were never measured at all**, by anyone.
- `scripts/build-circuit.mjs` hardcodes `hez_final_12` at line 20 and a 4,096 ceiling at line 21, and
  refuses by name above it. That refusal is intact and was deliberately left intact.

### 3.6 What the circuits do not certify, stated by the agents themselves

- **Book completeness, in either shape.** Nothing binds submitted legs to an exchange account. A
  prover who omits the genuinely-nearest leg gets a true statement about the legs it did submit. This
  is identical in the wide and per-leg routes, so per-leg proving loses no soundness — and solves
  nothing here either. It is the input problem `QUIVER_ROADMAP_V2.md` already names as the end of the
  road.
- **`lpbracket`'s two endpoint values are public inputs and uncertified by construction.** A caller
  supplying two wrong expectation values that happen to straddle gets a valid proof of a false
  breakeven. Stated in the circuit header and in the published signals; it is residue, not oversight.
- **`lp-risk`'s expectation is not proven.** Only the R1CS count of `lpexpectation` is real. Its Plonk
  count, prove time and gas are unmeasured, and the 36,613 is an honest **floor**: the two Taylor
  seeds were pinned numerically (9 terms to 1.25e-13, 10 terms plus 9 squarings to 7.74e-13) but those
  constraints were never written, so they are not in the count.
- **Monotonicity of E[IL] is swept, not proven** — 0 non-decreasing steps over 20,001 samples on
  [1e-8, 1e4]. The circuit checks only the local order.
- **`concentrationFactor > 1` is out of scope entirely** for `lp-risk`, and the refusal-by-name that
  any wiring would need was not built.
- **`ncdf` pins N given x; it does not pin x.** The binding through gamma is real and measured at
  99.80% refusal of the relocation attack, but it is an **off-circuit** check the caller performs.
  Its constraint cost was not measured. The leg price needs `ncdf` twice — 7,480 Plonk against a
  4,096 ceiling — and neither the composed-proof route nor the larger-ceremony route was built or
  benchmarked.
- **`r != 0` was never tested for `options-risk`.** Identity E gains a term, and both the
  `delta = N(d1)` and `gamma = phi(d1)/(F*sigma*sqrt(T))` bindings assume `df = 1`.
- **The wrong-CDF detection was not tested against a CDF whose error is correlated with `d1`** — an
  adversary tuning its approximation to the legs it intends to publish. The three tried were a
  published approximation, a textbook surrogate, and an arbitrary odd perturbation.
- **`exec-verify` proves nothing about where the reserves came from**, which block they were read at,
  whether they predate a front-run, or that the caller received what they said. Same input problem.

### 3.7 The sweeps are synthetic where it matters

- `portfolioleg`'s refusal rate is 200 **seeded synthetic** books per size over a chosen price ladder,
  not the live venue universe. `gateB8-1` is the gate that samples the real engine and was not re-run
  against the wider bounds.
- `execadverse`'s 4,000 trades sampled a fill range of -50 to +400 bps of mid, which is a choice, not
  an observed distribution. 0 of 4,000 hit the 2^50 bps width, which is therefore weak evidence.
- 405 pools and 404 trades per sweep sit outside the 2^62 amount domain and are refused rather than
  approximated. **What fraction of real pools sit past 2^62 scaled was not checked.**
- The 3 `lpbracket` encoder refusals are characterised from their reason string and from the same
  effect measured elsewhere; they were not individually verified.
- One branch-rate figure does not reconcile: the `ncdf` report gives 0.63% off-branch for the identity
  sweeps, and the gate artifact records 39 of 6,000 = 0.65% for its own sweep. Different sweeps,
  probably, but the 0.63% is not re-derivable from any artifact I read, and neither are the 1.03% and
  46.79% book figures beside it.

### 3.8 Portability is asserted, and the checker that would settle it never finished

- `gate-clone-portability.mjs` was started and never completed. Measured instead: its `CIRCUITS` array
  holds **14 names and none of the four new ones** — and `liquidation`, the circuit the live
  `perp-gate` proves against, is **not in it either**. That list has been incomplete since before this
  round.
- `Quiver/zk/node_modules` is **absent** (correctly gitignored), so every gate's EVM section fails
  there with a missing `solc`. This affects the pre-existing gates identically and is a
  `cd zk && npm install` step, not a defect introduced here — but it means no EVM figure in this
  document has been reproduced from the mirror.
- All four docs are mirrored **byte-identical** into `Quiver/docs/` (13,677 / 22,264 / 24,341 / 22,359
  bytes; `cmp` clean), and all four circuits plus their gates and encoders are present under
  `Quiver/zk/`. That part is verified.

### 3.9 Nothing was measured on any hardware but this machine

Every prove time and every gas figure is one machine, one node, one in-process EVM. No figure here is
a claim about a production prover.

### 3.10 Four new defects were found and none reached the defect register

`hackathon/KNOWN_DEFECTS.md` holds 3 numbered entries. None of them is: `gateB6`'s price ranking,
`lpRisk`'s boundedness self-check, `parity.circom`'s header, or `greekssigned.circom`'s header. Two
of the four were spawned as background tasks (`task_2a207982`, `task_d5f6bebd`) and two were recorded
only in a `VERIFY_*` document. `gateB7-1` also records `passed: false` with `worstGreekRelative`
0.6077 — long documented in `TIER3_FINDINGS.md`, and still not in the register.

---

## 4. How many of 22 could serve proofs, and how many do

**Today: 3.** `perp-gate`, `size-gate`, `treasury-risk`. Measured from `gates/preflight.mjs`, which
enumerates the HTTP handler array (22) and the MCP handler array (9) separately, asserts each is
non-empty and readable before testing anything, and prints the proof-emitting set: `http:perp-gate`,
`http:size-gate`, `http:treasury-risk` and the three matching MCP tools. `src/util/snark.js` exports
exactly three witness builders, which is the same three from the other direction.

**If everything named buildable in this document were built and wired: 7 of 22.** The four Phase B
services above are the four additions. The remaining 15 have no circuit of any kind, so no count of
compiled work moves them.

That 7 needs one qualifier, and it is the same qualifier the wired three already carry. A service that
carries a proof is not the same as a service whose **headline number** is inside the proof:

| service | proof would cover | headline inside it |
|---|---|---|
| `perp-gate` (wired) | the liquidation identity | yes |
| `treasury-risk` (wired) | the Herfindahl identity | yes, with shares entering as quotients |
| `size-gate` (wired) | `fullKellyFraction` | **no** — the served `recommendedBetFraction` is `lambda * f*` and the circuit has no `lambda` term |
| `exec-verify` | `adverseExecutionBps` and the exact shortfall | yes |
| `portfolio-gate` | nearest-liquidation leg, any leg count | yes |
| `lp-risk` | breakeven volatility as the root of its bracket | **no** — `expectedIlPct` stays a public input |
| `options-risk` | N and phi at a supplied x | **no** — neither x, nor the price, nor delta |

So the honest reading is: 3 of 22 carry a proof today, 2 of those 3 have their headline inside it, and
the buildable ceiling is 7 of 22 with 4 headlines inside. Every one of the four new circuits is
reachable only from `zk/`; no served path reaches any of them.

---

## 5. Decisions that are Tristan's, ranked by what they unlock

Deploys are frozen and nothing below asks for one.

**1. Commit the `options-risk` work out of the index (minutes, unlocks: a day of work stops depending
on a dangling commit).** 18 staged-uncommitted paths, described in their own report as committed inside
`8901f04` — a commit no longer reachable from any branch. The content is recoverable from that dangling
commit until a `git gc`, so this is urgent-ish rather than urgent. Committing with an explicit pathspec
costs nothing and moves no hash. The related standing rule the agents converged on independently:
while the tree is shared, `git commit --only -- <paths>` and never a bare commit, because a bare commit
is what created `8901f04` and swept up a sibling's files in the first place. `main` is 6 ahead of
`origin` and pushing is your call, not a side effect of this.

**2. Decide whether Phase B wiring happens at all before the deadline (unlocks: 3 of 22 becomes up to
7 of 22).** Every circuit here is built, gated and refusing; not one is reachable from a served
response. The precedent is `PHASE_B_WIRED.md`: the work that turned 1 into 3 was not circuit work, it
was moving witness builders across the fence between `zk/` and `src/`. That fence is exactly where
these four sit. `exec-verify` is the cheapest and the only one whose published headline lands inside
the proof — +504 Plonk on an existing domain, no new ceremony file, and the shortfall certified with
no tolerance term. `portfolio-gate` is the second cheapest and its per-leg shape removes a ceiling
rather than raising one.

**3. Decide the ceremony-file question, or decide not to (unlocks: nothing you need, and that is the
finding).** 2^13 at 9,520,280 B would build the 4-leg wide circuit — which the per-leg route makes
unnecessary. 2^16 or 2^17 would be needed for `lp-risk`'s expectation, and **nobody has measured what
those files weigh**. Both are downloads, which is your call and not an agent's, and this box has a
preflight-checksum history that makes the point. Declining is a legitimate answer: the only thing 2^13
buys is a shape that has been superseded.

**4. Re-measure every gas figure as a median before any of them is published (unlocks: not shipping
false precision).** Freshly measured today: 1.22% spread across 12 proofs of an identical statement,
error bar about 3,500 gas. One figure in these reports has already taken three different values, and
one marginal-cost claim is entirely inside the noise. `gateB9-2` already does this correctly — fresh
EVM per verifier, median over several proofs — and is the pattern to copy.

**5. Put the four new defects in the register (unlocks: the register meaning what it says).** The
`lpRisk` boundedness self-check ships `allChecksPass: false` on a correct value for any caller at high
sigma over a long tenor, and it is a live-response defect rather than a gate finding. `gateB6`'s
price ranking names the wrong leg while verifying real proofs. `parity.circom`'s and
`greekssigned.circom`'s headers claim more than their constraints deliver, each demonstrated with an
accepted proof. Three of the four are outside `src/engine/`, so the build hash does not move; the
`lpRisk` one is inside it and therefore a separate decision with its own cost.

**6. Decide whether the adversary gets run retroactively (unlocks: knowing whether section 2 is
true).** The pass was skipped because every verdict was positive, which is the one condition under
which an adversary is most useful and least likely to be invited. Three of four briefs were wrong
about their own blockers; nothing yet has been wrong about the answers, because nothing has tried.

**7. Fix `gate-clone-portability.mjs`'s circuit list, whoever batches it (unlocks: the portability
gate covering the wired circuit).** It omits `liquidation` — the one circuit a paying caller's proof
is checked against — plus all four new ones. Three agents each declined to edit it mid-flight in a
shared tree, which was the right call individually and leaves the list wrong.

**8. Note that preflight's single red is the changelog check.** 24 PASS, 1 FAIL, exit 1: the repo
changelog is identical to live, so the check that demands an entry for the next deploy is doing its
job. It has nothing to do with the four services and it goes green when a changelog entry is written,
which is a deploy-sequencing step and therefore yours.

---

## 6. How to reproduce anything on this page

```
cd zk && node scripts/circuit-facts.mjs ncdf            # one circuit's counts, from the artifacts
node scripts/circuit-facts.mjs                          # all of them; several minutes, it reads every zkey
node scripts/probe-plonk-gas-variance.mjs               # the 1.22% spread and the 7,500-gas cold/warm trap
node scripts/gateB10-portfolio-perleg.mjs               # 11 legs, the ranking defect, the refusal sweep
B10_REVERT=price node scripts/gateB10-portfolio-perleg.mjs   # and the revert that turns it red
node scripts/gateB5-3-execadverse.mjs                   # the headline bps, exact shortfall
node scripts/gateLP0-bracket.mjs                        # the bracket certificate
node scripts/gateLP2-expectation-cost.mjs               # 36,613 R1CS, 8.94x over the ceiling
node scripts/gateB7-5-ncdf.mjs                          # the CDF and its density, computed
cd ../hackathon/veritape && node gates/preflight.mjs     # the proof-emitting set: three services
node tools/docs-consistency.mjs                          # this document included
npm test                                                 # 386
```

The EVM sections need `solc`, which means `cd zk && npm install` first, and they do not run from the
`Quiver` mirror at all. Nothing on this page was deployed, `src/engine/` was not touched, and the
paper was not opened.
