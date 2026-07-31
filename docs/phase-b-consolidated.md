# Phase B consolidated — six repairs, six adversaries, and what is actually left

*2026-07-30. Written after six repair sessions and six adversarial reviews of those repairs.*

**Provenance rule for this page.** Every number in the "Measured here" section was computed by this
session, in this tree, just now — scripts in the scratchpad, nothing imported from the reports being
consolidated. Every number taken from someone else's run is labelled with whose run it was and which
artifact or file it came from. The claims section at the end lists every assertion on this page, and in
the six reports it consolidates, that **nobody** measured. That section is the point of the page.

**Not a deploy recommendation.** Deploys are frozen. Nothing here asks for one.

---

## 1. The table

Adversary verdict is the adversary's own `standsUp` flag, then what this session could confirm of it.

| # | What was wrong | What was done | Adversary | What is still open |
| --- | --- | --- | --- | --- |
| **1** | `zk/scripts/gate-clone-portability.mjs` hardcoded 14 of 22 circuits and skipped `liquidation` — the circuit a paying perp-gate proof is built and checked against. 84 required paths, **not one containing the string `liquidation`**. A gate asserting "verifiable from a clone" was green while the flagship reproduction path was unrunnable from a clone. | Array replaced by `readdirSync` discovery. 19 circuits fully checked (6 paths each), 3 exclusions NAMED with a `why` and a `holds()` re-measured every run. vk filename asserted against the service's own `VK_FILES`. Non-vacuity guards kept and extended. New falsifiability harness `revert-clone-portability-section1.mjs`, 4 mutations. | **BROKE IT.** The headline was overstated: the report said of the mirror "every artifact needed to prove or check anything with it is not [tracked]", having looked only under `zk/build`. Four of the five are tracked under `assets/zk/`. | The gate is genuinely RED in the mirror, but the fix is **107,920 bytes plus a path fallback**, not a 5.4 MB repository decision. `zk/scripts/service-root.mjs` already exists for exactly this two-layout problem and **no script under `zk/scripts` falls back to `assets/zk`**. Also open: the new vk-rename check is vacuous under double quotes; two of the six non-vacuity assertions are partition identities; the section-2 dev-path detector is defeated by `path.join` and the section-3 detector tests the wrong error code. |
| **2** | Gas figures in the four `VERIFY_*.md` disagreed with the artifacts. One marginal had been published as 2,388 / 3,318 / 6,340 / 8,420 — four values for one quantity, two of its terms taken from runs four seconds apart. `docs-consistency.mjs` passed over 225 documents without comparing a single gas figure. | Measured the noise first (fresh `EVM.create()` per sample). Corrected 24 occurrences / 19 distinct quantities, each with an inline artifact citation. Deleted the subtraction rather than replacing it with another single number. Added rule 9 to `tools/docs-consistency.mjs` in two halves (cited-figure comparison; uncited-figure-is-the-finding in gate reports). 4 revert scenarios, 8/8 caught. | **BROKE IT.** The strongest sentence of the report's "REFUTED AS STATED" section — "two figures match no copy in either tree", singling out `291,708` as a false provenance claim — is itself false. `Quiver/zk/build/gateB10-portfolio-perleg.json` holds `wide3LegVerifyGas: "291708"`. Absence was read from a single-file check. | The `~2%` tolerance cannot separate the two sibling verifiers whose confusion caused the defect. `VERIFY_EXEC_VERIFY.md:176-178` publishes a window (198–8,102 gas) and claims it "contains every one of the four figures" — 8,420, named at `:158`, is **318 gas outside it**. Rule 9(b) covers 4 documents of 39. 16 verify-scale figures in those four docs sit in columns not headed "gas" and are invisible to both halves. Two artifact sets still disagree. |
| **3** | The defect register disclosed 3 sections while the source documents carried at least 13 real open defects. | 3 → 13 sections, each with what is wrong / what a caller sees / fixed or not / why not. Retracted claims quoted rather than deleted. Status index added. New `gateN-known-defects.mjs` (19 checks) that fails in **both** directions, plus a 7-mutation revert. New `probe-direct-vs-snark-gas.mjs`. | **BROKE IT.** §4's only original correction of another party retracts a figure for statement A by measuring statement B. The borrowed ~5,011 gas is the **exec-verify** predicate (`PHASE_B_VERIFIED.md:27`); the 2,050 measured is the **liquidation** identity. A sibling has since measured exec-verify's at exactly **5,011**, ratio 56.1× (`FIX_REPRODUCIBLE_ARTIFACTS.md:193-194`). "Wrong in the direction that flattered the proof" is not a measurement anybody took. | §9's own correction table contains the defect §9 discloses: row `:733` claims gate B10's artifact held 2,969,816; **that number is in no artifact in either tree**. §13's row `:904` ("present in the published repository: **0**") is now false and gate N is green over it. The gas-citation check is skipped on any line containing `was`. Marking §11/§12/§13 fixed leaves gate N green. The 133.5× ratio is pinned verbatim with no tolerance while its numerator is one random Plonk sample. |
| **4** | `gateB6-portfolio-routes.mjs` recorded `[PASS] the contract picks the right leg`. Its reference was `argmin(sigs[NPUB-1])` compared against a contract taking `argmin(sigs[PRICE_INDEX])`, `PRICE_INDEX === NPUB-1` — a rule compared against itself. The router ranks by liquidation **price**; the engine ranks by distance from the mark. | Chose relabel. `PortfolioMin` → `CertifiedPriceMin`. Deleted the false claim; added a check against the engine's price minimum plus three that assert the gate's own limit, including a measured counterexample showing the tempting `p0Hat` substitution splits the moment a leg is marked. `README.md` corrected. Revert mode restores the deleted claim and goes red. | **HELD.** Rankings reproduced to the digit by an independent script; the pre-fix vacuity confirmed from `git show`; the revert confirmed to go red on the named check without clobbering the artifact. | One of the four replacement checks is a parse-time constant: `:199-201` reads only the hand-typed `LIQ_SIGNALS` literal at `:183`. Two pre-existing offenders left in the same file (`:387` asserts literal `true`). Gas rows 1/3/5/8/11 are measured in **one shared EVM**, so the 1-leg row is the only cold call — the 7,500-gas EIP-2929 step is inside the intercept, and "the gas curve was always honest" does not survive. Three timing figures published from a run that no longer exists; no rule checks milliseconds. |
| **5** | Four adversarial refutations existed only in a session scratchpad. `zk/build` held two `.ptau` and no adversary artifact. `git ls-files \| grep ptau` matched **nothing** — even `hez_final_12.ptau`, which three of the four rest on. | Enumerated 37 circuits (the named list was 7). Ported 37 scripts out of hardcoded absolute paths, with a porting step that refuses to emit a file still containing one. Committed 90 text/ceremony files, scripted the 726.8 MiB of derived binaries. `ptau.mjs fetch` refuses any power whose digest nobody measured. New `gateZ` + revert. Ran every refutation from a fresh `git clone`. | **HELD.** Constraint counts and powers reproduced with an independently written `.r1cs` parser and snarkjs's own bit-position `log2`; the five-leg ceiling confirmed by actually running the Groth16 setups (which the gate never does); one attack failed and was reported as such. | `repro.mjs:246-247`, the row carrying refutation 1's headline, is `12===12 && 13===13` — it reads the hardcoded expectation column, not a measurement, and stayed green under the mutation that inverted all eight power readings. Four published size numbers are wrong. The repo-growth percentage used the wrong denominator. The inventory is 35 distinct circuits plus two exact duplicates — the same defect the session correctly flagged in the ptau. `gate:z` is in no aggregate. |
| **6** | `execadverse` was built and unreachable. `exec-verify`'s handler was a one-liner on both surfaces: no snap, no proof. The brief's premise that event-vol and options-desk come free off `ncdf` was **false for both** and was disproved before anything was built on it. | Wired one service to the full standard: engine-line-copied encoder, own derived divergence bound (8-corner box, not a derivative), grid snap on five fields, both surfaces, recipe declaration, no contentHash movement, conscious preflight pin. New `gateEX` (19 checks) + 8-revert. Fixed `preflight`'s `EMITS_ZK`, which matched one of four builders. Found and fixed a signed-signal decode published wrong on half its domain (naive read returned `2.19e+67` where the answer was `−3207.37`). | **BROKE IT.** The sweep's generator, `seed = (seed*1103515245 + 12345) & 0x7fffffff` in doubles, has a period of **10,466**; every seed enters the same cycle. "54,410 trades" is a fixed, unenlargeable sample, so the tightest bound in the repo cannot be widened with this instrument. | `snark.js:1127` computes `displayTokens` — the shortfall's own publication ceiling — and **nothing reads it**. The guard tests the benchmark in tokens and the headline in bps; the shortfall's own step is never a refusal condition, while `services.js:870` / `mcp.js:409` tell the buyer the shortfall is "certified EXACTLY, with no tolerance of any kind". Step 5 reads `enc.sHat`, which the witness does not carry. `EMITS_ZK` remains a regex standing in for "this handler proves something". |

**Two of six survived.** The four that did not were not broken on their central diagnosis — in every case the
diagnosis reproduced. They were broken on a claim made *beside* the fix: a headline inflated by looking in one
directory, an absence read from a single file, a retraction of the wrong statement, a sample size that does not exist.

---

## 2. Proof-emitting services — measured from `gates/preflight.mjs`

Not restated. this work imported `SERVICES` and `TOOLS`, applied preflight's own `EMITS_ZK` and `bodyOf`
(`gates/preflight.mjs:206`, `:214`), and printed the set.

```
HTTP services: 22        MCP tools: 9        handlers: 31, all 31 with a readable body
EMITTING: 8  ["http:exec-verify","http:perp-gate","http:size-gate","http:treasury-risk",
              "mcp:exec_verify","mcp:perp_gate","mcp:size_gate","mcp:treasury_risk"]
distinct HTTP services emitting: 4          non-emitting handlers: 23
every emitter snaps its inputs first: true
```

> **4 of 22 services serve proofs.** Eight handler entries, because each of the four is wired on both
> surfaces. `perp-gate` (liquidation), `size-gate` (kelly), `treasury-risk` (concentration),
> `exec-verify` (execadverse). All four circuits' artifacts are present under `assets/zk`.

One correction to repair 6's own account, measured: the **old** literal regex (`buildInBackground`)
returns the *same* 8 entries on today's code. The widening at `preflight.mjs:206` is right on the merits —
three of the four builders genuinely do not contain that substring, and were being caught only by the
incidental `env.proof` alternative — but it changed no set, so "three were detected only by accident"
is a statement about fragility, not about a set that was ever wrong.

---

## 3. Measured here

Every figure below was computed by this session. Where a party's number differs, both are shown.

### Suite, docs, engine

| | |
| --- | --- |
| `npm test` | **386 tests · 381 pass · 5 skipped · 0 fail** · 14,644 ms |
| `node tools/docs-consistency.mjs` | **CONSISTENT — 238 documents** (session start; re-run at the foot of this page) |
| engine build id, via `src/engine/proof.js` `_internal.buildId()` | **`q1-e1fa99d08887d6cc`** |
| `Quiver` `git status --porcelain src/engine` | **0 paths** — the engine is untouched by all six repairs |
| `Quiver` working tree, total dirty | **29 paths**, shared by five sessions |
| markdown files quoting the build hash | **109 files, 303 occurrences** — 47 in `hackathon/`, 7 in `hackathon/veritape/`, 55 in `Quiver/` |
| `assets/changelog.md` occurrences | **23** |

### Circuits and gate discovery

| | |
| --- | --- |
| `.circom` in `zk/circuits/` | **22**, of which **21** carry a `component main` |
| `gate*.mjs` in `zk/scripts/` | **40** matching the gate's own `/^gate.*\.mjs$/`, minus SELF = **39 spawned** |
| `gate*.mjs` in `hackathon/veritape/gates/` | **53** |
| clone-portability section 1, dev tree | **120 required paths · 120 found · PASS** (19 fully checked × 6 + reduced sets for 3 exclusions) |
| clone-portability section 1, `Quiver` mirror | **RED — 5 missing.** `git status` 29 paths before, 29 after: section 1 writes nothing |

Repair 1 published "45 gate scripts"; the adversary measured 39; this work measure 39. The fabricated 45 is
committed into `zk/scripts/revert-clone-portability-section1.mjs`.

### The five "missing" liquidation artifacts — sha256, first 16 hex

| file | `zk/build` | `Quiver/assets/zk` | tracked in the mirror? |
| --- | --- | --- | --- |
| `liquidation_plonk.zkey` (**5,436,000 B**) | `e5120f585ef9833f` | `e5120f585ef9833f` | **yes** |
| `vk_plonk.json` | `8e6ebc631043ddc2` | `8e6ebc631043ddc2` | **yes** |
| `liquidation_js/liquidation.wasm` | `3e904f95f31e18ce` | `3e904f95f31e18ce` | **yes** |
| `liquidation_js/witness_calculator.cjs` | `cc2d37b2cff2a589` | `cc2d37b2cff2a589` | **yes** |
| `liquidation.r1cs` (**107,920 B**) | present | — | **no. Exists at exactly one path in this whole tree.** |

`git ls-files zk/build | grep -i liquid` in the mirror returns one path: `zk/build/LiquidationVerifier.sol`.
Scripts under `zk/scripts` that fall back to `assets/zk`: **0**. So the reproduction path is genuinely
broken from a clone — and the cause is the lookup, not the bytes.

### Gas figures, read off the artifacts with their own timestamps

No gas figure here is a measurement made here; each is a field read from a JSON on disk, quoted with the
artifact's own `at`. Plonk verify gas has a spread of roughly 1.2–1.7% (~3,500 gas) as measured by three
prior parties, so no difference smaller than that is asserted to mean anything.

| artifact (`at`) | field | value |
| --- | --- | --- |
| `gateB10-portfolio-perleg.json` (01:41:22.761Z) | `perLeg.gas` | 2,974,674 |
| same | `wide3LegVerifyGas` | 292,124 |
| same | `ceiling.wideN4` | r1cs 2,736 · plonk 5,295 · domainNeeded 8,192 · `buildableOnDisk: false` |
| `gateB6-portfolio-routes.json` (01:54:15.902Z) | `routeA.gas` / `routeB.gas` | 292,124 / **2,945,493** |
| same | `gasByLegCount` | 274,705 / 804,211 / 1,338,302 / 2,142,625 / 2,945,493 |
| `Quiver/zk/build/gateB10-portfolio-perleg.json` | `wide3LegVerifyGas` | **`"291708"`** |

Two consequences, both measured by grep over every `.json` under both `zk/build` directories:

- **`2969816` occurs in zero artifacts, in either tree.** `KNOWN_DEFECTS.md:733` publishes it as what
  gate B10's artifact held, in the table correcting figures that disagreed with their artifacts.
- **`291708` occurs in exactly one artifact**, and it is the mirror's `gateB10`. `FIX_GAS_FROM_ARTIFACTS.md`
  calls it a figure that "match[es] no copy in either tree" and the more serious of two, "a false claim
  of provenance". It is a stale copy with a wrong artifact *name* attached — the class rule 9(a) exists for.

### The `lpRisk` boundedness defect, reproduced end to end

Through `src/engine/lpRisk.js` and then through the live `lp-risk` handler and `src/x402.js`:

| σ (per period), T = 365 | σ²T | served `expectedIlPct` | `allSelfChecksPass` | `isChargeable` | `ok` |
| --- | --- | --- | --- | --- | --- |
| 0.5 | 91.25 | −99.9989 | **true** | **true** | true |
| **0.5639118274086009** | **116.06874041832731** | **−100** | **false** | **false** | true |
| 0.62 | 140.306 | −100 | false | false | true |
| 0.8 | 233.6 | −100 | false | false | true |

My own bisection (200 iterations, both bracket ends checked) puts the flip at
σ = **0.5639118274086009**, σ²T = **116.06874041832731** — sixteen digits, matching two prior parties
independently. The mechanism, read from source: `lpRisk.js:110` publishes
`expectedIlPct: round(eIlExact * 100, 4)`; `lpRisk.js:205-206` evaluates the boundedness check on
**that rounded display field**. The exact expectation is always strictly inside (−100%, 0]; the
4-decimal display is not. Past σ²T ≈ 116 the display rounds to exactly −100.0000 and `e > -100` is false.

The consequence, measured rather than described: `src/x402.js:37` returns `false` from `isChargeable`
whenever `allSelfChecksPass === false`. So the caller receives a **correct answer**, `ok: true`, with the
engine's own verifier saying it failed, and **the fee is not collected**. It is not a refusal —
"input rejected by engine — no settlement", the phrasing an earlier report used, does not appear in the
response and does not reproduce.

### Checks that cannot fail, confirmed by reading and by evaluating the predicate

| where | why it cannot fail |
| --- | --- |
| `zk/scripts/gate-clone-portability.mjs:204-206` | `matchAll(/(\w+)\s*:\s*'([^']+)'/g)` — **single quotes only**. A double-quoted `VK_FILES` literal yields `{}`, so `vkDisagree` is `[]` and the record PASSES, printing a bare `— matched`. This is the check that makes the liquidation vk *rename* safe. |
| `zk/scripts/gateB6-portfolio-routes.mjs:199-201` | Reads only the hand-typed `LIQ_SIGNALS` literal at `:183`. No circuit, no proof, no `NPUB`. Truth value fixed at parse time. |
| `zk/scripts/adversary/repro.mjs:246-247` | `PORT.find('pg5')[3] === 12 && PORT.find('pg6')[3] === 13`, where `PORT` is the hardcoded expectation table at `:222-232`. This is the row carrying refutation 1's headline. |
| `gates/gateN-known-defects.mjs:390` | Any line matching `/said\|was\|were\|used to\|retracted\|no longer\|earlier\|previously\|disagree\|stale/i` is skipped by the gas-citation check. Measured on the register itself: **96 of 710** non-blank non-fenced lines already exempt = **13.5%**. `RE.test('The batch route was 987,654 gas.')` → `true`; with `costs` → `false`. |
| `gates/gateN-known-defects.mjs:464, :480, :501` | `if (!isOpen(11)) return;` and the same for 12 and 13 — marking those sections fixed leaves the gate green, while the gate's header claims symmetry "in either direction". |
| `src/util/snark.js:1127` | `displayTokens` is assigned and read **nowhere** — one occurrence in the file. The guard at `:1204` and `:1208` tests the benchmark in tokens and the headline in bps. |

### A green gate over a claim that is now false

`gateN-known-defects.mjs` runs **19 checks, 19 pass** (measured, 1,136 ms), including
`§13 the adversary artifacts are still absent, and their sources still unpublished`. That check
(`:500-513`) tests the ptau count, their byte size, the file count in `zk/circuits/adv`, and the absence
of zkeys. It never looks at git. Measured in the mirror:

```
git ls-files zk/circuits        -> 59 paths      (§13:904 says "returns 22 paths and none is under adv/")
git ls-files zk/circuits/adv    -> 37 paths      (§13:904 says 0 are in the repository)
git ls-files zk/scripts/adversary -> 49 paths
tracked .ptau                   -> 1
```

Repair 5 published those sources between repair 3 writing §13 and now. The register is stale, the gate is
green, and this is the second instance of the same shape: **a gate whose name is broader than its predicate.**

### `gateZ` — its own artifact contradicts the number published about it

`zk/build/adversary-repro.json` (03:03:47.107Z): **64 rows — 62 `ok: true`, 0 false, 2 informational.**
`FIX_REPRODUCIBLE_ARTIFACTS.md` publishes "61 of 61 assertions pass", twice, in the same paragraph that
says the artifact records every row.

Size table, recomputed by me from `git ls-tree -r -l HEAD`:

| | published | measured here |
| --- | --- | --- |
| files added | 90 | **90** |
| bytes added | 5,377,786 | **5,377,931** |
| text bytes (89 files) | 576,098 | **576,243** |
| the write-up itself | 35,251 | **35,396** |
| repo growth | 0.706% / 0.076% | **+2.70% / +0.29%** (HEAD is 744 blobs, 204,440,257 B) |

Each of the first three is low by **exactly 145** — the write-up is one of the 90 files, so writing the
table into the document changes a row of the table. The growth percentage divided by the excluded derived
binaries (762,139,277 B) instead of by the repository.

### The pseudo-random generator every sweep gate shares

`seed = (seed * 1103515245 + 12345) & 0x7fffffff` evaluated in doubles: the product exceeds 2^53, so the
low bits are rounded away before the mask. Measured cycle length, six seeds:

```
20260730 -> enters at 702,  period 10466      7   -> enters at 4004, period 10466
424242   -> enters at 460,  period 10466      991 -> enters at 1595, period 10466
99991    -> enters at 5829, period 10466      13  -> enters at 5232, period 10466
```

**Period 10,466, and every seed lands in the same cycle.** The adversary found this in four gates. It is
in **28 files**: `gateEX`, `gateK`, `gateH`, `gateW` in `gates/`, plus thirteen sweep gates under
`zk/scripts/` (`gateB1`, `gateB3-1`, `gateB4-1`, `gateB5-1`, `gateB5-4`, `gateB7-1..5`, `gateB8-1`,
`gateB10`, `gateLP1`), `lib/kelly-batch-witness.mjs`, five probes, and five adversary scripts. Every
sweep's stated sample size is capped by the cycle, per independent branch, regardless of the loop count —
so **no sweep gate in this repository can be strengthened by raising its iteration count.** That is a
one-line fix (a 64-bit or `Math.imul` step) touching 28 files and moving every sweep's reported numbers,
which is why it is written down here rather than done.

### Adversary inventory duplicates

`zk/scripts/adversary/MANIFEST.json`: 79 entries, **37 `.circom`**, and by sha256 grouping **two
duplicate-content pairs** — `pgb4.circom == pgbatch.circom`, `pgd4.circom == pgbatch2.circom`. The
"37 circuits" inventory is **35 distinct files plus two exact copies**: the same "one file stored twice"
that session correctly flagged about the two `.ptau`, recurring inside its own commit.

### The 5,011-gas retraction

`PHASE_B_VERIFIED.md:27` places "~5,011 gas against a 278k pairing check" in the **`exec-verify`** row.
`FIX_REPRODUCIBLE_ARTIFACTS.md:193-194` measures that predicate at **5,011 execution gas**, 1,172-byte
contract, ratio **56.1× (281,250 / 5,011)** — the borrowed figure reproduced exactly.
`KNOWN_DEFECTS.md:490-498` retracts it by measuring the **liquidation** identity (2,050 gas, 790-byte
contract) and concluding the ratio is 133.5× and "the borrowed figure was wrong in the direction that
flattered the proof." Two different statements, two different contracts. Nothing in `gateN` can see it:
`:208` only asserts the artifact's own ratio `> 50`, and `:209-210` asserts the register quotes
`ratio.toFixed(1) + '×'` **with no tolerance** — so re-running the probe the gate demands exist will
usually turn the gate red on pure Plonk sampling noise.

### The arithmetic falsehood a judge would read

`VERIFY_EXEC_VERIFY.md:158` names 8,420 as one of the four published marginals. `:176-178` states the
one-shot window is 198 to 8,102 gas and "it contains every one of the four figures this document and its
siblings have published." **8,420 − 8,102 = 318.** Both endpoints are correctly cited, so rule 9 is blind
by construction: the false thing is the English quantifier.

---

## 4. Every claim nobody measured

Tristan's standing instruction: an unmeasured claim is worse than an admitted gap, because a false claim
in the README passed every gate for days. This is the complete list, including the ones introduced by this round's own work.

### Unmeasured in the six repair reports

1. **"The full gate spawns all 45 `gate*.mjs` scripts."** Never measured. It is **39**. The number is
   committed into `zk/scripts/revert-clone-portability-section1.mjs:7`, and it makes the honest
   disclosure read worse than reality (7 of 39, not 7 of 45).
2. **"Every artifact needed to prove or check anything with [liquidation] is not [tracked]."** A claim
   about the repository, tested against one directory. Four of five are tracked under `assets/zk/`.
3. **"`liquidation_plonk.zkey` is 5.3 MB; that is a repository-content decision and it is Tristan's."**
   The repository already carries those bytes once. It is 5,436,000 B and the decision on the table is
   107,920 B.
4. **`npm test ... fail 1`** published as a measurement with no test named and no pre-change baseline. It
   does not reproduce: 11 runs by the adversary gave 10× `fail 0`, and this work’s run gives `fail 0`. Nobody
   established whether it failed before the change, so it cannot rule out that the repair broke a test.
5. **"Two figures match no copy in either tree… `291,708`… that file has never held 291,708 in either
   tree."** Absence read from the one artifact the doc *named*, without searching. It is in the mirror's
   `gateB10`.
6. **"The three artifacts agree to within their own measurement noise"** (`VERIFY_PORTFOLIO_GATE.md`
   §"none of them is wrong"). No variance was propagated: a relative range on a **sum of eleven proofs**
   was compared against a relative range on **one**. Correct propagation is √11 × per-proof sd.
7. **"`gas-facts.mjs`'s 1.26% / 3,328 gas is measurably understated; wants widening to ~4,500."**
   Compares max-minus-min ranges taken at different N. A range grows without bound in N; it is not a
   property of the system. Do not widen on the strength of a bigger sample.
8. **"At `honestOut` 8.8e-8 the headline pins only to 91 bps."** Shipped twice in `src/util/snark.js`
   (`:942`, `:1197`) and repeated as a measurement. The adversary measured 103.81 bps at the nearest
   reachable fill; the sentence's own stated arithmetic gives 56.99. No gate asserts it.
9. **"133.5×" and "the borrowed figure was wrong in the direction that flattered the proof."** Nobody
   measured a direct Solidity check of the exec-verify statement in that session. When somebody did, it
   was 5,011 — exactly the borrowed number.
10. **"A Poseidon-committed variant measured at 1,764 R1CS."** Stated flatly in `KNOWN_DEFECTS.md:485-487`
    with no provenance label, in a document whose §13 declares these figures unreproducible. It *is*
    reproducible now (`xacommit.circom` is tracked and `build-adv.mjs` compiles it), which makes §13
    stale rather than the figure false — but as written the page asserts as measured a number it elsewhere
    says cannot be checked.
11. **"The artifact held 2,969,816."** In no artifact, in either tree. Copied from `PHASE_B_VERIFIED.md:447`.
12. **"Reconstructs 11 of 11 legs EXACTLY."** The engine serves 3 decimal places; exactness is not a
    measurable property from served output in either direction.
13. **"The gas curve was always honest"** — the stated reason for rejecting option (c) in repair 4. The
    intercept carries a 7,500-gas EIP-2929 cold/warm step because rows 1/3/5/8/11 share one EVM. The
    *slope* survives; the sentence does not.
14. **"~1,166 ms if 11 legs run on 11 workers."** `slowestMs` from a serial run with no contention
    accounting, published without the EXTRAPOLATED label its neighbour carries, from a run that no longer
    exists. No rule checks milliseconds.
15. **"Artifact confirmed untouched by the revert: `at` stayed 01:40:31.079Z."** The no-clobber property
    is real (independently verified), but that timestamp is nowhere on disk. The evidence cited for the
    claim was overwritten by the same session's later runs.
16. **"61 of 61 assertions pass."** The artifact says 62.
17. **90 files / 5,377,786 B / 576,098 B / 35,251 B, and "+0.706% / +0.076%".** Four wrong numbers in a
    commit titled "the size table is read out of `git ls-tree`, not off the working tree".
18. **"The wide ceiling on the on-disk 2^12 is FIVE legs"** is published as a passing gate row and is
    measured by nothing — the row is a tautology and the gate never runs a Groth16 setup. The finding is
    true; the repository does not establish it.
19. **"54,410 trades swept" / "49,241 published"** as a sample size. The generator has 10,466 states.
20. **"Both arms refuse 21,311 vs 21,370 of the same 226,761 trades."** A scratchpad probe whose script is
    in neither tree, so it is unverifiable from the repository.
21. **"docs-consistency reads 229 documents"** (`KNOWN_DEFECTS.md:44` and the `gateN` header) — a moving
    literal published as a fact inside the sentence justifying the gate. It was 238 when this work started.

### Unmeasured in the six adversarial reviews

22. **`encodingTokens > displayTokens` on 30.8%, and `round(certifiedShortfall,8) != served` on 19.7%,
    of 49,241 trades.** this work confirmed the structural defect — `displayTokens` has no readers, and
    `services.js:870` does claim "no tolerance of any kind" — but this work did **not** re-run the sweep. The
    rates and the worst gap (4.862e-6 tokens) are the adversary's numbers, and they were produced with
    the 10,466-state generator, so they describe that sample and not the input space.
23. **"1 in 8 of my proofs rounds to 133.5×"** and the 8-sample accept-gas distribution. One party's run.
24. **"Three different seeds give bit-identical worst cases; 60,000 and 600,000 runs give the same 47,587
    distinct trades."** The structural cause is measured (period 10,466, confirmed here); the specific
    distinct-trade counts are the adversary's single run and this work did not reproduce them.
25. **"exec-verify's direct checker is a 1,172-byte contract at 5,011 gas."** Read from
    `FIX_REPRODUCIBLE_ARTIFACTS.md`; not re-run here.
26. **The 200,000-trial and 100,000-trial randomised searches** establishing that two of the
    non-vacuity assertions are identities. this work confirmed the identities by reading the two expressions;
    the trial counts are theirs.
27. **"7.8 sigma as published, 8.8 sigma now"** on the three-way eleven-leg disagreement. The
    propagation is correct in form; the per-proof sd it rests on is a cited figure, not one this work took.
28. **"pg5 builds, pg6 is refused, 1,785,380 B"** — one Groth16 setup by one party.

### Unmeasured on this page

29. **Every gas figure in section 3 is a field read from a JSON, not a measurement made here.** this work took no
    gas measurement this session and publish no marginal, no ratio and no delta.
30. **The ~1.2–1.7% Plonk verify spread** is three prior parties' figure. this work did not re-measure it, and
    this work does not assert which end of the range is right — only that nothing here rests on a difference
    smaller than it.
31. **this work did not run** `gate:ex`, `gate:z`, `gate:b6`, `gate:clone-revert`, `gate:n-revert`, `gate:ex-revert`,
    `docs:revert`, or sections 2–3 of the clone-portability gate to completion (section 3 spawns 39 gates
    and four sessions are editing them underneath a run). Their verdicts on this page are the running
    parties' or read from code.
32. **`gateZ`'s 62 passing rows** are read from its artifact at 03:03:47.107Z. this work did not re-run it — it
    needs `circom.exe` and a work directory, and a reader reproducing into an empty directory still
    writes `adversary-repro.json` back into the repository.
33. **this work did not verify that the 37 tracked adversary circuits actually rebuild.** this work verified they are
    tracked, which is what makes §13's row false; whether `build-adv.mjs` reproduces every count from
    a clean clone is repair 5's claim, tested by repair 5.
34. **Nothing here was measured on any machine but this one**, on win32, with the toolchain in this tree.
35. **Nothing is deployed.** Every figure is local. `4 of 22` describes this checkout; the live host at
    `quiver-production-c3a8` serves whatever was last deployed, and this page does not measure it.

---

## 5. Decisions that are Tristan's

### 5.1 The `lpRisk` boundedness check — first, because it is the only one that costs a promise

**What is wrong.** `src/engine/lpRisk.js:205-206` evaluates the boundedness self-check on
`out.expectedDivergence.expectedIlPct`, which `:110` produced as `round(eIlExact * 100, 4)` — a
**rounded display field**. The underlying expectation is bounded in (−100%, 0] by construction and the
engine's own comment says so. The 4-decimal display is not: past σ²T ≈ 116.07 it rounds to exactly
−100.0000, and `e > -100` becomes false.

**What a caller sees**, measured through the live handler and `src/x402.js`: a correct answer, `ok: true`,
carrying `allSelfChecksPass: false`, and `isChargeable` returns **false** — so the fee is lost and the
envelope tells the buyer the engine does not stand behind an answer that is right. The flip is at
σ = 0.5639118274086009, σ²T = 116.06874041832731, reproduced to sixteen digits here.

**The shape of the fix.** One expression: evaluate the check on the unrounded fraction rather than on the
published display field. It is not a rewrite. Both prior sessions that read the check reached the same
conclusion, and neither implemented it.

**The trade, stated as a trade.** `src/engine/` is inside the build-hash scope. Any change to that
expression moves **`q1-e1fa99d08887d6cc`** — and `assets/changelog.md:5-11` promises, at the top of the
page a reviewer reads first, that two things will not change while judging runs: the endpoint URL and
that hash, because "a reviewer testing a moving target learns nothing", and because Appendix C of the
paper reproduces byte-for-byte against this build.

So the choice is:

- **Fix it.** A wrong verifier verdict on a correct answer stops being served. The hash moves, the
  changelog's own promise is broken by the changelog's author, Appendix C's byte-for-byte claim needs
  re-establishing against a new build, and the paper cannot absorb an edit (~85 bytes of headroom in
  Part 4). Cost: **109 markdown files quote the hash, 303 times** — 47 in `hackathon/`, 7 under
  `hackathon/veritape/`, 55 in `Quiver/`, of which 23 occurrences are in the served changelog itself.
- **Leave it and disclose.** The hash holds, the promise holds, and `KNOWN_DEFECTS.md` §5 already
  discloses it. A caller in the high-variance regime keeps getting a correct answer with a false
  self-check attached, for free, for the rest of judging.

**If it is yes:** the codeHash doc-sync ledger
(`~/.claude/projects/.../memory/quiver-codehash-sync-state.md`) must be walked, not grepped once —
it exists because that walk was skipped before and the X thread went stale. Hash edits are batched to
the end of a work batch, never per-fix. And the 386-test count and `docs-consistency` must be re-run
after the batch, not during it.

### 5.2 The five liquidation artifacts — a much smaller decision than it was written up as

The clone-portability gate is red in the mirror and will stay red. But four of the five files are already
tracked under `assets/zk/`, **byte-identical** (sha256 above). Genuinely absent from the repository:
`zk/build/liquidation.r1cs`, **107,920 bytes**. The rest is a lookup problem: no script under
`zk/scripts` falls back to `assets/zk`, and `zk/scripts/service-root.mjs` already exists precisely for
"whichever of the two layouts this checkout is in". Also absent and read by gate scripts:
`build/proof_plonk.json`, `build/public_plonk.json`, `build/xlayer-deployment.json`,
`build/verification_key.json`, `build/liquidation_final.zkey` — none of which is in the gate's
`REQUIRED_ARTIFACTS`, so committing the five liquidation files turns section 1 green while the claim its
name makes is still false.

Three options: commit the r1cs and add the fallback; document a setup step; or narrow the "verifiable
from a clone" claim to what is true. Not a 5.4 MB question.

### 5.3 The pseudo-random generator in 28 files

Every sweep in this repository draws from a 10,466-state cycle. The bound repair 6 calls the tightest in
the repo (7.6e-5 margin, "worth a wider sweep before anyone loosens anything near it") **cannot be
widened** with the current instrument, and neither can any other sweep's confidence. The fix is one line
per file; the cost is that every sweep gate's published numbers move at once, across 28 files and several
documents, in the middle of judging. Decide whether that happens now or after.

### 5.4 Whether the gates whose names are broader than their predicates get fixed now

Three measured instances: `gateN`'s §13 check is green over a row that is now false; the clone gate's
vk-rename check passes on a double-quoted literal; `repro.mjs`'s five-leg row is `12===12`. None is a
false *answer* to a buyer — all three are verifiers that cannot fail, which is the disease this project
organises against. Each fix is small. Together they are a fourth session's worth of work on files five
sessions share.

### 5.5 The two engine-scoped defects that are not §5

`KNOWN_DEFECTS.md` §6: the same file's served note describes a number and its own logarithm as a
diverging approximation and publishes an `approximationGapPct` that is `e^x − 1 − x`. Same file, same
freeze, same decision as §5 — and if §5 is being fixed, this is the one to fix in the same batch, because
it costs the same hash move and no second doc-sync walk.

---

## 6. What this page changed

Nothing executable. No file under `src/engine/`, `assets/whitepaper*` or `test/` was touched, no gate
was modified, nothing was deployed, and no commit was made. `npm test` is **386 tests, 381 pass,
5 skipped, 0 fail** — measured before writing and unmoved, because nothing this page did could move it.

Reproduce section 2 from `hackathon/veritape`. One unbroken line — do not add continuations, they are
shell-specific and this has to run in both shells. Verified to print `22 services, 8 emitting entries`:

```
node -e "import('./src/services.js').then(async m=>{const t=(await import('./src/mcp.js')).TOOLS;const R=/env\.proof|obs\.snark|build\w*InBackground/;const b=f=>String(f||'')+String(f?.unwrapped||'');const h=[...m.SERVICES.map(s=>['http:'+s.name,b(s.run)]),...t.map(x=>['mcp:'+x.name,b(x.run)])];console.log(m.SERVICES.length+' services, '+h.filter(x=>R.test(x[1])).length+' emitting entries')})"
```

Reproduce section 5.1's table: call `lpRisk({ volatility: σ, horizonPeriods: 365, feeApyPct: 20,
capitalUsd: 100000 })` from `src/engine/lpRisk.js`, read `expectedDivergence.expectedIlPct` and
`checks`, then pass the same result through `isChargeable` from `src/x402.js`. σ = 0.5 passes;
σ = 0.5639118274086009 and above do not.
