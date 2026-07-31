# The defect register did not contain the defects

**Written 30 July 2026.** `docs/known-defects.md` held three entries. A four-service Phase B
investigation and four adversarial passes over it had produced ten more, four of them confirmed, one of
them shipping in a live envelope, and none of them on the page whose entire purpose is to disclose our own
bugs. This is the account of establishing what was actually open, writing it down, and building the check
that will not let the page drift again.

The register now runs to thirteen sections. Ten were added today. Two of the ten were **fixed by sibling
sessions while this page was being written**, one of them minutes before the gate first ran — and that is
the most useful thing in this document, so it is in §6 rather than buried.

---

## 1. What was already there, and what was missing

| § | on the page before today | status now |
| --- | --- | --- |
| 1 | `side` / option `type` matched as exact lowercase strings | fixed 29 Jul |
| 2 | 12 of 13 observation services ship `selfChecks: []` while the summary promises a proof | still open |
| 3 | `portfolio_gate` sealed a live venue read inside a `deterministic: true` proof | fixed 29 Jul |

Nothing else. The four `VERIFY_*.md` reports and `PHASE_B_VERIFIED.md` between them named the ten below.

---

## 2. Every defect established as open, and how

Each was re-measured here rather than copied. Where the reproduction disagreed with the report, the
register follows the measurement.

### §4 — Eighteen of twenty-one circuits have no private input, and a proof costs 134× the direct check

`.r1cs` section-1 headers parsed with a purpose-built reader (no `snarkjs`, no `circuit-facts.mjs`, a
non-vacuity guard that throws on a zero — the `lp-risk` investigation's own parser read `nLabels` as
`nConstraints` and had a row pass green on zeros):

```
circuits: 21          nPrvIn == 0: 18
nPrvIn > 0 : lpexpectation(246), portfoliogate(3), portfoliogate4(4)
```

Every circuit on the paid path — `liquidation`, `kelly`, `concentration`, and `execadverse` since today —
measures `nPrvIn = 0`. The R1CS totals reproduce `PHASE_B_VERIFIED.md` §3 exactly, including
`liquidation` at 667 and `portfoliogate4` at 2,736.

**The paper's claim, read before writing the entry**, because the brief said to check it. `whitepaper.md`
already discloses the count and disclaims privacy:

> "The word for it is *succinct*, not *zero-knowledge*: the circuit has **zero private inputs**, every
> value it consumes is one the service already publishes, and it hides nothing."

That is honest, and the register quotes it approvingly. What the paper leaves standing is **succinctness**,
resting on "what re-execution needs is a *runtime*, and a smart contract has none". With every input
public, a contract needs no runtime to check the identity — so the question is what the pairing check buys
over checking the predicate, and nobody in this repository had measured it. The figure in circulation —
"about 55×", from an unmeasured ~5,011-gas direct check — is one `PHASE_B_VERIFIED.md` §3.1 explicitly
declines to own: *"I did not myself measure the ~5,011-gas direct Solidity check."*

So it is measured now. **`zk/scripts/probe-direct-vs-snark-gas.mjs`** proves the liquidation identity for a
real `perp-gate` answer and evaluates every constraint `liquidation.circom` imposes — five range bounds,
`(s−1)(s+1) = 0`, `mmr < 1`, `q ≠ 0`, the residual and the derived bound `2|R| ≤ q̂(SCALE + m̂mr)` —
directly in Solidity over the identical integers, each side in a **fresh EVM** so neither gets the
EIP-2929 warm discount:

| | accept gas | deployed bytes |
| --- | --- | --- |
| Plonk pairing check | 273,693 | 7,270 |
| the same predicate, in Solidity | 2,050 | 790 |

**133.5×**, against the 55× in circulation — the borrowed figure was wrong in the direction that flattered
the proof. The probe refuses to report either number unless the direct checker behaves: it must accept the
honest witness, refuse the same one-grid-step perturbation of `pLiqHat` that the on-chain registry records
as `ProofRejected`, and refuse `side: 0`, `mmr ≥ 1` and `size: 0`. A cheap checker that accepted everything
would post a wonderful ratio for checking nothing.

It also measures its own error bar, because the two columns are not the same kind of number: twelve proofs
of that identical statement spread over 3,022 gas (1.1%), while the direct check returns identical gas on a
second run. The left column is a sample; the right one is a value.

**Not being fixed**, and the entry says why: closing it means a Poseidon-committed circuit — a new
statement, gate and wiring — and both `src/engine/` and the paper are frozen.

### §5 — `lp-risk`'s boundedness self-check fails on a live call

Reproduced through the service's own handler, not the engine:

```
lp-risk {volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000}
  ok true · expectedIlPct -100 · totalVariance 140.306
  proof.allSelfChecksPass  false
  [FAIL] boundedness: reported expected divergence lies in (-100%, 0] ...  residual = -100
  isChargeable(result)     false
```

The check ranges over `round(E[IL]·100, 4)`, so once the expectation reaches −0.9999995 the display value
is exactly `-100` and `-100 > -100` is false. The value is not wrong: full precision it is
−0.9999999758323288, strictly inside the interval the check demands. Threshold bisected here rather than
recalled: **σ = 0.5639118274086009 at T = 365, σ²T = 116.06874041832731**, matching the figure
`VERIFY_LP_RISK.md` reports to every digit.

**What a caller sees was worse than the reports said, and it took reading `x402.js` to find.**
`isChargeable()` returns false on any failed self-check, so the paid path answers with
`PAYMENT-RESPONSE: status "not_charged", reason "input rejected by engine — no settlement"`. A buyer asking
an ordinary question about a 62%-vol LP position is told **their input was rejected**, over an answer that
is correct and delivered, and the seller loses the fee.

**This is the one that is deliberately not being fixed.** It is inside `src/engine/lpRisk.js`, it moves
`q1-e1fa99d08887d6cc`, and it is Tristan's call. The register says so in its status line and states the
one-line shape of the fix for whoever owns the next engine change.

One prediction is recorded as **unconfirmed** rather than as agreement: the closed form puts the flip at
`−8·ln(5e-7)` = 116.06926190819375, which is 5.2e-4 from the measured threshold — consistent with the
engine's `|z| ≤ 6` quadrature truncation floor, and not the analytic confirmation a sibling report called it.

### §6 — the served note describes a number and its own logarithm as a diverging approximation

Recomputed over eight (σ, T) pairs spanning σ²T from 0.075 to 259.2:

| | worst |
| --- | --- |
| `expectedIlPct` vs `round((exp(−σ²T/8) − 1)·100, 4)` | 3.96e-5 pp — inside the 5e-5 half-step |
| `approximationGapPct` vs `round((e^x − 1 − x)·100, 4)` | exact in 8 of 8 |
| `1 + pct/100` vs `exp(leadingOrder/100)` | 3.32e-7 |

`E[IL](v) = exp(−v/8) − 1`, so the leading-order `−v/8` is `ln(1 + E[IL])` and the published
"approximation gap" is `e^x − 1 − x`, which measures nothing about accuracy. Same file, same freeze, same
decision as §5.

### §7 — `gateB6` passed "the contract picks the right leg" while ranking by price

The router kept `min(signals[i][NPUB − 1])`, which is `pLiqHat`. Reconstructing the gate's own eleven-leg
book through the real engine:

| ranking | leg | adverse distance | liquidation price |
| --- | --- | --- | --- |
| distance (`moveToLiqPct`, the engine's, `portfolioGate.js:107`) | **10** | **6.103%** | $300.47 |
| liquidation price (`gateB6`'s router) | 3 | 24.089% | $0.4706 |

**And the reason it stayed green is the more interesting half**: the gate's expectation was
`prepared.reduce(… BigInt(b.sigs[NPUB - 1]) < BigInt(a.sigs[NPUB - 1]) …)` — a price minimum in JavaScript
compared against a price minimum in Solidity. The check could not fail on the error it was about.

### §8 — the clone-portability gate listed 14 of 21 circuits, and missed the one the clone lacks

```
listed  (14): kelly, concentration, divergence, constantproduct, padprobe, greeks, greeksfp,
              greekssigned, parity, portfoliogate, kellybatch1..4
OMITTED  (7): execadverse, liquidation, lpbracket, lpexpectation, ncdf, portfoliogate4, portfolioleg
```

And the fact that makes it more than a coverage gap, measured directly: `zk/build` holds 21 `.r1cs`,
`Quiver/zk/build` holds 20, and **the missing one is `liquidation`** — the flagship, the circuit the paper's
Appendix C exhibit and both on-chain registry transactions are about. `gateB6` is the only gate that proves
against `zk/build/liquidation_*`, so it is the only gate that cannot run from a clone at all.

The live service is unaffected and the register says so plainly: proving artifacts live in `assets/zk/`,
are tracked, and are checked at deploy time by `preflight.mjs`. What is affected is the one claim a
reviewer will actually test — clone it and reproduce the numbers.

The shrink flag `QUIVER_GATE_PORTABILITY_PROBE` was found in **exactly one file: the gate itself.**

### §9 — every gas figure in the four reports disagreed with its artifact, and every disagreement was noise

Seven pairs, doc against JSON. All seven differ, and all seven are quoted in the register rather than
deleted. The measured context is what makes them a defect of a particular kind: across proofs of an
*identical* statement the verify figure spreads by 1.10%, 1.24%, 1.34% and 1.59% in four runs today, on
three circuits. Six of the seven disagreements are inside that band — the largest, 276,892 against 273,564,
is 1.22% out. **None of them was a wrong measurement.** They were samples published to six significant
figures, and one of them was then subtracted from another such sample, which is how one marginal took the
values 2,388 / 3,318 / 6,340 / 8,420 with nothing in the circuits changing.

### §10 — three of the four circuits built this round are unreachable from a served answer

`src/util/proverWorker.mjs` carries a closed set of circuit names and that set decides what a response can
carry. `portfolioleg`, `lpbracket` and `ncdf` are compiled, gated and unreachable.

### §11 — two shipped circuit headers claim more than the circuits prove

Both sentences re-measured as still present. `parity.circom` claims to catch a one-sided price drift and
provably cannot: for any `N` with `N(−x) = 1 − N(x)` — which the engine's `ncdf` has by construction,
returning `x <= 0 ? c : 1 - c` — the CDF cancels out of `C − P = df·(F − K)` algebraically. It carries a
second sentence that has been false since today: *"That residue is unchanged and stays until erf is
provable"* — `ncdf.circom` computes the CDF, and the engine never computed `erf`.
`greekssigned.circom:26` claims identity A as a by-product; `dDiff` is an unconstrained witness. The forged
proofs are the `options-risk` investigation's, labelled as such; the algebra was re-derived here.

### §12 — three constants inside the trust root contradict the code beneath them

`portfoliogate4.circom:220` states N=3's result inside the N=4 circuit, whose header measures 2,736.
`gen-ncdf-circom.mjs:3` says "208 exponential constants" where the emitted circuit has **192** — counted
here as 12 `Mux4` groups and 192 `.c[i] <==` assignments, agreeing with the circuit's own line 130 and the
generator's own `console.log`. And `vk_plonk.json` is the `liquidation` verification key under a name no
other circuit uses.

### §13 — the four refutations are not reproducible from the repository

37 adversary circuit sources were rescued out of temp into `zk/circuits/adv/`. **`git ls-files zk/circuits`
returns 22 paths and none is under `adv/`** — so they sit in a working tree that is not under version
control at all, which is the same exposure that left a whole circuit surviving only in an index last night.
Not one has a zkey; there are exactly two ceremony files, both power 12 at 4,801,688 bytes.

---

## 3. `gates/gateN-known-defects.mjs` — the check that makes this page able to go red

19 checks. For every open section the symptom is re-measured and the register must disclose it, **in both
directions**:

- the defect is present and the page is silent → red, a hidden defect;
- the defect is gone and the page still says so → red, a stale disclosure. On this page that is the worse
  of the two, and the register's own note about 29 July says so.

So closing a defect breaks the gate until the entry is updated. That is the point, and it is not
hypothetical — see §6 below.

What it measures rather than trusts: `.r1cs` headers byte by byte with a non-vacuity guard; the prover's own
closed set of circuits, so wiring a fifth is caught rather than assumed away; the engine, called for real,
for §5 and §6; `gateB6`'s eleven-leg book read out of the gate source and re-priced, so the two cannot
drift apart; the probe artifact's internal consistency before either of its gas figures is allowed to
matter; and every gas figure on the register itself, in prose **and in table cells**, which must carry a
`<!--gas:ARTIFACT#FIELD-->` citation or be a quotation.

That last check found its own hole while the revert was being written. Its first version asked whether the
*line* carried a citation, so a table row with two cited cells covered for a third that had none — which is
precisely where six of the seven wrong figures in §9 lived. Its second version had a prose pattern that
could not see a bare number in a column headed "accept gas" at all. The revert is what caught both.

### `gates/gateN-revert.mjs` — seven mutations, and two of them prove the gate is not redundant

```
GATE N REVERT — 2026-07-30T02:13:05.904Z
  register copies under test: hackathon/KNOWN_DEFECTS.md, Quiver/docs/known-defects.md

  baseline: gate N is green
  baseline: docs-consistency says nothing about the register

  [PASS] a deleted section makes gate N red, and docs-consistency does not notice
  [PASS] marking a live defect FIXED makes gate N red
  [PASS] editing the private-input count makes gate N red
  [PASS] dropping the missing artifact from §8 makes gate N red
  [PASS] removing a gas citation makes gate N red, and docs-consistency does not notice
  [PASS] misdirecting a gas citation is caught by docs-consistency, which gate N leaves to it
  [PASS] every copy of the register is byte-identical to how it started

GATE N REVERT: PASSED — 7 mutations, each one red where it should be
```

Both copies are mutated together, because gate N also checks they are byte-identical and mutating one
would produce a red for the wrong reason. Everything is restored in a `finally` and the restoration is
itself asserted.

The two rows naming `docs-consistency` are the argument for gate N existing at all. Deleting a whole
section, and stripping a gas citation off this page, are both invisible to the 229-document checker — the
first because it has no concept of a defect, the second because its gas rule covers the four `VERIFY_*`
reports and not this one. The sixth mutation is the mirror image: a citation pointed at the wrong field is
caught by `docs-consistency` and **gate N is required to stay green on it**, because a gate that fires on
everything is as uninformative as one that fires on nothing.

`docs-consistency` is judged on the *delta* rather than on being globally green, because four sibling
sessions are editing this tree at the same time and a contradiction in someone else's document is not this
script's business.

---

## 4. Numbers this session produced

| what | measured |
| --- | --- |
| compiled circuits / with `nPrvIn = 0` | 21 / **18** |
| circuits on the paid path, all with `nPrvIn = 0` | 4 — `liquidation`, `kelly`, `concentration`, `execadverse` |
| Plonk verify vs the same predicate in Solidity | 273,693 vs **2,050** gas · 7,270 vs 790 bytes · **133.5×** |
| spread over 12 proofs of one identical statement | 3,022 gas, 1.1% of the mean |
| the borrowed figure it replaces | ~5,011 gas, "about 55×", measured by nobody |
| `lp-risk` boundedness threshold at T = 365 | σ = 0.5639118274086009, σ²T = **116.06874041832731** |
| the closed form's prediction of it | 116.06926190819375 — **5.2e-4 away, recorded as unconfirmed** |
| `gateB6`'s two rankings on its own book | leg 10 at 6.103% vs leg 3 at 24.089% — **3.95× further** |
| circuits listed by `gate-clone-portability` before today | 14 of 21 |
| `.r1cs` in `zk/build` vs `Quiver/zk/build` | 21 vs 20 — the missing one is `liquidation` |
| adversary sources in `zk/circuits/adv/` vs in git | 37 vs **0** |
| ceremony files on disk | 2, both power 12, 4,801,688 bytes each |
| gate N checks / revert mutations | 19 / 7 |
| `npm test` | **386**, unmoved |
| engine build hash | `q1-e1fa99d08887d6cc`, unmoved |

---

## 5. What this session did not do

- **It did not fix any defect it disclosed.** Three were owned by sibling sessions and two are Tristan's;
  the deliverable here is the disclosure and the check.
- **It did not re-forge the two accepted proofs** behind §11. Those are the `options-risk` investigation's
  and are labelled as such; the parity algebra was re-derived by hand, the `greekssigned` exponent forgery
  was not repeated.
- **It did not measure prove time or gas on any other machine**, and every gas figure it publishes is one
  sample with its spread stated beside it.
- **It did not widen `docs-consistency`'s rule 9(b)** from the four report documents to the 39 documents in
  this corpus that publish a verify-scale gas figure. `assets/whitepaper.*` is among them and is frozen.
- **It did not touch `src/engine/`, the paper, or any deploy.** `npm test` is unchanged at 386 cases and the
  build hash has not moved.

---

## 6. The thing worth taking from today

**Two of the ten entries were fixed by other sessions between being written and being checked**, and the
gate caught both by going red on this document's own prose:

- `execadverse` was wired into the prover while §10 was being written, so §10's opening sentence — "not one
  of them is reachable from a served answer" — was false within the hour. The entry was corrected and the
  false sentence kept as a quotation, and §10's table is now checked row by row against the prover's own
  closed set, so the next circuit to be wired breaks the gate rather than the page.
- `gateB6` and `gate-clone-portability` were both repaired minutes before the gate first ran. Gate N's
  first run failed on §7 and §8, demanding the register catch up — which is exactly the behaviour asked
  of it, in the direction that is easy to get wrong.

A register is not a document you write once. The reason it held three entries this morning is that nothing
was ever able to tell it it was wrong.

---

### Reproduce

```
npm run gate:n                                     # 19 checks, register against system
npm run gate:n-revert                              # 7 mutations, each red where it should be
node zk/scripts/probe-direct-vs-snark-gas.mjs      # the pairing check against the same predicate
node tools/docs-consistency.mjs                    # 229 documents, gas citations included
```

Files: `docs/known-defects.md` (`hackathon/KNOWN_DEFECTS.md`), `gates/gateN-known-defects.mjs`,
`gates/gateN-revert.mjs`, `zk/scripts/probe-direct-vs-snark-gas.mjs`,
`zk/build/probe-direct-vs-snark-gas.json`.
