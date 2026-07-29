# A checker that reported CONSISTENT over documents it never opened

**Date:** 29 July 2026 · **Build:** `q1-e1fa99d08887d6cc` (unchanged; `src/engine/` untouched)
**Suite:** `npm test` → `tests 386` = `pass 381` + `skipped 5`, `fail 0` — unchanged, no test cases added
**Corpus:** `tools/docs-consistency.mjs` read **138** documents and now reads **199** over the tree as it stood when this began — **+61**, of which **11** are `.html` and were previously unreadable to it. **Nothing was dropped:** the old 138 are a strict subset. With this report and its mirror added the two figures are **140** and **201**, the same +61, and the report is itself checked.

---

## 1. The three blind spots, reproduced before they were closed

Each was put back into the real file and the tool required to be green on it in the old walk and red
on it by name in the new one. `npm run docs:revert` is that proof, and §5 is its output.

| # | The hole | How it was demonstrated |
|---|---|---|
| 1 | `walk()` ended `else if (e.endsWith('.md'))`. Eight authored `.html` files existed and none was ever opened — including `assets/landing.html`, the service's front page. | The six-entry paper index restored from `70673ea^`. Old walk: green. New walk: `enumerates parts but omits /paper/7`. |
| 2 | `hackathon/` was read with a bare `readdirSync` — top level only. Everything under `hackathon/veritape/`, the service directory itself, was outside the corpus. | `README.md`'s `152 model-free tests` restored. Old walk: green — it never opened the file. New walk: `quotes 152 model-free tests; the suite has 386`. |
| 3 | Every rule asked whether a claim was TRUE. None asked whether the sentence carrying it had survived being written down. | The changelog damage restored from `05d6c3f^` — two empty table rows and three eaten inline code spans. Old walk: green **over a file it did read**. New walk: five findings by line. |

Blind spots 1 and 2 are *positional* — the file was never opened. Blind spot 3 is not: the damaged
changelog was inside the 138 documents the whole time, and the tool reported CONSISTENT over it
anyway. The revert distinguishes these two by asking the tool itself (`--list`) which files the old
walk read, rather than by asserting a remembered story about it. That distinction is load-bearing —
see §5.1.

### 1.1 What the third blind spot is a rule about

A hole is not a wrong number. The damage class is generic and the failure is silent: the rows are
still rows and the sentences still end in full stops, so the document looks fine at a glance. Four
shapes are now checked, **each drawn from the damaged file** and **each measured against the maximal
471-document corpus before being admitted, at zero false positives**:

| Shape | From the real damage | Measured hits on the clean corpus |
|---|---|---|
| a table body row with no content in any cell | `\|  \|  \|` where two contract addresses belonged | 0 |
| a sentence ending on a word that cannot end one | `unchanged at .` · `Full record in .` | 0 |
| an unmatched empty inline code span | a code span whose contents vanished | 0 |
| a line beginning with a comma | `, a bent proof reverts .` | 0 |

Two further candidates were measured and **rejected for crying wolf**, which is the more useful half
of the exercise:

- **a row with *some* cells empty** — 136 hits, every one a legitimate trailing gap in a wide table
  (`| raw distance | 43,807 | 25.32% | 1.83% | 13.85× |  |`);
- **a backtick pair around whitespace** — 108 hits, every one two adjacent code spans
  (`` `src/x402.js` `isChargeable()` ``).

The header row of a two-column table is legitimately written `| | |` in this repository, so the rule
keys on the delimiter row above rather than on emptiness alone. The sentence rule skips fenced blocks,
where `git add .` is ordinary and correct, and the space before the stop is the entire signal — "that
is what a log is for." is normal English and `for` is in the word list; `for .` is a hole.

These rules are **not** held off logs. A log with its evidence eaten out is not a record of anything,
and currency is not the question being asked.

---

## 2. What the wider corpus turned up, and the judgement on each

A naive full walk produces **47 findings**. Judged individually, **all 47 are in snapshots or dated
reports** — and one genuine, live, previously-unseen defect was found by reading the front page.

### 2.1 The one real defect: the front page has been selling the wrong paper since 28 July

`assets/landing.html` line 79 — the first thing a judge reads — described the paper as

> Full technical documentation with methods, **ten tables** and 44 references, every one of them cited

Measured: the paper carries **eleven** numbered tables (`Table 1` … `Table 11`) and 44 references.
The references are right. The table count **was right too**, on 27 July, when the sentence was
written in `b383426` and the paper had exactly ten. The roadmap section landed on 28 July in
`a2a0602` carrying Table 11, and the front page was not touched.

This is the same file, the same paragraph, and three lines above the six-versus-seven part index that
*was* found and fixed the day before. One line in that paragraph was noticed and the other was not,
because nothing had ever read the file — and it has been wrong on live since.

**Judgement: fix, and it is now checked.** The paper's table-caption count and reference-list length
are read out of `assets/whitepaper.html` on every run, and every published claim about them is held
to that. `TEN-TABLES` in the revert proves the rule fires. Fixed in both trees; **live and still wrong
until a deploy** — see §6.

### 2.2 The 47: every one a snapshot or a dated report

| Where | Findings | Judgement |
|---|---|---|
| `hackathon/judging/Quiver/**` | 13 | **Out of corpus.** The judge's clone; `FINDINGS_LIVE.md` names it as such ("Clone: …\hackathon\judging\Quiver"). |
| `hackathon/judging/quiver-whitepaper.html` | 11 | **Out of corpus.** The paper as *rendered for that judging round* — still 298 tests, still `q1-3af04b595f397b54`. The live copy of the same file is `hackathon/paper/quiver-whitepaper.html`, which **is** checked and **is** current. |
| `hackathon/sentinel/vendor/**` | 5 | **Out of corpus.** The adversarial tester's vendored clone. |
| `hackathon/sentinel/recon/**` | 4 | **Out of corpus.** Captured HTTP responses — `body_build`, `hdr_paper.txt`, `github_readme.md`, down to the headers. `github_readme.md:63` records the live GitHub README saying `152 model-free tests`, which is a *measurement*, not a claim. |
| `hackathon/sentinel/*.md` (BUG_JOURNAL, BUG_REPORT, VERIFICATION_REPORT, LAPORAN_PENGGUNA) | 9 | **In corpus, classified as logs.** A five-day third-party buyer QA that states the build it ran against in its own header — "Build server saat verifikasi: `q1-bce7e7bccb16ea1b`". Every finding is "you quote the hash you tested". |
| `hackathon/judging/FINDINGS_LIVE.md` | 2 | **In corpus, classified as a log.** The hash sits inside a captured `curl /build` response. |
| `hackathon/.agents`, `hackathon/.claude` | 0 | **Out of corpus.** 244 files of installed third-party skill packages; `skills-lock.json` records their upstream (`okx/onchainos-skills`) and a content hash. They are `node_modules` for skills. |

The line between the two treatments is deliberate and is the distinction the tool already drew at
line 96: **a copy is not a document.** A clone, a rendered snapshot and a captured HTTP response are
excluded because holding them to currency means editing an artifact whose entire value is that it
records what was true when it was taken. The *reports about* those sessions stay in the corpus and are
classified as logs, so they are still read by the content-loss rules — nothing is hidden by being
dropped, it is classified instead. Both lists name their paths explicitly rather than guessing from
content, so adding a new document does not silently widen either.

### 2.3 Checked and found correct — the non-findings worth recording

| Claim | Where | Verdict |
|---|---|---|
| "the earlier card was captured under `q1-bce7e7bccb16ea1b`" | `hackathon/demo/terminal-card.html:5` | **Correct non-finding.** A stale hash, deliberately quoted, in a sentence explaining why the old card cannot be reproduced. The build-hash rule's context window exempted it, which is the exemption working. |
| "9 tools" | `hackathon/mcp-listing/SUBMIT.md`, `assets/landing.html:66` | **Correct.** `src/mcp.js` exports exactly 9. |
| "$0.005 – $0.05 per call" | `assets/landing.html:63` | **Correct.** Measured across `SERVICES`: min 0.005, max 0.05. |
| "44 references" | `assets/landing.html:79` | **Correct.** The reference list holds exactly 44 entries. |
| "22 paid services" | `hackathon/videos/end-card/index.html` | **Correct.** |
| registry `0xd50A…8D60` | `terminal-card.html`, `videos/end-card/index-with-registry.html` | **Correct**, matches the deployment record. |
| `hackathon/paper/paper.md` | — | **Not a project document at all.** It is a captured YouTube transcript about designing figures for research papers, sitting in `paper/` under a name that suggests otherwise. Harmless, produces no findings, left in the corpus. Recorded because a reader of the corpus list will wonder. |

---

## 3. A rule mis-firing on prose it was never written for — and the narrow exemption

The new table-count rule fired **on this work's own changelog entry**, three times, and then on this
report nine more times — which is the tension line 101 already documents: a correction has to be able
to print the wrong count beside the right one, or the record of the fix cannot be published at all.
Four narrow repairs, none of which lets the real defect through.

**On the report — in two tools, and this is the one to push back on.** `DOCS_COVERAGE.md` and its
mirror are named in the log list of `tools/docs-consistency.mjs` **and** of
`gates/gateX-paper-contradiction.mjs`, which accused it twelve times over
`states suite total 152 ("152 model-free tests"); the runner reports 386`. Both additions are one
path token, both follow exactly the precedent `PAPER_CONSISTENCY.md` set when the previous report hit
the same wall, and gate X belongs to another workstream so the change is called out rather than
buried. This document cannot describe what was fixed without printing `152 model-free tests`,
`q1-3af04b595f397b54` and the old table count beside the true ones.

**The exemption was required not to weaken the gate, and that was checked rather than argued:**
`npm run gate:x-revert` still catches **7/7** reverted defects by name, including 4/4 of the judge
sweep's original findings. The content-loss rules of §1.1 still read this report too, because those
are not questions about currency.

**On an identifier:** the rule accused `TEN-TABLES`, which is the *name of a scenario* in the revert
script, not a claim about the paper. Narrowed by testing the case of the noun only: if it is not
lower case the phrase is a label, not prose. `Ten tables` at the start of a sentence is still read.

**On quotations, twice:**

1. **`isQuoted` could only see a number as the *first word* of a quotation.** Its six-character
   lookback catches `"386 tests"` and walks straight past
   `| the page said | "methods, ten tables and 44 references" |`, which is the same correction table
   doing the same job with the number four words in. It now also treats a match as quoted when an odd
   number of quote marks precede it *on its own line*. Quotes inside markup are blanked before this
   runs, so an HTML attribute cannot open a quotation that swallows a line.
2. **A correction-context window**, modelled on the build-hash rule's and using the same shape: a
   window spanning both sides, because a correction usually names the old count first and the true one
   after. The front page's own sentence carries none of those words — which is exactly what makes it a
   claim rather than a record, and why `TEN-TABLES` still goes red.

Reading `.html` needed one further piece: tags and entities are blanked to runs of spaces **of exactly
the same length**, so every byte offset — and so every reported line number — is still the offset in
the real file while the prose reads the way a person reads it. This is gate X's technique, reused
rather than reinvented. Part URLs are read from the **raw** bytes instead, because on the front page
half the references live in `href="/paper/7"` and blanking the tag would delete precisely the
reference whose absence is the defect.

---

## 4. The deliberate blind mode, and why it is in the tool rather than the revert

`DOCS_CONSISTENCY_PRE_WIDENING=1` runs the pre-29-July walk: `.md` only, `hackathon/` top level only,
content-loss rule off. It reproduces the old corpus exactly — **138 documents**, the same number the
tool printed before this work.

It exists for one caller and one purpose. A claim that the tool *used to be blind* has to be
demonstrated, and the only way to demonstrate it is to put the defect back and run the old walk over
it. Reimplementing the old walk inside the revert script would prove that the reimplementation is
blind, which is a different and worthless statement.

It is a hole, so it is guarded: it prints a warning to stderr on every run, and `npm run docs:revert`
asserts that each positional defect **passes** there and **fails by name** in the default mode.
Weakening the default therefore breaks the revert rather than quietly reopening the gap.

---

## 5. Proof that it can fail: `npm run docs:revert`

Run from the service directory. Every file is mutated through `node:fs` and restored from a string
held in memory, with **no shell anywhere in the path** — which is not fastidiousness but the direct
lesson of defect 3, whose entire cause was backticks inside a double-quoted `node -e` argument being
command substitution.

```
Proving tools/docs-consistency.mjs can fail — 4 defects it was measurably blind to.

  BASELINE  CONSISTENT — 201 documents agree with each other and with the running system.

  CAUGHT  SIX-PART-INDEX   assets/landing.html — the service's own front page — indexed six parts while seven were served
     pre-widening walk: GREEN — it never opened this file, which is the blind spot itself
     named the file: hackathon\veritape\assets\landing.html
     caught: L84: enumerates parts but omits /paper/7
     restored: GREEN again on the untouched file

  CAUGHT  TEN-TABLES       assets/landing.html sold the paper as having ten tables from the day it grew an eleventh
     pre-widening walk: GREEN — it never opened this file, which is the blind spot itself
     named the file: hackathon\veritape\assets\landing.html
     caught: L79: says "ten tables" of the paper; it has 11
     restored: GREEN again on the untouched file

  CAUGHT  README-152       README.md quoted 152 model-free tests — 234 stale — under hackathon/, which was walked top level only
     pre-widening walk: GREEN — it never opened this file, which is the blind spot itself
     named the file: hackathon\veritape\README.md
     caught: L63: quotes 152 model-free tests; the suite has 386
     restored: GREEN again on the untouched file

  CAUGHT  EATEN-SPANS      assets/changelog.md shipped with two empty table rows and three inline code spans eaten by a shell
     pre-widening walk: GREEN — it never opened this file, which is the blind spot itself
     named the file: hackathon\veritape\assets\changelog.md
     caught: L62: table row has no content in any of its 2 cells — the row survived and what it said did not
     caught: L63: table row has no content in any of its 2 cells — the row survived and what it said did not
     caught: L69: line begins with a comma — the clause before it is missing
     caught: L74: sentence ends "at ." — the word after it is missing
     caught: L74: sentence ends "in ." — the word after it is missing
     restored: GREEN again on the untouched file

====================================================================================================
  4/4 defects were caught BY NAME by the widened walk, and missed by the walk that shipped them.

PASSED — every defect was caught by name, every file was restored byte-for-byte, and the
         checker is green again on the untouched tree.
```

The **absence of false positives** is the other half of the claim and is asserted by the baseline and
the restore line on every defect: the tool is green on the untouched corpus before any mutation and
green again after each one, so no document that was already correct is being accused.

### 5.1 What running it in the mirror found — in the revert, not in the checker

The same script run from `Quiver/` failed 3 of 4 on the first attempt, and both causes were real
defects in the *revert*:

1. **The blind mode did not narrow the fallback walk.** In the mirror neither sibling tree resolves,
   so the tool scans itself — and that branch was still reading `.html` under
   `DOCS_CONSISTENCY_PRE_WIDENING=1`. It went red on the defect it was supposed to be blind to.
2. **`README-152` was never a blind spot in the mirror at all.** `Quiver/README.md` is a different,
   longer file than the service directory's, and it always sat inside the old corpus. Asserting "the
   old walk must be green here" was asserting a remembered story. The revert now **asks the tool**
   which files the old walk reads (`--list`) and sets the expectation from that, printing which of the
   two kinds of blindness applied:

```
  CAUGHT  README-152   pre-widening walk: RED — this tree already read this file, so here it was never a blind spot
  CAUGHT  EATEN-SPANS  pre-widening walk: GREEN over a file it DID read — the miss was in the rules, not the corpus
```

Both trees now pass 4/4. Neither would have been found without running the revert from both.

---

## 6. Live-visible and still wrong until a deploy

| Finding | File | Repo | Live |
|---|---|---|---|
| the paper described as having ten tables; it has eleven | `assets/landing.html:79` | **fixed** | **still wrong** — served at `/`, and has been since 28 July |
| the changelog entry recording this | `assets/changelog.md` | **added** | **not yet published** |

`assets/landing.html` and `assets/changelog.md` are both served. **No deploy was performed**, and no
deploy window is open, so a reader arriving at the service root today is still told the paper has ten
tables. `gates/preflight.mjs` remains 21 of 21 with the changelog correctly ahead of live, which is
the state it is designed to report immediately before a deploy.

`gates/paper-mapping.json` pins only the seven `<li>` lines of that file, so the edit to line 79 does
not touch gate Y's contract — verified by re-running it.

---

## 7. Ground truth that contradicts this brief

Recorded because the standing order is to distrust the framing and measure.

1. **"Eight `.html` files exist outside `node_modules`" is right about authored content and wrong as
   a raw count.** Measured across both trees: **eighteen**. Eight are authored by this project
   (`assets/{landing,quiver-demo,whitepaper}.html` in each tree, `hackathon/paper/quiver-whitepaper.html`,
   `hackathon/demo/terminal-card.html`); the other ten are the vendored clones and captured pages of
   §2.2 plus three HyperFrames video compositions. The corpus now reads **eleven** — the eight, plus
   the three video compositions, which render text a viewer sees and are clean.
2. **The count of blind spots that are about the corpus is two, not three.** Blind spot 3 was never
   positional: the damaged changelog was inside the 138 documents. The brief's own framing says so
   ("`docs-consistency` reported CONSISTENT across 138 documents over that file") and the revert
   measures it rather than restating it.
3. **`npm run gate:x` is not green in the mirror, and was not before this work.** In `Quiver/` it
   fails one of eight — `only 70 documents found — the paths this gate walks have moved` — because
   `ROOT` resolves outside the tree there and gate X asserts a corpus above 100. **This work added
   zero `.md` or `.html` files to `Quiver/`**, so the count was 70 before it and 66 before another
   session's four untracked docs. It is green 8/8 in the service directory, where the brief's
   constraint is met. Not touched: it belongs to another workstream, and the fix is gate X's `ROOT`
   resolution, not its corpus.
4. **Nothing was dropped from the corpus.** 138 → 199 over the tree as it stood, and the old 138 are
   a strict subset — verified by set difference, not by the count. The exclusions in §2.2 only ever
   removed files that a `.md`-only, top-level walk had never reached.
5. **`hackathon/paper/paper.md` is not a paper.** See §2.3.

---

## 8. Verification run

| Command | Result |
|---|---|
| `node tools/docs-consistency.mjs` | `CONSISTENT — 201 documents` (138 before this work; 140 for the old walk over the same tree, so +61 either way) |
| `npm run docs:revert` | `PASSED` — 4/4 caught by name, in **both** trees |
| `npm test` | `tests 386`, `pass 381`, `skipped 5`, `fail 0` — unchanged, no cases added |
| `npm run gate:x` | 8/8 pass, 160 documents (service directory; see §7.3 for the mirror) |
| `npm run gate:x-revert` | `PASSED` — still 7/7 by name, so the log-list addition of §3 did not weaken it |
| `npm run gate:y` | 8/8 pass, 7 parts, 5 publication sites, 0 findings |
| `npm run gate:y-revert` | `PASSED` — 13/13 blocked by name, 4/4 legitimate states allowed |
| `node gates/preflight.mjs` | **21 of 21 PASS — PREFLIGHT PASSED**, in both trees |

`src/engine/` was not touched and `q1-e1fa99d08887d6cc` did not move. No test cases were added; the
new revert lives in `gates/` behind `npm run docs:revert`. **No deploy was performed.**

### Files

New — `gates/docs-coverage-revert.mjs`.

Edited — `tools/docs-consistency.mjs` (corpus, the `.html` prose view, the paper-shape rule, the
content-loss rule, `--list`, the blind mode), `package.json` (`docs:check` and `docs:revert`, added
additively), `assets/landing.html` (line 79 only), `assets/changelog.md` (one entry),
`gates/gateX-paper-contradiction.mjs` (**one token in its log list — another workstream's file; see
§3**).

Mirrored to `Quiver/`, where the revert, `gate:y`, `npm test` and `gates/preflight.mjs` were all
re-run.
