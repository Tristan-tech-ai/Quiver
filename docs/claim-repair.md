# Four published claims had stopped being true, and one gate could not fail

**Date:** 29 July 2026 · **Build:** `q1-e1fa99d08887d6cc` (unchanged; `src/engine/` untouched)
**Suite:** `npm test` → `tests 386` = `pass 381` + `skipped 5`, `fail 0` · **Nothing was deployed.**

Source: `unmeasured-claims.md`, which is one sweep's judgement. **Every item below was re-measured
before anything was edited**, and two of its incidental claims did not survive that — recorded in §7.

---

## 1. What re-measured true, and what did not

All live measurements taken 10:38 UTC, 29 July 2026, against
`https://quiver-production-c3a8.up.railway.app`, unauthenticated, over the free MCP surface.

| claim under test | re-measured | verdict |
|---|---|---|
| `side: "banana"` is refused | `ok:false` + `unknownEnumValues`, *"Nothing was computed and you were not charged"* | **TRUE** |
| `side: "SHORT"` returns 108,641.98 | `liquidationPrice 108641.98`, `inputRepairs.recased` | **TRUE** |
| the build hash never moved | `/build` → `q1-e1fa99d08887d6cc`, 37 engine files | **TRUE** |
| the fix shipped outside `src/engine/` | `src/util/repair.js`, `src/services.js`, `src/mcp.js` | **TRUE** |
| the Drive link serves the current PDF | `HTTP 200`, `Content-Length: 935830`, `Last-Modified: 09:50:35 GMT` | **TRUE**, with one caveat — §3 |
| the served paper is byte-identical to the tree | 10 of 10 artifacts, sha256 per part | **TRUE** |
| `gate:buyer` has no revert | one file, one alias, no `gateBuyer-revert.mjs` | **TRUE** |
| there were three deploys, not two | commit timestamps — §4 | **TRUE** |
| `gate:r` has six checks | it has **fifteen** | **FALSE** — §7 |
| `README.md` carries the deploy claim | only `Quiver/README.md` does | **PARTLY FALSE** — §7 |

---

## 2. `known-defects.md` — the page that argued with itself

This is the page written specifically to disclose defects honestly, so an error here costs more than
anywhere else. It carried a correction at line 27 and the retraction of that correction at line 382 —
**355 lines apart, in the same file, with the false one last**. A judge reading top to bottom met the
truth first and the falsehood second.

The closing section told a reader to run a `curl` and predicted the wrong answer three ways:

> Either way, `{"side":"banana"}` still returns 91,139.24 on both builds. That half is genuinely still
> open and is not scheduled around judging: it needs `src/engine/` and a moved build hash.

It is refused, not answered. It did not need `src/engine/`. The hash did not move. A fourth sentence
said *"no deploy has been performed since it landed"*; three had.

**What changed.** The page now states current behaviour twice — a reading guide in the header and a
measured table at the foot — and every historical table is labelled *at the point of use* as the
before state, rather than relying on one sentence 300 lines earlier. The `options_risk` table that
lists `"banana"` under **call** now carries an explicit line saying none of its rows reproduces. The
four-step fix plan whose step 3 claimed the hash had to move is marked as the superseded plan it is.
The retracted sentences are **quoted and kept**, not deleted: a defect register that silently edits its
own history is worth less than one that shows the correction.

---

## 3. `pdf-rerender.md` — wrong in the opposite direction

Two sentences:

> Whatever that link currently serves, it is **not this document**.
> **Not verifiable from here**: what the Drive link actually holds right now.

One command, no credentials, under a second:

```
curl -sIL "https://drive.google.com/uc?export=download&id=1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW"
```

`HTTP 200` · `Content-Length: 935830` · `Last-Modified: Wed, 29 Jul 2026 09:50:35 GMT` ·
`Content-Disposition: … "Quiver — Verifiable Financial and Security Primitives for the Agentic
Economy.pdf"`. **935,830 bytes is exactly the current on-disk render**, and the upload is 20 minutes
after it.

**The caveat, stated because the point of that page is not overclaiming twice.** What is verified is
the byte count, the filename and the upload time. The **sha256 was not verified** — that needs a
download rather than a `HEAD`. "Same length as the current render, uploaded after it" is strong
evidence, not proof of identity, and the page now says so.

**The second error caused the first.** "Not verifiable from here" was not a measurement; it was an
assumption that closed the question, and what filled the gap was a stale to-do trail
(`QUIVER_MISSION_CONTROL.md` carries ten *"NEEDS Drive re-upload"* notes). **Declaring a fact
unmeasurable is itself a claim, and it is the one claim that guarantees nobody goes and looks.**

**The served paper was also described as stale, in three places.** It is not, and this was checked
rather than taken from the brief:

| route | on-disk | served | sha256 |
|---|---|---|---|
| `/paper` (HTML) | 420,284 | 420,284 | identical |
| `/paper/full` | 253,603 | 253,603 | identical |
| parts 1–7 | 36,425 / 27,109 / 44,259 / 56,234 / 13,428 / 49,786 / 35,330 | same | identical, 7 of 7 |
| `/changelog` | 46,248 | 46,248 | identical |

`gates/preflight.mjs` confirms independently: *"7 byte-identical to live — the repository and live
agree byte for byte."* Corrected in `pdf-rerender.md` §6, `truncation-audit.md` §1.1 and §1.5, and
**`assets/changelog.md`, which is served live** — that file was telling every reader of `/changelog`
that the live service serves a pre-correction paper, while being served byte-identically by it.

---

## 4. Three documents disagreed about the deploys — settled

**Three deploys, not two.** Settled from commit timestamps, which are evidence independent of anyone's
recollection.

| # | when (UTC) | darkness | evidence |
|---|---|---|---|
| 1 | **28 Jul 17:20:59** (01:20 WITA 29 Jul) | **11 s** | `verification-log.md` §"The deploy, for the record"; commit `468c701` *"deployed at 01:20 WITA, dark for 11 seconds"*; independently corroborated by `148f8fb` from an unrelated workstream, *"went out at 01:20 WITA"* |
| 2 | **29 Jul 00:30:41** | **0 s** | `verification-log.md` §V10; commit `af31f77` *"second deploy, live at 00:30:41 UTC, and it never went dark at all"* — **committed 00:32:25 UTC, 1m44s after the stated go-live** |
| 3 | **29 Jul ~09:30** | **never measured** | no commit, no log section, no watchdog output; bracketed by a measurement at 08:50 UTC showing live *behind* the tree, and one after showing byte-identical |

**How the error was made.** The verification log's sentence *"Zero seconds of darkness, against 11
seconds on the first deploy"* is correct: there, "first" is deploy 1 and "second" is deploy 2. The
README and the manifest then re-listed the deploys as *the two that fall on 29 July by UTC date* —
dropping deploy 1, whose 01:20 WITA clock time hides a 28 July UTC date — and **reused the copied
"first / second" wording against the new list**. 11 seconds moved onto a deploy that had none; 0
seconds moved onto a deploy nobody timed.

**What is settled and what is not.** The count, order and times are settled. The 11 s and 0 s figures
are *contemporaneous eyewitness records, not re-derivable measurements*: `gates/watchdog.mjs` computes
darkness at line 95 and prints it, and contains **no filesystem import of any kind** — the terminal
holding both numbers is gone. Deploy 3's darkness is not merely unrecorded but **unknown**, and none
of the three documents now assigns it a number.

### Would a committed deploy log have prevented this? Yes — proposed, not built

Every element of this failure is downstream of one absence. The count was ambiguous because nothing
enumerates deploys; the darkness figures drifted because the only record was a scrollback; the
mis-binding survived because no checker can read "how many deploys have there been".

**Proposal.** `gates/watchdog.mjs` already measures everything needed and throws it away. Have it
append one JSON line to a committed `gates/deploy-log.jsonl` per run:

```
{"deployedAtUtc":"2026-07-29T00:30:41Z","darkSeconds":0,"codeHashBefore":"q1-…","codeHashAfter":"q1-…",
 "servicesBefore":22,"servicesAfter":22,"markerWaitSeconds":56,"watchdogVersion":"…"}
```

That makes three currently-unreadable things checkable: a document may not say "no deploy has been
performed" while the log holds a newer record (which is finding 1.2 of `unmeasured-claims.md`); a
document naming a deploy count must match `wc -l`; and a darkness figure must match a logged one or be
absent. It is roughly a dozen lines in the watchdog plus a rule in `docs-consistency`.

**Not built here, deliberately.** It writes a file during a deploy, and the next deploy is not this
task's to schedule; it needs a decision about whether a failed or aborted deploy also appends. Building
it now would also mean the log's first three entries were reconstructed from commit messages rather
than measured — which is exactly the kind of retrofitted evidence this project should not create. It
should start empty and earn its first row.

---

## 5. `deploy-manifest.md` claimed a revert that did not exist — so the revert was built

The manifest described **both** buyer gates as *"proven able to fail by scripted revert"*. Confirmed
false: `gate:buyer` had `gates/gateBuyer-mistakes.mjs` and one alias, and no revert of any kind. Its
**sixteen checks had never been shown able to fail, once** — on the gate whose entire subject is the
failure this project exists for: a reviewer's agent that sends a slightly wrong body and does not
understand what comes back.

That mattered more than a wrong number, because **this gate has already let a defect through**.
`gates/gateP-paid-teaching.mjs:14` records it: every check of the teaching layer called `repairBody`
and `correctedExample` directly, or went through `/mcp`, and **not one ever put a `PAYMENT-SIGNATURE`
header on a request** — so a paying caller received the prose of a refusal and none of the retry, while
a free caller got the corrected body, on a listing that points at paid endpoints for 13 of 22 services.

**Built rather than deleted:** `gates/gateBuyer-revert.mjs`, `npm run gate:buyer-revert`.

Six defects, put back into `src/util/repair.js` and `src/util/routing.js` one at a time. It does **not**
touch `src/mcp.js` or `src/services.js`, re-reads each file before writing (a second agent is working
in this tree), restores in a `finally`, and verifies both files back to their exact starting sha256
before it will print a result.

| revert | the defect put back | shape |
|---|---|---|
| PLAUSIBLE-DEFAULTS | refusals hand back `0` / `long` / `false` instead of `<placeholder>` | an agent sends it back unread |
| EMPTY-EXAMPLE | `correctedExample` reads only the flat `required` list | the historical bug, verbatim |
| LOOSE-NUMBERS | `"64,000"`, `"64k"`, `"$64000"` parsed instead of refused | confident wrong answer |
| ALIAS-OVERWRITE | an alias overwrites the caller's own value | silent data loss |
| WRAPPER-GREEDY | unwrapping fires on a wrapper key that is not alone | **over-fire** |
| FOREIGN-KEY-BLIND | the signpost loses the branch `routing.js` calls *"the case that actually cost two stars"* | a call that **succeeds** at the wrong shop |

**Where a revert also trips another gate, it says so.** Five of the six are held by gateBuyer alone;
`gate:r` also catches FOREIGN-KEY-BLIND, naming it *"MantaRay call 2: an Aave request that options-desk
CAN satisfy, and answers wrongly"*.

### Coverage is counted, not claimed

The first version of this file ended *"all sixteen checks are backed by a defect"*. **That was false —
it is eight.** The gate now computes the union itself and prints the eight it does not cover:

```
COVERAGE: 8 of 16 checks are turned red by at least one revert here.
  NO REVERT params nested under a framework wrapper are unwrapped
  NO REVERT numbers sent as strings are read as numbers
  NO REVERT a mis-cased key is matched to the one the service declares
  NO REVERT a common synonym is accepted where it is unambiguous
  NO REVERT a repaired body is routed on what it MEANT, not on what arrived
  NO REVERT every service still serves its own correct call, unrepaired and unflagged
  NO REVERT repairs are never silent
  NO REVERT repair never invents a key the caller did not send
```

Those eight are **not thereby proven sound** — they are simply not yet shown able to fail, which is the
state the whole gate was in before this file existed. Writing "sixteen" would have reproduced, inside
the fix, the exact defect being fixed.

### A companion measurement that could not be reproduced

The revert originally used `preflight` as its companion, as every other revert here does. **Three
consecutive runs over identical code reported "4 of 6 held by gateBuyer alone", then 2, then 3.**
`preflight` makes six live-service calls, and those checks fail as a *cluster* on any network hiccup.
Taking the baseline twice and excluding whatever drifted was not enough: a check can be green in both
baselines and still flake red inside one revert window, and it is then credited to that revert as a
finding.

Replaced with `gate:r`, which makes zero network calls. Two consecutive runs now give identical
numbers. **A companion that answers differently each run cannot support a sentence in a published
document — and the sentence this gate exists to make true is in one.**

---

## 6. The buyer-revert output

```
GATEBUYER REVERT — proving the buyer-mistake checks can fail, and saying which of them another gate also holds

  repair   .\src\util\repair.js  sha256 8ceb3a27fbeb498e…
  routing  .\src\util\routing.js  sha256 ddd1c5182cc611d9…

  baseline gateBuyer : 16 pass, 0 fail
  baseline gateR     : 15 pass, 0 fail  (companion; zero network calls)

  revert: PLAUSIBLE-DEFAULTS — the refusal hands back a body that looks sendable instead of visible placeholders
    gateBuyer against reverted code : 14 pass, 2 fail
      RED: a missing required field is never filled in
      RED: an empty body gets the corrected call, not a guess
      NAMED: a placeholder, not a plausible default  (the gate's own words)

  revert: EMPTY-EXAMPLE — correctedExample reads only the flat `required` list
    gateBuyer against reverted code : 13 pass, 3 fail
      RED: a missing required field is never filled in
      RED: a refusal is actionable for every one of the twenty-two
      RED: prose with no parameters is refused with the shape it should have had
      NAMED: these refuse without showing what to send: chart-press, calldata-x, macro-sentry,
             perp-gate, portfolio-gate, size-gate, lp-risk, risk-attest

  revert: LOOSE-NUMBERS — "64,000" / "64k" / "$64000" are parsed instead of refused
    gateBuyer against reverted code : 15 pass, 1 fail
      RED: a number that is NOT plainly a number is refused, not guessed
      NAMED: 64,000 must not be parsed

  revert: ALIAS-OVERWRITE — an alias is applied over a value the caller actually supplied
    gateBuyer against reverted code : 15 pass, 1 fail
      RED: an alias never overwrites a value the caller actually supplied
      NAMED: the canonical key wins; the alias is not applied over it

  revert: WRAPPER-GREEDY — unwrapping fires on a wrapper key that is NOT alone
    gateBuyer against reverted code : 15 pass, 1 fail
      RED: a wrapper key that is NOT alone is left alone

  revert: FOREIGN-KEY-BLIND — the mis-route signpost loses the branch that catches a call which SUCCEEDS
    gateBuyer against reverted code : 15 pass, 1 fail
      RED: the two half-star calls both get a signpost

  all files restored, both back to their starting sha256
  gateBuyer against restored code : 16 pass, 0 fail
  gateR baseline, re-taken        : 15 pass, 0 fail — stable across the run

==============================================================================
  [PASS] PLAUSIBLE-DEFAULTS   gateR: green — sole custody sits with gateBuyer
  [PASS] EMPTY-EXAMPLE        gateR: green — sole custody sits with gateBuyer
  [PASS] LOOSE-NUMBERS        gateR: green — sole custody sits with gateBuyer
  [PASS] ALIAS-OVERWRITE      gateR: green — sole custody sits with gateBuyer
  [PASS] WRAPPER-GREEDY       gateR: green — sole custody sits with gateBuyer
  [PASS] FOREIGN-KEY-BLIND    gateR: also red — MantaRay call 2: an Aave request that
                                     options-desk CAN satisfy, and answers wrongly
  [PASS] gateBuyer is green again once the files are restored (16/16)

  5 of 6 reverts are held by gateBuyer ALONE; gateR caught the other 1.
  COVERAGE: 8 of 16 checks are turned red by at least one revert here.

GATEBUYER REVERT: PASSED — 8 of the 16 checks go red on a real defect and green again on restore
```

Run twice back to back; identical both times.

---

## 7. What contradicts the brief

Three things, all minor, all recorded because the standing instruction is to distrust the framing.

1. **`gate:r` has fifteen checks, not six.** `deploy-manifest.md` said *"Six checks and sixteen"*, and
   the brief did not flag it. `node --test gates/gateR-misroute.mjs` → `tests 15`. The accompanying
   figures *"2 of 6"* and *"6 of 16"* were also unverifiable as written, so both reverts were run and
   the real numbers substituted: **`gate:r` turns 7 of its 15 red across 4 reverts; `gate:buyer` turns
   8 of its 16 across 6.**

2. **The deploy claim is in `Quiver/README.md`, not the working tree's `README.md`.** The brief named
   "`README.md`". `hackathon/veritape/README.md` contains no deploy claim at all — grep for
   `deploy|dark|touched since` returns nothing. Only the mirror's README carried it, and only that one
   was edited.

3. **The brief's own framing of `known-defects.md` understated where the contradiction lives.** Lines
   106, 175 and 219 were already inside blocks labelled as historical or explicitly retracted; the
   genuinely dangerous text was the closing *"How to reproduce"* section at 372–383, which a reader
   meets last and which reads as current. That is where the rewrite is concentrated. The three earlier
   sites were strengthened rather than rewritten.

Also worth recording: the brief said the 16 checks *"have never been shown able to fail"*. Confirmed
exactly. And `unmeasured-claims.md` §1.6 concluded *"this work cannot resolve which is right, and that is the
finding"* — it **is** resolvable, from commit timestamps that were already in the repository; what is
not resolvable is deploy 3's darkness.

---

## 8. Gates

| gate | result |
|---|---|
| `node tools/docs-consistency.mjs` | CONSISTENT |
| `npm test` | `tests 386` = `pass 381` + `skipped 5`, `fail 0` |
| `node gates/preflight.mjs` | 22 of 22 |
| `npm run gate:buyer` | 16 pass, 0 fail |
| `npm run gate:buyer-revert` | PASSED — 8 of 16 covered, both files back to starting sha256 |

`src/engine/` was not touched and the build hash is unchanged at `q1-e1fa99d08887d6cc`. **Nothing was
deployed.** `assets/whitepaper*`, `src/` and `gates/paper-*` were left alone for the concurrent paper
agent; the only files under `src/` this work touches are the two the revert edits and restores.
