# Four stale numbers in the paper, and why the checker that reads 128 documents was green

**Date:** 29 July 2026 · **Build:** `q1-e1fa99d08887d6cc` (unchanged; `src/engine/` untouched)
**Suite:** `npm test` → `tests 386` = `pass 381` + `skipped 5`, `fail 0`

---

## 1. Ground truth, measured first

The five skipped tests are the live-archive LP integration tests, skipped unless an archive RPC is
configured. They are **inside** the 386, not additional to it. This is not taken on anyone's word:

```
ℹ tests 386
ℹ pass 381
ℹ fail 0
ℹ skipped 5
```

`381 + 5 = 386`. Every correction below follows from that one arithmetic fact.

---

## 2. The four sites, before and after

All four were reproduced in the generated `.part*.md` files and traced back to their source lines in
`assets/whitepaper.html`, which is what actually gets edited. None had moved from the line numbers the
sweep reported.

### 2.1 `whitepaper.part1.md:195` — §1 contributions (`whitepaper.html:276`)

> **Before** — A verification methodology: 386 automated tests of model-free invariants that run on every build, *a further five* live-archive integration tests behind an RPC flag, a ground-truthing protocol against live venues, …

> **After** — A verification methodology: 386 automated tests of model-free invariants, *of which 381 run on every build and five are live-archive integration tests skipped unless an archive RPC is configured*, a ground-truthing protocol against live venues, …

"A further five" asserts a suite of 391. The integer 386 was correct, which is exactly why a
total-only checker walked past it.

### 2.2 `whitepaper.part1.md:303` — §3.6 Proven by test (`whitepaper.html:373`)

> **Before** — … it currently holds 386 tests that run on every build, *with a further five* live-archive integration tests that are SKIPPED unless an archive RPC is configured. *None of the 333 fails*; the five are not run in the default environment, and calling that "all pass" — as this sentence did — counted a test that never executed as a passing one.

> **After** — … it currently holds 386 tests, *of which 381 run on every build and five are* live-archive integration tests that are SKIPPED unless an archive RPC is configured. *None of the 381 fails*; the five are not run in the default environment, and calling that "all pass" — as this sentence did — counted a test that never executed as a passing one.

Two defects in one sentence. **333 is not arbitrary**: §11.7 records that at the close of an earlier
round "the suite stood at 338 tests, 333 passing, five skipped". The passing count was carried forward
two review rounds after it stopped being true. Note the sentence already contained a correction of an
*earlier* version of the same error — the drift outran the correction.

### 2.3 `whitepaper.part4.md:28` — §6.1 (`whitepaper.html:1059`)

> **Before** — … locked by 386 automated tests that run under the built-in Node test runner [34] with no external dependency, *alongside a further five* live-archive integration tests exercised behind an RPC flag.

> **After** — … locked by 386 automated tests that run under the built-in Node test runner [34] with no external dependency *— 381 of them run on every build, and five are* live-archive integration tests exercised behind an RPC flag.

### 2.4 `whitepaper.part4.md:30` — Table 2 caption (`whitepaper.html:1062`)

> **Before** — Table 2 — representative invariants from the 386-test suite. *All currently pass.*

> **After** — Table 2 — representative invariants from the 386-test suite. *The 381 that run in the default environment all pass; five need an archive node.*

### 2.5 A fifth site, found by the new gate rather than by the sweep

`hackathon/veritape/README.md:63` said **`152` model-free tests** — 234 stale — plus the same additive
"+ 5 live-archive tests behind an RPC flag". `tools/docs-consistency.mjs` never saw it: it walks
`Quiver/**` recursively but only the **top level** of `hackathon/`, so nothing under
`hackathon/veritape/` is read at all.

### 2.6 The wording was matched, not invented

`whitepaper.part6.md:153` already said it correctly — "later rounds have taken it to 386 and 381". A
document that states one fact four different ways is how this drift started, so every correction above
reuses that framing rather than adding a fifth.

---

## 3. Why `tools/docs-consistency.mjs` missed all four

The tempting answer — "it did not read those files" — is **wrong**, and checking it was the most
useful thing in this exercise. The whitepaper parts are byte-identical between
`hackathon/veritape/assets/` and `Quiver/assets/`, and the Quiver copies *are* inside the 128
documents it walks. All four defects were sitting in files it had open.

The miss was in what the rules could express. Replaying rule 2's regex
(`(\d{3})\*{0,2}\s+\*{0,2}(?:model-free|automated)\s+tests?`) against the four sentences verbatim:

| Site | Rule 2 verdict | Why |
|---|---|---|
| §1 contributions | matched `386 automated tests` → `386 === SUITE_SIZE` → **no finding** | the integer is right; the lie is the word "further" |
| §3.6 | **no match at all** | "386 tests" carries no `model-free`/`automated` qualifier; "None of the 333 fails" is not followed by a test noun |
| §6.1 | matched `386 automated tests` → **no finding** | same as §1 |
| Table 2 caption | **no match at all** | "386-test suite" is hyphenated and singular; the pattern needs `\s+` and `tests?` |

Four structural causes underneath that:

1. **The only suite fact was a total.** `SUITE_SIZE` counts `test(`/`it(` declarations statically. It
   yields 386 and *cannot* yield a pass count or a skipped count. A sentence claiming "None of the 333
   fails" had nothing in the tool to be compared against. **A checker cannot catch a wrong answer to a
   question it never asks** — and the skipped count is precisely what all four sentences got wrong.
2. **Two of four were syntactically invisible**, per the table above.
3. **The other two matched and passed**, because they quote a correct total. The defect was arithmetic
   in the surrounding prose, and no rule read arithmetic.
4. **Nothing compares document to document.** Every rule is document → system. So part 6 saying
   "386 and 381" and part 1 saying "386 … a further five" both passed individually. This is the shape
   a single-source check cannot see by construction, and it is the shape that produced the drift.

To be fair to the tool: its comment file shows it has been beaten into shape by real misses, its
history/quotation exemptions are well-judged, and this gate reuses them rather than reinventing them.

---

## 4. The gate: `gates/gateX-paper-contradiction.mjs`

`npm run gate:x` · revert: `npm run gate:x-revert` · 8 checks over **154 documents**
(`.md` **and** `.html`, across `Quiver/**`, `hackathon/*.md`, and `hackathon/veritape/**`).

**Truth comes from running the suite**, not from counting declarations: the gate spawns the runner and
parses its own `tests`/`pass`/`fail`/`skipped` summary, and refuses to proceed unless
`pass + fail + skipped === tests`. The total, the pass count and the skipped count are all facts.

| Check | Catches |
|---|---|
| runner summary is internally coherent | a broken suite, before any prose is graded against it |
| number matcher refuses glued digits | regression test, see below |
| every published suite figure matches the runner | `152 model-free tests`, `None of the 333 fails` |
| no two published documents state the same quantity differently | the cross-document shape |
| no arithmetic claim that does not add up | `386 … a further five` asserting 391 |
| nothing claims "all pass" while tests are skipped | the Table 2 caption |
| served part count matches what the text packs into | a lost or unregenerated part |
| the corpus is non-trivial | a checker that reads nothing passes every time |

### 4.1 False positives were the design problem

Three real strings in this repository contain a live suite figure as a substring: `79,386 accounts`,
`333,155 gas`, and the content hash `8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538…`. The
number matcher refuses any digit run glued to another digit, comma or period, and a test asserts this
against those three literal strings. A gate that cries wolf gets ignored on the day it is right.

Four classes of sentence are exempt, each drawn from a real document rather than imagined:

- **Logs** — path-based, reusing `docs-consistency`'s own list plus `verification-log`, `JUDGE_SWEEP`.
- **Quotations** — a correction table must print the wrong sentence beside the right one.
- **Dated blocks** — `QUIVER_SUBMISSION.md`'s correction table announces "the right is what was true
  when the correction was made on 26 July 2026". Rewriting it to today's figures would destroy the
  record of what was corrected.
- **Narrative** — §§11.5–11.7 are a chronological account of review rounds ("The suite is 294 tests,
  289 passing and five skipped"). Scoped by the *nearest heading at any level*, so the exemption sits
  on the subsection where the narrative is, not over the whole chapter.

### 4.2 Reading HTML as prose

The source of truth is HTML, so the prose rules must read HTML — and raw markup lied to them twice.
§3.6 narrates its own former error as `calling that &ldquo;all pass&rdquo;`: the quotation marks are
**entities**, so the quoted-text exemption could not see them, and the **semicolon that ends each
entity** looked like a clause break, cutting "all pass" away from the "default environment" qualifier
that makes it honest. A correct sentence became a finding. Tags and entities are now blanked to runs
of spaces **of exactly the same length**, so every byte offset — and so every reported line number —
is still the offset in the real file while the prose reads the way a person reads it.

---

## 5. Proof that it can fail: `npm run gate:x-revert`

Each defect is put back into the real documents, the machine edition regenerated exactly as a human
would, and the gate required to go **red on it by name** — then restored and required to go green
again, because red-in-both-states is a broken gate. For the original four it also runs
`tools/docs-consistency.mjs` and requires it to stay **green**: the blind spot demonstrated, not
asserted.

```
  CAUGHT  FURTHER-1   by: no arithmetic claim that does not add up            docs-consistency GREEN (blind)
  CAUGHT  FURTHER-2   by: no arithmetic claim that does not add up,
                          every published suite figure matches what npm test actually reports,
                          no two published documents state the same quantity differently
                                                                              docs-consistency GREEN (blind)
  CAUGHT  FURTHER-3   by: no arithmetic claim that does not add up            docs-consistency GREEN (blind)
  CAUGHT  ALL-PASS    by: nothing claims "all pass" while tests are skipped   docs-consistency GREEN (blind)
  CAUGHT  README-152  by: every published suite figure matches what npm test actually reports,
                          no two published documents state the same quantity differently
  CAUGHT  UNREGEN     by: no two published documents state the same quantity differently
  CAUGHT  LOSTPART    by: the served part count still matches what the text packs into

  gate X caught 7/7 reverted defects,
  including 4/4 of the judge sweep's original findings,
  while tools/docs-consistency.mjs stayed green on 4/4 of them — the gap this gate closes.

PASSED — every defect was caught by name, and the gate is green once restored.
```

`UNREGEN` is the trap the "edit the HTML, not the parts" rule exists to prevent, in its other
direction: a correction made only in the source never reaches what the served part N serves. The gate catches
it because it reads the source **and** the generated copies and compares them to each other.

### 5.1 The revert found four defects in the gate itself

Worth recording, because it is the entire argument for writing the revert before believing the gate:

1. The "is this claim about the suite?" guard tested the **sentence** for the word "test" or "suite".
   `"None of the 333 fails;"` is its own sentence and contains neither — so the guard written to
   prevent false positives silently created a **false negative on the most important claim in the
   set**. Now discriminates on the population noun attached to the number (`14 checks, 13 passing`)
   and reads the topic from a wide window.
2. The same bug hid the Table 2 caption: `"All currently pass."` mentions no suite either.
3. `NODE_TEST_CONTEXT` is inherited by a spawned `node --test`, which then decides it is nested and
   **skips running any files** — yielding an empty summary the gate would have had to interpret.
4. A `const raw = m[1]` inside the match loop **shadowed** the document text, so the section lookup
   received the matched digits instead of the file, disabling the narrative exemption for every
   markdown document at once. Caught because the revert re-ran the whole corpus, not one file.

---

## 6. The part count — and the thing the part count does not protect

The condition on this work was that the served part count stay **7**. It does, and it was verified by
regenerating and counting rather than by reasoning:

```
  parts  7 (budget 55 kB each): 1=34kB 2=25kB 3=42kB 4=54kB 5=12kB 6=47kB 7=33kB
```

`whitepaper.parts.json` is byte-identical to before the edit, so the section-to-part mapping did not
move either.

**But the reasoning offered for why it was safe was wrong, and the margin is much thinner than it
looked.** The splitter does not simply cut at every section boundary — it **packs greedily against a
55,000-byte budget, at section boundaries**. The relevant number is not the on-disk file size (which
includes each part's navigation header and tail) but the packed section content:

| Part | packed bytes | headroom |
|---|---|---|
| 1 | 35,084 | 19,916 |
| 2 | 25,774 | 29,226 |
| 3 | 42,843 | 12,157 |
| **4** | **54,827** | **173** |
| 5 | 12,039 | 42,961 |
| 6 | 48,351 | 6,649 |
| 7 | 33,907 | 21,093 |

Part 4 had **257 bytes** of headroom before this edit and has **173** after. That is roughly two
sentences. Two of the four corrections land in part 4, and they consumed a third of the margin.

And the count is the wrong thing to watch. Measured, in `[BOUNDARY]` of the revert script:

```
+465 B into §6 → part count 7 → 7; parts whose contents changed: 4, 5
  part 4 was «6. Verification and Testing | 7. Worked Walkthrough | 8. Limitations…»
           now «6. Verification and Testing | 7. Worked Walkthrough»
  part 5 was «9. Related Work and Positioning | 10. The Build…»
           now «8. Limitations and Honest Disclosures | 9. Related Work…»
```

465 bytes moved §8 Limitations out of part 4 and into part 5 **while the count stayed at 7**. Every
count-based check stays green, and `QUIVER_SUBMISSION.md` still tells a reader that
"part 4 — verification, walkthrough, limitations" (written as a paper-part URL). **The count is not the contract; the mapping
is.** `whitepaper.parts.json` records the mapping but is regenerated alongside the parts, so it cannot
witness its own drift. The gate therefore *prints* the full mapping and the tightest headroom on every
run, so a move is visible in the log and in the diff, and this is recorded as an open gap rather than
asserted away.

---

## 7. Deploy gap, and the one check that is red because of it

The paper's served bytes have changed, so all seven served parts on the live service differ from this
repository until the next deploy. **All seven, not the two that were edited** — each part's navigation
header prints the whole-document size, and the 116-byte growth tipped `Math.round(253507/1024)` from
247 kB to 248 kB, rewriting one line in every part. Parts 2, 3, 5, 6 and 7 are otherwise untouched.

That is why `gates/preflight.mjs` is red on exactly one of its 21 checks:

```
  [*** FAIL ***] every paper part is still byte-identical to live
           0 of 7
  [PASS] the changelog has an entry this deploy has not yet published
```

The check was verified GREEN before this work: every live part was fetched and compared, and all seven
matched the pre-edit files byte-for-byte. **This check cannot be green again until a deploy**, because
it asserts that the repository's paper already matches live — which is false by construction the moment
the paper is corrected, and stays false until the correction ships. Its own comment says it guards
"the static assets a judge reads have not moved", so it is doing its job: it is reporting an unshipped
paper change, which is precisely what exists right now.

It was **not** edited to go green. Weakening a gate to make a red disappear is the failure mode this
whole exercise is about, and `gates/` belongs to another workstream. **No deploy was performed.**

---

## 8. Verification run

| Command | Result |
|---|---|
| `npm test` | `tests 386`, `pass 381`, `skipped 5`, `fail 0` |
| `node tools/docs-consistency.mjs` | `CONSISTENT — 134 documents` |
| `npm run gate:x` | 8/8 pass, 154 documents, 233 claims (92 held to currency) |
| `npm run gate:x-revert` | `PASSED` — 7/7 defects caught by name, 4/4 of the original findings |
| `node gates/preflight.mjs` | 20 of 21 pass; the one red is §7 above, and clears on deploy |

`src/engine/` was not touched and `q1-e1fa99d08887d6cc` did not move. No test cases were added:
`npm test` is exactly 386, and the gate lives in `gates/` behind `npm run gate:x`.

Two shared files were edited additively rather than rewritten: `package.json` gained `gate:x` and
`gate:x-revert`, and `tools/docs-consistency.mjs` gained this report to its log list (it exists to
print the wrong sentence beside the right one, which is the definition of a log by that rule's own
comment). Note that `npm test` **runs** `docs-consistency`, so a document that trips it fails the
suite — which is how the first draft of this report and the changelog entry were caught quoting a
part URL that read as a stale reference.
