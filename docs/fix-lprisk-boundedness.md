# The answer was right, the self-check was wrong, and the fix was never inside the engine

**Written 30 July 2026.** `lp-risk` has been answering ordinary high-volatility questions correctly and
attaching `allSelfChecksPass: false` to the answer. The paid path then declines to settle and tells the
buyer `reason: "input rejected by engine"`. Nothing about the input was rejected and nothing about the
arithmetic is wrong: the engine's boundedness self-check ranges over its own 4-decimal display value,
and a strict inequality asked of an already-rounded number fails on a value that is inside the interval.

`KNOWN_DEFECTS.md` §5 disclosed this on the morning of 30 July and closed the question with *"this one
is NOT being fixed here"*, because the check lives in `src/engine/`, the directory the build hash
`q1-e1fa99d08887d6cc` is taken over, and that hash must not move while judging runs. **That conclusion
was wrong, and the way it was reached is the part worth keeping.** The entry asked whether the
un-rounded value is *published* — it is not, `eIlExact` is a local variable — and stopped. The question
it should have asked is whether anything published lets a reader **recompute** it. Something does, and
it was sitting on the next page of the same register.

| | result |
|---|---|
| the defect, reproduced | **CONFIRMED** — `{volatility: 0.62, horizonPeriods: 365}` → `expectedIlPct: -100`, exactly one failing check, `allSelfChecksPass: false` |
| where the engine's check flips, T = 365 | σ = **0.56391182740860091**, σ²T = **116.06874041832731** — bisected here, and the register's figure to the digit |
| the exact expectation there | `exp(-v/8) - 1` = **−0.999999975832329**, i.e. 1 + E[IL] = **2.416767e-8** > 0, strictly inside (−1, 0] |
| the engine's own quadrature there | **−0.999999976290989** — also strictly inside, 4.5866e-10 from the closed form |
| the value `VERIFY_LP_RISK.md` §6 published | **−0.999999999999998** — **WRONG by seven orders**, corrected in place; it is the value near v = 270 |
| closed form vs an independent quadrature (`\|z\| ≤ 12`, N = 6000) | worst **6.88338e-15** at v = 1.19809e-4 over 401 log-spaced v in [1e-6, 250] |
| closed form vs the engine's own window (`\|z\| ≤ 6`, N = 400) | worst **1.41910e-9** — the truncation floor, six orders larger, and the reason the guard compares *rounded* figures |
| fixed where | `src/util/lpBoundedness.js` — **outside `src/engine/`**; `q1-e1fa99d08887d6cc` unmoved, `src/engine/` untouched |
| content hashes that move | **741 of 1,142** sweep calls, and no others — asserted as an equality |
| pinned exhibits | `lp-risk#0` `e65cd458…`, `lp-risk#1` `c3997db9…`, Appendix C `8575ce5a…` — all **byte-identical** |
| still refused, and correctly | σ²T > **5961.07** (`{volatility: 100, horizonPeriods: 1}`), and any non-finite σ²T |
| residual gap, disclosed | σ²T in (**116.06874041832731**, **116.06926190819375**) keeps the false failure — a band **5.2149e-4** wide |
| second instance, same class, also fixed | `realizedIL` flips at priceRatio ≤ **6.2499999975846693e-14** and ≥ 1.6e13 |
| new gate | `npm run gate:lb` — **12 checks, 1,142 calls, PASSED**; `npm run gate:lb-revert` — **4 reverts, all red, all naming their case** |
| `npm test` | **386**, unmoved, 0 fail |
| `node tools/docs-consistency.mjs` · `node gates/preflight.mjs` | green (see §8) |

---

## 1. Reproduced first, before anything was written

```
$ node -e "… lpRisk({ volatility: 0.62, horizonPeriods: 365 }) …"
expectedIlPct       = -100
totalVariance       = 140.306
  pass=true  | IL identity: closed form 2√r/(1+r)−1 == explicit constant-product token value
  pass=true  | E[IL] check: −σ²T/8 == numerical E[IL] at σ²T=0.01
  pass=false | boundedness: reported expected divergence lies in (-100%, 0] …   residual= -100
failing count       = 1
allSelfChecksPass   = false
codeHash            = q1-e1fa99d08887d6cc
```

`src/engine/lpRisk.js:110` publishes `expectedIlPct: round(eIlExact * 100, 4)`; line 206 asserts
`pass: e <= 0 && e > -100` on that same rounded field. Once `E[IL] ≤ -0.9999995` the display value is
exactly `-100`, and `-100 > -100` is false.

## 2. The quantity is recomputable from the response, which is the whole fix

`KNOWN_DEFECTS.md` §6 records the identity, derived rather than recalled:
`2√r/(1+r) = sech(ln r / 2)`; with `a = √v/2` the argument is `az − a²`; shifting `z = w + a` leaves
`sech(aw)` with the pdf gaining `e^{−aw − a²/2}`; symmetrising `w → −w` turns `e^{−aw}` into `cosh(aw)`;
and `cosh·sech ≡ 1`. So

> **E[IL](v) = exp(−v/8) − 1**, exactly, with `v = σ²T`.

`volatility` and `horizonPeriods` are echoed in `proof.inputs` on every envelope. So the exact fraction
is a two-line computation available to anyone holding the response — including a layer sitting between
the engine and the envelope. Nothing has to be extracted from the engine, and nothing in the engine has
to change.

**Checked against a different computation, not asserted.** The gate restates `exp(-v/8)` and compares it
to a quadrature of `E[sech]` that deliberately does **not** share the engine's `|z| ≤ 6` window:

| reference | worst \|quadrature − exp(−v/8)\| |
|---|---|
| `\|z\| ≤ 12`, N = 6000 (the gate's) | **6.88338e-15** at v = 1.19809e-4 |
| `\|z\| ≤ 6`, N = 400 (the engine's own) | **1.41910e-9** |
| `\|z\| ≤ 6`, N = 1600 | 1.52215e-9 — *invariant in N* |
| `\|z\| ≤ 8`, N = 400 | 2.22045e-15 — *collapses when the window widens* |

Two falsifiable predictions, both held: a truncation floor is invariant under refinement and vanishes
when the truncation is removed. The 1.41910e-9 belongs to the engine's window, not to the closed form.
(The wider 20,001-point sweep of [1e-8, 1e4] used while designing this puts the engine-window worst at
**1.41912e-9** at v = 1.12564. `PHASE_B_VERIFIED.md` reports 1.9786e-9 at v = 2.9964e+2 from its own
reimplementation; same order, same two predictions, different grid and different worst point. Neither
figure is load-bearing here — what decides the verdict is stated in §3.)

## 3. The strict inequality has to be asked in L-form, and that is not presentation

Recomputing `E[IL]` and testing `> -1` **reproduces this very defect one significant digit lower down**,
with `toFixed` replaced by subtraction:

| σ²T | `exp(-v/8)` | `exp(-v/8) - 1 > -1` | `exp(-v/8) > 0` |
|---|---|---|---|
| 140.306 | 2.4168e-8 | true | true |
| 200 | 1.3888e-11 | true | true |
| 260 | 7.6812e-15 | true | true |
| **300** | 5.1756e-17 | **false** | true |
| 400 | 1.9287e-22 | false | true |

So the test is carried out on

```
L := 1 + E[IL] = exp(-v/8)   in (0, 1]        ->   `E[IL] in (-1, 0]`  becomes  `L in (0, 1]`
```

which `Math.exp` returns directly and which never rounds to its own boundary until it underflows. The
complement `M := -E[IL] = 1 - exp(-v/8)` comes from `Math.expm1`, for the same reason in the other
regime: `1 - Math.exp(-v/8)` cancels for small v, and the concentration branch needs M.

**Measured effect.** The engine's check flips at σ²T = 116.06874041832731. The L-form check does not flip
until σ²T > 5961.07 — **51× further out** — and gate LB's revert 2 puts the subtraction back and requires
the gate to go red, which it does at σ²T ≈ 293.6 rather than at 116.07.

## 4. One-way and fail-closed, because a recomputation is not an authority

Re-deriving an engine expression outside the engine has been wrong three times on this project; the
`constantproduct` encoder rearranged the same algebra into a numerically different form and was off by
up to 64 grid steps. So the corrector is not allowed to decide anything on its own:

1. **A check whose `pass` is not literally `false` is never touched.** No call that passes today can
   start failing — not by argument, by construction. Asserted over the whole sweep.
2. **A failing check is overridden only when BOTH** the exact fraction is inside `(-1, 0]` in L-form
   **AND** `round(recomputed_pct, 4)` equals the percentage the response published. A disagreement means
   the closed form is not describing the number this response served, and the engine's verdict stands.

Condition 2 is what keeps the check able to fail, and it is not decoration. Fed at the corrector's own
interface — the only place a served figure the current engine cannot produce can be presented — it
refuses every one of these:

| injected served value | why it is refused |
|---|---|
| `-135` expected divergence (the live adversarial session's figure) | the closed form gives −60.84 at that v; digits disagree |
| `-200` amplified realized IL (the old escape hatch's figure) | the guarded closed form gives −40; digits disagree |
| `+12.5` expected divergence | a bounded loss reported as a gain; L > 1 |
| `-99.9999` where the exact value is −99.99999758 | one 4-dp step away; digits disagree |

`gates/gateLB-revert.mjs` revert 3 drops condition 2 and the fault-injection check goes red naming
*"overrode a verdict it cannot justify"* — while the sweep of 1,142 real calls stays green, which is
exactly why a sweep alone could not have caught it.

## 5. What still fails, and it is reachable

Past σ²T ≈ 5961.07, `exp(-v/8)` underflows to zero in double precision. There is then no representable
evidence that the served `-100%` is inside the open interval — and the engine's own quadrature has itself
saturated to exactly `-1` well before that, from **σ²T = 266.25** (measured on a 0.05 grid). At that
point the number being published *is* the boundary rather than a rounding of something inside it, and
certifying it would be inventing a pass. So:

```
v=5960.9    L=4.941e-324  verdict=true  corrected=true     <- a SUBNORMAL double still counts as inside
v=5961.0    L=4.941e-324  verdict=true  corrected=true
v=5961.07   L=0.000e+0    verdict=false corrected=false    <- and here it stops
v=6000      L=0.000e+0    verdict=false corrected=false
v=1e5       L=0.000e+0    verdict=false corrected=false
v=1e7       L=0.000e+0    verdict=false corrected=false
```

`{volatility: 100, horizonPeriods: 1}` is an ordinary-shaped request — no `Infinity`, no `NaN` — and it
still ships `allSelfChecksPass: false` and is still not billed. `{volatility: 1e200, horizonPeriods: 1e200}`
reaches the same refusal through a non-finite variance. **That is the genuinely out-of-range case trap 3
asks for, and it is still refused.**

**What is NOT reachable, said plainly.** A genuinely out-of-range *exact* expectation cannot be produced
by the current engine at all below the underflow edge: `exp(-v/8) > 0` for every finite v, and the
engine's own amplification branch reverts to the unamplified figure whenever `conc·M ≥ 1`, so the served
value is in range by construction. Swept over 4,947 calls — σ log-spaced 1e-4…40 × T ∈ {1, 7, 30, 90,
365, 1000} × conc ∈ {1, 1.5, 2, 3, 5, 10, 100, 1000} — **336** had an out-of-range exact fraction and
**every one of the 336 was an underflow case** (σ²T > 5961.07); zero were anything else. Also zero
amplification-branch disagreements between the closed form and the engine over those 4,947 calls. So the
range half of this check is close to vacuous on reachable input below the underflow edge,
and what keeps it honest is condition 2 above. That is a limitation of the check, not a claim about it.

## 6. The residual gap, measured rather than described

The engine's quadrature and the closed form differ by the truncation floor, and that floor straddles the
4-decimal rounding boundary in one narrow band. Inside it the served digit is `-100` while the closed
form's is `-99.9999`, so condition 2 withholds and **the false failure is retained**:

```
scanned v in [115.9, 116.25] on a 1e-5 grid
engine-fails AND digit mismatch (override withheld): 52 points, v in [116.068750, 116.069260]
engine-fails AND digit agrees   (override applies) : 18,073 points, from v = 116.069270
```

The band is `(116.06874041832731, 116.06926190819375)` — the engine's flip to the closed form's flip at
`-8·ln(5e-7)` — **5.2149e-4** wide in total variance, 1.3e-6 wide in σ at T = 365. `KNOWN_DEFECTS.md` §5
recorded that 5.2e-4 gap as *"an unconfirmed prediction"* and explicitly declined to call it an
agreement; it is now the confirmed edge of a disclosed gap. Gate LB holds 52 sweep points inside the band
and **asserts that all 52 still fail**, so the disclosure cannot go stale without the gate going red.

## 7. What this costs a caller, stated because it is caller-visible

**`selfChecks` is inside the contentHash preimage.** `src/engine/proof.js:170` puts the same array in
`proof.selfChecks` that line 145 hashes as part of `result`, so correcting a `pass` moves the hash of the
call it corrects.

| | |
|---|---|
| sweep calls whose contentHash moves | **741 of 1,142** |
| sweep calls whose contentHash is unchanged | 401 — every one of them a call with no correction |
| calls that move without a correction, or are corrected without moving | **0** (asserted as an equality) |
| `lp-risk#0` `{priceRatio: 1.4, feeAprPct: 20}` | `e65cd458…` — **unmoved** |
| `lp-risk#1` `{volatility: 0.5, horizonPeriods: 30}` | `c3997db9…` — **unmoved** |
| Appendix C perp-gate exhibit | `8575ce5a…` — **unmoved** |
| the register's own input, `{volatility: 0.62, horizonPeriods: 365, feeAprPct: 20, capitalUsd: 100000}` | `e29f5dbd…` (engine only) → **`57a32fce…`** (corrected), identical on both surfaces |
| the bare `{volatility: 0.62, horizonPeriods: 365}` | `55009649…` → **`03f24979…`** |
| `version` in the preimage | it is not — the preimage is `{engine, codeHash, inputs, result}`, re-measured against two different version strings |

The moved calls are the ones that were publishing a **false failure**, so moving them is a correction —
the same argument that justified the case-sensitivity fix on 29 July. It is still caller-visible and it
is still a change: a caller who stored `55009649…` for that exact request will not match it again.

**And re-running the engine alone no longer reproduces those responses.** That is the real cost, and it
is disclosed at three places rather than argued away:

- the corrected check carries `reEvaluated.reproduce` — *"re-run the engine on proof.inputs, then apply
  recheckLpBoundedness(result, inputs) from src/util/lpBoundedness.js"*;
- one sentence is appended to `proof.reproduce`, on corrected calls only. `proof` is stripped from the
  hash preimage, so appending it moves nothing (`gates/gateV-recipe-reproduces.mjs` still green);
- `sdk/index.js`'s `ENGINES` map applies the same step, so `reproduce()` returns `true` on an honest
  high-volatility response instead of `false`. Without that, the SDK would have accused an honest
  answer — the exact failure `src/engine/proof.js` records finding four times at four call sites.

The `codeHash` still covers `src/engine` only, and it should: nothing in there changed. What a reader
needs is one more named file, and the response names it.

## 8. Every surface, and every gate

The fix is applied at all three call sites that reach this engine, from one imported function, so the
paid HTTP path, the free MCP path and the SDK cannot drift into three verdicts about one call:
`src/services.js` (`run: (i) => lpRiskEnvelope(i, config.version)`), `src/mcp.js` (same), and
`sdk/index.js` (`localCompute.lpRisk` and the `ENGINES` map `reproduce()` reads). Gate LB asserts the two
server surfaces publish the identical `contentHash` and the identical verdict on four bodies, and
revert 4 unwires the free one and requires the gate to catch it.

| gate | result |
|---|---|
| `npm run gate:lb` | **12 pass, 0 fail** — 1,142 calls |
| `npm run gate:lb-revert` | **4 reverts, all red, all naming their case**, files restored, gate green again |
| `npm run gate:n` (defect register) | **19 pass, 0 fail** — §5 now takes the *fixed* branch |
| `npm run gate:n-revert` | **7 mutations, all red where they should be** |
| `npm run gate:v` (recipe reproduces + 24 pinned hashes + Appendix C) | see §9 |
| `npm test` | **386 tests, 0 fail** |
| `node tools/docs-consistency.mjs` | **CONSISTENT — 244 documents** |
| `node gates/preflight.mjs` | **PASSED** immediately after this change; **now red on three checks that are not this change** — see §9 |
| `npm run gate:v` · `gate:l` · `gate:p2` · `gate:m` · `gate:a` · `gate:g` | 9 · 8 · 7 · 17 · 11 · 7, all 0 fail |

**Gate N is the one that made the register mandatory.** It re-measures §5's symptom and fails in *either*
direction — a defect the page hides, or a fix the page has not caught up with — so this change could not
land without the register being rewritten. `gates/gateN-revert.mjs` step 2 had to be inverted with it:
the reachable staleness reversed sign, because the page can no longer claim a fixed defect is live, only
that a live defect is fixed.

## 9. The residue, and what I did not do

- **`src/engine/lpRisk.js:206` still contains the defect.** This layer corrects the *verdict* a caller
  receives; it does not correct the engine. Anyone importing `lpRisk` directly — `test/lprisk.test.mjs`,
  `test/liveAdversarial.test.mjs`, `test/judgeRound2.test.mjs` and `tools/genfigs.mjs`, counted — still
  sees `pass: false` on a high-volatility call. That is deliberate: the engine is frozen, and its tests
  pin its current behaviour.
- **The band in §6 is not fixed.** 5.2149e-4 of total variance still publishes a false failure.
- **The realized-IL half of this check cannot fail on reachable input.** `2√r/(1+r) > 0` for every
  representable `r > 0`. Disclosed in §5 of the register in those words.
- **Not deployed.** Deploys are frozen; the live service still answers the old way. `preflight` compares
  against live and its "changelog is ahead of live" check is what keeps that honest.
- **`preflight` and `gate:n` are red right now, on three and two checks that are not this change.**
  Measured rather than assumed, because "a sibling did it" is the easiest excuse in a shared tree.
  Immediately after this change preflight printed **PASSED** with a proof-emitting set of ten that did
  **not** include lp-risk. A concurrent session then wired the `lpbracket` circuit into both lp-risk
  handlers — `src/util/lpBracket.js`, `buildLpBracketInBackground`, around the `lpRiskEnvelope` seam this
  change created — and lp-risk therefore became a proof-emitting handler that does not call
  `gridSnapFields`, which their own handler comment argues for at length and preflight's pinned set and
  exemption list have not caught up with. The three reds name `http:lp-risk, mcp:lp_risk` for exactly
  that reason; `gate:n` §4 and §10 are red because `lpbracket` is now on the paid path and the register
  does not say so. Neither is reachable from anything in this change: the handler it installed was
  `run: (i) => lpRiskEnvelope(i, config.version)`, which contains no `env.proof`, no `obs.snark` and no
  `build*InBackground`, so it could not match preflight's `EMITS_ZK` trigger. Both belong to that
  session's entry and are left to it.
- **The revert script's own fragility, found the same way.** `gateLB-revert.mjs` originally anchored its
  fourth revert on `run: (a) => lpRiskEnvelope(a, config.version),` in `src/mcp.js`. The sibling's
  wiring replaced that line within the hour and the harness **refused to run** rather than reporting a
  green — which is the property it was built with, and it earned its keep on the first day. It is now
  anchored on the call itself. A revert script that patches shared files also races the sessions editing
  them: it snapshots at start and restores at exit, so a concurrent write inside that window would be
  rolled back. Verified after each run that `src/mcp.js` still carries all seven of the sibling's
  `lpbracket` references and no `SCRIPTED REVERT` line survives.
- **§6 of `KNOWN_DEFECTS.md` is still open and cannot take this treatment.** Its defect *is* a served
  string inside the hash preimage of every divergence call, including the pinned `lp-risk#1` fixture.
  Rewriting it from outside the engine would move those hashes to correct a sentence. That is the line
  this approach does not cross, and saying where it is matters more than the fix.
- **The published mirror carries the documents but not the code.** `Quiver/src/services.js` and
  `Quiver/package.json` already held uncommitted changes from three concurrent sessions when this
  landed — event-vol's ncdf encoder, the exec-verify snark path — and `Quiver/src/` lags the dev tree by
  however long a sibling takes to sync it, which is the state `gates/gateN-known-defects.mjs` describes
  in its own path resolution. Hand-merging four call sites into files another session is mid-edit on
  would have meant committing their work inside this change. So `src/util/lpBoundedness.js`,
  `gates/gateLB-*.mjs` and the four call sites are in the dev tree only, and the mirror's copy of this
  page describes code the mirror does not yet carry. Stated because a reader of the clone would
  otherwise find `npm run gate:lb` missing.
- **`Quiver/docs/verify-lp-risk.md` is left uncommitted for the same reason.** The §6 correction above is
  written into both copies, but the mirror's file was *already* dirty with a sibling's gas-citation
  rewrite (277,953 → 278,051 with artifact citations) before this session touched it. Committing it
  would have swept that in.

---

### Files

- `src/util/lpBoundedness.js` — the corrector (new)
- `gates/gateLB-lp-boundedness.mjs` · `gates/gateLB-revert.mjs` (new); `package.json` — two scripts
- `src/services.js` · `src/mcp.js` · `sdk/index.js` — one call site each
- `KNOWN_DEFECTS.md` §5 rewritten, §6's status sharpened, index row updated; mirrored to
  `Quiver/docs/known-defects.md` byte-for-byte
- `gates/gateN-revert.mjs` — step 2 inverted, because §5's staleness direction reversed with the fix
- `assets/changelog.md` — dated entry, mirrored to `Quiver/assets/changelog.md`
- `VERIFY_LP_RISK.md` — §6's "not fixed here" retained and marked wrong, and its
  **−0.999999999999998** corrected to **−0.999999975832329**; mirrored to `Quiver/docs/verify-lp-risk.md`
  but left uncommitted there (see §9)
- unchanged: `src/engine/**` (hash `q1-e1fa99d08887d6cc`), `assets/whitepaper*`, `test/**`
