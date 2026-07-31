# Five services, five adversaries — the consolidated read

**Written 30 July 2026.** Five sessions each wired or examined a service; each result was then handed
to an adversary told to break it. This document is the single read across all five.

## Provenance rule for every number below

This report consolidates work I did not do. That makes it exactly the kind of document that has
already shipped false claims here — a figure copied from a hand-off report into a document, where no
gate can reach it. So every figure carries its source, and the list of what was measured directly is
closed:

**Measured by me, this session, in this tree:** the proof-emitting set and the handler counts; the
behavioural deterministic/observation split over all 22 services; portfolio-gate's deterministic
branch; `codeHash`; the engine-vs-mirror diff; `npm test`; `preflight`; `docs-consistency`; the
`lpbracket_plonk.zkey` header and the R1CS→Plonk expansion; the presence and text of eight specific
claims in committed source, artifacts and docs; the duplicate `wire-lp-risk` pair; and **which
services serve a Plonk proof on the deployed container, with a like-for-like local control for every
call.**

**Everything else is attributed** to the session or the adversary that produced it and was **not
re-measured here.** Where a figure is attributed, treat it as a claim with a name on it, not as a
fact. Section 4 lists the ones nobody measured at all.

---

## 1. The table

| Service | What it had | What was done | Adversary | Still open |
|---|---|---|---|---|
| **lp-risk** | `lpbracket.circom` already wired on both surfaces (`3c73436`) — the brief's premise that it needed wiring was false. `lpexpectation.circom` built-not-wired. | Verified rather than re-wired. Fixed a live defect: gate LP.3 computed the dropped Gaussian weight 2·Q(6) from a divergent asymptotic series, wrong in the 5th digit, while two comments and a doc carried the corrected value — the correction had never reached the code that computes it. Fixed a second defect: LP.11 read the circom through a path that resolves only from `hackathon/veritape`, so the one test keeping `doesNotProve` from going stale was the one test a buyer could not run. Compiled a closed-form probe circuit to cost it. 2 commits, pushed. | **BROKE IT.** Re-measured four figures — all matched — and closed the one the session said it could not measure (the 1,776 Plonk count, parsed straight from the zkey). Then found two published claims that break. | **The served `doesNotProve` string contains a false sentence and the gate asserts it is false.** `src/util/lpBracket.js:469` publishes "zero non-decreasing steps"; `gates/gateLP-bracket-snark.mjs:482` asserts `flat > 0`. Both verified by me. Same shape as the 2·Q(6) defect the session came to fix, one level out: the correction reached `WIRE_LP_RISK.md` and a comment, not the bytes a paying caller receives. Plus the ceremony-file refutation — see §4.1. |
| **options-risk** | Unreachable by every file in the tree, because `d1` needs `ln(F/K)` and the price needs two CDF points. | The observation that opens it: at r=0 all six `greeks` are rational functions of exactly two transcendentals at the **same** point `d1`. `ncdf.circom` already publishes and pins both. One instance pins six published fields; no new circuit, zkey, ceremony or verifier. Wired both surfaces through one shared builder. Preflight's emitting set and grid exemption updated by name. Caught two of its own defects and recorded both — a bound that could not fail, and a 100x-wrong ratio in its own write-up. | **STOOD UP.** Re-derived both envelope constants bit-identically, re-ran the substitution attack on two seeds, reproduced the public signals bit-for-bit, ran the gate itself (44 checks, 0 failures), reproduced the corrected 6,200x ratio to five digits, and confirmed a third gas sample inside the stated spread. No unsoundness across ~450,000 legs in six boxes plus a hill-climb. | `FP_OPS = 9` (`src/util/optionsRiskNcdfWitness.js:90`, verified by me) is the one term in the encoding bound that nothing constrains — see §4.2. The adversary also measured that the headline "99.9965% of bound" is insensitive to that term over ten million-fold, that one of the seven revert mutations is a tautology (`1.01 > 1`), and that reachability on a realistic position-size box is 84.77% rather than the served 98.62%. All attributed, none re-measured by me. |
| **event-vol** | Already wired (`be0d4c9`) on both surfaces. | Found the gate **red before any edit** and reproduced the cause deterministically: the proof store released its in-flight marker at enqueue, so insertion-order eviction could evict a `building` record, and a repeat request then wrote `unavailable: prover busy` over a proof that was in the prover. Fixed in `put()`; added a gate and a two-sided revert. Corrected nine stale published figures and the TOLC comment trap (the circuit's comparator enforces TOLC/2, so "fixing" 12 to 6 without the evaluator term makes the envelope unsound while looking like a fix). | **BROKE IT.** Rebuilt the circuit's integer path from the circom, replicated the session's evaluator figure to the bit, then **beat it** — 2.536 ulp against a published 2.110, at a point inside event-vol's own domain. Every derived figure moves. Confirmed the shipped guard stays sound and nothing served is wrong. | The published **buyer envelope is not a bound** — it is a sampled maximum presented as a supremum, and it is understated in the direction that flatters the buyer. See §4.3. The eviction fix itself held under attack; two harness observations (a ~2x timing margin in the new gate, and both `put()` hunks reverted as one) are attributed and not re-measured. |
| **risk-attest** | Examined earlier the same day; a 226-line report and 14 supporting files, committed as `6d1037c` and already pushed — the brief's "nobody has ever examined it" was false. | Became its first independent examiner. Replicated the crux from a second implementation transcribed off the response's own `verify` string: set-exactness in 2N−1 hashes, and a root over 9 leaves whose response lists 8 passes every served inclusion proof and is refused by recomputation. Then found two published figures that did not survive a re-run (a headroom and a linearity claim from a 3-point fit with one residual degree of freedom) and **rebuilt the estimator rather than widening the tolerance.** | **STOOD UP.** Re-derived the whole OLS from raw means — every figure matched. Rebuilt the instrument and pushed it past 64 signals. Attacked the linearity with a quadratic out of sample and failed to break it. Replicated the crux at three hidden-leaf positions. | **The finding survives; the gas leg does not.** The adversary measured that a set can be named by a digest rather than enumerated (4 public signals, constant in N), which makes the SNARK route ~42% cheaper — and that no pairing verifier for the enumerated statement can be deployed at all above N=44 (EIP-170, bisected with real deploys). Two clauses of `PROVES` are false as written and revert #5 canonises the strawman. The **finding** never needed the gas leg: the circuit is unbuildable on the constraint floor and there is no privacy to buy. Also: one of the 72 published checks is a tautology (`verify-attest-report.mjs:130`, verified by me). |
| **chart-press / poly-fill / portfolio-gate** | Gate G, its revert, and `wire-classify-two.md` already landed in `b714687` — the task was done and pushed. | Re-measured from the original brief instead of restating it. **Could not reproduce chart-press's throw** in 40 runs across 5 call conventions — it was the harness, not the handler. Reproduced poly-fill's refusal exactly and separated its offline (throws) from its live (refuses) behaviour. Re-derived portfolio-gate's signal layout from the `.sym` rather than from circom convention. Found and pinned a rotted figure in the report itself (proof-emitting set stated as 4 services / 8 entries; it was 6/12). | **BROKE IT.** The corrected figure was **stale again in the same tree**: measured 14 entries / 7 services while both copies of the report still say twelve / 19. The new gate is structurally blind to the mechanism that rotted the figure. And "no divergence bound was derived" is false — the bound exists, is enforced, and the same artifact's `refusalSweep` already shows honest cases exceeding it. | 12/6 is now **14/7** — I re-measured it independently and confirm the report is stale (§4.5). portfolio-gate's circuit is built-not-wired and its `refHat` enters only a range check, so the mark is prover-chosen and the "no other leg is nearer" claim is reorderable without omitting anything. chart-press and poly-fill correctly route to input attestation, not a circuit. |

Nothing in the fifth row was wired. Two services were wired this cycle: **options-risk** (new) and
**event-vol** (repaired). **lp-risk** was already wired and was verified.

---

## 2. The count, measured

Measured by re-running preflight's own `EMITS_ZK` regex over the live handler arrays — never a second
derivation written here, which is the failure mode that shipped a 64-grid-step encoder:

```
handlers total 31 = http 22 + mcp 9
emitting entries 14   ·   distinct services 7   ·   non-emitting entries 17
event-vol · exec-verify · lp-risk · options-risk · perp-gate · size-gate · treasury-risk
```

`gates/preflight.mjs:387` pins exactly this 14-entry set and is **green**.

Then the behavioural split, measured by calling all 22 HTTP services with their real fixture bodies
and asking which envelope came back — 31 input forms:

| Outcome | Services |
|---|---|
| `proof` envelope on every form | 7 — size-gate, exec-verify, options-risk, lp-risk, treasury-risk, risk-attest, event-vol |
| `proof` on one form, `observation` on another | 1 — perp-gate |
| `observation` only | 13 (includes portfolio-gate) |
| refusal (no `proof`, no `observation`) | 1 — poly-fill |

portfolio-gate is the 22nd case and it is a hybrid, not an observation service. Measured directly: a
fully supplied two-leg book makes **0 venue reads**, serves a `proof` envelope with
`deterministic: true`, no `live` block, contentHash `d5c751e8c64643ba…`, per-leg distances
`[10.355, 5.963]`. Which envelope a caller gets is a property of the **body**.

So the honest split is **8 deterministic / 12 observation / 2 hybrid-or-conditional**
(portfolio-gate, poly-fill), which reproduces the split the parent agent measured behaviourally.

### The answer

> **7 of the 8 deterministic services emit a Plonk proof. 7 of the 22 overall.**

The 8th deterministic service is **risk-attest**, and it is not a gap. It has been examined twice and
adversarially reviewed, and the finding is that **no circuit adds anything**: the response publishes
every leaf, so a buyer decides set-exactness alone in 2N−1 sha256 calls — cheaper than a pairing
check and strictly more informative than per-item inclusion proofs, which are provably blind to a
hidden extra leaf. The circuit is also unbuildable here on the constraint floor. That is a published
answer, not an omission.

**A distinction this report must not blur:** the `proof` envelope is not the Plonk proof.
risk-attest and portfolio-gate both serve a `proof` block — contentHash, canonical-JSON recipe,
EIP-712 attestation — with no snark in it. Eight services serve a `proof` envelope; seven serve a
Plonk proof.

---

## 3. Why the 22 denominator misleads

**12 of the 22 are observation services reading live data, and a proof of arithmetic over live data
does not give a buyer what they need.**

A Plonk proof certifies arithmetic **over the inputs it was handed**. For tape-pulse, poly-desk,
options-desk, lp-desk, calldata-x, protocol-pulse, macro-sentry, updown-pulse, loop-digest,
token-scan, wallet-audit and chart-press, the arithmetic is not what a buyer doubts. What a buyer
doubts is the **tape** — the candles, the order book, the wallet history, the DEX prints. A circuit
over a live read moves the trust from the arithmetic to the inputs and then publishes the inputs as
public signals, which is exactly where the trust already was. It is a true statement that buys
nothing.

Their route is **input attestation** — the HyperEVM verifier deployed 29 July reads the mark from
HyperCore precompiles itself — not a circuit. Two sessions reached that conclusion independently and
both adversaries agreed with it. So "7 of 22" reads as 32% coverage of something, and the something
is a set two thirds of which no circuit can serve. The denominator a wiring roadmap runs against is
**8**, and that road is 7/8 travelled with the 8th answered.

One honest amendment, from the fifth adversary and not re-measured by me: "no honest statement
exists" is stronger than what was measured. poly-fill's order-book walk has risk-attest's shape — a
commitment to the book snapshot plus every level consumed, checkable from the response with hashes
and no circuit. That is a sellable statement; it is simply not a Plonk proof. For chart-press the
adversary tried and could not construct one.

---

## 4. Every claim in this report nobody measured

An admitted gap is safe: it is written down and someone can price it. **An unmeasured claim published
as a fact is not** — a false claim in the README passed every gate here for days, because no gate can
read prose. This section is the list.

### 4.1 "3,023 constraints, 73.8% of the ceremony file" — and the refutation built on it

The lp-risk session compiled a closed-form probe circuit at 3,023 constraints and concluded that
`docs/verify-lp-risk.md`'s "what actually blocks the quadrature: the ceremony file" and
`WIRE_LP_RISK.md` §8's "the honest answer today is a bigger ceremony file, not a cleverer circuit"
are **refuted**.

3,023 is an **R1CS** count. 4,096 is the **Plonk domain size** `hez_final_12` supports. Different
units. **The only R1CS→Plonk expansion that exists in this tree was measured, from the zkey header
myself:**

```
zk/build/lpbracket_plonk.zkey  §1 protocolId = 2 (Plonk)
  §2  nVars 1743 · nPublic 13 · domainSize 2048 · nAdditions 831 · nConstraints 1776
  932 R1CS -> 1776 Plonk = 1.9056x
  3023 R1CS at that expansion -> ~5761 Plonk -> domain 8192   (hez_final_12 admits 4096)
```

**At the tree's own expansion factor the conclusion inverts.** The session knew — its hand-off report
says so in almost these words. But that caveat reached the hand-off report and **neither the artifact
nor the document**. Verified by me:

- `zk/build/probe-lpclosed-cost.json` (committed in `b764ee9`) publishes
  `"fractionOfCeiling": 0.738037109375` against `"ptauCeiling": 4096`, and its `conclusion` field
  reads *"A closed-form circuit fits inside hez_final_12 with room to spare"*.
- `Quiver/docs/WIRE_LP_RISK.md` §11.3 opens "That is now refuted" and tables "4,096 — this uses
  73.8%", with no caveat in the section.

So the commit that fixed *"a correction reached two comments and a document but not the code"*
shipped, in the same commit, a correction that reached the hand-off report and neither the document
nor the artifact. The honest claim is "3,023 R1CS, an order of magnitude under `lpexpectation`'s
36,613, and plausibly within reach" — not "fits with room to spare". Nothing has been proved for the
probe circuit: no zkey, no prover run, no verifier, and its inputs are not range-checked.

### 4.2 `FP_OPS = 9` — the only unconstrained term in the options-risk bound

Verified by me: `src/util/optionsRiskNcdfWitness.js:90` `const FP_OPS = 9;`, consumed at line 276 as
`encodingBound[k] = halfStep + FP_OPS * Number.EPSILON * Math.abs(engineExact)`. Described as "nine
COUNTED off black76's longest chain, volga, not chosen".

Attributed to the adversary, not re-measured by me: at `FP_OPS = 0` an honest leg **violates** at
100.0279%; at `9e7` — ten-million-fold — every check is still green and the headline still reads
99.9954%. So the term is load-bearing and **nothing anywhere would go red if the 9 were wrong in
either direction.** The headline "99.9965% of the derived bound, a bound landing on itself" pins only
the grid half-step coefficient.

Second, same service: the served **98.62% reachability** figure comes from a probe that persists no
artifact, so it is the one published number that cannot rot into a red check. The gate's own figure
is 98.60%; the adversary measured 84.77% on a realistic position-size box.

### 4.3 event-vol's "own derived buyer bound" is the artifact's own composition, and it is not a bound

The session's headline was "MY OWN DERIVED BUYER BOUND (independent, three terms) = 8.309517526919466
ulp". **I read that value, all three of its terms, and its absolute form straight out of
`zk/build/gateB7-5-ncdf.json`:**

```
bandUlpN 6 · evaluatorUlpN 2.11004638671875 · xGridUlpN 0.19947114020071635
envelopeUlpN 8.309517526919466 · envelopeAbsoluteN 7.55746216502254e-12
```

Nothing was derived; the arithmetic was re-added. And the inherited middle term is a **sampled
maximum over 400,001 of ~7.77e12 grid points**, then relied on as an upper bound because the service
uses a narrower slice. Restricting a domain cannot turn a sampled maximum into a supremum — and the
adversary measured the slice maximum **higher** than the whole-branch figure it was borrowed from
(2.536 vs 2.110 ulp, at a point inside event-vol's own domain), which pushes the buyer envelope to
≥ 8.7358 ulp. The error direction flatters the buyer.

Nothing served is wrong: the shipped 12.199-ulp guard still dominates and the display ceiling is
still the tighter of the two. The defect is in the **published bound** and in gateB7-5's artifact,
whose assertion string reads "the worst honest residual **anywhere on the domain** is inside the band"
over 5.1e-8 of the domain.

### 4.4 risk-attest: nobody ever tried to deploy the alternative

Attributed to the adversary and not re-measured by me. Every pairing-check gas figure in §3 of the
risk-attest report — 411,267 at N=64, 776,741 and 768,042 at N=244 — is the price of a contract that
**cannot be deployed**: the snarkjs Plonk verifier grows ~212 bytes of runtime code per public
signal, 91 signals deploys at 24,516 bytes and 92 fails at 24,728 (EIP-170's 24,576), and 490 signals
is 113,746 bytes. Set-exactness at 2N+2 signals is therefore deployable only to **N=44** against a
service that accepts N=244. The elaborate error apparatus around those figures — two estimators, the
3-SE band on the fitted mean, "within 10% at the ceiling" — is precision applied to a phantom.

Also unmeasured there, and now measured by the adversary: the reason given for the instrument's
64-signal span ("as wide as the ptau on hand allows") was never true — a 490-signal circuit compiles
and completes Plonk setup on the 2^12 ptau. The 2^25 requirement belongs to the sha256 Merkle circuit
and was transferred to a different object. And "10.6% to 12.7% across four runs", the whole basis of
"a tenfold improvement in reproducibility", is in **no artifact** — the same class as the 46.92%
outlier the session correctly withdrew.

### 4.5 The figure that has now rotted twice, in the same tree

`Quiver/docs/wire-classify-two.md:132` and `hackathon/WIRE_CLASSIFY_TWO.md:132`, both copies,
verified by me: *"twelve entries of 31 handlers (22 HTTP + 9 MCP), and the other 19 build no
proof."* **I measure 14 entries and 17 non-emitting.** The figure moved 8/4 → 12/6 → 14/7; the
document has been corrected once and is stale again.

`gateG/8` was added to stop exactly this and cannot see it: it compares the document against
preflight's pinned literal, and its only arithmetic check is `31 − 12 = 19`, a tautology over two
numbers that both come from the doc/pin pair. When a sibling wires a service, the pin moves and the
gate compares two stale numbers to each other. Per the adversary, `gateG/8` also asserts rather than
skips when the `hackathon/` copy is absent, so it goes red in any fresh clone — the report copy it
requires is outside the repo and untracked.

### 4.6 Checks that cannot fail, published as checks

Each verified where marked; the rest attributed.

- `zk/scripts/verify-attest-report.mjs:130` — `implied('no residual exceeds 4x the fit noise',
  F.worstAbsResidual < 4 * F.residualSd)`. **Verified present by me.** Since SSR = dof·s² by
  construction, max|resid|/s ≤ √dof = 2.828 at n=10; the threshold is unreachable until n ≥ 18. It is
  one of the 72 published checks, it also gates the probe's own `passed` flag, and it **replaced** a
  falsifiable claim that a re-run had refuted — in a section whose own text says the tempting repair
  was to widen the tolerance and that the estimator was replaced instead. It was replaced *and* the
  tolerance was widened past the point of failure.
- `gates/gateLP-bracket-snark.mjs:370` — `assert.ok(worstUsed <= 1)` over rows that passed the
  refusal that refuses precisely when the ratio exceeds 1. Tautology over the proved set. Benign, the
  load-bearing assertion beside it can fail.
- `zk/scripts/revert-optionsrisk-greeks.mjs:164-167` — the inflation mutation computes
  `inflate = (halfGamma/envelope)*1.01` and then asserts `envelope*inflate > halfGamma`. The envelope
  cancels: it is `1.01 > 1`, red for every envelope from 1e-300 to 1e300. So "7 mutations, every
  broken thing turned a named check red" is 6 real and 1 tautology.
- `gateG/8`'s `claimedRest`, above.
- Three of options-risk's enumerated "guards" never fired over ~300,000 hostile requests and cannot,
  because they restate facts about N and φ that the witness already forces.

### 4.7 Gas

No gas figure in this tree is reproducible to better than its own spread, and several disagree with
their own artifacts. `docs/verify-lp-risk.md` says 278,051 for the bracket; its artifact says
277,329; earlier passes said 277,953 and 277,121. `WIRE_EVENT_VOL.md` publishes 273,920 and 275,584;
its artifact holds 274,752 — neither published figure is in the repo. Plonk verify gas has a measured
1.22% spread (~3,500 gas), so **every marginal-gas claim smaller than that is noise.** I quote no gas
figure in this document and computed none.

### 4.8 Everything in §1 that is not in the provenance list

Every figure in the table's *What was done* and *Adversary* cells is attributed and was not
re-measured here. I did not re-run gateLP-bracket-snark, gateB7-6, gateB7-7, gateAT, gateG, gateIF,
or any of the five revert harnesses. Their reported results are claims by the sessions and adversaries
that ran them, and two of the adversaries demonstrated that reading a gate's report is not the same
as running it.

---

## 5. Decisions that are Tristan's, ranked

**No deploy is recommended anywhere in this list.** Deploys are frozen.

1. **The served `doesNotProve` sentence for lp-risk is false in bytes a paying caller receives.**
   `src/util/lpBracket.js:469` says monotonicity is established by sweep with "zero non-decreasing
   steps"; the gate that measures it asserts `flat > 0` and its own comment calls the reading an
   overclaim. Strictness is exactly what buys uniqueness of a straddled root, which is the whole
   reason the sentence is there — and the gate holds the correct, stronger argument, published nowhere
   a buyer sees. Two echoes (`docs/verify-lp-risk.md:147`, `zk/circuits/lpbracket.circom:45-46`) say
   the same thing. This is a caller-visible text change on a proof-emitting service; it needs deciding,
   not defaulting, and whatever replaces it should be tied to the gate's measured counts so it cannot
   drift again.
2. **Retract or caveat "fits inside `hez_final_12` with room to spare."** In
   `zk/build/probe-lpclosed-cost.json`'s `conclusion` field and `WIRE_LP_RISK.md` §11.3. My own
   measurement of the tree's only R1CS→Plonk expansion says domain **8,192**, not 4,096. Committed
   artifact and committed doc both assert the uncaveated form.
3. **`src/engine/` is frozen, and lp-risk's headline percentage is one engine line from provable.**
   `expectedDivergence.expectedIlPct` — the number the service leads with — enters the circuit as two
   uncertified public inputs, because the engine serves a 401-point quadrature where the closed form
   `exp(-v/8) - 1` is exact. Substituting `Math.expm1(-v/8)` would remove the truncation floor and the
   two seed exponentials. The session correctly refused to wire a circuit that certifies a different
   number than the one served. Unfreezing the engine moves the published `codeHash`
   `q1-e1fa99d08887d6cc`, which is quoted in docs, the paper and on-chain material. **Only you can
   make that call**, and it is the largest single coverage gain available.
4. **`docs/verify-lp-risk.md` is the buyer-facing document and neither lp-risk commit touched it.**
   Verified by me: it still says the ceremony file is what blocks the quadrature (lines 24, 310, 403)
   and that the circuit "fits the ceremony file this repo already carries" (line 165). It also labels
   96.3% as "my derived bound" when that figure is the circuit's own root tolerance and the derived
   encoding bound's worst case is a different number. Two bounds, one label, in the doc a buyer reads.
5. **Decide whether `FP_OPS = 9` gets a check that can fail.** It is the load-bearing term in a
   bound published on a live service, and no gate, sweep or revert constrains it in either direction.
6. **event-vol's published buyer envelope should be published as a lower bound or re-derived.**
   It is a sampled maximum called a derivation, it is understated, and the understatement is in the
   direction that flatters the buyer. Nothing served is wrong; the *published bound* is.
7. **risk-attest §3's gas leg.** The finding — no circuit adds anything — survives on the two legs
   that carry it (no privacy to buy, unbuildable constraint floor). The gas leg is a strawman: a set
   can be named by a digest in 4 public signals rather than enumerated in 2N+2. Two clauses of
   `PROVES` are false as written, and revert #5 scripts the strawman as a defect that must go red, so
   pricing it correctly would now register as a regression. Fixing this makes the document *shorter*
   and the finding *stronger*.
8. **Duplicate wire docs, measured by me and mis-diagnosed as a case-sensitivity problem.**
   `Quiver/docs/` carries both `WIRE_LP_RISK.md` (41,695 B, contains this session's work) and
   `wire-lp-risk.md` (28,357 B, contains none of it) — they differ by more than case, so **both exist
   on every platform including this one**, and a reader who follows the `wire-*.md` mirror convention
   gets the 13.3 KB-shorter one. `WIRE_RISK_ATTEST.md` sits in `docs/` under the uppercase convention
   with no lowercase mirror at all. Pick one convention and delete the other copy.
9. **Stale figures with no gate over them.** `wire-classify-two.md`'s 12/6 (now 14/7, §4.5), and the
   document-corpus count, which reads 252 in one report, 255 in two others, and **260** when I ran
   `docs-consistency` — a number that moves whenever anyone adds a document and is quoted as a fact in
   three places.
10. **Single-writer discipline for the `*-revert` harnesses.** Five of them back up, rewrite and
    restore shared source from a snapshot taken at script start. Five sessions share this tree. One
    session's SIGTERM left an injected defect in a gate and the next run made it permanent by backing
    up the already-patched file; recovery worked only because the mirror held a pristine copy. Two
    sessions declined to re-run a revert for exactly this reason, which means the harness is now
    limiting what can be verified.
11. **Whether portfolio-gate gets wired.** The circuit exists and its residual tolerance is a genuine
    improvement on the liquidation half-cent. Two things to price first: `refHat` enters only a range
    check, so a prover reorders the book by choosing marks and "no other leg is nearer" is manipulable
    without omitting anything; and the bound that governs the wiring is already exceeded by honest
    cases — the `refusalSweep` field in `gateB10-portfolio-perleg.json` reports honest legs refused at
    every leg count, all for `divergedPct`, because the guard is set to exactly half a display unit so
    the theoretical honest worst case *equals* the bound. That is zero headroom by construction.
    (Attributed to the fifth adversary; not re-measured by me.)

---

## 6. Does anything here need a deploy to reach a caller?

**Yes — and more than the tree admits. Measured by me, live, with a like-for-like local control for
every call.**

I called the deployed container's free MCP surface with `snark: true` and identical bodies locally,
and compared whether a top-level `snark` block came back. (My first attempt looked for
`proof.snark`, found nothing anywhere, and would have "proved" that no service serves a proof —
the local control is what caught that. The block is top-level.)

| Service | Deployed container | Local tree, same body |
|---|---|---|
| perp-gate | `snark` **building** | building |
| size-gate | `snark` **building** | building |
| treasury-risk | `snark` **building** | building |
| exec-verify | **no `snark` key** (`ok: true`) | building |
| event-vol | **no `snark` key** | building |
| lp-risk | **no `snark` key** | building |
| options-risk | **no `snark` key** (`ok: true`) | building |

> **The deployed container serves a Plonk proof on 3 of the 7 wired services. Four — exec-verify,
> event-vol, lp-risk, options-risk — are wired, gated, reverted, documented, and reach no caller.**

This corrects the standing brief, which lists exec-verify among the services that "already serve
proofs". It is wired in the repo and absent from the deployment.

The changelog agrees with the behaviour, which is the independent confirmation: the live
`/changelog` is 37,228 bytes shorter than `assets/changelog.md` and its newest entry is dated
**29 July**. Nine `##` entries exist only in the repo, all dated 30 July, and four of them are
exactly the four announcements above — `exec-verify now serves a proof`, `event-vol can now hand you
a succinct proof`, `lp-risk can be asked for a proof`, `options-risk … certifies all six greeks at
once`. Preflight's own check states the same fact in its own words: *"the repo changelog is ahead of
live, as it should be right before a deploy."*

So: every proof wired in these five sessions is invisible today. Also invisible: the proof-store
eviction fix, which means the live container still has the failure mode where a repeat request can
write `unavailable: prover busy` over a proof that is in the prover. That is a live defect on a
deployed service, not just an undelivered feature.

The decision of when to deploy is not this document's, and none of the above is a recommendation to
deploy. It is a statement of what the frozen state costs, so the freeze is a choice made with the
number in hand.

---

## 7. Green, measured by me, at the moment of writing

```
node tools/docs-consistency.mjs   CONSISTENT — 260 before this file, 263 after
                                  (I predicted 262; it came back 263 — decision 9, demonstrated)
node gates/preflight.mjs          PREFLIGHT PASSED — safe to deploy
npm test                          386 tests · 381 pass · 0 fail · 5 skipped
diff -rq src/engine ../../Quiver/src/engine    byte-identical
codeHash (src/engine/proof.js)    q1-e1fa99d08887d6cc   — unmoved
live GET /build                   q1-e1fa99d08887d6cc · fileCount 37   — the deployed engine agrees
gates/preflight.mjs:387 pin       14 entries / 7 services — matches what was measured
```

`src/engine/` was not touched by this document. Two closed items, both verified by me and both
previously reported as open: `src/util/lpBoundedness.js` is now in HEAD (blob `c715acb7`), so a clone
loads; and the stale duplicate `src/util/mcp.js` was removed from HEAD in `ddcc434`.

## 8. What I did not verify

1. **No gate was re-run.** Not gateLP-bracket-snark, gateB7-6, gateB7-7, gateAT, gateG, gateIF, nor
   any of the five revert harnesses. Every gate result in §1 is the claim of the session or adversary
   that ran it. Given that this project's standing discipline note says reading an agent's report
   instead of re-running it is one of the nine ways a false claim shipped, treat §1 accordingly.
2. **No EVM arm, no gas measurement, no proving run.** I generated no proof and deployed no verifier.
   The only zk artifact I read is the `lpbracket_plonk.zkey` header, parsed by me.
3. **The adversaries' own measurements are unreplicated by me**, except the eight claims I name as
   verified. In particular I did not reproduce the 2.536-ulp evaluator maximum, the EIP-170
   bisection, the `FP_OPS` insensitivity sweep, the realistic-box reachability, or the `refusalSweep`
   reading.
4. **The live probe is one sample per service.** Seven calls, each with a local control on the same
   body. A cold container, a quota refusal, or a per-service outage would look the same as "not
   wired" — the changelog's nine missing entries are what turn a single sample into a conclusion, and
   the two agree.
5. **Nothing was deployed.** No `railway up`. The paper was not touched.
6. **One figure was published without being measured, and it was wrong within four minutes.** §7 first read
   "262 once this file's two copies land" — arithmetic, not a measurement. The re-run returned **263**:
   a sibling landed a document while I was writing. The figure is corrected above, the mistake is left
   here, and it is the cheapest possible demonstration of decision 9 — a count nobody can hold still
   is quoted as a fact in four documents.
7. **This document is prose and no gate reads it.** That is the exact condition under which the
   figure in §4.5 rotted twice. Every figure here is either in my provenance list or attributed by
   name; none of it is protected by a check that can fail.
