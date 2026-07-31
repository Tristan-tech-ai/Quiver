# Four Phase B services, four negative verdicts, four adversaries — and all four adversaries won

**Written 30 July 2026.** Four services — `portfolio-gate`, `exec-verify`, `lp-risk`, `options-risk` —
were each investigated for whether their zk proofs can be wired. Each investigation returned
`claim held: partly` and each shipped a working circuit. Every negative verdict was then handed to an
adversary briefed to refute it.

**All four adversaries returned `refuted=true`.** Not one of the four "cannot" lists survived contact.
That is the headline, and it is a good outcome rather than an embarrassing one: the four services are
*more* provable than their own investigators believed, and every wall that fell was a wall the project
had built out of a wrong assumption rather than out of mathematics.

This file replaces an earlier version of itself which said the adversary "ran zero times". That
sentence was true when it was written and is now false. It is the reason this document exists.

Everything below is either measured in this session from artifacts and running code, or is explicitly
labelled as a claim nobody has measured. Section 6 is the second kind, in full, and it is the section
to read if you only read one.

---

## 1. One row per service

| service | what the brief claimed was in the way | what measurement said | adversary | what is now buildable |
|---|---|---|---|---|
| `portfolio-gate` | a **structural** wall at 3 legs: the wide circuit outgrows the ceremony file on disk at N=4 | arithmetic exact to the digit, framing wrong. N=3 is 2,053 R1CS / 3,970 Plonk; N=4 is 2,736 and needs 2^13 **under Plonk**. The investigator concluded the wall was a download, then routed around it with a per-leg circuit at 651 R1CS that fits the file on disk with no leg cap | **REFUTED.** snarkjs's power test is proving-system-specific. Groth16 uses `log2(nConstraints+nPubIn+nOutputs)+1` = `log2(2,773)+1` = **12**. The 4-leg wide circuit builds on the `hez_final_12` already on disk, zero bytes downloaded. The real wide ceiling on that file is **five legs, not three** | nearest-liquidation over any number of legs by three different routes. The best of them is the one neither the investigator nor the brief considered: **N legs in one circuit with the argmin outside** — 6 legs, one proof, 651 R1CS/leg marginal |
| `exec-verify` | three blockers: `inEff` unpublished, encoder loses 64 grid steps above 9e6 reserves, headline bps has no circuit signal | 1 of 3 survived. `inEff` is already public signal 8 of `constantproduct`; the fee identity pins it to a unique grid integer on 3,988 of 4,000 trades. The 64 steps are real but belong to an encoder already fixed and post-mortemed. The headline genuinely had no signal, and now does | **REFUTED.** The circuit has **`nPrvIn = 0`** — nothing is private, so the whole statement is a closed-form predicate over numbers the verifier already receives, checkable directly in Solidity for ~5,011 gas against a 278k pairing check. And the shipped headline's "+2,388 gas" marginal cost is smaller than the run-to-run gas noise of one of its two terms | the same statement with the seven recomputable outputs demoted to private (929 R1CS, 8 public, cheaper and smaller), and — the real prize — a **Poseidon-committed** version at 1,764 R1CS on the existing ptau where every input is private. That is the field-element join a Phase-D attestation needs |
| `lp-risk` | two walls: a square root and a 200-iteration bisection, neither with an identity to restate | both counts right, both reasons wrong. The square root is 194 R1CS of already-green work. The bisection has a bracket certificate, built at 932 R1CS / 1,776 Plonk. The quadrature has a geometric restatement agreeing to 5.218e-15 | **REFUTED, and this is the largest single finding in the file.** The integrand is a hyperbolic secant, and the integral has a closed form: **E[IL] = exp(−σ²T/8) − 1**. The 401-point quadrature, the 200-step bisection, the 36,613-constraint restatement and the 2^16–2^17 ceremony file were all certifying a numerical method for a quantity with a two-line answer | the expectation itself, at **1,847 R1CS / 3,554 Plonk on the ptau already on disk** — cheaper *and* smaller than the bracket certificate built to avoid it. Breakeven inverts to `v* = −8·ln(1−f)`, monotonicity becomes a derivative, and three declared residues dissolve |
| `options-risk` | the normal CDF cannot be computed in-circuit, so the residue stays open | premise wrong, same shape as Tier 3. The engine computes Hart (1968), not `erf`: a ratio is a multiply, two polynomials are Horner, and the one exponential factors over the binary expansion of its argument into a product of 192 selected constants. The wall was fixed-point representation | **REFUTED.** Both items on the "not built" list are now built. `F·φ(d₁) = K·φ(d₂)` — absent from all eight of the service's identities — pins d₁ with **no logarithm at all**, one multiply instead of a second exp gadget. And "2 × 3,740 > 4,096 so it does not fit" adds constraints where the correct operation is to add **proofs**: the same zkey, twice | the full leg price, two ways. Route A needs **zero new artifacts** — two proofs on the unchanged `ncdf_plonk.zkey`, reconstructing the reference leg to $1.75e-7. Route B is one circuit at 7,758 Plonk on a locally-generated 2^13. Plus: `ncdf` reaches **two other services'** published fields |

Two things to read out of that table before the numbers.

**The pattern is one pattern, four times.** Every one of the four refutations is the same species of
error: a limit that belonged to a *tool*, a *representation*, or an *encoding choice* was recorded as a
limit belonging to mathematics. Plonk's power test was read as the ceremony file's ceiling. A public-input
circuit was read as a private one. A numerical method was read as the quantity it approximates. Two
proofs were read as one bigger circuit. This is the third and fourth time this project has made that
mistake in a week — Tier 3 and the case-sensitivity defect were the first two — and it now has a
diagnostic: **when something is "impossible", ask which layer the impossibility lives in.**

**Every adversary build is in a temp directory that does not survive the session.** Measured: `zk/build`
contains 21 `.r1cs`, 19 Plonk zkeys, and exactly **two** `.ptau` files, both power 12. Not one of the
adversaries' artifacts — the Groth16 4-leg and 6-leg zkeys, the locally-generated 2^13 and 2^17 ptau,
the closed-form LP circuit, the Poseidon-committed exec circuit, the two-instance LegPrice circuit — is
in the repo. They are all under
`AppData/Local/Temp/claude/.../scratchpad/`. **The refutations are real measurements and are currently
non-reproducible from the repository.** That is decision #1 in section 8.

---

## 2. Measured in this session

| measured today | result | measured how |
|---|---|---|
| services a caller can obtain a proof from | **3 of 22** — `perp-gate`, `size-gate`, `treasury-risk` | `node gates/preflight.mjs`, which enumerates both handler arrays and prints the proof-emitting set: `http:perp-gate, http:size-gate, http:treasury-risk, mcp:perp_gate, mcp:size_gate, mcp:treasury_risk` |
| services in the registry | **22** | `SERVICES.length` from `src/services.js` |
| handlers that build no proof | 25 of 31 | preflight, both surfaces (22 HTTP + 9 MCP) |
| `node gates/preflight.mjs` | **24 PASS, 1 FAIL, exit 1** | the one red is the unpublished-changelog check, which is a pre-deploy gate and not a defect |
| `npm test` | **386 tests, 381 pass, 5 skipped, 0 fail** | run directly; unchanged |
| engine build hash | **`q1-e1fa99d08887d6cc`**, unmoved | `_internal.buildId()` called live from `src/engine/proof.js` |
| `node tools/docs-consistency.mjs` | **CONSISTENT — 225 documents** | run directly |
| compiled circuits | 21 `.r1cs`; 19 with a Plonk zkey | `ls zk/build` |
| ceremony files on disk | **2, both power 12** — `hez_final_12.ptau` and `pot12_final.ptau`, 4,801,688 bytes each | `ls -la` |
| circuits with zero private inputs | **18 of 21** | own r1cs header parser, `nPrvIn` field |
| the four `VERIFY_*.md` docs vs their Quiver mirrors | **all four byte-identical** | `cmp` |
| gas figures in those four docs vs the artifacts that produced them | **7 of 7 disagree** | see §5.1 |
| adversarial refutation passes run | **4 of 4** | |
| adversarial passes run against the *adversaries* | **0 of 4** | nobody has attacked the new claims |
| commits containing `zk/circuits/ncdf.circom` | **0** — 18 files staged and uncommitted | `git log --all -- <path>`; the commit its author named is orphaned. §6.4 item 35 |

Every constraint count in sections 3 and 4 was read by a parser written for this report that uses
neither `snarkjs` nor `circuit-facts.mjs`, straight out of the `.r1cs` section-1 header and the Plonk
zkey section-2 header. It carries a non-vacuity guard that throws on a zero count, because the `lp-risk`
investigator's own parser skipped 20 bytes from `nWires` to `nConstraints` where **24** are needed, read
a zero out of `nLabels`, and had a row pass green on zeros.

---

## 3. Every compiled circuit, measured

| circuit | R1CS | Plonk | domain | public | private in |
|---|---|---|---|---|---|
| `kelly` (size-gate, **live**) | 372 | 718 | 1,024 | 5 | 0 |
| `concentration` (treasury-risk, **live**) | 451 | 834 | 1,024 | 12 | 0 |
| `divergence` (lp-risk) | 463 | 887 | 1,024 | 7 | 0 |
| `portfolioleg` (**new**) | 651 | 1,267 | 2,048 | 10 | 0 |
| `liquidation` (perp-gate, **live**) | 667 | 1,301 | 2,048 | 8 | 0 |
| `constantproduct` (exec-verify) | 671 | 1,293 | 2,048 | 10 | 0 |
| `execadverse` (**new**) | 932 | 1,797 | 2,048 | 15 | 0 |
| `lpbracket` (**new**) | 932 | 1,776 | 2,048 | 13 | 0 |
| `greeksfp` | 1,065 | 1,919 | 2,048 | 13 | 0 |
| `greeks` | 1,103 | 2,152 | 4,096 | 13 | 0 |
| `parity` | 1,153 | 2,255 | 4,096 | 13 | 0 |
| `greekssigned` | 1,952 | 3,615 | 4,096 | 29 | 0 |
| `ncdf` (**new**) | 2,012 | 3,740 | 4,096 | 7 | 0 |
| `portfoliogate` | 2,053 | 3,970 | 4,096 | 28 | 3 |
| `portfoliogate4` | 2,736 | *no zkey* | — | 37 | 4 |
| `lpexpectation` (**new**) | 36,613 | *no zkey* | — | 3 | 246 |
| `kellybatch1..4` | 493 / 743 / 1,236 / 1,486 | 1,190 / 1,664 / 2,854 / 3,328 | 2,048–4,096 | 1–2 | 0 |
| `padprobe` | 3,900 | 3,902 | 4,096 | 2 | 0 |

Confirmations this table settles, each of which was a disputed number somewhere above:

- `liquidation` is **667 R1CS / 1,301 Plonk**, and `portfolioleg` is 1,267 Plonk — so "34 Plonk smaller
  while proving strictly more" is **exact**.
- `portfoliogate` is 28 public, `portfoliogate4` is 37 public. Both investigators' figures reconcile
  (22 inputs + 6 outputs = 28; 29 + 8 = 37).
- `greeksfp` at 1,919 Plonk in a **2,048** domain is genuinely cheaper than `greeks` at 2,152 in 4,096 —
  cheaper on every axis including ceremony power.
- `ncdf` is 2,012 / 3,740 / 7 public, and its EVM verifier is 7,080 bytes.

### 3.1 The finding this table makes that nobody asked for

**Eighteen of the twenty-one compiled circuits have `nPrvIn = 0`.** Only `portfoliogate` (3),
`portfoliogate4` (4) and `lpexpectation` (246) have any private input at all.

The `exec-verify` adversary found this for one circuit and drew the right conclusion: with nothing
private, the statement is a closed-form predicate over data the verifier already receives, so the SNARK
buys no succinctness and no privacy — it buys third-party certification of arithmetic, and it pays about
55× the gas of just checking the predicate.

That conclusion generalises, and the generalisation was measured. **All three circuits on the live paid
path — `liquidation`, `kelly`, `concentration` — have `nPrvIn = 0`.** So does every new circuit built
this round. Whatever these proofs are worth, it is not succinctness, and the commercial story has to
survive that. The `exec-verify` adversary's Poseidon-committed variant (1,764 R1CS, 2 public signals,
every input private, on the existing ptau) is the only artifact produced this round in which a SNARK is
doing something a direct check cannot, and it is in a temp directory.

I did not myself measure the ~5,011-gas direct Solidity check. That number is the adversary's.

---

## 4. The numbers behind each row

### 4.1 portfolio-gate

**The two power tests, confirmed in source.** `zk/node_modules/snarkjs/build/main.cjs`:

- line 4427 (Groth16): `cirPower = log2(r1cs.nConstraints + r1cs.nPubInputs + r1cs.nOutputs + 1 - 1) + 1`
- line 6452 (Plonk): `cirPower = log2(plonkConstraints.length - 1) + 1`

`log2` at line 122 is a bit-position floor. So for `portfoliogate4`: Groth16 budget = 2,736 + 29 + 8 =
2,773, `log2(2,773) = 11`, `+1 = 12` → **fits `hez_final_12`**. Plonk = `log2(5,294) + 1 = 13` → needs
2^13. Both investigator and adversary are arithmetically right; they ran different tests, and only one
of them ran both. There is a *third* power computation at line 10026 (`plonkConstraints.length + 2`)
that neither touched.

**Ceremony file cost, and the fact that the download was never needed.** `hez_final_12.ptau` on disk is
4,801,688 bytes. The official Hermez `hez_final_13` is 9,520,280 bytes. Locally generated 2^13 files
produced by two different adversaries in this session, measured: **9,438,629** and **9,438,644** bytes —
differing from each other by 15 bytes (different contributor entropy) and each ~81.6 KB smaller than the
official file, which carries a longer contribution history. A third adversary generated a full 2^17 at
**150,996,408** bytes. Generation took 55 seconds for 2^13 and about 11 minutes for 2^17, **with no
network access**. The permission gate on downloading was never the blocker; the tree simply never
considered that `snarkjs powersoftau new` exists, and `build-circuit.mjs`'s refusal message says only
"fetch a larger powers-of-tau file".

**Leg ceiling.** `maxItems` appears **0 times** in `src/`, `api/` and `sdk/` — counted with `wc -l`, not
read off a truncated grep. The only bound is a lower one. So the ceiling was never the service's.

**Gas and latency.** Per-leg route, from `gateB10`: 11 legs = 2,969,816 gas. Wide 3-leg, from `gateB8-2`:
292,124. Latency, same process, same three legs: wide 1 proof 1,634 ms; 3 per-leg proofs 2,220 ms serial
/ 742 ms parallel; 11 per-leg 8,228 ms serial / 793 ms parallel. The parallel figure requires 11 workers
and represents *more* total prover work, which the investigator stated.

The adversary's third shape beats both, measured under Groth16 on the on-disk 2^12 at full bit-width
parity: 4 legs = 2,604 R1CS / 87 ms / 455,707 gas; **6 legs = 3,906 R1CS / one proof / 67 ms / 508,891
gas**. 7 legs refused at budget 4,613, so the bound can fail. Marginal cost 651 R1CS/leg — identical to
`portfolioleg` standalone, so batching legs is free in constraints and saves N−1 proofs. Against the
shipped per-leg route at 6 legs: **3.19× cheaper gas, one proof instead of six, one worker instead of six.**

**Honest counterweight the adversary volunteered:** Groth16 needs a per-circuit phase-2 ceremony where
Plonk's setup is universal, and their phase-2 contributions are single-contributor and worthless as
trust. At 3 legs the shipped Plonk verifier genuinely wins (292,124 gas, 28 signals) because Groth16
pays ~6,150 gas per public signal against Plonk's ~822; the crossover is at 4 legs. And the exported
Groth16 verifier burned 7,878,919 of an 8,000,000 gas limit on a bent proof point while still returning
`false` — sound, but a very expensive refusal path.

**The ranking defect, which is the most commercially serious thing in this row.** `gateB6`'s router
verified 11 real proofs and named the wrong leg. Ratio ranking (`d_a·ref_b < d_b·ref_a`) names leg 10 at
6.1033% from liquidation, `pLiq` $300.47. `gateB6`'s price ranking names leg 3 at 24.0891% away,
`pLiq` $0.4706 — **a leg four times further from liquidation than the binding one.** Filed as
`task_2a207982`, not edited mid-flight.

**Refusal rate**, 200 seeded synthetic books per size, encodability only: 4 legs 195/200, 6 legs 192/200,
11 legs 189/200. Every refusal was `divergedPct`, zero were bounds refusals — the wider bit widths
earning their place. Bit widths regained: margin 2^80 (was 2^60), size 2^60 (was 2^55), price/mark/
distance 2^60 (was 2^50).

The adversary showed that last claim's *stated reason* false too: three legs in one domain **can** afford
full parity, at 1,953 R1CS → 3,795 Plonk in domain 4,096 on the on-disk file, once the argmin moves out
of the batched circuit. N=4 batched is refused at 5,060 > 4,096, so that bound is real.

**A defect I confirmed myself.** `zk/circuits/portfoliogate4.circom` line 220 reads
`// Result: 1,989 non-linear + 64 linear R1CS, 3,970 Plonk, domain 4,096 — 126 gates of slack.` — the
N=3 figures, inside the N=4 circuit, which measures 2,736 R1CS and needs domain 8,192 under Plonk. `diff`
against `portfoliogate.circom` shows the **only** differing line is 222, `PortfolioNearest(3,` → `(4,`.
This is exactly the defect class `circuit-facts.mjs` was written to kill. (The adversary also reported a
literal `"N = 3 legs"` string there; I grepped and could not find one. Only the `Result:` line is stale.)

### 4.2 exec-verify

`constantproduct` 671 R1CS / 1,293 Plonk / 10 public. `execadverse` 932 / 1,797 / 15. Delta **+261 R1CS,
+504 Plonk, +5 public, domain unchanged** — the headline needs no new ceremony file.

Gates B5-0 through B5-5 all recorded `passed: true`. B5-1 kept 3,595 pools, 405 out of a 2^62 domain, 0
divergences; tightest invariant 7.997e-1, worst honest case using 77.7% of its allowance. B5-3 refused
13/13 dishonest witnesses including `inEff` ±1 grid step and a sign-flipped headline. B5-4 kept 3,596
trades, 0 violations of three bounds.

**The derived bps bound and its dominant term.** In bps, at the worst case: display `round(bps,2)`
5.00e-3; bps grid 5.00e-10; fill grid 1.74e-12; benchmark 1.49e-10; IEEE 1.00e-12. Total 5.0000e-3 —
**the display step is 99.99% of the whole allowance**, and the worst honest case uses 99.98% of it. The
bound was shown to be exceeded by five wrong benchmarks: mid-price refused 3,596/3,596 at up to
214,614×; 1e-6 relative slip 3,447/3,596; 1e-7 slip 328/3,596 — the two slips bracketing the
derivation's own 5e-7 crossover from both sides.

**The check that could not fail, and the investigator's own account of it.** The first version of the bps
bound read `gOut` off the value under test, so the allowance expanded to cover whatever the encoder had
just done. The proof it was worthless: it then failed to refuse an encoder this repo is on record as
having had wrong. Three of the investigator's checks failed before they passed. That is the discipline
working.

**The adversary's four surviving hits.**

1. *Cost accounting is noise.* See §5.1 — this is the finding I extended and it is now much worse than
   the adversary reported.
2. *The headline is free; the echo signals are the cost.* Seven of the fifteen public signals are
   closed-form in the other eight (`feeTolerance ≡ 1e9`, a constant; `bpsTolerance ≡ outHat`, a literal
   duplicate of signal 12; `tolerance ≡ x+in+y−out`; `shortfall ≡ out−realized`; three residuals
   quadratic). Demoting them to private: **929 R1CS / 1,787 Plonk / 8 public**, honest witness accepted,
   all 13 of B5-3's own dishonest witnesses refused, and **7,270 deployed bytes against 8,754 — also 424
   bytes smaller than the benchmark verifier it upgrades.**
3. *Two tests that cannot fail.* `gatekit`'s `proveVerifyRefuse` perturbs the `publicSignals` **array
   after proving** and asks `plonk.verify`. That is Plonk's public-input binding — true for every circuit
   in the repo — so "15/15 perturbations refused" is not evidence about `execadverse`. Measured proof:
   `xHat+1`, `yHat+1` and `outHat+1` all **prove and verify** against the shipped zkey. The statement
   admits exactly the tuples the perturbation test claims to refuse. Bisected: `x̂` can move **+62 grid
   steps** (6.2e-8 tokens) with the fill, the headline and every other signal unchanged — and the
   soundness table published windows for `în`, `ô` and `b̂` but none for `x̂`/`ŷ`, the two signals the
   entire "reserves are an input" disclaimer is about.
4. *One overclaim.* "The shortfall is certified exactly — no tolerance, no rounding argument to have with
   a counterparty." The subtraction is exact, but B5-4's own artifact records the certified shortfall
   differing from the served `adverseValueOut` by up to **7.0e-9 tokens** against a derived allowance of
   1.535e-8. Exact internally; ±7 nano-tokens against the figure a counterparty would actually dispute.

**And the shape that earns its keep**: `xacommit.circom` — Poseidon(5) over `(x,y,dx,f,realized)` as the
only public output, every input private. 1,764 R1CS / 3,028 Plonk / domain 4,096, **on the existing
`hez_final_12`**, prove 1.55 s, 267,499–268,331 gas (about 12k *less* than the shipped 15-signal
version), 5,986 deployed bytes, identical verdicts on all 13 dishonest witnesses. That is a venue proving
a client's adverse execution without publishing the client's size, the venue's fill, or the pool it was
quoting — a statement nobody can check without the proof.

Also unexplored and free: `kellybatch1..4` is this repo's own precedent for N answers per proof, and two
trades already fit `hez_final_12` (2 × 1,797 < 4,096). Never tried here.

### 4.3 lp-risk — the closed form, verified independently

This is the row where the most work turned out to be unnecessary, so I verified it myself rather than
taking the adversary's word.

**The identity.** `2√r/(1+r) = sech(ln r / 2)`. With `a = √v/2` the argument is `az − a²`; shifting
`z = w + a` leaves `sech(aw)` with the pdf gaining `e^{−aw − a²/2}`; symmetrising `w → −w` turns
`e^{−aw}` into `cosh(aw)`; and `cosh·sech ≡ 1`. So `E[sech] = e^{−a²/2} = e^{−v/8}`:

> **E[IL](v) = exp(−v/8) − 1**, where `v = σ²T`.

**My own measurement, own quadrature, own code.** I reimplemented the engine's grid from its source
shape (`z_i = −6 + 0.03i`, `i = 0..400`) and compared to the closed form over 20,001 log-spaced `v` in
[1e-8, 1e4]:

| window | nodes | worst \|quadrature − closed form\| |
|---|---|---|
| \|z\| ≤ 6 | N=400 | **1.9786e-9** at v = 2.9964e+2 |
| \|z\| ≤ 6 | N=1600 | 1.9735e-9 |
| \|z\| ≤ 8 | N=400 | **2.4425e-15** |
| \|z\| ≤ 8 | N=1600 | 3.2196e-15 |
| \|z\| ≤ 16 | N=25600 | 1.2879e-14 |

The residual is **invariant in N** (1.9786e-9 → 1.9735e-9 across a 4× refinement) and **collapses by six
orders when the window widens**. That is the signature of a truncation floor belonging to the engine's
`|z| ≤ 6` window, not an error in the closed form. Two falsifiable predictions, both held.

**Against the live engine's published fields**, calling `lpRisk` directly with `volatility` /
`horizonPeriods`:

| σ | T | v | published `expectedIlPct` | `exp(−v/8)−1` | gap (pp) | `approximationGapPct` published vs `(e^x−1−x)·100` |
|---|---|---|---|---|---|---|
| 0.3 | 30 | 2.7 | −28.6448 | −28.6448025 | 2.53e-6 | 5.1052 vs **5.1052** |
| 0.5 | 90 | 22.5 | −93.9945 | −93.9945332 | 3.32e-5 | 187.2555 vs **187.2555** |
| 0.6 | 365 | 131.4 | −100 | −99.9999926 | 7.36e-6 | 1542.5 vs **1542.5** |
| 0.8 | 7 | 4.48 | −42.8791 | −42.8790936 | 6.39e-6 | 13.1209 vs **13.1209** |
| 1.2 | 180 | 259.2 | −100 | −100 | 8.38e-13 | 3140 vs **3140** |
| 0.129854598 | 304 | 5.126114 | −47.3110 | −47.3110405 | 4.05e-5 | 16.7654 vs **16.7654** |

Every gap is under the 5e-5 half-step of the published 4-dp rounding. `approximationGapPct` reproduces
to the **published digit in all six cases** — it is exactly `e^x − 1 − x` at `x = −v/8`. And
`1 + pct/100 == exp(leadingOrderPct/100)` holds to ≤ 2.735e-7, pure rounding. **The engine's
`expectedIlPct` and `expectedIlLeadingOrderPct` are a number and its own logarithm.**

**Therefore a live documentation defect, independent of any circuit.** The engine's published note says
the leading order "diverges from the exact expectation" outside the small-variance regime. It does not
diverge from it in any meaningful sense — it *is* its logarithm, and `−v/8` is the first Taylor term of
`e^{−v/8}`. The engine's own self-check ("`−σ²T/8 == numerical E[IL]` at `σ²T = 0.01`") passes for that
reason and was read twice as evidence for the opposite conclusion.

**Built, on the on-disk ptau.** `lpclosed2.circom`: **1,847 R1CS / 3,554 Plonk / domain 4,096 / 4
public**, setup 633 ms on `hez_final_12`, prove 1,414–1,562 ms, 116 of 116 live engine calls certified
with worst deviation 1 step at 1e-6, in a real EVM **269,961 gas accept / 573 refuse / 6,385-byte
verifier**, 5 of 5 tampered submissions refused. Falsifiable: `lHat+3` refused pre-proof, and the `VCAP`
is sharp (v = 256.0 accepted, 256.1 refused). **Cheaper and smaller than `lpbracket`'s 278,051 gas and
8,330 bytes** — the bracket certificate built to avoid the expectation costs more than proving the
expectation.

Breakeven inverts in closed form: `v* = −8·ln(1−f)`. My values: f=1e-6 → 8.000004e-6; f=0.01 →
8.04026868e-2; f=0.1 → 8.42884125e-1; f=0.5 → 5.54517744; f=0.99 → 36.8413615. One logarithm against the
engine's instrumented **242,004 transcendental calls** (161,202 `exp` + 80,802 `sqrt`) per breakeven
solve. The full service call is 245,624 calls: 163,608 `exp` + 82,016 `sqrt`, decomposing exactly as
204 quadrature passes = 1 headline + 1 doubling probe + 200 bisection + 2 self-checks. The figure
reported elsewhere as "roughly 80,000 transcendental evaluations" is 204 × 401 = 81,804 quadrature
*points* and **undercounts evaluations by 3×**.

**One prediction I could not confirm.** The adversary claimed the boundedness-defect threshold the
investigator measured at v = 116.0687404 is "predicted analytically" by `−8·ln(5e-7)`. I computed
`−8·ln(5e-7) = 116.0692619`. That is a gap of **5.2e-4**, not agreement. The mechanism is right in shape
— the check trips where `round(E[IL]·100, 4)` reaches −100 — but the closed form does not reproduce the
measured threshold to the digit, and I am recording that as an unconfirmed prediction rather than a
confirmation.

**The defect underneath it is real and confirmed by the investigator's measurement:** `lpRisk`'s own
boundedness self-check tests `round(E[IL]·100, 4) > -100`, so at σ²T ≥ 116.07 it reports `pass: false` on
a value of −0.999999999999998, strictly inside (−1, 0]. `proof.js` turns that into
`allChecksPass: false`. A live call at σ = 0.62 over a year ships that way. Filed as `task_d5f6bebd`.

**What survives the closed form.** `concentrationFactor > 1` is out of scope for every circuit here
including the new one: the service then publishes `ilFull × conc`, a linearisation with no term in any
circuit. And the closed-form circuit's `v ≤ 256` cap is a real regression — above v = 171.3 every answer
is the −100% floor, but a caller asking v = 300 gets a refusal the current engine answers.

### 4.4 options-risk

**The defeat of the premise.** The engine does not compute `erf`. It computes Hart (1968):
`N(−z) = e^{−z²/2}·b(z)/d(z)`. A ratio is a multiply (`c·d = e·b`), two polynomials are Horner, and the
one exponential factors over the binary expansion of its argument. I counted the circuit's own table:
**exactly 192 mux constant assignments across 12 `Mux4` groups** — 12 groups × 16 = 192. The wall was
fixed-point representation, and `ncdf` at S=44 was built *first* at 2,555 R1CS → 4,810 Plonk and
**refused** against the 4,096 ceiling; S=40 is a measurement, not a preference.

**Why it closes the residue rather than moving it.** Every one of the service's eight consistency
identities is blind to the CDF — measured under three wrong CDFs (A-S 7.1.26, logistic 1.702x, and
`hart + 3e-3·x·e^{−x²/4}`), **all eight residuals are unchanged** (worst 1.54e-14) while worst relative
price error reaches 19.40% / 199.13% / 100.00%. A-S's `F` residual (3.30e-14) is *smaller* than the
correct engine's (1.32e-13) — the signature of a cancelling quantity, not a tested one. And put-call
parity is blind **algebraically**: any `N` with `N(−x) = 1 − N(x)` cancels out of `C − P = df·(F − K)`,
so a whole book repriced with A-S produces a parity proof that verifies with `C−P` off by 7.276e-12.
Parity is not a weak check on the price level; it is not a check on the price level at all.

**Derived tolerance, term by term, worst at z=0:** 9.500 ulp accumulated `exp` error × `b/d ≤ 0.5`;
3.41e-3 from `b`; 1.70e-3 from `d`; 1.0023 from the `c` relation's floor remainder. Total 10.507 ulp →
`TOLC = 12`, `TOLP = 10`, envelope **1.09e-11 on N and 9.09e-12 on the density**. Shown to be a band and
not a knife edge: 13 ulp out → residual 15.197 vs limit 12, refused; 2 ulp out → 4.197, accepted. Worst
real case over 6,000 legs uses 18.3% of `TOLC`.

**Bracketing measured and rejected**, which is what the brief actually asked: best density-aided bracket
at 16,384 anchors is 2.31e-7 against the circuit's 3.18e-8% price envelope — **1.51e+6× wider**, for
16,384 constants against 208. Computing wins by six orders.

**Two defects in the existing family, each demonstrated with a real accepted proof.** (1) `parity.circom`'s
header claims it catches a price that drifts on one side and not the other; it cannot, per above.
(2) `greekssigned.circom` claims identity A (`d1 − d2 = σ√T`) is "proven here as a by-product"; `dDiff`
appears in one constraint and nothing ties it to σ or T. Moving `vannaE` 11→10 and `dDiffE` 9→10 leaves
every mantissa identical and the circuit **accepts a vanna ten times the engine's and a `d1−d2` that is a
tenth of `σ√T`.** Neither patched. `gateB7-1` records `passed: false` on disk, as documented.

**The adversary's defeats.**

*Defeat 1 — the d₁ pin needs no logarithm.* `F·φ(d₁) = K·φ(d₂)` is a one-multiply identity, **absent from
all eight** of the service's identities (A–H never touch the density at d₂). Worst relative residual over
5,000 engine surfaces: 2.079e-14, mean 3.064e-16. With the linear spread relation `x₁ − x₂ = σ√T` it is
not a check but a *determination*: `φ(d₁)/φ(d₂) = K/F` gives `x₁ + x₂ = 2ln(F/K)/s`, and the two together
solve `x₁ = ln(F/K)/s + s/2 = d₁` uniquely. φ is even, so the density alone cannot fix a sign; the spread
relation breaks that symmetry.

*Defeat 2 — the leg price needs nothing new.* `ncdf` takes `(xSign, xMag, nHat, pHat)` as public signals
and only *checks* them, so a second CDF is a second **proof**, not a bigger circuit. On the unchanged
`build/ncdf_plonk.zkey`: both d₁ and d₂ of the reference leg (F=K=100000, T=30d, σ=0.6) verify, each
refuses `nHat+1`, 1,697 + 1,415 = 3,112 ms. Then arithmetic on the two proofs' public signals alone —
spread residual 2.467e-13, `F·p₁ − K·p₂ = 0`, price = **$6853.940718429** against the engine's
$6853.940718254, off by **$1.754e-7**, inside the investigator's own $2.183e-6 envelope *and* inside the
`round(x,6)` publication grid. Over 3,978 random legs the worst composed price error was $3.734e-7 =
0.75× that grid. On chain: two calls to the 7,080-byte verifier already exported.

*Defeat 3 — and a corrected number.* The single-circuit route measures **4,444 R1CS / 8,302 Plonk** lazily
and **4,172 / 7,758** once comparator widths are derived. The investigator's inferred 7,480 **understates
the real cost by 822 constraints and lands on the wrong side of 2^13** — anyone acting on it would have
fetched power 13 and failed. With a locally generated 2^13: verify true, 2,867 ms, 13 public signals,
13/13 perturbations refused, an A-S-priced leg refused, and on F=100000/K=120000 the pinned price was
$1395.481646032 vs engine $1395.481646024.

*What the pair is worth, with its honest limit.* Largest simultaneous shift of d₁ and d₂ surviving
`F·p₁ = K·p₂`, by |d₁| bucket: 0–0.5 **4.670e-10**; 0.5–1 5.642e-10; 1–2 1.935e-9; 2–3 4.302e-8; 3–4
1.025e-6; 4–5.5 1.194e-3; 5.5–7.07 2.945e-1. Near the money that is ~2e6× tighter than the 9.16e-4 the
off-circuit relocation attack achieved. 23 of 3,972 legs (0.58%) are looser, all deep-wing where φ(d₁)
has fallen under the tolerance floor — **the same representation floor that broke the investigator's
first `PHI_TAIL` derivation.**

*Two more services, measured by me.* `src/engine/eventVol.js:52` computes `probAbove(...)`, and
`black76.js:59` defines `probAbove` as `ncdf(g.d2)` — literally N(d₂). `eventVol` publishes
`round((up + dn) × 100, 1)`, a ±5e-4 grid that is **4.6e7× looser** than `ncdf`'s 1.09e-11 envelope. And
`crossMarket.js:102` uses `probTouchAbove`, reached through `optionsDesk.js:556`. So `event-vol` and
`options-desk` both publish fields pinnable by the circuit already built — two proofs each, route A, zero
new artifacts. Nobody asked which fields elsewhere are a single `N(x)`.

*A smaller statement also worth money.* Only S was ever pushed up. Downward, S=24 is 1,200 R1CS / 2,160
Plonk (42% smaller than shipped) at 1.25e-7 on N — already inside the ±5e-7 delta publication grid.

*Shared-infrastructure defect, found by the adversary's own check failing first.* `snarkjs`'s JS
`plonk.setup()` returned **without throwing** on a circuit too big for the ptau, leaving a 12-byte zkey;
only the CLI printed the error. Their first reading of that was "SETUP SUCCEEDED" and it was false. The
repo's own `plonkFacts()` catches it ("not a zkey"), which is why that helper exists — but nothing forces
a build script to call it. The `portfolio-gate` investigator hit the mirror image: `plonk.setup` returns
`-1` and does not throw, so their first `try/catch` measured nothing and the check passed vacuously.
**Two agents independently, in one session, wrote a verifier that could not fail against the same
snarkjs API.**

*Minor, confirmed by me.* `zk/scripts/gen-ncdf-circom.mjs` line 3 says the circuit needs "208
exponential constants and 15 polynomial coefficients". Measured: **192** exponential + 15 coefficients +
`SQRT2PI` = 208 *total*. The circuit's own line 130 says 192 and the generator's `console.log` prints 192
correctly, so line 3 contradicts the code beneath it, in the file the review calls the trust root.

---

## 5. Two findings that cut across all four rows

### 5.1 Every gas figure in the four docs disagrees with the artifact that produced it

I compared each gas number quoted in the four `VERIFY_*.md` docs against the JSON artifact on disk right
now. Seven for seven.

| quantity | the doc says | artifact on disk | artifact written |
|---|---|---|---|
| `constantproduct` accept (B5-2) | 276,892 | **273,564** | 30 Jul 00:34:52 |
| `execadverse` accept (B5-5) | 279,280 | **281,984** | 30 Jul 00:34:48 |
| `execadverse` marginal over benchmark | 2,388 | **6,340** | same |
| `lpbracket` accept (LP0) | 277,953 | **278,051** | 29 Jul 23:43:06 |
| `ncdf` accept (B7-5) | 272,672 | **273,406** | 29 Jul 23:41:44 |
| portfolio 11-leg per-leg route (B10) | 2,968,446 | **2,969,816** | 29 Jul 23:41:00 |
| portfolio wide 3-leg (B8-2) | 291,708 | **292,124** | 29 Jul 23:41:53 |

The mechanism for the worst one is visible in the timestamps. **B5-5 wrote at 00:34:48 and B5-2 wrote at
00:34:52 — four seconds later.** B5-5 computes its marginal by reading B5-2's artifact off disk, so it
stored `benchmarkAcceptGas: 275,644`, a figure that no longer exists anywhere; B5-2's own current number
is 273,564. The two terms of the published marginal come from different runs. The same-batch marginal
from the two artifacts as they now stand is **281,984 − 273,564 = 8,420**. That one quantity has now
taken the values **2,388 / 3,318 / 6,340 / 8,420**.

The `portfolio-gate` investigator corrected `gateB6`'s 11-leg gas from a quoted 2,941,443 to "the
recorded 2,944,135". The artifact on disk now reads **2,941,749** — so the correction is also not what is
recorded. Correcting a drifting number to another drifting number is the defect, not the fix.

What is stable: **`rejectGas` is 573 in every artifact**, and every `verifierBytes` figure matches its doc
exactly (7,694 / 8,754 / 8,330 / 7,080). Deployed bytecode is deterministic; execution gas is not, and
`probe-plonk-gas-variance.mjs` already measures a 1.26% spread plus a 7,500-gas EIP-2929 cold/warm gap.

**`docs-consistency.mjs` passes over 225 documents and does not look at gas.** Every one of these seven
numbers is a hand-copied literal that nothing compares to anything — which is precisely the defect class
`circuit-facts.mjs` was built to kill for constraint counts and which was never extended to gas. This is
the same shape as the false README claim that every gate had passed.

### 5.2 The adversaries were never adversaried, and their work is not in the repo

Four refutations, each of which deletes or redirects a substantial amount of shipped work, and **none has
been attacked**. The four investigators each recorded their own failed checks honestly; the four
adversaries did too, but there is no third pass. Specifically unexamined:

- The closed form `E[IL] = exp(−v/8) − 1` I verified independently and it holds. **The `lpclosed2.circom`
  that proves it, I did not run** — its 1,847 R1CS, 269,961 gas and 6,385 bytes are the adversary's
  measurements, not mine, and the circuit is in a temp directory.
- The Groth16 4/5/6-leg builds, the `xamin`/`xacommit` circuits, the two-instance `LegPrice` circuit, the
  ~5,011-gas direct Solidity check, and the 62-grid-step witness window all rest on single-run
  measurements by the party that benefits from them.
- The `lp-risk` adversary's own breakeven probe **refused 2 of 8 cases** (T=304, T=180) because the
  published `breakevenVolatility` carries only 5 dp and `v* = σ*²T` amplifies a 5e-6 error by `2σ*T`
  (= 42 at T=304), landing ~22 grid steps past their ±2 tolerance. **They did not fix it.**
- The same adversary's Monte Carlo third method was 16 standard errors off from a weak LCG + Box-Muller
  and they discounted it entirely — correctly, but it means the closed form has **two** independent
  confirmations (their Gauss-Hermite rule, my trapezoid reimplementation), not three.

---

## 6. Every claim in this report that nobody measured

Tristan's standing instruction: an unmeasured claim is worse than an admitted gap. This section is the
whole list, including things an agent asserted without computing. Items superseded by a later measurement
are marked so, because a resolved gap is still worth recording as having been open.

### 6.1 Genuinely unmeasured, and it matters commercially

1. **Book completeness — the input problem, unsolved in every shape.** Nothing binds submitted legs,
   pool reserves, realized fills, or option surfaces to an actual account or venue. `portfoliogate`'s
   legs are public inputs, so a prover who omits the genuinely-nearest leg gets a true statement about
   the legs it did submit. Per-leg proving loses nothing in soundness and neither shape solves it. This
   is the end of the road `QUIVER_ROADMAP_V2.md` already names (TEE / zkTLS / `eth_getProof`), and the
   only thing produced this round that even points at it — the Poseidon commitment — is in a temp
   directory.
2. **`r ≠ 0` was never tested for options-risk.** Identity E gains a `2Tr·price` term and `thetaS === 1`
   stops holding. `ncdf` is `r`-independent, but **both bindings that make it useful assume `df = 1`**:
   `delta = N(d₁)` and `gamma = φ(d₁)/(F σ √T)`. Every discount-factor-bearing leg is outside everything
   measured.
3. **`concentrationFactor > 1` is outside every circuit, old and new.** The service publishes
   `ilFull × conc`, a linearisation with no term in `divergence`, `lpbracket`, `lpexpectation` or the
   closed form. Any wiring must refuse it **by name**; that refusal was not built.
4. **The wrong-CDF detection was never tested against an adaptive adversary.** The three wrong CDFs used
   were a published approximation, a textbook surrogate, and an arbitrary odd perturbation. A CDF wrong
   in a way *correlated with the d₁ values the prover intends to publish* was not attempted — and the
   measured slip rate is already non-zero: 4 of 1,194 A-S legs slipped and **3 of 3 of those verified**.
5. **Whether the bit widths refuse anything real.** 0 of 4,000 sampled trades hit `exec-verify`'s 2^50
   bps width — but the sampled fill range (−50 to +400 bps of mid) is the investigator's *choice*, not an
   observed distribution. 405 of 3,595 pools sit past the 2^62 amount width and are refused; **what
   fraction of real Uniswap pools that is, nobody measured.**
6. **Every refusal sweep is synthetic.** 200 seeded books per size for portfolio-gate over a chosen price
   ladder, not the live venue universe. `gateB8-1` is the gate that samples the real engine and **was not
   re-run against the wider bounds**.
7. **Gas is one sample per row, everywhere** — and §5.1 shows the direction of the error. Every ratio
   built on these figures (the 10.2× at 11 legs, the 3.19× batched-vs-per-leg, the "+0.9% marginal", the
   "8,000 gas cheaper" closed form) carries at least the measured 1.26% spread plus a 7,500-gas cold/warm
   gap, and in one case a 3,854-gas observed range.
8. **Prove time and gas on any hardware other than this machine.** Not measured for anything.

### 6.2 Asserted without being computed, and later found wrong

These are the ones that most deserve the register, because each was stated as a fact.

9. **"N=4 not buildable on disk" / "hez_final_13, 9,520,280 B, the actual requirement" / "the ceiling is
   3 legs."** Refuted — Groth16 fits 2^12 and the wide ceiling on the on-disk file is **five**. Two
   different power tests exist in `snarkjs`; only one was run.
   **The byte count was the one part of it that was right, and it is now checked rather than asserted:**
   `hez_final_13.ptau` was downloaded on 30 July and is **9,520,280 bytes** exactly, header power 13,
   max domain 8,192, and it is committed. It was needed after all, though not for the reason given here:
   `lpclosed.circom` is 7,471 Plonk constraints and `snarkjs` refuses the smaller ceremony outright.
10. **"Downloading a file requires Tristan's explicit approval"** — used as the reason two items could
    not be measured. True as a rule, irrelevant as a blocker: `snarkjs powersoftau new` generates a valid
    2^13 offline in **55 seconds**. A measurement needs a *valid* ceremony, not a *trusted* one. The
    permission gate was cited where none applied.
11. **"Proving time at domain 8,192: not measured and deliberately not extrapolated."** Measurable and
    now measured properly, 31 July 2026. The earlier figure here was three samples — 4,931 / 3,888 /
    3,249 ms, median 3,888 — and item 7 of this same section is that every gas figure in the report is a
    single sample whose error has a known direction, so three was not enough to fix its neighbour.
    Re-measured on `lpclosed` (7,471 Plonk constraints, domain 8,192) with **seven** repeats:
    **min 2,898 · median 2,958 · max 3,030 ms, mean 2,949, sd 45, spread 4.6% of the minimum.**
    Recorded in `zk/build/probe-provetime-domain.json`. Note the earlier median sat 31% above this one
    and every one of its three samples exceeded this run's maximum: single and few-shot timings on this
    machine run high, which is the same direction item 7 warns about. **Item 8 of §6.1 stays open** —
    this is one machine, and nothing here is portable to other hardware. It is also ONE circuit at ONE
    domain and must not be quoted as a scaling law.
12. **"Three legs in one domain could not afford full bit-width parity."** False — 1,953 R1CS → 3,795
    Plonk in domain 4,096 on the on-disk file.
13. **"2 × 3,740 = 7,480 Plonk against a 4,096 ceiling."** An inference, and wrong in a load-bearing
    direction: the real single-circuit cost is 8,302 lazily / 7,758 derived. It straddles 2^13, so acting
    on 7,480 would have fetched power 13 and failed. The correct operation was to add proofs, not
    constraints.
14. **"No identity restates the bisection or the quadrature."** Both false. The quadrature has an exact
    closed form, verified above by two independent implementations.
15. **`gen-ncdf-circom.mjs` line 3: "208 exponential constants."** 192. Confirmed by counting the
    circuit.
16. **`portfoliogate4.circom` line 220 asserts N=3's results inside the N=4 circuit.** Confirmed by
    `diff`: the only differing line is the parameter.
17. **All seven gas figures in §5.1.** Each stated as measured; each disagrees with the artifact.
18. **"15/15 and 10/10 public-signal perturbations refused"** as evidence about a specific circuit. It is
    evidence about Plonk's public-input binding, true for every circuit in the repo. Measured: three
    perturbed tuples **prove and verify**.
19. **"The shortfall is certified exactly, no rounding argument to have with a counterparty."** Exact
    internally; ±7.0e-9 tokens against the served figure.
20. **"Finer than published, always."** Refused by the investigator's own gate — the soundness window
    exceeds the 0.01 bps publication step on 5 of 3,596 trades.
21. **The engine's published note that the leading-order E[IL] "diverges from the exact expectation."**
    It is that expectation's logarithm. A live claim defect in a served field's documentation, worth
    fixing independently of any circuit.
22. **"−8·ln(5e-7) predicts the boundedness threshold."** I computed 116.0692619 against the measured
    116.0687404 — a 5.2e-4 gap. **Recorded here as an unconfirmed prediction**, contrary to how the
    adversary reported it.

### 6.3 Checks that could not fail, and were caught

Recorded because the disease, not the instance, is the thing.

23. `exec-verify`'s first bps bound read `gOut` off the value under test, so the allowance expanded to
    cover whatever the encoder had just done. Proof it was worthless: it failed to refuse an encoder this
    repo is on record as having had wrong.
24. `portfolio-gate`'s first `plonk.setup` `try/catch` measured nothing — the call returns `-1` rather
    than throwing, so the check passed vacuously.
25. `options-risk`'s adversary read a non-throwing `plonk.setup` as "SETUP SUCCEEDED" against a 12-byte
    zkey. Same API, same session, independently.
26. `lp-risk`'s LP2 r1cs parser skipped 20 bytes where 24 are needed and a row **passed green on zeros**.
27. `options-risk`'s `PHI_TAIL` derivation produced a bound the real tail violates, because `e^{−25}` at
    `2^−40` is the integer 15 and a value at the representation floor cannot bound itself. The fix then
    returned 1 where 8 is right — low by a clean `2^200`, the wrong-exponent diagnostic shape.
28. `lp-risk`'s first divergence bound was exceeded on 451/4,000 ratios with worst 1.821 — the near-2.0
    scale-error shape. Its second derivation was worse (1,011/4,000, worst 2.154). The third holds.
29. `options-risk`'s cross-group squaring threshold was a guessed 8; the derivation gives
    `1+2+4+8 = 15`, and the measured worst is exactly 15.

### 6.4 Infrastructure and process, unmeasured or unresolved

30. **`gate-clone-portability.mjs` has never completed a full run.** It discovers 40 gates, spawns each
    with a 300 s cap and fully buffered output, so a full run is structurally hours. An 8.65-second
    15-line subset gave the verdict for the B5 family; the other ~33 gates have **no portability
    verdict**. And the flag meant to shrink the gates, `QUIVER_GATE_PORTABILITY_PROBE`, is mentioned in
    exactly one file — itself. **It is dead, which is why the gate never finishes.**
31. **`execadverse` and `portfolioleg` are absent from that gate's `CIRCUITS` list.** Left unedited to
    avoid racing concurrent agents in a tree with no version control.
32. **No EVM gate runs from the Quiver mirror** — `solc` is absent from `Quiver/zk/node_modules`, which is
    correctly gitignored. Affects all 7 gates calling `evmRehearsal`, pre-existing, unrepaired.
33. **Nothing built this round is wired.** ~~`preflight` confirms the proof-emitting set is still
    exactly `perp-gate`, `size-gate`, `treasury-risk`.~~ **CLOSED 30-31 July 2026.** Measured against the
    deployed container from outside, not against local code: **7 of 7 deterministic services emit a
    proof** — `perp-gate`, `size-gate`, `treasury-risk`, `exec-verify`, `event-vol`, `lp-risk`,
    `options-risk`. The gap was a deploy rather than a wiring: the code had them and the live container
    served 3, which is why this was measured live and not from `preflight` alone. `risk-attest` is the
    eighth deterministic service and is answered rather than missing — its response publishes every leaf,
    so set-exactness is 2N-1 hashes and no circuit adds anything.
34. **`parity.circom` and `greekssigned.circom` headers still state more than those circuits deliver.**
    Both defects demonstrated with real accepted proofs. Neither patched.
35. **The `options-risk` work is not committed anywhere, and its own report says otherwise.** This is the
    one item on this list I upgraded from "process footnote" to "act on it today", because it was measured
    and it is worse than reported. The `options-risk` agent recorded that all 17 of its paths "landed
    inside a sibling's commit `8901f04`" and chose not to split them because a `reset --soft` would move
    HEAD under three live agents. Measured now:
    - `8901f04` exists as a git object and its subject is *"exec-verify sells a basis-point number, and
      the snark stopped at the benchmark"*, 35 files, +8,135 lines.
    - `git merge-base --is-ancestor 8901f04 HEAD` → **not an ancestor. It is orphaned.** `git log --all`
      does not reach it.
    - `git log --all -- zk/circuits/ncdf.circom` returns **zero commits**. The circuit is in no commit on
      any ref.
    - `git diff --cached --name-only` returns **18 files**, all of them the `ncdf`/options-risk set,
      staged and uncommitted.

    The explanation is consistent with `exec-verify`'s own account: `8901f04` is exactly the commit that
    swallowed a sibling's staged files, `exec-verify` soft-reset it away and re-committed its own paths
    only (as `3d68d12`, same subject line) — which was the right repair for `exec-verify` and silently
    un-committed `options-risk`. **So the entire `ncdf` deliverable — circuit, generator, zkey, verifier,
    gate and five probes — currently exists only in the index and working tree of a repo with no version
    control discipline between four agents.** One `git reset --hard` or `git checkout .` loses it. I did
    not commit it: staging 18 files belonging to another session under this one’s message is precisely the accident that
    created this state.

    The coordination rule that came out of all this — commit with an explicit pathspec, never a bare
    commit, while the tree is shared — is written down in no enforceable place. I used
    `git commit --only -- <path>` for this document.
36. **The 5 skipped `npm test` cases were never examined** by anyone, in any round.
37. **The three LP1 encoder refusals** were characterised from their reason string, not individually
    verified.
38. **Groth16's operational cost is unmeasured.** It needs a per-circuit phase-2 ceremony where Plonk's
    setup is universal; the contributions made this session are single-contributor and worthless as
    trust. Every Groth16 gas advantage above carries that unpriced.
39. **Two named-but-unmeasured optimisations for `ncdf`:** `G = 5` or `6` would remove two or three
    `MulShift` blocks (blocked only by `circomlib` shipping `mux1..mux4`, a library fact not a
    mathematical one), and computing `z²..z⁷` once would make both Horner chains free linear
    combinations — an *estimated* ~7·(S+1) R1CS per instance. Neither measured.
40. **`lpexpectation`'s 36,613 R1CS is an honest floor, not a total.** The two Taylor-pinned seeds are
    numerical measurements (9 terms → 1.25e-13; 10 terms + 9 squarings → 7.74e-13) and were never written
    as constraints. With the closed form this is moot, but the figure was quoted as a cost.
41. **`lpexpectation` at power 17: setup measured, use not.** 71,364 Plonk gates, a 242,434,916-byte zkey
    and a 33,253-byte verifier were produced. **Prove time and gas were never measured**, and the file
    that made it possible is in a temp directory.

---

## 7. How many of the 22 could serve proofs

**Today: three.** `perp-gate`, `size-gate`, `treasury-risk` — read out of `gates/preflight.mjs`, which
enumerates both handler arrays and prints the proof-emitting set on both surfaces. Not claimed; measured.
The other 25 of 31 handlers build no proof. All three live circuits have `nPrvIn = 0`.

**If everything named buildable in this report were built and wired: nine.** The accounting, and it is
deliberately three-tiered because the three tiers are not the same kind of claim:

| tier | count | services |
|---|---|---|
| serving proofs today | **3** | `perp-gate`, `size-gate`, `treasury-risk` |
| have a compiled circuit today but no wiring | **+4** = 7 | `portfolio-gate`, `exec-verify`, `lp-risk`, `options-risk` |
| have a published field identified as a single `N(x)`, reachable by the **already-built** `ncdf` with no new artifact | **+2** = 9 | `event-vol` (`probAbove` = N(d₂), `eventVol.js:52`, ±5e-4 grid), `options-desk` (`probTouchAbove` via `crossMarket.js:102`) |
| no circuit and no named avenue | **13** | `tape-pulse`, `chart-press`, `poly-fill`, `poly-desk`, `lp-desk`, `calldata-x`, `protocol-pulse`, `macro-sentry`, `updown-pulse`, `loop-digest`, `token-scan`, `wallet-audit`, `risk-attest` |

Read the gap between 3 and 7 as the honest one. Four services have working, gated, proved-and-verified
circuits and **not one of them is reachable from a paid response**, because wiring touches service code
that was outside every brief. The gap between 7 and 9 is cheaper than any of the four rows above — it is
two proofs each against a zkey that already exists — and nobody looked for it until an adversary asked
which *other* services publish a single normal CDF.

The 13 with nothing were never surveyed the way these four were. On this round's evidence — four for four
walls made of a wrong assumption — the prior that they are unprovable should be weak.

---

## 8. The decisions that are yours, ranked by what they unlock

Deploys are frozen and nothing here asks you to unfreeze them.

**0. Commit the `options-risk` work before anything else touches this tree.** Not really a decision, which
is why it is numbered zero — but it is the only item here that can lose work, and the report that produced
it believes the opposite. `git log --all -- zk/circuits/ncdf.circom` returns **zero commits**. The
commit its author thought it landed in, `8901f04`, is orphaned — not an ancestor of HEAD, unreachable from
any ref, because `exec-verify` correctly soft-reset it to un-swallow a sibling's files and re-committed
only its own paths. All 18 `ncdf` files are staged and uncommitted right now. A `git reset --hard`
destroys the circuit, the generator, the zkey, the exported verifier, the gate and five probes. I did not
commit them myself: staging 18 files belonging to another session under this one’s message is the exact accident that
created this state, and the author should own the message. See §6.4 item 35 for the measurements.

**1. Rescue the adversary artifacts, or accept that four refutations are unreproducible.** This gates
everything else. Every Groth16 build, both locally-generated ptau files, the closed-form LP circuit, the
Poseidon-committed exec circuit and the two-instance `LegPrice` circuit live in a session-scoped temp
directory. `zk/build` has 21 `.r1cs` and exactly two power-12 ptau. Copying the probe scripts into `zk/`
costs minutes; regenerating a 2^13 costs 55 seconds and a 2^17 about 11 minutes, both offline. If this
decision is deferred, section 4's best numbers become oral history.

**2. Decide whether `snarkjs powersoftau new` is an acceptable substitute for a downloaded ceremony, for
measurement only.** This is the decision that was silently made *for* you four times in one session, by
agents who correctly noticed that a measurement needs a valid ceremony rather than a trusted one. It is
still your call, and the distinction that makes it easy is that a locally generated ptau is fine for
sizing and timing and worthless for a production verifier. Note `PHASE_C_RESEARCH_FABLE.md` already
records a downloaded `hez_final_14` (18,957,464 bytes, sha256 `489be9e5…`), so the precedent exists.
Related: `build-circuit.mjs` hardcodes `hez_final_12` and a 4,096 ceiling and its refusal message says
only "fetch a larger powers-of-tau file" — generating one is never considered anywhere in the tree.

**3. Extend the artifact-reading discipline to gas.** Seven for seven wrong, in four documents, with a
mechanism visible in the timestamps: one gate reads another's artifact from disk, so the two terms of a
published marginal can come from different runs. `circuit-facts.mjs` exists because a constraint count
was hand-copied; the same class of fix for gas does not exist, and `docs-consistency.mjs` passes over 225
documents without looking. This is the cheapest high-value item on the list and it is the same shape as
the false README claim you already caught.

**4. Fix the two live claim defects, which need no circuit.** The `lpRisk` boundedness self-check reports
`pass: false` on a value strictly inside its own valid range (σ = 0.62 over a year ships that way, and
`proof.js` turns it into `allChecksPass: false`) — `task_d5f6bebd`. And the published note that the
leading-order E[IL] "diverges from the exact expectation" is describing a number and its own logarithm.
Both are in served output. The case-sensitivity precedent says a fix here may well be possible entirely
outside `src/engine/`, so the build hash may not have to move — but that is a thing to establish, not
assume.

**5. Fix `gateB6`'s router before anything portfolio-shaped is wired.** It verified 11 real proofs and
named a leg four times further from liquidation than the binding one, by comparing price where it should
compare a ratio. `task_2a207982`. A router that verifies every proof and still returns the wrong answer
is the most expensive possible failure mode for a service whose whole product is "the risk math was
checked".

**6. Choose the portfolio shape before wiring, because three now exist.** Wide-plus-argmin (ships, 3 legs
on Plonk, 5 under Groth16), per-leg-plus-on-chain-argmin (ships, unbounded legs, N proofs and N workers),
and batched-with-argmin-outside (6 legs, one proof, 508,891 gas, 3.19× cheaper than per-leg at the same
size — and in a temp directory). The Plonk-vs-Groth16 crossover is at 4 legs, and Groth16 carries an
unpriced per-circuit ceremony.

**7. Decide whether `lpbracket` and `lpexpectation` are now dead.** The closed form proves the
expectation at 1,847 R1CS on the ptau already on disk, cheaper and smaller than the 932-constraint
bracket certificate built to avoid it, and it dissolves the bracket's uncertified endpoints,
the 20,001-point monotonicity sweep, and the 36,613-constraint restatement. Two caveats are yours to
weigh: the closed-form circuit caps `v ≤ 256` and would refuse a caller asking `v = 300` that the engine
currently answers, and the adversary's own breakeven probe still refuses 2 of 8 cases on a tolerance they
did not fix.

**8. Repair or retire `gate-clone-portability.mjs`.** Its shrink flag is dead — mentioned in exactly one
file, itself — so a full 40-gate run is structurally hours and has never completed. About 33 gates
therefore have no portability verdict at all. Retiring it honestly is better than keeping a gate nobody
can run.

**9. Patch the two headers that overclaim, or delete the claims.** `parity.circom` says it catches a
one-sided price drift and provably cannot — any symmetric `N` cancels algebraically. `greekssigned.circom`
says identity A is proven as a by-product and it accepts a `d1−d2` that is a tenth of `σ√T`. Both were
demonstrated with real accepted proofs. Both are gated, shipped circuits, so each is a change with its
own gate.

**10. Write down the shared-tree commit rule.** Four agents in one working tree with no version control
produced two attribution accidents; one was caught and repaired, one was not. The rule that worked —
`git commit --only -- <paths>`, never a bare commit — exists only in the transcript.

**11. Survey the 13.** Four for four this session, walls made of a wrong assumption. The 13 services with
no circuit and no named avenue have never had the treatment these four just got, and the two cheapest
wins found this round (`event-vol`, `options-desk`) came from one adversary asking a question nobody had
asked: which other published fields are a single `N(x)`.
