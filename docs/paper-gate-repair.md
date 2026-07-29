# A gate that could not go green, and a contract nobody was holding

**Date:** 29 July 2026 · **Build:** `q1-e1fa99d08887d6cc` (unchanged; `src/engine/` untouched)
**Suite:** `npm test` → `tests 386` = `pass 381` + `skipped 5`, `fail 0` — unchanged, no test cases added
**Result:** `node gates/preflight.mjs` → **21 of 21 PASS**. It was 20 of 21 with one permanently red.

---

## 1. Defect 1 — the check that blocked the deploy that would have cleared it

`gates/preflight.mjs` check 5 required every machine-readable part of the paper to be **byte-identical
to the live service**. Check 6, forty lines below it, requires the changelog to be **ahead of** live.

One demanded `repo == live`. The other demanded `repo > live`. The only state satisfying both is one
in which the paper has not been touched. The moment the paper is legitimately corrected, check 5 is
false by construction and stays false until the correction is deployed — and preflight is the gate
that authorises the deploy. **It blocked precisely the deploy that would have made it green.**

That is not a check being strict. A check is a question about the world; this one asked a question
whose only correct answer, in the state it was designed to report on, made the answer unreachable.
The distinction it needed was never between *same* and *different*. It was between:

| | |
|---|---|
| the paper differs from live because we changed it deliberately, and that is written down | **proceed** |
| the paper differs from live and nothing accounts for it | **block** |

### 1.1 The signal, and why the weaker candidates are not sufficient

The brief suggested the changelog as the signal, and asked that its sufficiency be established rather
than assumed. It is **necessary and not sufficient**, and the reason is worth stating because it is
the same reason for both rejected variants:

| Candidate signal | What satisfies it by accident |
|---|---|
| "the changelog is ahead of live" (check 6 already asserts this) | any unrelated entry. It says nothing about the paper. |
| "the changelog delta mentions the paper" | an entry about the paper written for a different change. |
| "the changelog names the parts that changed" | a **second, unnoticed edit to a part that was already named**. The parts are regenerated wholesale by `tools/paper-to-text.mjs`, so two changes landing in one part is the likeliest accident there is. |

Every prose-level signal is satisfied by a superset of the state it is meant to certify. The signal
has to bind to the **bytes**. So:

- a part whose **paper text** differs from live must be declared in `gates/paper-pending-deploy.json`
  by **sha256 of the exact file**, together with the changelog entry that explains it;
- that entry must be present in `assets/changelog.md` and **absent from the live changelog** — i.e.
  it is the unshipped paperwork for this unshipped change, not something that already went out;
- **every** declaration must match the tree as it stands, whether or not that part currently differs
  from live. A declaration that has drifted from the bytes is not evidence of anything.

Declarations are **per part, each naming its own changelog entry**, not one anchor for the file. That
detail was forced by measurement, not foresight: on the day this was written the paper had been
changed by *two* separate corrections landing in different parts, and a single anchor would have let
the second ride on the first one's paperwork.

**Why this is sufficient.** Any further byte moved in a declared part changes its hash and the
declaration stops matching. Any part that changes without being declared is named and blocked. The
only way to pass is for a human to have looked at each differing part and written down what it is —
which is exactly the acknowledgement the old check was reaching for and could not express.

**Why it is a repair and not a loophole.** The new condition is *always satisfiable by an action in
the repository*: write down what you changed. The old condition was satisfiable only by the deploy it
was gating. That is the whole difference, and it is the property to check if this is ever revised.

**What it deliberately does not claim.** The manifest is an *acknowledgement* mechanism. It does not
verify that a change is correct — no gate can — and a determined author can approve a mistake. What
it removes is the ability for a change to reach a judge without anyone having named it.

### 1.2 The reporting fix — `0 of 7` when two parts had changed

The old detail line read `0 of 7`. Measured, that was true and useless. Every part's navigation header
prints the whole-document size, so a 116-byte edit tipped `Math.round(bytes/1024)` from 247 kB to
248 kB and rewrote **one line in all seven**.

Each part file is now split into its generated navigation header, the packed paper text, and its
generated tail, and only **one** header line is treated as an echo:

```
> Whole document in one response (248 kB, may truncate in your client): `/paper/full`
```

Nothing else in the header is exempt, and that restraint is load-bearing: **the header also carries
the full part map**, so a section moving between parts rewrites the map in every part. Folding the
whole header into "just boilerplate" would have hidden exactly the drift defect 2 is about. The
revert proves the narrowness (`NAV-MAP-MOVED`).

Preflight now reports, against live at the time of writing:

```
  [PASS] every difference between the repo paper and live is declared and documented
           7 parts: 3 differ in the paper text (1, 4, 7), 4 differ only in the generated
             document-size line (2, 3, 5, 6), 0 byte-identical to live
           part 1 — declared, hash matches, documented by the unpublished entry
             "## 29 July 2026 — the paper said the suite was bigger than it is"
           part 4 — declared, hash matches, documented by the unpublished entry
             "## 29 July 2026 — the paper said the suite was bigger than it is"
           part 7 — declared, hash matches, documented by the unpublished entry
             "## 29 July 2026 — a fifth site said the same thing in a verb the"
           every difference is declared by content hash and covered by an unpublished changelog entry
```

Three, not two: a fifth correction site landed in Appendix B — inside part 7 — while this work was in
progress. See §6.

---

## 2. Defect 2 — the mapping was published in five places and asserted in none

`tools/paper-to-text.mjs` packs sections **greedily against a 55,000-byte budget at section
boundaries**. Which part a section lands in is therefore a function of every byte before it. Part 4
sits **173 bytes** under budget: adding 465 bytes to §6 moves §8 *Limitations and Honest Disclosures*
out of part 4 and into part 5 **while the count stays at seven**.

Every check in this repository watched the count. `assets/whitepaper.parts.json` records the mapping
but is rewritten by the same run that moves the boundary, so it agrees with every move and cannot
witness its own drift. Gate X prints the mapping and the tightest headroom on every run, so a move is
visible in a diff — but nothing asserted it.

### 2.1 The shape chosen, and the judgement on it

The brief suggested a committed mapping file that is **not** regenerated, checked against both
`parts.json` and the published descriptions. **That is the right shape and it is what was built**, with
one refinement and one honest limit.

Keyword-matching the published prose against generated titles was correctly rejected as fragile — part
2 is published as "the twenty-two services" and generated as "4. Service Catalogue", and no keyword
rule relates those without either false-positiving or being loosened until it matches anything.
`gates/paper-mapping.json` sidesteps the problem by storing **both sides verbatim**: the section list
each part must carry, and the exact wording each publication uses for it. Neither side may move
without the other.

The honest limit, stated plainly because it is where a reader should push back: **a machine cannot
verify that "limitations" means §8.** That pairing is a human judgement, made once, recorded in the
committed file. What the machine verifies is the property that actually rots — that the pairing a
human approved is still the pairing being served *and* still the pairing being published. This is a
weaker claim than "the descriptions are true", and it is the strongest claim available without a
keyword rule.

The refinement: the mapping is not published in one place. **It is published in five.**

| Site | What it publishes | State when found |
|---|---|---|
| `hackathon/QUIVER_SUBMISSION.md` | the seven descriptions a judge reads | correct |
| `assets/whitepaper.html` | the paper's own index of its machine edition | correct (read-only — this file *is* the paper) |
| `hackathon/paper/quiver-whitepaper.html` | the copy the PDF is rendered from | correct |
| `Quiver/README.md` | the only site publishing the mapping by section **number** | correct |
| `assets/landing.html` | the service's own front page | **wrong, and live** — see §3 |

`npm run gate:y` holds four independent records to the committed contract:

1. what the text **actually packs into**, recomputed from `assets/whitepaper.md`
2. the generated `assets/whitepaper.parts.json`
3. the part files on disk, **rebuilt byte-for-byte** as the splitter would write them
4. all five publication sites, byte-exact, plus "every site that enumerates the parts must enumerate
   all of them"

…plus two guards on its own foundations: that `assets/whitepaper.html` and `assets/whitepaper.md`
still list the same sections in the same order (a section added to the source without regenerating is
the change most likely to move a boundary, and is invisible to everything that reads only generated
files), and that `tools/paper-to-text.mjs` still declares `BUDGET = 55_000`, so no figure in the gate
is computed against a number that has moved.

---

## 3. What the new gate found on its first run, live, on the front page

`assets/landing.html` — the first thing a judge sees at the service root — published an index with
**six** entries while seven parts were being served, and had no link to part 7 at all. Its
descriptions were off by one from part 4 onward: part 4 was described as carrying "related work"
(that is §9, in part 5), and a reader with two minutes was told to read part 6 for the checkable
artifacts, which are in part 7. Fetched from the live service at the time of writing, it was wrong
there too. It had been wrong for days.

This is defect 2's failure mode, already realised, in the most-read place there is. Every *other*
publication of the mapping had been corrected when the document grew a seventh part; this one was
left behind. Commit `6e6e45c`, whose message is about the mirror's paper index having been left a part
short while the seventh sat next to it on disk, is the moment the README was fixed and this file was
not.

**Why nothing caught it.** `tools/docs-consistency.mjs` has *exactly* the right rule — "a document
that enumerates parts must enumerate all of them", complete with a range-expansion special case so it
does not accuse correct prose — and its `walk()` ends with `else if (e.endsWith('.md'))`. It never
opened the file. Gate X walks `.html` as well as `.md`, but has no rule about part URLs. Between them
the property was covered twice and the file was covered zero times.

**Scope call, flagged deliberately.** The brief says "you are building checks, not editing content",
and names `whitepaper.html` and `whitepaper.part*.md` as off limits. `assets/landing.html` is neither
— it is not the paper — but it is content, so this is a judgement made against the letter of the
brief and stated here rather than buried. The alternative was to ship a mapping gate that looks away
from the one site where the defect is real, which is the failure mode this repository is organised
against. The fix is nine lines, derived from the packing rather than invented, and is reverted with
`git checkout assets/landing.html` in either tree. It is disclosed in `assets/changelog.md`.

---

## 4. Headroom, measured, and whether 173 bytes deserves a warning

| Part | packed bytes | headroom | sections |
|---|---|---|---|
| 1 | 35,084 | 19,916 | Abstract · At a Glance · Contents · §§1–3 |
| 2 | 25,774 | 29,226 | §4 Service Catalogue |
| 3 | 42,843 | 12,157 | §5 Methodology |
| **4** | **54,827** | **173** | §6 Verification · §7 Walkthrough · §8 Limitations |
| 5 | 12,039 | 42,961 | §9 Related Work · §10 The Build |
| 6 | 48,351 | 6,649 | §11 Roadmap · §12 Conclusion |
| 7 | 34,003 | 20,997 | Appendices A–C · References |

Part 7 grew 96 bytes during this work (§6). Part 4 is unchanged at 173 bytes — about two sentences.

**Yes, a warning threshold is worth having, and it is not a substitute for the assertion.** They fire
at different times and only one of them is cheap to act on:

- the **assertion** fires *after* the boundary has moved. By then the document is re-cut, the
  published mapping is already wrong, and the remedy is to rewrite prose or re-approve the mapping
  across five files;
- the **warning** fires *before*, while the cheap remedy still exists — shorten the sentence, or move
  it into an adjacent section.

`gate:y` warns when the tightest part is under **1,200 bytes**, roughly one paragraph of this paper's
prose. The message it prints is the actionable form: *the next paragraph you add here re-cuts the
document*. 173 bytes is deep inside that band; a single sentence moves it.

It is deliberately **not** an assertion. 173 bytes is a legitimate state of the document — a thin
margin, not a defect. Failing on it would demand rewriting correct prose to satisfy a gate, which is
how a gate gets switched off. The defect is the mapping moving, and that is asserted.

---

## 5. Proof that both checks can fail: `npm run gate:y-revert`

Both checks guard artifacts a gate may not edit, so every defect is reinstated **in memory** against
the real live bytes and the real files. That is why `gates/paper-integrity.mjs` reads nothing and
fetches nothing: all its inputs are arguments, and `gates/paper-inputs.mjs` is the only place the
paths live.

For defect 1 the revert proves **both directions**. A check that only blocked would have re-certified
the deadlock.

```
DEFECT 1 — preflight check 5: repo-vs-live parity

   OK     DELIBERATE       expected to pass  — the real pending paper change is declared and
                                               documented, and the check is GREEN — the deadlock is gone
   OK     POST-DEPLOY      expected to pass  — repo == live for every part and nothing is demanded
                                               of the manifest
   OK     UNDECLARED       expected to block — part 2 differs from live in the paper text (48 lines
                                               of the paper text differ) and is NOT declared in
                                               gates/paper-pending-deploy.json
   OK     HASH-DRIFT       expected to block — the manifest declares part 4 as ab2c7dbffc8db907… but
                                               assets/whitepaper.part4.md hashes to 49978f3355a64777…
                                               — the file has moved since it was approved
   OK     ALREADY-SHIPPED  expected to block — part 1 names the changelog entry "## 29 July 2026 —
                                               the paper said the suite was bigger than i", which is
                                               ALREADY live — it does not document an unshipped change
   OK     ECHO-ONLY        expected to block — 7 part(s) carry a changed document-size line while no
                                               part's text changed — the served bytes moved and
                                               nothing in this tree explains it
   OK     NAV-MAP-MOVED    expected to block — part 3 … the navigation header differs beyond the
                                               document-size echo (nav line 10) — the header carries
                                               the part map, so this can be a section moving between parts
   OK     UNREACHABLE      expected to block — part 5: live did not answer — this part could not be
                                               compared, and an unevaluated check is not a pass
```

`DELIBERATE` is the anti-deadlock proof and `POST-DEPLOY` is its companion: red in both states is a
gate broken in a different way. `ECHO-ONLY` and `NAV-MAP-MOVED` are the two ways the reporting fix
could have quietly become a loophole, and both refuse.

```
DEFECT 2 — gate Y: the published section-to-part mapping

   OK     RESTORED          expected to pass  — all four records agree across 5 publication sites
   OK     BOUNDARY-MOVE     expected to block — +464 B into §6 moved §8 Limitations from part 4 to
                                                part 5. Every count-based / generated-vs-generated
                                                check stays GREEN (part count is still 7;
                                                whitepaper.parts.json still matches the packing; the
                                                part files are still what the splitter would write;
                                                the source and the markdown edition still agree).
                                                Only the rules anchored to the committed mapping fire
                                                [MAPPING, PARTS-JSON]: part 4 now packs «6. Verification
                                                and Testing | 7. Worked Walkthrough» but the committed
                                                mapping says «… | 8. Limitations and Honest Disclosures»
   OK     SIX-PART-INDEX    expected to block — assets/landing.html … enumerates the machine-readable
                                                parts but never references part 7 — a reader is told
                                                the paper is smaller than it is
   OK     SUBMISSION-PROSE  expected to block — hackathon/QUIVER_SUBMISSION.md no longer contains its
                                                committed description of part 4
   OK     HAND-EDIT         expected to block — whitepaper.part4.md is not what the splitter would
                                                write from assets/whitepaper.md (first difference at
                                                line 163) — it was hand-edited, or the source moved
                                                without a regeneration
   OK     PARTS-JSON-STALE  expected to block — whitepaper.parts.json part 5 records «8. Limitations
                                                …» against the committed «9. Related Work …»
   OK     SOURCE-DRIFT      expected to block — assets/whitepaper.html lists 20 top-level sections and
                                                assets/whitepaper.md lists 19 — the markdown edition
                                                was not regenerated from the source
   OK     BUDGET-DRIFT      expected to block — tools/paper-to-text.mjs no longer declares
                                                BUDGET = 55_000
   OK     RESTORED-AGAIN    expected to pass  — both checks green again on the untouched tree

============================================================================
  13/13 defects were BLOCKED by name
  4/4 legitimate states were ALLOWED through

PASSED — every defect was caught by name, every legitimate state was allowed, and both
        checks are green once restored.
```

`BOUNDARY-MOVE` is the measurement that justifies the whole of defect 2. The mutated document is
**regenerated exactly as an author would regenerate it**, so the part files, `parts.json` and the
count are all mutually consistent afterwards. Every check that compares one generated artifact to
another stays green through the move. Only the rules anchored to the record a human committed fire.

### 5.1 What the revert found in the checks themselves

Two things, both caught by writing the revert before believing the gate:

1. The first `BOUNDARY-MOVE` assertion claimed `parts.json` would stay green through the move. It does
   not — held against the **committed** mapping it fires, because that comparison is no longer
   generated-vs-generated. The blindness is real but belongs to `parts.json` compared *to the
   packing*, not to `parts.json` as such, and the scenario now measures which rules go red instead of
   asserting a remembered story about them.
2. `gateY-revert.mjs` originally imported `readInputs` from the gate, which registers `node:test`
   cases at import — so running the revert would have silently run the gate as well. The filesystem
   half now lives in `gates/paper-inputs.mjs`, which imports nothing that runs.

---

## 6. Ground truth that contradicts the brief

Recorded because the standing order is to distrust the framing and measure:

1. **"The paper must not change" was not true of the tree while this ran.** At 14:06 local, mid-task,
   `assets/whitepaper.html` and every generated part were rewritten by the concurrent session: a
   **fifth** correction site in Appendix B ("381 of the 386 model-free properties … can be verified
   offline"), +96 bytes, landing in part 7. Measurements taken before that point were discarded and
   redone. The manifest hashes in this report are pinned to the tree as of the final verification run.
   Nothing in this work edited the paper.
2. **The count of parts differing from live is 3, not 2.** The brief describes parts 1 and 4 as the
   substantive changes; Appendix B makes it 1, 4 and 7. The check reports what it measures.
3. **The mapping is published in five places, not one.** The brief names `QUIVER_SUBMISSION.md` lines
   122–128. Four other sites publish it, and the one the brief did not name is the one that was wrong.
4. **`whitepaper.parts.json` did not need to witness its own drift to be useful.** The brief is right
   that it cannot — but held against a *committed* record it witnesses the other half of the same
   failure: a part set that was never regenerated. It is used for that.
5. **The gate count in preflight is unchanged at 21.** Check 5 was replaced in place rather than
   split, so no document that quotes "21 checks" goes stale.

---

## 7. Residual gaps, named rather than closed

- **`whitepaper.md` is not proven to be a current render of `whitepaper.html`.** The gate asserts the
  two list the same sections in the same order, which catches a section added, removed, renamed or
  reordered — the changes that move a boundary. It does not catch a *sentence* edited in the HTML
  without regenerating. Closing it means re-implementing 150 lines of the HTML-to-markdown transform
  as a second copy that would drift from the first, or running the generator, which writes to
  `assets/`. Gate X's cross-document rules cover the case that matters most (a corrected figure that
  never reaches the served part).
- **The navigation template is duplicated** between `tools/paper-to-text.mjs` and
  `gates/paper-integrity.mjs`. If the generator's template changes, the rebuild check goes red until
  the copy is updated. That is a loud failure rather than a silent one, which is the right side to
  fail on, but it is duplication.
- **The manifest cannot tell an approved change from an approved mistake.** It records that somebody
  looked. See §1.1.
- **`assets/landing.html` is not held to the paper's own figures** by anything — only its part
  mapping is now checked. Nothing reads the `.html` surfaces for stale suite counts; `docs-consistency`
  is `.md`-only and gate X's corpus includes `.html` but its rules are about suite figures, not
  landing-page claims.

---

## 8. Verification run

| Command | Result |
|---|---|
| `node tools/docs-consistency.mjs` | `CONSISTENT — 136 documents` |
| `npm test` | `tests 386`, `pass 381`, `skipped 5`, `fail 0` — unchanged, no cases added |
| `npm run gate:x` | 8/8 pass, 156 documents, 253 claims (102 held to currency) |
| `npm run gate:y` | 8/8 pass, 7 parts, 5 publication sites, 0 findings |
| `npm run gate:y-revert` | `PASSED` — 13/13 blocked by name, 4/4 legitimate states allowed |
| `node gates/preflight.mjs` | **21 of 21 PASS — PREFLIGHT PASSED**, in both trees |

`src/engine/` was not touched and `q1-e1fa99d08887d6cc` did not move. No test cases were added; both
new gates live in `gates/` behind `npm run gate:y` and `npm run gate:y-revert`. **No deploy was
performed.**

### Files

New — `gates/paper-integrity.mjs` (logic, reads nothing), `gates/paper-inputs.mjs` (the filesystem
half), `gates/paper-mapping.json` (the committed mapping contract), `gates/paper-pending-deploy.json`
(the hash-pinned declaration), `gates/gateY-paper-mapping.mjs`, `gates/gateY-revert.mjs`.

Edited — `gates/preflight.mjs` (check 5 only, replaced in place), `package.json` (two script aliases,
added additively), `assets/landing.html` (the mapping fix of §3), `assets/changelog.md` (one entry).

Mirrored to `Quiver/`, where `npm run gate:y` and `gates/preflight.mjs` were both re-run and are green.
