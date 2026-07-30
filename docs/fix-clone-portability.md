# The clone-portability gate was skipping the circuit that serves paying callers

`zk/scripts/gate-clone-portability.mjs` exists to test the load-bearing claim of this project — that a
reader who clones the repository can re-run the proofs. Its artifact check ran against a **hardcoded
array of 14 circuit names** while `zk/circuits/` held **22 `.circom` files**. The eight it never looked
at were:

```
execadverse  kellybatch  liquidation  lpbracket  lpexpectation  ncdf  portfoliogate4  portfolioleg
```

`liquidation` is the circuit a paying caller's proof is actually built and checked against.

Measured, not asserted:

| where | evidence |
| --- | --- |
| `src/util/proverWorker.mjs:46` | `const DEFAULT_CIRCUIT = 'liquidation';` — the circuit any prover message proves unless it names another |
| `src/util/snark.js:423` | the perp-gate proof path calls `prove('liquidation', …)` |
| `src/util/snark.js:929` | `VK_FILES = { liquidation: 'vk_plonk.json', … }` — the key `/proof/vk` publishes |
| `src/app.js:337` | `const circuit = rec.circuit \|\| 'liquidation';` — every already-published proof record defaults to it |
| `zk/build/xlayer-deployment.json` | the `PlonkVerifier` at `0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25` on X Layer is generated from the liquidation circuit (`zk/scripts/deploy-xlayer.mjs:144` compiles `PlonkVerifier.sol`) |

So the gate whose entire purpose is "verifiable from a clone" had never checked one artifact belonging
to the circuit that serves paying customers, on any run, ever.

The gate's own comment on the section below it says the opposite of what section 1 did:

> `// DISCOVERED, not listed. A hardcoded array is how coverage stops growing without anyone noticing:`
> `// three new circuits landed with nine new gates and a fixed list would have checked none of them.`

Section 3 learned that lesson for gate scripts. Section 1 kept a list, and eight circuits landed
behind it.

---

## Reproduction, before any fix

The shipped gate, run from the repository root in the author's working tree:

```
GATE: clone portability — 2026-07-30T01:33:53.649Z

  [PASS] the artifact list is not empty
           84 paths across 14 circuits
  [PASS] every artifact a gate needs is present in this checkout
           84 artifacts found
  [PASS] no gate hardcodes the author's working-tree path
           checked every script under zk/scripts
```

84 = 14 × 6. Not one of those 84 paths contains the string `liquidation`.

Replaying the same section-1 arithmetic over all 21 main-bearing circuits instead, against the same
files on the same disk, gives 126 paths and **9 missing**:

```
build/liquidation_vk.json
build/lpexpectation_plonk.zkey        build/lpexpectation_vk.json
build/lpexpectation_js/lpexpectation.wasm      build/lpexpectation_js/witness_calculator.cjs
build/portfoliogate4_plonk.zkey       build/portfoliogate4_vk.json
build/portfoliogate4_js/portfoliogate4.wasm    build/portfoliogate4_js/witness_calculator.cjs
```

That is the raw signal. Three of those nine are real and six are the naive check being wrong, which is
the whole reason each of the eight had to be judged individually rather than bulk-added.

---

## Judging the eight

Every circuit's artifact inventory, counted on disk (author's tree), against the six paths the gate
requires per circuit:

| circuit | on disk | verdict |
| --- | --- | --- |
| `execadverse` | 6/6 | **now fully checked.** Nothing was wrong with it; nothing was checking it. |
| `lpbracket` | 6/6 | **now fully checked.** |
| `ncdf` | 6/6 | **now fully checked.** |
| `portfolioleg` | 6/6 | **now fully checked.** |
| `liquidation` | 5/6 | **now fully checked, with the vk under the name the service publishes** — see below. |
| `kellybatch` | 1/6 | **named exclusion:** template library, no `component main`. |
| `lpexpectation` | 2/6 | **named exclusion:** r1cs-only on purpose. |
| `portfoliogate4` | 2/6 | **named exclusion:** r1cs-only, does not fit the ceremony file. |

### `liquidation` — a rename, not an exemption

`build/liquidation_vk.json` does not exist and should not. `/proof/vk` is a URL the paper quotes, so
the liquidation verification key has always been served from `build/vk_plonk.json`
(`plonk`, `bn128`, `nPublic 8`, read from the file). The fix does **not** drop the vk requirement — it
requires `build/vk_plonk.json` for `liquidation` and asserts that name against the service's own
`VK_FILES` map, parsed out of `src/util/snark.js` on every run:

```
[PASS] the verification-key filename this gate requires is the one the service serves
       liquidation→vk_plonk.json, kelly→kelly_vk.json, concentration→concentration_vk.json — matched
```

A rename on either side turns that red. Note it is bidirectional: it walks the service's map, so a
fourth circuit added to `VK_FILES` under an unexpected filename fails here rather than passing.

### `lpexpectation` — r1cs-only, and the reason is measured

It is compiled r1cs-only so `gateLP2-expectation-cost.mjs` can read its size and show that what blocks
a closed-form expectation circuit is the ceremony file rather than the arithmetic. A zkey cannot exist
for it. The exclusion asserts the reason:

```
36613 R1CS constraints vs a 4096-gate domain
```

36,613 read from the `.r1cs` header on disk; 4,096 is the domain of `hez_final_12.ptau`, the same
constant `gateLP2` already uses under the same name.

### `portfoliogate4` — where the obvious assertion would have been wrong

The tempting exclusion test is "its R1CS count exceeds the ceiling". **It does not.** Measured:

```
circuit              R1CS    Plonk   domain   ptau
portfoliogate        2053     3970     4096   2^12
portfoliogate4       2736  (no zkey)
portfolioleg          651     1267     2048   2^11
```

2,736 R1CS is comfortably *under* 4,096. What a Plonk domain has to hold is the Plonk gate count, and
that is a different number. Measured over the 19 circuits that have both a `.r1cs` and a
`_plonk.zkey` on disk, Plonk ≥ R1CS in all 19, but the ratio spans 1.001 (`padprobe`, deliberately
near-linear) to 2.414 (`kellybatch1`), median 1.930 (`kelly`) — so it cannot be extrapolated either.
This exclusion is therefore asserted against the Plonk figure `gateB10-portfolio-perleg.mjs` measured
off snarkjs's own gate generation, cross-checked against the r1cs on disk so a stale result file cannot
justify the exclusion on its own:

```
gateB10 measured 5295 Plonk gates → domain 8192 (2^13) > 4096;
its recorded 2736 R1CS matches the r1cs on disk (2736)
```

Had this been asserted on the R1CS count it would have been a check that passes while measuring the
wrong quantity — the same defect one layer down.

### `kellybatch` — template library

No `component main`, so it compiles to nothing: there is no r1cs, key or wasm to require. Detected
rather than assumed (`/^[ \t]*component\s+main/m` over the file), and checked instead by
`kellybatch1..4`, which include it and cannot compile without it.

---

## The fix

`CIRCUITS` is gone. The circuits are read from `zk/circuits/`, the way section 3 already reads its gate
scripts. Every circuit is either fully checked or named in an `EXCLUSIONS` table, and each exclusion
carries both a `why` a reader can read and a `holds()` a run can falsify — so the day
`portfoliogate4` becomes buildable, or `kellybatch` grows a main, the exclusion goes red and the
circuit is pulled back into full coverage.

The non-vacuity assertions the old gate had are kept and extended, because discovery has the same
failure mode a list has, one layer up: a `readdir` that returns nothing checks nothing and passes.

| assertion | what breaks it |
| --- | --- |
| the circuit set was discovered from disk and did not come back short | a readdir or filter that returns fewer than 22 circuits / 21 mains — a ratchet, raise it when circuits are added |
| every circuit on disk is either fully checked or named as an exclusion | a circuit falling between the two sets |
| no exclusion names a circuit that is not on disk | a stale exclusion still suppressing coverage for a deleted circuit |
| every named exclusion still earns its exclusion | the stated reason ceasing to be true |
| the verification-key filename this gate requires is the one the service serves | a rename on either side |
| the artifact list is not empty | the path list not matching the per-circuit arithmetic |

Coverage went from **84 paths across 14 circuits** to **120 paths across 19 fully-checked circuits plus
the reduced set for 3 named exclusions**.

---

## What it finds now

### In the author's working tree: green

```
  [PASS] the circuit set was discovered from disk and did not come back short
           22 .circom in circuits/ (floor 22), 21 with a `component main` (floor 21)
  [PASS] every circuit on disk is either fully checked or named as an exclusion
           19 fully checked, 3 named exclusions, 22 on disk
  [PASS] no exclusion names a circuit that is not on disk
  [PASS] every named exclusion still earns its exclusion
           3 of 3 re-measured
  [PASS] the verification-key filename this gate requires is the one the service serves
  [PASS] the artifact list is not empty
           120 paths: 19 circuits x 6, plus the reduced set for 3 exclusions
  [PASS] every artifact a gate needs is present in this checkout
           120 artifacts found
```

Section 3 — the sweep that spawns all 45 `gate*.mjs` scripts — is unchanged by this work, and it is
slow: it reached 7 of 45 in about 40 minutes, all PASS, before it was stopped. **It was not run to
completion here** and its verdict for this change is therefore unmeasured. Two reasons for stopping:
the runtime, and the fact that four concurrent sessions were editing gate scripts underneath it
(`gateB6-portfolio-routes.mjs` grew a `--revert-binding` mode mid-run), so a section-3 result taken
now could not be attributed to anything.

### In the actual clone: red, on the circuit that serves paying callers

The author's tree cannot detect this defect, because in the author's tree the artifacts are all there.
The same gate, same 120 paths, run against `Quiver/` — the git-tracked mirror, which is what a reader
clones:

```
  [*** FAIL ***] every artifact a gate needs is present in this checkout
           5 missing:
           build/liquidation.r1cs
           build/liquidation_plonk.zkey
           build/vk_plonk.json
           build/liquidation_js/liquidation.wasm
           build/liquidation_js/witness_calculator.cjs
```

`git ls-files zk/build | grep -i liquid` in that repository returns exactly one path:
`zk/build/LiquidationVerifier.sol`. The circuit is tracked, the Solidity verifier generated from it is
tracked, and **every artifact needed to prove or check anything with it is not**.

This is not the service being broken. The service reads its own copies from `assets/zk/`, and
`assets/zk/liquidation_plonk.zkey`, `assets/zk/liquidation_js/{liquidation.wasm,witness_calculator.cjs}`
and `assets/zk/vk_plonk.json` are all present in the clone. What is missing is the reproduction path —
the `zk/build/` copies that the zk-side scripts read:

| consumer | what it reads from `zk/build/` |
| --- | --- |
| `zk/scripts/lib/perpkit.mjs:117-129` | `liquidation_js/witness_calculator.cjs`, `liquidation_js/liquidation.wasm`, `liquidation_plonk.zkey`, `vk_plonk.json` |
| `zk/scripts/gateB6-portfolio-routes.mjs` | the same three (line numbers omitted: another session is editing this file) |
| `zk/scripts/negative.js:29-31` | `liquidation_js/liquidation.wasm`, `liquidation.r1cs` |
| `zk/scripts/prove.js:14`, `zk/scripts/pin-sweep.js:22` | `liquidation_js/liquidation.wasm` |
| `zk/scripts/gate0-plonk.mjs:51-52` | `proof_plonk.json`, `public_plonk.json` — also absent from the clone |

`perpkit.mjs` is imported by `gateA0-hyperevm-verifier`, `gateA1-precompile-view`, `gateA2-join` and
`gateA3-staleness`. `build/liquidation.r1cs` exists nowhere in the clone, not even under `assets/zk/`,
so a reader cannot re-derive the key either.

**This is a finding, not something this change fixed.** Committing the artifacts is a decision about
what belongs in the repository (`liquidation_plonk.zkey` is 5.3 MB) and it is left to Tristan. What
changed is that the gate now says so instead of reporting PASSED.

---

## Two more places the same gate cannot fail

Both found while reading the gate, both confirmed by measurement, both **left unfixed** — fixing either
turns the gate red on scripts this change is not scoped to rewrite.

### Section 2's dev-path detector is defeated by `path.join`

It searches each script for the literal `'hackathon/veritape'`. Six scripts hardcode the author's
layout as separate path segments and are invisible to it:

```
zk/scripts/gate2-service.mjs:15         join(…, '..', '..', 'hackathon', 'veritape')
zk/scripts/gate3-registry.mjs:23        path.join(__dirname, '..', '..', 'hackathon', 'veritape')
zk/scripts/gateA0-hyperevm-verifier.mjs:135
zk/scripts/lib/perpkit.mjs:103          path.join(ZK, '..', 'hackathon', 'veritape', 'src', 'util', 'scale.cjs')
zk/scripts/deploy-hyperevm.mjs:26       zk/scripts/deploy-xlayer.mjs:26
```

and it reports `no gate hardcodes the author's working-tree path — checked every script under
zk/scripts`. It also only scans the top level: `readdirSync(SCRIPTS)` never descends into `lib/`, so
`perpkit.mjs` is invisible twice over.

### Section 3's module-resolution check only sees ESM failures

`badModule` tests `/ERR_MODULE_NOT_FOUND/`. `perpkit.mjs:103` uses a CJS `require`, and the two codes
are different strings — measured:

```
CJS require -> code=MODULE_NOT_FOUND
ESM import  -> code=ERR_MODULE_NOT_FOUND
/ERR_MODULE_NOT_FOUND/.test('… code MODULE_NOT_FOUND')  ->  false
```

So in a clone, the four `gateA*` gates would fail on the author's path and be reported as
`ran its own logic and reported a failure of its own (not a portability problem)`.

Related, unmeasured: `missingPkg` suppresses `badModule` but a gate that dies at import time on
`Cannot find package 'solc'` never reaches its artifact reads either, so on a fresh clone before
`npm install` the artifact failures are masked as a setup step. `Quiver/node_modules` resolves
`snarkjs` but not `solc` or `@ethereumjs/*`, so this is the default clone experience. Stated as read
from the code — not run, because running gates inside the mirror would rewrite git-tracked result JSON.

---

## Proving the new checks can fail

`zk/scripts/revert-clone-portability-section1.mjs` (`npm run gate:clone-revert` in `zk/`) breaks one
input at a time, runs the gate, reads section 1, and puts the input back. It reads section 1 only and
kills the child at the "Running each gate" line, because section 1 is what is under test; nothing in
the gate was given a skip flag to make that possible.

| mutation | expected red line | result |
| --- | --- | --- |
| hide `build/vk_plonk.json` | `every artifact a gate needs is present` | red |
| hide `build/liquidation_plonk.zkey` | `every artifact a gate needs is present` | red |
| hide `build/gateB10-portfolio-perleg.json` | `every named exclusion still earns its exclusion` | red |
| hide `circuits/ncdf.circom` | `the circuit set was discovered from disk and did not come back short` | red |

Baseline green, four for four red, every file restored (`find zk -name '*.__reverted__'` → 0). The first
two are the ones that matter: they are liquidation artifacts, and under the old hardcoded list hiding
either of them changed nothing at all.

---

## Files

- `zk/scripts/gate-clone-portability.mjs` — discovery replaces the hardcoded array; named, asserted
  exclusions; per-circuit vk name checked against the service
- `zk/scripts/revert-clone-portability-section1.mjs` — new, the revert proof
- `zk/package.json` — `gate:clone`, `gate:clone-revert`
- mirrored to `Quiver/zk/scripts/`, `Quiver/zk/package.json`, `Quiver/docs/fix-clone-portability.md`

Untouched: `src/engine/`, `assets/whitepaper*`, `test/`.

`npm test` after the change: **tests 386**, pass 380, fail 1, skipped 5. The one failure is
`docsAgreeWithTheSystem` reporting 41 gas-citation contradictions across `Quiver/docs/verify-*.md` and
`hackathon/VERIFY_*.md` — documents written by concurrent sessions minutes earlier (their cited probe
artifact is stamped `2026-07-30T01:35`). The count is moving as those sessions fix their own: 41 at the
time of the `npm test` run, 21 on a re-run twenty minutes later, across 229 documents both times.
Neither `FIX_CLONE_PORTABILITY.md` nor `fix-clone-portability.md` appears in that list on any run —
`docs-consistency.mjs | grep -ci clone-portability` → 0.

## Still open

1. **The liquidation artifacts are not in the clone.** Five files, listed above, plus
   `build/proof_plonk.json` and `build/public_plonk.json` for `gate0-plonk`. Commit them, fetch them in
   a documented setup step, or narrow the claim. The gate is red in the mirror until one of those
   happens.
2. **Section 2 and section 3 of this same gate cannot see the six `path.join`-split dev paths.**
   Fixing the detectors without fixing the six scripts leaves the gate red for a second reason.
3. `padprobe` stays fully checked. It is a measuring stick rather than a Quiver statement, but a reader
   needs its artifacts to reproduce the timing table, and it has all six.
