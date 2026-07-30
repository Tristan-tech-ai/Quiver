# A gate whose write-up nobody checked: five wrong figures behind a green tree

**Written 30 July 2026.** Everything below was measured in this session, from `git ls-tree`, from
`zk/build/adversary-repro.json`, and from runs of `gate:z` on this machine. No figure is restated from a
prior document; where a prior document's number is quoted it is labelled as theirs and set beside the
one measured today.

The brief reported three figures in `docs/fix-reproducible-artifacts.md` as wrong. Reproducing them found
six, and all six are one defect: **a number that lives only in prose, with nothing in the repository able to
contradict it.** `gate:z` had 62 assertions about circuits and zero about the document that reports it.

---

## 1. What was reproduced, and what the reproduction found

| # | reported | reproduced? | measured |
|---|---|---|---|
| 1 | the artifact records 62 passing rows against a published **61** | **yes, exactly** | `adversary-repro.json` from a full run holds 64 rows: **62 pass, 0 fail, 2 skipped**. §6 published 61 |
| 2 | the size table is low by **145 bytes in three places** | **yes, exactly** | the write-up's own row, the text subtotal and the grand total were each 145 low: 35,251 / 576,098 / 5,377,786 against 35,396 / 576,243 / 5,377,931 |
| 3 | repo growth is **+2.70% / +0.29%**, not the published 0.706% / 0.076% | **yes, and the published pair is not wrong — it is a different ratio** | different denominator, named in §4 below |
| 4 | *not reported* | found | the `zk/scripts/adversary/` row said **286,480** bytes; the tree has held 288,398 → 289,583 → **290,429** and never 286,480. The table's own total used 290,429, so the table contradicted itself |
| 5 | *not reported* | found | "the largest is `circuits/adv/ctl.circom` at **21,376** bytes". That file is **21,385** bytes in every commit it appears in, and has never been 21,376 in this repository |
| 6 | *not reported* | found | §9's clone-test row published "**61 of 61 pass**" — the same miscount written down a second place |

Reproducing 1 needed a full `gate:z` run with a local 2^13 present, because section 4 of `repro.mjs` is
skipped without one and section 4 is where the seventh row lives:

```
node zk/scripts/adversary/ptau.mjs make 13     # 44.8 s, offline, 9,438,657 bytes
npm run gate:z
```

```
  13           7 pass    0 fail          tool         1 pass    0 fail
  src          2 pass    0 fail          opt          1 pass    0 fail
  ptau         2 pass    0 fail          pg          25 pass    0 fail
  plonk       16 pass    0 fail          bytes        8 pass    0 fail
```

7 + 1 + 2 + 1 + 2 + 25 + 16 + 8 = **62**, and 55 of those are the sections that do not need a ceremony
file bigger than the committed 2^12 — which is why §6's *other* figure, 55, was right.

**The arithmetic that produced 61 is not a typo.** Section 4 contributes seven passing rows. The seventh
is `price40b .r1cs sha256 matches the pin`, and it was counted in the sentence's *other* tally — "9
byte-identity pins", where it is correct, being the ninth of nine. One row, classified twice and totalled
once. The two figures in that sentence were each individually right and their sum was one short.

---

## 2. The 145 bytes: a measurement that includes its own output

The write-up's size table listed six paths and totalled them. One of the six was the write-up.

| | published | measured at `5ca5137` | low by |
|---|---|---|---|
| `docs/fix-reproducible-artifacts.md` row | 35,251 | 35,396 | **145** |
| text subtotal | 576,098 | 576,243 | **145** |
| grand total | 5,377,786 | 5,377,931 | **145** |

145 bytes is the length of the edit that published the numbers. The sequence is visible in the history:
at `21857b6` the file was 35,251 bytes; the next commit — `5ca5137`, "the size table is read out of
`git ls-tree`, not off the working tree" — wrote 35,251 into the table, and that write made the file
35,396. The commit that fixed the *method* reintroduced the *number*, because the number was about the
file the commit was editing.

The other three subtotals in the same table were correct, and the sum proves the mechanism rather than
carelessness: 245,992 + 290,429 + 2,138 + 2,288 = **540,847**, and 540,847 + 35,251 = 576,098 exactly.
The author summed the rows correctly and the row for this file was stale before the addition was done.

### The honest resolutions, and why the one taken is the one taken

**Taken: measure the set with the write-up excluded, and name the exclusion.** §3 of the write-up now
counts four groups and no write-up, and `npm run gate:z2` recomputes every figure from `git ls-tree` at
HEAD and goes red on a disagreement.

The reason is not that a self-including figure is impossible. It is *reachable*: replacing a six-digit
number with another six-digit number is byte-neutral, so writing 35,396 where 35,251 stood would have
been stable immediately. The reason to reject it is that **the fixed point must be re-solved on every
later edit to the document, forever, and no gate can assist** — a checker would have to know the file's
size *after* the edit that publishes it, which is not a quantity any checker can obtain. So the figure
would return to living in prose, unfalsifiable from inside the tree, which is the condition that
produced all six defects in the table above.

**Rejected: measure the whole set, write-up included, at a named commit.** The fixed point genuinely
dissolves — a past commit is immutable, so `5ca5137`'s copy is 35,396 bytes forever. Two objections.

- It answers a question nobody asked, and it decays while staying arithmetically true. Measured today:
  between `5ca5137` and HEAD, `zk/circuits/adv/` gained `ncdfonesided.circom` (+21,759 bytes) which
  belongs to the options-risk work, and `zk/scripts/adversary/` gained the module that performs this
  check. A figure pinned to `5ca5137` would verify and would describe none of that.
- It cannot be landed in one commit. Stating the figure *as of the commit that states it* requires the
  commit's contents before the commit exists, so it needs an amend — which this project forbids for
  commits you did not create, having orphaned a circuit that way — or two commits, the first publishing
  a number wrong by construction.

**Rejected: publish it as prose, "as of commit X".** Same decay, minus the only property that makes a
number here trustworthy: a prose qualifier is unreachable by a gate, because the gate would have to be
re-aimed at a new commit by hand. That is the shape the "61" had — plausible, unqualified, and
uncheckable.

One asymmetry, named because it looks like the second option smuggled back in: the *growth denominator*
is a named commit, `620c041^`. Growth is a difference between two states, so one term is necessarily a
past event, and that is what a commit hash is for. The numerator is measured at HEAD; only the thing it
is compared against is frozen, and it is frozen because it is history.

### Why the set is defined by `MANIFEST.json`, not by a directory

A glob over `zk/circuits/adv/` would drift for reasons unrelated to these refutations — five commits from other sessions
landed on HEAD while this was being written, one of them adding a circuit to that directory. `MANIFEST.json` enumerates
exactly the circuits and probes the reproduction pins, so the set is defined by the work. Measured, the
manifest-defined set is byte-identical at `5ca5137` and at every later HEAD checked: 245,992 bytes in 37
circuits, both then and now.

A latent trap found while doing this and **not** fixed here: `repro.mjs --write-manifest` walks
`zk/circuits/adv/` and would now absorb `ncdfonesided.circom` into the pinned set, widening the
reproduction to a circuit no probe here covers. The manifest was therefore updated key-by-key for the two
files this session changed, not regenerated.

---

## 3. The row that contradicted its own total, and the size that never existed

`zk/scripts/adversary/` was published as **286,480** bytes across 49 files. Measured from `git ls-tree`
at every commit that directory has:

| commit | bytes |
|---|---|
| `620c041` | 288,398 |
| `ac18088` | 289,583 |
| `1761b7d` … `5ca5137` … HEAD | 290,429 |

286,480 is not a value the repository has ever held. It is a working-tree reading taken before the last
edits of the commit that published it — and the same table's total used 290,429, so the row disagreed
with the sum beneath it. This is the defect the `stale-row` revert now reproduces.

`ctl.circom` was published at **21,376** bytes. It is 21,385 in `620c041`, the only commit that touches
it, and 21,385 on disk in both trees today, with no CRLF pairs in it. The nine bytes are not a line-ending
artifact and 21,376 is not recoverable from anything in the repository. Also worth stating: the largest
`.circom` under `zk/circuits/adv/` today is `ncdfonesided.circom` at 21,759 bytes, so "the largest source
file committed" was becoming false for a second reason. The claim is now scoped to the pinned set.

---

## 4. The growth figures, recomputed from `git ls-tree`

The published pair, **0.706% / 0.076%**, is arithmetically correct and answers a different question from
the one its sentence appeared to ask. Both denominators, measured:

| denominator | what it is | measured |
|---|---|---|
| 199,061,444 B in 654 files | the repository at `620c041^`, the commit before this work | `git ls-tree -r -l` summed |
| 762,139,277 B (726.8 MiB) | the derived binaries the four adversaries produced and this repository does not carry | §2's own class table, which sums exactly to it |

Two numerators, and the distinction matters because one of them is the set the brief was reporting on and
the other is the set as it stands after this fix added two gates to it:

| numerator | repo growth (incl. / excl. ceremony) | share of the derived binaries |
|---|---|---|
| **5,377,931 B / 576,243 B** — the set as the write-up defined it, its own bytes included | **2.70% / 0.29%** | 0.706% / 0.076% |
| **5,385,805 B / 584,117 B** — the set as committed now, write-up excluded, two new gates in | **2.71% / 0.29%** | 0.707% / 0.077% |

So **the reported +2.70% / +0.29% is confirmed exactly** for the set the report was about, and the
published 0.706% / 0.076% was **measured against a different baseline** — the discarded artifacts, not
the repository. The shipped sentence read "the repository grows by **0.706%** of what the refutations
produced", which is true if the trailing clause is read as the denominator and false as it will be read.
Both ratios are now stated with their denominators attached in their own sentences, and both are
asserted; near-four-times is too large a gap to leave to a reader's parse.

Worth noticing in that table: this fix's own two gates moved the *third* decimal of the derived-binaries
share, 0.706% → 0.707%. That is the drift the gate now catches, and it caught it during this session —
the figure was written as 0.706% four times while the gate files were still being edited, and went red
each time until it was recomputed.

---

## 5. What can now go red

Two gates, four commands, ten reverts.

```
npm run gate:z              # the reproduction, plus §5: the published counts against this run
npm run gate:z-revert       # 5 modes + a baseline run, ~18 min
npm run gate:z2             # the published figures against git ls-tree, seconds
npm run gate:z2-revert      # 5 modes + a baseline run, seconds
```

**`gate:z` itself now fails on a row count that disagrees with its own artifact.** Section 5 of
`repro.mjs` compares the published figures against the counts of *the run in progress* — not against
`adversary-repro.json` on disk, because a stale artifact agreeing with a stale document is exactly the
state this is meant to detect. `ADV_REPRO_REVERT=row-count` reports one fewer passing row than the run
produced, and the gate goes red.

Two design points, both of which are the §2 argument applied again:

- **Section 5's own comparisons are not among the 62.** An assertion about how many rows there are must
  not be one of the rows it counts. Adding it as a row would have moved the published figure from 62 to
  63 and made the check self-referential — the same fixed point as a document recording its own size.
- **`adversary-repro-counts.json` is committed and carries no timestamp and no path.** The full artifact
  does carry both, so committing *that* would produce a diff on every run and be reverted within a week.
  The summary is byte-stable, so an unchanged run leaves the tree clean. A partial run — no local 2^13,
  therefore no section 4 — refuses to overwrite it, because replacing a complete record with an
  incomplete one would silently turn `gate:z2`'s 62-row assertion into a skip. A run whose own assertions
  failed refuses too.

`gate:z2` is separate from `gate:z` and deliberately cheap. `gate:z` needs `circom`, a 4.58 MiB ceremony
file, two `node_modules` trees and three minutes; those are the right requirements for rebuilding Groth16
and Plonk artifacts and the wrong ones for asking whether a number in a markdown table matches
`git ls-tree`. It asserts, for **both** published copies of the write-up — the mirror's
`docs/fix-reproducible-artifacts.md` and the submission's `FIX_REPRODUCIBLE_ARTIFACTS.md`, because the
stale copy has historically survived in the second — 24 things in total: the three counts, four table
rows, the total-is-the-sum-of-its-rows identity, the write-up's exclusion, both growth pairs, that no
measured file differs from the tree being measured, and that all 92 measured files also exist in the dev
tree byte-identical to their blobs.

Neither revert harness will now claim anything about a gate that was not green first. Both run the
unmodified gate before breaking it and exit without a verdict if it comes back red — five lines saying
"the gate went red as required" prove nothing when the gate was already red, and that is a failure mode
this repository has the shape to produce.

### The five `gate:z2` reverts, and the defect each one is

| mode | the defect it puts back |
|---|---|
| `row-count` | publish one fewer passing row than the artifact holds — defect 1 |
| `self-include` | put the write-up back into the set it measures — defect 2, the 145 bytes |
| `stale-row` | read the table off the tree at `620c041` instead of HEAD — defect 4, a figure measured at the wrong moment |
| `derived-denominator` | divide the growth by the repository instead of by the binaries left out — defect 3 |
| `mirror-drop` | drop one measured file from the dev tree — the discipline that has failed twice here |

`mirror-drop` earns its place: twice in this project a module was written into one tree, its importer
committed, and the module never copied, once leaving a HEAD that could not start. It compares bytes
against the blob rather than grepping for the import, which is what produced eight false positives the
last time that check was attempted.

---

## 6. Scope, and what was deliberately not touched

- `src/engine/` is untouched; the engine build id did not move. Verified by diffing the whole directory
  against HEAD, not by intending to.
- No `contentHash` moved and no response shape changed. `gate:v` (a response reproduces its own printed
  recipe) is green; Appendix C reproduces unchanged.
- `assets/whitepaper*` untouched. `npm test` is unchanged at 386; the two new gates are `gates/` entries
  with `npm run` aliases and are not in the suite.
- Nothing was deployed.
- `package.json` in the mirror was missing `gate:lb` / `gate:lb-revert` before this session and still is:
  `gates/gateLB-lp-boundedness.mjs` and `gates/gateLB-revert.mjs` are committed, but the aliases exist
  only in the dev tree, so `npm run gate:lb` fails in a clone. That belongs to another session's work and
  was left alone rather than folded into this commit.
