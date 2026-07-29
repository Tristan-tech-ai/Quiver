# The judge-facing PDF was two corrections behind, and so is everything else served from that build

> **SUPERSEDED IN ITS TWO CONCLUSIONS, 29 July 2026.** The re-render described below is accurate and
> stands. What no longer holds is everything this document said about what was *published*:
>
> - **§6 said the live served paper was stale. It is not.** The 09:30 UTC deploy landed after this was
>   written. All seven parts, the typeset HTML, `/paper/full` and `/changelog` are **byte-identical to
>   the tree** — verified by sha256 per part, and independently by `gates/preflight.mjs`, which now
>   reports *"7 byte-identical to live … the repository and live agree byte for byte"*.
> - **§8 said "whatever that link currently serves, it is not this document", and that this was "not
>   verifiable from here". Both were false.** Tristan replaced the Drive file. One unauthenticated
>   `curl -sIL` returns the published size, and that is the whole verification — see §8.
>
> The second error caused the first: because the page had decided the fact could not be checked, it
> stopped trying and reported a records trail as a measurement. The corrected sections are marked
> in place below. Write-up: `claim-repair.md`.

**Date:** 29 July 2026 · **Build:** `q1-e1fa99d08887d6cc` (unchanged; `src/engine/` untouched)
**Suite:** `npm test` → `tests 386` = `pass 381` + `skipped 5`, `fail 0`
**Artifact:** `paper/Quiver-Technical-Documentation.pdf` — re-rendered, 56 pages, verified by eye

---

## 1. What was wrong

Two paper corrections landed on 29 July. `paper/Quiver-Technical-Documentation.pdf` was dated 28 July
04:23, so it predated both. Tristan publishes a Google Drive copy of that PDF in the submission form,
so a judge who downloads it reads the uncorrected numbers.

The corrections live in five places in `assets/whitepaper.html`. Measured before touching anything —
counts are occurrences in the extracted PDF text and in the source, normalised for whitespace and
line-break hyphenation:

| marker | old PDF | source HTML |
|---|---|---|
| "a further five" | 3 | 0 |
| "None of the 333 fails" | 1 | 0 |
| "All currently pass." | 1 | 0 |
| "of which 381 run on every build and five are" | 0 | 2 |
| "None of the 381 fails" | 0 | 1 |
| "The 381 that run in the default environment all pass" | 0 | 1 |
| "381 of the 386" | 0 | 1 |

Every stale marker was present in the PDF and absent from the source; every corrected marker was the
other way round. That is the definition of a stale render, and it was true of all five sites — not
four. A parallel sweep reported that the old PDF already carried the Appendix B fix; it did not, and
the word-level diff in §4 shows the words `381 of` being inserted on page 51.

---

## 2. How it was rendered

There **is** a render script on disk: `paper/render.cjs`. It was the tool that produced the 28 July
file, which is not assumed — the old PDF's own metadata says `Producer: Skia/PDF m149`, and its
extracted footer reads "Quiver · Technical Documentation · v1.0 · Page 46 of 56", which is the exact
footer template `render.cjs` injects.

The source it reads, `paper/quiver-whitepaper.html`, is byte-identical to the source of truth
(`md5 0fc58050c062c962100905d4975e7699` for both), so no sync step was needed.

| | |
|---|---|
| renderer | `paper/render.cjs` — Playwright 1.61.1, headless Chromium |
| Chromium | `HeadlessChrome/149.0.7827.55` → `Skia/PDF m149`, same major as the old file |
| page setup | A4, `printBackground`, margins 17/15/17/17 mm, footer with page numbers |
| external fetches | none — the HTML has zero external `src`/`href`/`@import`; one inline PNG data URI |

The last row matters: a browser render that silently loses a stylesheet produces a plausible-looking
PDF with the wrong typography. This document cannot, because it depends on nothing off-disk.

The render was written to a scratch path first and only copied over the judge-facing file after the
checks below passed.

---

## 3. Before and after

| | before | after |
|---|---|---|
| bytes | 935,265 | 935,830 |
| sha256 | `2e288cd5…901382` | `8b45e027…83451f` |
| pages | 56 | 56 |
| created | 28 Jul 04:23 | 29 Jul 15:30 |
| title | Quiver — Verifiable Financial and Security Primitives for the Agentic Economy | unchanged |
| fonts | 18, all embedded | identical set, all embedded |
| images | 1 (page 33, 1200×675) | identical |

All three stale markers are now absent from the PDF and all four corrected markers present, at the
counts the source carries. The document title survives intact.

---

## 4. The page count did not move, and that is explained rather than assumed

56 pages before, 56 after. An unexplained page count is worse than a changed one, so the pagination
was measured three ways:

1. **Page-start drift** — the opening 90 characters of all 56 pages are identical between editions.
   Nothing moved across a page boundary.
2. **Whole-page equality** — exactly five pages differ: 7, 11, 25, 26 and 51. Those are precisely the
   five correction sites. The other 51 pages are textually identical.
3. **Word-level diff** of those five pages — the only edits are the corrections themselves:

| page | section | edit |
|---|---|---|
| 7 | §1 contributions | "invariants that run on every build, a further five" → "invariants, of which 381 run on every build and five are" |
| 11 | §3.6 Proven by test | same rewrite, plus "None of the 333 fails" → "None of the 381 fails" |
| 25 | §6.1 invariant test suite | "alongside a further five" → "— 381 of them run on every build, and five are" |
| 26 | Table 2 caption | "All currently pass." → "The 381 that run in the default environment all pass; five need an archive node." |
| 51 | Appendix B | "so the 386 … verified offline." → "so 381 of the 386 … verified offline, and five are live-archive integration tests skipped unless an archive RPC is configured." |

The corrections add roughly one line of text in total. It did not push the document onto a 57th page
because §6.1 already ended with a large whitespace gap — Table 2 is a keep-together block that starts
on page 26, and page 25 has been short since before this change. Rasterising the **old** page 25
confirms the same gap was there already, so the extra line was absorbed by space that already existed
rather than by anything reflowing.

---

## 5. What was actually seen — rasterised, not grepped

Grepping the source is not verification. Seven pages were rendered to PNG with `pdftoppm` and looked
at, plus two 400-DPI crops for the details that small type hides.

| page | rendered at | what was seen |
|---|---|---|
| 1 | 150 DPI | Title page clean. Heading reads "Verifiable Financial and Security Primitives for the Agentic Economy", subtitle, "Technical Documentation · Version 1.0 · July 2026", footer "Page 1 of 56". |
| 7 | 150 + 400 DPI | Contribution 8 reads correctly. The line breaks as "live-" / "archive", which is why the text extractor reports "livearchive" — a hyphenation artifact, not a defect. |
| 11 | 150 DPI | §3.6 carries both rewrites in one paragraph, ending "counted a test that never executed as a passing one." |
| 25 | 150 DPI | §6.1 reads "— 381 of them run on every build, and five are live-archive integration tests exercised behind an RPC flag." Old page 25 rendered alongside as a control. |
| 26 | 150 + 400 DPI | **Table 2 intact** — header row, 13 body rows, both columns, all rules and borders. Corrected caption below it. Table 3 below that also intact. |
| 33 | 150 DPI | **Figure 6 intact** — candles, EMA, Bollinger bands, RSI panel, volume panel, axis labels, price tag. No clipping. |
| 51 | 150 DPI | Appendix B closing paragraph carries the corrected sentence. |

**The `₮` glyph.** It has broken before, so it was checked directly rather than inferred. It appears
on the same six pages in both editions, and the 400-DPI crop of page 7 shows a properly formed tenge
sign with its crossbar in "USD₮0" — not a fallback box. The trailing zero sits low because the
document uses old-style figures throughout; the same shape appears in "402" and "0.005" on the same
line, so it is the typeface, not a broken glyph.

**Table 2's caption, old and new, at the same crop.** The 400-DPI crops were taken at identical
coordinates from both editions. The old reads "…386-test suite. All currently pass." and the new reads
"…386-test suite. The 381 that run in the default environment all pass; five need an archive node." In
both crops the following line — "The no-look-ahead test deserves emphasis…" — sits at the same height,
which shows the longer caption absorbed inside its own line rather than displacing the body text.

---

## 6. The live served paper is stale too — RESOLVED BY THE 09:30 UTC DEPLOY

> **This section is history. The served paper is not stale.** Re-measured after the 09:30 UTC deploy on
> 29 July 2026, every route below is byte-identical to the working tree:
>
> | route | on-disk bytes | served bytes | sha256 |
> |---|---|---|---|
> | `/paper` (typeset HTML) | 420,284 | 420,284 | identical |
> | `/paper/full` | 253,603 | 253,603 | identical |
> | parts 1–7 | 36,425 / 27,109 / 44,259 / 56,234 / 13,428 / 49,786 / 35,330 | same | identical, 7 of 7 |
> | `/changelog` | 46,248 | 46,248 | identical |
>
> Ten of ten served artifacts match. `gates/preflight.mjs` agrees independently, and the three stale
> markers this document was written to remove (`"All currently pass."`, `"None of the 333"`,
> `"a further five"`) are absent from the served copy as well as from disk.
>
> The table immediately below is the pre-deploy measurement, kept as the record of what was true when
> this was written. **Its "stale" verdicts no longer hold, and none of its byte counts is current.**

The brief for this work assumed the PDF was more exposed than the served paper. It is not. A read-only
`GET` of the deployed service shows the corrections are absent from every paper route it serves:

| route | bytes | verdict |
|---|---|---|
| `/paper` | 419,108 | **stale** — carries all three stale markers, none of the corrected ones |
| `/paper/full` | 252,128 | **stale** — same |
| part 1 | 36,261 | **stale** — "a further five", "None of the 333 fails" |
| part 4 | 55,888 | **stale** — "a further five", "All currently pass." |
| part 7 | 35,027 | **stale** — lacks "381 of the 386", which the current part 7 carries |

The served HTML is 419,108 bytes against the corrected 420,284 on disk. `/build` still reports
`q1-e1fa99d08887d6cc`, so the engine is the build the paper describes — only the assets are behind.
The repository is correct and pushed; the deployment simply predates the corrections.

**This divergence is already declared, not undetected.** `gates/preflight.mjs` measures it on every
run and passes *because* it is accounted for: it reports that three of the seven parts differ from
live in their paper text, that each difference is declared by content hash, and that each is covered
by a changelog entry the current deployment has not published yet. That is the state the gate expects
immediately before a deploy. The finding here is not that something slipped past a check — it is that
the deploy which resolves it has not happened, so a judge reading the typeset paper today still gets
the old numbers.

**This was not fixed here, deliberately.** Closing it needs a deploy, and deploying is outside the
scope of this task and off-limits during judging. It is Tristan's call.

**It was Tristan's call and he made it.** The deploy went out at roughly 09:30 UTC the same day,
43 minutes after this paragraph was committed, and shipped exactly the thing it declined to fix. The
paragraph was correct about its own scope and wrong about the world within the hour — which is the
whole shape this document's superseded banner is about: a sentence describing an external state that
no check reads goes false silently, and the document that wrote it is the last to know.

---

## 7. Every other artifact derived from the paper

Whole-tree sweep for the stale and corrected markers — 47 files matched, classified below rather than
counted.

**Current, nothing to do.** The source of truth `assets/whitepaper.html`, its byte-identical copies at
`paper/quiver-whitepaper.html` and in the published repository, the generated `whitepaper.md` and the
seven `whitepaper.part*.md` files, and `assets/landing.html`. The repository mirror is fully synced —
the corrected paper is committed and pushed. The prose documents that quote the suite figures
(`QUIVER_SUBMISSION.md`, `veritape/README.md`, `X_THREAD_UPDATE.md`) all already say 386 / 381 / 5 / 0
and are current despite pre-correction file dates.

**Regenerated by this work.** `paper/Quiver-Technical-Documentation.pdf`.

**Needs a human. ~~Needed~~ — done.** The Google Drive copy was re-uploaded; verified by `HEAD` at
935,830 bytes. See §8.

**Needs a deploy. ~~Needs~~ — deployed.** The live service's paper routes are byte-identical to the
tree. See §6.

**Deliberately frozen, leave alone.** These are snapshots whose value is that they record what was
true when taken, and `tools/docs-consistency.mjs` already excludes them by name:

| path | date | era it froze |
|---|---|---|
| `judging/quiver-whitepaper.html`, `judging/Quiver/assets/whitepaper.html` | 27 Jul | 298-test judging round |
| `sentinel/vendor/quiver/assets/whitepaper.html` | 23 Jul | 232-test buyer QA |
| `sentinel/recon/body_paper` | 21 Jul | captured HTTP body |
| `.playwright-mcp/page-2026-07-27T20-05-21-959Z.yml` | 27 Jul | browser capture of the live page |

**Scratch, not published.** `paper/_plain.txt` (stale), `paper/_pdftext.txt`, `paper/_pdftext2.txt`,
`paper/_pdfstreams.txt` — working files from an earlier extraction session. `paper/paper.md` is not
paper-derived at all despite the name; it is an unrelated video transcript.

**Outside `hackathon/`.** Twelve further whitepaper copies live in sibling experiment worktrees
(`underclaim*`, `deepclaim`, `trustless`, `ctxtest`). All stale, none published, none in any judge's
path.

**No rasterised page images of the paper exist on disk**, so there is no image cache to invalidate.
The four paper figures under `veritape/paper/figures/` are SVG plots and carry no test counts, so the
corrections do not touch them.

---

## 8. What Tristan has to do himself

**Re-upload the PDF to Drive.** The submission form and the GitHub README both point at
`drive.google.com/file/d/1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW`. Replacing it via *Manage versions* keeps
that link resolving. This cannot be automated from here and should not be.

> **DONE, AND THE TWO SENTENCES BELOW WERE BOTH FALSE.** Tristan replaced the file through *Manage
> versions*. Re-measured 10:38 UTC, 29 July 2026, unauthenticated, no credentials, one command:
>
> ```
> curl -sIL "https://drive.google.com/uc?export=download&id=1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW"
> ```
>
> `HTTP 200` · `Content-Length: 935830` · `Last-Modified: Wed, 29 Jul 2026 09:50:35 GMT` ·
> `Content-Disposition: attachment; filename="Quiver — Verifiable Financial and Security Primitives
> for the Agentic Economy.pdf"`
>
> **935,830 bytes is exactly the current on-disk render** — the "after" figure in §3 of this very
> document — and the upload timestamp is 20 minutes after the render. The link serves this document.
>
> **Stated precisely, because the point of this page is not overclaiming twice in a row:** what was
> verified is the byte count, the filename and the upload time. The sha256 was *not* verified, because
> that needs a download rather than a `HEAD`. A size collision with the previous 935,265-byte render is
> not possible — they differ — but "same length as the current render, uploaded after it" is strong
> evidence rather than proof of identity. Anyone wanting proof should download it and compare against
> `8b45e027…83451f`.

The Drive copy is behind by more than these two corrections. `QUIVER_MISSION_CONTROL.md` records the
last **confirmed** upload on 21 July, verified byte-identical on 23 July at a sha256 that matches no
file now on disk. Every re-render since — and there have been many, the PDF growing from 667 KB to
936 KB — carries an unresolved "NEEDS Drive re-upload" note. Whatever that link currently serves, it is
not this document.

Not verifiable from here: what the Drive link actually holds right now. The record says it is old; the
file itself was not fetched.

**Why that second sentence is the more serious error of the two.** "Not verifiable from here" was not
a measurement; it was an assumption that closed the question, and the false claim above it is what the
assumption produced. The file *was* fetchable, by an anonymous `HEAD`, in under a second, with no
credentials — the same class of check this project performs against its own endpoint dozens of times a
day. Deciding a fact is unmeasurable is itself a claim, and it is the one claim that guarantees nobody
will go and look.

---

## 9. Gates

Run after the re-render, from `veritape/`:

| gate | result |
|---|---|
| `npm test` | `tests 386` = `pass 381` + `skipped 5`, `fail 0` |
| `node gates/preflight.mjs` | 21 of 21 |
| `node tools/docs-consistency.mjs` | CONSISTENT |

`src/engine/` was not touched and the build hash is unchanged at `q1-e1fa99d08887d6cc`. Nothing was
deployed.
