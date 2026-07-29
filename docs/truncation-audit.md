# Truncation audit — what "absence within a cap" hid

**Date:** 29 July 2026
**Scope:** every "X does not exist" and "nothing else does Y" claim made in the 28–29 July session
(`cdeb06fc-e974-4d4a-9172-8033d0b77930`), re-derived without a cap.
**Status:** findings only. Nothing here was fixed. `hackathon/paper/` was not touched.

> **TWO HEADLINE FINDINGS ARE NOW CLOSED, 29 July 2026 (later).** Both were true when measured and both
> were resolved the same day. They are left in place because this is a findings document and the
> measurements are the point — but a reader must not take either as current:
>
> - **§1.1, "the judge-facing PDF on Google Drive is stale" — closed.** The file was re-uploaded.
>   `curl -sIL` on the published link now returns `Content-Length: 935830`, the exact size of the
>   current render, with `Last-Modified` 09:50 UTC on 29 July.
> - **§1.5, "the live deploy is behind the working tree" — closed.** A deploy at roughly 09:30 UTC
>   landed after the 08:50 UTC measurement recorded below. All seven paper parts, the typeset HTML,
>   `/paper/full` and `/changelog` are byte-identical to the tree, verified per-part by sha256 and
>   independently by `gates/preflight.mjs`.
>
> This document also correctly flagged, at §1.5, that the deploy manifest was telling readers the live
> service "has not been touched since 28 July". That finding was read and not acted on for several
> hours, which is recorded in the commit that eventually fixed it. Write-up: `claim-repair.md`.

---

## Headline — what bears on the deploy decision

**Nothing actively dangerous was found.** No secret is committed to the public repo (§4.2), no route
is broken (§2.1), no gate is unreachable in the public mirror (§5.4), and the two trees are in sync
(§5.4).

Four things are wrong, in descending order of external visibility:

1. **The judge-facing PDF on Google Drive is stale** — 934,725 bytes published vs 935,830 rendered
   locally at 15:34 today, still carrying the old title. Re-rendering locally did not update Drive.
   That link is in the submission form. (§1.1)
2. **The live deploy is behind the working tree** — 13 changelog entries never deployed, and the live
   front page still says the paper has "ten tables" when it has eleven. The fix exists and is
   committed; it is simply not in production. (§1.5)
3. **`codeHash` was used as a build-freshness signal it cannot be** — it covers 37 of 74 files in
   `src/`, excluding `app.js`, `mcp.js`, `services.js`, `routing.js`, and every adapter and util.
   Live, tree, and mirror all agree on it *while* the deployed bundle is a day old. `DEPLOY_MANIFEST.md`
   states this boundary correctly on its first page; the session's reasoning ignored it. (§1.4)
4. **32 zk gates sit outside every automated battery** — `zk/package.json` has no aliases at all, so
   by the orphan check's own criterion they are orphaned; one of them produces the staleness window
   the HyperEVM deploy script reads. (§3.2)

Two claims that were *believed false* turn out fine: the misroute fix **is** live and correctly
directed (§2.3), and the public mirror is **not** stale (§5.4).

---

## The defect

A search for a PDF ran:

```
find . -iname "*.pdf" ... 2>/dev/null | head -5; echo "  (no output = no PDF exists)"
```

It returned five PDFs belonging to unrelated projects, and the label `(no output = no PDF exists)`
was printed underneath output that plainly existed. There were **eight**. The Quiver one,
`hackathon/paper/Quiver-Technical-Documentation.pdf`, was sixth — outside the cap.

The failure is not "forgot to look for a PDF". It is:

> **a capped result set was read as a complete one, and absence-within-the-cap was reported as
> absence-overall.**

That shape recurs whenever a check has a boundary the conclusion ignores. The boundary is not always
`head`. It is also: one chain out of three, one file-extension out of two, one surface out of two,
one directory out of four, a regex anchor, a JSON shape assumption, or a hash that covers half a
tree. Every one of those appears below, with a real consequence.

**Three of the instances below I introduced myself while running this audit.** They are marked
*[self-inflicted]* and left in deliberately: they are the evidence that the defect is a default
behaviour, not a one-off lapse.

---

## Method

For every claim: get the **count** first (`| wc -l`), then read the **whole** list. Enumerate the
**dimensions** of the search space before searching, and state which were covered. Never conclude
absence from a truncated, filtered, or single-dimension probe.

Where a claim survives, it is marked SURVIVES and kept short. Where it does not, that is the finding.

---

## 1. Artifacts and derived files

### 1.1 The PDF — FALSE, and the artifact is judge-facing

| | |
|---|---|
| capped answer | "no PDF exists" (from `head -5`, which printed 5 PDFs) |
| complete answer | **8 PDFs.** `find ... \| wc -l` = 8 |
| the one that mattered | `hackathon/paper/Quiver-Technical-Documentation.pdf`, position 6 of 8 |

The other seven belong to unrelated research projects in the same tree (`Firdaus_2026_*`,
`.playwright-mcp/*`, `discovery-loop/…`, `occupancy_resolution/…`). The cap was not merely tight —
the sort order put the only relevant hit past it.

**Current state (re-measured):** the PDF was re-rendered at **15:34 today** from
`hackathon/paper/quiver-whitepaper.html` (15:23). Both are current. The three live
`whitepaper.html` copies are byte-identical (md5 `0fc58050…`, 420,284 b), so the render chain is
consistent as of this audit.

**The published copy is stale — measured, not inferred.** The PDF is published to Google Drive
(`1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW`), and that link is recorded in **10 places**, including
`hackathon/hq-projects.json` — the scraped record of the *live submission form*. A `HEAD` on the
direct-download endpoint returns the published file's size without downloading it:

| | bytes | filename |
|---|---|---|
| **Drive (what judges get)** | **934,725** | `Quiver — Verifiable Financial and Security Primitives for the Agentic Economy.pdf` |
| **local, re-rendered 15:34** | **935,830** | `Quiver-Technical-Documentation.pdf` |

**They are different files, by 1,105 bytes.** The Drive copy also still carries the *old title*.
Re-rendering locally does not update Drive: **the judge-facing PDF is the pre-correction render and
must be re-uploaded**, or the submission form's PDF link continues to serve the stale paper. This is
the single most externally-visible staleness found in this audit.

### 1.2 Whitepaper copies — the enumeration was hard-coded and missed two

The session's sync check iterated a hand-written list of four paths.

| | |
|---|---|
| capped answer | 4 copies checked |
| complete answer | **6 copies exist** (`find -name "*whitepaper*.html" \| wc -l` = 6) |
| missed | `hackathon/judging/Quiver/assets/whitepaper.html`, `hackathon/sentinel/vendor/quiver/assets/whitepaper.html` |

| copy | bytes | mtime | max table | codeHash |
|---|---|---|---|---|
| `hackathon/veritape/assets/whitepaper.html` | 420,284 | 07-29 14:06 | 11 | current |
| `Quiver/assets/whitepaper.html` | 420,284 | 07-29 14:06 | 11 | current |
| `hackathon/paper/quiver-whitepaper.html` | 420,284 | 07-29 15:23 | 11 | current |
| `hackathon/judging/Quiver/assets/whitepaper.html` | 370,427 | 07-27 17:08 | **10** | **stale** |
| `hackathon/judging/quiver-whitepaper.html` | 381,889 | 07-27 16:52 | **10** | **stale** |
| `hackathon/sentinel/vendor/quiver/assets/whitepaper.html` | 330,256 | 07-23 10:22 | **5** | none |

The three stale copies are **deliberately excluded** from `tools/docs-consistency.mjs` via its
`VENDORED` set, with the reasoning written out at lines 102–116 and backed by a measurement ("47 of
the 47 findings a naive full walk produces"). They are historical snapshots, correctly classified.
**Not a defect** — recorded so the next sweep does not re-discover them as one.

### 1.3 `veritape` ↔ `Quiver` asset parity — SURVIVES

25 files in `assets/` compared byte-for-byte. **0 differ.** `whitepaper.parts.json` says 7 and
7 part files exist, in both trees.

### 1.4 codeHash as a staleness signal — HALF-COVERAGE READ AS WHOLE-BUILD IDENTITY

This is the most consequential instance, because it was used to decide that nothing needed re-syncing.

`/build.hashRule` states: root `src/engine`, `fileCount: 37`.

| | |
|---|---|
| implied answer | codeHash unchanged ⇒ the build is unchanged |
| complete answer | codeHash covers **37 of the 74** `.js` files under `src/` — exactly half |
| excluded | `app.js`, `mcp.js`, `services.js`, `server.js`, `config.js`, `x402.js`, `okxsign.js`, `recurrence.js`, all 18 of `src/adapters/`, all 13 of `src/util/` |

`src/util/routing.js` — where the misroute fix lives — is **not covered**. So "the engine was not
touched, so codeHash did not move and no re-sync is needed" is true about the engine and says
**nothing** about whether the deployed bundle carries the routing fix, the MCP repair layer, or the
service definitions. Live, working tree, and mirror all report `q1-e1fa99d08887d6cc`, and the
deployed bundle is still materially older than the working tree (§1.5).

**In fairness: the project already documents this boundary correctly.** `DEPLOY_MANIFEST.md` lines
7–8 state it exactly — *"Nothing here changes the published `codeHash`. Every file touched is under
`src/util/`, `src/app.js` or `src/mcp.js`; the hash walks `src/engine/` only."* The defect is not in
the documentation. It is that during the session the hash's **equality across live/tree/mirror was
repeatedly treated as evidence of sync**, a use the manifest rules out on its own first page. A
correctly-documented boundary does not protect a conclusion that ignores it — which is the whole
lesson of this audit in one artifact.

A related claim in that manifest **survives** and is worth recording, because it looked like a
contradiction: it says the live service "has not been touched since 28 July and still serves the
submitted build", yet live `/build` *does* report `proofStorage`, which the manifest lists as
awaiting deploy. Checked rather than assumed — `proofStorage` entered `src/app.js` in commit
`237ebfe` on **07-28 11:11**, and the newest live changelog entry is **28 July**. The live build is
from late 28 July, after that commit. Consistent; no contradiction.

### 1.5 The live deploy is behind the working tree — and it is judge-visible

Measured at 15:50, after the concurrent paper agent's last commit (`8148a25`):

| surface | live | working tree | verdict |
|---|---|---|---|
| `/changelog` date-headed entries | **5** | **18** | **13 entries never deployed** |
| `/changelog` bytes | 9,827 | 46,248 | |
| `/` (landing.html) bytes | 7,099 | 7,173 | differs |
| machine-readable part 1, bytes | 36,393 | 36,425 | differs |

The concrete consequence, on the page a judge lands on first:

| | |
|---|---|
| **live front page says** | "methods, **ten** tables and 44 references" |
| **working tree says** | "methods, **eleven** tables and 44 references" |
| **the paper actually carries** | Table 11 |

The fix exists, is committed, and is described in a changelog entry — which is itself one of the 12
entries that is not deployed. **The bug it describes as fixed is still live.**

### 1.6 Named artifacts, dated

| artifact | mtime | note |
|---|---|---|
| `hackathon/veritape/README.md` | 07-29 15:20 | current |
| `Quiver/README.md` | 07-29 15:16 | current |
| `assets/changelog.md` | 07-29 15:20 | current in tree, **12 entries ahead of live** |
| `assets/landing.html` | 07-29 15:20 | current in tree, **not deployed** |
| `assets/whitepaper.html` | 07-29 14:06 | current |
| `assets/whitepaper.md` / `.parts.json` | 07-29 15:10 | derived from the 14:06 HTML — current |
| `hackathon/paper/Quiver-Technical-Documentation.pdf` | 07-29 15:34 | current vs its 15:23 source |
| `hackathon/QUIVER_SUBMISSION.md` | 07-28 04:21 | no codeHash quoted; links verified live |
| `hackathon/QUIVER_MISSION_CONTROL.md` | 07-27 12:24 | **quotes 9 superseded codeHashes, none current** |
| `hackathon/X_THREAD_UPDATE.md` | 07-28 04:04 | contains the **current** hash — the memory note calling it stale is itself out of date for the local file |
| `hackathon/QUIVER_X_POST.md` | 07-21 15:23 | no hash quoted |

`QUIVER_MISSION_CONTROL.md` is a running log, so historical hashes in it are *records*, not stale
assertions. It is flagged because it is the largest document (119 kB) and the only named artifact
where a reader cannot tell a record from a current claim without checking each one.

### 1.7 codeHash sweep across all documents

| | |
|---|---|
| capped/typical answer | grep a few known docs |
| complete answer | **1,965 files** contain a `q1-` hash; **106** are `.md`/`.html`; **21** quote only superseded hashes |

15 distinct hashes exist in the tree. Of the 21 stale-only documents, **18 are historical records**
(bug journals, research anchors, checkpoints) where the dated hash is correct. The 3 that are not
records are all inside the deliberately-vendored `judging/` and `sentinel/` snapshots (§1.2).

---

## 2. "Not served" claims

### 2.1 The route table was never enumerated

| | |
|---|---|
| capped answer | 8 distinct live paths were probed across the entire session |
| complete answer | the service routes **51** paths |

Enumerated from source, not guessed:

- **20** single-string routes (`/`, `/build`, `/healthz`, `/llms.txt`, `/mcp`, `/proof/vk`, `/proof/:contentHash`, `/paper/:n`, `/card/:id`, `/diag` + 9 `/diag/*`)
- **9** array-form routes: `/.well-known/agent-card.json`, `/agent.json`, `/changelog`, `/changes`, `/paper/full`, `/paper.md`, `/paper`, `/whitepaper`, `/docs`
- **22** service routes `/api/<slug>`, each on GET and POST

All 27 probed paths return as designed (`/mcp` 405 by design; machine-readable part 7 returns 200 and
part 8 returns 404, confirming exactly 7 parts live). No route is broken.

*[self-inflicted]* My own first enumeration grepped for `app.get('…'` and returned **20**. It missed
**every array-form route**, because the regex required a quote immediately after the paren and the
array form has a `[` there. One dimension of the syntax covered, one missed — the same defect,
committed while auditing it.

### 2.2 `/services` — a phantom path that manufactured an empty list

This is the most damaging instance found, because it produced a *confident wrong answer* rather than
a missing one.

`https://…/services` was probed **three times** to answer "which services advertise a zk proof".
**There is no `/services` route.** It returns:

```
{"error":"not_found","note":"no route GET /services","index":"/","docs":"/paper"}   HTTP 404
```

The parsing code was `j.services || j.serviceList || j.items || []`. Against that 404 body every
branch is undefined, so it fell through to `[]` and printed:

```
count: 0
advertising a zk proof: (none)
portfolio-gate present: false
```

Three separate false statements, all derived from a 404, none of them flagged as an error. The
correct index lives at `/`.

*[self-inflicted]* When I re-probed the **correct** path, my own array-shaped parser printed
`COUNT: 0` and `portfolio-gate present: false` **again** — because `/`'s `services` node is an
**object keyed by route** (`"POST /api/portfolio-gate": "…"`), not an array. Two independent
defects, either one sufficient to produce the same wrong answer. Read correctly: **22 entries**,
`portfolio-gate` present, and only `risk-attest` mentions "proof" (Merkle inclusion, not zk) — so
the index cannot answer the original question at all, and the whole line of inquiry was
unanswerable from that surface.

### 2.3 The misroute fix — SURVIVES, but only where it could be measured

The three services that were flagging their own correct calls as misrouted (`portfolio-gate`,
`chart-press`, `macro-sentry`):

**Working tree, complete local sweep** — all 22 services, all 31 declared input forms, via
`gates/routing-fixtures.mjs`: **0 self-flagging.** 0 services lack a fixture. Clean.

**Live, free MCP surface** — verified with a *discriminating* test, not a one-sided one:

| probe | routingNotice |
|---|---|
| `portfolio_gate` with its own correct body (3,151 b) | absent ✓ |
| `perp_gate` with its own correct body (3,046 b) | absent ✓ |
| `treasury_risk` given a **perp_gate** body (3,245 b) | **present** ✓ |

The signal is alive and correctly directed — "no notice" means fixed, not feature-dead.

*[self-inflicted]* My first attempt probed `chart_press` and `macro_sentry` over MCP and got
`routingNotice: 0` for both. Both responses were 343 bytes: `unknown tool`. **Only 9 of the 22
services are MCP tools.** I had probed two tools that do not exist and read the resulting absence as
a clean bill of health — the identical error to §2.2, made one step after documenting it.

**Still unverified:** `chart-press` and `macro-sentry` in production. They are HTTP-only, and
`src/app.js:529–532` states the payment gate fires *before* input validation, with `routingNotice`
attached inside the handler (lines 560, 587). An unpaid 402 probe **structurally cannot** see the
field, so the clean 402 results prove nothing. Verifying these two costs a real payment, which is
out of scope here.

### 2.4 The upstream 404 claim — SURVIVES

`/api/v6/dex/market/holders` and four neighbours were each individually confirmed 404 against the
live OKX API. Five spellings, five measured responses. Correctly done.

---

## 3. Gate battery completeness

The claim: *"30 gate files on disk, 28 reachable through an npm script, 2 orphaned."*

Discovery pattern: `readdirSync('gates').filter(f => /^gate[A-Z0-9]/.test(f) && f.endsWith('.mjs'))`.

### 3.1 Within `veritape/gates/` — the arithmetic SURVIVES, the pattern does not

| | |
|---|---|
| entries in `gates/` | **53** |
| matched by the pattern | **38** (30 at the time of the claim; 8 gates added since) |
| **invisible to the pattern** | **15** |
| orphans among matched | **0** — survives |
| dangling aliases (script names a file not on disk) | **0** — the reverse direction, never checked before, is clean |

Of the 9 invisible `.mjs` files: 5 are aliased anyway (`preflight`, `watchdog`,
`docs-coverage-revert`, `calibrate-divergence`, `calibrate-hl-premium-bound`) and 4 are legitimate
helper modules imported by gates (`paper-inputs`, `paper-integrity`, `routing-fixtures`,
`s3-emulator` — each confirmed imported, uncapped, by 1–4 gate files).

So no gate is currently lost. **But the check cannot see them either way.** `docs-coverage-revert.mjs`
is named exactly like every other `-revert.mjs` gate and is invisible to the discovery pattern purely
because it does not begin with the literal `gate`. Had its alias been dropped, the orphan check would
have reported 0 orphans — the precise failure the check exists to prevent, which this repo has
already been bitten by twice (`gate:f`, then `gate:w`).

### 3.2 Outside `veritape/gates/` — a whole battery was never in scope

`readdirSync` is non-recursive and was pointed at one directory. Uncapped, across the tree:

| location | gate `.mjs` files | npm aliases |
|---|---|---|
| `hackathon/veritape/gates/` | 38 | 38 |
| **`zk/scripts/`** | **32** | **0** |
| `Quiver/zk/scripts/` | 32 (mirror) | 0 |
| `Quiver/research/zk/scripts/` | 2 | 0 |
| `hackathon/judging/Quiver/gates/` | 2 (snapshot) | — |

`zk/package.json` defines exactly one script: `"test": "echo \"Error: no test specified\" && exit 1"`.
By the orphan check's **own stated criterion** — "no npm alias, so nobody will ever run them" — **32
zk gates are orphaned**, including `gateA3-staleness.mjs`, whose output file the HyperEVM deploy
script reads to choose the window it writes into the contract constructor. 8 documents reference
these scripts by path, so they are run by hand rather than lost; but they sit outside every automated
gate the project believes it has.

### 3.3 The test glob — SURVIVES

`npm test` runs `test/*.test.mjs`. 75 entries in `test/`, **74** matched. The one unmatched file,
`run-local.mjs`, contains no test registrations — a harness. Complete.

---

## 4. Balance and wallet claims

### 4.1 Balances — FALSE, and in one more dimension than reported

A sweep checked native tokens only and reported wallets empty. The complete sweep enumerates **three**
dimensions — address × chain × asset-kind — where the original covered one chain and one asset kind.

| address | chain | native | ERC-20 |
|---|---|---|---|
| owner `0x65bb…073b` | X Layer | OKB **0.000000** | **USD₮0 4.980000** |
| owner | Base | ETH 0.000993 | **USDC 0.450000** |
| owner | HyperEVM | HYPE 0.000000 | — |
| buyer `0xc385…6c63` | X Layer | OKB 0.006148 | **USD₮0 13.242366** |
| buyer | Base | ETH 0.213770 | **USDC 9.380582** |
| buyer | HyperEVM | HYPE 0.000000 | — |
| deployer `0xb4ee…eba9` | X Layer | OKB 0.001935 | USD₮0 0.000000 |
| deployer | HyperEVM | **HYPE 0.042554** | — |

A native-only, X-Layer-only sweep reports the owner as **completely empty**. It holds 4.98 USD₮0
and 0.45 USDC. The **chain** dimension was missed by the original *and* by the brief: the buyer's
9.38 USDC on Base is invisible to any X-Layer sweep.

Decision-relevant: the deployer address now holds **0.0426 HYPE**, where an earlier check in the
session found it empty. Gas is no longer the blocker for the HyperEVM deploy.

### 4.2 Key material

The original scan was:

```
grep -rhoiE "^[A-Z0-9_]*(PRIVATE_KEY|PAYER_KEY|BUYER_KEY|PK)[A-Z0-9_]*" \
  hackathon/veritape/.env.example hackathon/judging/.env* 2>/dev/null | sort -u | head
```

Five boundaries, none stated with the conclusion: **2 explicit paths** (not a recursive sweep of
plausible roots); `^` **anchored to line start** (misses `export KEY=`, indentation, and JSON/TOML/YAML
fields); **4 name-shapes only** (misses SECRET, MNEMONIC, SEED, KEYSTORE, DEPLOYER_KEY, SIGNER,
API_SECRET); **no value-shape dimension at all** (never looks for a bare 64-hex string or a BIP39
phrase); and a trailing `| head`.

**Independent check of the actively-dangerous case — the public mirror.** Searched git-tracked
content for a key-shaped value adjacent to a key-shaped name:

| check | result |
|---|---|
| tracked lines matching `(private_key\|secret\|mnemonic\|seed_phrase\|payer_key\|deployer_key\|signer_key)\s*[:=]\s*(0x)?[0-9a-f]{64}` | **0** |
| tracked `.env` / `.key` / `.pem` / `keystore` / `mnemonic` files | **1** — `.env.example`, correct to track |
| `.env.example` secret-named vars | 7, all **placeholder text or empty** (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `DIAG_TOKEN`, `OKX_API_KEY`, `OKX_PASSPHRASE`, `OKX_SECRET_KEY`, `QUIVER_SIGNING_KEY`) |

24 tracked files do contain bare 64-hex strings, but **0** sit next to a key-shaped name — they are
transaction hashes, content hashes, and Merkle roots, which are unavoidable in this repository. **No
secret is committed to the public repo.**

The full five-dimension, multi-root sweep — which the conclusion survives — is at §7.

---

## 5. "Nothing reads this file" claims

Re-derived uncapped across 11 dimensions: ES `import`/`export from` (extensionless and with
extension), `require()`, dynamic `import()`, string-literal `readFileSync`/`readFile`, npm scripts in
both trees, `.md` docs, HTML `src`/`href`, CI config (`nixpacks.toml`, `railway.json`, `vercel.json`
— no Dockerfile and no CI yaml exist), constructed/template-literal strings searched **by stem**, and
wholesale `readdirSync`/glob reads.

**247 files** enumerated under `src/ gates/ tools/ assets/ test/ sdk/ api/`. **236 referenced, 11
not.**

### 5.1 Three ways a per-file grep says "nothing reads this" and is wrong

1. **Test files — wrong 74 times.** All 74 `test/*.test.mjs` have **zero** import-site references.
   They are pulled in wholesale by the shell glob in `"test": "node --test test/*.test.mjs"`, plus
   `readdirSync` in `gates/gateX-paper-contradiction.mjs:69` and `tools/docs-consistency.mjs:65`.
2. **The whitepaper parts — referenced only by template literal.** Grepping the literal
   `whitepaper.part1.md` finds only prose. The load-bearing reference is production code:
   `src/app.js:43` → ``readFileSync(join(__dir, `../assets/whitepaper.part${i}.md`))``. Four more
   live in `gates/paper-inputs.mjs`, `gates/preflight.mjs:268`, `tools/docs-consistency.mjs:33`,
   `test/paperMachineReadable.test.mjs:43`.
3. **`src/engine/*.js` is hashed wholesale.** `engineSourceFiles()` (`src/engine/proof.js:91`)
   recursively walks the directory, so every `.js` there is read by the build hash regardless of
   imports.

**Nothing in `src/` is orphaned:** 74 of 76 files are imported by another module; the 2 that are not
are `src/server.js` (npm script + `railway.json`) and `src/util/proverWorker.mjs` (string literal in
`src/util/snark.js`).

### 5.2 The 11 genuine orphans — zero hits on every dimension

| file | note |
|---|---|
| `tools/calibrate.mjs`, `tools/discover-paths.mjs`, `tools/hero-verify.mjs` | one-off ops scripts aimed at live `/diag/*`; mirrored to Quiver but **inert there** — they need `.diag-token`, the single veritape-only file |
| `tools/genfigs.mjs`, `tools/make-logo.mjs`, `tools/make-toolkit-logo.mjs` | generators whose outputs nothing imports |
| `assets/chart-fast-server.png`, `chart-newindicators.png`, `chart-prod-fast.png`, `chart-prod-newind.png`, `chartcard-sample.png` | 5 PNGs; not served (no `express.static`/`sendFile`), referenced by **zero** HTML, not built by concatenation |
| `sdk/README.md` | only apparent hits were false positives inside a competitor blurb in `hq-projects.json` |

`assets/veritape-logo.png` is referenced **only by its own orphaned generator** — a dead chain.

### 5.3 Provenance: mtime staleness is a false-positive machine

Two artifacts read as STALE by mtime. Both were re-generated into scratchpad and compared **by bytes**:

| artifact | generator | mtime verdict | **content verdict** |
|---|---|---|---|
| `paper/figures/*.svg` ×4 | `tools/genfigs.mjs` | **STALE** (Jul 19 vs engine Jul 27) | **CURRENT** — byte-identical re-render |
| `gates/divergence-calibration.json` | `gates/calibrate-divergence.mjs` | **STALE** (13:39 vs generator 13:52) | **CURRENT** — byte-identical re-analysis; both shipped in commit `f20def8` |
| `assets/whitepaper.md`, `.parts.json`, `.part1-7.md` | `tools/paper-to-text.mjs` | current | **current** — gate Y 8/8 |

Both mtime-stale verdicts are **false positives**, and they are the same defect inverted: an mtime
comparison is a *proxy* for staleness with a boundary, exactly as `head -5` is a proxy for a result
set with a boundary. Trusting either without checking content produces confident wrong answers in
both directions.

**One structural risk:** the 4 figures are **inlined** into `whitepaper.html` as `<svg>` blocks with
zero filename references, so `paper/figures/*.svg` → paper is a **manual copy step with no gate over
it**. A regenerated figure would not propagate, and nothing would notice.

### 5.4 Mirror parity — SURVIVES

263 shared files, **261 byte-identical**. The 2 that differ are intentional: `.gitattributes`
(Quiver's is *newer*) and `README.md` (deliberately different internal/public documents). **No file
is newer-in-veritape in a way that makes the public mirror stale.** `package.json` is byte-identical,
and the public mirror carries all 43 gate aliases with **0 missing gate files and 0 orphans** — a
judge cloning the public repo can run the full battery.

---

## 6. What could not be checked, and why

| item | why |
|---|---|
| **Which corrections the Drive PDF is missing** | Its *staleness* is proven (§1.1: 934,725 b vs 935,830 b). Identifying exactly which two corrections are absent would require downloading and diffing it, which is out of scope here. |
| **The posted X thread** | `X_THREAD_UPDATE.md` carries the current codeHash locally. Whether the thread actually posted on x.com does is not determinable from disk. |
| **`chart-press` / `macro-sentry` misroute fix in production** | HTTP-only services; the payment gate fires before `routingNotice` is attached, so an unpaid probe cannot observe it. Verifying costs a real payment. |
| **Paid-path response bodies generally** | Same reason. Everything verified live here is on the free MCP surface or the 402 challenge. |
| **HackQuest submission form current contents** | `hq-projects.json` is a 28 July scrape, not a live read. |
| **Whether the live bundle's `src/` matches any specific commit** | `/build` exposes only the engine-scoped codeHash (§1.4). There is no deployed-commit identifier on any endpoint. |
| **Content-currency of the two logo PNGs and the `hl-premium-bound` pair** | Their generators write into `assets/` and `gates/`, which are read-only for this audit; the latter also reads live network, so it is not deterministically reproducible. |
| **`gates/.divergence-raw.json` freshness** | A live network capture. No reproducible source exists to compare against. |
| **Whether the 32 zk gates currently pass** | They are outside every npm battery (§3.2) and running them was out of scope. Their *reachability* was measured; their *status* was not. |

---

## 7. Key material — complete sweep

**Verdict: "no payer key is reachable in this environment" SURVIVES.** It was true. The method used
to establish it could not have known that.

Five dimensions, all uncapped. Counts first; **no key value, mnemonic, or secret was printed, copied,
or moved at any point.**

| # | dimension | the original scan | this sweep | result |
|---|---|---|---|---|
| A | **roots / filenames** | 2 explicit paths | recursive over `hackathon/`, `Quiver/`, `zk/`, `~/.onchainos/`, and the whole Claude scratchpad tree, for `.env`, `.env.*`, `*.key`, `*.pem`, `keystore*`, `wallets.json`, `*mnemonic*` | **8 files found**, 6 of which the original never looked at |
| B | **variable names, unanchored** | `^` anchored, 4 name-shapes | unanchored, case-insensitive, 11 name-shapes (`private_key`, `payer_key`, `buyer_key`, `deployer_key`, `signer_key`, `wallet_key`, `secret_key`, `mnemonic`, `seed_phrase`, `passphrase`, `api_secret`) adjacent to a 64-hex value | **0 matches** |
| C | **value shape** | *absent entirely* | bare 64-hex (with and without `0x`) and BIP39-shaped word runs, searched in file **contents** regardless of variable name | **0 in every `.env*` file; 0 in all four `wallets.json`** |
| D | **git history** | not attempted | tracked content of the public mirror, key-name-adjacent 64-hex | **0**; only `.env.example` is tracked, and its 7 secret-named vars are placeholders or empty (§4.2) |
| E | **runtime env** | not attempted | shell environment variables with key-ish names | **0** |

### 7.1 The six files the original scan never opened

| file | contains key material? |
|---|---|
| `hackathon/sentinel/fleet/homes/acc1/wallets.json` | **no** — 0 key-ish field names, 0 hex-64, 0 BIP39 runs, 1 address |
| `hackathon/sentinel/fleet/homes/acc2/wallets.json` | **no** — same shape |
| `hackathon/sentinel/fleet/homes/acc3/wallets.json` | **no** — same shape |
| `~/.onchainos/wallets.json` | **no** — 0 key-ish field names, 1 address |
| `hackathon/sentinel/vendor/quiver/.env.example` | no — placeholders |
| `hackathon/judging/Quiver/.env.example` | no — placeholders |

Three fleet wallet files existed that the two-path scan could not have seen. All four wallet stores
hold **an address and no key** — onchainos keeps signing material outside these files, which is why
the conclusion happened to be right.

### 7.2 The prior payer harness

`.../f347635e-…/scratchpad/base-pay` **does exist** — the hand-rolled viem EIP-3009 payer from the
earlier Base settlement. It contains **0 key-shaped secrets**: the payer key was supplied at runtime
and never persisted. Searched the entire scratchpad tree (excluding `node_modules`): **0 files** with
a key-name-adjacent 64-hex value.

### 7.3 What the original scan would have missed

Nothing, **as it happens** — there was no key to find. But it would have missed one had it existed in
any of these forms: an indented or `export`-prefixed assignment; a JSON field such as
`"privateKey": …`; any name outside its four (`DEPLOYER_KEY` and `SIGNER_KEY` are both used elsewhere
in this project); a bare key with no variable name at all; anything in the three fleet wallet stores;
anything past the tenth line of output. A conclusion that is right for none of the reasons its method
supports is not a verified conclusion — it is a coincidence that has not been distinguished from one.

---

## 8. What this changes about method

Every instance above shares one repair: **state the boundary of the check in the same breath as its
result.** Not "no PDF exists" but "no PDF in the first 5 of an unknown total". Not "codeHash
unchanged" but "codeHash unchanged, over 37 of 74 files". Not "no routingNotice" but "no
routingNotice on a surface that cannot carry one".

The three self-inflicted instances are the argument that this is not about discipline in the moment.
All three were committed *while auditing this exact defect*, minutes after writing it down. The
practices that actually caught them were mechanical, not attentive:

1. **Count before you look.** `| wc -l` first, always.
2. **Enumerate dimensions before searching**, and write down which ones the search covers.
3. **Discriminating tests.** A probe that cannot fail proves nothing — §2.3 only became evidence once
   a *known-bad* input was shown to still trigger the signal.
4. **Check the reverse direction.** The dangling-alias check (§3.1) had never been run; it happened to
   be clean.
5. **Distrust a zero.** Every false conclusion here presented as `0`, `(none)`, or `false` — never as
   an error. A zero from a parser is a claim about the parser first and the world second.
