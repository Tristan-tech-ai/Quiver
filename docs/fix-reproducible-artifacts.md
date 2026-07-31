# Four refutations that lived in a temp directory, and now live in the repository

**Written 30 July 2026.** `PHASE_B_VERIFIED.md` §8 decision 1 said this, and it was right:

> Every Groth16 build, both locally-generated ptau files, the closed-form LP circuit, the
> Poseidon-committed exec circuit and the two-instance `LegPrice` circuit live in a session-scoped temp
> directory. […] If this decision is deferred, section 4's best numbers become oral history.

This document is what happened when the decision was taken. **All four refutations now reproduce from
the repository**, three of them on the ceremony file already committed, and the fourth on a ceremony
file a reader generates offline in 31 seconds. Every number below was computed in this session, from
the artifacts and running code, on this machine. Nothing is quoted from a note, including from the four
`VERIFY_*.md` and from `PHASE_B_VERIFIED.md` itself — where a prior document's figure is repeated it is
labelled as theirs and set beside the one measured today.

---

## 1. The verdict, one row per refutation

| refutation | needs a ceremony file the repo lacks? | reproduces? | strongest evidence |
|---|---|---|---|
| **portfolio-gate** — the 4-leg wide circuit builds on the on-disk 2^12 under Groth16, and the real wide ceiling is five legs | no | **yes, in full** | five probes re-run end to end; `pgb4` 455,707 gas and `pgc6` 508,891 gas reproduce to the gas unit |
| **exec-verify** — `nPrvIn = 0`, so the statement is a ~5,011-gas Solidity predicate; and a Poseidon-committed variant fits the existing ptau | no | **yes, in full** | three zkeys rebuilt **byte-identical** to the originals; 5,011 gas reproduced exactly |
| **lp-risk** — `E[IL] = exp(−σ²T/8) − 1`, and proving the expectation is cheaper than the bracket certificate built to avoid it | no | **yes, in full** | 1,847 R1CS / 3,554 Plonk / 6,385-byte verifier all exact; zkey **byte-identical** |
| **options-risk** — route A needs zero new artifacts; route B is one circuit at 7,758 Plonk on a local 2^13 | route B only | **yes, both routes** | route A price to $1.754e-7; route B price to the engine's last published digit |

Two things follow that are worth reading before the numbers.

**Three of the four never needed a download at all, and the fourth needed 31 seconds of local
compute.** The thing that made these refutations unreproducible was not a missing 9 MB file. It was
three hardcoded absolute paths per script — the zk tree, the service tree, and the author's own
scratchpad. Resolving those three constants is the entire repair for the portfolio, exec and lp rows.
**524 KiB of text replaced 727 MiB of derived binaries**, and nothing was downloaded.

**A fourth thing was missing and only a clone found it: the ceremony file itself was not in the
repository.** Every sentence in this project of the form "the ptau already on disk" was true of a
working tree and false of a clone — `git ls-files | grep ptau` returned **no ceremony file at all**.
Three of the four refutations rest entirely on that file. It is committed now, at a stated cost of
**4,801,688 bytes (4.58 MiB)**, its sha256 is pinned, and `repro.mjs` refuses loudly if it is absent.
This is recorded as a defect this exercise created for itself and then found, because the first draft of
this document asserted the file was already committed. §5 has the detail.

**One class of artifact is genuinely not byte-reproducible, and it is not the one you would guess.** It
is not the zkeys: `plonk setup` has no randomness, so a Plonk zkey built on a committed ptau comes back
byte-identical, and three of them are pinned to sha256 in the gate. It is the *ceremony files*.
`powersoftau new` mixes fresh entropy, so every locally generated ptau is a different file, and
everything downstream of one inherits that. Section 5 measures this rather than asserting it.

---

## 2. What the four adversaries actually produced, enumerated

All of it survives, in one place: `AppData/Local/Temp/claude/…/692aad58-…/scratchpad/`. The four
adversaries were subagents of one session and shared its scratchpad, which is the only reason there
was anything left to rescue. Counted by class, excluding the two reproduction directories created
today:

| class | files | bytes |
|---|---|---|
| `.ptau` | 9 | 283,125,698 |
| `.zkey` | 39 | 455,014,042 |
| `.r1cs` | 34 | 16,674,644 |
| `.wasm` | 27 | 3,840,548 |
| `.sym` | 25 | 3,136,936 |
| `.sol` (exported verifiers) | 12 | 347,409 |
| **total derived** | **146** | **762,139,277 = 726.8 MiB** |

Plus the sources: 37 `.circom`, 40 `.mjs`, 2 `.sh`, 5 result `.json`.

`PHASE_B_VERIFIED.md` named seven artifacts. All seven were found, and the enumeration turned up more
than the seven — the search was not capped:

| named in §1 / §8 | found as | committed? |
|---|---|---|
| the Groth16 4-leg zkey | `pg4_g16_final.zkey`, from `portfoliogate4.circom` (already in the repo) | script |
| the Groth16 6-leg zkey | `pgb6_f.zkey` / `pgc6_mf.zkey`, from `pgb6.circom` / `pgc6.circom` | **circuits committed** |
| the locally generated 2^13 | `adv/pot13_final.ptau` **and** `build/pot13_final.ptau` — two of them, 15 bytes apart | script |
| the locally generated 2^17 | `ptau/pot17_final.ptau`, 150,996,408 bytes | script |
| the closed-form LP circuit | `lpclosed2.circom` (and its first pass, `lpclosed.circom`) | **committed** |
| the Poseidon-committed exec circuit | `xacommit.circom` on `xabody.circom` (plus `xamin`, `xapriv`) | **committed** |
| the two-instance `LegPrice` circuit | `price40b.circom` on `lib40.circom` (plus `price24`, `price40`) | **committed** |
| *not named anywhere* | the wide `pg5`/`pg6`/`pg7`, the batched `pgb4..pgb11`, `pgc6..pgc8`, `pgd2..pgd4`, the `v24`/`v28`/`v32` S-variants, `ctl`, the three `lp/c/` sub-probes | **committed** |

So the named list was 7 of **37** circuits. Nineteen batched portfolio shapes and four CDF variants
were in nobody's inventory.

---

## 3. Committed, scripted, or neither — and what each costs

The rule applied: **commit what is small and irreducible, script what is large or derived, and where a
step needs a download, write the fetch with a checksum assertion.**

| artifact class | decision | reason |
|---|---|---|
| 37 `.circom` | **commit** — 246,888 B | text, and the only irreducible input. Six of them are generator output and are checked against a regeneration |
| 47 probe/gate `.mjs` | **commit** — 316,228 B | text. These *are* the refutations. Two of them, `figures.mjs` and `gateZ2-repro-figures.mjs`, check this document rather than a circuit |
| 5 `probe*.json` from the original run | **commit** — 5,701 B | the original verdicts, for comparison against a re-run |
| `MANIFEST.json`, `README.md` | **commit** — 16,196 B | the pins and the map |
| `.r1cs`, `.sym`, `.wasm` | **script** | deterministic circom output. 23.7 MiB regenerated in ~2 s per circuit |
| Plonk `.zkey` on `hez_final_12` | **script**, sha256 pinned | deterministic; 18.9 MiB across the four, ~0.6 s each. Pinning the digest is a stronger check than committing the bytes |
| Groth16 `.zkey` | **script**, not pinned | phase-2 contribution mixes entropy. And a single-contributor phase 2 is worthless as trust, so committing one would be committing a misleading artifact |
| exported `Verifier.sol` | **script** | derived from the zkey; deployed byte counts are asserted instead |
| `hez_final_12.ptau` | **commit — 4,801,688 B (4.58 MiB)**, sha256 pinned | the one exception, and the cost is stated. Three of the four refutations rest on it and it was **not in the repository at all**. `ptau.mjs fetch 12` is also enabled now, so a reader can obtain it with a digest assertion instead |
| every other `.ptau` | **script** | see §5. 270 MiB more, and not byte-reproducible when generated |
| `build/pot12_final.ptau` | **neither** | it is `hez_final_12.ptau` with a different name and the same sha256. Committing a byte-identical duplicate would be 4.58 MiB spent on nothing |

**Total committed: 5,386,701 bytes (5.14 MiB) across 92 files**, read out of `git ls-tree` at HEAD —
584,117 bytes (570.4 KiB) of text in 91 files, plus the 4,801,688-byte ceremony file, plus 12 lines of
`.gitattributes`. Every figure in this section is asserted by `npm run gate:z2`, which recomputes it
from `git ls-tree` and goes red on a disagreement; the five ways it can go red are in `gate:z2-revert`.

**This file is not one of the files counted, and that is a decision rather than an oversight.** The
first version of this table counted itself: it published its own size as 35,251 bytes when the file was
35,396, and the missing 145 bytes were the length of the edit that published the number. The same 145
propagated into the text subtotal and the grand total, so three of the six figures here were wrong by
exactly the act of writing them down. §3.1 states why the write-up is excluded rather than corrected,
and why the two other honest resolutions are worse. Its size, if you want it:
`git ls-tree -l HEAD -- docs/fix-reproducible-artifacts.md`.

<!--figures:size-table-->
| where | bytes | files |
|---|---|---|
| `zk/circuits/adv/` — the `.circom` pinned in `MANIFEST.json` | 246,888 | 37 |
| `zk/scripts/adversary/` | 319,864 | 50 |
| `gates/gateZ*.mjs` — the two gates and their two reverts | 18,261 | 4 |
| `zk/build/hez_final_12.ptau` | **4,801,688** | 1 |
| **total** | **5,386,701** | **92** |

Two growth statements, each naming its own denominator, because the first version of this paragraph
did not and was read as the other one.

<!--figures:growth-repo-->Against the repository as it stood at `620c041^` (199,061,444 bytes in 654
files), this work grows it by **2.71%**, or **0.29%** with the ceremony file excluded.

<!--figures:growth-derived-->Against the 762,139,277 bytes (726.8 MiB) of derived binaries §2
enumerates and this repository deliberately does not carry, what is committed is **0.707%** of it, or
**0.077%** with the ceremony file excluded.

The published figure used to be "the repository grows by 0.706%". That is the second ratio wearing the
first one's sentence: 0.706% is committed bytes over *discarded artifacts*, and against the repository
the same numerator is near four times larger. Both are worth knowing and neither substitutes for the
other, so both are now stated with their denominators attached and both are asserted.

No *source* file committed is over 25 KiB; the largest of the pinned circuits is
`circuits/adv/ctl.circom` at 21,385 bytes, a generated constant table that `repro.mjs` regenerates and
diffs. (This was published as 21,376. That file has been 21,385 bytes in every commit it appears in;
21,376 is not a size it has ever had in this repository. `circuits/adv/ncdfonesided.circom` is larger
at 21,759 bytes, and is *not* part of this set — it belongs to the options-risk work and no assertion
here covers it, which is why the row above says "pinned in `MANIFEST.json`" rather than the directory.)

`.gitattributes` gained `*.ptau *.zkey *.r1cs *.wasm *.sym *.wtns binary`. Measurement says the
existing `text=auto` sniffing was already working — every committed `.zkey` and `.r1cs` comes out of a
fresh clone byte-identical, with `core.autocrlf=true` set globally on this machine. But sniffing is a
guess, and one of these files now has an asserted sha256. A normalized ceremony file would break that
digest and read as "the refutations do not reproduce", which is the worst false alarm available here.
Marking them changed no already-committed blob.

Two things deliberately *not* committed and *not* scripted:

- **The Hermez `hez_final_13`.** It was never needed. `ptau.mjs fetch 13` exists and **refuses**,
  because no digest for it has been measured in this project — see §5.
- **A prove-time or gas figure for `lpexpectation`.** Item 41 of `PHASE_B_VERIFIED.md` records these as
  unmeasured. They still are: measuring them needs a witness for a circuit with 246 private inputs and
  no encoder was ever written. `lp/expsetup.mjs` reproduces the three figures that *were* measured and
  says on its own last line that the other two are still unmeasured.

### 3.1 A document that grows when it records its own size

The table above measures a set of files. The first version of it put this file in that set, and so the
number it published was a fixed point: measure, write the measurement down, and the writing changes
what you measured. It came out 145 bytes low in three places, which is the length of the edit.

It is worth being exact about how solvable that is, because "impossible" would be the easy answer and
it is false. Replacing one six-digit number with another six-digit number is byte-neutral, so the
fixed point was reachable in a single step: writing 35,396 where 35,251 stood would have left the file
at 35,396 and the table correct. **The reason to reject that is not that it cannot be done — it is
that it has to be done again on every subsequent edit to this document, forever, and no gate can help.**
A gate would have to know the file's size *after* the edit that publishes it. That is a number no
checker can obtain, so the figure would be back to living in prose with nothing able to contradict it,
which is the condition that produced all five of the defects in this section.

Three resolutions were available. The one taken is the first, and the reasons the other two are worse
are specific rather than aesthetic.

**Taken — measure the set with the write-up excluded, and name the exclusion.** The measured set is
then a total function of the tree: `git ls-tree` at any commit answers it, editing this document cannot
move it, and `gate:z2` can therefore recompute it and go red. The exclusion costs one figure, and that
figure is recoverable with one command, printed above. The self-inclusion cannot creep back either: the
checker matches every row of the table to a group it knows, and a row it does not recognise is a hard
failure rather than an unchecked row — so re-adding a `docs/fix-reproducible-artifacts.md` row turns
the gate red instead of turning it blind.

**Rejected — measure the whole set, including this file, at a named commit.** Stable, and the fixed
point genuinely dissolves: a past commit is immutable, so `5ca5137`'s copy of this file is 35,396 bytes
and will be forever. Two things are wrong with it. First, it answers a question nobody asked — what the
tree weighed at a commit the reader does not have — and it decays silently while remaining
arithmetically true. Between `5ca5137` and the HEAD this was written against, `zk/circuits/adv/` gained
a circuit (+21,759 bytes) that belongs to different work, and `zk/scripts/adversary/` gained the module
that performs this very check; a figure pinned to `5ca5137` would still verify and would describe none
of it. Second, and worse, it cannot be landed in one commit: stating the figure *as of the commit that
states it* requires knowing the commit before it exists, so it needs either an amend — which this
project forbids for commits you did not create, having once orphaned a circuit that way — or two
commits, the first of which publishes a number that is wrong by construction.

**Rejected — publish the figure as prose, "as of commit X".** The same decay as above, minus the only
thing that makes a published number trustworthy here. A figure qualified in prose is a figure no gate
can check, because the gate would have to be re-pointed at a new commit by hand each time, and a check
that a human must re-aim is a check that goes stale between the two people who care about it. This is
the shape the original 61 had: correct-looking, unqualified, and unfalsifiable from inside the tree.

One asymmetry is worth naming, because it looks like the second option smuggled back in. The
*repository-growth denominator* IS a named commit — `620c041^`, the commit before this work began.
That is not the same choice: growth is a difference between two states, so one of its terms is
necessarily a past event, and a past event is exactly what a commit hash is for. The quantity being
divided is measured at HEAD; only the thing it is compared against is fixed, and it is fixed because it
is history.

---

## 4. The reproduction, refutation by refutation

Run in `ADV_WORK` pointed at an empty directory, as a reader would. Where a figure differs from the
prior documents, both are shown and the difference is either explained or called noise against the
measured **1.22–1.26% Plonk verify gas spread (~3,500 gas)**.

### 4.1 portfolio-gate — five probes, all green

```
node zk/scripts/adversary/build-adv.mjs portfoliogate4 pg5 pg6 pg7
node zk/scripts/adversary/portfolio/probe1-groth16-n4.mjs
```

| quantity | prior docs | measured today | |
|---|---|---|---|
| `portfoliogate4` R1CS | 2,736 | **2,736** | exact |
| Groth16 budget = R1CS + pubIn + pubOut | 2,773 | **2,773** | exact |
| Groth16 power = floor(log2 budget) + 1 | 12 | **12** | exact — fits the on-disk 2^12 |
| 4-leg Groth16 zkey | built, no download | **1,481,592 bytes, zero bytes downloaded** | same size as the original |
| public signals | 37 | **37**, all 37 perturbations refused | exact |
| prove, 4-leg wide Groth16 | 87 ms | **73 ms** (median of 3: 62/68/79) | timing, different machine state |
| wide ceiling on 2^12 | five legs | **pg5 3,419 R1CS / budget 3,465 → power 12, BUILDS; pg6 4,102 / 4,157 → power 13, refused** | exact |
| batched `pgb4` gas | 455,707 | **455,707** | exact to the gas unit |
| batched `pgc6` (6 legs, one proof) gas | 508,891 | **508,891** | exact to the gas unit |
| `pgc6` R1CS / prove | 3,906 / 67 ms | **3,906** / 69 ms median | count exact |
| 7 legs batched | refused at budget 4,613 | **`pgc7` 4,557 R1CS, budget 4,613, needs 2^13 — refused** | exact |
| Plonk at full bit-width parity, N=3 | 1,953 R1CS → 3,795 Plonk, domain 4,096 | **1,953 → 3,795, domain 4,096** | exact |
| Plonk N=4 | refused, 5,060 > 4,096 | **refused, 5,060 > 4,096** | exact |
| bent Groth16 proof refusal cost | 7,878,919 gas | **7,878,919 gas** | exact |
| 4-leg wide **Plonk** on a local 2^13 | 5,295 gates, domain 8,192 | **5,295, domain 8,192**, prove median **3,350 ms** | count exact |

The 2^13 row is the one PHASE_B_VERIFIED §8 item 8 called out as measured-but-in-a-temp-directory.
It is now a command.

### 4.2 exec-verify — three zkeys byte-identical, and the 5,011 gas measured

```
node zk/scripts/adversary/build-adv.mjs --into advbuild --setup xamin xapriv xacommit
node zk/scripts/adversary/exec/directcheck.mjs
node zk/scripts/adversary/exec/same-statement.mjs
```

| quantity | prior docs | measured today | |
|---|---|---|---|
| `execadverse` (shipped) | 932 R1CS, 15 public, `nPrvIn = 0` | **932, 15 public, nPrvIn 0**, 8,754 deployed bytes | exact |
| `xamin` | 929 R1CS / 1,787 Plonk / 8 public / 7,270 deployed | **929 / 1,787 / 8 / 7,270** | exact |
| `xapriv` | — | **929 / 1,781 / 2 public / 5,968 deployed** | new |
| `xacommit` | 1,764 / 3,028 / domain 4,096 / 2 public / 5,986 deployed | **1,764 / 3,028 / 4,096 / 2 / 5,986** | exact |
| all four on gate B5-3's 13 dishonest witnesses | identical verdicts | **13/13 refused by all four, honest accepted by all four** | exact |
| **the direct Solidity check** | ~5,011 gas — *"I did not myself measure this"* | **5,011 execution gas** + 1,580 calldata, 1,172-byte contract | now measured, exact |
| ratio, proof vs direct check | 55.7× | **56.1×** measured in one batch (281,250 / 5,011) | see below |
| `xacommit` vs shipped, same batch | "about 12k less" | **281,250 − 270,313 = 10,937 gas** | a real difference: 3× the 3,431-gas noise floor at this magnitude |

Two things this run says that the original did not.

**The three Plonk zkeys came back byte-identical to the adversary's own files** — 5,457,960 /
3,491,808 / 6,944,308 bytes, matching sha256. `plonk setup` is a deterministic function of the r1cs and
the ceremony file, and both are in the repository, so this is the strongest form of reproduction
available and the gate pins it.

**`directcheck.mjs`'s printed 55.7× is computed against a hardcoded 278,962.** That is the §5.1 disease
of `PHASE_B_VERIFIED.md` — a hand-copied gas literal from another run — surviving inside a rescued
script. Measured in the same batch as its own 5,011, the ratio is **56.1×**. The literal is left in
place because the script is evidence; it is recorded here as an open defect (§7).

**Three rows of `directcheck.mjs` are red, and the red rows are the finding.** `xHat+1`, `yHat+1` and
`outHat+1` are all *accepted* by the statement. That is the adversary's hit: gate B5-3's "15/15
perturbations refused" moves a public signal *after* proving, which tests Plonk's input binding rather
than this statement's strength.

### 4.3 lp-risk — the closed form, three independent ways, plus the circuit

```
node zk/scripts/adversary/lp/verify-closedform.mjs        # against the live engine
node zk/scripts/adversary/lp/confirm.mjs                  # grid refinement + Gauss-Hermite + Monte Carlo
node zk/scripts/adversary/build-adv.mjs --into build --setup lpclosed2
node zk/scripts/adversary/lp/gate-lpclosed2.mjs
node zk/scripts/adversary/lp/gate-lpclosed-evm.mjs
```

| quantity | prior docs | measured today | |
|---|---|---|---|
| `lpclosed2` | 1,847 R1CS / 3,554 Plonk / domain 4,096 / 4 public | **1,847 / 3,554 / 4,096 / 4** | exact, and zkey byte-identical |
| setup on `hez_final_12` | 633 ms | **647 ms** | timing |
| prove | 1,414–1,562 ms | **1,368 ms** and **1,590 ms** in two runs | timing |
| live-engine sweep | 116 of 116 certified | **116 / 116** | exact |
| worst deviation | 1 step at 1e-6 | **1 step at 1e-6**, worst at σ=0.01 T=1 | exact |
| `VCAP` sharpness | v = 256.0 accepted, 256.1 refused | **256.0 accepted, 256.1 refused** | exact |
| pre-proof refusal threshold | `lHat+3` refused | **`lHat+0,1,2` accepted; `lHat+3` refused** | exact |
| verifier | 6,385 deployed bytes | **6,385** (source 34,670 bytes) | exact |
| accept gas | 269,961 | **271,527** | +1,566 = **0.58%**, inside the 1.22% spread — noise, not a discrepancy |
| refusal gas | 573 | **573** | exact |
| tampered submissions | 5 of 5 refused | **5 of 5** | exact |
| breakeven through the same circuit | 6 of 8, T=304 and T=180 refused, unfixed | **6 of 8, T=304 and T=180 refused** | the unfixed defect reproduces as red |
| `approximationGapPct` = `e^x − 1 − x` at x = −v/8 | published digit in all 6 cases | **all 6, to the published digit** | exact |
| `v* = −8·ln(1−f)` | f=0.01 → 8.04026868e-2, f=0.99 → 36.8413615 | **8.04026868e-2 … 36.8413615** | exact, 9 s.f. |
| transcendentals per breakeven solve | 242,004 (161,202 exp + 80,802 sqrt) | **242,004 = 161,202 + 80,802**, vs 1 log closed-form | exact |
| the unconfirmed prediction | −8·ln(5e-7) = 116.0692619 vs measured 116.0687404, gap 5.2e-4 | **116.0692619**, gap 5.2e-4 | **still unconfirmed**, reproduces as unconfirmed |
| independent confirmations | 2 (their Gauss-Hermite, one trapezoid) | **Gauss-Hermite agrees to 1.4e-17 at v=0.01; Monte Carlo off by 2.484e-3 against a 1.5e-4 s.e. (~16 s.e.)** | exact |
| truncation-floor signature | N-invariant at \|z\|≤6, collapses at \|z\|≤8 | **1.4873e-9 (N=800) → 1.5222e-9 (N=1600) at R=6; ~1.0e-15 at R=8** | exact |

### 4.4 options-risk — route A needs nothing, route B needs 31 seconds

```
node zk/scripts/adversary/options/adv-proofs.mjs                        # route A, zero new artifacts
node zk/scripts/adversary/ptau.mjs make 13                              # 31 s, offline
node zk/scripts/adversary/build-adv.mjs --into build --ptau <pot13> price40b
node zk/scripts/adversary/options/prove-price.mjs                       # route B
```

| quantity | prior docs | measured today | |
|---|---|---|---|
| **route A** — two proofs on the unchanged `build/ncdf_plonk.zkey` | both verify, each refuses `nHat+1` | **both verify, both refuse `nHat+1`** | exact |
| spread residual x₁−x₂ vs σ√T | 2.467e-13 | **2.467e-13** | exact |
| moneyness F·p₁ − K·p₂ | 0 | **0.000e+0** (tol 1.819e-6) | exact |
| reconstructed leg price | $6853.940718429 vs engine $6853.940718254, off $1.754e-7 | **$6853.940718429 vs $6853.940718254, off $1.754e-7** | exact |
| delta from n₁ | — | **8.769e-13 from the engine's** | new |
| prove, both | 1,697 + 1,415 = 3,112 ms | **1,578 + 1,394 = 2,972 ms** | timing |
| new artifacts required | zero | **zero** | exact |
| **route B** — `price40b` | 4,172 R1CS / 7,758 Plonk / 13 public | **4,172 / 7,758 / domain 8,192 / 13 public** | exact |
| on a locally generated 2^13 | verify true, 2,867 ms | **verify true, 2,884 ms** | exact / timing |
| perturbations | 13/13 refused | **13/13** | exact |
| an Abramowitz-Stegun priced leg | refused | **refused** | exact |
| pinned price at F=100000 / K=120000 | $1395.481646032 vs engine $1395.481646024 | **$1395.481646032 vs $1395.481646024** | exact, to the last digit |
| the six CDF circuits vs their generator | — | **6 of 6 regenerate byte-for-byte** | new |

---

## 5. The one thing that is not byte-reproducible, measured

A locally generated ceremony file cannot be pinned to a digest, and `ptau.mjs` says so on every file it
makes. Three independent 2^13 files have now been generated in this project:

| power | generated by | bytes |
|---|---|---|
| 2^13 | the portfolio adversary | 9,438,629 |
| 2^13 | the options adversary | 9,438,644 |
| 2^13 | **this session** | **9,438,657** |
| 2^17 | the lp adversary | 150,996,408 |
| 2^17 | **this session** | **150,996,417** |

Five runs, five sizes — different contributor entropy every time. Each 2^13 is ~81.6 KB smaller than the
official `powersOfTau28_hez_final_13` at 9,520,280 bytes, which carries a longer contribution history.
Wall clock today, both offline and both `powersoftau verify`-clean:

| | `new` | `contribute` | `prepare phase2` | `verify` | total | prior doc |
|---|---|---|---|---|---|---|
| 2^13 | 0.6 s | 2.3 s | 28.3 s | 1.6 s | **31.3 s** | ~55 s |
| 2^17 | 2.7 s | 30.3 s | 618.8 s | 12.8 s | **651.9 s = 10.9 min** | ~11 min |

The boundary this draws was demonstrated, not asserted. Building `price40b` twice, once on each of two
different local 2^13 files:

- `price40b.r1cs` — **byte-identical** (sha256 `532a34f7…`), because circom's input is committed text
- `price40b_plonk.zkey` — **28,401,124 bytes both times, different bytes**, because the ceremony differs

And the 2^17 half sharpens it, with a figure that turns out to be on the wrong side of the line. Against
the adversary's 2^17, item 41's three figures reproduce like this:

| | recorded | on this session's 2^17 | |
|---|---|---|---|
| Plonk gates | 71,364 | **71,364** | exact |
| zkey bytes | 242,434,916 | **242,434,916** | exact — zkey size is structural |
| verifier **source** bytes | 33,253 | **33,249** | **4 bytes short** |

The exported verifier embeds the verification key as *decimal literals*, and those come out of the
ceremony file — so the `.sol` source length varies with the digit counts of a handful of field elements.
The first version of `expsetup.mjs` asserted equality on it and went red, correctly. **A verifier
source-size figure measured on a locally generated ceremony is not reproducible**, and the four bytes
are the proof. The zkey size is, because it is structure rather than digits. `expsetup.mjs` now reports
the `.sol` size, asserts only that it lands within 64 bytes, and labels it ceremony-dependent.

So for anything built on a local ptau: constraint counts, domains, public-signal counts, zkey size,
verify outcomes and gas are reproducible; the zkey bytes, the verifier bytecode and the verifier source
*length* are not. `MANIFEST.json` pins the r1cs and leaves the zkey `null`, which is the honest pin.

**On the download path.** `ptau.mjs fetch <power>` will download and assert a pinned sha256, and it
**refuses** any power whose digest has not been measured in this project:

```
$ node zk/scripts/adversary/ptau.mjs fetch 13
REFUSING to fetch power 13: no pinned sha256 for it.

A download without a pinned digest is a verifier that cannot fail: whatever bytes
arrive would be accepted. Nobody in this project has downloaded this file, so no
digest has been measured, and none is invented here.
```

Power 14 is in the table with a digest of `null` and a note explaining why: `PHASE_C_RESEARCH_FABLE.md`
records a *truncated* digest beginning `489be9e5`, and a truncated digest is a check that cannot fail on
the last 24 bytes.

**Power 12 is the one row with a real digest, and it is the one this exercise nearly got wrong.**
`ptau.mjs fetch 12` now asserts
`dcf4ea473bf14b971ce5f7b7c1d6ce1c41a8ed042cdb75b65ca9178e3a3c7c17`, measured from the file in this
tree. Two caveats are written into the table beside it, because they are real: the digest is of the
*local* file, and `zk/FINDINGS.md`'s record that this file is byte-for-byte the public Hermez one was
**not independently verified here** — doing so needs the download. So if `fetch 12` ever mismatches, the
honest reading is "the file here is not the public one", not "the bucket changed". Either way it fails
loudly.

**And the file was not in the repository.** This was found by cloning the mirror and running the gate,
which is the only way it could have been found: every check that ran in a working tree passed. A bare
clone has **no `.ptau` at all** — `git ls-files | grep ptau` matched only `ptau.mjs`. Three refutations
depend on it. It is committed now (4.58 MiB, cost stated in §3), `repro.mjs` refuses loudly if it is
absent and names the fetch command, and the first draft of this document confidently described it as
"the ceremony file already committed". That sentence was false when written, and the thing that caught
it was running the reproduction as a reader rather than as its author.

---

## 6. The gate, and proof that it can fail

```
npm run gate:z              # rebuild and re-assert everything, ~3 min
npm run gate:z-revert       # five ways to break it
npm run gate:z2             # the figures published above, against git ls-tree — seconds
npm run gate:z2-revert      # five ways to break that
```

`zk/scripts/adversary/repro.mjs` asserts three different kinds of claim and keeps them separate:
source integrity (sha256 of 80 committed sources), byte reproducibility (8 pinned r1cs/zkey digests),
and figures (constraint counts, domains, public-signal counts, and the Groth16 power arithmetic).

<!--figures:assertions-->Run against an empty `ADV_WORK`: **55 assertions, 55 pass, 0 fail** — 1
toolchain, 2 source, 1 generator, 2 ceremony, 25 portfolio, 16 Plonk, 8 byte-identity. With a locally
generated 2^13 also present, section 4 opens and adds seven more, for **62 assertions, 62 pass, 0 fail**
with 9 byte-identity pins. Both numbers were measured in a **fresh clone** as well as in the working
tree. `zk/build/adversary-repro.json` records every row, and
`zk/build/adversary-repro-counts.json` — committed, timestamp-free, so an unchanged run leaves no diff
— records the totals.

**This paragraph said 61 for a day, and nothing could contradict it.** The artifact held 62 passing
rows the whole time. The arithmetic that produced 61 is worth naming because it is not a typo: section 4
contributes seven passing rows, and the seventh, `price40b .r1cs sha256 matches the pin`, was counted
under "9 byte-identity pins" — where it is correct, being the ninth — and then not counted again in the
total. One row, classified twice and tallied once. Section 5 of `repro.mjs` now compares the published
figure against the counts of the run in progress, so `gate:z` itself goes red on a disagreement; the
`row-count` revert below proves it. Those comparisons are deliberately *not* among the 62 — an
assertion about how many rows there are must not be one of the rows, for the same reason §3.1 gives
about a document that records its own size.

It does **not** assert gas. Plonk verify gas has a measured 1.22–1.26% spread plus a 7,500-gas EIP-2929
cold/warm gap, so an equality assertion on gas is a gate that goes red on noise. The probes print gas;
this document states the spread beside every gas figure.

Five independent reverts, each breaking one kind of assertion:

```
  (unmodified)  exit   0 ·  0 red rows · green, so the reverts below mean something
  source-hash   exit   1 ·  5 red rows · the gate FAILED as required
  plonk-bytes   exit   1 ·  7 red rows · the gate FAILED as required
  counts        exit   1 ·  5 red rows · the gate FAILED as required
  ptau-power    exit   1 · 12 red rows · the gate FAILED as required
  row-count     exit   1 ·  4 red rows · the gate FAILED as required

GATE Z REVERT: PASSED — all 5 assertions are load-bearing
```

`ptau-power` is the interesting one: it reads snarkjs's Groth16 power test with `Math.ceil` instead of
the floor snarkjs actually uses (`main.cjs:4427`). That is not a synthetic mutation — it is the exact
error that put "2^14, ~18 MB" into a report where 2^13 was what the circuit needed, one clean power out.
Eight rows go red, including `portfoliogate4` reading power 13 and therefore *not* fitting the file it
demonstrably fits.

### 6.1 The second gate: the numbers in this document

`gate:z` checks circuits. Nothing checked *this document* until 30 July, and the five defects §3 and §6
now record — a row count, three propagated 145-byte errors, a stale table row its own total
contradicted, a size the file never had, and a percentage against an unstated denominator — all shipped
while every gate in the tree was green.

`gates/gateZ2-repro-figures.mjs` closes that. It is separate from `gate:z` and it is deliberately cheap:
`gate:z` needs `circom`, a 4.58 MiB ceremony file, two `node_modules` trees and three minutes, which are
the right requirements for rebuilding Groth16 and Plonk artifacts and the wrong ones for asking whether
a number in a markdown table matches `git ls-tree`. It asserts, for **both** published copies of this
document — the mirror's `docs/fix-reproducible-artifacts.md` and the submission's
`FIX_REPRODUCIBLE_ARTIFACTS.md`, because the stale copy historically survives in the second:

- the two assertion counts and the byte-identity pin count, against `adversary-repro-counts.json`;
- every row of the §3 size table, against `git ls-tree` at HEAD, and that the total is the sum of the
  rows shown — so a row cannot be added without being checked, and this file cannot be added back;
- both growth percentages, each against its own named denominator;
- that no measured file is dirty relative to HEAD, because a figure read from a commit describes that
  commit and not a draft;
- that every measured file also exists in the dev tree, byte-identical to its blob. This is the
  discipline that has failed twice here — a module written into one tree, its importer committed, and
  the module never copied, once leaving a HEAD that could not start — and it is checked by comparing
  bytes rather than by grepping for the import, which is what produced eight false positives the last
  time it was attempted.

Five reverts, one per shipped defect rather than one per line of code. `mirror-drop` is the one that
cannot be exercised inside a clone — there is no second tree to drop a file from — and the harness marks
it `n/a` there rather than green, granting the exemption only when the gate itself reported that row
skipped:

```
  (unmodified)        exit   0 ·  0 red rows · green, so the reverts below mean something
  row-count           exit   1 ·  4 red rows · the gate FAILED as required
  self-include        exit   1 · 10 red rows · the gate FAILED as required
  stale-row           exit   1 · 12 red rows · the gate FAILED as required
  derived-denominator exit   1 ·  2 red rows · the gate FAILED as required
  mirror-drop         exit   1 ·  1 red rows · the gate FAILED as required

GATE Z2 REVERT: PASSED — all 5 exercised assertions are load-bearing
```

And the same harness in a fresh clone of the pushed HEAD, where the fifth mode cannot be exercised at all
— there is no second tree to drop a file from. It is reported `n/a` rather than green, and the exemption
is granted only because `gate:z2` itself printed `mirror-check: skipped`:

```
  (unmodified)        exit   0 ·  0 red rows · green, so the reverts below mean something
  row-count           exit   1 ·  2 red rows · the gate FAILED as required
  self-include        exit   1 ·  5 red rows · the gate FAILED as required
  stale-row           exit   1 ·  6 red rows · the gate FAILED as required
  derived-denominator exit   1 ·  1 red rows · the gate FAILED as required
  mirror-drop              n/a · the mirror row is skipped in this checkout — no second tree to drop from

GATE Z2 REVERT: PASSED — all 4 exercised assertions are load-bearing, 1 inapplicable here
```

Fewer red rows in the clone because only one copy of this document exists there; the working tree holds
two and both are checked, so every document assertion doubles. 12 assertions in a clone, 24 in the
working tree.

---

## 7. New measurements, and defects found while doing this

Seven things measured in this session that appear in no prior document.

1. **The repository's "two ceremony files" are one file stored twice.** `build/hez_final_12.ptau` and
   `build/pot12_final.ptau` have the **same sha256**, `dcf4ea473bf14b971ce5f7b7c1d6ce1c41a8ed042cdb75b65ca9178e3a3c7c17`.
   `PHASE_B_VERIFIED.md` §2 counts "**2**, both power 12 … 4,801,688 bytes each" as a measurement of the
   ceremony inventory. Byte-for-byte it is one ceremony, and 4,801,688 bytes of the repository are a
   duplicate.
2. **Plonk setup on a committed ptau is byte-deterministic**, verified on four circuits. This is what
   makes pinning digests rather than committing 18.9 MiB of zkey the right trade.
3. **A third local 2^13 measures 9,438,657 bytes**, giving the non-determinism claim n=3 rather than n=2.
4. **The same-batch exec-verify marginal is 10,937 gas** (281,250 − 270,313), which is 3× the noise floor
   at that magnitude. The quantity `PHASE_B_VERIFIED.md` §5.1 tracked through the values
   2,388 / 3,318 / 6,340 / 8,420 is a *different* marginal — shipped-vs-benchmark, not
   shipped-vs-Poseidon — and this one is measured in one batch by construction.
5. **`gen-variant.mjs`'s include depth was not a parameter**, so regenerating a committed circuit
   differed on three lines and no more. It is a parameter now (`VINC`), which turns "identical except
   for three lines I decided to forgive" into a byte comparison. A diff that forgives lines can be made
   to forgive the wrong ones.
6. **An exported Plonk verifier's *source length* is ceremony-dependent; its zkey's *size* is not.**
   Measured on `lpexpectation` at 2^17: 242,434,916 zkey bytes both times, 33,253 vs **33,249** `.sol`
   bytes. So item 41's third figure is not a reproducible quantity, and the assertion that caught this
   is the one that went red first.
7. **`lpexpectation` at 2^17 is now reproduced end to end** — 36,613 R1CS, 246 private inputs, 71,364
   Plonk gates, domain 131,072, 242,434,916-byte zkey — from a ceremony file generated offline in 10.9
   minutes. Item 41 called this "setup measured, use not"; the setup half now has a command.

Five defects found in the rescued material, four unpatched, each recorded:

6. **`exec/directcheck.mjs` prints a ratio against a hardcoded 278,962.** The gas literal is from a
   different run; same-batch the ratio is 56.1×, not 55.7×. Left in place because the script is
   evidence, and because editing an artifact to make it agree with a re-run is the wrong repair.
7. **`lp/gate-lpclosed.mjs` crashes and prints a field element as a magnitude.** Both defects are the
   ones its own author recorded as fixed in `gate2`. Kept unpatched, with `gate-lpclosed2.mjs` and
   `gate-lpclosed-evm.mjs` as the repairs, because a report saying "three of my checks failed before
   they passed" is worth more with the failing versions on disk.
8. **`exec/advgas.mjs` stalls**, as its author found when they replaced it with `advgas2.mjs`. Both kept.
9. **`r1cs-probe.mjs` dereferenced `process.argv[1]` unconditionally**, so importing the parser from a
   `node -e` context crashed instead of exporting it. This one *was* patched — a guard that throws on
   import is not evidence of anything.

---

## 8. What is not verified

- **`lpexpectation`'s prove time and gas.** The setup reproduces (§5); these do not exist. Measuring
  them needs a witness for a circuit with 246 private inputs and no encoder was ever written for it.
  Item 41 of `PHASE_B_VERIFIED.md` said they were unmeasured; they still are, and `expsetup.mjs` prints
  that on its last line rather than producing a number.
- **`exec/witness-window.mjs`** — the bisection that finds the ±62-grid-step window on `x̂`. Ported, and
  it exceeded a 10-minute budget without completing. Not run.
- **`snarkjs powersoftau verify` on `hez_final_12`.** The locally generated files verify in 1.6 s (2^13)
  and 12.8 s (2^17). The Hermez file carries a long contribution chain and its verify exceeded 300 s
  without completing here; it was left running and is not reported as passed. `repro.mjs` asserts the
  file's **sha256** instead, which is the check that matters for reproduction and completes instantly.
- **`exec/advgas.mjs`** — stalls by construction (defect 8). Not run; `advgas2.mjs` covers it.
- **`options/adv-pair.mjs`, `adv-pair2.mjs`, `adv-pin.mjs`, `sizes.mjs`; `lp/probe1..5.mjs`,
  `b100.mjs`, `measure.mjs`; `portfolio/…` sub-analyses.** Ported and hash-pinned, not executed in this
  pass. The refutation *headlines* are covered by the probes that were run; these are the supporting
  sweeps.
- **Groth16 zkeys are not byte-reproducible** and are not pinned. Their constraint counts, gas and
  verdicts are. And the standing caveat holds unchanged: a single-contributor phase 2 is worthless as
  trust, so every Groth16 gas advantage here still carries an unpriced ceremony.
- **Gas equality.** Not asserted anywhere, deliberately. See §6.
- **Nothing here is wired.** No service serves any of these circuits; the proof-emitting set is still
  `perp-gate`, `size-gate`, `treasury-risk`. Reproducibility is not reachability.
- **Nothing was deployed, and nothing was downloaded.** No `railway up`, no network fetch, no write into
  `src/engine/`, no change to the paper. `_internal.buildId()` reads **`q1-e1fa99d08887d6cc`**, unmoved.
  `npm test` is **386 tests, 381 pass, 5 skipped, 0 fail**, unchanged. `node tools/docs-consistency.mjs`
  is **CONSISTENT — 238 documents**. `node gates/preflight.mjs` **PASSED**.

---

## 9. The three things a reader supplies, and how the clone test found two of them

**Everything in this section came out of actually cloning the repository and running the gate.** Every
check that ran inside a working tree passed, which is precisely why none of it surfaced until a clone
existed. The sequence, in order:

| clone state | result |
|---|---|
| bare clone of `620c041` | **refuses**, naming `zk/circom.exe` and `zk/node_modules`, exit 2 |
| + circom and the zk dependencies | **still fails** — `zk/build/hez_final_12.ptau` was in no commit |
| + the ceremony file | **55 of 55 assertions pass**, all 8 byte-identity pins among them |
| …but `portfolio/probe1` | **crashes** — the service tree's `node_modules` is missing, and probes 1–3 build witnesses through the service's own encoder, which reaches `ethers` |
| + the service dependencies | `probe1` runs, and the gate goes **red on one row**: the manifest catching this repository’s own edit to `repro.mjs` made after the last manifest write |
| fresh clone of `1761b7d`, all three supplied, a local 2^13 in the work directory | **62 of 62 pass**, **9 byte-identity pins**, `gate:z-revert` red in all four modes it then had |

That last row read "61 of 61" until 30 July. It was the same miscount §6 records, written down a second
time: `repro.mjs` is byte-identical from `1761b7d` through the commit that published the figure, so the
clone produced 62 passing rows on the day too. A wrong number copied into a second place is the reason
`gate:z` now derives it instead of quoting it.

Two of those five rows are defects this exercise created for itself and then found: the uncommitted
ceremony file (now committed, §3/§5) and a gate that went green while three of the probes it claims to
cover could not start (now a hard refusal). The second is the more instructive one — **a gate can pass 55
assertions and still be narrower than its own name**, and the only thing that showed it was running a
probe rather than the gate.

The load-bearing result is that the byte-identity rows pass **in a clone**: `xamin`, `xapriv`, `xacommit`
and `lpclosed2` rebuild to zkeys whose sha256 matches artifacts produced last night in a temp directory,
from nothing but committed inputs. And the committed ceremony file comes out of `git clone` with its
pinned digest intact, `core.autocrlf=true` notwithstanding.

Verified from the clone directly, not only through the gate:

| probe | from the clone |
|---|---|
| `options/adv-proofs.mjs` (route A) | spread 2.467e-13, `F·p₁−K·p₂` = 0, price off **$1.754e-7** — identical to the working tree |
| `portfolio/probe1-groth16-n4.mjs` | 2,736 R1CS, power 12, 4-leg Groth16 zkey on the committed 2^12, **37 of 37** perturbations refused, prove 76 ms |
| `portfolio/probe4-minimal.mjs` | `pgc6` 3,906 R1CS / **508,891 gas** / 48 of 48 refused; `pgc7` refused at budget **4,613** |
| `options/prove-price.mjs` (route B) | 13 public signals, verify true, price **$1395.481646032** vs engine $1395.481646024, 13/13 refused, A-S leg refused |
| `exec/directcheck.mjs` | **5,011 execution gas**, same three red rows that are the finding |

Every one of those figures is identical to the working-tree run and to the prior documents, to the digit.

`repro.mjs` refuses before building anything if any of the three is missing, and names which:

```
CANNOT REPRODUCE — the toolchain is incomplete:

  zk/circom.exe is missing. The circuits cannot be compiled without it.
    It is a 12,039,168-byte binary and is deliberately not committed.
    Obtain circom 2.2.3 and place it at <repo>/zk/circom.exe

  zk/node_modules is missing (gitignored, as it should be).
    Run:  npm install --prefix "<repo>/zk"
```

That is the output of `npm run gate:z` in the mirror as it stands, and it is the honest limit of this
work. `zk/circom.exe` is a 12 MB platform binary; committing it would be exactly the multi-megabyte
binary this exercise is about not committing. `zk/node_modules` is gitignored and `zk/package.json`
pins every dependency the probes use.

The version check is not decoration. **The pinned r1cs digests are circom 2.2.3 output**, so a reader on
2.2.2 or 2.3.0 would watch section 3's byte-identity rows go red with no explanation. `repro.mjs` reads
`circom --version`, compares it to `MANIFEST.json`'s `toolchain.circom`, and reports the mismatch as its
own row before anything is compiled.
