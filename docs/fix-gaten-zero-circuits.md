# `gate:n` passed 19 of 19 over a row it had no way to read

**30 July 2026.** `docs/known-defects.md` §13 published a count of what is **committed** to the published
repository. Every source `gateN-known-defects.mjs` consulted was a **working tree**. Committedness had no
representation anywhere in the gate's corpus, so the row was checked against nothing, was wrong twice, and
nineteen green rows had nothing to say about it.

The engine was not touched. `src/engine/` is byte-identical to HEAD and `buildId()` still returns
`q1-e1fa99d08887d6cc`, computed rather than quoted.

---

## 1. What was reproduced first, and how the brief's own numbers were already stale

The brief said §13 stated `present in the published repository: 0`, and that `git ls-files zk/circuits`
returns 59 paths with 37 under `adv/`. **Neither figure was current.** Measured before anything was
changed:

| measured | command | answer |
| --- | --- | --- |
| circuits tracked at HEAD | `git ls-tree -r --name-only HEAD zk/circuits` | **60** |
| of those, under `adv/` | same, `zk/circuits/adv` | **38** |
| the index agrees with HEAD | `diff` of `ls-tree HEAD` against `ls-files` | identical, no staged-only path |
| `.circom` on disk in `zk/circuits/adv` | `ls` | **38**, and the same 38 names |
| of those, with a compiled `.r1cs` | `existsSync(zk/build/<name>.r1cs)` | **0** |
| of those, with a Plonk zkey | `existsSync(zk/build/<name>_plonk.zkey)` | **0** |

The row on the page said neither `0` nor `59/37`. It said **`37 of 38`**, and quoted `59 paths … 37 under
adv/`. So there were three numbers in play — the brief's, the page's, and the repository's — and only the
third was real.

**The history is the interesting part.** `git log` on the file gives the whole sequence:

- Commit `620c041` committed the adversary rescue. The row still said `**0** — git ls-files zk/circuits
  returns 22 paths and none is under adv/`. True when written, stale from that commit on.
- Commit `ea69ea3` corrected it to `37 of 38` — **and added the 38th file, `adv/ncdfonesided.circom`, in
  the same commit.** `git show --stat ea69ea3 -- zk/circuits` confirms it. The count was measured before the
  file was staged, so it was false the instant it landed.

That second version is worse than the first, and it says so itself: two sentences after the count, the same
cell states that `ncdfonesided.circom` was *"added 30 July and committed with the change that made it
necessary."* **A cell that contradicts its own count in its own second sentence is not a transcription
slip.** It is a measurement taken against the working tree and published as a fact about the repository —
which is exactly what the gate beneath it was also doing.

Both errors understated what was published. That direction matters: the working tree always holds at least
what HEAD holds, so **a disk-based reader can never notice that HEAD has caught up.** It is structurally the
one direction a working-tree check is blind to.

---

## 2. Why `gate:n` could not see it — the third hypothesis, sharpened

The brief offered three: the row is outside the corpus, the rule does not match the phrasing, or the rule
compares the claim against something derived from the same stale place. **The answer is the third, and it is
stronger than "the rule was missing".**

`grep -niE "git|execSync|spawnSync|child_process|ls-files|ls-tree"` over
`gates/gateN-known-defects.mjs` before this change returned **three hits, none of them a git invocation**:
two prose comments and one `if (e === '.git') continue` inside a directory walk that skips it. The gate's
entire corpus was:

1. the register's own text,
2. the **working-tree** filesystem — `readdirSync`, `statSync`, `existsSync`, `readFileSync` over
   `zk/build`, `zk/circuits`, `zk/scripts`, `src/`,
3. engine and service modules, imported and run.

The gate's own header explains, at length and correctly, why it resolves `ZK` to the working tree rather
than the mirror: *"THE WORKING TREE WINS WHERE BOTH EXIST, and that is a decision rather than an
accident."* That decision is right for every other row. It is precisely wrong for one row, and nothing
connected the two facts.

**This is the `gateB6` shape, one step subtler.** `gateB6` recorded *"the contract picks the right leg"*
while ranking on the wrong quantity — it compared a claim against a source that could only agree with it.
Here, §13's table has two adjacent cells:

- `adversary circuit sources rescued … into zk/circuits/adv/ | 38 files` — checked, against
  `readdirSync(adv).length`. Correct, and it *can* fail.
- `of those, present in the published repository | 37 of 38` — **not checked at all**, because the only
  filesystem the gate could reach is the one that agrees with the first cell by construction and knows
  nothing about the second.

So the gate held the disk claim and silently dropped the git claim sitting next to it in the same table. Not
a missing rule so much as a **corpus that could not express the quantity the row published**. That is why
the answer matters more than the number: any row on this page that is about the repository rather than about
the tree was in the same position.

### The premise itself did not hold: `gate:n` was **not** 19 of 19

Run before any edit: **17 pass, 2 fail.**

```
not ok 4 - §4 every circuit a caller can obtain a proof of is one §4 names …
    AssertionError: ncdf is on the paid path and §4 does not name it
not ok 16 - §10 every row of the wiring table says what the prover says
    AssertionError: ncdf IS wired into the prover and §10's table says "no" — the entry must be updated
```

`src/util/proverWorker.mjs` is byte-identical to HEAD and wires **six** circuits, not four:
`concentration, execadverse, kelly, liquidation, lpbracket, ncdf`. `ncdf` was wired in `be0d4c9`; §10's row
said `no` through both later edits of the register (`ea69ea3`, `3c73436`), each of which corrected *other
rows of the same table*. The §10 test predates the wiring, so the gate was red on that row the entire time.

**This is its own finding, and it is a bad one.** `gateN-revert.mjs` — the harness that proves this gate can
fail — exits `1` at baseline when `gate:n` is already red, by design:

> `Every mutation below would appear to work while measuring nothing. Fix the gate first.`

So from `be0d4c9` onward, **the revert harness could not run at all**. The mechanism this project uses to
prove its verifiers have teeth was inert, and the reason was a stale row nobody looked at. A red gate nobody
runs costs what a green gate that cannot fail costs. Closing those two rows was a precondition for
demonstrating anything below, so both were fixed and both are measured, not restated.

---

## 3. The published figure, corrected — as three quantities, because one was wrong in every reading

*Committed*, *compiled*, and *has a proving key* are three different states. §13 published one number for
all three, and there is no single value of that number that is honest. The table now reads:

| | |
| --- | --- |
| sources rescued into `zk/circuits/adv/` | **38 files** |
| of those, **committed** to the published repository | **38 of 38** — `git ls-tree -r --name-only HEAD zk/circuits` returns **60** paths, **38** under `adv/`, same names as on disk |
| of those, with a compiled `.r1cs` anywhere under `zk/build` | **1 of 38** — `ncdfonesided`, at `zk/build/adv/ncdfadv/ncdfonesided.r1cs` |
| Plonk zkeys for any of them | **0 of 38** |

The distinction is the honest answer to the section's own question. **The sources are in the repository; one
of the 38 has been compiled and none has a proving key**, so no reader can re-derive the four refutations
from what is published — which is the defect §13 is about, and is *not* the same sentence as "the sources are
lost". The single compiled `.r1cs` is itself uncommitted.

### That "1" was a "0" in the first version of this fix, and the cause was mine

The compiled row was first published as **0 of 38**, and the rule behind it was:

```js
… .filter((c) => existsSync(join(BUILD, `${c}.r1cs`)))     // flat. wrong.
```

`find zk/build -name '*.r1cs'` returns **22** paths, and one of them is
`zk/build/adv/ncdfadv/ncdfonesided.r1cs` — three directories below where every other circuit's artifact
lands. A flat `existsSync` cannot see it, so a search that did not recurse produced an absence and the
absence was published as a fact. **This is the same error as the row it was fixing**, one level down: a
measurement taken with the wrong instrument and reported as a property of the world. It was caught by
searching properly before the batch closed, not by the gate.

Two rules were repaired, not one. `zk/build` is now indexed **recursively, once**, and asked by basename;
the pre-existing zkey check in the original §13 test had the identical flat hole and now asks at every depth
for `_plonk.zkey`, `.zkey` and `_final.zkey`. Its answer is unchanged — `0 of 38`, now measured rather than
assumed. The compiled rule additionally requires the page to **name** every circuit it counts, so the figure
cannot drift without the reader being told which file moved it, and revert mutation 11 puts the `0` back and
requires the gate to name `ncdfonesided` rather than merely disagree with the count.

Both prior versions of the row are quoted on the page rather than deleted, with the `ea69ea3` diagnosis.

### The half a count could never catch

The row had already been corrected once. Two paragraphs below it, the prose had not:

> "So the sources survived the session that produced them and are still not in a repository. They sit in a
> working tree that is **not under version control at all** — the git checkout is the published mirror, and
> `zk/circuits/adv/` is not in it"

That is flatly false, and it sat on the same screen as `37 of 38`. **A rule that compares only numbers
passes this**: the number was right. This is the one-sided-edit failure §1 of the register is about, and it
now has a rule of its own — if any adversary source is committed at HEAD, those three sentences must not be
on the page.

---

## 4. The gate, and the proof it can fail

Four rules added to `gates/gateN-known-defects.mjs` (23 tests, all green). `git` is now asked, `HEAD` is the
authority, and the answer is guarded against vacuity — a `git` that errors, or a repository reporting zero
tracked circuits, **throws** rather than passing, because an empty list would make every assertion pass.
`ls-tree HEAD` rather than `ls-files`: the index is not what a reviewer clones, and a circuit surviving only
in an index has already happened here once.

| test | holds | fails when |
| --- | --- | --- |
| §13 the published-repository row is git at HEAD, not a directory listing | both figures; the `N of M` ratio with git as numerator and disk as denominator; set equality by **name**, not only by count; the three stale prose sentences absent; the compiled count published separately | any figure drifts, a name appears on one side only, or the prose is reverted under a correct row |
| §8 the artifacts the clone is missing are missing from HEAD, not merely from a directory listing | the mirror's `readdirSync` answer equals its `ls-tree HEAD` answer, and both equal `['liquidation']` | an artifact is written into the mirror and not committed |
| ★ the index table does not report a live defect as fixed | every section has an index row; an index row may not say *fixed* where the section says OPEN with no FIXED half | the top-of-page copy of a status drifts from the section's own |
| ★ §10's index row states the number of circuits actually left unwired | the count read **from the prover** | the last circuit is wired, or the row rots as `ncdf`'s did |

Counts are compared by **name as well as by number** because two counts can agree while the sets differ: a
file committed and a different file added on disk in the same round nets to zero and hides both. That is
close to what `ea69ea3` actually did.

### `npm run gate:n-revert` — 11 mutations, verbatim

Five are new. Mutation 7 is the one the brief asked for: **the `0` goes back, and `gate:n` goes red naming
it**, while `docs-consistency` stays silent — it cannot read git either. The run below is complete and
unedited except that `docs-consistency`'s two long finding lines under mutation 6 are elided.

```
GATE N REVERT — 2026-07-30T07:55:29.338Z
  register copies under test: hackathon/KNOWN_DEFECTS.md, Quiver/docs/known-defects.md

  baseline: gate N is green
  baseline: docs-consistency says nothing about the register

  [PASS] a deleted section makes gate N red, and docs-consistency does not notice
           gate N went RED (expected red) and named it
           docs-consistency about the register: nothing (expected silent)
  [PASS] a status line left OPEN over a defect that is now fixed makes gate N red
           gate N went RED (expected red) and named it
  [PASS] editing the private-input count makes gate N red
           gate N went RED (expected red) and named it
  [PASS] dropping the missing artifact from §8 makes gate N red
           gate N went RED (expected red) and named it
  [PASS] removing a gas citation makes gate N red, and docs-consistency does not notice
           gate N went RED (expected red) and named it
           docs-consistency about the register: nothing (expected silent)
  [PASS] misdirecting a gas citation is caught by docs-consistency, which gate N leaves to it
           gate N stayed green (expected green)
  [PASS] putting the published-circuit count back to zero makes gate N red, and docs-consistency does not notice
           gate N went RED (expected red) and named it
           docs-consistency about the register: nothing (expected silent)
  [PASS] reverting the prose under a corrected row makes gate N red
           gate N went RED (expected red) and named it
  [PASS] putting §10's index row back to its stale count makes gate N red
           gate N went RED (expected red) and named it
  [PASS] an uncommitted artifact in the mirror makes gate N red rather than green
           gate N went RED (expected red) and named it
  [PASS] putting the compiled count back to zero makes gate N red and names the circuit
           gate N went RED (expected red) and named it

  [PASS] every copy of the register is byte-identical to how it started
  [PASS] the ghost artifact is gone from Quiver/zk/build/liquidation.r1cs

GATE N REVERT: PASSED — 13 mutations, each one red where it should be
```

And the assertion mutation 7 produces, verbatim, with the `0` back in place:

```
✖ §13 the published-repository row is git at HEAD, not a directory listing
  AssertionError [ERR_ASSERTION]: HEAD tracks 60 paths under zk/circuits and 38 of them
  are under adv/; §13's row does not state those two figures
exit status: 1
```

Mutation 10 is a **file** mutation rather than a text one, because no edit to the page can demonstrate the
disk-versus-HEAD hazard: a `liquidation.r1cs` is written into `Quiver/zk/build` and not committed. The
original §8 test reads that directory with `readdirSync` and would report the clone complete; the new test
asks HEAD and goes red. It is removed in the same `finally`, cleared again at the next startup if a run
crashes, and its absence is asserted at the end.

The revert also gained `mutateLine()`, which addresses a row by its stable left-hand cell and replaces the
whole line, so measured figures never get copied into the revert script — otherwise adding a circuit would
make `mutate()` throw *"the register has moved"* about a page that had not moved.

---

## 5. The sweep: every other row whose rule reads the same stale source

Not a spot-check. The register was grepped for every claim about repository, clone, mirror, or committed
state — `git ls-files|git ls-tree|committed|not in it|version control|published repository|published
mirror|a clone|fresh clone|uncommitted|in the repository` — and each hit was traced to the rule that checks
it and to the source that rule reads.

**One other row, and it is the same defect exactly.**

`§8` (register line ~774): *"`zk/build` in the working tree holds 21 `.r1cs`; the published mirror holds 20,
and the missing one is `liquidation`."* The consequence drawn is about **a clone** — *"for the flagship
circuit the artifacts to do that are not in the clone."* The rule that checked it,
`§8 the five liquidation artifacts the clone needs are still absent from it`, computed its answer with:

```js
const there = readdirSync(mirror).filter((f) => f.endsWith('.r1cs'))…
```

**A clone gets HEAD, not a directory listing.** An artifact written into the mirror and never committed is
present to `readdirSync` and absent from every clone — which is the failure that shipped a `services.js`
importing a module that was never copied, one directory over, on 29 July. This is a **latent unsoundness,
not a live wrong number**: measured now, the two answers agree.

| measured in `Quiver/zk/build` | answer |
| --- | --- |
| `.r1cs` on disk | **20** |
| `.r1cs` at HEAD | **20** |
| tracked at HEAD, missing from disk | **none** |
| on disk, untracked | **one**, `probe-execadverse-marginal.json` — not an artifact any gate needs |

So the row was right, by luck rather than by any rule. It now has one: the disk answer and the HEAD answer
must agree, and both must equal `['liquidation']`. Mutation 10 shows it failing.

**A second finding, of a different shape: thirteen rows checked by nothing.** Every status on the page
exists twice — the index table at the top, and each section's own `**Status:**` line — and until this change
**only the second copy was ever read.** `SECTIONS` is built from `## N.` headings; the index is a table
above §1 and no rule touched it. That is how the §10 index row sat at `open for 3 of 4` while three of the
four were wired. Two rules now cover it, and the wording of the general one is deliberately one-directional:
it fires when the index calls a section *fixed* while the section says OPEN with no FIXED half. §2's status
line contains neither word and §8's contains both, and a two-sided rule those two must satisfy would mean
rewriting disclosure prose to suit a checker.

**Reported rather than asserted**, because fixing them would be scope creep or would degrade the page:

- **`isOpen(2)` silently reads §2 as not-open.** Its status line — *"the envelopes are honest; the summary
  copy is not. Copy fix pending."* — contains neither *open* nor *fixed*, so `/\bopen\b/` is false. There is
  no §2 test, so nothing currently depends on it; the next §2 test written will quietly not run.
- **`gateN`'s own header quoted a stale figure, and correcting it twice demonstrated why.** It said
  `docs-consistency.mjs` reads *229 documents*. Within a few hours of 30 July the live count read **229**,
  then **255**, then **257** once this document and its twin were added, then **259** when two sibling
  sessions committed their own write-ups. Every figure written into that comment was stale before it could be
  read, including both of the ones written during this fix. **So the comment now gives no count at all** — it
  records the sequence, says why it is not pinned, and points at the tool that prints the live number. The
  register's closing paragraph carried the same 229 and now also gives no count. A number that moves with
  every commit does not belong in prose in a tree five sessions are writing to.
- **The ceremony question in §13 is unchanged and still Tristan's.** Compiling the 38 adversary sources
  needs `2^13` and `2^17` ceremony files, which is decision 2 in `phase-b-verified.md` §8. `0 of 38
  compiled` is therefore the honest figure and not a task left undone.

---

## 6. A clone of HEAD, measured before and after

The work has to be reachable from what a reviewer clones, so `git clone` from `github.com` (not from the
local mirror) into a scratch directory, `node_modules` junctioned in, and `gate:n` run inside it.

| | tests | pass | fail |
| --- | --- | --- | --- |
| clone of `db931a3`, the parent commit | 19 | 14 | 5 |
| clone of `b4eb6b0`, this change | 23 | **19** | 4 |

**All four new rules pass in the clone**, and §10 went from red to green there. The clone's own git answers
`60` paths and `38` under `adv/`, and its `zk/circuits/adv` holds the same 38 files — so the git-based rule
measures the clone rather than the working tree, which is the case it exists for.

**The four that still fail in a clone are the §8 defect, and they are the same four before and after:**

```
20 circuits are compiled; §4's table does not say so          (§4 states 21 — the working tree's count)
the prover serves liquidation and there is no liquidation.r1cs in this build to measure
vk_plonk.json is gone — §12 describes it
1 ceremony files are on disk; §13 says two
```

Every one traces to an artifact the published mirror does not carry. **Three of them are the artifacts §8
already names. The fourth is not**: §8 lists five missing files and `pot12_final.ptau` is not among them, so
its list is short by one — which is the shape of §8's *original* defect, a list too short to catch its own
subject. Measured: `zk/build/*.ptau` is two files in the working tree (`hez_final_12.ptau`,
`pot12_final.ptau`) and one in a clone.

That is left open and disclosed rather than fixed here. Extending §8's list is a one-line edit, but the
honest fix is deciding whether `gate:n` should be runnable from a clone at all — the gate's own header argues
it should measure the working tree because *"the register describes the running system"*, and a reviewer who
clones and runs `npm run gate:n` will get four reds that are all §8 and none of them theirs. That is a
judgement about what the gate is for, and it is on the list rather than taken.

---

## 7. Gates, before committing

| | |
| --- | --- |
| `npm test` | **386 tests, 0 fail**, 5 skipped — unchanged |
| `npm run gate:n` | **23 pass, 0 fail** (was 17 pass / 2 fail) |
| `npm run gate:n-revert` | **PASSED — 13 mutations**, each red where it should be |
| `node tools/docs-consistency.mjs` | `CONSISTENT` — over 259 documents at the final run; the count moves with every sibling commit and is not quoted as a fixed figure anywhere |
| `node gates/preflight.mjs` | `PREFLIGHT PASSED` |
| `node gates/gateV-recipe-reproduces.mjs` | **9 pass, 0 fail** |
| `src/engine/` | `git status` and `git diff HEAD` both empty over the whole directory; `buildId()` returns `q1-e1fa99d08887d6cc` |

Nothing was deployed. No response shape changed and no `contentHash` moved: **`src/` was not edited at
all.** The only files changed are `docs/known-defects.md` (with its `KNOWN_DEFECTS.md` twin),
`gates/gateN-known-defects.mjs`, `gates/gateN-revert.mjs`, and this document.
