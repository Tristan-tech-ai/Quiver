# Claims no check can falsify

**Date:** 29 July 2026 · **Build:** `q1-e1fa99d08887d6cc` (unchanged; nothing here touched `src/`,
`assets/`, `gates/`, `tools/`, `zk/` or `paper/`) · **Status:** report only. **Nothing found here was
fixed.** Every decision below is Tristan's.

This is not a staleness sweep. `tools/docs-consistency.mjs` walks 205 documents and
`gates/gateX-paper-contradiction.mjs` reads the paper; between them, a number that disagrees with a
measurable number goes red. Every rule in that tool reads its truth **from the system** — the engine's
build hash, the service list, the test declarations, the paper's own tables and references, the
deployment record on disk.

The class hunted here is the complement: **a claim whose referent no checker can read, so it cannot go
red no matter how false it becomes.**

The one that started it told a judge the live endpoint had not been touched since the deadline, while
two deploys had shipped. Every gate was green, because "we did not deploy" is measured by nothing. That
sentence and its twin in the deploy manifest are fixed and are not re-reported. Worse, the truncation
audit had recorded the contradiction hours earlier and it was read and not acted on — so this sweep
checks the *findings* documents against reality too, not only the claims documents. Two of the fourteen
false statements below are in findings documents whose own subject is unchecked claims.

**Six shapes.** Each entry names which it is.

| | shape | why nothing can read it |
|---|---|---|
| 1 | operational history | "has not been touched", "never ran", "nothing was spent". Nothing polls the past. |
| 2 | external systems | Drive, x.com, the status page, the MCP registry, the on-chain registry. Four of five **are** fetchable — that is a different and more actionable finding than "unmeasurable in principle". |
| 3 | process discipline | "proven able to fail", "measured rather than assumed", "verified by eye", "taken first and written down second". The project's core promises, all prose. |
| 4 | universal quantifiers | "every", "all", "none", "the only" — where nothing enumerates the set. |
| 5 | attribution of intent | "deliberately", "by design". Launders an omission into a decision after the fact. |
| 6 | dates, sequence, authorship | "written in commit X", "hours after the deploy", "ground-truthed on 27 July". |

**Cost** is scored 1–100 on one basis: a judge reads it, and being wrong makes the project look like it
does not know its own state. The README sentence that started this would have scored about 95.

---

# 1. False right now

Fourteen, ordered by cost. Each was measured; the measurement is given so it can be repeated. Every
finding is in both trees — `Quiver/docs/<name>.md` and `hackathon/<NAME>.md` are byte-identical
mirrors, verified with `diff`, so line numbers are the same in both.

---

## 1.1 — cost 90 · shape 1 + 5 · the page tells a judge to run a command and predicts the wrong answer

`Quiver/docs/known-defects.md:382` · `hackathon/KNOWN_DEFECTS.md:382`

> Either way, `{"side":"banana"}` still returns 91,139.24 on both builds. That half is genuinely still
> open and is not scheduled around judging: it needs `src/engine/` and a moved build hash.

**False three ways.** Measured against the live endpoint on the free MCP surface — the surface this
section's own reproduction command uses:

```
curl -s https://quiver-production-c3a8.up.railway.app/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"perp_gate",
       "arguments":{"side":"banana","entryPrice":100000,"size":1,"leverage":10,
                    "maxLeverage":40,"markPrice":100000}}}'
```

The live answer is `"ok": false` with an `unknownEnumValues` block naming the field, listing the
accepted values, and saying *"Nothing was computed and you were not charged"*. It does not return
91,139.24. It refuses.

1. The value is refused, not answered as a long.
2. It did not need `src/engine/` — the guard shipped in `src/util/repair.js`.
3. The build hash did not move: `/build` reads `q1-e1fa99d08887d6cc`, the hash this document quotes.

**Why it is the worst one.** The same file says the opposite 355 lines earlier, at
`known-defects.md:27`, where `side: "banana"` is described as **now refused**. A judge reading top to
bottom meets the correction first and the retraction of it second. Nothing compares a document to
itself.

**Make it measurable.** This defect register is the one document whose every assertion is a
live-endpoint prediction. A gate that lifts each `curl` and its expected answer out of the markdown and
replays it against the live service would have gone red the moment the deploy landed. Same construction
as `gates/preflight.mjs`, pointed at prose instead of at config.

---

## 1.2 — cost 88 · shape 1 · "no deploy has been performed" — two have

`Quiver/docs/known-defects.md:372` · `hackathon/KNOWN_DEFECTS.md:372`

> The §1 fix is in the repository and has **not been deployed** — no deploy has been performed
> since it landed, and the changelog entry for it is written ahead of the deploy exactly as this
> project's other entries are.

**False.** The same request with `"side":"SHORT"` returns `liquidationPrice 108641.98` — the branch
this page itself labels *"you reached a build carrying the fix"*. `src/services.js`, `src/mcp.js` and
`src/util/repair.js` are all inside Group 1 of the deploy manifest, whose banner says the live service
now carries it.

**Stated fairly:** the paragraph above says *"Which answer you get tells you which build you reached,
and both are correct outcomes of this page"*, and the two bullets below read correctly whichever answer
arrives. A careful judge is not misled about the *defect*. They are misled about whether this project
knows its own deployment state — which is exactly what the README paragraph was fixed for this morning.

**Make it measurable.** `gates/watchdog.mjs` already records each deploy. A rule that no published
document may say "no deploy has been performed" while the watchdog holds a record newer than that
document's date is a dozen lines, and it generalises to the whole of shape 1.

---

## 1.3 — cost 85 · shape 4 · Appendix C promises artifacts we cannot edit, then lists four we can

`Quiver/docs/checkable-artifacts.md:5` · `Quiver/assets/whitepaper.part7.md:125` ·
`Quiver/assets/whitepaper.md:1173` · and the served typeset paper

> Every row below lives outside it — on a public chain or a public endpoint — together with the command
> that checks it. **None requires our cooperation, and none can be edited by us after the fact.**

**False for every row of the "Off chain" block, 4 of 4.** Read the rows at
`checkable-artifacts.md:47–51`:

| row | what it actually points at |
|---|---|
| build identity | `/build` on `quiver-production-c3a8.up.railway.app` — **our own server**, which requires our cooperation to answer and which we rewrite on every deploy |
| research anchor | `../research/RESEARCH_ANCHOR.md` — a relative path **into this repository**, editable with one commit |
| buyer ledger | `../research/BUYER_LEDGER.csv` — likewise |
| availability record | the AWS Lambda, which `Quiver/assets/whitepaper.part4.md:271` itself describes as ours rather than a third party's |

Two of the four do not merely require our cooperation; they contradict the same sentence's opening
clause, because they live *inside* the repository the appendix is drawing a boundary against.

This is the highest-cost universal quantifier in the corpus because of where it sits: Appendix C is the
"check this without contacting the authors" table, in the paper, on the live endpoint. Its whole
function is to bound what a reader must take on trust, and its bounding sentence is wrong about half
its own contents. The on-chain rows above it are genuinely third-party and genuinely uneditable; the
sentence over-claims for the block that is not.

**Make it measurable.** The rows are a markdown table. Parse them, resolve each target, and fail any row
whose host is ours or whose path is repository-relative — then let the sentence quantify over a set that
has actually been enumerated.

---

## 1.4 — cost 84 · shape 4 · the not-advice disclosure is in 3 of 34 engines

`Quiver/assets/whitepaper.part4.md:270` (§8 structural limitation 9), mirrored at
`Quiver/assets/whitepaper.part1.md:298` and `Quiver/docs/limitations.md:102`

> 9. **[structural] None of the services is financial advice.** They report what markets price and what
>    data shows. Every output that touches a decision carries a not-advice disclosure, and the
>    short-window up/down service refuses to output a directional edge at all.

**False.** Measured two ways:

- **Source.** `notAdvice` / `notFinancialAdvice` appears in **3 of the 34 files** under
  `Quiver/src/engine/`: `tokenScan.js`, `walletAudit.js`, `optionsDesk.js`. There is no wrapper adding
  it — the field count in `src/app.js`, `src/services.js` and `src/x402.js` is zero in each.
- **Live.** A `perp_gate` call to the live endpoint returns no occurrence of the string *advice*
  anywhere in the response body. `perp-gate`, `size-gate`, `portfolio-gate`, `treasury-risk`,
  `lp-risk` and `exec-verify` are unambiguously decision-touching and carry nothing.

The second clause is true — the up/down service does refuse a directional edge — which is what makes
the first read as though it had been checked to the same standard.

**Why the cost is this high.** It is in §8, the paper's limitations list. A judge who goes looking for
candour reads §8 first, and this is the section where an over-claim costs the most, because the whole
section is an argument that the authors count carefully against themselves.

**Make it measurable.** Enumerate `SERVICES`, call each on its fixture body, and assert the disclosure
field on every service the register marks decision-touching. The register already exists —
`src/util/inputClaims.js` classifies all 22 services for a different property.

---

## 1.5 — cost 82 · shape 2 · a flat assertion about an external file that was never fetched

`Quiver/docs/pdf-rerender.md:215` · `hackathon/PDF_RERENDER.md:215`

> Whatever that link currently serves, it is not this document.

**False.** One unauthenticated GET settles it:

```
curl -sL "https://drive.google.com/uc?export=download&id=1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW"
```

| | Drive, fetched now | `Quiver/paper/Quiver-Technical-Documentation.pdf` |
|---|---|---|
| bytes | 935,830 | 935,830 |
| sha256 | `8b45e027…83451f` | `8b45e027…83451f` |

Byte-identical. The Drive link serves **exactly** this document — at the very sha256 the same page
records in its own before/after table at §3. `hackathon/paper/` holds a third identical copy.

The sentence is not hedged. It says *whatever* it serves, it is *not* this. It was written from a
records trail — a "NEEDS Drive re-upload" note carried forward across many re-renders — rather than
from the file, and the records trail was out of date.

**Consequence.** §8 of the same document is headed "What Tristan has to do himself", and its first
action item at `pdf-rerender.md:208` — *"**Re-upload the PDF to Drive.**"* — is already done. A to-do
list whose top item is complete is how a real one gets ignored.

**Make it measurable.** The most actionable item in this report: one `curl` of the public Drive link,
`sha256`, compare to `paper/Quiver-Technical-Documentation.pdf`. No credentials, no wallet. The
judge-facing PDF is currently the only artifact a reader downloads that no check reads.

---

## 1.6 — cost 78 · shape 1 + 6 · three published documents disagree about the deploys, in the README's own numbers

`Quiver/README.md:46` and `:51` and `Quiver/docs/deploy-manifest.md:4`:

> **two deploys have shipped**, on 29 July at 00:30 and 09:30 UTC … **Measured darkness was 11 seconds
> on the first deploy and 0 seconds on the second**

against `Quiver/docs/verification-log.md:116–119` · `hackathon/VERIFICATION_LOG.md:116–119`:

> ## V10 — second deploy, and it never went dark at all
>
> Out at 00:30:41 UTC on 29 July, on a fresh authorisation. **Zero seconds of darkness**, against 11
> seconds on the first deploy and a three-minute expectation before that.

**Mutually inconsistent, and at least one is false.** The manifest and the README list exactly two
deploys and assign 11 seconds of darkness to the 00:30 UTC one. The verification log calls the
00:30:41 UTC deploy the **second**, with **zero** darkness, and puts the 11 seconds on an earlier one
that is not in the manifest's list at all.

Git corroborates the verification log's ordering and implies a third deploy: commit `468c701`
(2026-07-29 06:09 +0700) is titled *"deployed at 01:20 WITA, dark for 11 seconds"* — 01:20 WITA is
17:20 UTC on **28** July — and `af31f77` (2026-07-29 07:32 +0700) is *"second deploy, live at 00:30:41
UTC, and it never went dark at all"*. On that reading there were three deploys, the 11 seconds belongs
to the first, and the README both undercounts and mis-assigns.

**I cannot resolve which is right**, and that is the finding. No deploy log is committed. The watchdog
measures darkness and its output is not kept. The number a judge is most likely to quote back —
*"eleven seconds"* — exists in three published accounts that disagree, and nothing can go red.

**Make it measurable.** Have `gates/watchdog.mjs` append one row per deploy to a committed ledger, and
add a `docs-consistency` rule asserting that any document saying "N deploys" or naming a darkness
figure agrees with it. That is the same construction as the existing part-count and service-count
rules, applied to the one fact currently written down everywhere and read nowhere.

---

## 1.7 — cost 75 · shape 4 · "every answer carries a proof" — true of 9 services of 22, and still live

`hackathon/QUIVER_X_POST.md:87`:

> **One-line pitch:** The verifiable risk brain for autonomous agents — 22 deterministic risk &
> intelligence services where every answer carries a re-runnable, self-checked proof.

`hackathon/QUIVER_COMMUNITY_KIT.md:22` and `:38` carry the same sentence, the second as a
copy-paste-ready post: *"The bit I'm proud of: **every answer carries a re-runnable, self-checked
proof**"*.

**False, and the project has already measured exactly how false.**
`Quiver/docs/known-defects.md:272–296` calls all 22 services on their own fixture bodies and finds 12
of the 13 observation services ship `selfChecks: []` and `allSelfChecksPass: null`. Its own conclusion,
verbatim: *"The claim is true of 9 services out of 22 and should name them."*

Two further things that entry does not say:

- **Its remediation scope is under-enumerated.** It names three surfaces carrying the overreach —
  `/`, `/llms.txt` and the agent card. The two files above are not on the list, and neither is the SDK
  README at `Quiver/sdk/README.md:3` (*"One import, every risk computation"* — `sdk/index.js` imports
  nine engines). The disclosure of an unbounded claim is itself unbounded.
- **It is still live.** `curl https://quiver-production-c3a8.up.railway.app/llms.txt` still returns the
  sentence, after two deploys. The entry's status line reads "Copy fix pending"; that page is what an
  AI agent reads to decide what this service is.

`Quiver/INTEGRATIONS.md:9` carries a near-identical sentence and is **excluded**: it is scoped to MCP
tool results, and the live `tools/list` returns exactly the nine deterministic engines, so for that
surface it is true. The distinction is the whole point — the same words are correct at one scope and
false at another, and no checker knows which scope a sentence is in.

---

## 1.8 — cost 72 · shape 1 · "the live served paper is stale too" — it is not

`Quiver/docs/pdf-rerender.md` §6: the five-row table at lines 141–145, the prose at 147–149 and
156–157, and the classification at line 180 (*"**Needs a deploy.** The live service's paper routes"*).

> The served HTML is 419,108 bytes against the corrected 420,284 on disk. … the deploy which resolves
> it has not happened, so a judge reading the typeset paper today still gets the old numbers.

**False, every row.** Measured now:

| route | served bytes | local corrected | stale markers |
|---|---|---|---|
| `/paper` | 420,284 | 420,284 | 0 |
| `/paper/full` | 253,603 | — | 0 |
| part 1 | 36,425 | 36,425 | 0 |
| part 4 | 56,234 | 56,234 | 0 |
| part 7 | 35,330 | 35,330 | 0 |

`sha256` of the served typeset paper equals `sha256` of `Quiver/assets/whitepaper.html` exactly. The
served copy carries the corrected marker *"The 381 that run in the default environment all pass"*, does
not carry *"All currently pass."*, and holds 11 tables. The 09:30 UTC deploy landed after this document
was written.

**Make it measurable.** Half the machinery exists: `gates/preflight.mjs` already compares live paper
text to the tree by content hash, and reports divergence as *expected before a deploy*. Nothing flips
that expectation off afterwards, so a document quoting the pre-deploy state stays quoted.

---

## 1.9 — cost 70 · shape 2 · "not verifiable from here" — it is one command

`Quiver/docs/pdf-rerender.md:218` · `hackathon/PDF_RERENDER.md:218`

> Not verifiable from here: what the Drive link actually holds right now. The record says it is old; the
> file itself was not fetched.

**The second clause is honest and the first is false.** It is verifiable from here. It took one `curl`
with no credentials, and it produced 1.5 above.

Listed separately from 1.5 because it is a different defect and the more instructive one. 1.5 is a wrong
fact; this is the method failure that produced it — a link the project publishes to judges was declared
unreachable without anyone trying to reach it, and the declaration then became the reason nobody tried.

**The distinction this whole report turns on:** "unmeasurable in principle" (what a private folder held
last Tuesday) and "measurable and not measured" (what a public link serves right now) are not the same
finding, and only the second is actionable. Of the five external systems this project cites, **four are
fetchable and none is fetched** — §2.3 through §2.7.

---

## 1.10 — cost 68 · shape 6 · the forensic attribution in the blind-spot report is wrong, and `git show` says so

`Quiver/docs/docs-coverage.md:70` · `hackathon/DOCS_COVERAGE.md:70`

> The references are right. The table count **was right too**, on 27 July, when the sentence was
> written in `b383426` and the paper had exactly ten.

The sentence being attributed, quoted three lines above at `docs-coverage.md:67`, is *"Full technical
documentation with methods, "ten tables" and 44 references, every one of them cited"*.

**False.** One command:

```
git show b383426:assets/landing.html
```

At `b383426` (2026-07-27 22:20:56 +0700) the front page read *"methods, "ten tables" and "73
references":"* — a different reference count and a different trailing clause. The wording actually
attributed to it first appears in **`2af7238`** (2026-07-27 22:38:51), eighteen minutes later, in a
commit whose own subject is *"a padded bibliography"*.

What is correct, and I checked it: the paper did hold exactly ten numbered tables at `b383426`, and
Table 11 did arrive on 28 July in `a2a0602`. Only the commit and the quoted sentence are wrong.

**Why it costs this much.** This is §2.1, "The one real defect" — the paragraph where the project
performs forensic precision about its own history, in the document whose subject is *checks that were
blind*. A judge who runs the one command the paragraph invites gets a different sentence back.

**Make it measurable.** Any prose of the form "written in `<sha>`" is checkable by `git show <sha>` and
a substring test. Roughly a dozen documents make attributions of this shape, and nothing reads any of
them.

---

## 1.11 — cost 65 · shape 3 + 4 · "both proven able to fail by scripted revert" — one of them has no revert

`Quiver/docs/deploy-manifest.md:56` · `hackathon/DEPLOY_MANIFEST.md:56`

> Six checks and sixteen. Both proven able to fail by scripted revert: stub the router and 2 of 6 go
> red; stub the repair layer and 6 of 16 go red.

**The second half names a script that does not exist.** Measured from `package.json` and `gates/`:

- `gate:r` has `gate:r-revert` → `gates/gateR-revert.mjs`, four reverts, each driving
  `gateR-misroute.mjs` red and green again. `Quiver/README.md:173` states only this half, correctly.
- `gate:buyer` has **no revert**. There is no `gate:buyer-revert` script and no `gateBuyer-revert.mjs`.
  Of the 41 gate and docs scripts in `package.json`, it is the only `node --test` gate with no
  `-revert` sibling; every other one has exactly one.
- Every appearance of `gateBuyer-mistakes.mjs` inside a revert script — `gateC-revert.mjs:115`,
  `gateU-revert.mjs:106` and `:125`, `gateP-revert.mjs:88` — is as a companion that must **STAY
  GREEN**, which is the opposite claim. Nothing anywhere makes it go red.

So "6 of 16 go red" is a number nothing runnable has ever produced. The string appears in this file and
nowhere else in either tree.

Sharper still: `gates/gateP-paid-teaching.mjs:14` names `gateBuyer-mistakes` as one of the checks that
let a defect through. The one gate with no proof it can fail is the one already on record as having
failed to catch something.

**Adjacent, reported as context and not as a finding.** `Quiver/docs/phase-d-build-plan.md:183` says
*"**Every gate proves it can fail by a scripted revert.** No exceptions, including for the ones that
look obviously correct."* That sits under the heading "Constraints that hold throughout" in a
forward-looking plan, so it is a rule for future work rather than a claim about the tree, and I am not
calling it false. It is worth noting only because the rule is already broken by a gate that shipped
before the plan was written, and nothing would ever say so.

**Make it measurable.** The highest-leverage checker this report suggests: enumerate `gates/*.mjs`, pair
each `node --test` gate with a revert, fail on any gate without one. It converts the project's flagship
promise from prose into a set that is actually enumerated.

---

## 1.12 — cost 60 · shape 4 · "every response carries an `elapsedMs` field" — the flagship service does not

`Quiver/assets/whitepaper.part1.md:239` · `Quiver/assets/whitepaper.md:233` · and the served paper

> Every response carries an `elapsedMs` field so a caller can hold the service to its own timing.

**False.** Measured two ways:

- **Source.** `elapsedMs` occurs in 14 of the 34 files under `Quiver/src/engine/`, and **all nine
  deterministic engines carry zero occurrences** — `perpGate`, `portfolioGate`, `sizeGate`,
  `execVerify`, `optionsRisk`, `lpRisk`, `treasuryRisk`, `riskAttest`, `eventVol`. No wrapper adds it:
  the count in `src/app.js`, `src/mcp.js` and `src/services.js` is zero in each.
- **Live.** A `perp_gate` response from the live endpoint has no `elapsedMs` key.

Mitigation, stated fairly: the surrounding paragraph is about live-data latency, so a reader may take
"every response" as scoped to the services just discussed. But the sentence invites the caller to hold
*the service* to its own timing, and the nine services a caller most wants to time offer no way to.

**Make it measurable.** Same construction as 1.4 — call every service on its fixture body and assert the
field.

---

## 1.13 — cost 55 · shape 1 · the audit that recorded the original contradiction is now wrong in the same way

`Quiver/docs/truncation-audit.md:16–22` · `hackathon/TRUNCATION_AUDIT.md:16–22`, its two highest
headline items:

> 1. **The judge-facing PDF on Google Drive is stale** — 934,725 bytes published vs 935,830 rendered
>    locally at 15:34 today, still carrying the old title. …
> 2. **The live deploy is behind the working tree** — 13 changelog entries never deployed, and the live
>    front page still says the paper has "ten tables" when it has eleven. The fix exists and is
>    committed; it is simply not in production.

**Both false now.**

| claim | measured |
|---|---|
| Drive PDF 934,725 bytes and stale | 935,830 bytes, sha256 matching the corrected local file |
| 13 changelog entries never deployed | live `/changelog` serves 19 date-headed entries, identical to `assets/changelog.md` |
| live front page says the paper has "ten tables" | live front page is 4,941 bytes, contains no such phrase, and links every part of the machine edition |

**Judged, and included on purpose.** The rule this sweep inherits is that prose in a dated record
*supposed* to describe a past state is not a finding, and this file does carry `**Date:** 29 July 2026`
and `**Status:** findings only. Nothing here was fixed.` That is real protection and it is why the cost
is 55 rather than 85.

It is included anyway for one reason. `docs/deploy-manifest.md` was in exactly this position this
morning and got a `> **SUPERSEDED, 29 July 2026.**` banner across its top, which is what makes it safe
to read. This file describes findings that have since been resolved, sits in the published mirror, and
got nothing. Same class of document, same day, treated two ways — and it is specifically the file whose
§1.5 already caught the README defect and was not acted on. A reader who finds it and starts working the
list will redo work that is done.

---

## 1.14 — cost 45 · shape 6 + 4 · "every number below was ground-truthed … on 27 July"

`hackathon/QUIVER_SUBMISSION.md:3`

> Every number below was ground-truthed against the running code, the live endpoint, or the paper on
> 27 July 2026 before being written here.

**False as written.** Below that line the document contains numbers that did not exist on 27 July:

- line 103 — the registry and verifier addresses, two transaction hashes and their gas figures, all
  labelled *"Live, on mainnet, 28 July 2026"* in the same sentence.
- line 95 — "386 model-free tests". The 27 July judging snapshot at
  `hackathon/judging/Quiver/README.md` records 274.
- the file's own mtime is 28 July 2026 04:21.

A universal quantifier bound to a date the document post-dates. Nothing checks dates, nothing checks
authorship order, and "this was verified before it was written" is unfalsifiable by construction.

Cost is 45 rather than higher because this file is not mirrored into `Quiver/` — a judge reads the form,
not this. But it is the source the form was filled from, and the sentence is a process promise about the
most externally-visible text the project has.

---

# 2. True now, or unchecked — ranked by what it costs when it goes false

Nothing below is a present error. Each is a claim no checker reads, so it will not announce itself on
the day it stops being true.

### 2.1 — cost 95 · shape 1 · `Quiver/README.md:37–55`, "Since the deadline"

The paragraph is now honest about the deploys, and its individual facts hold — except that its darkness
figure is contradicted by the verification log (1.6). It is the highest cost in the report because it is
the sentence that already failed once, in this position, in the first file a judge opens, and it is
still a count of an event nothing enumerates. A third deploy makes it false and every gate stays green.
The fix is the deploy ledger in 1.6.

### 2.2 — cost 70 · shape 3 · "every number on this page comes from a fresh measurement, taken first and written down second"

`Quiver/docs/known-defects.md:5` · `hackathon/KNOWN_DEFECTS.md:5`. The governing sentence of the whole
defect register, quantifying over every number in a 390-line document. No checker can establish that
measurement preceded prose — the class is unfalsifiable in principle, not merely unmeasured. It ranks
this high because 1.1 and 1.2, two false claims, are on the page it governs: a judge who finds either
has grounds to disbelieve the sentence, and the sentence is what the submission leans on for "we grade
ourselves honestly". The same construction recurs at `Quiver/docs/case-sensitivity-fix.md:8` and
`Quiver/docs/unknown-enum-refusal.md:9` (*"written down second"*), and neither before-state tree is
tagged in git, so even the earlier numbers cannot be re-derived.

### 2.3 — cost 60 · shape 2 · the ERC-8004 registry: 22 services on one reading, 0 on another

`Quiver/assets/whitepaper.part1.md:230` says registration *"makes its twenty-two services discoverable
to any agent browsing the registry"*. `hackathon/QUIVER_MISSION_CONTROL.md:154` records that
`agent service-list --agent-id 5152` shows 22 live while the aggregate `get-agents` `serviceList` field
*"always 0"*. **Could not check** — see §3. The whitepaper sentence is defensible under the first
reading and overstated under the second, and the second is the call a *browsing* agent makes.
`Quiver/docs/a2mcp-meaning.md:124` adds that the registry is frozen while the services are under review,
a state nothing polls.

### 2.4 — cost 60 · shape 2 · the launch thread, in the README's first screenful

`Quiver/README.md:14` and `Quiver/assets/landing.html:56`. **True — I fetched it.**
`cdn.syndication.twimg.com/tweet-result?id=2080225222880526720` returns the post: author `Quiverrrs`,
created `2026-07-23T09:35:16Z`, video attached. Ranked this high while true because
`QUIVER_MISSION_CONTROL.md:740` records that the project's *previous* X account was suspended. A repeat
kills the README's fourth bullet and the landing page's video section at once, on the two pages a judge
lands on first. One unauthenticated GET per external link, asserting status and author handle, closes it.

### 2.5 — cost 55 · shape 2 + 6 · whether the correction reply was ever posted

`hackathon/X_THREAD_UPDATE.md:3` says the pinned thread quotes a superseded hash and now must explain
it; `Quiver/docs/truncation-audit.md:501` says whether the thread actually posted on x.com does so is
*"not determinable from disk"*. That framing is exactly right and is the honest version of the sentence
that went wrong in 1.9 — it names the boundary rather than declaring the fact unknowable. It remains
unfalsifiable in practice because nothing steps off disk. **Partly checked:** the root post is live and
carries no build hash at all, so any mismatch is in a reply, and replies need an authenticated session.

### 2.6 — cost 52 · shape 3 + 4 · "three gates, each able to fail" — none runs in any battery

`Quiver/README.md:77` and `:106`. **True as history, unenforced as a property.**
`Quiver/zk/package.json` does name them — `gate:b0`, `gate:b1`, `gate:b2`, `gate:clone`, `facts` — which
was fixed on 29 July. But nothing *calls* them: `npm test`, `gates/preflight.mjs` and
`tools/docs-consistency.mjs` never enter `zk/`, where 42 scripts live. A regression in a circuit, a
verifier, or the clone-portability check the README calls *"the check that was missing"* leaves every
battery green.

Second, unreported anywhere: the two `zk` trees have diverged. The published `Quiver/zk/package.json`
carries the five aliases; the working `zk/package.json` at the tree root still carries only
`"test": "echo \"Error: no test specified\" && exit 1"`. Nothing compares them, because
`docs-consistency` walks documents rather than manifests.

### 2.7 — cost 50 · shape 2 · the availability record, hosted off the service on purpose

`Quiver/README.md:12`. **True — I fetched it.** The JSON endpoint returns `"status": "operational"`,
`checkedAtUtc 2026-07-29T10:19:44Z`, a live probe up in 866 ms reporting 22 services, and a 24-hour
window of 720 pings at 99.86%. It is a genuinely good design: an availability claim that does not depend
on the thing it measures. It is also a third-party AWS deployment nothing in either tree pings, so if
the Lambda's schedule lapses the README goes on advertising a record that has stopped being written.

The shape-5 word in the same sentence — *"hosted **deliberately** off the service it watches"* — is
legitimate, and is listed here as the contrast case: the rationale is stated and the artifact
demonstrates it.

### 2.8 — cost 45 · shape 5 · four intent attributions with no record behind them

Each launders an absence into a decision, and in three cases the premise is also wrong:

| | claim | measured |
|---|---|---|
| `Quiver/docs/perp-snark-reachable.md:292` | left alone *"on a day with no deploy window"* | committed 01:45 UTC 29 July; the manifest records deploys at 00:30 and 09:30 UTC the same day, one 75 minutes before and one later |
| `Quiver/docs/pdf-rerender.md:159` | *"not fixed here, deliberately … deploying is off-limits during judging"* | committed 08:47 UTC; the 09:30 UTC deploy is 43 minutes later and shipped exactly the thing it declined to fix |
| `Quiver/docs/phase-b-remaining-plan.md:174` | *"declined, deliberately, and recorded here so that the absence reads as a decision rather than an omission"* | the sentence tells the reader how to read it. No earlier artifact in the corpus records the decision; the roadmap argues the property but does not decide |
| `Quiver/docs/t3-portfolio-circuit.md:215` | *"Recorded as a deliberate choice, not an oversight."* | no prior artifact records the choice |

The first two are the instructive pair: a deliberate omission is a defensible thing to publish, but both
rest on a claim about the day that the project's own deploy record contradicts. The reasoning is
unfalsifiable; the premise was checkable and was not checked.

### 2.9 — cost 40 · shape 6 · "hours after the deploy" — 65 minutes before it

`Quiver/docs/verification-log.md:207` reads the OKX listing *"at 07:25 WITA on 29 July, hours after the
deploy"*. 07:25 WITA is 23:25 UTC on 28 July. V10, 89 lines earlier **in the same file**, puts the
deploy at 00:30:41 UTC on 29 July — this read is 65 minutes *before* it. It is "hours after" only the
earlier deploy, the one the manifest does not list. Reported as context for 1.6 rather than as a
separate falsehood: which deploy is meant depends on which of the three accounts is right, and that is
the unresolved thing.

### 2.10 — cost 40 · shape 2 · the MCP registry listing

`Quiver/README.md:9` and `Quiver/assets/whitepaper.part1.md:230`. **True — I fetched it.**
`registry.modelcontextprotocol.io/v0/servers?search=quiver-risk-brain` returns one server,
`io.github.Tristan-tech-ai/quiver-risk-brain`, status `active`, remote `streamable-http` pointing at the
live endpoint. Nothing fetches it; a de-listing or a host migration would leave the claim standing in
the README, the landing page and the paper at once.

### 2.11 — cost 35 · shape 1 · the traction figures

`Quiver/README.md:29`. Cannot go false by drift — the window is explicitly bounded to the eight days to
27 July, which is the right way to write a historical on-chain figure — but it cannot stay current
either, and it errs by understating, which is the safe direction. Partial coverage exists and deserves
credit: `docs-consistency` rule 6 already fails on this claim's retracted predecessors.

### 2.12 — cost 30 · shape 3 · "verified by eye"

`Quiver/docs/pdf-rerender.md:5`. A human act with no artifact — no screenshot, no page-image diff,
nothing a later reader can re-run — and it is the load-bearing step of the PDF pipeline. Rasterising the
first page and the two corrected pages to committed images and diffing on re-render would turn it into
one.

---

# 3. What I could not check, and why

The part of this sweep that could be wrong.

| | why not |
|---|---|
| **Whether the X thread's replies carry the superseded build hash** (2.5) | The public syndication endpoint returns the root post only. Reading replies needs an authenticated session, and signing in to a social account is not something to do on the user's behalf. The root post carries no hash, so the claim is neither confirmed nor refuted. |
| **What the on-chain registry returns for agent 5152** (2.3) | Needs either the onchainos CLI in a wallet context or the registry address and ABI for a raw `eth_call`. Neither was in reach without touching wallet state, which this sweep was barred from. The disagreement the project itself records is left open. |
| **Which of the three deploy accounts is right** (1.6, 2.9) | No deploy log is committed and the watchdog's output is not kept. Git commit subjects imply three deploys and an ordering, but a commit subject is not a measurement. |
| **Whether the HackQuest entry still holds the values in `QUIVER_SUBMISSION.md`** | The submission is behind a login; the hackathon page is public, the entry's field values are not. This is the largest genuinely unmeasurable surface in the project — seven hardcoded paper URLs, a Drive link and a thread link, none of which anything can read back. |
| **Whether the 27 July ground-truthing pass happened** (1.14), and every "measured before touching anything" / "written down second" claim (2.2) | `hackathon/` is not a git repository, so nothing outside `Quiver/` has history. Roughly forty documents open with a sequencing assertion of this kind; some are checkable against `Quiver/`'s 126 commits and most are not. |
| **`gates/preflight.mjs`'s reported blind spot** | `Quiver/docs/perp-snark-reachable.md:307` states that preflight *"reports success over a path it does not examine"* because it reads `SERVICES.map(s => s.run)` while the MCP handlers are a different array. If accurate this is a green gate over an unfixed path — the exact class hunted here, disclosed in prose only. I did not verify it, because `gates/` is read-only for this sweep and confirming it would mean reasoning about code I was told not to touch. **It should be verified.** |
| **The paid HTTP surface** | Every live measurement used `/build`, `/`, `/changelog`, the paper routes and the free `/mcp`. The paid x402 routes were not called, because that spends. Claims specific to the paid path are unverified here. |

---

# 4. Method, and the dimensions enumerated before searching

Recorded so the next sweep can tell whether this one was capped.

**Corpus.** `node tools/docs-consistency.mjs --list` from `veritape/` — 205 documents. A full walk of
both trees, excluding `node_modules`, finds 267 `.md` and 15 `.html` under `hackathon/` and 70 `.md` and
3 `.html` under `Quiver/`; the difference is the vendored skill packages, the judge's clone and the
adversarial tester's captures, which `docs-consistency` excludes by name and which are snapshots rather
than claims. Both dimensions were enumerated: `.md` **and** `.html`; top level **and** recursive;
`hackathon/`, `Quiver/`, `zk/` and `assets/`.

**No caps.** Every grep ran unlimited. The operational-history sweep alone returned 34 hits across both
trees and all 34 were read. Three sweeps ran in parallel — operational history and external systems by
hand, universal quantifiers and dates/intent delegated — and **every delegated finding was re-measured
before it was written down here.** Three were dropped on re-measurement: `INTEGRATIONS.md:9` (correct at
MCP scope, see 1.7), and two "every service" claims that turned out to be enumerated in code
(`gates/gateP-paid-teaching.mjs` loops `SERVICES`; the field-test result files hold 22 rows each).

**Live measurements taken** — all read-only, no wallet, no deploy, no paid route: `/build`, `/`,
`/llms.txt`, `/changelog`, `/paper`, `/paper/full`, three individual parts, and four free `/mcp`
requests; the public Google Drive object; `cdn.syndication.twimg.com`;
`registry.modelcontextprotocol.io`; the AWS status Lambda; and the GitHub API, which confirms the
published mirror is current (`pushed_at 2026-07-29T10:08:28Z`, matching the local `HEAD`).

**Excluded, with the reason.** Prose in a dated record that is *supposed* to describe a past state is not
a finding. That removed the "No deploy was performed" line from seven session write-ups
(`case-sensitivity-fix.md:305`, `docs-coverage.md:262` and `:314`, `paper-consistency.md:285`,
`paper-gate-repair.md:384`, `unknown-enum-refusal.md:367`, `divergence-headroom.md:307`) — each true of
the session that wrote it, dated in its own header, and holding them to currency would demand falsifying
the record of what shipped when. `truncation-audit.md` is the one case where the rule was overridden;
1.13 gives the reason. Design rationale in the paper that explains a modelling choice was excluded from
shape 5 throughout.

**What this report cannot do.** It is prose about prose, and nothing here goes red either. The
"make it measurable" notes are the only durable output — six checkers, of which the gate-revert pairing
(1.11) and the deploy ledger (1.6) would each have caught more than one finding above. The report itself
is exactly the artifact class it is complaining about, and 1.13 is what happens when one of these is
written and not acted on.
