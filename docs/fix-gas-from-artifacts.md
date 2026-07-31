# Gas figures: what was actually wrong, and the rule that now holds them

30 July 2026. Every number below was computed on this machine during this session, by a script named
beside it. Nothing is deployed, `src/engine/` is untouched, the build hash is `q1-e1fa99d08887d6cc`, and
`npm test` is 386 with 0 failures.

---

## 0. Verdict first

The reported defect **reproduced, and the brief's diagnosis of it was wrong in a way that matters.**

| claim under test | verdict |
|---|---|
| gas figures in the four `VERIFY_*.md` docs disagree with the artifacts | **CONFIRMED** — and there are more than seven |
| the count is seven | **UNDERCOUNTS** — 24 published figures, 19 distinct quantities |
| a published marginal took its two terms from runs four seconds apart | **CONFIRMED** to the millisecond |
| that marginal has taken four values | **CONFIRMED** — 2,388 / 3,318 / 6,340 / 8,420 |
| a marginal below ~3,500 gas is inside the noise | **CONFIRMED, and the threshold is higher** — 7,904 |
| the `execadverse` marginal is inside the noise | **CONFIRMED as published**, but the quantity itself is real |
| the Plonk spread is 1.22% | **REFUTED as an upper bound** — measured 1.24%, 1.59% and 1.73% today |
| the docs disagree with "the artifact that produced it" | **REFUTED as stated** — 9 of 11 match an artifact *exactly* |
| `docs-consistency.mjs` never looks at a gas figure | **CONFIRMED** — 225 documents, zero gas comparisons |

The last two are the substance of this report. **The documents were not sloppy transcription.** Nine of
the eleven checkable original figures match a real artifact to the digit — the copy in
`Quiver/zk/build`, not the copy in `zk/build`. There are two artifact sets in this working tree, they
disagree, and the gates that write the first one were re-run **five times during this session** by
siblings. "The artifact that produced it" is not a well-defined object.

---

## 1. Reproducing the disagreement — counted, not capped

Compared every gas figure in the four documents against `zk/build/*.json` as it stood at the start of
the session. **24 published figures disagreed, across 19 distinct quantities.** The brief's seven counted
one representative per gate; it missed the six per-leg table rows, the six `gas/leg` values derived from
them, and the repeat occurrences.

| document | figures | distinct | what they were |
|---|---|---|---|
| `VERIFY_EXEC_VERIFY.md` | 7 | 3 | 276,892 (×2), 279,280 (×3), the +2,388 marginal (×2) |
| `VERIFY_LP_RISK.md` | 2 | 1 | 277,953 (×2) |
| `VERIFY_OPTIONS_RISK.md` | 1 | 1 | 272,672 |
| `VERIFY_PORTFOLIO_GATE.md` | 14 | 14 | 6 per-leg gas cells, 6 `gas/leg` cells, 291,708, 2,944,135 |
| **total** | **24** | **19** | |

Two counting traps worth recording, both of which a naive pass falls into:

- **Six of the fourteen never appear next to the word "gas".** The portfolio table puts `gas` in the
  header and nothing on the rows, so a pattern keyed on `N gas` sees none of them. This is the same
  shape as the regex that matched "non-linear constraints" while looking for "linear constraints".
- **The `gas/leg` column is arithmetically correct on every row.** 815,487 / 3 = 271,829 exactly. Each
  cell is a right answer to a division whose numerator was stale — a derived figure inherits staleness
  silently, and checking the division would have found nothing.

### The mechanism, to the millisecond

`gateB5-5-execadverse-evm.json` was written at **2026-07-30T00:34:48.160Z** and
`gateB5-2-constantproduct-evm.json` at **2026-07-30T00:34:52.291Z** — four seconds later. B5-5 computes
its marginal by reading B5-2's artifact off disk, so it stored `benchmarkAcceptGas: 275,644`, which is not
what B5-2 then wrote. Confirmed exactly as reported.

---

## 2. The premise is wrong: there are two artifact sets, and the docs match the other one

This is the finding that changes what the fix should be. The published mirror ships its own
`Quiver/zk/build`, with 56 JSON artifacts, and its copies are hours older than `zk/build`.

| quantity | the doc published | `Quiver/zk/build` says | match? |
|---|---|---|---|
| `constantproduct` accept | 276,892 | **276,892** at 22:51:00.392Z | **exact** |
| `execadverse` accept | 279,280 | **279,280** at 23:21:43.661Z | **exact** |
| `lpbracket` accept | 277,953 | **277,953** at 23:25:35.036Z | **exact** |
| per-leg, 1 leg | 276,448 | **276,448** at 23:14:40.337Z | **exact** |
| per-leg, 3 legs | 815,487 | **815,487** | **exact** |
| per-leg, 4 legs | 1,086,248 | **1,086,248** | **exact** |
| per-leg, 6 legs | 1,625,200 | **1,625,200** | **exact** |
| per-leg, 8 legs | 2,161,535 | **2,161,535** | **exact** |
| per-leg, 11 legs | 2,968,446 | **2,968,446** | **exact** |
| `ncdf` accept | 272,672 | 273,504 at 23:33:30.292Z | no |
| portfolio wide 3-leg | 291,708 | 293,262 at 00:09:34.159Z | no |

**Nine of eleven, to the digit.** The authors read an artifact and wrote down what it said. The gates
were then re-run against `zk/build` and the mirror's copies were not refreshed, so the documents became
stale without anyone editing them. Describing that as "the figure disagrees with the artifact that
produced it" points the reader at a transcription error that did not happen, and hides the two problems
that did:

1. **Two artifact sets disagree**, so a document can be simultaneously right and wrong depending on
   which tree it is read in. Both sets are in this working tree and both are shipped.
2. **Two figures match no copy in either tree.** `272,672` for `ncdf` and `291,708` for the wide
   3-leg verifier. The second is the serious one, because the sentence carrying it claimed its own
   provenance: *"read out of `gateB8-2-portfolio-evm.json`, not written down"*. That file has never held
   291,708 in either tree. A false claim of provenance is worse than a stale number, because it tells the
   reader not to check.

---

## 3. The artifacts moved five times while this was being written

Not a hypothetical. `gateB6-portfolio-routes.json`, observed live:

| `at` | `routeB.gas` (11 legs) |
|---|---|
| earlier state (session start) | 2,941,749 |
| 2026-07-30T01:33:20.393Z | 2,939,559 |
| 2026-07-30T01:40:31.079Z | 2,948,931 |
| 2026-07-30T01:52:41.910Z | 2,947,291 |

`gateB10-portfolio-perleg.json` and `gate0-plonk.json` also re-ran. Nothing changed in any circuit; the
constraint counts, domains and deployed byte counts are identical throughout. **A gas figure in a document
is a sample of a random variable that a sibling re-rolls every few minutes**, and that single fact
determines what a correct fix can look like. Writing today's sample down is not a fix, it is the next
iteration of the same defect.

Corollary, and it is the reason §5 has a tolerance form: `gate0-plonk.json` reproduced
`verifyGasHonest: 273901` *exactly* across a re-run, which is the tell that that gate reuses a stored
proof rather than proving afresh. Determinism there is an artifact of the harness, not of the EVM.

---

## 4. The measurement: how wide is the noise, really?

Two probes, both run today, both writing their own artifact.

**`zk/scripts/probe-plonk-gas-variance.mjs`** (`npm run probe:gas-variance` in `zk/`) — kelly, 5 public
signals, 12 proofs of an identical statement:

```
spread 4576 gas = 1.73% of the mean
first call costs 7500 gas more than every later one  (EIP-2929, 3 precompiles x 2500)
```

**`zk/scripts/probe-execadverse-marginal.mjs`** (new, `npm run probe:exec-marginal`) — 25 proofs of each
of two circuits, **a fresh `EVM.create()` per sample** so every measurement pays the cold-access price a
standalone transaction pays:

| | `constantproduct` | `execadverse` |
|---|---|---|
| public signals | 10 | 15 |
| min · median · max | 274,604 · 276,476 · 278,042 | 278,240 · 280,210 · 282,706 |
| mean · sd | 276,361 · 989 | 280,177 · 1,045 |
| **spread across identical statements** | **3,438 gas = 1.24%** | **4,466 gas = 1.59%** |

So the figure quoted as authoritative in `gas-facts.mjs`, in `VERIFY_OPTIONS_RISK.md` and in the brief —
**1.26%, 3,328 gas** — is the *bottom* of the measured range, not the range. Today's three independent
measurements give **1.24%, 1.59% and 1.73%; 3,438, 4,466 and 4,576 gas.** The brief's "1.22% / ~3,500
gas" understates it. Anywhere a document needs one number for this, **~4,500 gas** is the honest one, and
`gas-facts.mjs`'s `GAS_VARIANCE_NOTE` should be widened (§8).

### The marginal, asked two ways

| | value |
|---|---|
| **one-shot subtraction** — one proof each, which is what was published | anywhere in **198 .. 8,102 gas** |
| that window's width | **7,904 gas — 2.1× the quantity being measured** |
| **difference of means**, 25 proofs each | **+3,815 gas**, standard error 288 |
| 95% interval | **3,251 .. 4,379 gas** |
| per extra public signal | **763 gas** across 5 signals |

**Rule 3 of the brief is confirmed, and needs one refinement to be true.** The published `+2,388` *is*
inside the noise, and so are 3,318 and 6,340; the one-shot window observed in a 21-proof run was
822..8,934, which contains 8,420 as well. **All four values that quantity has taken are draws from the
same window.** That is the whole story: they were never four different measurements of four different
things, they were four samples of one subtraction that cannot be done this way.

The refinement: **the underlying quantity is real.** +3,815 ± 288 clears its own interval comfortably, and
763 gas per public signal is consistent with the ~822 gas/signal that `gas-facts.mjs` derives from a
completely different direction. So the correct statement is not "the marginal is noise" — it is:

> The marginal is about 3,800 gas. It cannot be obtained by subtracting one gas measurement from another,
> because the window such a subtraction draws from is twice as wide as the answer. State it as a mean over
> many proofs with an interval, or do not state it.

That sentence is now in `VERIFY_EXEC_VERIFY.md`, next to the table that used to publish `+2,388`.

---

## 5. Where two artifacts disagree, both are quoted

The eleven-leg per-leg route is measured by three gates, and they record three numbers. The earlier
version of `VERIFY_PORTFOLIO_GATE.md` "corrected" a recalled 2,941,443 to *"the recorded 2,944,135"* — and
that was not what the file held either. **There is no single recorded value to correct to.**

| artifact | field | value | written |
|---|---|---|---|
| `gateB10-portfolio-perleg.json` | `perLeg.gas` | 2,974,674 | 2026-07-30T01:41:22.761Z |
| `gateB6-portfolio-routes.json` | `routeB.gas` | 2,948,931 | 2026-07-30T01:40:31.079Z |
| `gateB8-2-portfolio-evm.json` | `comparison.perLegRouteElevenLegsGas` | 2,947,769 | 2026-07-29T23:41:53.111Z |

Largest minus smallest is 26,905, or 0.91% — *inside* the 1.24%–1.59% per-proof spread measured above,
multiplied across eleven proofs. **The three artifacts agree to within their own measurement noise.**

The wide 3-leg figure, by contrast, now reads 292,124 in all three
(`gateB8-2#acceptGas`, `gateB6#routeA.gas`, `gateB10#wide3LegVerifyGas`). Earlier in the day gateB10 held
292,014 against the other two, and that 110-gas disagreement resolved itself on a re-run — which is the
tell that it was never a fact about the verifier.

**What is stable is the ratio, and the ratio is all the argument ever needed.** Eleven legs against three
legs in one proof: 10.17, 10.18, 10.18 across the three re-runs. A ratio of two noisy figures is far
better behaved than either, because the noise is a per-proof cost that scales with the number of proofs.
The document now leads with the ratio and labels the absolute column as one sample.

---

## 6. The rule: `tools/docs-consistency.mjs` rule 9

`docs-consistency.mjs` passed over 225 documents without ever comparing a gas figure to anything — the
same shape as the README that claimed every gate passed. Rule 9 closes it, in two halves, because either
half alone is evadable.

**(a) Every citation is checked, in every document.** A figure carries its source inline:

```
281,984 gas <!--gas:gateB5-5-execadverse-evm#acceptGas~2%-->
573 gas <!--gas:gateB5-2-constantproduct-evm#rejectGas-->
```

The artifact is read from `zk/build`, the dotted field resolved, and the last number before the comment on
that line compared. A citation to a missing artifact, a missing field, or a different value is red.

**Two forms, because two kinds of quantity live in these artifacts:**

| form | for | why |
|---|---|---|
| `#field` | `rejectGas`, deployed bytes, a probe's recorded statistics | deterministic — reproduces to the digit |
| `#field~2%` | a single verify-gas sample | **not** deterministic — 1.24%–1.73% spread, re-rolled hourly |

A tolerance above 5% is itself a finding: 5% of a verify-gas figure is ~14,000 gas, three times the
measured spread, and past that the citation cannot fail. **A derived statistic — any marginal — is held
exactly**, with no tolerance, because the entire defect was that its two terms came from different runs.

**(b) In a gate report — `VERIFY_*.md` and mirrored `verify-*.md` — an uncited gas figure is itself the
finding.** Without this, (a) is a rule you satisfy by deleting the annotation. It reads both prose
(`**291,708** gas`, with `\*{0,2}` on both sides — the emphasis trap this file already records having
been caught by once) and table columns headed `gas`, which is where six of the fourteen wrong figures
lived with the word "gas" nowhere on their rows. Floor is 500 gas, not 200,000, so the marginal and
`rejectGas` are in scope; EIP-2929 protocol constants (100 / 2,500 / 2,600 / 7,500 / 21,000) are exempt
because they are arithmetic about Ethereum that no artifact measures or could.

### What the rule deliberately does NOT do, and this is the weak point

**A stale verify-gas sample that is within 2% of the current artifact is not caught by value, and cannot
be.** 276,892 against 273,564 is 1.2% — *inside* the noise. It is indistinguishable from a fresh sample,
because that is exactly what it is. So the rule cannot catch the original seven by comparing numbers; what
catches them is that **they carried no citation at all**, plus the discipline of publishing an interval
instead of six significant figures. Anyone reading rule 9 as "the gas figures are now verified to the
digit" has misread it. What is now true is narrower and honest:

> Every gas figure in a gate report names the artifact it came from; that artifact contains a figure of
> the same quantity within the measured noise; and every derived statistic matches exactly.

Three further limits, stated rather than left to be discovered:

- **(b) covers 4 documents of the 39** that name a gate artifact and publish a verify-scale gas figure —
  111 figures in total, including `assets/whitepaper.*`, which is frozen. Widening it is the right end
  state and is not done here.
- **Derived arithmetic escapes.** The `gas/leg` column, and "largest minus smallest is 26,905", are
  computed from cited figures but are not themselves cited. The rule sees `N gas` adjacency and table
  columns headed `gas`, nothing else.
- **The two artifact sets are still divergent.** this work did not refresh `Quiver/zk/build` from `zk/build`,
  because measured against the values a sibling's docs cite it would not have fixed them and gateB6 had
  re-run twice more by the time the check finished. §9 carries this as open.

---

## 7. Proof it can fail

`npm run docs:revert` (`gates/docs-coverage-revert.mjs`) puts the published text back and requires the
tool to be green on it in the pre-29-July walk, red **by name** in the current walk, and green again once
restored. Rule 9 is switched off entirely under `DOCS_CONSISTENCY_PRE_WIDENING=1`, because the walk that
shipped these figures had no gas rule of any kind and modelling it otherwise would demonstrate a blind
spot that never existed.

Four scenarios were added, deliberately four because rule 9 has four independent ways to be right:

```
CAUGHT  GAS-UNCITED-PROSE  VERIFY_EXEC_VERIFY.md published three gas figures with no artifact behind any
   caught: L145: publishes 276,892 gas without citing the artifact that measured it
   caught: L146: publishes 279,280 gas without citing the artifact that measured it
   caught: L147: publishes 2,388 gas without citing the artifact that measured it
CAUGHT  GAS-UNCITED-TABLE  six per-leg figures in a column where "gas" appears only in the header
   caught: L157: table column "gas" publishes 276,448 without citing the artifact that measured it
CAUGHT  GAS-WRONG-ARTIFACT the benchmark figure attributed to another verifier
   caught: L220: publishes 273,564 citing gateB8-2-portfolio-evm#acceptGas within ~2%,
                 but that field is 292,124 as measured at 2026-07-29T23:41:53.111Z — 6.35% away
CAUGHT  GAS-MARGINAL-3318  the marginal restored to 3,318, one of the four values it has taken
   caught: L182: publishes 3,318 citing probe-execadverse-marginal#marginal.meanMinusMean,
                 which is 3,815 as measured at 2026-07-30T01:35:09.766Z

8/8 defects were caught BY NAME by the widened walk, and missed by the walk that shipped them.
```

**8/8 in both trees** — from `hackathon/veritape` and from `Quiver`, which needed a `files` list on each
scenario because the gate reports sit at `hackathon/VERIFY_*.md` in one tree and `Quiver/docs/verify-*.md`
in the other. Naming one path made every gas scenario ERROR in the mirror, which reports a broken revert
rather than a broken checker.

Two things the revert caught about itself, both worth recording because both are the "verifier that cannot
fail" disease in miniature:

- `GAS-WRONG-ARTIFACT` first pointed the benchmark figure at the sibling `execadverse` verifier. That is
  **2.99% out in this tree and 2.05% out in the mirror** — red in both, but by 0.05 percentage points in
  one, and it would flip to MISS on the next gate re-run. Re-aimed at the 3-leg portfolio verifier: 6.35%
  and 6.72%, unambiguous in both.
- Rule 9 accused `KNOWN_DEFECTS.md` for containing the literal string `<!--gas:ARTIFACT#FIELD-->` — the
  syntax, quoted from the rule's own error message by a sibling documenting it. The checker accusing its
  own documentation, which is precisely what rule 8 records happening with `TEN-TABLES`. Guarded on the
  exact literal only.

And one that is worse than either, found by running the two trees' reverts concurrently: **the revert
script is not safe to run twice at once.** It mutates a real document and then asks the checker whether
the tree is consistent, and the checker's corpus spans *both* trees. A run started from `Quiver` sees the
file a run started from `hackathon/veritape` has mid-flight; one of them aborts on a baseline that is red
through no fault of its own, and the aborting one exits through a path that has already written the defect
and not yet restored it. That left `VERIFY_EXEC_VERIFY.md` sitting on disk publishing a marginal of
**3,318** — one of the exact wrong values this whole exercise is about, reintroduced by the tool built to
catch it, and caught only because the next baseline run refused to start. The hazard is now documented at
the top of `docs-coverage-revert.mjs`; run them sequentially.

---

## 8. What changed

| file | change |
|---|---|
| `hackathon/VERIFY_EXEC_VERIFY.md` | 7 figures corrected + cited; the `+2,388` delta cell **removed** and replaced with the measured interval and the reason a subtraction cannot produce it |
| `hackathon/VERIFY_LP_RISK.md` | 2 figures corrected + cited; a paragraph on why the byte count is exact and the gas figure is not |
| `hackathon/VERIFY_OPTIONS_RISK.md` | 1 figure corrected + cited; the stale "1.26% spread" widened to the measured range |
| `hackathon/VERIFY_PORTFOLIO_GATE.md` | 14 figures corrected + cited; the three-way artifact disagreement quoted with timestamps; the argument re-led on the ratio |
| `zk/scripts/probe-execadverse-marginal.mjs` | **new** — 25 proofs per circuit, fresh EVM per sample, writes `probe-execadverse-marginal.json` |
| `zk/package.json` | `probe:exec-marginal`, `probe:gas-variance` aliases |
| `tools/docs-consistency.mjs` | **rule 9**, both halves, both citation forms |
| `gates/docs-coverage-revert.mjs` | 4 gas scenarios, `files` for per-tree paths |
| `Quiver/docs/`, `Quiver/tools/`, `Quiver/gates/`, `Quiver/zk/` | all of the above mirrored |

`src/engine/` untouched. `assets/whitepaper*` untouched. Nothing deployed.

```
node tools/docs-consistency.mjs   CONSISTENT — 229 documents   (from hackathon/veritape)
node tools/docs-consistency.mjs   CONSISTENT —  85 documents   (from Quiver)
node gates/docs-coverage-revert.mjs   8/8 PASSED   (both trees)
npm test                          386 tests · 0 fail · 5 skipped
```

---

## 9. Still open

1. **`gas-facts.mjs`'s own comment is now understated.** Its header says "a 3,328-gas spread, 1.26%" and
   `GAS_VARIANCE_NOTE` says the same. Measured today: 1.24%, 1.59%, 1.73%. The module is otherwise exactly
   right and is the reason this was fixable; its number wants widening to ~4,500 gas. Not changed here
   because `gas-facts.mjs` is imported by gates this work did not run.
2. **Two artifact sets still disagree.** `Quiver/zk/build` is hours behind `zk/build` for every gate cited
   in this report. Refreshing it is a data change with a sibling's name on it and it does not converge
   while gateB6 re-runs every ten minutes. The real fix is one artifact set, or a generator that rewrites
   cited cells from the artifacts instead of a human typing them.
3. **Rule 9(b) covers 4 documents of 39.** The other 35 publish 111 verify-scale gas figures with no
   citation, `assets/whitepaper.*` among them.
4. **`gate0-plonk.json` appears not to re-prove.** It reproduced `verifyGasHonest` exactly across a
   re-run while every other gate moved. If it is reusing a stored proof, its gas figure is a property of
   that stored proof and not of the circuit, and the gate should say so.
5. **The `lpRisk.js` boundedness defect** named in `VERIFY_LP_RISK.md` §6 is untouched and remains
   Tristan's call.
